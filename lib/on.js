var Queue = require('bull');

function Wrapper () {

}

Wrapper.prototype = {
  context: null,
  eventName: null,
  callback: null,
  requiredProperties: [],
  isQueueMember: false,
  isDispatchable: false,
  dispatchAsName: null,
  setEventName: function (eventName) {
    this.eventName = eventName
  },
  getEventName: function () {
    return this.eventName
  },
  setProperties: function (properties) {
    this.requiredProperties = properties
  },
  getProperties: function () {
    return this.requiredProperties
  },
  setCallback: function (callback) {
    this.callback = callback
  },
  getCallback: function (data) {
    if (data) return this.callback(data)
    else {
      return this.callback()
    }
  },
  getQueueCallback: function () {
    return this.callback
  },
  getDispatchAsName: function () {
    return this.dispatchAsName
  },
  setAsDispachable: function () {
    this.isDispatchable = true
  },
  setDispatchAsName: function (eventName) {
    this.dispatchAsName = eventName
  },
  setAsQueueMember: function () {
    this.isQueueMember = true
  },
  unsetAsQueueMember: function () {
    this.isQueueMember = false
  }
}

function On(mqInstance, eventsInstance, options) {
  this.config = options
  this.mq = mqInstance
	this.eventsInstance = eventsInstance

  this.registerEvents = function init() {
    this.instances.forEach((instance) => {
      eventsInstance.on(instance.getEventName(), (data) => {
        return instance.getCallback(data)
      })
    })
  }

  this.registerQueueEvents = function inititQueue() {
    this.queueInstances.forEach((instance) => {
      eventsInstance.on(instance.getEventName(), (data) => {
        return handleQueueEvent(instance, data, this.queue, this.mq)
      })
    })
  }

  return this
}

function handleQueueEvent (instance, data, queue, mq) {
  var now = Date.now()
  var jobId = data.tid || now
  var handlerName = instance.getEventName() + '-' + now;

  try {
    queue.add(handlerName, data, {
      jobId: jobId
    })

    if (instance.isDispatchable) {
      var newEventName = instance.getDispatchAsName()
      queue.process(handlerName, function (job, done) {
        mq.dispatchToQueue(newEventName, job.data)
        done()
      })
    }
    else {
      queue.process(handlerName, instance.getQueueCallback())
    }
  }
  catch (error) {
    console.log(error)
  }
}

On.prototype = {
  instances: [],
  queueInstances: []
}

On.prototype.eventReceived = function (eventName) {
  this.instance = new Wrapper()
  this.instance.setEventName(eventName)
  this.instances.push(this.instance)
  return this
}

On.prototype.withProperties = function (properties) {
  this.instance.setProperties(properties)
  return this
}

On.prototype.do = function (callback) {
  this.instance.setCallback(callback)
  this.instance._prototype_ = On.prototype
  this.instance.context = this
  return this
}

On.prototype.validate = function (data) {
  Object.keys(data).forEach(item => {
    if (item.includes(this.instance.getProperties())) {
      return true
    }
    else {
      return false
    }
  })

  return this
}

On.prototype.addToQueue = function () {
  this.instances.pop()
  this.queueInstances.push(this.instance)
  return this
}

On.prototype.andProcess = function (callback) {
  this.instance.setCallback(callback)
  return this
}

On.prototype.dispatchAs = function (newEventName) {
  return this.andDispatchAs(newEventName)
}

On.prototype.andDispatchAs = function (newEventName) {
  this.instance.setAsDispachable()
  this.instance.setDispatchAsName(newEventName)
  return this
}

On.prototype.listen = function () {
  this.registerEvents()
  this.registerQueueEvents()

  this.mq.connect()
  .then(() => {
    this.mq.listen(this.eventsInstance.eventNames())
  })
  .catch((err) => {
    console.log(err)
  })
}

On.prototype.initQueue = function (queueName) {
  this.queue = new Queue(queueName, {
    redis: this.config.redis
  })
}

module.exports = On
