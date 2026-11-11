const { expect } = require('chai')
const On = require('../../index')
const EventEmitter = require('events')
class Events extends EventEmitter {}
const MQ = require('rabbitmq-lib').MQ
const REDIS_PORT = 6379

function nullMe (data) {
  return null
}

function nullMeToo () {
  return null
}

describe('On.js', function () {
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

  describe('Topics registration', function () {
    it('Should get an event given the index', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .eventReceived('testEvent2')

      const index = on._getEventIndex('testEvent2')
      expect(index).to.equal(1)
    })

    it('Should register a topic event listener with a callback', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .do(nullMe)

      const eventsRegistered = on._getEvents('topic')

      expect(eventsRegistered).to.be.an('array')
      expect(eventsRegistered).to.have.lengthOf(1)
      expect(eventsRegistered[0]).to.have.property('eventName', 'testEvent')
      expect(eventsRegistered[0]).to.have.property('type', 'topic')
      expect(eventsRegistered[0]).to.have.property('actions')
      expect(eventsRegistered[0].actions[0]).to.equal(nullMe)
    })

    it('Should throw an error when not registering a callback', function () {
      const on = new On(config)

      try {
        on
          .eventReceived('testEvent')
          .do()
      }
      catch (error) {
        expect(error).to.have.property('message', 'A callback needs to be registered first calling the do method or the registerCallback method')
      }
    })

    it('Should throw an error if the callback registered is not a Function', function () {
      const on = new On(config)

      try {
        on
          .eventReceived('testEvent')
          .do(true)
      }
      catch (error) {
        expect(error).to.have.property('message', 'A callback needs to be registered first and be a function')
      }
    })

    it('Should throw an error if the event was not registered first', function () {
      const on = new On(config)

      try {
        on.do(nullMe)
      }
      catch (error) {
        expect(error).to.have.property('message', 'The event hasn\'t been registered first')
      }
    })
  })

  describe('Double events', function () {
    it('Should register different event names with different callbacks', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .do(nullMe)

      on
        .eventReceived('testEvent2')
        .do(nullMeToo)

      const events = on._getEvents('topic')

      expect(events).to.be.an('array')
      expect(events).to.have.lengthOf(2)
      expect(events[0]).to.have.property('actions')
      expect(events[0]).to.have.property('eventName', 'testEvent')
      expect(events[0].actions).to.have.lengthOf(1)
      expect(events[0].actions[0]).to.equal(nullMe)

      expect(events[1]).to.have.property('actions')
      expect(events[1]).to.have.property('eventName', 'testEvent2')
      expect(events[1].actions).to.have.lengthOf(1)
      expect(events[1].actions[0]).to.equal(nullMeToo)
    })

    it('Should register different event names with the same callback', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .do(nullMe)

      on
        .eventReceived('testEvent2')
        .do(nullMe)

      const events = on._getEvents('topic')

      expect(events).to.be.an('array')
      expect(events).to.have.lengthOf(2)
      expect(events[0]).to.have.property('eventName', 'testEvent')
      expect(events[1]).to.have.property('eventName', 'testEvent2')
      
      expect(events[0].actions[0]).to.equal(nullMe)
      expect(events[1].actions[0]).to.equal(nullMe)
    })

    it('Should register the same event name with different callbacks', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .do(nullMe)
        .and()
        .do(nullMeToo)

      const events = on._getEvents('topic')

      expect(events).to.be.an('array')
      expect(events).to.have.lengthOf(1)
      expect(events[0]).to.have.property('actions')
      expect(events[0].actions).to.have.lengthOf(2)
      expect(events[0].actions[0]).to.equal(nullMe)
      expect(events[0].actions[1]).to.equal(nullMeToo)
      expect(events[0]).to.have.property('eventName', 'testEvent')
      expect(events[0]).to.have.property('type', 'topic')
    })
  })

  describe('Properties', function () {
    it('Should register an event with properties', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .withProperties(['name', 'age'])

      const events = on._getEvents('topic')

      expect(events).to.be.an('array')
      expect(events).to.have.lengthOf(1)
      expect(events[0]).to.have.property('eventName', 'testEvent')
      expect(events[0]).to.have.property('properties')
      expect(events[0].properties).to.be.an('array')
      expect(events[0].properties).to.have.lengthOf(2)
      expect(events[0].properties[0]).to.equal('name')
      expect(events[0].properties[1]).to.equal('age')
    })

    it('Should throw an error when the event hasn\'t been registered first', function () {
      const on = new On(config)

      try {
        on
          .withProperties(['name'])
      }
      catch (error) {
        expect(error).to.have.property('message', 'The event hasn\'t been registered first')
      }
    })

    it('Should throw an error if the properties is not an array', function () {
      const on = new On(config)

      try {
        on
          .eventReceived('testEvent')
          .withProperties('name')
      }
      catch (error) {
        expect(error).to.have.property('message', 'The properties must be an array')
      }
    })
  })

  describe('Validate properties', function () {
    it('Should pass validation of properties', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .withProperties(['name', 'age'])

      const data = {
        name: 'Hello World',
        age: 25,
      }

      const validation = on._validationIsSuccess('testEvent', data)

      expect(validation).to.equal(true)
    })

    it('Should fail validation of properties', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .withProperties(['name', 'age'])

      const data = {
        age: 25,
      }

      const validation = on._validationIsSuccess('testEvent', data)

      expect(validation).to.equal(false)
    })
  })

  describe('Event types', function () {
    it('Should detect that an event exists of type topic', function () {
      const on = new On(config)

      try {
        on.eventReceived('testEvent')
        on.taskReceived('testEvent1')
        on.eventReceived('testEvent')
      }
      catch (err) {
        expect(err).to.have.property('message', 'The event testEvent is already registered')
        
        const events = on._getEvents('topic')
        expect(events).to.have.lengthOf(1)
        expect(events[0]).to.have.property('eventName', 'testEvent')
      }
    })

    it('Should detect that an event exists of type task', function () {
      const on = new On(config)
      
      try {
        on.eventReceived('testEvent')
        on.taskReceived('testEvent1')
        on.taskReceived('testEvent1')
      }
      catch (err) {
        expect(err).to.have.property('message', 'The task testEvent1 is already registered')
        const events = on._getEvents('queue')
        expect(events).to.have.lengthOf(1)
        expect(events[0]).to.have.property('eventName', 'testEvent1')
      }
    })

    it('Should detect that an event exists with the same name but different type', function () {
      const on = new On(config)

      on.eventReceived('testEvent')
      on.taskReceived('testEvent')

      const queues = on._getEvents('queue')
      expect(queues).to.have.lengthOf(1)
      expect(queues[0]).to.have.property('eventName', 'testEvent')
      expect(queues[0]).to.have.property('type', 'queue')

      on.eventReceived('testEvent1')
      on.taskReceived('testEvent1')

      const topics = on._getEvents('topic')
      expect(topics).to.have.lengthOf(2)
      expect(topics[0]).to.have.property('eventName', 'testEvent')
      expect(topics[1]).to.have.property('eventName', 'testEvent1')
      expect(topics[0]).to.have.property('type', 'topic')
    })

    it('Should detect that an event of type topic exist', function () {
      const on = new On(config)

      on.eventReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'topic')
      expect(eventExists).to.be.true
    })

    it('Should detect that an event of type queue exists', function () {
      const on = new On(config)

      on.taskReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'queue')
      expect(eventExists).to.be.true
    })

    it('Should detect that an event of type rpc exists', function () {
      const on = new On(config)

      on.requestReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'rpc')
      expect(eventExists).to.be.true
    })

    it('Should detect that an event of type queue exists when another event of type topic exists with the same name', function () {
      const on = new On(config)

      on.taskReceived('testEvent')
      on.eventReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'queue')
      expect(eventExists).to.be.true
    })

    it('Should detect than an event of type topic does not exist when another event of type queue exists with the same name', function () {
      const on = new On(config)

      on.taskReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'topic')
      expect(eventExists).to.be.false
    })

    it('Should detect that an event of type topic exists when another event of type queue exists with the same name', function () {
      const on = new On(config)

      on.taskReceived('testEvent')
      on.eventReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'topic')
      expect(eventExists).to.be.true
    })
  })

  describe('Queues', function () {
    it('Should register a queue event listener', function () {
      const on = new On(config)

      on
        .taskReceived('testEvent')

      const eventsRegistered = on._getEvents('queue')

      expect(eventsRegistered).to.be.an('array')
      expect(eventsRegistered).to.have.lengthOf(1)
      expect(eventsRegistered[0]).to.have.property('eventName', 'testEvent')
      expect(eventsRegistered[0]).to.have.property('type', 'queue')
    })

    it('Should register a queue event listener with a callback', function () {
      const on = new On(config)

      on
        .taskReceived('testEvent')
        .andProcess(nullMe)

      const eventsRegistered = on._getEvents('queue')

      expect(eventsRegistered).to.be.an('array')
      expect(eventsRegistered).to.have.lengthOf(1)
      expect(eventsRegistered[0]).to.have.property('eventName', 'testEvent')
      expect(eventsRegistered[0]).to.have.property('type', 'queue')
      expect(eventsRegistered[0]).to.have.property('actions')
      expect(eventsRegistered[0].actions).to.have.lengthOf(1)
      expect(eventsRegistered[0].actions[0]).to.equal(nullMe)
    })

    it('Should register a topic and a queue event with the same name', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .do(nullMe)
        .and()
        .do(nullMeToo)

      on
        .taskReceived('testEvent')
        .andProcess(nullMeToo)

      const topics = on._getEvents('topic')
      const queues = on._getEvents('queue')

      expect(topics).to.be.an('array')
      expect(topics).to.have.lengthOf(1)

      expect(queues).to.be.an('array')
      expect(queues).to.have.lengthOf(1)

      expect(topics[0]).to.have.property('eventName', 'testEvent')
      expect(topics[0]).to.have.property('type', 'topic')
      expect(topics[0]).to.have.property('actions')
      expect(topics[0].actions).to.have.lengthOf(2)
      expect(topics[0].actions[0]).to.equal(nullMe)
      expect(topics[0].actions[1]).to.equal(nullMeToo)

      expect(queues[0]).to.have.property('eventName', 'testEvent')
      expect(queues[0]).to.have.property('type', 'queue')
      expect(queues[0]).to.have.property('actions')
      expect(queues[0].actions).to.have.lengthOf(1)
      expect(queues[0].actions[0]).to.equal(nullMeToo)
    })

    it('Should create a dispatchable event', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .andDispatchAs('newEvent')

      const topics = on._getEvents('topic')

      expect(topics[0]).to.have.property('eventName', 'testEvent')
      expect(topics[0]).to.have.property('type', 'topic')
      expect(topics[0]).to.have.property('dispatchAs')
      expect(topics[0].dispatchAs).to.have.lengthOf(1)
      expect(topics[0].dispatchAs[0]).to.equal('newEvent')
    })

    it('Should throw an error if a dispatchable event hasn\'t been registered first', function () {
      const on = new On(config)

      try {
        on
          .andDispatchAs('newEvent')
      }
      catch (error) {
        expect(error).to.have.property('message', 'The event null hasn\'t been registered first')
      }
    })

    it('Should throw an error if a dispatchable event is registered as a task', function () {
      const on = new On(config)

      try {
        on
          .taskReceived('testEvent')
          .andDispatchAs('newEvent')
      }
      catch (error) {
        expect(error).to.have.property('message', 'Dispatchable events should be registered as topics. Execute the method onEventReceived instead of onTaskReceived on the event testEvent')
      }
    })

    it('Should register the same destination once per andDispatchAs call', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .andDispatchAs('newEvent')
        .andDispatchAs('otherEvent')
        .andDispatchAs('newEvent')

      expect(on._getEvents('topic')[0].dispatchAs).to.deep.equal([
        'newEvent',
        'otherEvent',
        'newEvent',
      ])
    })
  })

  describe('sendToQueue alias', function () {
    it('Should behave like andDispatchAs', function () {
      const on = new On(config)

      on
        .eventReceived('legacyDispatchEvent')
        .sendToQueue('legacyTargetQueue')

      expect(on._getEvents('topic')[0].dispatchAs).to.deep.equal(['legacyTargetQueue'])
    })
  })

  describe('Fluent log marker', function () {
    it('Should mark the event being registered as logged and keep the chain fluent', function () {
      const on = new On(config)

      const result = on
        .eventReceived('loggedEvent')
        .log()
        .do(nullMe)

      expect(result).to.equal(on)
      expect(on.debugEnabled).to.equal(false)
      expect(on._getEvents('topic')[0]).to.have.property('isLogged', true)
    })

    it('Should log through the configured logger only for the marked event', function () {
      const printed = []
      const logger = {
        info: function (message) { printed.push(['info', message]) },
        error: function () {},
        warning: function () {},
      }

      const on = new On(Object.assign({}, config, { logger: logger }))

      // log() marks the event being registered, so it must come after
      // withProperties() and before do() — the registration modifiers all
      // throw when nothing is being registered
      on
        .eventReceived('loggedEvent')
        .withProperties(['name'])
        .log()
        .do(nullMe)
      on
        .eventReceived('quietEvent')
        .do(nullMe)

      // log() announces itself through _log (info), which only prints in
      // debug mode; the per-event opt-in is applied right after
      expect(printed).to.deep.equal([])

      on._eventLog('info', 'loggedEvent', 'printed')
      on._eventLog('info', 'quietEvent', 'not printed')
      on._eventLog('info', 'unknownEvent', 'not printed')

      expect(printed).to.deep.equal([['info', 'printed']])
    })

    it('Should not throw when log() runs without an event being registered', function () {
      const on = new On(config)

      expect(function () {
        on.log()
      }).to.not.throw()
      expect(on.events).to.have.lengthOf(0)
    })
  })

  describe('Registration guards', function () {
    it('Should require redis for eventReceived', function () {
      const mqOnlyConfig = {
        mq: config.mq,
        reconnectOnClose: false,
      }
      const on = new On(mqOnlyConfig)

      expect(function () {
        on.eventReceived('noRedisEvent')
      }).to.throw('Redis config must be set if enabling events listeners')
      expect(on.events).to.have.lengthOf(0)
    })

    it('Should throw when an event is registered twice as a broadcast', function () {
      const on = new On(config)

      on.broadcastReceived('broadcastEvent')
      expect(on._getEvents('topic')[0]).to.have.property('asTask', true)

      expect(function () {
        on.broadcastReceived('broadcastEvent')
      }).to.throw('The event broadcastEvent is already registered, possibly as eventReceived')
      expect(on._getEvents('topic')).to.have.lengthOf(1)
    })

    it('Should throw when a request is registered twice', function () {
      const on = new On(config)

      on.requestReceived('statusRequest')
      expect(function () {
        on.requestReceived('statusRequest')
      }).to.throw('Request statusRequest already registered')
      expect(on._getEvents('rpc')).to.have.lengthOf(1)
    })

    it('Should refuse a delayed task when the delayed exchange is not configured', function () {
      const on = new On(config)

      expect(function () {
        on.taskReceived('delayedTask', { isDelayed: true })
      }).to.throw(/delayed_exchange_name is empty/)
      expect(on.events).to.have.lengthOf(0)
    })

    it('Should refuse manual ack on anything but a regular queue task', function () {
      const on = new On(config)

      on.eventReceived('topicWithManualAck')
      expect(function () {
        on.ackAfterProcessing()
      }).to.throw(/only supported for queue events/)
    })

    it('Should refuse manual ack before taskReceived', function () {
      const on = new On(config)

      // no event is being registered, so the ack mode is rejected before the
      // "was taskReceived called first" check is reached
      expect(function () {
        on.ackAfterProcessing()
      }).to.throw(/only supported for queue events/)
    })

    it('Should refuse respond() before requestReceived', function () {
      const on = new On(config)

      expect(function () {
        on.respond()
      }).to.throw('The event hasn\'t been registered first')
    })
  })

  describe('Event names', function () {
    it('Should list the names of the events of a type in registration order', function () {
      const on = new On(config)

      on.taskReceived('firstQueue')
      on.eventReceived('firstTopic')
      on.taskReceived('secondQueue')
      on.requestReceived('aRequest')

      expect(on._getEventNames('queue')).to.deep.equal(['firstQueue', 'secondQueue'])
      expect(on._getEventNames('topic')).to.deep.equal(['firstTopic'])
      expect(on._getEventNames('rpc')).to.deep.equal(['aRequest'])
      expect(on._getEventNames('delayedQueue')).to.deep.equal([])
      expect(on._getEventNames('unknown')).to.deep.equal([])
    })

    it('Should return the first event with a name whatever its type', function () {
      const on = new On(config)

      on.taskReceived('sharedName')
      on.eventReceived('sharedName')

      expect(on._getEventByName('sharedName')).to.have.property('type', 'queue')
      expect(on._getEventByName('missing')).to.equal(undefined)
    })
  })

  describe('Stopping listeners', function () {
    it('Should remove every local listener and keep the chain returnable', function () {
      const on = new On(config)
      on.on('error', nullMe)
      on.on('custom', nullMe)

      const result = on._stopEventsListeners()

      expect(result).to.equal(on)
      expect(on.listenerCount('error')).to.equal(0)
      expect(on.listenerCount('custom')).to.equal(0)
    })
  })

  describe('RPC', function () {
    it('Should fail to register an RPC event if the event hasn\'t been registered before', function () {
      const on = new On(config)

      try {
        on
          .respond()
      }
      catch (error) {
        expect(error).to.have.property('message', 'The event hasn\'t been registered first')
      }
    })

    it('Should register an RPC event listener', function () {
      const on = new On(config)

      on
        .requestReceived('testEvent')
        .respond()

      const eventsRegistered = on._getEvents('rpc')

      expect(eventsRegistered).to.be.an('array')
      expect(eventsRegistered).to.have.lengthOf(1)
      expect(eventsRegistered[0]).to.have.property('eventName', 'testEvent')
      expect(eventsRegistered[0]).to.have.property('type', 'rpc')
    })

    it('Should register an RPC event listener with a callback', function () {
      const on = new On(config)

      on
        .requestReceived('testEvent')
        .respond()
        .afterExecuting(nullMe)

      const eventsRegistered = on._getEvents('rpc')

      expect(eventsRegistered).to.be.an('array')
      expect(eventsRegistered).to.have.lengthOf(1)
      expect(eventsRegistered[0]).to.have.property('eventName', 'testEvent')
      expect(eventsRegistered[0]).to.have.property('type', 'rpc')
      expect(eventsRegistered[0]).to.have.property('actions')
      expect(eventsRegistered[0].actions).to.have.lengthOf(1)
      expect(eventsRegistered[0].actions[0]).to.equal(nullMe)
    })

    it('Should register an RPC event, a topic event and a queue event', function () {
      const on = new On(config)

      on
        .eventReceived('testEvent')
        .do(nullMe)
        .do(nullMeToo)

      on
        .taskReceived('testEvent')
        .andProcess(nullMeToo)

      on
        .requestReceived('testEvent')
        .respond()
        .afterExecuting(nullMe)

      const topics = on._getEvents('topic')
      const queues = on._getEvents('queue')
      const rpcs = on._getEvents('rpc')

      expect(topics).to.be.an('array')
      expect(topics).to.have.lengthOf(1)

      expect(queues).to.be.an('array')
      expect(queues).to.have.lengthOf(1)

      expect(rpcs).to.be.an('array')
      expect(rpcs).to.have.lengthOf(1)

      expect(topics[0]).to.have.property('eventName', 'testEvent')
      expect(topics[0]).to.have.property('type', 'topic')
      expect(topics[0]).to.have.property('actions')
      expect(topics[0].actions).to.have.lengthOf(2)
      expect(topics[0].actions[0]).to.equal(nullMe)
      expect(topics[0].actions[1]).to.equal(nullMeToo)

      expect(queues[0]).to.have.property('eventName', 'testEvent')
      expect(queues[0]).to.have.property('type', 'queue')
      expect(queues[0]).to.have.property('actions')
      expect(queues[0].actions).to.have.lengthOf(1)
      expect(queues[0].actions[0]).to.equal(nullMeToo)

      expect(rpcs[0]).to.have.property('eventName', 'testEvent')
      expect(rpcs[0]).to.have.property('type', 'rpc')
      expect(rpcs[0]).to.have.property('actions')
      expect(rpcs[0].actions).to.have.lengthOf(1)
      expect(rpcs[0].actions[0]).to.equal(nullMe)
    })
  })

  describe('Modernization flags', function () {
    it('Should tear down without throwing when init has not been called', async function () {
      const on = new On(config)

      await on.tearDown()
    })

    it('Should pass validation for an event registered without properties', function () {
      const on = new On(config)

      on.broadcastReceived('broadcastEvent')

      const validation = on._validationIsSuccess('broadcastEvent', { any: 'data' })

      expect(validation).to.equal(true)
    })

    it('Should find events from the start of the registered list', function () {
      const on = new On(config)

      on
        .eventReceived('firstEvent')
        .eventReceived('secondEvent')

      expect(on._getEventIndex('firstEvent')).to.equal(0)
      expect(on._getEventIndex('secondEvent')).to.equal(1)
      expect(on._getEventIndex('nope')).to.equal(-1)
    })

    it('Should attach a single error listener to the redis queue at registration time', function () {
      const on = new On(config)

      on.eventReceived('listenerEvent')

      expect(on.events[0].redisQueue.listenerCount('error')).to.equal(1)
    })

    it('Should close the redis queue, the worker and the MQ connection on tearDown', async function () {
      const on = new On(config)
      on.eventReceived('tearDownEvent')

      const closed = []
      on.events[0].redisQueue.close = async function () { closed.push('queue') }
      on.events[0].redisWorker = { close: async function () { closed.push('worker') } }
      on.setConnection({ close: async function () { closed.push('connection') } })

      await on.tearDown()
      expect(closed).to.deep.equal(['queue', 'worker', 'connection'])

      // a second call finds no connection and must resolve without throwing
      await on.tearDown()
      expect(on.getConnection()).to.not.exist
    })
  })

  describe('tearDown error containment', function () {
    it('Should log and swallow a failing MQ connection close', async function () {
      const logged = []
      const logger = {
        info: function () {},
        error: function (message, metadata) { logged.push([message, metadata]) },
        warning: function () {},
      }

      const on = new On(Object.assign({}, config, { logger: logger }))
      on.setConnection({
        close: async function () {
          throw new Error('close boom')
        },
      })

      await on.tearDown()

      expect(on.getConnection()).to.not.exist
      expect(logged).to.have.lengthOf(1)
      expect(logged[0][0]).to.equal('Error closing MQ connection')
      expect(logged[0][1]).to.have.property('message', 'close boom')
    })

    it('Should close the worker even when the redis queue close fails', async function () {
      const logged = []
      const logger = {
        info: function () {},
        error: function (message) { logged.push(message) },
        warning: function () {},
      }

      const on = new On(Object.assign({}, config, { logger: logger }))
      on.eventReceived('redisCloseFailure')

      const closed = []
      on.events[0].redisQueue.close = async function () {
        throw new Error('queue close boom')
      }
      on.events[0].redisWorker = {
        close: async function () {
          closed.push('worker')
        },
      }

      await on.tearDown()

      expect(closed).to.deep.equal(['worker'])
      expect(logged).to.deep.equal(['Error closing redis queue'])
    })

    it('Should log and swallow a failing redis worker close', async function () {
      const logged = []
      const logger = {
        info: function () {},
        error: function (message) { logged.push(message) },
        warning: function () {},
      }

      const on = new On(Object.assign({}, config, { logger: logger }))
      on.eventReceived('workerCloseFailure')

      const closed = []
      on.events[0].redisQueue.close = async function () { closed.push('queue') }
      on.events[0].redisWorker = {
        close: async function () {
          throw new Error('worker close boom')
        },
      }

      await on.tearDown()

      expect(closed).to.deep.equal(['queue'])
      expect(logged).to.deep.equal(['Error closing redis worker'])
    })
  })
})

describe('Default logger', function () {
  const utils = require('../../lib/utils')
  const originalConsole = {
    log: console.log,
    error: console.error,
  }
  let calls = []

  beforeEach(function () {
    calls = []
    console.log = function (...args) { calls.push(['log', args]) }
    console.error = function (...args) { calls.push(['error', args]) }
  })

  afterEach(function () {
    console.log = originalConsole.log
    console.error = originalConsole.error
  })

  it('Should log info and warning on the console with optional data', function () {
    utils.logger.info('plain info')
    utils.logger.info('info with data', { id: 1 })
    utils.logger.warning('plain warning')
    utils.logger.warning('warning with data', { id: 2 })

    expect(calls).to.deep.equal([
      ['log', ['plain info']],
      ['log', ['info with data', { id: 1 }]],
      ['log', ['plain warning']],
      ['log', ['warning with data', { id: 2 }]],
    ])
  })

  it('Should log errors on the error stream with optional data', function () {
    utils.logger.error('plain error')
    utils.logger.error('error with data', new Error('boom'))

    expect(calls).to.have.lengthOf(2)
    expect(calls[0]).to.deep.equal(['error', ['plain error']])
    expect(calls[1][0]).to.equal('error')
    expect(calls[1][1][0]).to.equal('error with data')
    expect(calls[1][1][1]).to.have.property('message', 'boom')
  })

  it('Should log only what the legacy next() callback receives', function () {
    utils.next(null, null)
    utils.next(null, 'result')
    utils.next(new Error('failed'))

    expect(calls).to.have.lengthOf(2)
    expect(calls[0]).to.deep.equal(['log', ['result']])
    expect(calls[1][0]).to.equal('log')
    expect(calls[1][1][0]).to.be.an('error').with.property('message', 'failed')
  })
})
