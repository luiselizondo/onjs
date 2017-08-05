var should = require('should')
var On = require('../../index')
var EventEmitter = require('events');
class Events extends EventEmitter {}
var MQ = require('rabbitmq-lib')

function nullMe(data) {
  return null
}

function nullMeToo() {
  return null
}

describe('On.js', function () {
  var config = {
    exchange_name: 'onjs_test',
    url: 'amqp://rabbitmq:rabbitmq@localhost:35672/'
  }

  describe('Topics registration', function () {
    it('Should get an event given the index', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .eventReceived('testEvent2')

      var index = on._getEventIndex('testEvent2')
      index.should.be.equal(1)
      done();
    })

    it('Should register a topic event listener with a callback', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .do(nullMe)

      var eventsRegistered = on._getEvents('topic')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'topic');
      eventsRegistered[0].should.have.property('callback')
      eventsRegistered[0].should.have.property('callback', nullMe)

      done()
    })

    it('Should throw an error when not registering a callback', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on.eventReceived('testEvent').do()
      }
      catch (error) {
        error.should.have.property('message', 'A callback needs to be registered first calling the do method or the registerCallback method')
        done()
      }

    })

    it('Should throw an error if the callback registered is not a Function', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on.eventReceived('testEvent').do(true)
      }
      catch (error) {
        error.should.have.property('message', 'A callback needs to be registered first and be a function')
        done()
      }
    })

    it('Should throw an error if the event was not registered first', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on.do(nullMe)
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
        done()
      }
    })
  })

  describe('Double events', function () {
    it('Should register different event names with different callbacks', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent2')
      .do(nullMeToo)

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(2);
      events[0].should.have.property('callback', nullMe)
      events[0].should.have.property('eventName', 'testEvent')
      events[1].should.have.property('callback', nullMeToo)
      events[1].should.have.property('eventName', 'testEvent2')
      done()
    });

    it('Should register different event names with the same callback', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent2')
      .do(nullMe)

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(2);
      events[0].should.have.property('callback', nullMe)
      events[0].should.have.property('eventName', 'testEvent')
      events[1].should.have.property('callback', nullMe)
      events[1].should.have.property('eventName', 'testEvent2')
      done()
    })

    it('Should register the same event name with different callbacks', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent')
      .do(nullMeToo)

      var events = on._getEvents('topic')

      events.should.be.an.Array;
      events.should.have.lengthOf(2);
      events[0].should.have.property('callback', nullMe)
      events[0].should.have.property('eventName', 'testEvent')
      events[1].should.have.property('callback', nullMeToo)
      events[1].should.have.property('eventName', 'testEvent')
      done()
    })
  })

  describe('Properties', function () {
    it('Should register an event with properties', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

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
      done()
    })

    it('Should throw an error when the event hasn\'t been registered first', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on
        .withProperties(['name'])
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
        done();
      }
    })

    it('Should throw an error if the properties is not an array', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on
        .eventReceived('testEvent')
        .withProperties('name')
      }
      catch (error) {
        error.should.have.property('message', 'The properties must be an array')
        done();
      }
    })
  })

  describe('Validate properties', function () {
    it("Should pass validation of properties", function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .withProperties(['name', 'age'])

      var data = {
        name: 'Hello World',
        age: 25
      }

      var validation = on.validationIsSuccess('testEvent', data)

      validation.should.equal(true)
      done()
    })

    it("Should fail validation of properties", function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .withProperties(['name', 'age'])

      var data = {
        age: 25
      }

      var validation = on.validationIsSuccess('testEvent', data)

      validation.should.equal(false)
      done()
    })
  })

  describe('Queues', function () {
    it('Should register a queue event listener', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .addToQueue()

      var eventsRegistered = on._getEvents('queue')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'queue');

      done()
    })

    it('Should register a queue event listener with a callback', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .addToQueue()
      .andProcess(nullMe)

      var eventsRegistered = on._getEvents('queue')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'queue');
      eventsRegistered[0].should.have.property('callback')
      eventsRegistered[0].should.have.property('callback', nullMe)

      done()
    })

    it('Should register a topic and a queue event with the same name', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent')
      .addToQueue()
      .andProcess(nullMeToo)

      on
      .eventReceived('testEvent')
      .do(nullMeToo)

      var topics = on._getEvents('topic')
      var queues = on._getEvents('queue')

      topics.should.be.an.Array;
      topics.should.have.lengthOf(2);

      queues.should.be.an.Array;
      queues.should.have.lengthOf(1);

      topics[0].should.have.property('eventName', 'testEvent');
      topics[0].should.have.property('type', 'topic');
      topics[0].should.have.property('callback')
      topics[0].should.have.property('callback', nullMe)

      topics[1].should.have.property('eventName', 'testEvent');
      topics[1].should.have.property('type', 'topic');
      topics[1].should.have.property('callback')
      topics[1].should.have.property('callback', nullMeToo)

      queues[0].should.have.property('eventName', 'testEvent');
      queues[0].should.have.property('type', 'queue');
      queues[0].should.have.property('callback')
      queues[0].should.have.property('callback', nullMeToo)

      done()
    })

    it("Should create a dispatchable event", function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .addToQueue()
      .andDispatchAs('newEvent')

      var queues = on._getEvents('queue')

      queues[0].should.have.property('eventName', 'testEvent');
      queues[0].should.have.property('type', 'queue');
      queues[0].should.have.property('dispatchAs', 'newEvent')
      done()
    })

    it("Should throw an error if a dispatchable event hasn't been registered first", function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on
        .andDispatchAs('newEvent')
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
        done()
      }
    })

    it("Should throw an error if a dispatchable event is registered on a topic", function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on
        .eventReceived('testEvent')
        .andDispatchAs('newEvent')
      }
      catch (error) {
        error.should.have.property('message', 'Dispatchable events should be registered as queues. Execute the method addToQueue before')
        done()
      }
    })
  })

  describe('RPC', function () {
    it('Should fail to register an RPC event if the event hasn\'t been registered before', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      try {
        on
        .respond()
      }
      catch (error) {
        error.should.have.property('message', 'The event hasn\'t been registered first')
        done()
      }
    })

    it('Should register an RPC event listener', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .respond()

      var eventsRegistered = on._getEvents('rpc')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'rpc');

      done()
    })

    it('Should register an RPC event listener with a callback', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .respond()
      .afterExecuting(nullMe)

      var eventsRegistered = on._getEvents('rpc')

      eventsRegistered.should.be.an.Array;
      eventsRegistered.should.have.lengthOf(1);
      eventsRegistered[0].should.have.property('eventName', 'testEvent');
      eventsRegistered[0].should.have.property('type', 'rpc');
      eventsRegistered[0].should.have.property('callback')
      eventsRegistered[0].should.have.property('callback', nullMe)

      done()
    });

    it('Should register an RPC event, a topic event and a queue event', function (done) {
      var eventsInstance = new Events();
      var mq = new MQ(eventsInstance, config)
      var on = new On(mq, eventsInstance, {})

      on
      .eventReceived('testEvent')
      .do(nullMe)

      on
      .eventReceived('testEvent')
      .addToQueue()
      .andProcess(nullMeToo)

      on
      .eventReceived('testEvent')
      .do(nullMeToo)

      on
      .eventReceived('testEvent')
      .respond()
      .afterExecuting(nullMe)

      var topics = on._getEvents('topic')
      var queues = on._getEvents('queue')
      var rpcs = on._getEvents('rpc')

      topics.should.be.an.Array;
      topics.should.have.lengthOf(2);

      queues.should.be.an.Array;
      queues.should.have.lengthOf(1);

      rpcs.should.be.an.Array;
      rpcs.should.have.lengthOf(1);

      topics[0].should.have.property('eventName', 'testEvent');
      topics[0].should.have.property('type', 'topic');
      topics[0].should.have.property('callback')
      topics[0].should.have.property('callback', nullMe)

      topics[1].should.have.property('eventName', 'testEvent');
      topics[1].should.have.property('type', 'topic');
      topics[1].should.have.property('callback')
      topics[1].should.have.property('callback', nullMeToo)

      queues[0].should.have.property('eventName', 'testEvent');
      queues[0].should.have.property('type', 'queue');
      queues[0].should.have.property('callback')
      queues[0].should.have.property('callback', nullMeToo)

      rpcs[0].should.have.property('eventName', 'testEvent');
      rpcs[0].should.have.property('type', 'rpc');
      rpcs[0].should.have.property('callback')
      rpcs[0].should.have.property('callback', nullMe)

      done()
    })
  });
})
