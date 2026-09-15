// Citation rendering (§19). Presentation only — it never decides what may be
// cited, only how an already-built citation looks.
//
// Every style renders from the citation's own recorded fields. A style that
// needed a field the source did not have (an author, a publication date) omits
// it rather than inventing or guessing one, which is why every helper here is
// written as a filtered join.

const { CITATION_STYLE } = require('../schemas/citation');

function formatInline(citation) {
  return `[${citation.ordinal}]`;
}

function formatFootnoteMarker(citation) {
  return `[^${citation.ordinal}]`;
}

function formatMarkdownLink(citation) {
  const label = citation.title || citation.url || `source ${citation.ordinal}`;
  return citation.url ? `[${escapeLabel(label)}](${citation.url})` : escapeLabel(label);
}

// A bibliography line. `entry` is a CitationEngine.bibliography() row.
function formatEntry(entry, style = CITATION_STYLE.NUMBERED_LIST) {
  const date = entry.publishedAt ? isoDate(entry.publishedAt) : null;
  const retrieved = entry.retrievedAt ? isoDate(entry.retrievedAt) : null;

  if (style === CITATION_STYLE.APA) {
    const parts = [
      entry.author || entry.publisher || null,
      date ? `(${date.slice(0, 4)})` : '(n.d.)',
      entry.title ? `${entry.title}.` : null,
      entry.publisher && entry.publisher !== entry.author ? `${entry.publisher}.` : null,
      entry.url || null,
    ].filter(Boolean);
    return parts.join(' ');
  }

  if (style === CITATION_STYLE.MARKDOWN) {
    const link = entry.url ? `[${escapeLabel(entry.title || entry.url)}](${entry.url})` : escapeLabel(entry.title || '(untitled)');
    const meta = [entry.publisher, date].filter(Boolean).join(', ');
    return meta ? `${link} — ${meta}` : link;
  }

  // Default: numbered, with the provenance a reader needs to judge it —
  // publisher, date, whether it is a primary source, and when we fetched it.
  const meta = [
    entry.publisher || entry.author || null,
    date || null,
    entry.primary ? 'primary source' : null,
    retrieved ? `retrieved ${retrieved}` : null,
  ].filter(Boolean).join(', ');
  const head = entry.url ? `${entry.title} — ${entry.url}` : entry.title;
  return `[${entry.ordinal}] ${head}${meta ? ` (${meta})` : ''}`;
}

function formatBibliography(entries, style = CITATION_STYLE.NUMBERED_LIST) {
  return entries.map((e) => formatEntry(e, style)).join('\n');
}

// Footnote definitions to go under a footnote-style answer.
function formatFootnotes(entries) {
  return entries.map((e) => `[^${e.ordinal}]: ${formatEntry(e, CITATION_STYLE.MARKDOWN)}`).join('\n');
}

// The quote, attributed. Used in the evidence appendix of the report, where the
// point is that a reader can check the claim against the actual words.
function formatQuote(citation) {
  const where = locationLabel(citation.location);
  const attribution = [citation.title, where].filter(Boolean).join(' — ');
  return `> ${citation.quote.replace(/\n/g, '\n> ')}\n>\n> — ${attribution} ${formatInline(citation)}`;
}

function locationLabel(location) {
  if (!location) return null;
  if (location.kind === 'line' && location.line) {
    return location.endLine && location.endLine !== location.line
      ? `${location.path || 'file'}:${location.line}-${location.endLine}`
      : `${location.path || 'file'}:${location.line}`;
  }
  if (location.section) return location.section;
  if (location.kind === 'char' && Number.isInteger(location.start)) return `chars ${location.start}–${location.end}`;
  return null;
}

function escapeLabel(text) {
  return String(text).replace(/[[\]]/g, '');
}

function isoDate(ms) {
  try { return new Date(ms).toISOString().slice(0, 10); } catch { return ''; }
}

module.exports = {
  CITATION_STYLE, formatInline, formatFootnoteMarker, formatMarkdownLink,
  formatEntry, formatBibliography, formatFootnotes, formatQuote, locationLabel,
};
