var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib')

var REDIS_PORT = 19379

function waitAndExecute(waitTime, callback) {
  setTimeout(callback, waitTime)
}

describe('Queue', function () {
  this.timeout(10000)

  var config = {
    exchange_name: 'onjs_test',
    url: 'amqp://rabbitmq:rabbitmq@localhost:35672/'
  }

  it('Should execute a queue event', function (done) {
    var eventsInstance = new Events();
    var mq = new MQ(config)
    var on = new On(mq, {
      redis: {
        port: REDIS_PORT,
        host: '127.0.0.1'
      }
    })

    function execution(incomingData) {
      incomingData.should.have.property('name', 'Superman')
      incomingData.should.have.property('superpower', 'Fly')
      done()
    }

    on
    .eventReceived('testQueue')
    .withProperties(['name', 'superpower'])
    .addToQueue()
    .andProcess(execution)

    on.init()

    waitAndExecute(2000, function () {
      mq.dispatchToQueue('testQueue', {
        name: 'Superman',
        superpower: 'Fly'
      })
    })
  });

  it("Should redispatch the event as a new event", function (done) {
    var eventsInstance = new Events();
    var mq = new MQ(config)
    var on = new On(mq, {
      redis: {
        port: REDIS_PORT,
        host: '127.0.0.1'
      }
    })

    function execution(incomingData) {
      incomingData.should.have.property('name', 'Wonder Woman')
      incomingData.should.have.property('superpower', 'Fly')
      done()
    }

    on
    .eventReceived('dispatchableQueue')
    .withProperties(['name', 'superpower'])
    .addToQueue()
    .andDispatchAs('newTestQueue')

    on
    .eventReceived('newTestQueue')
    .withProperties(['name', 'superpower'])
    .addToQueue()
    .andProcess(execution)

    on.init()

    waitAndExecute(2000, function () {
      mq.dispatchToQueue('dispatchableQueue', {
        name: 'Wonder Woman',
        superpower: 'Fly'
      })
    })
  })
})
