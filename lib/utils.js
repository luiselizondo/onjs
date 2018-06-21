function hasProperties (event) {
  try {
    if (event.properties.length > 0) {
      return true
    }
    else {
      return false
    }
  }
  catch (error) {
    return false
  }
}

function eventIsDeclaredBeforeCallingRegisterCallback (eventIndex) {
  return eventIndex >= 0
}

function next (err, result) {
  if (err) console.log(err)
  if (result) console.log(result)
}

var logger = {
  info: function (message, data) {
    if (data) {
      return console.log(message, data)
    }

    return console.log(message)
  },

  error: function (message, data) {
    if (data) {
      return console.error(message, data)
    }

    return console.error(message)
  },

  warning: function (message, data) {
    if (data) {
      return console.log(message, data)
    }

    return console.log(message)
  }
}

module.exports = {
  hasProperties,
  eventIsDeclaredBeforeCallingRegisterCallback,
  next,
  logger
}