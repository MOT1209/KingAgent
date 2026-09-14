// Context layers: where a piece of context came from, and which one wins.
//
// Context is not one bag of strings. The same key ("constraints", "model",
// "cwd") can be set platform-wide, per project, per workspace, per agent, per
// task, per step and per tool call, and the *narrowest* setting has to win —
// otherwise a global default silently overrides what a step just decided.
//
// So layers are ordered, resolution walks narrow → broad, and a merged view is
// built once rather than recomputed per lookup. Nothing here decides what the
// model sees; selector.js and budget.js do that. This only decides what the
// *value* of something is.

const LAYERS = Object.freeze({
  GLOBAL: 'global',
  SESSION: 'session',
  PROJECT: 'project',
  WORKSPACE: 'workspace',
  AGENT: 'agent',
  TASK: 'task',
  STEP: 'step',
  TOOL: 'tool',
});

// Broad → narrow. A later layer overrides an earlier one.
const LAYER_ORDER = Object.freeze([
  LAYERS.GLOBAL, LAYERS.SESSION, LAYERS.PROJECT, LAYERS.WORKSPACE,
  LAYERS.AGENT, LAYERS.TASK, LAYERS.STEP, LAYERS.TOOL,
]);

const LAYER_RANK = Object.freeze(Object.fromEntries(LAYER_ORDER.map((l, i) => [l, i])));

function isLayer(l) {
  return typeof l === 'string' && l in LAYER_RANK;
}

function assertLayer(l) {
  if (!isLayer(l)) throw new Error(`unknown context layer "${l}"`);
  return l;
}

function createLayerStack(seed = {}) {
  const layers = new Map(LAYER_ORDER.map((l) => [l, new Map()]));
  for (const [layer, values] of Object.entries(seed)) {
    if (!isLayer(layer) || !values) continue;
    for (const [k, v] of Object.entries(values)) layers.get(layer).set(k, v);
  }

  return {
    set(layer, key, value) {
      layers.get(assertLayer(layer)).set(key, value);
      return this;
    },
    setAll(layer, values) {
      const target = layers.get(assertLayer(layer));
      for (const [k, v] of Object.entries(values || {})) target.set(k, v);
      return this;
    },
    // Narrowest wins.
    get(key) {
      for (let i = LAYER_ORDER.length - 1; i >= 0; i -= 1) {
        const m = layers.get(LAYER_ORDER[i]);
        if (m.has(key)) return m.get(key);
      }
      return undefined;
    },
    // Which layer actually supplied the value — the thing you need when a
    // setting is not what you expected.
    origin(key) {
      for (let i = LAYER_ORDER.length - 1; i >= 0; i -= 1) {
        if (layers.get(LAYER_ORDER[i]).has(key)) return LAYER_ORDER[i];
      }
      return null;
    },
    has(key) {
      return this.get(key) !== undefined;
    },
    layer(layer) {
      return Object.fromEntries(layers.get(assertLayer(layer)));
    },
    keys() {
      const out = new Set();
      for (const m of layers.values()) for (const k of m.keys()) out.add(k);
      return [...out].sort();
    },
    // Flattened view, broad first so narrow overwrites.
    merge() {
      const out = {};
      for (const layer of LAYER_ORDER) {
        for (const [k, v] of layers.get(layer)) out[k] = v;
      }
      return out;
    },
    // What each key resolved to and from where — the debugging view, and what a
    // context packet carries so a run can be explained after the fact.
    explain() {
      return this.keys().map((key) => ({ key, layer: this.origin(key), value: this.get(key) }));
    },
    clear(layer) {
      if (layer) { layers.get(assertLayer(layer)).clear(); return this; }
      for (const m of layers.values()) m.clear();
      return this;
    },
    toJSON() {
      return Object.fromEntries(LAYER_ORDER.map((l) => [l, Object.fromEntries(layers.get(l))]));
    },
  };
}

module.exports = { LAYERS, LAYER_ORDER, LAYER_RANK, isLayer, assertLayer, createLayerStack };
