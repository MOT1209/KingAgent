// Barrel for agent-to-agent messaging.

const { AgentMessageBus, MessageDeliveryError } = require('./bus');
const message = require('./message');

module.exports = {
  AgentMessageBus,
  MessageDeliveryError,
  MESSAGE_TYPES: message.MESSAGE_TYPES,
  ALL_MESSAGE_TYPES: message.ALL_MESSAGE_TYPES,
  validateMessage: message.validateMessage,
  normalizeMessage: message.normalizeMessage,
  replyTo: message.replyTo,
};
