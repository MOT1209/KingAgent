// Barrel for the context subsystem.
//
// `buildTaskContext` (the Phase 2 immutable task-context snapshot the
// AgentRuntime takes as `contextBuilder`) is re-exported unchanged. The
// ContextManager is the Phase 3 layer above it: layered, selected, budgeted and
// frozen into an addressable packet.

const { buildTaskContext, summarizeContext } = require('./context');
const { ContextManager } = require('./manager');
const layers = require('./layers');
const selector = require('./selector');
const budget = require('./budget');
const packet = require('./packet');

module.exports = {
  buildTaskContext,
  summarizeContext,
  ContextManager,
  LAYERS: layers.LAYERS,
  LAYER_ORDER: layers.LAYER_ORDER,
  createLayerStack: layers.createLayerStack,
  RELEVANCE: selector.RELEVANCE,
  KIND_PRIORITY: selector.KIND_PRIORITY,
  select: selector.select,
  classify: selector.classify,
  createBudget: budget.createBudget,
  trimText: budget.trimText,
  estimateTokens: budget.estimateTokens,
  PACKET_VERSION: packet.PACKET_VERSION,
  createContextPacket: packet.createContextPacket,
  serializePacket: packet.serializePacket,
  deserializePacket: packet.deserializePacket,
  summarizePacket: packet.summarizePacket,
  packetDigest: packet.packetDigest,
};
