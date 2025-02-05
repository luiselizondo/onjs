var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib').MQ
var RPC = require('rabbitmq-lib').RPC

var REDIS_PORT = 19379

describe('RPC', function () {
  this.timeout(10000)

  var config = {
    mq: {
      exchange_name: 'onjs_test',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis'
    }
  }

  var mq = new MQ(config.mq)
  var sender = new RPC()
  var on = new On(config)
  on.debug()

  before(async function () {
    await mq.connect()
    
    var connection = await mq.connect()
    return sender.setConnection(connection)
  })

  after(async function () {
    return await mq.disconnect()
  })

  afterEach(async function () {
    return await on.tearDown()
  })

  it('Should execute a queue event', async function () {
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
    .requestReceived('getSuperhero')
    .withProperties(['name'])
    .respond()
    .afterExecuting(execution)

    await on.init()

    var data = await sender.send('getSuperhero', {
      name: 'Batman'
    })
    
    var result = JSON.parse(data)
    result.should.have.property('results')
    result.should.have.property('type', 'success')
    result.results.should.have.property('name', 'Batman')
    result.results.should.have.property('superpower', 'None')
  });
})
