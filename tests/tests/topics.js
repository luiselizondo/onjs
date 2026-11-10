const { expect } = require('chai')
const On = require('../../index')
const EventEmitter = require('events')
class Events extends EventEmitter {}
const MQ = require('rabbitmq-lib').MQ
const Topic = require('rabbitmq-lib').Topic
const REDIS_PORT = 6379

describe('Topics', function () {
  this.timeout(5000)

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
    reconnectOnClose: false,
  }

  const mq1 = new MQ(config.mq)

  const publisher = new Topic(config.mq.exchange_name)
  const on = new On(config)

  before(async function () {
    await mq1.connect()
    
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

  it('Should execute a topic event', async function () {
    let resolveExecution
    const executionPromise = new Promise((resolve) => {
      resolveExecution = resolve
    })

    function execution (incomingData) {
      console.log('Incoming', incomingData)
      resolveExecution(incomingData)
    }

    on
      .eventReceived('topicEvent')
      .withProperties(['name', 'superpower'])
      .do(execution)

    await on.init()

    await publisher.publish('topicEvent', {
      name: 'Flash',
      superpower: 'Run fast',
    })

    // The publish only guarantees delivery to the broker: awaiting the deferred
    // proves the redis round trip actually ran the action.
    const data = await executionPromise
    expect(data).to.have.property('name', 'Flash')
    expect(data).to.have.property('superpower', 'Run fast')
  })

  it('Should fail to execute because validation', async function () {
    function execution (incomingData) {
      console.log('Should not execute')
    }

    on
      .eventReceived('topicEvent2')
      .withProperties(['name', 'superpower'])
      .do(execution)

    await on.init()

    await publisher.publish('topicEvent2', {
      name: 'Flash',
    })
  })
})
