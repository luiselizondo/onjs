var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib').MQ
var Topic = require('rabbitmq-lib').Topic
var REDIS_PORT = 19379

describe('Topics', function () {
  this.timeout(5000)

  var config = {
    mq: {
      exchange_name: 'onjs_test',
      url: 'amqp://rabbitmq:rabbitmq@127.0.0.1:5672/',
    },
    redis: {
      port: REDIS_PORT,
      host: '127.0.0.1'
    }
  }

  var mq1 = new MQ(config.mq)

  var publisher = new Topic(config.mq.exchange_name)
  var on = new On(config)

  before(async function () {
    await mq1.connect()
    
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

  it('Should execute a topic event', async function () {
    function execution(incomingData) {
      console.log('Incoming', incomingData)
      incomingData.should.have.property('name', 'Flash')
      incomingData.should.have.property('superpower', 'Run fast')
    }

    on
    .eventReceived('topicEvent')
    .withProperties(['name', 'superpower'])
    .do(execution)

    await on.init()

    await publisher.publish('topicEvent', {
      name: 'Flash',
      superpower: 'Run fast'
    })
  });

  it("Should fail to execute because validation", async function () {
    function execution(incomingData) {
      console.log('Should not execute')
    }

    on
    .eventReceived('topicEvent2')
    .withProperties(['name', 'superpower'])
    .do(execution)

    await on.init()

    await publisher.publish('topicEvent2', {
      name: 'Flash'
    })
  })
})
