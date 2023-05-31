var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib').MQ
var REDIS_PORT = 19379

function nullMe(data) {
  return null
}

function nullMeToo() {
  return null
}

describe('On.js', function () {
  var config = {
    mq: {
      exchange_name: 'onjs_test',
      url: 'amqp://rabbitmq:rabbitmq@localhost:5672/',
    },
    redis: {
      port: REDIS_PORT,
      host: 'rabbitmq'
    }
  }

  describe('Topics registration', function () {
    it('Should get an event given the index', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .eventReceived('testEvent2')

      var index = on._getEventIndex('testEvent2')
      index.should.be.equal(1)
    })

    it('Should register a topic event listener with a callback', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .do(nullMe)

      var eventsRegistered = on._getEvents('topic')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'topic');
      eventsRegistered[0].should.have.property('actions')
      eventsRegistered[0].actions[0].should.equal(nullMe)
    })

    it('Should throw an error when not registering a callback', function () {
      var on = new On(config)

      try {
        on
        .eventReceived('testEvent')
        .do()
      }
      catch (error) {
        error.should.have.property('message', 'A callback needs to be registered first calling the do method or the registerCallback method')
      }
    })

    it('Should throw an error if the callback registered is not a Function', function () {
      var on = new On(config)

      try {
        on
        .eventReceived('testEvent')
        .do(true)
      }
      catch (error) {
        error.should.have.property('message', 'A callback needs to be registered first and be a function')
      }
    })

    it('Should throw an error if the event was not registered first', function () {
      var on = new On(config)

      try {
        on.do(nullMe)
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
      }
    })
  })

  describe('Double events', function () {
    it('Should register different event names with different callbacks', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent2')
      .do(nullMeToo)

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(2);
      events[0].should.have.property('actions')
      events[0].should.have.property('eventName', 'testEvent')
      events[0].actions.should.have.lengthOf(1)
      events[0].actions[0].should.equal(nullMe)

      events[1].should.have.property('actions')
      events[1].should.have.property('eventName', 'testEvent2')
      events[1].actions.should.have.lengthOf(1)
      events[1].actions[0].should.equal(nullMeToo)
    });

    it('Should register different event names with the same callback', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent2')
      .do(nullMe)

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(2);
      events[0].should.have.property('eventName', 'testEvent')
      events[1].should.have.property('eventName', 'testEvent2')
      
      events[0].actions[0].should.equal(nullMe)
      events[1].actions[0].should.equal(nullMe)
    })

    it('Should register the same event name with different callbacks', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .do(nullMe)
      .and()
      .do(nullMeToo)

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(1);
      events[0].should.have.property('actions')
      events[0].actions.should.have.lengthOf(2)
      events[0].actions[0].should.equal(nullMe)
      events[0].actions[1].should.equal(nullMeToo)
      events[0].should.have.property('eventName', 'testEvent')
      events[0].should.have.property('type', 'topic')
    })
  })

  describe('Properties', function () {
    it('Should register an event with properties', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .withProperties(['name', 'age'])

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(1);
      events[0].should.have.property('eventName', 'testEvent')
      events[0].should.have.property('properties')
      events[0].properties.should.be.an.Array;
      events[0].properties.should.have.lengthOf(2);
      events[0].properties[0].should.equal('name')
      events[0].properties[1].should.equal('age')
    })

    it('Should throw an error when the event hasn\'t been registered first', function () {
      var on = new On(config)

      try {
        on
        .withProperties(['name'])
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
      }
    })

    it('Should throw an error if the properties is not an array', function () {
      var on = new On(config)

      try {
        on
        .eventReceived('testEvent')
        .withProperties('name')
      }
      catch (error) {
        error.should.have.property('message', 'The properties must be an array')
      }
    })
  })

  describe('Validate properties', function () {
    it("Should pass validation of properties", function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .withProperties(['name', 'age'])

      var data = {
        name: 'Hello World',
        age: 25
      }

      var validation = on._validationIsSuccess('testEvent', data)

      validation.should.equal(true)
    })

    it("Should fail validation of properties", function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .withProperties(['name', 'age'])

      var data = {
        age: 25
      }

      var validation = on._validationIsSuccess('testEvent', data)

      validation.should.equal(false)
    })
  })

  describe('Event types', function () {
    it('Should detect that an event exists of type topic', function () {
      var on = new On(config)

      try {
        on.eventReceived('testEvent')
        on.taskReceived('testEvent1')
        on.eventReceived('testEvent')
      }
      catch (err) {
        err.should.have.property('message', 'The event testEvent is already registered')
        
        var events = on._getEvents('topic')
        events.should.have.lengthOf(1)
        events[0].should.have.property('eventName', 'testEvent')
      }
    })

    it('Should detect that an event exists of type task', function () {
      var on = new On(config)
      
      try {
        on.eventReceived('testEvent')
        on.taskReceived('testEvent1')
        on.taskReceived('testEvent1')
      }
      catch (err) {
        err.should.have.property('message', 'The task testEvent1 is already registered')
        var events = on._getEvents('queue')
        events.should.have.lengthOf(1)
        events[0].should.have.property('eventName', 'testEvent1')
      }
    })

    it('Should detect that an event exists with the same name but different type', function () {
      var on = new On(config)

      on.eventReceived('testEvent')
      on.taskReceived('testEvent')

      var queues = on._getEvents('queue')
      queues.should.have.lengthOf(1)
      queues[0].should.have.property('eventName', 'testEvent')
      queues[0].should.have.property('type', 'queue')

      on.eventReceived('testEvent1')
      on.taskReceived('testEvent1')

      var topics = on._getEvents('topic')
      topics.should.have.lengthOf(2)
      topics[0].should.have.property('eventName', 'testEvent')
      topics[1].should.have.property('eventName', 'testEvent1')
      topics[0].should.have.property('type', 'topic')
    })

    it('Should detect that an event of type topic exist', function () {
      var on = new On(config)

      on.eventReceived('testEvent')

      var eventExists = on._eventExists('testEvent', 'topic')
      eventExists.should.be.true
    })

    it('Should detect that an event of type queue exists', function () {
      var on = new On(config)

      on.taskReceived('testEvent')

      var eventExists = on._eventExists('testEvent', 'queue')
      eventExists.should.be.true
    })

    it('Should detect that an event of type rpc exists', function () {
      var on = new On(config)

      on.requestReceived('testEvent')

      var eventExists = on._eventExists('testEvent', 'rpc')
      eventExists.should.be.true
    })

    it('Should detect that an event of type topic exists when another event of type queue exists with the same name', function () {
      var on = new On(config)

      on.taskReceived('testEvent')
      on.eventReceived('testEvent')

      var eventExists = on._eventExists('testEvent', 'queue')
      eventExists.should.be.true
    })

    it('Should detect than an event of type topic does not exist when another event of type queue exists with the same name', function () {
      var on = new On(config)

      on.taskReceived('testEvent')
      on.eventReceived('testEvent')

      var eventExists = on._eventExists('testEvent', 'queue')
      eventExists.should.be.true
    })

    it('Should detect that an event of type queue exists when another event of type topic exists with the same name', function () {
      var on = new On(config)

      on.taskReceived('testEvent')
      on.eventReceived('testEvent')

      var eventExists = on._eventExists('testEvent', 'topic')
      eventExists.should.be.true
    })
  })

  describe('Queues', function () {
    it('Should register a queue event listener', function () {
      var on = new On(config)

      on
      .taskReceived('testEvent')

      var eventsRegistered = on._getEvents('queue')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'queue');
    })

    it('Should register a queue event listener with a callback', function () {
      var on = new On(config)

      on
      .taskReceived('testEvent')
      .andProcess(nullMe)

      var eventsRegistered = on._getEvents('queue')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'queue');
      eventsRegistered[0].should.have.property('actions')
      eventsRegistered[0].actions.should.have.lengthOf(1)
      eventsRegistered[0].actions[0].should.equal(nullMe)
    })

    it('Should register a topic and a queue event with the same name', function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .do(nullMe)
      .and()
      .do(nullMeToo)

      on
      .taskReceived('testEvent')
      .andProcess(nullMeToo)

      var topics = on._getEvents('topic')
      var queues = on._getEvents('queue')

      topics.should.be.an.Array;
      topics.should.have.lengthOf(1);

      queues.should.be.an.Array;
      queues.should.have.lengthOf(1);

      topics[0].should.have.property('eventName', 'testEvent');
      topics[0].should.have.property('type', 'topic');
      topics[0].should.have.property('actions')
      topics[0].actions.should.have.lengthOf(2)
      topics[0].actions[0].should.equal(nullMe)
      topics[0].actions[1].should.equal(nullMeToo)

      queues[0].should.have.property('eventName', 'testEvent');
      queues[0].should.have.property('type', 'queue');
      queues[0].should.have.property('actions')
      queues[0].actions.should.have.lengthOf(1)
      queues[0].actions[0].should.equal(nullMeToo)
    })

    it("Should create a dispatchable event", function () {
      var on = new On(config)

      on
      .eventReceived('testEvent')
      .andDispatchAs('newEvent')

      var topics = on._getEvents('topic')

      topics[0].should.have.property('eventName', 'testEvent');
      topics[0].should.have.property('type', 'topic');
      topics[0].should.have.property('dispatchAs')
      topics[0].dispatchAs.should.have.lengthOf(1)
      topics[0].dispatchAs[0].should.equal('newEvent')
    })

    it("Should throw an error if a dispatchable event hasn't been registered first", function () {
      var on = new On(config)

      try {
        on
        .andDispatchAs('newEvent')
      }
      catch (error) {
        error.should.have.property('message', 'The event null hasn\'t been registered first')
      }
    })

    it("Should throw an error if a dispatchable event is registered as a task", function () {
      var on = new On(config)

      try {
        on
        .taskReceived('testEvent')
        .andDispatchAs('newEvent')
      }
      catch (error) {
        error.should.have.property('message', 'Dispatchable events should be registered as topics. Execute the method onEventReceived instead of onTaskReceived on the event testEvent')
      }
    })
  })

  describe('RPC', function () {
    it('Should fail to register an RPC event if the event hasn\'t been registered before', function () {
      var on = new On(config)

      try {
        on
        .respond()
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
      }
    })

    it('Should register an RPC event listener', function () {
      var on = new On(config)

      on
      .requestReceived('testEvent')
      .respond()

      var eventsRegistered = on._getEvents('rpc')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'rpc');
    })

    it('Should register an RPC event listener with a callback', function () {
      var on = new On(config)

      on
      .requestReceived('testEvent')
      .respond()
      .afterExecuting(nullMe)

      var eventsRegistered = on._getEvents('rpc')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'rpc');
      eventsRegistered[0].should.have.property('actions')
      eventsRegistered[0].actions.should.have.lengthOf(1)
      eventsRegistered[0].actions[0].should.equal(nullMe)
    });

    it('Should register an RPC event, a topic event and a queue event', function () {
      var on = new On(config)

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

      var topics = on._getEvents('topic')
      var queues = on._getEvents('queue')
      var rpcs = on._getEvents('rpc')

      topics.should.be.an.Array;
      topics.should.have.lengthOf(1);

      queues.should.be.an.Array;
      queues.should.have.lengthOf(1);

      rpcs.should.be.an.Array;
      rpcs.should.have.lengthOf(1);

      topics[0].should.have.property('eventName', 'testEvent');
      topics[0].should.have.property('type', 'topic');
      topics[0].should.have.property('actions')
      topics[0].actions.should.have.lengthOf(2)
      topics[0].actions[0].should.equal(nullMe)
      topics[0].actions[1].should.equal(nullMeToo)

      queues[0].should.have.property('eventName', 'testEvent');
      queues[0].should.have.property('type', 'queue');
      queues[0].should.have.property('actions')
      queues[0].actions.should.have.lengthOf(1)
      queues[0].actions[0].should.equal(nullMeToo)

      rpcs[0].should.have.property('eventName', 'testEvent');
      rpcs[0].should.have.property('type', 'rpc');
      rpcs[0].should.have.property('actions')
      rpcs[0].actions.should.have.lengthOf(1)
      rpcs[0].actions[0].should.equal(nullMe)
    })
  });
})
