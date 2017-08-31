var Queue = require('bull');
var _ = require('lodash')

function On(mqInstance, options) {
  this.config = options
  this.mq = mqInstance
  this.events = []
  this.currentEventNameToRegister = null
  this.debugEnabled = false
}

On.prototype.debug = function () {
  this.debugEnabled = true
  return this
}

On.prototype._log = function (message, data) {
  if (this.debugEnabled) {
    if (data) {
      console.log(message, data)
    }
    else {
      console.log(message)
    }
  }
}

On.prototype.eventReceived = function (eventName) {
  this.currentEventNameToRegister = eventName
  this.events.push({
    eventName: eventName,
    type: 'topic'
  })

  this._log('Registered event ' + eventName)

  return this
}

On.prototype.requestReceived = function (eventName) {
  this.currentEventNameToRegister = eventName
  this.events.push({
    eventName: eventName,
    type: 'rpc'
  })

  this._log('Registered request ' + eventName)
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
    this.events[eventIndex].context = this
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
// It will trigger an event on mq
// that will be picked up by the _init* methods.
// Each of those methods subscribe locally to an event of the same name As MQ
On.prototype.init = function () {
  var topics = this._getEvents('topic')
  var queues = this._getEvents('queue')
  var requests = this._getEvents('rpc')

  this.mq.on('disconnected', () => {
    console.log('Disconnected from MQ. Stop listening for events')
    if (topics.length > 0) {
      topics.forEach((topicName) => {
        this.removeAllListeners(topicName)
      })
    }

    if (queues.length > 0) {
      queues.forEach((queueName) => {
        this.removeAllListeners(queueName)
      })
    }

    if (requests.length > 0) {
      requests.forEach((requestName) => {
        this.removeAllListeners(requestName)
      })
    }
  })

  this.mq.on('connected', () => {
    if (topics.length > 0) {
      return this._initTopics(topics)
    }
  })

  this.mq.on('connected', () => {
    if (queues.length > 0) {
      return this._initQueues(queues)
    }
  })

  this.mq.on('connected', () => {
    if (requests.length > 0) {
      this._initRPCRequests(requests)
    }
  })

  return this.mq.connect()
  .catch((error) => {
    console.log('Error on on.js init', error)
    return
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

  topics.forEach((topic) => {
    this.mq.on(topic.eventName, (data) => {
      this._log('Received topic event ' + topic.eventName, data)

      if (this._hasProperties(topic)) {
        this._log('Event has properties', data)
        if (this.validationIsSuccess(topic.eventName, data)) {
          this._log('Validation success')
          return topic.callback(data)
        }
        else {
          throw new Error('Validation failed for event ' + topic.eventName)
        }
      }
      else {
        return topic.callback(data)
      }
    })
  })

  this._log('Listening for topics', topicsNames)
  return this.mq.listenForTopics(topicsNames)
}

On.prototype._hasProperties = function (event) {
  try {
    if (event.properties.length > 0) {
      return true
    }
    else {
      return false
    }
  }
  catch (error) {
    return false
  }
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

  this._log('Listening for queueNames', queueNames)

  queues.forEach((queue) => {
    this.mq.on(queue.eventName, (data) => {
      this._log('Received event on queue ' + queue.eventName, data)
      if (this._hasProperties(queue)) {
        this._log('Queue event has properties ' + queue.eventName, data)

        if (this.validationIsSuccess(queue.eventName, data)) {
          this._log('Validation success for ' + queue.eventName, data)
          return this._onEventReceivedOnQueue(queue, data)
        }
        else {
          throw new Error('Validation failed for event ' + queue.eventName)
        }
      }
      else {
        return this._onEventReceivedOnQueue(queue, data)
      }
    })
  })

  this.mq.consumeFromQueues(queueNames)
}

On.prototype._onEventReceivedOnQueue = function (queue, data) {
  var now = Date.now()
  var jobId = data.tid || now
  var taskName = queue.eventName + '-' + now;

  this._log('Creating redis queue with name ' + queue.eventName)
  this.redisQueue = new Queue(queue.eventName, {
    redis: this.config.redis
  })

  if (queue.dispatchAs) {
    this._log('Queue event is redispatchable')
    this._redispatchToMQ(queue, taskName)
  }
  else {
    this._log('Sending the queue event to redis as task ' + taskName)
    this._sendToRedisQueueToProcess(queue, taskName)
  }

  this.redisQueue.add(taskName, data, {
    jobId: jobId,
    attempts: 0,
    removeOnFail: true
  })

  this.redisQueue.on('error', function (error) {
    console.log(error)
  })
}

On.prototype._sendToRedisQueueToProcess = function (queue, taskName) {
  this._log('Registering task with redis')
  this.redisQueue.process(taskName, (job) => {
    this._log('Processing redis event ' + taskName + ' and executing callback')
    this.redisQueue.close();
    return queue.callback(job.data)
  })
}

On.prototype._redispatchToMQ = function (queue, taskName) {
  this.redisQueue.process(taskName, (job) => {
    var newEventName = queue.dispatchAs
    this._log('Processing redis event ' + taskName + ' and redispatching as ' + newEventName)
    this.redisQueue.close();
    this.mq.dispatchToQueue(newEventName, job.data)
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
