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

  it('Should drop an invalid payload and keep the topic consumer alive', async function () {
    const executed = []
    const errors = []

    on
      .eventReceived('containedTopic')
      .withProperties(['name'])
      .do(function (incomingData) {
        executed.push(incomingData)
      })

    on.on('error', (err) => errors.push(err))

    await on.init()

    await publisher.publish('containedTopic', { other: 'value' })

    let waited = 0
    while (errors.length === 0 && waited < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      waited += 50
    }

    // the consumer must still be subscribed after the invalid message
    await publisher.publish('containedTopic', { name: 'Flash' })

    waited = 0
    while (executed.length === 0 && waited < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      waited += 50
    }

    // the valid message may be redelivered (the redis job is keyed by the
    // message tid), so assert the payload rather than the delivery count
    expect(executed.length).to.be.above(0)
    expect(executed.every((data) => data.name === 'Flash')).to.equal(true)
    // the invalid message may be redelivered too; what matters is that it was
    // dropped (never executed) and surfaced as an error
    expect(errors.length).to.be.above(0)
    expect(errors[0]).to.have.property('message', 'Validation failed for event containedTopic')
    expect(errors[0].event).to.have.property('eventName', 'containedTopic')
  })

  it('Should not surface an unhandled rejection when a topic payload is invalid and no error listener exists', async function () {
    let executed = 0
    const rejections = []
    const onRejection = (err) => rejections.push(err)

    on
      .eventReceived('unlistenedContainedTopic')
      .withProperties(['name'])
      .do(function () {
        executed++
      })

    // no `error` listener on purpose: emitting `error` without one throws
    // inside the async listener and would escape as an unhandled rejection
    process.on('unhandledRejection', onRejection)
    try {
      await on.init()
      await publisher.publish('unlistenedContainedTopic', { other: 'value' })
      await new Promise((resolve) => setTimeout(resolve, 300))
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }

    expect(rejections).to.have.lengthOf(0)
    expect(executed).to.equal(0)
  })
})
