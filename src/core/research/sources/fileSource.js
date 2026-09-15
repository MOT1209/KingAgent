// File research (§25): PDFs, markdown, text, DOCX, JSON, CSV and source code
// that are already on this machine.
//
// Two properties make this adapter different from every other one:
//
//   * **It never touches the network.** Its "provider" is the platform's own
//     `fs`, reached through the same injected io the built-in fs tools use, and
//     the path guard the rest of the platform already enforces.
//   * **It is the only adapter allowed to run when a task says `filesOnly`.**
//     That is the whole point of the flag: "answer using only these files" must
//     be a gate, not a hint.
//
// Retrieval is lexical over the file set, reusing core/memory/relevance.js's
// tokenizer rather than introducing a second one. Binary formats (PDF, DOCX)
// are handed to a host-supplied extractor when one exists; when none does, the
// file is reported as unreadable rather than silently skipped, because "your PDF
// contributed nothing" is something the user needs to be told.

const path = require('node:path');
const { SOURCE_TYPES } = require('../schemas/source');
const { normalizeResult } = require('../schemas/researchResult');
const { tokenize } = require('../../memory/relevance');
const { screenFilePath } = require('../security/researchSecurity');
const { SourceUnavailableError } = require('../errors/researchErrors');

// Read directly; no extractor needed.
const TEXT_EXT = Object.freeze([
  '.txt', '.md', '.markdown', '.mdx', '.rst', '.json', '.jsonl', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.html', '.htm', '.xml', '.svg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.kt', '.sh', '.ps1',
  '.sql', '.graphql', '.proto', '.env.example',
]);

// Need a host extractor: `io.research.extractText({ path, ext })`.
const EXTRACTABLE_EXT = Object.freeze(['.pdf', '.docx', '.doc', '.rtf', '.odt', '.pptx', '.epub']);

// Images are supported only when the host supplies an extractor that can
// describe them (OCR or a vision model). Without one they are skipped with a
// stated reason.
const IMAGE_EXT = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']);

const MAX_FILE_BYTES = 4 * 1024 * 1024;
// Long documents are searched as windows so a 300-page PDF yields the paragraph
// that matters instead of one unusable blob.
const CHUNK_CHARS = 4_000;
const CHUNK_OVERLAP = 400;

function createFileSource({ fs, root = null, extractText = null, pathGuard = null } = {}) {
  if (!fs) throw new TypeError('the file research source requires an fs adapter');

  async function readDocument(filePath) {
    const screened = screenFilePath(filePath);
    if (!screened.ok) throw new SourceUnavailableError('file', screened.reason);
    const resolved = pathGuard ? pathGuard(root, filePath) : filePath;
    const ext = path.extname(resolved).toLowerCase();

    let stat;
    try { stat = await fs.stat(resolved); } catch (err) {
      throw new SourceUnavailableError('file', `cannot stat ${filePath}: ${err.message}`);
    }
    if (stat && typeof stat.size === 'number' && stat.size > MAX_FILE_BYTES) {
      throw new SourceUnavailableError('file', `${filePath} is ${stat.size} bytes; over the ${MAX_FILE_BYTES}-byte research limit`);
    }

    if (TEXT_EXT.includes(ext) || ext === '') {
      const text = await fs.readFile(resolved, 'utf8');
      return { text: String(text), ext, resolved, stat, extractor: 'text' };
    }
    if (EXTRACTABLE_EXT.includes(ext) || IMAGE_EXT.includes(ext)) {
      if (typeof extractText !== 'function') {
        throw new SourceUnavailableError('file', `${ext} files need a text extractor, and none is configured`);
      }
      const out = await extractText({ path: resolved, ext, originalPath: filePath });
      const text = out && typeof out === 'object' ? out.text : out;
      if (typeof text !== 'string' || !text.trim()) {
        throw new SourceUnavailableError('file', `the extractor returned no text for ${filePath}`);
      }
      return { text, ext, resolved, stat, extractor: (out && out.extractor) || 'host' };
    }
    throw new SourceUnavailableError('file', `${ext || '(no extension)'} is not a supported research document`);
  }

  // Split into overlapping windows, remembering where each one started so the
  // evidence extractor can report a real character range inside the file.
  function chunk(text) {
    const out = [];
    if (text.length <= CHUNK_CHARS) return [{ text, start: 0, index: 0 }];
    let start = 0;
    let index = 0;
    while (start < text.length) {
      out.push({ text: text.slice(start, start + CHUNK_CHARS), start, index: index++ });
      if (start + CHUNK_CHARS >= text.length) break;
      start += CHUNK_CHARS - CHUNK_OVERLAP;
    }
    return out;
  }

  function scoreChunk(queryTokens, chunkText) {
    if (queryTokens.size === 0) return 0.35;
    const tokens = new Set(tokenize(chunkText));
    let hits = 0;
    for (const t of queryTokens) if (tokens.has(t)) hits += 1;
    return hits / queryTokens.size;
  }

  return Object.freeze({
    id: 'file',
    type: SOURCE_TYPES.FILE,
    label: 'File research',
    description: 'Search documents already on this machine. Never reaches the network.',
    providerTypes: Object.freeze([SOURCE_TYPES.FILE]),
    defaultAuthority: 0.7,
    supportsFetch: true,

    // The file adapter is its own provider, so it is available whenever the
    // task names files. `registry` is ignored on purpose.
    providersFrom() { return []; },
    available() { return true; },

    async search({ query, limit = 10, files = [], signal = null, onFailure = null }) {
      const queryTokens = new Set(tokenize(query.text));
      const scored = [];
      for (const file of files) {
        if (signal && signal.aborted) break;
        let doc;
        try {
          doc = await readDocument(file);
        } catch (err) {
          // A file we cannot read is reported, never swallowed: §25's answer
          // must not quietly exclude a document the user pointed at.
          if (onFailure) onFailure({ file, reason: err.message, code: err.code || 'RESEARCH_SOURCE_UNAVAILABLE' });
          continue;
        }
        for (const part of chunk(doc.text)) {
          const score = scoreChunk(queryTokens, part.text);
          if (score <= 0) continue;
          scored.push({ file, doc, part, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, limit).map(({ file, doc, part, score }, i) => normalizeResult({
        type: SOURCE_TYPES.FILE,
        url: null,
        path: file,
        title: `${path.basename(file)}${part.index > 0 ? ` (part ${part.index + 1})` : ''}`,
        content: part.text,
        snippet: part.text.slice(0, 400),
        publisher: 'local file',
        primary: true,
        relevanceScore: score,
        providerRank: i,
        retrievedAt: Date.now(),
        updatedAt: doc.stat && doc.stat.mtimeMs ? doc.stat.mtimeMs : null,
        metadata: {
          ext: doc.ext,
          extractor: doc.extractor,
          chunkIndex: part.index,
          chunkStart: part.start,
          bytes: doc.stat ? doc.stat.size : null,
        },
      }, { query, adapterId: 'file' }));
    },

    async readDocument(filePath) {
      return readDocument(filePath);
    },
  });
}

module.exports = {
  createFileSource, TEXT_EXT, EXTRACTABLE_EXT, IMAGE_EXT, MAX_FILE_BYTES, CHUNK_CHARS,
};
