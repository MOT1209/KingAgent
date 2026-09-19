// doc:convert / diagram:generate — the two new builtin tools inspired by
// anydoc (office docs -> markdown) and archify (diagram-as-artifact), and the
// minimal zip reader that backs .docx support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { readEntries } = require('../src/core/tools/builtin/zip-reader.js');
const { convertToMarkdown, docxXmlToMarkdown, csvToMarkdownTable } = require('../src/core/tools/builtin/doc-convert.js');
const { generateDiagram } = require('../src/core/tools/builtin/diagram-generate.js');
const { EventBus } = require('../src/core/events/event-bus.js');
const { ToolManager } = require('../src/core/tools/manager.js');
const { registerBuiltinTools } = require('../src/core/tools/builtin/index.js');

// Builds a minimal, valid, single-entry ZIP archive (stored, no compression)
// so the reader can be tested without a real Office file on disk.
function buildStoredZip(entryName, content) {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
  local.writeUInt32LE(dataBuf.length, 18); // compressed size
  local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length
  const localRecord = Buffer.concat([local, nameBuf, dataBuf]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(0, 10); // method
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(0, 16); // crc32
  central.writeUInt32LE(dataBuf.length, 20);
  central.writeUInt32LE(dataBuf.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset
  const centralRecord = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralRecord.length, 12); // central dir size
  eocd.writeUInt32LE(localRecord.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

test('zip-reader: reads a stored entry out of a minimal zip', () => {
  const zip = buildStoredZip('word/document.xml', '<hello/>');
  const entries = readEntries(zip, { only: ['word/document.xml'] });
  assert.equal(entries.get('word/document.xml').toString('utf8'), '<hello/>');
});

test('zip-reader: throws a clear error on a non-zip buffer', () => {
  assert.throws(() => readEntries(Buffer.from('not a zip')), /not a valid zip/);
});

test('docx: paragraphs and headings become markdown', () => {
  const xml = `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
    <w:p><w:r><w:t>Some body text with an </w:t></w:r><w:r><w:t>escaped &amp; entity.</w:t></w:r></w:p>
  </w:body></w:document>`;
  const md = docxXmlToMarkdown(xml);
  assert.match(md, /^# Title/m);
  assert.match(md, /Some body text with an escaped & entity\./);
});

test('doc:convert reads a real .docx built as a zip', async () => {
  const { root, dispose } = makeTempDir();
  try {
    const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p></w:body></w:document>';
    const docxBuf = buildStoredZip('word/document.xml', xml);
    const filePath = path.join(root, 'report.docx');
    await fs.writeFile(filePath, docxBuf);
    const markdown = await convertToMarkdown(require('node:fs/promises'), filePath);
    assert.match(markdown, /^## Section/m);
  } finally {
    dispose();
  }
});

test('doc:convert rejects unsupported formats by name', async () => {
  const { root, dispose } = makeTempDir();
  try {
    const filePath = path.join(root, 'scan.pdf');
    await fs.writeFile(filePath, 'not really a pdf');
    await assert.rejects(
      () => convertToMarkdown(require('node:fs/promises'), filePath),
      /unsupported format ".pdf"/,
    );
  } finally {
    dispose();
  }
});

test('csv -> markdown table, including quoted fields with embedded commas', () => {
  const csv = 'name,note\n"Doe, Jane",ok\nBob,"has ""quotes"""';
  const md = csvToMarkdownTable(csv, ',');
  assert.match(md, /\| name \| note \|/);
  assert.match(md, /\| Doe, Jane \| ok \|/);
  assert.match(md, /has "quotes"/);
});

test('doc:convert is registered and reachable through the ToolManager', async () => {
  const { root, dispose } = makeTempDir();
  try {
    await fs.writeFile(path.join(root, 'notes.txt'), 'plain text');
    const tm = new ToolManager({ bus: new EventBus() });
    registerBuiltinTools(tm, { fs: require('node:fs/promises'), root, cwd: () => root, runShell: null });
    const agent = { id: 't', capabilities: ['read'], permissions: { levels: ['read_only'], allowDestructive: false, denyTools: [] }, model: { id: 'default' }, tools: [] };
    const result = await tm.execute({ id: 'doc:convert', input: { path: 'notes.txt' }, agent });
    assert.equal(result.data.markdown, 'plain text');
  } finally {
    dispose();
  }
});

test('diagram:generate lays out a small graph deterministically', () => {
  const { html, nodeCount, edgeCount } = generateDiagram({
    title: 'Pipeline',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'then' }],
  });
  assert.equal(nodeCount, 3);
  assert.equal(edgeCount, 2);
  assert.match(html, /<svg/);
  assert.match(html, />A<\/text>/);
  assert.match(html, /then/);
});

test('diagram:generate rejects a dangling edge with a specific error', () => {
  assert.throws(
    () => generateDiagram({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] }),
    /unknown node "ghost"/,
  );
});

test('diagram:generate is registered and reachable through the ToolManager', async () => {
  const tm = new ToolManager({ bus: new EventBus() });
  registerBuiltinTools(tm, { fs: require('node:fs/promises'), root: null, cwd: () => process.cwd(), runShell: null });
  const agent = { id: 't', capabilities: ['read'], permissions: { levels: ['read_only'], allowDestructive: false, denyTools: [] }, model: { id: 'default' }, tools: [] };
  const result = await tm.execute({ id: 'diagram:generate', input: { nodes: [{ id: 'x' }] }, agent });
  assert.match(result.data.html, /<svg/);
});
