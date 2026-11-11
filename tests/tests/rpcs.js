const { expect } = require('chai')
const On = require('../../index')
const EventEmitter = require('events')
class Events extends EventEmitter {}
const MQ = require('rabbitmq-lib').MQ
const RPC = require('rabbitmq-lib').RPC

const REDIS_PORT = 6379

describe('RPC', function () {
  this.timeout(10000)

  const config = {
    mq: {
      exchange_name: 'onjs_test',
      url: 'amqp://rabbitmq:rabbitmq@rabbitmq:5672/',
      connectMaxAttempts: 1,
      delayMS: 10,
    },
    redis: {
      port: REDIS_PORT,
      host: 'redis',
    },
    reconnectOnClose: false,
  }

  const mq = new MQ(config.mq)
  const sender = new RPC()
  const on = new On(config)
  on.debug()

  before(async function () {
    await mq.connect()
    
    const connection = await mq.connect()
    return sender.setConnection(connection)
  })

  after(async function () {
    return await mq.disconnect()
  })

  afterEach(async function () {
    return await on.tearDown()
  })

  it('Should execute a queue event', async function () {
    function execution (input, next) {
      let response
      if (input.name === 'Batman') {
        response = {
          name: 'Batman',
          superpower: 'None',
        }
      }

      return next(false, response)
    }

    on
      .requestReceived('getSuperhero')
      .withProperties(['name'])
      .respond()
      .afterExecuting(execution)

    await on.init()

    const data = await sender.send('getSuperhero', {
      name: 'Batman',
    })
    
    const result = JSON.parse(data)
    expect(result).to.have.property('results')
    expect(result).to.have.property('type', 'success')
    expect(result.results).to.have.property('name', 'Batman')
    expect(result.results).to.have.property('superpower', 'None')
  })
})
