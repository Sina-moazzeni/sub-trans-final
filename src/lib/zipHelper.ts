/**
 * Fast, zero-dependency UTF-8 ZIP archive builder (PKZIP Store mode, CRC-32).
 * Packages dozens or hundreds of translated SRT/VTT subtitle files in milliseconds.
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeUniqueEntryName(rawName: string, seen: Set<string>): string {
  const clean = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'subtitle.srt';
  const lower = clean.toLowerCase();
  if (!seen.has(lower)) {
    seen.add(lower);
    return clean;
  }
  const dotIdx = clean.lastIndexOf('.');
  const base = dotIdx > 0 ? clean.slice(0, dotIdx) : clean;
  const ext = dotIdx > 0 ? clean.slice(dotIdx) : '';
  let counter = 2;
  while (seen.has(`${base} (${counter})${ext}`.toLowerCase())) {
    counter++;
  }
  const candidate = `${base} (${counter})${ext}`;
  seen.add(candidate.toLowerCase());
  return candidate;
}

export interface ZipEntryInput {
  name: string;
  content: string;
}

export function createZipBlob(entries: ZipEntryInput[]): Blob {
  const encoder = new TextEncoder();
  const seenNames = new Set<string>();
  const now = new Date();

  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const safeName = makeUniqueEntryName(entry.name, seenNames);
    const nameBytes = encoder.encode(safeName);
    const dataBytes = encoder.encode(entry.content);
    const crc = crc32(dataBytes);

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lView = new DataView(localHeader.buffer);
    lView.setUint32(0, 0x04034b50, true); // Local file header signature
    lView.setUint16(4, 20, true);         // Version needed to extract (2.0)
    lView.setUint16(6, 0x0800, true);     // UTF-8 filename flag
    lView.setUint16(8, 0, true);          // Compression method: 0 (Store)
    lView.setUint16(10, dosTime, true);
    lView.setUint16(12, dosDate, true);
    lView.setUint32(14, crc, true);
    lView.setUint32(18, dataBytes.length, true);
    lView.setUint32(22, dataBytes.length, true);
    lView.setUint16(26, nameBytes.length, true);
    lView.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    // Central directory header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(centralHeader.buffer);
    cView.setUint32(0, 0x02014b50, true); // Central file header signature
    cView.setUint16(4, 20, true);         // Version made by
    cView.setUint16(6, 20, true);         // Version needed
    cView.setUint16(8, 0x0800, true);     // UTF-8 filename flag
    cView.setUint16(10, 0, true);         // Compression method: 0 (Store)
    cView.setUint16(12, dosTime, true);
    cView.setUint16(14, dosDate, true);
    cView.setUint32(16, crc, true);
    cView.setUint32(20, dataBytes.length, true);
    cView.setUint32(24, dataBytes.length, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint16(30, 0, true);         // Extra field length
    cView.setUint16(32, 0, true);         // Comment length
    cView.setUint16(34, 0, true);         // Disk number start
    cView.setUint16(36, 0, true);         // Internal file attributes
    cView.setUint32(38, 0, true);         // External file attributes
    cView.setUint32(42, offset, true);    // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectorySize = centralParts.reduce((acc, part) => acc + part.length, 0);

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);
  eView.setUint16(4, 0, true);
  eView.setUint16(6, 0, true);
  eView.setUint16(8, entries.length, true);
  eView.setUint16(10, entries.length, true);
  eView.setUint32(12, centralDirectorySize, true);
  eView.setUint32(16, offset, true);
  eView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], {
    type: 'application/zip',
  });
}
