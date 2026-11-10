const { expect } = require('chai')
const EventEmitter = require('events')
const On = require('../../index')

describe('Consumer recovery', function () {
  this.timeout(10000)

  const config = {
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
    const onInstance = new On(Object.assign({}, config, options))
    const state = {
      onInstance: onInstance,
      channels: [],
      reconnectCalls: 0,
      setChannelCalls: [],
      listenCalls: [],
    }
    let resolveReconnect = null

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
      const channel = new EventEmitter()
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
        const resolve = resolveReconnect
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
    const stubs = createStubbedOn({ reconnectOnClose: true })

    stubs.onInstance
      .taskReceived('recoveryQueue')
      .andProcess(function () {})

    await stubs.onInstance.init()

    expect(stubs.listenCalls.length).to.equal(1)

    const deadChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    expect(deadChannel).to.be.an.instanceOf(EventEmitter)

    deadChannel.emit('close')
    // a second close while the first recovery is still in flight must not
    // start another recovery
    deadChannel.emit('close')
    await flush()

    expect(stubs.reconnectCalls).to.equal(1)

    stubs.resolveReconnect()
    await flush()
    stubs.onInstance.mqInstance.emit('reconnected', {})
    await flush()
    await flush()
    await flush()

    expect(stubs.reconnectCalls).to.equal(1)
    expect(stubs.listenCalls.length).to.equal(2)

    const currentChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    expect(currentChannel).to.not.equal(deadChannel)
    expect(stubs.channels.length).to.equal(4)
  })

  it('Should log channel and connection errors even when debug is not enabled', async function () {
    const logged = { info: [], error: [] }
    const logger = {
      info: function (message, metadata) {
        logged.info.push([message, metadata])
      },
      error: function (message, metadata) {
        logged.error.push([message, metadata])
      },
    }

    const stubs = createStubbedOn({ reconnectOnClose: true, logger: logger })
    stubs.onInstance.mqInstance.reconnect = async function () {
      stubs.reconnectCalls++
    }

    await stubs.onInstance.init()

    const channel = stubs.channels[0]
    channel.emit('close')
    await flush()

    stubs.onInstance.mqInstance.emit('error', new Error('connection boom'))

    expect(stubs.onInstance.debugEnabled).to.equal(false)
    expect(logged.error.length).to.be.above(0)
    const messages = logged.error.map((entry) => entry[0])
    expect(messages).to.deep.include('Event channel closed, attempting recovery')
    expect(messages).to.deep.include('Connection error')
    expect(logged.info.length).to.equal(0)
    expect(stubs.reconnectCalls).to.equal(1)
  })

  it('Should not throw on connection error when reconnectOnClose is enabled', async function () {
    const stubs = createStubbedOn({ reconnectOnClose: true })

    await stubs.onInstance.init()

    expect(function () {
      stubs.onInstance.mqInstance.emit('error', new Error('connection boom'))
    }).to.not.throw()
  })

  it('Should keep throwing on connection error when reconnectOnClose is disabled', async function () {
    const stubs = createStubbedOn({ reconnectOnClose: false })

    await stubs.onInstance.init()

    expect(function () {
      stubs.onInstance.mqInstance.emit('error', new Error('connection boom'))
    }).to.throw(/connection boom/)
  })

  it('Should restore listeners directly when a channel dies but the connection is alive', async function () {
    const stubs = createStubbedOn({ reconnectOnClose: true })
    stubs.onInstance.mqInstance.isConnected = true

    stubs.onInstance
      .taskReceived('recoveryQueue')
      .andProcess(function () {})

    await stubs.onInstance.init()

    expect(stubs.listenCalls.length).to.equal(1)

    const deadChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    deadChannel.emit('close')
    await flush()
    await flush()

    // the connection survived, so reconnect() would no-op: listeners must be
    // restored directly on fresh channels without going through reconnect
    expect(stubs.reconnectCalls).to.equal(0)
    expect(stubs.listenCalls.length).to.equal(2)

    const currentChannel = stubs.setChannelCalls[stubs.setChannelCalls.length - 1]
    expect(currentChannel).to.not.equal(deadChannel)
  })

  it('Should run a single recovery when disconnected and close both fire', async function () {
    const stubs = createStubbedOn({ reconnectOnClose: true })

    stubs.onInstance
      .taskReceived('recoveryQueue')
      .andProcess(function () {})

    await stubs.onInstance.init()

    stubs.onInstance.mqInstance.emit('disconnected')
    stubs.onInstance.mqInstance.emit('close')
    await flush()

    expect(stubs.reconnectCalls).to.equal(1)

    stubs.resolveReconnect()
    await flush()
    stubs.onInstance.mqInstance.emit('reconnected', {})
    await flush()
    await flush()

    expect(stubs.reconnectCalls).to.equal(1)
    expect(stubs.listenCalls.length).to.equal(2)
  })

  it('Should log channel loss without reconnecting when recovery is disabled', async function () {
    const logged = { error: [] }
    const logger = {
      info: function () {},
      error: function (message, metadata) {
        logged.error.push([message, metadata])
      },
    }

    const stubs = createStubbedOn({ reconnectOnClose: false, logger: logger })

    await stubs.onInstance.init()

    expect(function () {
      stubs.channels[0].emit('error', new Error('channel boom'))
    }).to.not.throw()
    await flush()

    expect(logged.error.length).to.be.above(0)
    expect(logged.error.map((entry) => entry[0])).to.deep.include('Event channel error, attempting recovery')
    expect(stubs.reconnectCalls).to.equal(0)
  })

  it('Should retry recovery with backoff until the connection comes back', async function () {
    const stubs = createStubbedOn({ reconnectOnClose: true, reconnectRetryDelayMS: 10 })
    const reconnectFailures = 2

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

    expect(stubs.reconnectCalls).to.equal(3)

    stubs.onInstance.mqInstance.emit('reconnected', {})
    await flush()
    await flush()

    expect(stubs.listenCalls.length).to.equal(2)
  })

  it('Should contain a failure raised while recovering', async function () {
    const logged = { error: [] }
    const logger = {
      info: function () {},
      error: function (message, metadata) {
        logged.error.push([message, metadata])
      },
    }

    const stubs = createStubbedOn({ reconnectOnClose: true, logger: logger })

    // the recovery path itself is not the subject here: it fails, and the
    // retry recursion sleeps with the capped exponential backoff (30s once
    // the attempt count grows), so it is turned into a single failing attempt
    // the retry recursion is driven by the test itself (no sleeping), so a
    // single attempt rejection is enough to reach the containment
    let attempts = 0
    stubs.onInstance._attemptRecovery = async function () {
      attempts++
      throw new Error('retry boom')
    }

    const onRejection = (err) => {
      throw err
    }
    process.on('unhandledRejection', onRejection)
    try {
      // without containment the retry rejection would reject this call (and
      // escape as an unhandled rejection from the MQ event handler that calls
      // it) and _isRecovering would stay true, blocking every later recovery
      await stubs.onInstance._recoverFromChannelLoss('Lost channel')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }

    // the recovery was attempted once and the failure was contained
    expect(attempts).to.equal(1)
    expect(stubs.onInstance._isRecovering).to.equal(false)
    const messages = logged.error.map((entry) => entry[0])
    expect(messages).to.deep.include('Recovery failed')
    const recoveryFailure = logged.error.find((entry) => entry[0] === 'Recovery failed')
    expect(recoveryFailure[1]).to.have.property('message', 'retry boom')
  })
})
