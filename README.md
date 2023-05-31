# On.js

Helper utility to handle and keep control of events on RabbitMQ.

Version 2 deprecates serveral APIs

# API

### Registering events

The first step is to register the name of the event. The type of event will be determined by the methods you chain after you register the event

```
on.eventReceived(eventName: string)
```

### Topics

The pattern of listening to a topic exchange is described at https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html

To achieve this on On.js you have to register the event, declare the properties you're expecting to receive so validation executes and then execute a callback

On.js uses it's own local Redis based queue to order to avoid duplicates if multiple services listen to the same event

On.js provides two options for working with topics. Processing and Dispatching

Processing means that the task will be added to the queue and processed as soon as the queue determines that it can start processing it.

Dispatching means that the task will be added to the queue but instead of being processed, it will be sent to MQ with another name.

```
on
	.eventReceived(eventName: string)
	.withProperties(properties: array)
	.do(callback: function)

```

#### Processing

```
on
	.eventReceived(eventName: string)
	.withProperties(properties: array)
	.andProcess(callback: function)
```

Any event received with the name registered on ```eventReceived``` will be added to the queue and then the callback defined on ```andProcess``` will be executed by the queue.

#### Dispatching

```
on
	.eventReceived(eventName: string)
	.withProperties(properties: array)
	.andDispatchAs(eventName: string)
```

Any event received with the name registered on ```eventReceived``` will be added to the queue and dispatched to MQ with the same data as received but with the name defined on the method ```andDispatchAs```

### Queues

The pattern of listening to work queues is described at https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html

This are tasks that will be executed by a queue

```
on
	.taskReceived(eventName: string)
	.withProperties(properties: array)
	.do(eventName: string)
```
### Delayed Queues

The pattern of listening to work queues is described at https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html
This type of queues require the rabbitmq-delayed-message-exchange plugin

The task will arrive at the queue with a set delay

```
on
	.taskReceived(eventName: string, options: { isDelayed: boolean})
	.withProperties(properties: array)
	.do(eventName: string)
```

### RPC Requests
The pattern of listening to RPC requests described at https://www.rabbitmq.com/tutorials/tutorial-six-javascript.html

On.js will order MQ to start listening for events registered and the callback registered will be executed by MQ and the results sent to the client who requested the data.

```
on
	.eventReceived(eventName: string)
	.withProperties(properties: array)
	.respond()
	.afterExecuting(callback: function)
```

The response will be a JSON string so you will have to parse it. The type of response will be determined by the property 'type' since an error in this context means an error with the connection of MQ and not with the execution of the callback.

### Init

To initialize initialize a new instance and then call .init()

```
var options = {
	redis: {
		host: REDIS_HOST,
		port: REDIS_PORT
	},
	mq: {
		url: RABBITMQ_URL,
  	exchange_name: EXCHANGE_NAME
	},
	logger: new Logger()
}

Logger must be an instance of your logger, the logger must have the following methods 'info', 'error' and 'warning'

var on = new On(options)
on.init()
```

## Usage Example

```
var RabbitMQ = require('rabbitmq-lib')
var On = require('./lib/on/on.js')

var RABBITMQ_URL = process.env.RABBITMQ_URL;
var EXCHANGE_NAME = 'exchange-' + process.env.NODE_ENV;
var REDIS_HOST = process.env.REDIS_HOST
var REDIS_PORT = process.env.REDIS_PORT

var options = {
	redis: {
		host: REDIS_HOST,
		port: REDIS_PORT
	}
}

var mqOptions = {
	exchange_name: 'onjs_test',
	url: 'amqp://rabbitmq:rabbitmq@127.0.0.1:5672/'
}

var mq = new MQ(mqOptions)
var on = new On(mq, options)

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
	.andProcess(function (data) {
		// This callback will be executed as part of the queue process
		// console.log(data.accountUpdated)
	})

on
	.eventReceived('account.updated')
	.withProperties(['accountUpdated'])
	.andDispatchAs('newEventName')

on
	.requestReceived('someRequest')
	.withProperties(['userId'])
	.respond()
	.afterExecuting(actions.doSomethingAndReturnToRequester)

on.init()

```

# Debugging and Logging
Running 

```
on.debug()
```

will enable all logging. If you only want to enable one particular event to have logging, you can do it as well by calling the .log method on a particular event:

```
on
	.requestReceived('someRequest')
	.withProperties(['userId'])
	.respond()
	.afterExecuting(actions.doSomethingAndReturnToRequester)
	.and()
	.log()
```

# MQ Dependency
The module has a dependency on a MQ class that handles the communication with MQ. In theory any kind of service with MQ should work as long as the communication with MQ is abstracted. The methods needed in the constructor are:

```
connect()
disconnect()
publish(eventName, data)
publishToTopic(eventName, data)
dispatchToQueue(queueName, data)
listenForTopics(arrayOfTopicsToListenOn)
consumeFromQueues(arrayOfTasksToConsume)
sendRequest(requestName, data)
listenAndAnswerRequest(requestName, callback)
```

# Troubleshooting
One of the most common errors is to trigger a topic event and expect an event on a queue or any problem related to moving events between topics and queues.

So if you receive an event that is a topic event, and you want to send that event to a queue, you'll need to do it manually. To do this, execute a callback and inside call this.context.mq.publish() or this.context.mq.dispatchToQueue() depending on what you want.

You can always bypass on.js and use the MQ instance as an EventEmitter since it inherits from the Node.js EventEmitter class. Just use mq.emit() or mq.on('someEvent')

# License

(The MIT License)

Copyright &copy; 2016 Luis Elizondo <lelizondo@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
