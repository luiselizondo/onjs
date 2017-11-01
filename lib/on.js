var Queue = require('bull');
var _ = require('lodash')
var Q = require('q')

function On(mqInstance, options) {
  this.config = options
  this.mq = mqInstance
  this.events = []
  this.currentEventNameToRegister = null
  this.currentEventTypeToRegister = null
  this.debugEnabled = false
}

On.prototype.and = function () {
  return this
}

On.prototype.log = function () {
  console.log('Event ' + this.currentEventNameToRegister + ' registered')

  var eventIndex = this._getEventIndexFromStart(this.currentEventNameToRegister)
  if (eventIndex >= 0) {
    this.events[eventIndex].isLogged = true
  }

  return this
}

On.prototype.eventReceived = function (eventName) {
  this.currentEventNameToRegister = eventName
  this.currentEventTypeToRegister = 'topic'

  var currentEventNames = this.events.map((event) => {
    return event.eventName
  })
  
  if (!this._eventExists(eventName, 'topic')) {
    var redisQueue = new Queue(eventName, {
      redis: this.config.redis
    })

    this.events.push({
      eventName: eventName,
      type: 'topic',
      redisQueue: redisQueue
    })

    this.__log(eventName, 'Registered event ' + eventName + ' and redis queue ' + eventName)
  }
  else {
    this.__log(eventName, 'The event ' + eventName + ' is already registered')
  }

  return this
}

On.prototype.taskReceived = function (taskName) {
  this.currentEventNameToRegister = taskName
  this.currentEventTypeToRegister = 'queue'
  
  this.__log(taskName, 'Registered task ' + taskName)

  if (!this._eventExists(taskName, 'queue')) {
    this.events.push({
      eventName: taskName,
      type: 'queue'
    })

    this.__log(taskName, 'Registered task ' + taskName)
  }
  else {
    this.__log(taskName, 'The task ' + taskName + ' is already registered')
  }

  return this
}

On.prototype.requestReceived = function (eventName) {
  this.currentEventNameToRegister = eventName
  this.currentEventTypeToRegister = 'rpc'

  this.events.push({
    eventName: eventName,
    type: 'rpc'
  })

  this.__log(eventName, 'Registered request ' + eventName)
  return this
}

On.prototype.addToQueue = function () {
  console.log('addToQueue has been deprecated')
  return this
}

On.prototype.respond = function () {
  var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)
  if (eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
    this.events[eventIndex].context = this
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

  var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)

  if (eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
    this._initializeActionsArrayIfItDoesNotExist(eventIndex)
    
    this.events[eventIndex].actions.push(callback)
    this.events[eventIndex].context = this
    return this
  }
  else {
    throw new Error('The event hasn\'t been registered first')
  }
}

function eventIsDeclaredBeforeCallingRegisterCallback (eventIndex) {
  return eventIndex >= 0
}

On.prototype._initializeActionsArrayIfItDoesNotExist = function (eventIndex) {
  if (!this.events[eventIndex].actions || !Array.isArray(this.events[eventIndex].actions)) {
    this.events[eventIndex].actions = []
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
  var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)
  if (eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
    if (!this._eventIsTopic(this.events[eventIndex])) {
      throw new Error('Dispatchable events should be registered as topics. Execute the method onEventReceived instead of onTaskReceived on the event ' + this.currentEventNameToRegister)
    }

    if (this.events[eventIndex].dispatchAs && Array.isArray(this.events[eventIndex].dispatchAs)) {
      this.events[eventIndex].dispatchAs.push(newEventName)
    }
    else {
      this.events[eventIndex].dispatchAs = []
      this.events[eventIndex].dispatchAs.push(newEventName)
    }
    
    return this
  }
  else {
    throw new Error('The event ' + this.currentEventNameToRegister + ' hasn\'t been registered first')
  }
}

On.prototype.withProperties = function (properties) {
  if (!_.isArray(properties)) {
    throw new Error('The properties must be an array')
  }

  var eventIndex = this._getEventIndexByNameAndType(this.currentEventNameToRegister, this.currentEventTypeToRegister)
  if (eventIsDeclaredBeforeCallingRegisterCallback(eventIndex)) {
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
  })

  this.mq.on('connected', () => {
    if (topics.length > 0) {
      console.log('Connected to MQ, initializing topics')
      return this._initTopics(topics)
    }
  })

  this.mq.on('connected', () => {
    if (queues.length > 0) {
      console.log('Connected to MQ, initializing queues')
      return this._initQueues(queues)
    }
  })

  this.mq.on('connected', () => {
    if (requests.length > 0) {
      console.log('Connected to MQ, initializing request listeners')
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
    this.mq.listenAndAnswerRequest(request.eventName, request.actions[0])
  })
}

// Consume events from MQ based on topics pattern
On.prototype._initTopics = function (topics) {
  var topicsNames = topics.map((topic) => {
    return topic.eventName
  })

  topics.forEach((topic) => {
    this.mq.on(topic.eventName, (data) => {
      this.__log(topic.eventName, 'Received topic event ' + topic.eventName, data)

      if (this._hasProperties(topic)) {
        this.__log(topic.eventName, 'Event has properties')

        if (this.validationIsSuccess(topic.eventName, data)) {
          this.__log(topic.eventName, 'Validation success')
          return this._onEventReceived(topic, data)
        }
        else {
          var error = new Error('Validation failed for event ' + topic.eventName)
          error.event = topic
          this.mq.emit('error', error)
          throw error
        }
      }
      else {
        return this._onEventReceived(topic, data)
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
      this.__log(queue.eventName, 'Received event on queue ' + queue.eventName, data)
      if (this._hasProperties(queue)) {
        this.__log(queue.eventName, 'Queue event has properties ' + queue.eventName, data)

        if (this.validationIsSuccess(queue.eventName, data)) {
          this.__log(queue.eventName, 'Validation success for ' + queue.eventName, data)
          return this._onTaskReceived(queue, data)
        }
        else {
          var error = new Error('Validation failed for event ' + queue.eventName)
          error.event = queue
          this.mq.emit('error', error)
          throw error
        }
      }
      else {
        return this._onTaskReceived(queue, data)
      }
    })
  })

  this.mq.consumeFromQueues(queueNames)
}

On.prototype._onTaskReceived = function (task, data) {
  this.__log(task.eventName, 'Executing task callback for task', task)

  return Q.allSettled(task.actions.map(function (action) {
    return action.call(task, data, next)
  }))
  .then((results) => {
    this._log(task.eventName, 'Results of all executions')
    this._log(task.eventName, results)
    jobDone()
  })
}

On.prototype._onEventReceived = function (event, data) {
  this.__log(event.eventName, 'Creating redis queue with name ' + event.eventName)
  
  if (event.dispatchAs && event.dispatchAs.length > 0) {
    this.__log(event.eventName, 'Event is redispatchable')
    this._redispatchToMQ(event, data)
  }
  else {
    this.__log(event.eventName, 'Sending the event to redis as task ' + event.eventName)
    this._sendToRedisQueueToProcess(event, data)
  }
}

On.prototype._redispatchToMQ = function (event, data) {
  var taskName = event.eventName
  var newEventName = event.dispatchAs
  var processName = event.eventName + '-' + data.tid
  var now = Math.trunc(new Date().getTime / 1000)
  var jobId = data.tid || now

  event.redisQueue.process(processName, (job, jobDone) => {
    this.__log(event.eventName, 'Processing redis event ' + taskName + ' and redispatching as ' + newEventName)
    
    event.dispatchAs.forEach(newEventName => {
      this.__log(event.eventName, 'Dispatching to queue on mq as ' + newEventName)
      this.mq.dispatchToQueue(newEventName, job.data)
    })

    this.__log(event.eventName, 'Job done')
    jobDone()
  })

  event.redisQueue.add(processName, data, {
    jobId: data.tid,
    attempts: 0,
    removeOnFail: false,
    timeout: 3000
  })

  event.redisQueue.on('error', err => {
    console.log(err)
  })
}

On.prototype._sendToRedisQueueToProcess = function (event, data) {
  var processName = event.eventName + '-' + data.tid
  var that = this

  this.__log(event.eventName, 'Registering task with redis as process ' + processName)
  
  event.redisQueue.process(processName, (job, jobDone) => {
    this._log(event.eventName, 'Processing redis event ' + event.eventName + ' and executing callback')
    this._log(event.eventName, 'Calling event callback')
    
    return Q.allSettled(event.actions.map(function (action) {
      return action.call(event, data, next)
    }))
    .then((results) => {
      this._log(event.eventName, 'Results of all executions')
      this._log(event.eventName, results)
      jobDone()
    })
  })

  event.redisQueue.add(processName, data, {
    jobId: data.tid,
    attempts: 0,
    removeOnFail: false,
    timeout: 3000
  })

  event.redisQueue.on('error', err => {
    console.log(err)
  })
}

On.prototype.debug = function () {
  this.debugEnabled = true
  return this
}

function log (message, data) {
  if (data) {
    console.log(message, data)
  }
  else {
    console.log(message)
  }
}

On.prototype._log = function (message, data) {
  if (this.debugEnabled) {
    log(message, data)
  }
}

On.prototype.__log = function (eventName, message, data) {
  if (this.debugEnabled) {
    log(message, data)
  }
  else {
    var eventIndex = this._getEventIndex(eventName)
    if (eventIndex >= 0) {
      var event = this.events[eventIndex]
      if (event.isLogged) {
        log(message, data)
      }
    }
  }
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
  var events = this.events.map((element) => {
    return element.eventName
  })
  
  var index = events.indexOf(eventName, -1)
  return index
}

On.prototype._getEventIndexFromStart = function (eventName) {
  var events = this.events.map((element) => {
    return element.eventName
  })
  
  var index = events.indexOf(eventName)
  return index
}

function next (err, result) {
  if (err) console.log(err)
  if (result) console.log(result)
}

On.prototype._eventExists = function (eventName, type) {
  return _.find(this.events, (event) => {
    return event.eventName === eventName && event.type === type
  })
}

On.prototype._getEventByName = function (eventName) {
  return _.find(this.events, (event) => {
    return event.eventName === eventName
  })
}

On.prototype._getEventByName = function (eventName) {
  return _.find(this.events, (event) => {
    return event.eventName === eventName
  })
}

On.prototype._getEventIndexByNameAndType = function (eventName, type) {
  return _.findLastKey(this.events, (event) => {
    return event.eventName === eventName && event.type === type
  })
}

On.prototype._eventIsTopic = function (event) {
  return event.type === 'topic'
}

module.exports = On
