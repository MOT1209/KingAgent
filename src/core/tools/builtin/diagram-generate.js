// diagram:generate — turn a small, typed node/edge description into a
// self-contained HTML+SVG diagram an agent can hand back as an artifact.
//
// Inspired by tt-a1i/archify's idea of a validated JSON intermediate
// representation compiled to a portable, deterministic HTML artifact — not
// vendored from it (archify is its own multi-diagram-type rendering engine
// with a layout/validation pipeline well beyond what a single workspace tool
// should own). This is a clean-room, single-diagram-type subset: a directed
// graph laid out in left-to-right layers, enough for "show me how these
// pieces connect" without pulling in a layout engine dependency.
//
// It only computes a layout and returns markup; it never writes to disk —
// saving the result is `fs:write`'s job, so permissions stay separated the
// way the rest of the tool surface already does.

const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const H_GAP = 80;
const V_GAP = 24;
const MARGIN = 24;

function generateDiagram({ title, nodes, edges }) {
  const validated = validate({ title, nodes, edges });
  const layers = layerNodes(validated.nodes, validated.edges);
  const positions = positionNodes(layers);
  const width = layers.length * (NODE_WIDTH + H_GAP) + MARGIN * 2;
  const maxPerLayer = Math.max(1, ...layers.map((l) => l.length));
  const height = maxPerLayer * (NODE_HEIGHT + V_GAP) + MARGIN * 2;

  const svgNodes = validated.nodes.map((n) => renderNode(n, positions.get(n.id))).join('\n');
  const svgEdges = validated.edges.map((e) => renderEdge(e, positions)).join('\n');

  const html = wrapHtml({
    title: validated.title,
    width,
    height,
    body: `${svgEdgeDefs()}\n${svgEdges}\n${svgNodes}`,
  });
  return { html, width, height, nodeCount: validated.nodes.length, edgeCount: validated.edges.length };
}

function validate({ title, nodes, edges }) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('diagram requires at least one node');
  if (nodes.length > 200) throw new Error('diagram supports at most 200 nodes');
  const ids = new Set();
  const normNodes = nodes.map((n, i) => {
    if (!n || typeof n.id !== 'string' || !n.id) throw new Error(`node[${i}] requires a non-empty string id`);
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    return { id: n.id, label: typeof n.label === 'string' && n.label ? n.label : n.id };
  });
  const normEdges = (Array.isArray(edges) ? edges : []).map((e, i) => {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') {
      throw new Error(`edge[${i}] requires string "from" and "to"`);
    }
    if (!ids.has(e.from)) throw new Error(`edge[${i}] references unknown node "${e.from}"`);
    if (!ids.has(e.to)) throw new Error(`edge[${i}] references unknown node "${e.to}"`);
    return { from: e.from, to: e.to, label: typeof e.label === 'string' ? e.label : '' };
  });
  return { title: typeof title === 'string' && title ? title : 'Diagram', nodes: normNodes, edges: normEdges };
}

// Longest-path layering (a minimal Sugiyama-style pass): a node's layer is one
// more than the deepest layer of anything pointing into it. Cycles are broken
// by ignoring back-edges once a node is already placed (best-effort, not a
// claim of topological correctness for cyclic graphs).
function layerNodes(nodes, edges) {
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) incoming.get(e.to).push(e.from);

  const layerOf = new Map();
  const resolving = new Set();
  function resolve(id) {
    if (layerOf.has(id)) return layerOf.get(id);
    if (resolving.has(id)) return 0; // cycle guard
    resolving.add(id);
    const parents = incoming.get(id) || [];
    const layer = parents.length === 0 ? 0 : Math.max(...parents.map(resolve)) + 1;
    resolving.delete(id);
    layerOf.set(id, layer);
    return layer;
  }
  for (const n of nodes) resolve(n.id);

  const maxLayer = Math.max(0, ...[...layerOf.values()]);
  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id)].push(n);
  return layers;
}

function positionNodes(layers) {
  const positions = new Map();
  layers.forEach((layer, layerIndex) => {
    layer.forEach((node, rowIndex) => {
      positions.set(node.id, {
        x: MARGIN + layerIndex * (NODE_WIDTH + H_GAP),
        y: MARGIN + rowIndex * (NODE_HEIGHT + V_GAP),
      });
    });
  });
  return positions;
}

function renderNode(node, pos) {
  const label = escapeXml(node.label);
  return `<g>
  <rect x="${pos.x}" y="${pos.y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="8" class="node-box" />
  <text x="${pos.x + NODE_WIDTH / 2}" y="${pos.y + NODE_HEIGHT / 2}" class="node-label" text-anchor="middle" dominant-baseline="middle">${label}</text>
</g>`;
}

function renderEdge(edge, positions) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const midX = (x1 + x2) / 2;
  const label = edge.label ? `<text x="${midX}" y="${(y1 + y2) / 2 - 6}" class="edge-label" text-anchor="middle">${escapeXml(edge.label)}</text>` : '';
  return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" class="edge-line" marker-end="url(#arrow)" />\n${label}`;
}

function svgEdgeDefs() {
  return `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="edge-arrow" /></marker></defs>`;
}

function wrapHtml({ title, width, height, body }) {
  const safeTitle = escapeXml(title);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  body { margin: 0; padding: 16px; font-family: -apple-system, Segoe UI, sans-serif; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 14px; font-weight: 600; opacity: 0.8; margin: 0 0 12px; }
  svg { max-width: 100%; height: auto; }
  .node-box { fill: #161b22; stroke: #30363d; stroke-width: 1.5; }
  .node-label { fill: #e6edf3; font-size: 12px; }
  .edge-line { fill: none; stroke: #58a6ff; stroke-width: 1.5; }
  .edge-arrow { fill: #58a6ff; }
  .edge-label { fill: #8b949e; font-size: 10px; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
${body}
</svg>
</body>
</html>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateDiagram };
