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
      on.eventReceived('testEvent')

      const eventExists = on._eventExists('testEvent', 'queue')
      expect(eventExists).to.be.true
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
})
