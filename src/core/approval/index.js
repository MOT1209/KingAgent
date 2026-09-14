// Barrel for the human-approval subsystem.

const { ApprovalManager, TOOL_ACTIONS } = require('./manager');
const request = require('./request');

module.exports = {
  ApprovalManager,
  TOOL_ACTIONS,
  APPROVAL_STATUS: request.APPROVAL_STATUS,
  RISK: request.RISK,
  DANGEROUS_ACTIONS: request.DANGEROUS_ACTIONS,
  DEFAULT_TTL_MS: request.DEFAULT_TTL_MS,
  createApprovalRequest: request.createApprovalRequest,
  requiresApproval: request.requiresApproval,
};
