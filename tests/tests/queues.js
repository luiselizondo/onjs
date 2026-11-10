const { expect } = require('chai')
const On = require('../../index')
const EventEmitter = require('events')
class Events extends EventEmitter {}
const MQ = require('rabbitmq-lib').MQ
const Queue = require('rabbitmq-lib').Queue
const Topic = require('rabbitmq-lib').Topic

const REDIS_PORT = 6379

describe('Queue', function () {
  this.timeout(10000)

  const config = {
    mq: {
      exchange_name: 'onjs_test',
      delayed_exchange_name: 'onjs_test_delayed',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis',
    },
  }

  const mq1 = new MQ(config.mq)
  const sender = new Queue()
  const publisher = new Topic(config.mq.exchange_name)
  const on = new On(config)
  on.debug()

  before(async function () {
    await mq1.connect()
    const channelConsumer = await mq1.createChannel()
    sender.setChannel(channelConsumer)

    const channelConsumer2 = await mq1.createChannel()
    publisher.setChannel(channelConsumer2)
    return
  })

  after(async function () {
    return await mq1.disconnect()
  })

  afterEach(async function () {
    return await on.tearDown()
  })

  it('Should execute a queue event', async function () {
    const eventsInstance = new Events()

    function execution (incomingData) {
      console.log('Incoming', incomingData)
      expect(incomingData).to.have.property('name', 'Superman')
      expect(incomingData).to.have.property('superpower', 'Fly')
      return
    }

    on.taskReceived('testQueue')
      .withProperties(['name', 'superpower'])
      .andProcess(execution)

    await on.init()

    await sender.send('testQueue', {
      name: 'Superman',
      superpower: 'Fly',
    })
  })

  it('Should redispatch the event as a new queue', async function () {
    const eventsInstance = new Events()

    function execution (incomingData) {
      console.log('Incoming newTestQueue', incomingData)
      expect(incomingData).to.have.property('name', 'Wonder Woman')
      expect(incomingData).to.have.property('superpower', 'Fly')
    }

    on.eventReceived('dispatchableQueue')
      .withProperties(['name', 'superpower'])
      .andDispatchAs('newTestQueue')

    on.taskReceived('newTestQueue')
      .withProperties(['name', 'superpower'])
      .andProcess(execution)

    await on.init()

    await publisher.publish('dispatchableQueue', {
      name: 'Wonder Woman',
      superpower: 'Fly',
    })
  })

  it('Should execute a redispatchable event only once for the same tid', async function () {
    const dispatched = []

    on.eventReceived('dedupQueue').andDispatchAs('dedupTargetQueue')

    on.taskReceived('dedupTargetQueue').andProcess(function () {
      return
    })

    await on.init()

    // The redis processor redispatches to the mq; count those dispatches
    // instead of hitting the broker twice (the point here is the redis dedup
    // window, keyed by tid).
    on.queueInstance.send = async function (newEventName) {
      dispatched.push(newEventName)
    }

    const event = on._getEventByName('dedupQueue')
    // unique per run: a fixed tid would already be a retained job from a
    // previous run, and both adds would be ignored
    const tid = `dedup-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const payload = { tid: tid, name: 'Wonder Woman', superpower: 'Fly' }

    await on._redispatchToMQ(event, payload)
    await on._redispatchToMQ(event, payload)

    let waited = 0
    while (dispatched.length === 0 && waited < 3000) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
      waited += 100
    }

    // give a duplicate job the chance to show up before asserting the window
    await new Promise((resolve) => {
      setTimeout(resolve, 500)
    })

    expect(dispatched).to.deep.equal(['dedupTargetQueue'])
  })

  it('Should initialize and process a delayed queue task', async function () {
    // The delayed round trip needs the delayed-message exchange plugin,
    // installed by bin/prepare-test-environment. CI runs the stock image
    // without the plugin: bin/test sets ONJS_DELAYED_PLUGIN_TESTS=true so
    // this test runs there, and CI skips it (the routing regression test
    // still guards the delayed path on every broker).
    if (process.env.ONJS_DELAYED_PLUGIN_TESTS !== 'true') this.skip()
    // installed by bin/prepare-test-environment. CI services run the stock
    // image, where this test skips (the routing regression test above still
    // guards the delayed path everywhere).
    const probeChannel = await mq1.createChannel()
    let pluginSupported = true
    try {
      await probeChannel.assertExchange(
        'onjs_delayed_probe',
        'x-delayed-message',
        { arguments: { 'x-delayed-type': 'direct' } },
      )
    } catch {
      pluginSupported = false
    }
    try {
      await probeChannel.close()
    } catch {
      // the probe channel may already be gone; it did its job either way
    }
    if (!pluginSupported) this.skip()
    if (process.env.ONJS_DELAYED_PLUGIN_TESTS !== 'true') this.skip()

    let executed = null

    function execution (incomingData) {
      executed = incomingData
      return
    }

    on.taskReceived('delayedQueueRegression', { isDelayed: true }).andProcess(
      execution,
    )

    await on.init()

    await sender.send(
      'delayedQueueRegression',
      { name: 'Delayed Superman' },
      300,
    )

    let waited = 0
    while (!executed && waited < 5000) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
      waited += 100
    }

    expect(executed).to.have.property('name', 'Delayed Superman')
  })
})

describe('Queue with manual ack', function () {
  this.timeout(10000)

  const config = {
    mq: {
      exchange_name: 'onjs_test_manual_ack',
      delayed_exchange_name: 'onjs_test_manual_ack_delayed',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis',
    },
  }

  // These tests use a stubbed queueInstance and a fake channel,
  // so they don't need a live broker connection
  function createFakeChannel () {
    const fake = {
      prefetchCalls: [],
      assertQueueCalls: [],
      consumeCalls: [],
      ackCalls: [],
      nackCalls: [],
      prefetch: async function (count, globalScope) {
        fake.prefetchCalls.push([count, globalScope])
      },
      assertQueue: async function (queueName, options) {
        fake.assertQueueCalls.push([queueName, options])
        return { queue: queueName }
      },
      consume: async function (queueName, handler, options) {
        fake.consumeCalls.push({
          queueName: queueName,
          handler: handler,
          options: options,
        })
      },
      ack: function (message) {
        fake.ackCalls.push(message)
      },
      nack: function (message, allUpTo, requeue) {
        fake.nackCalls.push([message, allUpTo, requeue])
      },
    }
    return fake
  }

  function createStubbedOn () {
    const onInstance = new On(config)
    const channel = createFakeChannel()
    const listenCalls = []
    const listenManualCalls = []
    const listenManualHandlers = []
    const listenOptions = []

    onInstance.mqInstance.createChannel = async function () {
      return channel
    }

    onInstance.queueInstance = {
      setChannel: function () {},
      on: function () {},
      listen: async function (queueNames, options) {
        listenCalls.push(queueNames)
        listenOptions.push(options)
      },
      listenManual: async function (queueNames, handler) {
        listenManualCalls.push(queueNames)
        listenManualHandlers.push(handler)
      },
    }

    return {
      onInstance: onInstance,
      channel: channel,
      listenCalls: listenCalls,
      listenOptions: listenOptions,
      listenManualCalls: listenManualCalls,
      listenManualHandlers: listenManualHandlers,
    }
  }

  it('Should route auto ack tasks to listen and manual ack tasks to the manual consumer', async function () {
    const stubs = createStubbedOn()

    function execution (incomingData) {
      return
    }

    stubs.onInstance.taskReceived('autoAckQueue').andProcess(execution)

    stubs.onInstance
      .taskReceived('manualAckQueue')
      .ackAfterProcessing()
      .andProcess(execution)

    await stubs.onInstance._startEventListeners()

    expect(stubs.listenCalls).to.deep.equal([['autoAckQueue']])
    expect(stubs.listenManualCalls).to.deep.equal([['manualAckQueue']])
    expect(stubs.listenManualCalls[0]).to.not.deep.equal(stubs.listenCalls[0])
  })

  it('Should route delayed tasks through the auto-ack listen with isDelayed', async function () {
    const stubs = createStubbedOn()

    function execution (incomingData) {
      return
    }

    stubs.onInstance
      .taskReceived('delayedQueue', { isDelayed: true })
      .andProcess(execution)

    await stubs.onInstance._startEventListeners()

    expect(stubs.listenCalls).to.deep.equal([['delayedQueue']])
    expect(stubs.listenOptions[0]).to.have.property('isDelayed', true)
  })

  it('Should await the actions and ack the message after processing', async function () {
    const stubs = createStubbedOn()
    const executed = []
    let actionFinished = false

    stubs.onInstance
      .taskReceived('manualAckQueue')
      .ackAfterProcessing()
      .andProcess(async function (incomingData) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25)
        })
        executed.push(incomingData)
        actionFinished = true
      })

    await stubs.onInstance._initQueuesWithManualAck(
      stubs.onInstance._getEvents('queue'),
      stubs.channel,
    )

    const handler = stubs.listenManualHandlers[0]

    await handler(
      { name: 'Superman' },
      { fields: { routingKey: 'manualAckQueue' } },
    )

    expect(actionFinished).to.equal(true)
    expect(executed).to.deep.equal([{ name: 'Superman' }])
  })

  it('Should nack and drop the message when the task action fails', async function () {
    const stubs = createStubbedOn()
    let executed = false

    stubs.onInstance
      .taskReceived('failingManualQueue')
      .ackAfterProcessing()
      .andProcess(async function () {
        executed = true
        throw new Error('action failed')
      })

    await stubs.onInstance._initQueuesWithManualAck(
      stubs.onInstance._getEvents('queue'),
      stubs.channel,
    )

    const handler = stubs.listenManualHandlers[0]

    let rejectedWith = null
    try {
      await handler(
        { name: 'Superman' },
        { fields: { routingKey: 'failingManualQueue' } },
      )
    } catch (err) {
      rejectedWith = err
    }
    expect(rejectedWith).to.be.an('error')
    expect(rejectedWith.message).to.equal('action failed')

    expect(executed).to.equal(true)
  })

  it('Should nack the message when payload validation fails', async function () {
    const stubs = createStubbedOn()
    let executed = false

    stubs.onInstance
      .taskReceived('validatedManualQueue')
      .withProperties(['name'])
      .ackAfterProcessing()
      .andProcess(async function () {
        executed = true
      })

    await stubs.onInstance._initQueuesWithManualAck(
      stubs.onInstance._getEvents('queue'),
      stubs.channel,
    )

    const handler = stubs.listenManualHandlers[0]

    let rejectedWith = null
    try {
      await handler(
        { other: 'value' },
        { fields: { routingKey: 'validatedManualQueue' } },
      )
    } catch (err) {
      rejectedWith = err
    }
    expect(rejectedWith).to.be.an('error')
    expect(rejectedWith.message).to.equal(
      'Validation failed for task validatedManualQueue',
    )

    expect(executed).to.equal(false)
  })

  it('Should ack the message when payload validation passes', async function () {
    const stubs = createStubbedOn()
    const executed = []

    stubs.onInstance
      .taskReceived('validatedManualQueue')
      .withProperties(['name'])
      .ackAfterProcessing()
      .andProcess(async function (incomingData) {
        executed.push(incomingData)
      })

    await stubs.onInstance._initQueuesWithManualAck(
      stubs.onInstance._getEvents('queue'),
      stubs.channel,
    )

    const handler = stubs.listenManualHandlers[0]

    await handler(
      { name: 'Superman' },
      { fields: { routingKey: 'validatedManualQueue' } },
    )

    expect(executed).to.deep.equal([{ name: 'Superman' }])
  })
})

describe('Queue dispatcher validation containment', function () {
  this.timeout(10000)

  const config = {
    mq: {
      exchange_name: 'onjs_test',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis',
    },
  }

  it('Should contain a validation failure when no error listener is registered', async function () {
    const on = new On(config)
    let executed = 0
    const rejections = []
    const onRejection = (err) => rejections.push(err)

    on.taskReceived('validationFailureNoListener')
      .withProperties(['name'])
      .do(function () {
        executed++
      })

    // no `error` listener registered on purpose — emitting `error` used to
    // throw inside this async listener and surface as an unhandled
    // rejection that crashes the process
    process.on('unhandledRejection', onRejection)
    try {
      on._registerQueueEventDispatcher()

      await on.queueInstance.emit('queueEventReceived', {
        data: { wrong: 'payload' },
        type: 'queue',
        name: 'validationFailureNoListener',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }

    expect(rejections.length).to.equal(0)
    expect(executed).to.equal(0)
  })

  it('Should emit error once and keep the dispatcher alive when a listener is registered', async function () {
    const on = new On(config)
    const errors = []
    let executedAfter = 0

    on.taskReceived('validationFailureWithListener')
      .withProperties(['name'])
      .do(function () {
        executedAfter++
      })

    on.on('error', (err) => errors.push(err))
    on._registerQueueEventDispatcher()

    await on.queueInstance.emit('queueEventReceived', {
      data: {},
      type: 'queue',
      name: 'validationFailureWithListener',
    })

    expect(errors.length).to.equal(1)
    expect(errors[0].message).to.match(/Validation failed/)
    expect(errors[0].event).to.have.property(
      'eventName',
      'validationFailureWithListener',
    )

    await on.queueInstance.emit('queueEventReceived', {
      data: { name: 'Flash' },
      type: 'queue',
      name: 'validationFailureWithListener',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(executedAfter).to.equal(1)
  })
})
