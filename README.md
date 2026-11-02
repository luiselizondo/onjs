# onjs

Event library on top of RabbitMQ that gives you control over **topics**, **work queues** and **RPC**, plus a
redis (bullmq) layer that deduplicates processing across processes.

- **Version:** 3.0.0
- **Runtime:** Node.js **>= 22** (CommonJS, `require()`)
- **Broker:** RabbitMQ (via [`rabbitmq-lib`](https://www.npmjs.com/package/rabbitmq-lib) `^3.0.0`)
- **Dedup layer:** Redis via `bullmq` (`^5`), connection made with `ioredis` style options

```sh
npm install onjs
```

```js
const On = require('onjs')
```

The module exports the `On` class itself (`module.exports = On`).

## Contents

- [How registration works](#how-registration-works)
- [Event types](#event-types)
- [Topics](#topics)
- [Queues](#queues)
- [Delayed queues](#delayed-queues)
- [RPC requests](#rpc-requests)
- [Configuration](#configuration)
- [Redis / bullmq behaviour](#redis--bullmq-behaviour)
- [Lifecycle: `init()` and `tearDown()`](#lifecycle-init-and-teardown)
- [Error handling](#error-handling)
- [Logging](#logging)
- [rabbitmq-lib 3.x notes](#rabbitmq-lib-3x-notes)
- [Migrating from v2](#migrating-from-v2)

---

## How registration works

Registration is fluent and takes two steps:

1. **Declare** the event with one of the four `*Received` methods. The method decides the type.
2. **Complete** it with a callback (`do`, `andProcess`, `afterExecuting`) or with a redispatch
   (`andDispatchAs` / `sendToQueue`), optionally chaining the modifiers `withProperties()`,
   `ackAfterProcessing()` and `respond()`.

The RabbitMQ connection is not opened until `init()`. Redis is different: `eventReceived()` creates the
bullmq queue at registration time, and that queue opens its Redis connection right away (bullmq does not use
ioredis `lazyConnect`). Listeners and jobs only start flowing after `init()` publishes through.

```js
const on = new On(config)

on
  .eventReceived('order.created')
  .withProperties(['id', 'total'])
  .do(handleOrder)

await on.init()
```

Every method returns `this`, so chains can be split across lines or statements.

## Event types

| Type | Declared with | Callback | Dedup |
| --- | --- | --- | --- |
| `topic` | `eventReceived(name)` | `do(cb)` | Yes — Redis queue, one execution per message id |
| `topic` | `broadcastReceived(name)` | `do(cb)` | No — every process executes the event |
| `queue` | `taskReceived(name)` | `do(cb)` / `andProcess(cb)` | No — RabbitMQ work queue |
| `delayedQueue` | `taskReceived(name, { isDelayed: true })` | `do(cb)` / `andProcess(cb)` | No |
| `rpc` | `requestReceived(name)` | `respond().afterExecuting(cb)` | No |

Registering the same name with the same type twice throws. `eventReceived` and `broadcastReceived` both
register a `topic`, so a name can only be used by one of them.

## Topics

Topics use a topic exchange (`options.mq.exchange_name`). There are two ways to consume them.

### `eventReceived` — processed once through Redis

```js
on
  .eventReceived('order.created')
  .withProperties(['id', 'total'])
  .do(async function (data) {
    // one process handles this message, whichever picks the job up
  })
```

- Requires `options.redis`; `eventReceived()` throws immediately when it is missing.
- The message is added to a bullmq queue named after the event, with `jobId = data.tid`. A redelivered
  message (same `tid`) does not create a second job, so the callback runs **once** even with several
  processes listening.
- Validation runs before the message is queued: when declared properties are missing, the instance emits
  `'error'` and the handler rejects.

### `broadcastReceived` — executed by every listener

```js
on
  .broadcastReceived('config.updated')
  .do(async function (data) {
    // every process executes this, no Redis involved
  })
```

No Redis and no deduplication: each process that subscribed executes the callback with the received data.

### `andDispatchAs` / `sendToQueue` — redispatch a topic into a queue

```js
on
  .eventReceived('order.created')
  .withProperties(['id'])
  .andDispatchAs('order.persist')

on
  .broadcastReceived('config.updated')
  .sendToQueue('config.reload') // legacy alias of andDispatchAs
```

A received topic message is deduplicated through Redis (same `jobId = data.tid` rule) and then published to
each destination queue name registered with `andDispatchAs`. Call it more than once to fan out to several
queues. The destination sends are awaited sequentially, and each one is logged. A failed send is logged and
does **not** fail the job: the worker catches it and the job completes regardless, so check your logs if a
destination did not receive the message. It throws when the current event is not a `topic`.

Combine it with a queue task in the same process:

```js
on.eventReceived('order.created').andDispatchAs('order.persist')
on.taskReceived('order.persist').andProcess(saveOrder)
```

Note that `andDispatchAs` **replaces** processing: a topic registered for redispatch does not call a local
`do()` callback.

## Queues

Work queues use the default exchange. `taskReceived` declares the task; `do` and `andProcess` are aliases.

```js
on
  .taskReceived('order.persist')
  .withProperties(['id'])
  .andProcess(async function (data) {
    // consume the task
  })
```

### Acknowledgement mode (`ackMode`)

The default mode (`ackMode` unset) is **automatic acknowledgement**: the message is acked as soon as it is
delivered, so handlers run concurrently and a task that fails — or a container that crashes mid-task — is
not redelivered. This is the legacy behaviour.

`.ackAfterProcessing()` switches the task to **manual acknowledgement** (`ackMode: 'manual'`):

```js
on
  .taskReceived('order.persist')
  .withProperties(['id'])
  .ackAfterProcessing()
  .andProcess(async function (data) {
    // awaited; acked only after this resolves
  })
```

- The registered actions are awaited and the message is acknowledged only after they all succeed.
- Consumers run on a **dedicated channel** with `prefetch 1` / global prefetch, so the broker holds the next
  delivery and the service processes one manual-ack task at a time. Unacknowledged messages are redelivered
  if the process crashes.
- If an action fails, the message is dropped **without requeueing** — the publisher is expected to send the
  task again when the work is requested once more. The failure is logged and rethrown from the consumer.
- Manual ack is only supported on regular `queue` events; calling it after `taskReceived(..., { isDelayed: true })`,
  `eventReceived()` or `requestReceived()` throws. Registering several manual-ack queues keeps one task in
  flight across all of them (one shared prefetch window on their channel).

Auto-ack tasks and delayed queues share the default queue channel; manual-ack tasks never throttle them.

## Delayed queues

Delayed queues use the `x-delayed-message` exchange and require the
[`rabbitmq-delayed-message-exchange`](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) plugin on
the broker.

```js
on
  .taskReceived('order.expire', { isDelayed: true })
  .withProperties(['id'])
  .andProcess(async function (data) {
    // delivered after the publisher's delay
  })
```

- `options.mq.delayed_exchange_name` must be set. When it is empty, registering a delayed task throws; an
  explicitly empty string (`''`) is treated as "not configured".
- A delayed task is a `delayedQueue` event and cannot use `ackAfterProcessing()`.

## RPC requests

RPC uses the reply-to pseudo-queue from `rabbitmq-lib`. Declare the request with `requestReceived`, mark it as
the consumer with `respond()`, and attach the reply callback with `afterExecuting()`:

```js
on
  .requestReceived('order.status')
  .withProperties(['id'])
  .respond()
  .afterExecuting(async function (data, next) {
    const order = await findOrder(data.id)
    await next(false, { id: order.id, status: order.status })
  })
```

The callback signature is `(data, next)`:

- `next(false, result)` replies `{ type: 'success', results: result }`
- `next(err)` replies `{ type: 'error', error: err }`
- `next(false, null)` / `next()` replies `{ type: 'error', error: 'No data found' }`

The reply is JSON, so a client has to parse it and check its `type` field. In a reply, `type: 'error'` means
the **request** failed or returned no data — it is not an MQ connection error. `respond()` only sets the On
instance as the event context; it does not change the callback signature.

## Configuration

```js
const On = require('onjs')

const on = new On({
  mq: {
    url: 'amqp://user:pass@localhost:5672/',
    exchange_name: 'my-service',
    // required only for delayed queues
    delayed_exchange_name: 'my-service.delayed',
    // optional, rabbitmq-lib defaults apply
    connectMaxAttempts: 600,
    delayMS: 10000
  },
  redis: {
    host: 'localhost',
    port: 6379
  },
  logger: {
    info: console.log,
    error: console.error,
    warning: console.warn
  },
  reconnectOnClose: true
})
```

| Option | Type | Description |
| --- | --- | --- |
| `mq` | `object` | Connection and declaration options, passed to `rabbitmq-lib`'s `MQ`/`Queue`/`Topic` |
| `mq.url` | `string` | AMQP url, e.g. `amqp://user:pass@host:5672/` |
| `mq.exchange_name` | `string` | Exchange used for `topic` events |
| `mq.delayed_exchange_name` | `string` (optional) | `x-delayed-message` exchange for `delayedQueue` events |
| `mq.connectMaxAttempts` | `number` (optional) | Connection attempts before giving up (`rabbitmq-lib` default: 600) |
| `mq.delayMS` | `number` (optional) | Delay between connection attempts (`rabbitmq-lib` default: 10000) |
| `redis` | `object` (optional) | Redis connection for the bullmq layer — **required** by `eventReceived()` |
| `redis.host` | `string` | Redis host |
| `redis.port` | `number` | Redis port |
| `logger` | `object` (optional) | Logger with `info`, `error` and `warning`; defaults to the console logger |
| `reconnectOnClose` | `boolean` (optional) | Reconnect when the MQ connection closes. Default `true` |

`redis` is passed to bullmq as `{ connection: { host, port } }`, i.e. an ioredis style connection object —
not a connection string or an existing ioredis client.

`reconnectOnClose` also reconnects when someone closes the MQ connection directly. Set it to `false` if you
manage reconnection yourself; `tearDown()` always disables it before closing.

## Redis / bullmq behaviour

The dedup layer is bullmq, and its settings are deliberate:

| Setting | Value | Effect |
| --- | --- | --- |
| `jobId` | `data.tid` | Same message id executes once — redeliveries do not create a second job |
| `attempts` | `1` | No retries; a failure is left for inspection instead of being retried automatically |
| `removeOnComplete` | `false` | Completed jobs are retained |
| `removeOnFail` | `false` | Failed jobs are retained |
| `lockDuration` | `3000` (ms) | **Stall detection**, not a per-job timeout |

`lockDuration: 3000` replaces bull's per-job `timeout` (which has no bullmq equivalent). It is the window in
which the worker must renew the job lock; a job whose worker holds it longer without renewing is considered
stalled and redelivered. A long-running callback is **not** aborted at 3 seconds.

One bullmq worker is created per topic event, on the first message, and reused afterwards (bullmq has one
worker per queue, not one processor per job). The Redis queue is created at registration (opening its Redis
connection immediately); the worker is created on the first message. Both are closed by `tearDown()`.

## Lifecycle: `init()` and `tearDown()`

```js
await on.init()      // connect, wire reconnection, start every listener
await on.tearDown()  // close Redis queues/workers and the MQ connection
```

`init()` returns the established MQ connection. It creates the topic subscription first, then the queue
channel (auto-ack and delayed consumers), the dedicated manual-ack channel, and finally the RPC listeners.
Each event type is only wired when at least one event of that type is registered.

`tearDown()` stops listeners, closes each registered event's bullmq queue and worker, and closes the MQ
connection. It never throws: already-closed resources are logged and skipped, it is safe before `init()` and
safe to call more than once.

## Error handling

`On` extends `EventEmitter`.

- **Validation failures** — a payload missing the properties declared with `withProperties()` emits
  `'error'` on the On instance (with `error.event` set to the registered event) before the handler rejects.
  Attach a listener, otherwise Node treats the emitted `'error'` as unhandled and throws:

  ```js
  on.on('error', (err) => {
    console.error('onjs error:', err.message)
  })
  ```

- **MQ connection errors** — the `'error'` handler installed by `init()` rethrows the connection error
  **from the EventEmitter handler**; enable debug logging to also see it logged. That is deliberate (flag 14):
  throwing inside a listener is a process-fatal crash, because a connection that cannot be established is not
  recoverable for a consumer, and silently swallowing it would leave the service running without receiving
  events. Only the `close` handler reconnects, when `reconnectOnClose` is enabled.
- **Redis errors** are logged (when debug/logging is on) and do not crash the process.
- **Manual-ack task failures** are logged and rethrown from the consumer, which drops the message without
  requeueing.

## Logging

```js
on.debug() // log everything through options.logger
```

To log a single event, chain `.log()` on it:

```js
on.requestReceived('order.status').log().respond().afterExecuting(getStatus)
```

`.and()` is a no-op that only exists to keep a chain readable between two callbacks:

```js
on.eventReceived('order.created').do(firstHandler).and().do(secondHandler)
```

## rabbitmq-lib 3.x notes

`onjs` 3.0 depends on `rabbitmq-lib` `^3.0.0` and inherits its upgrade constraints:

- **Node.js >= 22 required** (was Node 8). Both packages are CommonJS.
- **`frameMax=131072` is appended to the AMQP URL** by `MQ` when the URL does not already set it. RabbitMQ
  4.x enforces a minimum frame size and amqplib's default would otherwise drop the connection mid-handshake;
  older brokers negotiate the frame size down. No action needed on your side.
- **`MQ.connect()` rejects** after emitting `error` instead of resolving `undefined`; `reconnect()` propagates
  that rejection. `on.init()` awaits `connect()`, so a failed startup rejects `init()` as well.

## Migrating from v2

- RPC requests are declared with **`requestReceived`** (not `eventReceived`), and the callback receives
  `(data, next)` — reply with `next(err, result)`.
- The old "call `this.context.mq.dispatchToQueue()` inside a callback" recipe is gone. Redispatch with
  `andDispatchAs()` / `sendToQueue()`; for anything else the On instance exposes `mqInstance`,
  `queueInstance` and `topicInstance` from `rabbitmq-lib`.
- `.log()`, `.and()`, `.debug()` and `reconnectOnClose` are unchanged.
- Node.js 22 or newer is required, and `eventReceived()` now requires `options.redis`.

## License

(The MIT License)

Copyright &copy; 2016 Luis Elizondo <lelizondo@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the 'Software'), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
