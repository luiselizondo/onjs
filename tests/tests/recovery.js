var should = require('should')
var EventEmitter = require('events')
var On = require('../../index')

describe('Consumer recovery', function () {
  this.timeout(10000)

  var config = {
    mq: {
      exchange_name: 'onjs_test',
      delayed_exchange_name: 'onjs_test_delayed',
      url: 'amqp://guest:guest@localhost:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
  }

  function flush () {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  function createStubbedOn (options = {}) {
    var onInstance = new On(Object.assign({}, config, options))
    var state = {
      onInstance: onInstance,
      channels: [],
      reconnectCalls: 0,
      setChannelCalls: [],
      listenCalls: [],
    }
    var resolveReconnect = null

    if (!options.logger) {
      onInstance.logger = {
        info: function () {},
        error: function () {},
      }
    }

    onInstance.mqInstance.connect = async function () {
      return {}
    }

    onInstance.mqInstance.createChannel = async function () {
      var channel = new EventEmitter()
      state.channels.push(channel)
      return channel
    }

    // recovery is deliberately pending until the test resolves it, so the
    // in-flight guard can be exercised deterministically
    onInstance.mqInstance.reconnect = function () {
      state.reconnectCalls++
      return new Promise((resolve) => {
        resolveReconnect = resolve
      })
    }

    state.resolveReconnect = function () {
      if (resolveReconnect) {
        var resolve = resolveReconnect
        resolveReconnect = null
        resolve()
      }
    }

    onInstance.topicInstance = {
      setChannel: function (channel) {
        state.setChannelCalls.push(channel)
      },
      listen: async function () {},
    }

    onInstance.queueInstance = {
      setChannel: function (channel) {
        state.setChannelCalls.push(channel)
      },
      on: function () {},
      listen: async function (queueNames) {
        state.listenCalls.push(queueNames)
      },
      listenManual: async function () {},
    }

    return state
  }

  it('Should recover once and re-register consumers after the consumer channel closes', async function () {
    var stubs = createStubbedOn({ reconnectOnClose: true })

    stubs.onInstance
    .taskReceived('recoveryQueue')
    .andProcess(function () {})

    await stubs.onInstance.init()

    stubs.listenCalls.length.should.equal(1)

    var deadChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    deadChannel.should.be.instanceOf(EventEmitter)

    deadChannel.emit('close')
    // a second close while the first recovery is still in flight must not
    // start another recovery
    deadChannel.emit('close')
    await flush()

    stubs.reconnectCalls.should.equal(1)

    stubs.resolveReconnect()
    await flush()
    stubs.onInstance.mqInstance.emit('reconnected', {})
    await flush()
    await flush()
    await flush()

    stubs.reconnectCalls.should.equal(1)
    stubs.listenCalls.length.should.equal(2)

    var currentChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    currentChannel.should.not.equal(deadChannel)
    stubs.channels.length.should.equal(4)
  })

  it('Should log channel and connection errors even when debug is not enabled', async function () {
    var logged = { info: [], error: [] }
    var logger = {
      info: function (message, metadata) {
        logged.info.push([message, metadata])
      },
      error: function (message, metadata) {
        logged.error.push([message, metadata])
      },
    }

    var stubs = createStubbedOn({ reconnectOnClose: true, logger: logger })
    stubs.onInstance.mqInstance.reconnect = async function () {
      stubs.reconnectCalls++
    }

    await stubs.onInstance.init()

    var channel = stubs.channels[0]
    channel.emit('close')
    await flush()

    stubs.onInstance.mqInstance.emit('error', new Error('connection boom'))

    stubs.onInstance.debugEnabled.should.equal(false)
    logged.error.length.should.be.above(0)
    var messages = logged.error.map((entry) => entry[0])
    messages.should.containEql('Event channel closed, attempting recovery')
    messages.should.containEql('Connection error')
    logged.info.length.should.equal(0)
    stubs.reconnectCalls.should.equal(1)
  })

  it('Should not throw on connection error when reconnectOnClose is enabled', async function () {
    var stubs = createStubbedOn({ reconnectOnClose: true })

    await stubs.onInstance.init()

    ;(function () {
      stubs.onInstance.mqInstance.emit('error', new Error('connection boom'))
    }).should.not.throw()
  })

  it('Should keep throwing on connection error when reconnectOnClose is disabled', async function () {
    var stubs = createStubbedOn({ reconnectOnClose: false })

    await stubs.onInstance.init()

    ;(function () {
      stubs.onInstance.mqInstance.emit('error', new Error('connection boom'))
    }).should.throw(/connection boom/)
  })

  it('Should restore listeners directly when a channel dies but the connection is alive', async function () {
    var stubs = createStubbedOn({ reconnectOnClose: true })
    stubs.onInstance.mqInstance.isConnected = true

    stubs.onInstance
    .taskReceived('recoveryQueue')
    .andProcess(function () {})

    await stubs.onInstance.init()

    stubs.listenCalls.length.should.equal(1)

    var deadChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    deadChannel.emit('close')
    await flush()
    await flush()

    // the connection survived, so reconnect() would no-op: listeners must be
    // restored directly on fresh channels without going through reconnect
    stubs.reconnectCalls.should.equal(0)
    stubs.listenCalls.length.should.equal(2)

    var currentChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    currentChannel.should.not.equal(deadChannel)
  })

  it('Should run a single recovery when disconnected and close both fire', async function () {
    var stubs = createStubbedOn({ reconnectOnClose: true })

    stubs.onInstance
    .taskReceived('recoveryQueue')
    .andProcess(function () {})

    await stubs.onInstance.init()

    stubs.onInstance.mqInstance.emit('disconnected')
    stubs.onInstance.mqInstance.emit('close')
    await flush()

    stubs.reconnectCalls.should.equal(1)

    stubs.resolveReconnect()
    await flush()
    stubs.onInstance.mqInstance.emit('reconnected', {})
    await flush()
    await flush()

    stubs.reconnectCalls.should.equal(1)
    stubs.listenCalls.length.should.equal(2)
  })

  it('Should log channel loss without reconnecting when recovery is disabled', async function () {
    var logged = { error: [] }
    var logger = {
      info: function () {},
      error: function (message, metadata) {
        logged.error.push([message, metadata])
      },
    }

    var stubs = createStubbedOn({ reconnectOnClose: false, logger: logger })

    await stubs.onInstance.init()

    ;(function () {
      stubs.channels[0].emit('error', new Error('channel boom'))
    }).should.not.throw()
    await flush()

    logged.error.length.should.be.above(0)
    logged.error.map((entry) => entry[0]).should.containEql('Event channel error, attempting recovery')
    stubs.reconnectCalls.should.equal(0)
  })

  it('Should retry recovery with backoff until the connection comes back', async function () {
    var stubs = createStubbedOn({ reconnectOnClose: true, reconnectRetryDelayMS: 10 })
    var reconnectFailures = 2

    stubs.onInstance
    .taskReceived('recoveryQueue')
    .andProcess(function () {})

    await stubs.onInstance.init()

    stubs.onInstance.mqInstance.reconnect = function () {
      stubs.reconnectCalls++
      if (stubs.reconnectCalls <= reconnectFailures) {
        return Promise.reject(new Error('broker still down'))
      }
      return Promise.resolve({})
    }

    stubs.channels[0].emit('close')
    // give the two failing attempts (10ms backoff each) time to play out
    await new Promise((resolve) => setTimeout(resolve, 80))

    stubs.reconnectCalls.should.equal(3)

    stubs.onInstance.mqInstance.emit('reconnected', {})
    await flush()
    await flush()

    stubs.listenCalls.length.should.equal(2)
  })
})
