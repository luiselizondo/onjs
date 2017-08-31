var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib')

var REDIS_PORT = 19379

function waitAndExecute(waitTime, callback) {
  setTimeout(callback, waitTime)
}

describe('RPC', function () {
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

    function execution(input, next) {
      if (input.name === 'Batman') {
        var response = {
          name: 'Batman',
          superpower: 'None'
        }
      }

      return next(false, response)
    }

    on
    .eventReceived('getSuperhero')
    .withProperties(['name'])
    .respond()
    .afterExecuting(execution)

    on.init()

    waitAndExecute(2000, function () {
      mq.sendRequest('getSuperhero', {
        name: 'Batman'
      })
      .then((data) => {
        var result = JSON.parse(data)
        result.should.have.property('results')
        result.should.have.property('type', 'success')
        result.results.should.have.property('name', 'Batman')
        result.results.should.have.property('superpower', 'None')
        done()
      })
    })
  });
})
