# On.js

Helper utility to handle and keep control of events on a microservices arquitecture handled by MQ.

## Usage

```
var RabbitMQ = require('./lib/on/RabbitMQ')
var On = require('./lib/on/on.js')

var RABBITMQ_URL = process.env.RABBITMQ_URL;
var EXCHANGE_NAME = 'exchange-' + process.env.NODE_ENV;
var REDIS_HOST = process.env.REDIS_HOST
var REDIS_PORT = process.env.REDIS_PORT

var options = {
  mq: {
    url: RABBITMQ_URL,
    exchange_name: EXCHANGE_NAME
  },
  redis: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
}

var on = new On(RabbitMQ, options)

on
  .eventReceived('content.updated')
  .withProperties(['body', 'account'])
  .do(function (data) {
    // Do something with data
  })

on
  .eventReceived('content.updated')
  .withProperties(['body', 'account'])
  .do(function (data) {
    // Do something with data or dispatch it to the queue

    this.context.mq.dispatchToQueue('someOtherEvent', {
      contentId: data.body.id,
      userId: data.account.id
    })
  })

on
  .eventReceived('account.updated')
  .withProperties(['accountUpdated'])
  .addToQueue()
  .andProcess(function (data) {
    // This callback will be executed as part of the queue process
    // console.log(data.accountUpdated)
  })

on.listen(options)
on.initQueue(someQueueName)

```

# MQ Dependency
The module has a dependency on a MQ class that handles the communication with MQ. In theory any kind of service with MQ should work as long as the communication with MQ is abstracted. The methods needed in the constructor are:

```
connect()
emit(eventName, data)
dispatchToQueue(queueName, data)
listen(arrayOfTopicsToListenOn)
consumeFromQueue(arrayOfTasksToConsume)
```
