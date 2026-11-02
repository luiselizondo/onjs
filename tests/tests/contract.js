const should = require('should')
const EventEmitter = require('events')
const On = require('../../index')

const config = {
  mq: {
    exchange_name: 'onjs_contract_test',
    url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
    connectMaxAttempts: 1,
    delayMS: 10,
  },
  redis: {
    port: 6379,
    host: 'redis',
  },
  reconnectOnClose: false,
}

const FLUENT_METHODS = [
  'and',
  'debug',
  'log',
  'init',
  'eventReceived',
  'broadcastReceived',
  'taskReceived',
  'requestReceived',
  'respond',
  'withProperties',
  'ackAfterProcessing',
  'do',
  'andProcess',
  'afterExecuting',
  'sendToQueue',
  'andDispatchAs',
  'tearDown',
  'setConnection',
  'getConnection',
]

describe('On public contract', function () {
  it('exports the On class extending EventEmitter', function () {
    On.should.be.a.Function()
    const on = new On(config)
    on.should.be.instanceOf(EventEmitter)
  })

  it('does not connect on instantiation', function () {
    const on = new On(config)
    should(on.getConnection()).be.undefined()
    on.events.should.be.an.Array().and.have.length(0)
  })

  it('exposes the fluent registration surface on the prototype', function () {
    FLUENT_METHODS.forEach(function (method) {
      On.prototype[method].should.be.a.Function()
    })
  })

  it('pins the arity of the registration methods', function () {
    On.prototype.eventReceived.should.have.property('length', 1)
    // options is a defaulted parameter, so Function#length only counts the name
    On.prototype.taskReceived.should.have.property('length', 1)
    On.prototype.withProperties.should.have.property('length', 1)
    On.prototype.do.should.have.property('length', 1)
  })

  it('defaults taskReceived options to { isDelayed: false }', function () {
    const on = new On(config)
    on.taskReceived('contractTask')
    on.events[0].should.have.property('eventName', 'contractTask')
    on.events[0].should.have.property('type', 'queue')
  })

  it('honours the optional taskReceived options argument', function () {
    const on = new On(config)
    const registerDelayed = function () {
      on.taskReceived('contractDelayedTask', { isDelayed: true })
    }
    registerDelayed.should.throw(/delayed_exchange_name is empty/)
  })

  it('registers eventReceived(name).do(fn) with the documented event shape', function () {
    const action = function () {
      return null
    }

    const on = new On(config)
    on.eventReceived('contractEvent').do(action)

    on.events.should.have.length(1)
    const event = on.events[0]

    event.should.have.property('eventName', 'contractEvent')
    event.should.have.property('type', 'topic')
    event.should.have.property('redisQueue')
    event.should.have.property('actions').which.is.an.Array().and.deepEqual([action])
    event.should.have.property('context', on)
  })
})
