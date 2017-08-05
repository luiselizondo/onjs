var Queue = require('bull');
var _ = require('lodash')

function On(mqInstance, eventsInstance, options) {
  this.config = options
  this.mq = mqInstance
  this.eventsInstance = eventsInstance
  this.events = []
  this.currentEventNameToRegister = null
}

On.prototype.eventReceived = function (eventName) {
  this.currentEventNameToRegister = eventName
  this.events.push({
    eventName: eventName,
    type: 'topic'
  })

  return this
}

On.prototype.requestReceived = function (eventName) {
  this.currentEventNameToRegister = eventName
  this.events.push({
    eventName: eventName,
    type: 'rpc'
  })

  return this
}

On.prototype.addToQueue = function () {
  var eventIndex = this._getEventIndex(this.currentEventNameToRegister)
  if (eventIndex >= 0) {
    this.events[eventIndex].type = 'queue'
    return this
  }
  else {
    throw new Error('The event hasn\'t been registered first')
  }
}

On.prototype.respond = function () {
  var eventIndex = this._getEventIndex(this.currentEventNameToRegister)
  if (eventIndex >= 0) {
    this.events[eventIndex].type = 'rpc'
    return this
  }
  else {
    throw new Error('The event hasn\'t been registered first')
  }
}

On.prototype.registerCallback = function (callback) {
  if (!callback) {
    throw new Error('A callback needs to be registered first calling the do method or the registerCallback method')
  }

  if (typeof callback !== 'function') {
    throw new Error('A callback needs to be registered first and be a function')
  }

  var eventIndex = this._getEventIndex(this.currentEventNameToRegister)
  if (eventIndex >= 0) {
    this.events[eventIndex].callback = callback
    return this
  }
  else {
    throw new Error('The event hasn\'t been registered first')
  }
}

// Alias method
On.prototype.do = function (callback) {
  return this.registerCallback(callback)
}

// Alias method
On.prototype.andProcess = function (callback) {
  return this.registerCallback(callback)
}

// Alias method
On.prototype.afterExecuting = function (callback) {
  return this.registerCallback(callback)
}

On.prototype.andDispatchAs = function (newEventName) {
  var eventIndex = this._getEventIndex(this.currentEventNameToRegister)
  if (eventIndex >= 0) {

    if (!this._eventIsQueue(this.events[eventIndex])) {
      throw new Error('Dispatchable events should be registered as queues. Execute the method addToQueue before')
    }

    this.events[eventIndex].dispatchAs = newEventName
    return this
  }
  else {
    throw new Error('The event hasn\'t been registered first')
  }
}

On.prototype.withProperties = function (properties) {
  if (!_.isArray(properties)) {
    throw new Error('The properties must be an array')
  }

  var eventIndex = this._getEventIndex(this.currentEventNameToRegister)
  if (eventIndex >= 0) {
    this.events[eventIndex].properties = properties
    return this
  }
  else {
    throw new Error('The event hasn\'t been registered first')
  }
}

On.prototype.validationIsSuccess = function (eventName, data) {
  var event = this._getEventByName(eventName)
  var properties = event.properties

  var hasEveryProperty = properties.every((property) => {
    return property in data
  })

  return hasEveryProperty
}

// Consume events from MQ
// Once an event has been received by MQ
// It will trigger an event on the eventsInstance
// that will be picked up by the _init* methods.
// Each of those methods subscribe locally to an event of the same name As MQ
On.prototype.init = function () {
  var topics = this._getEvents('topic')
  var queues = this._getEvents('queue')
  var requests = this._getEvents('rpc')

  return this.mq.connect()
  .then(() => {
    if (topics.length > 0) {
      this._initTopics(topics)
    }

    if (queues.length > 0) {
      this._initQueues(queues)
    }

    if (requests.length > 0) {
      this._initRPCRequests(requests)
    }
  })
  .catch((error) => {
    throw error
  })
}

On.prototype._initRPCRequests = function (requests) {
  requests.forEach((request) => {
    this.mq.listenAndAnswerRequest(request.eventName, request.callback)
  })
}

// Consume events from MQ based on topics pattern
On.prototype._initTopics = function (topics) {
  var topicsNames = topics.map((topic) => {
    return topic.eventName
  })

  this.mq.listenForTopics(topicsNames)

  topics.forEach((topic) => {
    this.eventsInstance.on(topic.eventName, (data) => {
      if (this.validationIsSuccess(topic.eventName, data)) {
        return topic.callback(data)
      }
      else {
        throw new Error('Validation failed for event ' + topic.eventName)
      }
    })
  })
}

// Consume queue events from MQ
// Once the event is received it will be sent
// To a local redis-based queue
// Where it will be processed to avoid duplicate
// events sent from multiple processes
On.prototype._initQueues = function (queues) {
  var queueNames = queues.map((queue) => {
    return queue.eventName
  })

  this.mq.consumeFromQueue(queueNames)

  queues.forEach((queue) => {
    this.eventsInstance.on(queue.eventName, (data) => {
      if (this.validationIsSuccess(queue.eventName, data)) {
        return this._onEventReceivedOnQueue(queue, data)
      }
      else {
        throw new Error('Validation failed for event ' + queue.eventName)
      }
    })
  })
}

On.prototype._onEventReceivedOnQueue = function (queue, data) {
  var taskName = this._addToRedisQueue(queue, data)
  if (queue.dispatchAs) {
    this._redispatchToMQ(queue, taskName)
  }
  else {
    this._sendToRedisQueueToProcess(queue, taskName)
  }
}

On.prototype._addToRedisQueue = function (queue, data) {
  var now = Date.now()
  var jobId = data.tid || now
  var queueName = queue.eventName
  var taskName = queue.eventName + '-' + now;

  this.redisQueue = new Queue(queueName, {
    redis: this.config.redis
  })

  this.redisQueue.add(taskName, data, {
    jobId: jobId
  })

  return taskName
}

On.prototype._sendToRedisQueueToProcess = function (queue, taskName) {
  this.redisQueue.process(taskName, (job, done) => {
    return queue.callback(job.data)
  })
}

On.prototype._redispatchToMQ = function (queue, taskName) {
  this.redisQueue.process(taskName, (job, done) => {
    var newEventName = queue.dispatchAs
    this.mq.dispatchToQueue(newEventName, job.data)
    done()
  })
}

// Valid Types are:
// - topic
// - queue
// - rpc
On.prototype._getEvents = function _getEvents (type) {
  return _.filter(this.events, (event) => {
    return event.type === type
  })
}

On.prototype._getEventNames = function (type) {
  var events = _.filter(this.events, (event) => {
    return event.type === type
  })

  var names = events.map((event) => {
    return event.eventName
  })

  return names
}

On.prototype._getEventIndex = function (eventName) {
  var index = this.events.map((element) => {
    return element.eventName
  }).indexOf(eventName, -1)

  return index
}

On.prototype._getEventByName = function (eventName) {
  return _.find(this.events, (event) => {
    return event.eventName === eventName
  })
}

On.prototype._eventIsQueue = function (event) {
  return event.type === 'queue'
}

module.exports = On
