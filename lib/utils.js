/**
 * Small helpers shared by `lib/on.js`. They carry no state: everything here is
 * a pure function plus the default console logger.
 */

/**
 * Whether an event declares at least one property to validate. Events without
 * a `properties` array (or with an empty one) are not validated at all.
 *
 * @param {object} event registered event
 * @returns {boolean} true when the event declares properties
 */
function hasProperties (event) {
  try {
    return event.properties.length > 0
  }
  catch {
    return false
  }
}

/**
 * Whether a registration modifier found its event. An index of -1 means the
 * event (name + type) was never registered.
 *
 * @param {number} eventIndex index returned by `_getEventIndexByNameAndType`
 * @returns {boolean} true when the event exists
 */
function eventIsDeclaredBeforeCallingRegisterCallback (eventIndex) {
  return eventIndex >= 0
}

/**
 * Legacy node-style callback passed to user actions as their last argument.
 * Kept as a console logger because published actions already call it.
 *
 * @param {Error|null} err error to log
 * @param {*} [result] result to log
 * @returns {void}
 */
function next (err, result) {
  if (err) console.log(err)
  if (result) console.log(result)
}

/**
 * Default logger used when `options.logger` is not provided. It implements the
 * `info`/`error`/`warning` interface `On` expects.
 *
 * @type {{info: Function, error: Function, warning: Function}}
 */
const logger = {
  info (message, data) {
    if (data) {
      return console.log(message, data)
    }

    return console.log(message)
  },

  error (message, data) {
    if (data) {
      return console.error(message, data)
    }

    return console.error(message)
  },

  warning (message, data) {
    if (data) {
      return console.log(message, data)
    }

    return console.log(message)
  },
}

module.exports = {
  hasProperties,
  eventIsDeclaredBeforeCallingRegisterCallback,
  next,
  logger,
}
