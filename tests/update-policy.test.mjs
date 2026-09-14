import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyImportance, deriveImportance, policyFor } = require('../src/main/updater/update-policy.js');

const analysis = (over = {}) => ({
  category: 'fix', breakingChanges: false,
  stats: { features: 0, bugFixes: 0, securityFixes: 0 },
  ...over,
});

// --- the priority order when no author opinion exists -------------------------

test('a security fix is CRITICAL above everything else', () => {
  assert.equal(deriveImportance(analysis({ stats: { features: 5, bugFixes: 5, securityFixes: 1 } })), 'CRITICAL');
});

test('a breaking change without a security fix is HIGH', () => {
  assert.equal(deriveImportance(analysis({ breakingChanges: true })), 'HIGH');
});

test('a plain feature release is NORMAL', () => {
  assert.equal(deriveImportance(analysis({ stats: { features: 1, bugFixes: 0, securityFixes: 0 } })), 'NORMAL');
});

test('a bug-fix-only release is NORMAL, not LOW — stability matters', () => {
  assert.equal(deriveImportance(analysis({ stats: { features: 0, bugFixes: 1, securityFixes: 0 } })), 'NORMAL');
});

test('nothing notable at all is LOW', () => {
  assert.equal(deriveImportance(analysis()), 'LOW');
});

// --- explicit author importance is trusted -------------------------------------

test('an explicit "optional" is trusted as LOW even with a feature or two', () => {
  const importance = classifyImportance({
    metadata: { importance: 'optional' },
    analysis: analysis({ stats: { features: 3, bugFixes: 0, securityFixes: 0 } }),
  });
  assert.equal(importance, 'LOW');
});

test('an explicit "critical" is trusted as CRITICAL', () => {
  const importance = classifyImportance({ metadata: { importance: 'critical' }, analysis: analysis() });
  assert.equal(importance, 'CRITICAL');
});

test('with no explicit importance, the derived priority order applies', () => {
  const importance = classifyImportance({ metadata: {}, analysis: analysis({ breakingChanges: true }) });
  assert.equal(importance, 'HIGH');
});

// --- the one floor: a security fix is never shown as less than HIGH ----------

test('a security fix floors an explicit "optional" up to HIGH', () => {
  const importance = classifyImportance({
    metadata: { importance: 'optional' },
    analysis: analysis({ stats: { features: 0, bugFixes: 0, securityFixes: 1 } }),
  });
  assert.equal(importance, 'HIGH');
});

test('a security fix does not downgrade an explicit "critical"', () => {
  const importance = classifyImportance({
    metadata: { importance: 'critical' },
    analysis: analysis({ stats: { features: 0, bugFixes: 0, securityFixes: 1 } }),
  });
  assert.equal(importance, 'CRITICAL');
});

// --- the mapping back to policy words ------------------------------------------

test('policyFor maps every importance level back to its policy word', () => {
  assert.equal(policyFor('LOW'), 'optional');
  assert.equal(policyFor('NORMAL'), 'recommended');
  assert.equal(policyFor('HIGH'), 'important');
  assert.equal(policyFor('CRITICAL'), 'critical');
});

test('an unknown importance falls back to the lowest policy rather than throwing', () => {
  assert.equal(policyFor('nonsense'), 'optional');
});
