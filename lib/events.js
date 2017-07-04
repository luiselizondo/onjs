const EventEmitter = require('events');
class MyEmitter extends EventEmitter {}
const events = new MyEmitter();

module.exports = events
