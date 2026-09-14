// Barrel for the execution trace subsystem.

const { ExecutionTrace, STATUS } = require('./trace');
const { ExecutionTraceStore } = require('./store');
const events = require('./events');
const serializer = require('./serializer');

module.exports = {
  ExecutionTrace,
  ExecutionTraceStore,
  TRACE_STATUS: STATUS,
  TRACE_EVENTS: events.TRACE_EVENTS,
  CORRELATION_FIELDS: events.CORRELATION_FIELDS,
  createTraceEvent: events.createTraceEvent,
  isCorrelated: events.isCorrelated,
  serializeTrace: serializer.serializeTrace,
  deserializeTrace: serializer.deserializeTrace,
  toActivityStream: serializer.toActivityStream,
  scrub: serializer.scrub,
};
