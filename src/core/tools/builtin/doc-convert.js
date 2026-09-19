// doc:convert — turn a handful of common document formats into Markdown, so an
// agent can read a spreadsheet or a Word doc the same way it reads a text
// file, without leaving the workspace's tool/policy boundary.
//
// Scope is deliberately narrow: .docx (paragraph text + heading levels),
// .csv/.tsv (as a Markdown table) and .txt/.md/.json (passthrough/pretty).
// PDF and legacy binary formats (.doc, .xls, .ppt) are NOT supported — their
// real formats need a compressed-stream/content-stream parser (PDF) or a
// binary OLE parser (.doc/.xls/.ppt), which is a project in itself, not
// something to fake with a regex. `doc:convert` refuses those by name instead
// of returning a plausible-looking wrong answer.
//
// Inspired by firecrawl/anydoc's "office docs to clean Markdown for LLMs"
// idea; not vendored from it — anydoc's Rust core has no compatible Node
// package (the "anydoc" name on npm is an unrelated project), so this is a
// clean-room implementation scoped to what a workspace tool can support
// without shelling out or adding a new dependency.

const path = require('node:path');
const { readEntries } = require('./zip-reader');

const SUPPORTED = Object.freeze(['.docx', '.csv', '.tsv', '.txt', '.md', '.markdown', '.json']);

async function convertToMarkdown(fs, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    throw new Error(
      `unsupported format "${ext}" — doc:convert handles ${SUPPORTED.join(', ')}. `
      + 'PDF and legacy .doc/.xls/.ppt need a real parser this tool does not implement; read them with another tool.',
    );
  }

  if (ext === '.docx') {
    const buf = await fs.readFile(absPath);
    return docxToMarkdown(buf);
  }
  const text = await fs.readFile(absPath, 'utf8');
  if (ext === '.csv') return csvToMarkdownTable(text, ',');
  if (ext === '.tsv') return csvToMarkdownTable(text, '\t');
  if (ext === '.json') return '```json\n' + tryPrettyJson(text) + '\n```';
  return text; // .txt / .md / .markdown
}

function docxToMarkdown(buf) {
  let entries;
  try {
    entries = readEntries(buf, { only: ['word/document.xml'] });
  } catch (err) {
    throw new Error(`could not read .docx as a zip archive: ${err.message}`, { cause: err });
  }
  const xml = entries.get('word/document.xml');
  if (!xml) throw new Error('.docx has no word/document.xml — not a Word document, or a format this parser does not recognize');
  return docxXmlToMarkdown(xml.toString('utf8'));
}

// A tolerant, purpose-built reader for the one subset of WordprocessingML that
// matters here: paragraphs (<w:p>), their style (<w:pStyle w:val="Heading1">),
// and the runs of text inside them (<w:r><w:t>...</w:t></w:r>). It is not a
// general OOXML parser — tables, images and tracked changes are out of scope.
function docxXmlToMarkdown(xml) {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = [];
  for (const para of paragraphs) {
    const styleMatch = para.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : '';
    const runs = para.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    const text = runs.map((r) => decodeXmlEntities(r.replace(/<[^>]+>/g, ''))).join('');
    if (!text.trim()) { lines.push(''); continue; }

    const headingLevel = /^Heading(\d)$/.exec(style);
    if (headingLevel) {
      lines.push(`${'#'.repeat(Math.min(6, Number(headingLevel[1])))} ${text.trim()}`);
    } else if (/^ListParagraph$/.test(style) || /^List/.test(style)) {
      lines.push(`- ${text.trim()}`);
    } else {
      lines.push(text.trim());
    }
  }
  // Collapse runs of 3+ blank lines the way a person would when reading it back.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function csvToMarkdownTable(text, delimiter) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => splitDelimited(line, delimiter));
  if (rows.length === 0) return '';
  const header = rows[0];
  const body = rows.slice(1);
  const out = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${header.map((_, i) => row[i] || '').join(' | ')} |`),
  ];
  return out.join('\n') + '\n';
}

// Minimal delimiter split with double-quote support (handles quoted fields
// containing the delimiter or escaped `""`), without a full CSV grammar.
function splitDelimited(line, delimiter) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

function tryPrettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

module.exports = { convertToMarkdown, docxXmlToMarkdown, csvToMarkdownTable, SUPPORTED };
