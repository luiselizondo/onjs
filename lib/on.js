var events = require('./events.js')
var RabbitMQ = require('./RabbitMQ.js');

function On() {
  return this
}

On.prototype = {
  requiredValues: [],
  eventName: null
}

On.prototype.withProperties = function (properties) {
  this.requiredValues = properties
  return this
}

On.prototype.eventReceived = function (eventName) {
  this.eventName = eventName
  return this
}

On.prototype.do = function (callback) {
  events.on(this.eventName, (data) => {
    return callback(data)
  })
}

On.prototype.validate = function (data) {
  Object.keys(data).forEach(item => {
    if (item.includes(this.requiredValues)) {
      return true
    }
    else {
      return false
    }
  })

  return this
}

On.prototype.listen = function (config) {
  var rabbit = new RabbitMQ(config);

  rabbit.connect()
  .then(() => {
    rabbit.listen(events.eventNames())
  })
  .catch((err) => {
    console.log(err)
  })
}

module.exports = On
