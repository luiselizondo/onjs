var RedisQueue = require('bull');
var _ = require('lodash')
var Q = require('q')
var EventEmitter = require('events')
var utils = require('./utils')
var hasProperties = utils.hasProperties
var eventIsDeclaredBeforeCallingRegisterCallback = utils.eventIsDeclaredBeforeCallingRegisterCallback
var next = utils.next
var logger = utils.logger

var MQ = require('rabbitmq-lib').MQ
var Queue = require('rabbitmq-lib').Queue
var Topic = require('rabbitmq-lib').Topic
var RPC = require('rabbitmq-lib').RPC

class On extends EventEmitter {
  constructor(options) {
    super()
    this.config = options

    this.mqInstance = new MQ(options.mq)
    this.queueInstance = new Queue()
    this.topicInstance = new Topic(options.mq.exchange_name)
    this.logger = options.logger || logger

    this.events = []
    this.currentEventNameToRegister = null
    this.currentEventTypeToRegister = null
    this.debugEnabled = false

    return this
  }

  and () {
    return this
  }
  debug () {
    this.debugEnabled = true
    return this
  }

  log () {
    this._eventLog('info', this.currentEventNameToRegister, `Event ${this.currentEventNameToRegister} registered`)
    var eventIndex = this._getEventIndexFromStart(this.currentEventNameToRegister)
    if (eventIndex >= 0) {
      this.events[eventIndex].isLogged = true
    }

    return this
  }

  // Consume events from MQ
  // Once an event has been received by MQ
  // It will trigger an event on mq
  // that will be picked up by the _init* methods.
  // Each of those methods subscribe locally to an event of the same name As MQ
  async init () {
    try {
      this.mqInstance.on('disconnected', () => {
        this._log('info', 'Disconnected from MQ. Stop listening for events')
        this.mqInstance.reconnect()
      })

      this.mqInstance.on('connected', async (connection) => {
        this.setConnection(connection)
        this._log('info', 'Connected to MQ, initializing topics')
      })

      this.mqInstance.on('reconnected', async (connection) => {
        this.setConnection(connection)
        this._log('info', 'ReConnected to MQ, initializing topics')
        await this._startEventListeners()
      })

      this.mqInstance.on('error', (err) => {
        this._log('error', 'Connection error', err)
        throw err
      })

      this._log('info', 'Connecting to RabbitMQ')
      var connection = await this.mqInstance.connect()
      this.setConnection(connection)
      await this._startEventListeners()

      return connection
    }
    catch (err) {
      this._log('error', err)
      throw err
    }
  }

  setConnection (_connection) {
    this.connection = _connection
  }

  getConnection () {
    return this.connection
  }

  async _startEventListeners () {
    try {
      var topics = this._getEvents('topic')
      var queues = this._getEvents('queue')
      var requests = this._getEvents('rpc')

      if (topics.length > 0) {
        this._log('info', 'Initializing topics')
        var topicChannel = await this.mqInstance.createChannel()
        this.topicInstance.setChannel(topicChannel)
        await this._initTopics(topics)
      }

      var queueChannel = await this.mqInstance.createChannel()
      this.queueInstance.setChannel(queueChannel)

      if (queues.length > 0) {
        this._log('info', 'Initializing queues')
        await this._initQueues(queues)
      }

      if (requests.length > 0) {
        this._log('info', 'Initializing request listeners')
        await this._initRPCRequests(requests)
      }

      return
    }
    catch (err) {
      throw err
    }
  }

  _stopEventsListeners () {
    this._log('info', 'Stopped listening events')
    return this.removeAllListeners()
  }

  async tearDown () {
    try {
      this._log('info', 'Tearing down on.js. Closing connection and stopped listening events')
      this.removeAllListeners()
      var connection = this.getConnection()
      return await connection.close()
    }
    catch (err) {
      throw err
    }
  }

  // Consume events from MQ based on topics pattern
  async _initTopics (topics) {
    try {
      var topicsNames = topics.map((topic) => {
        return topic.eventName
      })

      this._log('info', 'Listening for topics', topicsNames)

      this.topicInstance.on('topicEventReceived', async (data) => {
        let eventName = data.name
        this._log('info', eventName, `Received topic event ${eventName}`, data)

        let topic = this._getEventByName(eventName)

        if (hasProperties(topic) && !this._validationIsSuccess(topic.eventName, data.data)) {
          var error = new Error(`Validation failed for event ${topic.eventName}`)
          error.event = topic

          this.emit('error', error)
          throw error
        }

        return await this._onTopicReceived(topic, data.data)
      })

      var listener = await this.topicInstance.listen(topicsNames)
      return listener
    }
    catch (err) {
      throw err
    }
  }

  async _onTopicReceived (event, data) {
    try {
      this._eventLog('info', event.eventName, `Creating redis queue with name ${event.eventName}`)

      if (event.dispatchAs && event.dispatchAs.length > 0) {
        this._eventLog('info', event.eventName, `Event is redispatchable`)
        await this._redispatchToMQ(event, data)
      }
      else {
        this._eventLog('info', event.eventName, `Sending the event to redis as task ${event.eventName}`)
        this._sendToRedisQueueToProcess(event, data)
      }
    }
    catch (err) {
      throw err
    }
  }

  // Consume queue events from MQ
  // Once the event is received it will be sent
  // To a local redis-based queue
  // Where it will be processed to avoid duplicate
  // events sent from multiple processes
  async _initQueues (queues) {
    try {
      var queueNames = queues.map((queue) => {
        return queue.eventName
      })

      this._log('info', 'Listening for queueNames', queueNames)

      this.queueInstance.on('queueEventReceived', async (data) => {
        try {
          let taskName = data.name
          this._eventLog('info', taskName, `Received task on queue ${taskName}`)
          this._eventLog('info', taskName, data.data)

          let task = this._getEventByName(taskName)

          if (hasProperties(task) && !this._validationIsSuccess(task.eventName, data.data)) {
            this._log('error', `Validation failed for task ${task.eventName} due to missing properties, received data`)
            this._log('error', data.data)
            var error = new Error(`Validation failed for task ${task.eventName}`)
            error.event = task

            this.emit('error', error)
            throw error
          }

          return this._onTaskReceived(task, data.data)
        }
        catch (err) {
          throw err
        }
      })

      var listener = await this.queueInstance.listen(queueNames)
      return listener
    }
    catch (err) {
      throw err
    }
  }

  _onTaskReceived (task, data) {
    this._eventLog('info', task.eventName, 'Executing task callback for task')
    this._eventLog('info', task.eventName, task)

    return Q.allSettled(task.actions.map((action) => {
      return action.call(task, data)
    }))
      .then((results) => {
        this._eventLog('info', task.eventName, 'Results of all executions')
        this._eventLog('info', task.eventName, results)
      })
  }

  async _initRPCRequests (requests) {
    try {
      this._log('info', 'Listening for rpc requests', requests)

      for (let request of requests) {
        let rpcInstance = new RPC()
        let channel = await this.mqInstance.createChannel()
        rpcInstance.setChannel(channel)
        this._log('info', `Listening rpc request ${request.eventName}`, channel)
        await rpcInstance.listen(request.eventName, request.actions[0])
      }

      return
    }
    catch (err) {
      throw err
    }
  }

  eventReceived (eventName) {
    if (!this.config.redis) {
      throw new Error(`Redis config must be set if enabling events listeners`)
    }

    this.currentEventNameToRegister = eventName
    this.currentEventTypeToRegister = 'topic'

    if (this._eventExists(eventName, 'topic')) {
      this._eventLog('info', eventName, `The event ${eventName} is already registered`)
      throw new Error(`The event ${eventName} is already registered`)
    }

    let redisQueue = new RedisQueue(eventName, {
      redis: this.config.redis
    })

    this.events.push({
      eventName: eventName,
      type: 'topic',
      redisQueue: redisQueue
    })

    this._eventLog('info', eventName, `Registered event ${eventName} and redis queue ${eventName}`)

    return this
  }

  taskReceived (taskName) {
    this.currentEventNameToRegister = taskName
    this.currentEventTypeToRegister = 'queue'

    this._eventLog('info', taskName, `Registering task ${taskName}`)

    if (this._eventExists(taskName, 'queue')) {
      this._eventLog('info', taskName, `The task ${taskName} is already registered`)
      throw new Error(`The task ${taskName} is already registered`)
    }

    this.events.push({
      eventName: taskName,
      type: 'queue'
    })

    this._eventLog('info', taskName, `Registered task ${taskName}`)
    return this
  }

  requestReceived (eventName) {
    this.currentEventNameToRegister = eventName
    this.currentEventTypeToRegister = 'rpc'

    if (this._eventExists(eventName, 'rpc')) {
      this._eventLog('info', eventName, `Request ${eventName} already registered`)
      throw new Error(`Request ${eventName} already registered`)
    }

    this.events.push({
      eventName: eventName,
      type: 'rpc'
    })

    this._eventLog('info', eventName, `Registered request ${eventName}`)
    return this
  }

  respond () {
    var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)
    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('The event hasn\'t been registered first')
    }

    this.events[eventIndex].context = this
    return this
  }

  withProperties (properties) {
    if (!_.isArray(properties)) {
      throw new Error('The properties must be an array')
    }

    var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)
    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('The event hasn\'t been registered first')
    }

    this.events[eventIndex].properties = properties
    return this
  }

  // Alias method
  do (callback) {
    return this._registerCallback(callback)
  }

  // Alias method
  andProcess (callback) {
    return this._registerCallback(callback)
  }

  // Alias method
  afterExecuting (callback) {
    return this._registerCallback(callback)
  }

  // Alias method
  sendToQueue (newEventName) {
    return this.andDispatchAs(newEventName)
  }

  _registerCallback (callback) {
    if (!callback) {
      throw new Error('A callback needs to be registered first calling the do method or the registerCallback method')
    }

    if (typeof callback !== 'function') {
      throw new Error('A callback needs to be registered first and be a function')
    }

    var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)

    if (!eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      throw new Error('The event hasn\'t been registered first')
    }

    this._initializeActionsArrayIfItDoesNotExist(eventIndex)

    this.events[eventIndex].actions.push(callback)
    this.events[eventIndex].context = this
    return this
  }

  _initializeActionsArrayIfItDoesNotExist (eventIndex) {
    if (!this.events[eventIndex].actions || !Array.isArray(this.events[eventIndex].actions)) {
      this.events[eventIndex].actions = []
    }
  }

  _validationIsSuccess (eventName, data) {
    var event = this._getEventByName(eventName)
    var properties = event.properties

    var hasEveryProperty = properties.every((property) => {
      return property in data
    })

    return hasEveryProperty
  }

  andDispatchAs (newEventName) {
    var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)
    if (eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
      if (!this._eventIsTopic(this.events[eventIndex])) {
        throw new Error(`Dispatchable events should be registered as topics. Execute the method onEventReceived instead of onTaskReceived on the event ${this.currentEventNameToRegister}`)
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
    else {
      throw new Error(`The event ${this.currentEventNameToRegister} hasn\'t been registered first`)
    }
  }

  async _redispatchToMQ (event, data) {
    try {
      var taskName = event.eventName
      var newEventName = event.dispatchAs
      var processName = event.eventName + '-' + data.tid

      event.redisQueue.process(processName, async (job, jobDone) => {
        try {
          this._eventLog('info', event.eventName, `Processing redis event ${taskName} and redispatching as ${newEventName}`)

          event.dispatchAs.forEach(async (newEventName) => {
            this._eventLog('info', event.eventName, `Dispatching to queue on mq as ${newEventName}`)
            return await this.queueInstance.send(newEventName, job.data)
          })

          this._eventLog('info', event.eventName, 'Job done')
          return jobDone()
        }
        catch (err) {
          this._log('error', err)
        }
      })

      event.redisQueue.on('error', err => {
        this._eventLog('error', event.eventName, 'Error on redis queue')
        this._eventLog('error', event.eventName, err)
      })

      return event.redisQueue.add(processName, data, {
        jobId: data.tid,
        attempts: 0,
        removeOnFail: false,
        timeout: 3000
      })
    }
    catch (err) {
      this._log('error', err)
      throw err
    }
  }

  async _sendToRedisQueueToProcess (event, data) {
    try {
      var processName = event.eventName + '-' + data.tid

      this._eventLog('info', event.eventName, `Registering task with redis as process ${processName}`)

      event.redisQueue.process(processName, (job, jobDone) => {
        this._eventLog('info', event.eventName, `Processing redis event ${event.eventName} and executing callback`)
        this._eventLog('info', event.eventName, `Calling event callback`)

        return Q.allSettled(event.actions.map((action) => {
          return action.call(event, data, next)
        }))
          .then((results) => {
            this._eventLog('info', event.eventName, 'Results of all executions')
            this._eventLog('info', event.eventName, results)
            jobDone()
          })
      })

      event.redisQueue.on('error', err => {
        this._eventLog('error', event.eventName, 'Error on redis queue')
        this._eventLog('error', event.eventName, err)
      })

      event.redisQueue.add(processName, data, {
        jobId: data.tid,
        attempts: 0,
        removeOnFail: false,
        timeout: 3000
      })
    }
    catch (err) {
      this._log('error', err)
      throw err
    }
  }

  _log (type, message) {
    if (this.debugEnabled) {
      return this.logger[type](message)
    }
  }

  _eventLog (type, eventName, message) {
    if (this.debugEnabled) {
      return this.logger[type](message)
    }

    var eventIndex = this._getEventIndex(eventName)
    if (eventIndex >= 0) {
      var event = this.events[eventIndex]
      if (event.isLogged) {
        return this.logger[type](message)
      }
    }
  }

  // Valid Types are:
  // - topic
  // - queue
  // - rpc
  _getEvents (type) {
    return _.filter(this.events, (event) => {
      return event.type === type
    })
  }

  _getEventNames (type) {
    var events = _.filter(this.events, (event) => {
      return event.type === type
    })

    var names = events.map((event) => {
      return event.eventName
    })

    return names
  }

  _getEventIndex (eventName) {
    var events = this.events.map((element) => {
      return element.eventName
    })

    var index = events.indexOf(eventName, -1)
    return index
  }

  _getEventIndexFromStart (eventName) {
    var events = this.events.map((element) => {
      return element.eventName
    })

    var index = events.indexOf(eventName)
    return index
  }

  _eventExists (eventName, type) {
    return _.find(this.events, (event) => {
      return event.eventName === eventName && event.type === type
    })
  }

  _getEventByName (eventName) {
    return _.find(this.events, (event) => {
      return event.eventName === eventName
    })
  }

  _getEventIndexByNameAndType (eventName, type) {
    return _.findLastKey(this.events, (event) => {
      return event.eventName === eventName && event.type === type
    })
  }

  _eventIsTopic (event) {
    return event.type === 'topic'
  }
}

module.exports = On
