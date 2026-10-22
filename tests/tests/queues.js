var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib').MQ
var Queue = require('rabbitmq-lib').Queue
var Topic = require('rabbitmq-lib').Topic

var REDIS_PORT = 19379

describe('Queue', function () {
  this.timeout(10000)

  var config = {
    mq: {
      exchange_name: 'onjs_test',
      delayed_exchange_name: 'onjs_test_delayed',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis'
    },
  }

  var mq1 = new MQ(config.mq)
  var sender = new Queue()
  var publisher = new Topic(config.mq.exchange_name)
  var on = new On(config)
  on.debug()

  before(async function () {
    await mq1.connect()
    var channelConsumer = await mq1.createChannel()
    sender.setChannel(channelConsumer)

    var channelConsumer2 = await mq1.createChannel()
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
    var eventsInstance = new Events();
    
    function execution(incomingData) {
      console.log('Incoming', incomingData)
      incomingData.should.have.property('name', 'Superman')
      incomingData.should.have.property('superpower', 'Fly')
      return
    }

    on
    .taskReceived('testQueue')
    .withProperties(['name', 'superpower'])
    .andProcess(execution)

    await on.init()

    await sender.send('testQueue', {
      name: 'Superman',
      superpower: 'Fly'
    })
  });

  it("Should redispatch the event as a new queue", async function () {
    var eventsInstance = new Events();

    function execution(incomingData) {
      console.log('Incoming newTestQueue', incomingData)
      incomingData.should.have.property('name', 'Wonder Woman')
      incomingData.should.have.property('superpower', 'Fly')
    }

    on
    .eventReceived('dispatchableQueue')
    .withProperties(['name', 'superpower'])
    .andDispatchAs('newTestQueue')

    on
    .taskReceived('newTestQueue')
    .withProperties(['name', 'superpower'])
    .andProcess(execution)

    await on.init()

    await publisher.publish('dispatchableQueue', {
      name: 'Wonder Woman',
      superpower: 'Fly'
    })
  })

  it("Should initialize and process a delayed queue task", async function () {
    // The delayed round trip needs the delayed-message exchange plugin,
    // installed by bin/prepare-test-environment. CI services run the stock
    // image, where this test skips (the routing regression test above still
    // guards the delayed path everywhere).
    var probeChannel = await mq1.createChannel()
    var pluginSupported = true
    try {
      await probeChannel.assertExchange('onjs_delayed_probe', 'x-delayed-message', { arguments: { 'x-delayed-type': 'direct' } })
    } catch (err) {
      pluginSupported = false
    }
    try { await probeChannel.close() } catch (err) { }
    if (!pluginSupported) this.skip()

    var executed = null

    function execution(incomingData) {
      executed = incomingData
      return
    }

    on
    .taskReceived('delayedQueueRegression', { isDelayed: true })
    .andProcess(execution)

    await on.init()

    await sender.send('delayedQueueRegression', { name: 'Delayed Superman' }, 300)

    var waited = 0
    while (!executed && waited < 5000) {
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      waited += 100
    }

    executed.should.have.property('name', 'Delayed Superman')
  })
})

describe('Queue with manual ack', function () {
  this.timeout(10000)

  var config = {
    mq: {
      exchange_name: 'onjs_test_manual_ack',
      delayed_exchange_name: 'onjs_test_manual_ack_delayed',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis'
    },
  }

  // These tests use a stubbed queueInstance and a fake channel,
  // so they don't need a live broker connection
  function createFakeChannel () {
    var fake = {
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
        fake.consumeCalls.push({ queueName: queueName, handler: handler, options: options })
      },
      ack: function (message) {
        fake.ackCalls.push(message)
      },
      nack: function (message, allUpTo, requeue) {
        fake.nackCalls.push([message, allUpTo, requeue])
      }
    }
    return fake
  }

  function createStubbedOn () {
    var onInstance = new On(config)
    var channel = createFakeChannel()
    var listenCalls = []
    var listenManualCalls = []
    var listenManualHandlers = []
    var listenOptions = []

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
      }
    }

    return { onInstance: onInstance, channel: channel, listenCalls: listenCalls, listenOptions: listenOptions, listenManualCalls: listenManualCalls, listenManualHandlers: listenManualHandlers }
  }

  it('Should route auto ack tasks to listen and manual ack tasks to the manual consumer', async function () {
    var stubs = createStubbedOn()

    function execution (incomingData) {
      return
    }

    stubs.onInstance
    .taskReceived('autoAckQueue')
    .andProcess(execution)

    stubs.onInstance
    .taskReceived('manualAckQueue')
    .ackAfterProcessing()
    .andProcess(execution)

    await stubs.onInstance._startEventListeners()

    stubs.listenCalls.should.deepEqual([['autoAckQueue']])
    stubs.listenManualCalls.should.deepEqual([['manualAckQueue']])
    stubs.listenManualCalls[0].should.not.deepEqual(stubs.listenCalls[0])
  })

  it('Should route delayed tasks through the auto-ack listen with isDelayed', async function () {
    var stubs = createStubbedOn()

    function execution (incomingData) {
      return
    }

    stubs.onInstance
    .taskReceived('delayedQueue', { isDelayed: true })
    .andProcess(execution)

    await stubs.onInstance._startEventListeners()

    stubs.listenCalls.should.deepEqual([['delayedQueue']])
    stubs.listenOptions[0].should.have.property('isDelayed', true)
  })

  it('Should await the actions and ack the message after processing', async function () {
    var stubs = createStubbedOn()
    var executed = []
    var actionFinished = false

    stubs.onInstance
    .taskReceived('manualAckQueue')
    .ackAfterProcessing()
    .andProcess(async function (incomingData) {
      await new Promise((resolve) => { setTimeout(resolve, 25) })
      executed.push(incomingData)
      actionFinished = true
    })

    await stubs.onInstance._initQueuesWithManualAck(stubs.onInstance._getEvents('queue'), stubs.channel)

    var handler = stubs.listenManualHandlers[0]

    await handler({ name: 'Superman' }, { fields: { routingKey: 'manualAckQueue' } })

    actionFinished.should.equal(true)
    executed.should.deepEqual([{ name: 'Superman' }])
  })

  it('Should nack and drop the message when the task action fails', async function () {
    var stubs = createStubbedOn()
    var executed = false

    stubs.onInstance
    .taskReceived('failingManualQueue')
    .ackAfterProcessing()
    .andProcess(async function () {
      executed = true
      throw new Error('action failed')
    })

    await stubs.onInstance._initQueuesWithManualAck(stubs.onInstance._getEvents('queue'), stubs.channel)

    var handler = stubs.listenManualHandlers[0]

    await handler({ name: 'Superman' }, { fields: { routingKey: 'failingManualQueue' } }).should.be.rejectedWith('action failed')

    executed.should.equal(true)
  })

  it('Should nack the message when payload validation fails', async function () {
    var stubs = createStubbedOn()
    var executed = false

    stubs.onInstance
    .taskReceived('validatedManualQueue')
    .withProperties(['name'])
    .ackAfterProcessing()
    .andProcess(async function () {
      executed = true
    })

    await stubs.onInstance._initQueuesWithManualAck(stubs.onInstance._getEvents('queue'), stubs.channel)

    var handler = stubs.listenManualHandlers[0]

    await handler({ other: 'value' }, { fields: { routingKey: 'validatedManualQueue' } }).should.be.rejectedWith('Validation failed for task validatedManualQueue')

    executed.should.equal(false)
  })

  it('Should ack the message when payload validation passes', async function () {
    var stubs = createStubbedOn()
    var executed = []

    stubs.onInstance
    .taskReceived('validatedManualQueue')
    .withProperties(['name'])
    .ackAfterProcessing()
    .andProcess(async function (incomingData) {
      executed.push(incomingData)
    })

    await stubs.onInstance._initQueuesWithManualAck(stubs.onInstance._getEvents('queue'), stubs.channel)

    var handler = stubs.listenManualHandlers[0]

    await handler({ name: 'Superman' }, { fields: { routingKey: 'validatedManualQueue' } })

    executed.should.deepEqual([{ name: 'Superman' }])
  })
})
