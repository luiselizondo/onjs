var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib')

function waitAndExecute(waitTime, callback) {
  setTimeout(callback, waitTime)
}

describe('Topics', function () {
  this.timeout(5000)

  var config = {
    exchange_name: 'onjs_test',
    url: 'amqp://rabbitmq:rabbitmq@localhost:35672/'
  }

  describe('Topic', function () {
    it('Should execute a topic event', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(config)
      var on = new On(mq, {})

      function execution(incomingData) {
        incomingData.should.have.property('name', 'Flash')
        incomingData.should.have.property('superpower', 'Run fast')
        done()
      }

      on
      .eventReceived('topicEvent')
      .withProperties(['name', 'superpower'])
      .do(execution)

      on.init()

      waitAndExecute(1000, function () {
        mq.publish('topicEvent', {
          name: 'Flash',
          superpower: 'Run fast'
        })
      })
    });

    it("Should fail to execute because validation", function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(config)
      var on = new On(mq, {})

      function execution(incomingData) {
        return done()
      }

      on
      .eventReceived('topicEvent')
      .withProperties(['name', 'superpower'])
      .do(execution)

      on.init()

      waitAndExecute(1000, function () {
        mq.publish('topicEvent', {
          name: 'Flash'
        })

        done()
      })
    })
  })
})
