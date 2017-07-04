var Q = require('q');
var amqp = require('amqplib');
var uuid = require('uuid');
var events = require('./events.js')

function RabbitMQ (config) {
  this.connection = null;
  this.EXCHANGE_NAME = config.exchange_name;
  this.RABBITMQ_URL = config.url;
}

RabbitMQ.prototype.connect = function() {
	return amqp.connect(this.RABBITMQ_URL)
  .then((connection) => {
		this.connection = connection;
    return connection;
  })
  .catch((err) => {
		return err
  })
}

RabbitMQ.prototype.disconnect = function() {
  this.connection.close();
}

RabbitMQ.prototype.listen = function(eventsToListenOn) {
  this.connection.createChannel()
  .then((channel) => {
    channel.assertExchange(this.EXCHANGE_NAME, 'topic', {
      durable: false
    });

    channel.assertQueue('', {
      exclusive: true
    })
    .then((q) => {
      this.bindChannelToEachRegisteredEvent(eventsToListenOn, q.queue, channel)
      this.consumeFromQueue(q.queue, channel)
    })
    .catch((err) => {
      console.log(err)
    })
    .done()
  })
  .catch((err) => {
    console.log(err)
  })
  .done()
}

RabbitMQ.prototype.bindChannelToEachRegisteredEvent = function (eventsToListenOn, queue, channel) {
  eventsToListenOn.forEach((eventName) => {
    channel.bindQueue(queue, this.EXCHANGE_NAME, eventName);
  });
}

RabbitMQ.prototype.consumeFromQueue = function (queue, channel) {
  channel.consume(queue, (message) => {
    var topic = message.fields.routingKey;
    var data = {};

    try {
      data = JSON.parse(message.content.toString());
      events.emit(topic, data);
    }
    catch (e) {
      console.log(e)
    }
  }, {noAck: true});
}

module.exports = RabbitMQ;
