// A minimal, read-only ZIP reader: just enough to pull named entries out of an
// Office Open XML package (.docx/.pptx/.xlsx are ZIP containers) without a new
// dependency. It does not write, does not shell out, and only supports the two
// storage methods Office actually uses (stored / deflate).
//
// This is not a general-purpose ZIP library: no encryption, no zip64, no
// streaming. If a real package needs more than that, `doc:convert` reports
// exactly what failed rather than guessing.

const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  // The EOCD record is at most 22 bytes + a comment (max 65535 bytes) from the
  // end of the file. Scan backwards for its signature.
  const maxScan = Math.min(buf.length, 22 + 65535);
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

// Returns a Map<entryName, Buffer> for every entry whose name is in `only`
// (or every entry, when `only` is omitted).
function readEntries(buf, { only = null } = {}) {
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset < 0) throw new Error('not a valid zip archive (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  const wanted = only ? new Set(only) : null;

  const out = new Map();
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) break;
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (!wanted || wanted.has(name)) {
      out.set(name, extractLocalEntry(buf, localHeaderOffset, compressionMethod, compressedSize));
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function extractLocalEntry(buf, localOffset, compressionMethod, compressedSize) {
  if (buf.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('corrupt zip entry (bad local file header)');
  }
  const nameLength = buf.readUInt16LE(localOffset + 26);
  const extraLength = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressed = buf.subarray(dataStart, dataStart + compressedSize);
  if (compressionMethod === 0) return Buffer.from(compressed); // stored
  if (compressionMethod === 8) return zlib.inflateRawSync(compressed); // deflate
  throw new Error(`unsupported zip compression method: ${compressionMethod}`);
}

module.exports = { readEntries };
