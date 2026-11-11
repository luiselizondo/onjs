const { Queue: RedisQueue, Worker } = require('bullmq')
const EventEmitter = require('events')
const {
  hasProperties,
  eventIsDeclaredBeforeCallingRegisterCallback,
  next,
  logger,
} = require('./utils')

const { MQ, Queue, Topic, RPC } = require('rabbitmq-lib')

/**
 * On.js — an event library on top of RabbitMQ (topics, queues and RPC) with a
 * redis (bullmq) layer that deduplicates the processing of a message across
 * processes.
 *
 * Registration is fluent: an event is declared with one of the `*Received`
 * methods and completed with a callback (`do`, `andProcess`, `afterExecuting`
 * or `respond`) plus the optional modifiers `withProperties`,
 * `ackAfterProcessing` and `andDispatchAs`. Nothing connects until `init()` is
 * called; `tearDown()` closes every resource.
 *
 * @class On
 * @extends EventEmitter
 * @param {object} options
 * @param {object} options.mq RabbitMQ connection and declaration options.
 * @param {string} options.mq.url AMQP url, e.g. `amqp://user:pass@host:5672/`.
 * @param {string} options.mq.exchange_name Exchange used for topic events.
 * @param {string} [options.mq.delayed_exchange_name] Exchange used for delayed
 *   queues. Registering a task with `{ isDelayed: true }` throws while it is
 *   empty; an explicitly empty string is treated as "not configured".
 * @param {number} [options.mq.connectMaxAttempts] Connection attempts before
 *   giving up (rabbitmq-lib's default applies when omitted).
 * @param {number} [options.mq.delayMS] Delay between connection attempts.
 * @param {object} [options.redis] Redis connection used by the bullmq layer.
 *   Required by `eventReceived()`, which deduplicates through redis.
 * @param {number} [options.redis.port] Redis port.
 * @param {string} [options.redis.host] Redis host.
 * @param {object} [options.logger] Logger exposing `info`, `error` and
 *   `warning`; defaults to the console logger from `lib/utils`.
 * @param {boolean} [options.reconnectOnClose=true] Reconnect automatically when
 *   the MQ connection (or a consumer channel) closes.
 * @param {number} [options.reconnectRetryDelayMS=1000] Base delay of the
 *   exponential backoff used while a recovery attempt keeps failing. Capped at
 *   30 seconds per attempt.
 */
class On extends EventEmitter {
  constructor (options) {
    super()
    this.config = options

    this.mqInstance = new MQ(options.mq)
    this.queueInstance = new Queue(options.mq.delayed_exchange_name)
    this.topicInstance = new Topic(options.mq.exchange_name)
    this.logger = options.logger || logger

    this.events = []
    this.currentEventNameToRegister = null
    this.currentEventTypeToRegister = null
    this.debugEnabled = false
    this.delayedExchangeNameIsEmpty =
      !options.mq.delayed_exchange_name && options.mq.delayed_exchange_name !== ''
    this.reconnectOnClose = options.reconnectOnClose ?? true
    this.reconnectRetryDelayMS = options.reconnectRetryDelayMS ?? 1000
    this._isRecovering = false
  }

  /**
   * No-op that keeps a fluent chain readable between two callbacks. It exists
   * only for readability of `.do(first).and().do(second)`.
   *
   * @returns {On} this
   * @example
   * on.eventReceived('order.created')
   *   .do(firstHandler)
   *   .and()
   *   .do(secondHandler)
   */
  and () {
    return this
  }

  /**
   * Log every internal message through `options.logger`, regardless of the
   * per-event `log()` opt-in.
   *
   * @returns {On} this
   * @example
   * on.debug()
   * await on.init()
   */
  debug () {
    this.debugEnabled = true
    return this
  }

  /**
   * Opt the event currently being registered into logging (in addition to
   * `debug()`, which logs everything).
   *
   * @returns {On} this
   * @example
   * on.eventReceived('order.created').log().do(handleOrder)
   */
  log () {
    this._eventLog(
      'info',
      this.currentEventNameToRegister,
      `Event ${this.currentEventNameToRegister} registered`,
    )

    const eventIndex = this._getEventIndexFromStart(this.currentEventNameToRegister)
    if (eventIndex >= 0) {
      this.events[eventIndex].isLogged = true
    }

    return this
  }

  /**
   * Connect to RabbitMQ, wire reconnection handling and start the listeners of
   * every registered event.
   *
   * WARNING (deliberate): a connection `'error'` is process-fatal only when
   * `options.reconnectOnClose` is disabled — then it is logged and rethrown
   * from the EventEmitter handler, because nothing will recover the consumers
   * and a silently dead service is worse than a crash. With recovery enabled
   * (default) the error is logged and the reconnect path takes over.
   *
   * @returns {Promise<object>} the established MQ connection
   * @throws {Error} when the connection cannot be established
   * @emits On#error
   * @example
   * const on = new On(config)
   * on.eventReceived('order.created').do(handleOrder)
   * await on.init()
   */
  async init () {
    this.mqInstance.on('disconnected', () => {
      return this._recoverFromChannelLoss('Disconnected from MQ. Stop listening for events')
    })

    this.mqInstance.on('connected', (connection) => {
      this.setConnection(connection)
      this._log('info', 'Connected to MQ, initializing topics')
    })

    this.mqInstance.on('connectionAttempt', (attempt) => {
      this._log('info', `MQ Connection attempt number ${attempt}`)
    })

    this.mqInstance.on('reconnected', async (connection) => {
      this.setConnection(connection)
      this._log('info', 'ReConnected to MQ, initializing topics')
      await this._startEventListeners()
    })

    this.mqInstance.on('error', (err) => {
      this._log('error', 'Connection error', err)

      // A connection error is followed by reconnect/reconnected when
      // recovery is enabled; throwing here would crash the process and
      // defeat the advertised recovery.
      if (this.reconnectOnClose) {
        return
      }

      throw err
    })

    this.mqInstance.on('close', async (err) => {
      return this._recoverFromChannelLoss('MQ Connection closed attempting to reconnect', err)
    })

    this._log('info', 'Connecting to RabbitMQ')
    const connection = await this.mqInstance.connect()
    this.setConnection(connection)
    await this._startEventListeners()

    return connection
  }

  /**
   * Store the MQ connection used by `tearDown()`.
   *
   * @param {object} connection MQ connection
   * @returns {void}
   * @example
   * on.setConnection(connection)
   */
  setConnection (connection) {
    this.connection = connection
  }

  /**
   * Current MQ connection, `undefined` before `init()`.
   *
   * @returns {object|undefined} the MQ connection
   * @example
   * const connection = on.getConnection()
   */
  getConnection () {
    return this.connection
  }

  /**
   * Attach loss handlers to a consumer channel. amqplib emits `'close'` (and
   * `'error'`) on the CHANNEL when it dies; without these handlers the
   * recovery path never runs and every consumer on that channel dies silently.
   *
   * @private
   * @param {object} channel channel returned by `createChannel()`
   * @param {string} [reason] human label for the channel kind (e.g. `queue`)
   * @returns {object} the same channel, for chaining at the call site
   */
  _guardChannel (channel, reason) {
    if (!channel || typeof channel.on !== 'function') {
      return channel
    }

    let lossHandled = false

    const onChannelLoss = (type, err) => {
      if (lossHandled) {
        return
      }
      lossHandled = true
      const message = type === 'error'
        ? 'Event channel error, attempting recovery'
        : 'Event channel closed, attempting recovery'
      return this._recoverFromChannelLoss(message, err, reason ? { channel: reason } : undefined)
    }

    channel.on('close', (err) => {
      return onChannelLoss('close', err)
    })

    channel.on('error', (err) => {
      return onChannelLoss('error', err)
    })

    return channel
  }

  /**
   * Single recovery funnel shared by connection-level and channel-level loss.
   * The in-flight flag stops a connection close and a channel close (or two
   * dead channels) from running recovery concurrently.
   *
   * @private
   * @param {string} message failure description, logged at error level
   * @param {*} [err] underlying error, logged as metadata
   * @param {object} [context] extra metadata (e.g. `{ channel: 'queue' }`)
   * @returns {Promise<void>}
   */
  async _recoverFromChannelLoss (message, err, context) {
    const metadata = context ? Object.assign({}, context, { error: err }) : err

    if (!this.reconnectOnClose) {
      this._log('error', message, metadata)
      return
    }

    if (this._isRecovering) {
      return
    }

    this._isRecovering = true
    this._log('error', message, metadata)

    try {
      await this._attemptRecovery(0)
    }
    catch (recoveryErr) {
      this._log('error', 'Recovery failed', recoveryErr)
    }
    finally {
      this._isRecovering = false
    }
  }

  /**
   * Keep attempting recovery with capped exponential backoff until it
   * succeeds. Without this, a broker that stays down longer than one reconnect
   * window leaves the consumers dead-but-logged forever.
   *
   * @private
   * @param {number} attempt zero-based attempt counter
   * @returns {Promise<void>}
   */
  async _attemptRecovery (attempt) {
    // tearDown() may run while a recovery is sleeping between attempts
    if (!this.reconnectOnClose) {
      return
    }

    try {
      if (this.mqInstance.isConnected) {
        // Channel-only loss: the connection survived, so reconnect() would
        // no-op (it returns early when isConnected) and consumers would stay
        // dead. Restore listeners directly on fresh channels instead.
        return await this._startEventListeners()
      }

      return await this.mqInstance.reconnect()
    }
    catch (recoveryErr) {
      const delayMS = Math.max(
        1,
        Math.min(30000, this.reconnectRetryDelayMS * Math.pow(2, attempt)),
      )
      this._log(
        'error',
        `Recovery attempt ${attempt + 1} failed, retrying in ${delayMS}ms`,
        recoveryErr,
      )
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      })
      return this._attemptRecovery(attempt + 1)
    }
  }

  /**
   * Start the listeners for every registered event: topics first, then the
   * queue channel (shared by auto-ack and delayed consumers), the dedicated
   * manual-ack channel and finally the RPC listeners.
   *
   * @private
   * @returns {Promise<void>}
   * @throws {Error} when any listener cannot be created
   */
  async _startEventListeners () {
    const topics = this._getEvents('topic')
    const queues = this._getEvents('queue')
    const requests = this._getEvents('rpc')
    const delayedQueues = this._getEvents('delayedQueue')

    if (topics.length > 0) {
      this._log('info', 'Initializing topics')
      const topicChannel = await this.mqInstance.createChannel()
      this._guardChannel(topicChannel, 'topic')
      this.topicInstance.setChannel(topicChannel)
      await this._initTopics(topics)
    }

    const queueChannel = await this.mqInstance.createChannel()
    this._guardChannel(queueChannel, 'queue')
    this.queueInstance.setChannel(queueChannel)

    if (queues.length > 0) {
      this._log('info', 'Initializing queues')
      await this._initQueues(queues)
    }

    if (delayedQueues.length > 0) {
      this._log('info', 'Initializing delayed queues')
      await this._initDelayedQueues(delayedQueues, { isDelayed: true })
    }

    if (requests.length > 0) {
      this._log('info', 'Initializing request listeners')
      await this._initRPCRequests(requests)
    }
  }

  /**
   * Stop listening to every local event.
   *
   * @private
   * @returns {On} this
   */
  _stopEventsListeners () {
    this._log('info', 'Stopped listening events')
    return this.removeAllListeners()
  }

  /**
   * Stop listening and close every resource: each registered event's bullmq
   * queue and worker, then the MQ connection. Resources that are already
   * closed are tolerated (logged and skipped), so the call never throws — it
   * is safe before `init()` and safe to call more than once.
   *
   * @returns {Promise<void>}
   * @example
   * await on.tearDown()
   */
  async tearDown () {
    this._log('info', 'Tearing down on.js. Closing connection and stopped listening events')
    this.reconnectOnClose = false
    this.removeAllListeners()

    for (const event of this.events) {
      await this._closeRedisResources(event)
    }

    const connection = this.getConnection()
    this.connection = null

    if (!connection) {
      this._log('info', 'No MQ connection to close')
      return
    }

    try {
      await connection.close()
    }
    catch (err) {
      this._log('error', 'Error closing MQ connection', err)
    }
  }

  /**
   * Close the bullmq queue and worker of a single registered event, tolerating
   * already-closed resources.
   *
   * @private
   * @param {object} event registered event
   * @returns {Promise<void>}
   */
  async _closeRedisResources (event) {
    if (event.redisQueue) {
      try {
        await event.redisQueue.close()
      }
      catch (err) {
        this._log('error', 'Error closing redis queue', err)
      }
    }

    if (event.redisWorker) {
      try {
        await event.redisWorker.close()
      }
      catch (err) {
        this._log('error', 'Error closing redis worker', err)
      }
    }
  }

  /**
   * Subscribe to the MQ topic pattern and route every received topic event.
   * A topic with declared `properties` is validated before being handled: a
   * failure is always logged and emitted as `error` when a listener is
   * registered; the message is dropped and the consumer keeps running (no
   * rejection propagates).
   *
   * @private
   * @param {object[]} topics topic events
   * @returns {Promise<object>} the topic listener
   * @throws {Error} when the subscription cannot be created
   */
  async _initTopics (topics) {
    const topicsNames = topics.map((topic) => {
      return topic.eventName
    })

    this._log('info', 'Listening for topics', topicsNames)

    this.topicInstance.on('topicEventReceived', async (data) => {
      const eventName = data.name
      this._log('info', eventName, `Received topic event ${eventName}`, data)

      const topic = this._getEventByName(eventName)

      if (hasProperties(topic) && !this._validationIsSuccess(topic.eventName, data.data)) {
        this._log(
          'error',
          `Validation failed for event ${topic.eventName} due to missing properties, received data`,
          data.data,
        )

        // Same containment as the queue dispatcher: without a listener this
        // emit would throw inside the async listener and crash the process
        // as an unhandled rejection. The message is dropped (`noAck`) and
        // the consumer keeps running.
        if (this.listenerCount('error') > 0) {
          const error = new Error(`Validation failed for event ${topic.eventName}`)
          error.event = topic
          this.emit('error', error)
        }

        return
      }

      return await this._onTopicReceived(topic, data.data)
    })

    return await this.topicInstance.listen(topicsNames)
  }

  /**
   * Route a received topic event: redispatch it, run it as a task, or send it
   * to the local redis queue for a single execution across processes.
   *
   * @private
   * @param {object} event registered topic event
   * @param {object} data message payload
   * @returns {Promise<void>}
   */
  async _onTopicReceived (event, data) {
    this._eventLog('info', event.eventName, `Creating topic queue with name ${event.eventName}`)

    if (event.dispatchAs && event.dispatchAs.length > 0) {
      this._eventLog('info', event.eventName, 'Event is redispatchable')
      return await this._redispatchToMQ(event, data)
    }
    if (event.asTask) {
      this._eventLog('info', event.eventName, 'Event is going to execute as task')
      return await this._onTaskReceived(event, data)
    }

    this._eventLog(
      'info',
      event.eventName,
      `Sending the event to redis as task ${event.eventName}`,
    )
    this._sendToRedisQueueToProcess(event, data)
  }

  /**
   * Consume queue events from MQ and send them to the local redis queue, where
   * they are processed once to avoid duplicate work when several processes
   * consume the same message.
   *
   * @private
   * @param {object[]} queues queue events
   * @returns {Promise<void>}
   * @throws {Error} when the listeners cannot be created
   */
  async _initQueues (queues) {
    const queueChannel = await this.mqInstance.createChannel()
    this._guardChannel(queueChannel, 'queue')
    this.queueInstance.setChannel(queueChannel)

    const autoTasks = queues.filter((task) => task.ackMode !== 'manual')
    const manualTasks = queues.filter((task) => task.ackMode === 'manual')
    const delayedTasks = this._getEvents('delayedQueue')

    // The legacy dispatcher executes auto-ack and delayed tasks: register it
    // whenever either exists — _initDelayedQueues consumes through the same
    // queueEventReceived event, so it must not depend on auto-ack queues.
    if (autoTasks.length > 0 || delayedTasks.length > 0) {
      this._registerQueueEventDispatcher()
    }

    if (autoTasks.length > 0) {
      this._log(
        'info',
        'Initializing queues (auto ack)',
        autoTasks.map((task) => task.eventName),
      )
      await this._initQueuesWithAutoAck(autoTasks)
    }

    // Manual-ack consumers get a DEDICATED channel: their prefetch window
    // must never throttle legacy auto-ack or delayed consumers sharing the
    // default channel (per Arturo's review).
    if (manualTasks.length > 0) {
      const manualChannel = await this.mqInstance.createChannel()
      this._guardChannel(manualChannel, 'queue-manual')
      this._log(
        'info',
        'Initializing queues (manual ack)',
        manualTasks.map((task) => task.eventName),
      )
      await this._initQueuesWithManualAck(manualTasks, manualChannel)
    }
  }

  /**
   * Route the MQ `queueEventReceived` event to the registered queue task,
   * validating its properties when declared.
   *
   * @private
   * @returns {void}
   * @emits On#error
   */
  _registerQueueEventDispatcher () {
    this.queueInstance.on('queueEventReceived', async (data) => {
      const taskName = data.name
      this._eventLog('info', taskName, `Received task on queue ${taskName}`, data.data)

      const task = this._getEventByName(taskName)

      if (hasProperties(task) && !this._validationIsSuccess(task.eventName, data.data)) {
        this._log(
          'error',
          `Validation failed for task ${task.eventName} due to missing properties, received data`,
          data.data,
        )

        // A rejected message must not take the service down: when nobody
        // listens to `error`, emitting it would throw inside this async
        // listener and surface as an unhandled rejection that crashes the
        // process. Drop the message (auto-ack semantics) and keep consuming.
        if (this.listenerCount('error') > 0) {
          const error = new Error(`Validation failed for task ${task.eventName}`)
          error.event = task
          this.emit('error', error)
        }

        return
      }

      return await this._onTaskReceived(task, data.data)
    })
  }

  /**
   * Consume tasks with automatic acknowledgement: the message is acked as soon
   * as it is received. This is the original (legacy) behavior.
   *
   * @private
   * @param {object[]} queues queue events
   * @returns {Promise<object>} the queue listener
   * @throws {Error} when the subscription cannot be created
   */
  async _initQueuesWithAutoAck (queues) {
    const queueNames = queues.map((queue) => {
      return queue.eventName
    })

    this._log('info', 'Listening for queueNames', queueNames)

    return await this.queueInstance.listen(queueNames)
  }

  /**
   * Consume tasks with manual acknowledgement. The broker holds the delivery
   * until the handler finishes (prefetch 1 across the whole channel), so the
   * service processes one task at a time and nothing is lost on crash
   * (redelivery).
   *
   * @private
   * @param {object[]} tasks queue events registered with `ackAfterProcessing()`
   * @param {object} manualChannel dedicated channel for manual-ack consumers
   * @returns {Promise<void>}
   * @throws {Error} when the subscription cannot be created
   */
  async _initQueuesWithManualAck (tasks, manualChannel) {
    const queueNames = tasks.map((task) => task.eventName)
    this._log('info', 'Initializing queues (manual ack)', queueNames)

    const tasksByQueueName = {}
    for (const task of tasks) {
      tasksByQueueName[task.eventName] = task
    }

    const handler = async (data, message) => {
      const taskDef = tasksByQueueName[message.fields.routingKey]
      try {
        if (taskDef && hasProperties(taskDef) && !this._validationIsSuccess(taskDef.eventName, data)) {
          throw new Error(`Validation failed for task ${taskDef.eventName}`)
        }

        await this._onTaskReceived(taskDef, data, { awaitActions: true })
      }
      catch (err) {
        const loggedName = taskDef ? taskDef.eventName : message.fields.routingKey
        this._log('error', loggedName, 'Task failed, dropping (service-api republishes by demand)', err)
        throw err
      }
    }

    // The manual consumer runs on its own channel: swap it in for the
    // listenManual() call only, so the shared channel keeps serving auto-ack
    // and delayed consumers with their own prefetch window.
    const sharedChannel = this.queueInstance.channel
    this.queueInstance.setChannel(manualChannel)
    try {
      await this.queueInstance.listenManual(queueNames, handler, { globalPrefetch: true })
    }
    finally {
      this.queueInstance.setChannel(sharedChannel)
    }
  }

  /**
   * Consume delayed queue tasks through the queue instance.
   *
   * @private
   * @param {object[]} delayedQueues delayed queue events
   * @param {object} options listener options (`{ isDelayed: true }`)
   * @returns {Promise<object>} the queue listener
   * @throws {Error} when the subscription cannot be created
   */
  async _initDelayedQueues (delayedQueues, options) {
    const queueNames = delayedQueues.map((queue) => queue.eventName)
    this._log('info', 'Listening for delayedQueueNames', queueNames)
    return await this.queueInstance.listen(queueNames, options)
  }

  /**
   * Execute every action of a task with the received data.
   *
   * Without `options.awaitActions` the actions are executed with the legacy
   * fire-and-forget semantics (results are logged, failures swallowed). With
   * `awaitActions` the method waits for EVERY action before propagating a
   * failure, so one rejection cannot release the next delivery while a sibling
   * action is still running (manual ack / redis deduplicated processing).
   *
   * @private
   * @param {object} task registered queue event
   * @param {object} data message payload
   * @param {object} [options={}]
   * @param {boolean} [options.awaitActions=false] wait for all actions and
   *   reject when one of them rejects
   * @returns {Promise<*>} settled results (legacy mode) or `undefined`
   * @throws {Error} first rejection in `awaitActions` mode
   */
  async _onTaskReceived (task, data, options = {}) {
    this._eventLog('info', task.eventName, 'Executing task callback for task')

    const executions = task.actions.map((action) => {
      try {
        return action.call(task, data)
      }
      catch (err) {
        // a synchronous throw must not bypass the settle-wait below
        return Promise.reject(err)
      }
    })

    if (options.awaitActions) {
      // wait for EVERY action before propagating a failure: one rejection
      // must not release the next delivery while a sibling action still runs
      const settled = await Promise.allSettled(executions)
      const firstRejection = settled.find((result) => result.status === 'rejected')
      if (firstRejection) {
        throw firstRejection.reason
      }
      return
    }

    return await Promise.allSettled(executions)
      .then((results) => {
        this._eventLog(
          'info',
          task.eventName,
          `Results of all executions for task ${task.eventName}`,
          results,
        )
      })
      .catch((err) => {
        this._eventLog('error', task.eventName, err)
      })
  }

  /**
   * Listen for every registered RPC request on its own channel.
   *
   * @private
   * @param {object[]} requests RPC events
   * @returns {Promise<void>}
   * @throws {Error} when a listener cannot be created
   */
  async _initRPCRequests (requests) {
    this._log('info', 'Listening for rpc requests')

    for (const request of requests) {
      const rpcInstance = new RPC()
      const channel = await this.mqInstance.createChannel()
      this._guardChannel(channel, `rpc ${request.eventName}`)
      rpcInstance.setChannel(channel)
      this._log('info', `Listening rpc request ${request.eventName}`)
      await rpcInstance.listen(request.eventName, request.actions[0])
    }
  }

  /**
   * Register a topic event whose work is executed exactly once across
   * processes: the message is added to a redis queue with `data.tid` as job id
   * (deduplication) and processed by a single worker.
   *
   * @param {string} eventName topic name
   * @returns {On} this
   * @throws {Error} when `options.redis` is not configured
   * @throws {Error} when the event is already registered as a topic
   * @example
   * on.eventReceived('order.created')
   *   .withProperties(['id'])
   *   .do(handleOrder)
   */
  eventReceived (eventName) {
    if (!this.config.redis) {
      throw new Error('Redis config must be set if enabling events listeners')
    }

    this.currentEventNameToRegister = eventName
    this.currentEventTypeToRegister = 'topic'

    if (this._eventExists(eventName, 'topic')) {
      this._eventLog('info', eventName, `The event ${eventName} is already registered`)
      throw new Error(`The event ${eventName} is already registered`)
    }

    const redisQueue = new RedisQueue(eventName, {
      connection: { host: this.config.redis.host, port: this.config.redis.port },
    })

    // Attached once, at registration: attaching per received message leaked a
    // listener for every message (MaxListenersExceededWarning, unbounded).
    redisQueue.on('error', (err) => {
      this._eventLog('error', eventName, 'Error on redis queue', err)
    })

    this.events.push({
      eventName,
      type: 'topic',
      redisQueue,
    })

    this._eventLog('info', eventName, `Registered event ${eventName} and redis queue ${eventName}`)

    return this
  }

  /**
   * Register a topic event that is executed as a task by every process (no
   * redis deduplication and no property validation).
   *
   * @param {string} eventName topic name
   * @returns {On} this
   * @throws {Error} when the event is already registered as a topic
   * @example
   * on.broadcastReceived('config.updated')
   *   .andDispatchAs('config.applied')
   *   .do(reloadConfig)
   */
  broadcastReceived (eventName) {
    this.currentEventNameToRegister = eventName
    this.currentEventTypeToRegister = 'topic'

    if (this._eventExists(eventName, 'topic')) {
      this._eventLog('info', eventName, `The event ${eventName} is already registered`)
      throw new Error(`The event ${eventName} is already registered, possibly as eventReceived`)
    }

    this.events.push({
      eventName,
      type: 'topic',
      asTask: true,
    })

    this._eventLog('info', eventName, `Registered event ${eventName} as broadcast`)
    return this
  }

  /**
   * Register a queue task. Tasks are consumed with automatic
   * acknowledgement unless `ackAfterProcessing()` is chained.
   *
   * @param {string} taskName queue name
   * @param {object} [options={ isDelayed: false }]
   * @param {boolean} [options.isDelayed=false] register against the delayed
   *   exchange instead of the regular queue
   * @returns {On} this
   * @throws {Error} when the task is already registered with the same type
   * @throws {Error} when `isDelayed` is set and
   *   `options.mq.delayed_exchange_name` is empty
   * @example
   * on.taskReceived('order.persist')
   *   .ackAfterProcessing()
   *   .andProcess(saveOrder)
   */
  taskReceived (taskName, options = { isDelayed: false }) {
    const eventType = options.isDelayed ? 'delayedQueue' : 'queue'
    this.currentEventNameToRegister = taskName
    this.currentEventTypeToRegister = eventType

    this._eventLog('info', taskName, `Registering task ${taskName}`)

    if (this._eventExists(taskName, eventType)) {
      this._eventLog('info', taskName, `The task ${taskName} is already registered`)
      throw new Error(`The task ${taskName} is already registered`)
    }

    if (options.isDelayed && this.delayedExchangeNameIsEmpty) {
      const message = `The task ${taskName} is set as delayed but the delayed_exchange_name is empty, ` +
        'make sure that options.mq.delayed_exchange_name is set'
      this._eventLog('info', taskName, message)
      throw new Error(message)
    }

    this.events.push({
      eventName: taskName,
      type: eventType,
    })

    this._eventLog('info', taskName, `Registered task ${taskName}`)
    return this
  }

  /**
   * Register an RPC request. Chain `respond()` to consume it and
   * `afterExecuting()` to attach the reply callback.
   *
   * @param {string} eventName RPC name
   * @returns {On} this
   * @throws {Error} when the request is already registered as RPC
   * @example
   * on.requestReceived('order.status')
   *   .respond()
   *   .afterExecuting(getStatus)
   */
  requestReceived (eventName) {
    this.currentEventNameToRegister = eventName
    this.currentEventTypeToRegister = 'rpc'

    if (this._eventExists(eventName, 'rpc')) {
      this._eventLog('info', eventName, `Request ${eventName} already registered`)
      throw new Error(`Request ${eventName} already registered`)
    }

    this.events.push({
      eventName,
      type: 'rpc',
    })

    this._eventLog('info', eventName, `Registered request ${eventName}`)
    return this
  }

  /**
   * Mark the current RPC request as consumer: the instance becomes the
   * callback context so the reply is sent back over the RPC channel.
   *
   * @returns {On} this
   * @throws {Error} when the request was not registered first
   * @example
   * on.requestReceived('order.status').respond().afterExecuting(getStatus)
   */
  respond () {
    const eventIndex = this._getEventIndexByNameAndType(
      this.currentEventNameToRegister,
      this.currentEventTypeToRegister,
    )

    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('The event hasn\'t been registered first')
    }

    this.events[eventIndex].context = this
    return this
  }

  /**
   * Declare the properties a received payload must contain. Validation uses
   * the `in` operator (own or inherited keys) and is skipped entirely when no
   * properties are declared.
   *
   * @param {string[]} properties property names
   * @returns {On} this
   * @throws {Error} when `properties` is not an array
   * @throws {Error} when the event was not registered first
   * @example
   * on.eventReceived('order.created')
   *   .withProperties(['id', 'total'])
   *   .do(handleOrder)
   */
  withProperties (properties) {
    if (!Array.isArray(properties)) {
      throw new Error('The properties must be an array')
    }

    const eventIndex = this._getEventIndexByNameAndType(
      this.currentEventNameToRegister,
      this.currentEventTypeToRegister,
    )

    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('The event hasn\'t been registered first')
    }

    this.events[eventIndex].properties = properties
    return this
  }

  /**
   * Consume the current queue task with manual acknowledgement: the broker
   * waits for the handler and redelivers when the process crashes mid-task.
   * Only regular queue tasks support it (not delayed queues, topics or RPC).
   *
   * @returns {On} this
   * @throws {Error} when the event is not a regular queue task
   * @throws {Error} when `taskReceived()` was not called first
   * @example
   * on.taskReceived('order.persist').ackAfterProcessing().andProcess(saveOrder)
   */
  ackAfterProcessing () {
    if (this.currentEventTypeToRegister !== 'queue') {
      throw new Error(
        'ackAfterProcessing is only supported for queue events (not delayed queues, topics or RPC)',
      )
    }

    const eventIndex = this._getEventIndexByNameAndType(
      this.currentEventNameToRegister,
      this.currentEventTypeToRegister,
    )

    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('Call taskReceived before setting the ack mode')
    }

    this.events[eventIndex].ackMode = 'manual'
    return this
  }

  /**
   * Register the callback of the event being registered.
   *
   * @param {Function} callback action executed with the received data
   * @returns {On} this
   * @throws {Error} when no callback is provided or it is not a function
   * @throws {Error} when the event was not registered first
   * @example
   * on.eventReceived('order.created').do(handleOrder)
   */
  do (callback) {
    return this._registerCallback(callback)
  }

  /**
   * Alias of `do()` for queue tasks.
   *
   * @param {Function} callback action executed with the received data
   * @returns {On} this
   * @throws {Error} when no callback is provided or it is not a function
   * @example
   * on.taskReceived('order.persist').andProcess(saveOrder)
   */
  andProcess (callback) {
    return this._registerCallback(callback)
  }

  /**
   * Alias of `do()` for RPC requests.
   *
   * @param {Function} callback reply callback
   * @returns {On} this
   * @throws {Error} when no callback is provided or it is not a function
   * @example
   * on.requestReceived('order.status').respond().afterExecuting(getStatus)
   */
  afterExecuting (callback) {
    return this._registerCallback(callback)
  }

  /**
   * Alias of `andDispatchAs()` kept for the legacy API.
   *
   * @param {string} newEventName destination queue name
   * @returns {On} this
   * @throws {Error} when the event is not a registered topic
   * @example
   * on.eventReceived('order.created').sendToQueue('order.persist')
   */
  sendToQueue (newEventName) {
    return this.andDispatchAs(newEventName)
  }

  /**
   * Register the callback of the event being registered (shared by `do`,
   * `andProcess` and `afterExecuting`).
   *
   * @private
   * @param {Function} callback action executed with the received data
   * @returns {On} this
   * @throws {Error} when no callback is provided or it is not a function
   * @throws {Error} when the event was not registered first
   */
  _registerCallback (callback) {
    if (!callback) {
      throw new Error(
        'A callback needs to be registered first calling the do method or the registerCallback method',
      )
    }

    if (typeof callback !== 'function') {
      throw new Error('A callback needs to be registered first and be a function')
    }

    const eventIndex = this._getEventIndexByNameAndType(
      this.currentEventNameToRegister,
      this.currentEventTypeToRegister,
    )

    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('The event hasn\'t been registered first')
    }

    this._initializeActionsArrayIfItDoesNotExist(eventIndex)

    this.events[eventIndex].actions.push(callback)
    this.events[eventIndex].context = this
    return this
  }

  /**
   * Ensure the event has an actions array.
   *
   * @private
   * @param {number} eventIndex index in `this.events`
   * @returns {void}
   */
  _initializeActionsArrayIfItDoesNotExist (eventIndex) {
    if (!this.events[eventIndex].actions || !Array.isArray(this.events[eventIndex].actions)) {
      this.events[eventIndex].actions = []
    }
  }

  /**
   * Validate a payload against the properties declared for an event. An event
   * without declared properties (or with an empty list) always passes.
   *
   * @private
   * @param {string} eventName registered event name
   * @param {object} data received payload
   * @returns {boolean} whether every declared property is present
   */
  _validationIsSuccess (eventName, data) {
    const event = this._getEventByName(eventName)
    const properties = event && event.properties

    if (!Array.isArray(properties) || properties.length === 0) {
      return true
    }

    return properties.every((property) => {
      return property in data
    })
  }

  /**
   * Mark the current topic as redispatchable: every received message is sent
   * to each given queue name after being deduplicated through redis.
   *
   * @param {string} newEventName destination queue name
   * @returns {On} this
   * @throws {Error} when the event was not registered first
   * @throws {Error} when the event is not a topic
   * @example
   * on.eventReceived('order.created').andDispatchAs('order.persist')
   */
  andDispatchAs (newEventName) {
    const eventIndex = this._getEventIndexByNameAndType(
      this.currentEventNameToRegister,
      this.currentEventTypeToRegister,
    )

    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error(`The event ${this.currentEventNameToRegister} hasn't been registered first`)
    }

    if (!this._eventIsTopic(this.events[eventIndex])) {
      throw new Error(
        'Dispatchable events should be registered as topics. Execute the method onEventReceived ' +
        `instead of onTaskReceived on the event ${this.currentEventNameToRegister}`,
      )
    }

    if (this.events[eventIndex].dispatchAs && Array.isArray(this.events[eventIndex].dispatchAs)) {
      this.events[eventIndex].dispatchAs.push(newEventName)
    }
    else {
      this.events[eventIndex].dispatchAs = []
      this.events[eventIndex].dispatchAs.push(newEventName)
    }

    return this
  }

  /**
   * Deduplicate a topic message through redis, then send it to every
   * `dispatchAs` queue on MQ. All sends are awaited before the job completes,
   * so the redis job is only done once every destination accepted it.
   *
   * bullmq internals: `jobId` is `data.tid` (the message id stamped by
   * rabbitmq-lib; non-string ids are coerced by bullmq, rml stamps uuid
   * strings), `attempts: 1` (no retry — a failure is left for inspection),
   * `removeOnComplete`/`removeOnFail` are false so jobs stay for auditing.
   *
   * @private
   * @param {object} event registered topic event with `dispatchAs`
   * @param {object} data message payload
   * @returns {Promise<object>} the added bullmq job
   * @throws {Error} when the job cannot be added
   */
  async _redispatchToMQ (event, data) {
    const taskName = event.eventName
    const processName = `${event.eventName}-${data.tid}`

    this._ensureWorker(event, async (job) => {
      try {
        this._eventLog(
          'info',
          event.eventName,
          `Processing redis event ${taskName} and redispatching as ${event.dispatchAs}`,
        )

        for (const dispatchName of event.dispatchAs) {
          this._eventLog('info', event.eventName, `Dispatching to queue on mq as ${dispatchName}`)
          await this.queueInstance.send(dispatchName, job.data)
        }

        this._eventLog('info', event.eventName, 'Job done')
      }
      catch (err) {
        this._log('error', err)
      }
    })

    return await event.redisQueue.add(processName, data, {
      jobId: data.tid,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    })
  }

  /**
   * Deduplicate a topic message through redis and execute the registered
   * actions once, whichever process picks the job up.
   *
   * Same bullmq internals as `_redispatchToMQ`: `jobId` is `data.tid` so a
   * redelivered message does not create a second job, `attempts: 1`, and jobs
   * are kept (`removeOnComplete`/`removeOnFail` false).
   *
   * @private
   * @param {object} event registered topic event with actions
   * @param {object} data message payload
   * @returns {Promise<void>}
   */
  async _sendToRedisQueueToProcess (event, data) {
    const processName = `${event.eventName}-${data.tid}`

    this._eventLog('info', event.eventName, `Registering task with redis as process ${processName}`)

    this._ensureWorker(event, (job) => {
      this._eventLog(
        'info',
        event.eventName,
        `Processing redis event ${event.eventName} and executing callback`,
      )
      this._eventLog('info', event.eventName, 'Calling event callback')

      return Promise.allSettled(event.actions.map((action) => {
        return action.call(event, job.data, next)
      }))
        .then((results) => {
          this._eventLog('info', event.eventName, 'Results of all executions', results)
        })
    })

    event.redisQueue.add(processName, data, {
      jobId: data.tid,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    })
  }

  /**
   * Create (once per event) the bullmq worker that processes the redis queue.
   *
   * bullmq has one worker per queue, not one processor per job: the worker is
   * created on the first message and reused afterwards. `lockDuration: 3000`
   * replaces bull's per-job `timeout: 3000`, which has no bullmq equivalent —
   * it is STALL DETECTION (the job is considered stalled and redelivered when
   * the worker holds it longer than this without renewing the lock), not a
   * per-job timeout.
   *
   * @private
   * @param {object} event registered topic event
   * @param {Function} processor bullmq processor
   * @returns {object} the bullmq worker
   */
  _ensureWorker (event, processor) {
    if (event.redisWorker) {
      return event.redisWorker
    }

    event.redisWorker = new Worker(event.eventName, processor, {
      connection: { host: this.config.redis.host, port: this.config.redis.port },
      lockDuration: 3000,
    })

    event.redisWorker.on('error', (err) => {
      this._eventLog('error', event.eventName, 'Error on redis worker', err)
    })

    return event.redisWorker
  }

  /**
   * Log a message when debug mode is on. Errors are always logged: they
   * explain consumer death and recovery, and `debug()` is not enabled by
   * consumers in production.
   *
   * @private
   * @param {'info'|'error'|'warning'} type logger level
   * @param {string} message message
   * @param {*} [metadata] optional data
   * @returns {void}
   */
  _log (type, message, metadata) {
    if (this.debugEnabled || type === 'error') {
      return this.logger[type](message, metadata)
    }
  }

  /**
   * Log a message when debug mode is on, or when the given event opted in
   * through `log()`.
   *
   * @private
   * @param {'info'|'error'|'warning'} type logger level
   * @param {string} eventName registered event name
   * @param {string} message message
   * @param {*} [metadata] optional data
   * @returns {void}
   */
  _eventLog (type, eventName, message, metadata) {
    if (this.debugEnabled) {
      return this.logger[type](message, metadata)
    }

    const eventIndex = this._getEventIndex(eventName)
    if (eventIndex >= 0) {
      const event = this.events[eventIndex]
      if (event.isLogged) {
        return this.logger[type](message, metadata)
      }
    }
  }

  /**
   * Registered events of a type. Valid types are `topic`, `queue`,
   * `delayedQueue` and `rpc`.
   *
   * @private
   * @param {string} type event type
   * @returns {object[]} matching events
   */
  _getEvents (type) {
    return this.events.filter((event) => {
      return event.type === type
    })
  }

  /**
   * Names of the registered events of a type.
   *
   * @private
   * @param {string} type event type
   * @returns {string[]} matching event names
   */
  _getEventNames (type) {
    const events = this.events.filter((event) => {
      return event.type === type
    })

    return events.map((event) => {
      return event.eventName
    })
  }

  /**
   * Index of an event by name, searched from the start of the list.
   *
   * @private
   * @param {string} eventName event name
   * @returns {number} index in `this.events`, or -1 when not registered
   */
  _getEventIndex (eventName) {
    return this._getEventIndexFromStart(eventName)
  }

  /**
   * Index of an event by name, searched from the start of the list.
   *
   * @private
   * @param {string} eventName event name
   * @returns {number} index in `this.events`, or -1 when not registered
   */
  _getEventIndexFromStart (eventName) {
    const names = this.events.map((element) => {
      return element.eventName
    })

    return names.indexOf(eventName)
  }

  /**
   * Whether an event with the given name and type is registered.
   *
   * @private
   * @param {string} eventName event name
   * @param {string} type event type
   * @returns {boolean} Whether the event is registered
   */
  _eventExists (eventName, type) {
    return this.events.some((event) => {
      return event.eventName === eventName && event.type === type
    })
  }

  /**
   * First registered event with the given name, whatever its type.
   *
   * @private
   * @param {string} eventName event name
   * @returns {object|undefined} the matching event
   */
  _getEventByName (eventName) {
    return this.events.find((event) => {
      return event.eventName === eventName
    })
  }

  /**
   * Array index of the last matching event, or -1 when the event is not
   * registered. The index is used directly to access `this.events`.
   *
   * @private
   * @param {string} eventName event name
   * @param {string} type event type
   * @returns {number} index in `this.events`, or -1
   */
  _getEventIndexByNameAndType (eventName, type) {
    return this.events.findLastIndex((event) => {
      return event.eventName === eventName && event.type === type
    })
  }

  /**
   * Whether the event is a topic.
   *
   * @private
   * @param {object} event registered event
   * @returns {boolean} true when the event type is `topic`
   */
  _eventIsTopic (event) {
    return event.type === 'topic'
  }
}

module.exports = On
