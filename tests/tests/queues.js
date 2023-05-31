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
      url: 'amqp://rabbitmq:rabbitmq@127.0.0.1:5672/',
    },
    redis: {
      port: REDIS_PORT,
      host: '127.0.0.1'
    }
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
})
