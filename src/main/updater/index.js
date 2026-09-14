// The updater subsystem, as one door in.
//
// `downloadUpdate`, `installNow`, `hasStagedFile`, `updaterState`, `nextState`
// and `percentOf` are ./updater.js — the file that was `src/main/updater.js`
// before this feature moved it in here; nothing about what it does changed,
// only where it lives. Everything else is new: the Smart Update Center layer
// that turns a bare "there is a newer version" into an explained, policy-
// scored, rememberable one.
const core = require('./updater');
const { createUpdateManager, MANAGER_STATES } = require('./update-manager');
const metadata = require('./update-metadata');
const analyzer = require('./update-analyzer');
const policy = require('./update-policy');
const state = require('./update-state');
const events = require('./update-events');

module.exports = {
  ...core,
  createUpdateManager,
  MANAGER_STATES,
  metadata,
  analyzer,
  policy,
  state,
  events,
};
