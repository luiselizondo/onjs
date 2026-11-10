const { expect } = require('chai')
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
    expect(On).to.be.a('function')
    const on = new On(config)
    expect(on).to.be.an.instanceOf(EventEmitter)
  })

  it('does not connect on instantiation', function () {
    const on = new On(config)
    expect(on.getConnection()).to.be.undefined
    expect(on.events).to.be.an('array').and.have.lengthOf(0)
  })

  it('exposes the fluent registration surface on the prototype', function () {
    FLUENT_METHODS.forEach(function (method) {
      expect(On.prototype[method]).to.be.a('function')
    })
  })

  it('pins the arity of the registration methods', function () {
    expect(On.prototype.eventReceived).to.have.property('length', 1)
    // options is a defaulted parameter, so Function#length only counts the name
    expect(On.prototype.taskReceived).to.have.property('length', 1)
    expect(On.prototype.withProperties).to.have.property('length', 1)
    expect(On.prototype.do).to.have.property('length', 1)
  })

  it('defaults taskReceived options to { isDelayed: false }', function () {
    const on = new On(config)
    on.taskReceived('contractTask')
    expect(on.events[0]).to.have.property('eventName', 'contractTask')
    expect(on.events[0]).to.have.property('type', 'queue')
  })

  it('honours the optional taskReceived options argument', function () {
    const on = new On(config)
    const registerDelayed = function () {
      on.taskReceived('contractDelayedTask', { isDelayed: true })
    }
    expect(registerDelayed).to.throw(/delayed_exchange_name is empty/)
  })

  it('registers eventReceived(name).do(fn) with the documented event shape', function () {
    const action = function () {
      return null
    }

    const on = new On(config)
    on.eventReceived('contractEvent').do(action)

    expect(on.events).to.have.lengthOf(1)
    const event = on.events[0]

    expect(event).to.have.property('eventName', 'contractEvent')
    expect(event).to.have.property('type', 'topic')
    expect(event).to.have.property('redisQueue')
    expect(event).to.have.property('actions').which.is.an('array').and.deep.equal([action])
    expect(event).to.have.property('context', on)
  })
})
