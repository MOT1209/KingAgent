// MCP research (§23).
//
// An honest note about what this is and is not. KingAgent does not carry an MCP
// *client* in core — `src/main/mcp-config.js` writes the config files the
// external harnesses read, and `src/main/browser-mcp.js` is a server KingAgent
// *exposes*. So this adapter does not speak MCP itself. It takes a client the
// host injects (`io.research.mcp`) with two methods:
//
//   listTools()               -> [{ name, description, inputSchema, serverId }]
//   callTool({ name, args })  -> whatever the tool returns
//
// and does the three things core is responsible for: decide which of the host's
// tools are research capabilities, shape a call for them, and turn the result
// into Sources. Every call still goes through sourceManager's policy gate and
// security screen — an MCP server is third-party code and §23 requires the whole
// pipeline, not a shortcut.
//
// With no client injected the adapter reports itself unavailable. It never
// fabricates a result.

const { SOURCE_TYPES } = require('../schemas/source');
const { normalizeResult } = require('../schemas/researchResult');
const { SourceUnavailableError } = require('../errors/researchErrors');

// The capability families §23 names, and the token shapes that identify them in
// a tool name or description. Matching is on word boundaries so a tool called
// `format_search_results` is not mistaken for a search backend.
const MCP_CAPABILITY = Object.freeze({
  SEARCH: 'search',
  FETCH: 'fetch',
  BROWSER: 'browser',
  DATABASE: 'database',
  DOCUMENTATION: 'documentation',
  GITHUB: 'github',
  FILES: 'files',
  KNOWLEDGE: 'knowledge',
});

const CAPABILITY_TOKENS = Object.freeze({
  search: [/\bsearch\b/, /\bquery\b/, /\bfind\b/, /\bweb_?search\b/, /\blookup\b/],
  fetch: [/\bfetch\b/, /\bget_?page\b/, /\bread_?url\b/, /\bscrape\b/, /\bcrawl\b/],
  browser: [/\bbrowser\b/, /\bnavigate\b/, /\bplaywright\b/, /\bpuppeteer\b/],
  database: [/\bsql\b/, /\bdatabase\b/, /\bquery_?db\b/, /\btable\b/],
  documentation: [/\bdocs?\b/, /\bdocumentation\b/, /\breference\b/, /\bapi_?ref\b/],
  github: [/\bgithub\b/, /\brepo(sitory)?\b/, /\bpull_?request\b/, /\bissue\b/],
  files: [/\bfile\b/, /\bread_?file\b/, /\blist_?dir\b/],
  knowledge: [/\bknowledge\b/, /\bwiki\b/, /\bmemory\b/, /\bvector\b/, /\bembedding\b/, /\bcorpus\b/],
});

// Which capabilities may answer a research *query*. Browser, database and file
// tools are discoverable and reportable but are not called speculatively by a
// search: driving a browser or running SQL on a guess is not a search, it is an
// action, and §23 routes actions through approval on their own terms.
const QUERYABLE = Object.freeze([
  MCP_CAPABILITY.SEARCH, MCP_CAPABILITY.DOCUMENTATION,
  MCP_CAPABILITY.GITHUB, MCP_CAPABILITY.KNOWLEDGE,
]);

function classifyTool(tool) {
  const hay = `${tool.name || ''} ${tool.description || ''}`.toLowerCase().replace(/[_-]/g, '_');
  const caps = [];
  for (const [cap, patterns] of Object.entries(CAPABILITY_TOKENS)) {
    if (patterns.some((re) => re.test(hay))) caps.push(cap);
  }
  return caps;
}

// Guess the query parameter without inventing one. If the schema names a string
// property that looks like a query, use it; otherwise the tool is not callable
// as a search and is reported as discoverable-but-unusable rather than being
// called with a made-up argument shape.
const QUERY_PARAM_NAMES = ['query', 'q', 'search', 'searchQuery', 'question', 'text', 'prompt', 'term', 'keywords'];

function queryParamFor(tool) {
  const schema = tool && tool.inputSchema;
  const props = schema && schema.properties;
  if (!props || typeof props !== 'object') return null;
  for (const name of QUERY_PARAM_NAMES) {
    const prop = props[name];
    if (prop && (prop.type === 'string' || prop.type === undefined)) return name;
  }
  // A single required string property is unambiguous enough to use.
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 1) {
    const only = props[required[0]];
    if (only && only.type === 'string') return required[0];
  }
  return null;
}

const LIMIT_PARAM_NAMES = ['limit', 'maxResults', 'max_results', 'count', 'topK', 'top_k', 'n'];

function limitParamFor(tool) {
  const props = tool && tool.inputSchema && tool.inputSchema.properties;
  if (!props) return null;
  return LIMIT_PARAM_NAMES.find((n) => props[n] && (props[n].type === 'number' || props[n].type === 'integer')) || null;
}

function createMcpSource({ client = null } = {}) {
  let discovered = null;

  async function discover({ signal } = {}) {
    if (!client || typeof client.listTools !== 'function') {
      throw new SourceUnavailableError('mcp', 'no MCP client is wired into this install');
    }
    const tools = await client.listTools({ signal });
    if (!Array.isArray(tools)) throw new SourceUnavailableError('mcp', 'MCP client returned a non-array from listTools()');
    discovered = tools.map((t) => {
      const capabilities = classifyTool(t);
      const queryParam = queryParamFor(t);
      return {
        name: String(t.name || ''),
        serverId: t.serverId || t.server || null,
        description: String(t.description || '').slice(0, 500),
        capabilities,
        queryParam,
        limitParam: limitParamFor(t),
        queryable: Boolean(queryParam) && capabilities.some((c) => QUERYABLE.includes(c)),
        // Why a discovered tool is not being used. Surfaced in the research
        // report so "we saw your MCP server and did nothing" is never silent.
        unusableReason: !capabilities.length
          ? 'no research capability recognized in its name or description'
          : !queryParam
            ? 'no string query parameter in its input schema'
            : !capabilities.some((c) => QUERYABLE.includes(c))
              ? `capabilities [${capabilities.join(', ')}] are actions, not searches`
              : null,
      };
    });
    return discovered;
  }

  // MCP tools return content in the MCP envelope shape
  // (`{ content: [{ type:'text', text }] }`) or plain JSON. Both are flattened
  // to rows here; anything unrecognizable becomes one text row rather than
  // being dropped.
  function rowsFrom(result) {
    if (result === null || result === undefined) return [];
    if (Array.isArray(result)) return result;
    if (Array.isArray(result.results)) return result.results;
    if (Array.isArray(result.items)) return result.items;
    if (Array.isArray(result.content)) {
      const rows = [];
      for (const part of result.content) {
        if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
        // A tool that returns JSON-in-text is common; parse it when it parses.
        try {
          const parsed = JSON.parse(part.text);
          if (Array.isArray(parsed)) { rows.push(...parsed); continue; }
          if (parsed && typeof parsed === 'object') { rows.push(parsed); continue; }
        } catch { /* not JSON: keep the text as one row */ }
        rows.push({ content: part.text, title: null });
      }
      return rows;
    }
    if (typeof result === 'object') return [result];
    return [{ content: String(result) }];
  }

  return Object.freeze({
    id: 'mcp',
    type: SOURCE_TYPES.MCP,
    label: 'MCP research tools',
    description: 'Search and knowledge tools exposed by the MCP servers this install is connected to.',
    providerTypes: Object.freeze([SOURCE_TYPES.MCP]),
    defaultAuthority: 0.6,
    supportsFetch: false,

    providersFrom() { return []; },
    available() { return Boolean(client && typeof client.listTools === 'function'); },

    discover,
    // What was found and why some of it is unused — read by the report and the
    // MCP audit, never used to make a claim.
    inventory() { return discovered ? discovered.map((t) => ({ ...t })) : null; },

    async search({ query, limit = 10, signal = null, onFailure = null, toolNames = null }) {
      if (!client || typeof client.callTool !== 'function') {
        throw new SourceUnavailableError('mcp', 'no MCP client is wired into this install');
      }
      const tools = (discovered || await discover({ signal }))
        .filter((t) => t.queryable && (!toolNames || toolNames.includes(t.name)));
      if (tools.length === 0) {
        throw new SourceUnavailableError('mcp', 'no connected MCP tool exposes a usable search capability');
      }

      const out = [];
      for (const tool of tools) {
        if (signal && signal.aborted) break;
        if (out.length >= limit) break;
        const args = { [tool.queryParam]: query.text };
        if (tool.limitParam) args[tool.limitParam] = Math.min(limit, 20);
        let raw;
        try {
          raw = await client.callTool({ name: tool.name, serverId: tool.serverId, args, signal });
        } catch (err) {
          // One bad MCP server must not end MCP research (§9).
          if (onFailure) onFailure({ tool: tool.name, reason: (err && err.message) || String(err), code: 'MCP_TOOL_FAILED' });
          continue;
        }
        const rows = rowsFrom(raw);
        for (const [i, row] of rows.entries()) {
          if (out.length >= limit) break;
          out.push(normalizeResult({
            type: SOURCE_TYPES.MCP,
            url: typeof row.url === 'string' ? row.url : (typeof row.link === 'string' ? row.link : null),
            title: typeof row.title === 'string' ? row.title : `${tool.name} result ${i + 1}`,
            content: typeof row.content === 'string' ? row.content : (typeof row.text === 'string' ? row.text : ''),
            snippet: typeof row.snippet === 'string' ? row.snippet : '',
            publisher: tool.serverId ? `mcp:${tool.serverId}` : 'mcp',
            // An MCP tool is as primary as whatever it wraps, which we cannot
            // know. Not primary is the safe default.
            primary: false,
            providerRank: i,
            metadata: {
              mcpTool: tool.name,
              mcpServer: tool.serverId,
              mcpCapabilities: tool.capabilities,
            },
          }, { query, adapterId: 'mcp' }));
        }
      }
      return out;
    },
  });
}

module.exports = {
  createMcpSource, classifyTool, queryParamFor, limitParamFor,
  MCP_CAPABILITY, QUERYABLE, CAPABILITY_TOKENS,
};
