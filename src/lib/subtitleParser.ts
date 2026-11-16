import { SubtitleFormat, SubtitleItem } from '../types';
import { detectEncodingAndDecodeText } from './encodingHelper';

/**
 * Detect text encoding from ArrayBuffer using enhanced detector with jschardet and Persian Windows-1256 fallback
 */
export function detectEncodingAndDecode(buffer: ArrayBuffer, forcedEncoding?: string): { text: string; encoding: string } {
  const result = detectEncodingAndDecodeText(buffer, forcedEncoding);
  return { text: result.text, encoding: result.encoding };
}

/**
 * Convert timestamp (e.g. "00:01:20,500" or "00:01:20.500" or "0:01:20.50") to seconds
 */
export function timestampToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  const cleaned = timeStr.trim().replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    const total = hours * 3600 + minutes * 60 + seconds;
    return isFinite(total) && total >= 0 ? total : 0;
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]) || 0;
    const seconds = parseFloat(parts[1]) || 0;
    const total = minutes * 60 + seconds;
    return isFinite(total) && total >= 0 ? total : 0;
  }
  const direct = parseFloat(cleaned) || 0;
  return isFinite(direct) && direct >= 0 ? direct : 0;
}

/**
 * Validates and sanitizes start/end timecodes ensuring non-negative, finite numbers and end >= start
 */
export function validateAndSanitizeTimecodes(startSec: number, endSec: number): { start: number; end: number } {
  const safeStart = isFinite(startSec) && startSec >= 0 ? startSec : 0;
  let safeEnd = isFinite(endSec) && endSec >= 0 ? endSec : safeStart + 2;
  if (safeEnd < safeStart) {
    safeEnd = safeStart + 0.5;
  }
  return { start: safeStart, end: safeEnd };
}

/**
 * Format seconds to SRT format: "00:01:20,500"
 * Uses mathematical total millisecond rollover so ms never equals 1000 and s never equals 60.
 */
export function secondsToSRT(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (num: number, size: number) => num.toString().padStart(size, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/**
 * Format seconds to VTT format: "00:01:20.500"
 */
export function secondsToVTT(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (num: number, size: number) => num.toString().padStart(size, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/**
 * Format seconds to ASS/SSA format: "0:01:20.50"
 * Uses mathematical total centisecond rollover so cs never equals 100 and s never equals 60.
 */
export function secondsToASS(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalCs = Math.round(seconds * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (num: number, size: number) => num.toString().padStart(size, '0');
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

/**
 * Parse raw timestamp string into integer { h, m, s, ms } with zero floating-point math
 */
function parseTimestampParts(raw?: string): { h: number; m: number; s: number; ms: number } | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  const match = cleaned.match(/^(\d{1,4}):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/);
  if (match) {
    let h = parseInt(match[1], 10);
    let m = parseInt(match[2], 10);
    let s = parseInt(match[3], 10);
    const frac = match[4] || '0';
    let ms = frac.length === 1
      ? parseInt(frac, 10) * 100
      : frac.length === 2
        ? parseInt(frac, 10) * 10
        : frac.length === 3
          ? parseInt(frac, 10)
          : Math.round(parseFloat(`0.${frac}`) * 1000);
    if (ms >= 1000) {
      s += Math.floor(ms / 1000);
      ms = ms % 1000;
    }
    if (s >= 60) {
      m += Math.floor(s / 60);
      s = s % 60;
    }
    if (m >= 60) {
      h += Math.floor(m / 60);
      m = m % 60;
    }
    if (h >= 0 && m >= 0 && s >= 0 && ms >= 0) {
      return { h, m, s, ms };
    }
  }
  // Support MM:SS.mmm (valid WebVTT short form without hours, including M >= 60 e.g. 65:12.300)
  const shortMatch = cleaned.match(/^(\d{1,4}):(\d{1,2})(?:[.,](\d+))?$/);
  if (shortMatch) {
    let m = parseInt(shortMatch[1], 10);
    let s = parseInt(shortMatch[2], 10);
    const frac = shortMatch[3] || '0';
    let ms = frac.length === 1
      ? parseInt(frac, 10) * 100
      : frac.length === 2
        ? parseInt(frac, 10) * 10
        : frac.length === 3
          ? parseInt(frac, 10)
          : Math.round(parseFloat(`0.${frac}`) * 1000);
    if (ms >= 1000) {
      s += Math.floor(ms / 1000);
      ms = ms % 1000;
    }
    if (s >= 60) {
      m += Math.floor(s / 60);
      s = s % 60;
    }
    const h = Math.floor(m / 60);
    m = m % 60;
    if (h >= 0 && m >= 0 && s >= 0 && ms >= 0) {
      return { h, m, s, ms };
    }
  }
  return null;
}

/**
 * Normalize raw timestamp directly to SRT format ("HH:MM:SS,mmm") without floating-point drift.
 */
export function normalizeTimestampToSRT(rawTimeStr: string | undefined, fallbackSeconds: number): string {
  const parts = parseTimestampParts(rawTimeStr);
  if (parts) {
    const pad = (num: number, size: number) => num.toString().padStart(size, '0');
    return `${pad(parts.h, 2)}:${pad(parts.m, 2)}:${pad(parts.s, 2)},${pad(parts.ms, 3)}`;
  }
  return secondsToSRT(fallbackSeconds);
}

/**
 * Normalize raw timestamp directly to VTT format ("HH:MM:SS.mmm") without floating-point drift.
 */
export function normalizeTimestampToVTT(rawTimeStr: string | undefined, fallbackSeconds: number): string {
  const parts = parseTimestampParts(rawTimeStr);
  if (parts) {
    const pad = (num: number, size: number) => num.toString().padStart(size, '0');
    return `${pad(parts.h, 2)}:${pad(parts.m, 2)}:${pad(parts.s, 2)}.${pad(parts.ms, 3)}`;
  }
  return secondsToVTT(fallbackSeconds);
}

/**
 * Normalize raw timestamp directly to ASS/SSA format ("H:MM:SS.cc") without floating-point drift.
 */
export function normalizeTimestampToASS(rawTimeStr: string | undefined, fallbackSeconds: number): string {
  const parts = parseTimestampParts(rawTimeStr);
  if (parts) {
    const pad = (num: number, size: number) => num.toString().padStart(size, '0');
    const cs = Math.floor(parts.ms / 10);
    return `${parts.h}:${pad(parts.m, 2)}:${pad(parts.s, 2)}.${pad(cs, 2)}`;
  }
  return secondsToASS(fallbackSeconds);
}

/**
 * Format seconds to MicroDVD frame format with configurable FPS
 */
export function secondsToFrame(seconds: number, fps = 25): number {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  return Math.round(seconds * fps);
}

/**
 * Detect format from filename or content
 */
export function detectFormat(filename: string, content: string): SubtitleFormat {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass') return 'ass';
  if (ext === 'ssa') return 'ssa';
  if (ext === 'sub') return 'sub';
  if (ext === 'srt') return 'srt';

  const cleanContent = content.replace(/^\uFEFF/, '').trimStart();
  if (cleanContent.startsWith('WEBVTT') || cleanContent.includes('\nWEBVTT')) return 'vtt';
  if (cleanContent.includes('[Script Info]') || cleanContent.includes('Dialogue:')) return 'ass';
  if (/^\{\d+\}\{\d+\}/m.test(cleanContent)) return 'sub';

  return 'srt';
}

/**
 * Main parser for subtitle files
 * FIX (B13/B14/B16/L8/L9): result now carries optional `warnings` (skipped/orphan blocks)
 * and `subFps` (MicroDVD FPS detected from the header) so exports stay faithful.
 */
export function parseSubtitleFile(content: string, filename: string): {
  items: SubtitleItem[];
  format: SubtitleFormat;
  rawHeader?: string;
  warnings?: string[];
  subFps?: number;
} {
  const format = detectFormat(filename, content);
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  switch (format) {
    case 'vtt':
      return parseVTT(normalized);
    case 'ass':
    case 'ssa':
      return parseASS(normalized, format);
    case 'sub':
      return parseSUB(normalized);
    case 'srt':
    default:
      return parseSRT(normalized);
  }
}

/**
 * SRT Parser - Timestamp Regex Anchored Block Extraction with timecode validation
 */
function parseSRT(content: string): { items: SubtitleItem[]; format: SubtitleFormat; warnings?: string[] } {
  const text = content.trim();
  const items: SubtitleItem[] = [];

  const timestampRegex = /(\d{1,2}:\d{2}:\d{2}[.,]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{2,3})/g;
  
  const matches: { index: number; startStr: string; endStr: string; fullMatch: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = timestampRegex.exec(text)) !== null) {
    matches.push({
      index: match.index,
      startStr: match[1],
      endStr: match[2],
      fullMatch: match[0],
    });
  }

  if (matches.length === 0) {
    return parseSRTFallback(text);
  }

  // FIX (B13): text that appears BEFORE the first timestamp used to be silently dropped.
  // Real cue numbers ("1") are ignored, but any other non-empty content becomes an orphan
  // cue at t=0 so the user's data is never lost silently.
  const warnings: string[] = [];
  const firstTimestamp = matches[0];
  if (firstTimestamp.index > 0) {
    const orphanPart = text.substring(0, firstTimestamp.index).trim();
    if (orphanPart) {
      const orphanLines = orphanPart.split('\n').map((l) => l.trim()).filter(Boolean);
      const meaningful = orphanLines.filter((l) => !/^\d+$/.test(l));
      if (meaningful.length > 0) {
        items.push({
          id: items.length + 1,
          startTime: '00:00:00,000',
          endTime: '00:00:00,000',
          startSeconds: 0,
          endSeconds: 0,
          originalText: meaningful.join('\n'),
          translatedText: '',
        });
        warnings.push(`یک بلوک متنی قبل از نخستین تایم‌استمپ بدون زمان به‌عنوان کیو حفظ شد (${meaningful.length} خط).`);
      }
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const nextMatchIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;

    const afterTimestampIndex = current.index + current.fullMatch.length;
    let blockTextPart = text.substring(afterTimestampIndex, nextMatchIndex);

    if (i + 1 < matches.length) {
      const textLines = blockTextPart.split('\n');
      while (textLines.length > 0 && textLines[textLines.length - 1].trim() === '') {
        textLines.pop();
      }
      // Trailing all-digits line immediately before the next timestamp is the next cue's index
      // if it matches expected sequence (i + 2) OR is separated by a blank line (handles skipped cue numbers in English SRTs).
      if (textLines.length > 0 && /^\d+$/.test(textLines[textLines.length - 1].trim())) {
        const trailingNumber = parseInt(textLines[textLines.length - 1].trim(), 10);
        const hasBlankLineAbove = textLines.length >= 2 && textLines[textLines.length - 2].trim() === '';
        if (trailingNumber === i + 2 || hasBlankLineAbove) {
          textLines.pop();
        }
      }
      blockTextPart = textLines.join('\n');
    }

    const cleanedText = blockTextPart.trim();
    const rawStart = timestampToSeconds(current.startStr);
    const rawEnd = timestampToSeconds(current.endStr);
    const { start: startSec, end: endSec } = validateAndSanitizeTimecodes(rawStart, rawEnd);

    items.push({
      id: items.length + 1,
      startTime: normalizeTimestampToSRT(current.startStr, startSec),
      endTime: normalizeTimestampToSRT(current.endStr, endSec),
      startSeconds: startSec,
      endSeconds: endSec,
      originalText: cleanedText,
      translatedText: '',
    });
  }

  // Preserve the load-warning for the UI (added by the B13 orphan-cue handling above)
  return warnings.length > 0 ? { items, format: 'srt' as SubtitleFormat, warnings } : { items, format: 'srt' as SubtitleFormat };
}

function parseSRTFallback(text: string): { items: SubtitleItem[]; format: SubtitleFormat } {
  const blocks = text.split(/\n\s*\n+/);
  const items: SubtitleItem[] = [];
  let autoId = 1;

  for (const block of blocks) {
    const lines = block.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    let timeLineIdx = 0;
    if (/^\d+$/.test(lines[0])) {
      timeLineIdx = 1;
    }

    const timeLine = lines[timeLineIdx];
    if (!timeLine || !timeLine.includes('-->')) continue;

    const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim());
    const textLines = lines.slice(timeLineIdx + 1).join('\n');

    const rawStart = timestampToSeconds(startStr);
    const rawEnd = timestampToSeconds(endStr);
    const { start: startSec, end: endSec } = validateAndSanitizeTimecodes(rawStart, rawEnd);

    items.push({
      id: autoId++,
      startTime: startStr.replace('.', ','),
      endTime: endStr.replace('.', ','),
      startSeconds: startSec,
      endSeconds: endSec,
      originalText: textLines,
      translatedText: '',
    });
  }

  return { items, format: 'srt' };
}

/**
 * WebVTT Parser preserving NOTE, STYLE, REGION header sections and cue settings
 * FIX (L9): mid-file NOTE/STYLE/REGION blocks are no longer merged into cue text (they are
 * preserved verbatim into the header), and cue identifier lines (e.g. "cue-1") are kept on the
 * item as `cueId` so the export can restore them.
 */
const isVttTimestampLine = (raw: string): boolean => {
  const trimmed = raw.trim();
  return /^(?:(?:\d{1,4}:)?\d{1,2}:)?\d{1,2}(?:[.,]\d+)?\s*-->\s*(?:(?:\d{1,4}:)?\d{1,2}:)?\d{1,2}(?:[.,]\d+)?(?:\s+.*)?$/.test(trimmed);
};

function parseVTT(content: string): { items: SubtitleItem[]; format: SubtitleFormat; rawHeader?: string; warnings?: string[] } {
  const lines = content.split('\n');
  const items: SubtitleItem[] = [];
  const headerBlocks: string[] = [];
  const warnings: string[] = [];
  let autoId = 1;

  let inHeader = true;
  let currentBlock: string[] = [];

  // A block-level VTT construct (NOTE/STYLE/REGION) — only valid at block boundary, NEVER inside an active cue
  const isBlockLevelKeyword = (raw: string) => /^(NOTE|STYLE|REGION)(?:\s|$)/i.test(raw.trim());

  let hasXTimestampMap = false;
  let hasInlineKaraokeTs = false;
  let nonMonotonicCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (/^X-TIMESTAMP-MAP=/i.test(line)) {
      hasXTimestampMap = true;
    }

    // Check if line is a genuine WebVTT timestamp line
    if (isVttTimestampLine(line)) {
      inHeader = false;
      // If currentBlock ALREADY has a cue timestamp, flush the prior cue first so back-to-back cues
      // without a separating blank line never merge together or drop cue #2's timestamps!
      if (currentBlock.some((l) => isVttTimestampLine(l))) {
        const lastLine = currentBlock[currentBlock.length - 1]?.trim() || '';
        const looksLikeCueId =
          currentBlock.length >= 2 &&
          !isVttTimestampLine(lastLine) &&
          (/^[\d]+$/.test(lastLine) || /^[A-Za-z0-9_.-]{1,32}$/.test(lastLine));

        if (looksLikeCueId && currentBlock.length >= 3) {
          const carriedCueId = currentBlock.pop()!;
          processVTTBlock(currentBlock, autoId++, items);
          currentBlock = [carriedCueId];
        } else {
          processVTTBlock(currentBlock, autoId++, items);
          currentBlock = [];
        }
      }
      currentBlock.push(rawLine);
      continue;
    }

    if (inHeader) {
      headerBlocks.push(rawLine);
      if (line === '' && headerBlocks.some((l) => l.trim() !== '')) {
        inHeader = false;
      }
      continue;
    }

    // Only treat NOTE/STYLE/REGION as block-level metadata when NOT already inside a cue
    if (currentBlock.length === 0 && isBlockLevelKeyword(rawLine)) {
      if (headerBlocks.length > 0 && headerBlocks[headerBlocks.length - 1].trim() !== '') {
        headerBlocks.push('');
      }
      headerBlocks.push(rawLine);
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') {
        i++;
        headerBlocks.push(lines[i]);
      }
      continue;
    }

    if (line === '') {
      if (currentBlock.length > 0) {
        processVTTBlock(currentBlock, autoId++, items);
        currentBlock = [];
      }
    } else {
      if (/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3}>/.test(rawLine)) {
        hasInlineKaraokeTs = true;
      }
      currentBlock.push(rawLine);
    }
  }

  if (currentBlock.length > 0) {
    processVTTBlock(currentBlock, autoId++, items);
  }

  for (let idx = 1; idx < items.length; idx++) {
    if (items[idx].startSeconds + 0.001 < items[idx - 1].startSeconds) {
      nonMonotonicCount++;
    }
  }

  if (hasXTimestampMap) {
    warnings.push('این فایل VTT دارای هدر HLS (X-TIMESTAMP-MAP) است که در خروجی استاندارد حذف می‌شود تا تایم‌بندی در پلیرها جابه‌جا نشود.');
  }
  if (hasInlineKaraokeTs) {
    warnings.push('فایل VTT ورودی دارای تایم‌کدهای درون‌خطی (شبیه زیرنویس خودکار یوتیوب) است.');
  }
  if (nonMonotonicCount > 0) {
    warnings.push(`در خود فایل VTT ورودی ${nonMonotonicCount} مورد تایم‌بندی نامرتب یا هم‌پوشانی زمانی مشاهده شد.`);
  }

  // Strip X-TIMESTAMP-MAP from saved header so standalone exports never suffer HLS MPEGTS clock drift
  const cleanedHeader = headerBlocks
    .filter((l) => !/^X-TIMESTAMP-MAP=/i.test(l.trim()))
    .join('\n')
    .trim();

  return {
    items,
    format: 'vtt',
    rawHeader: cleanedHeader,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function processVTTBlock(lines: string[], id: number, items: SubtitleItem[]) {
  let timeLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isVttTimestampLine(lines[i])) {
      timeLineIdx = i;
      break;
    }
  }

  if (timeLineIdx === -1) return;

  const timeLine = lines[timeLineIdx];
  const parts = timeLine.split('-->');
  if (parts.length < 2) return;

  const startPart = parts[0].trim();
  const endWithSettings = parts[1].trim();

  // WebVTT settings follow after end timestamp e.g. "00:01:25.000 line:0 position:20% align:start"
  const endTokens = endWithSettings.split(/\s+/);
  const endPart = endTokens[0];
  const settings = endTokens.slice(1).join(' ');

  const textLines = lines.slice(timeLineIdx + 1).join('\n').trim();

  // Capture cue identifier (any non-timestamp line(s) before the timestamp line)
  const identifierLines = lines.slice(0, timeLineIdx).map((l) => l.trim()).filter(Boolean);
  const cueId = identifierLines.length > 0 ? identifierLines[identifierLines.length - 1] : undefined;

  const rawStart = timestampToSeconds(startPart);
  const rawEnd = timestampToSeconds(endPart);
  const { start: startSec, end: endSec } = validateAndSanitizeTimecodes(rawStart, rawEnd);

  items.push({
    id,
    startTime: normalizeTimestampToVTT(startPart, startSec),
    endTime: normalizeTimestampToVTT(endPart, endSec),
    startSeconds: startSec,
    endSeconds: endSec,
    originalText: textLines,
    translatedText: '',
    styleTags: settings || undefined,
    cueId,
  });
}

/**
 * ASS/SSA Parser with dynamic Format: column mapping
 * FIX (B10): `Comment:` events are no longer converted into translatable Dialogue items.
 * They are preserved verbatim (exact columns + text) in the raw header so the export writes
 * them back as real Comment lines — technical notes stay off-screen and out of the translator.
 * FIX (B16): events with FEWER fields than the Format line are salvaged by scanning for the
 * timestamp pair instead of producing shifted meaningless items; unpar­seable events are
 * counted and reported through `warnings`.
 */
function parseASS(content: string, format: SubtitleFormat): {
  items: SubtitleItem[];
  format: SubtitleFormat;
  rawHeader?: string;
  warnings?: string[];
} {
  const lines = content.split('\n');
  const items: SubtitleItem[] = [];
  const headerLines: string[] = [];
  const warnings: string[] = [];
  let inEvents = false;
  let eventFormatCols: string[] = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let autoId = 1;

  // An ASS timestamp like 0:00:01.00 or 1:23:45.67
  const isAssTimestamp = (s: string) => /^\d+:\d{1,2}:\d{1,2}[.,]\d{1,3}$/.test(s.trim());

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[Events]')) {
      inEvents = true;
      headerLines.push(line);
      continue;
    }

    if (!inEvents) {
      headerLines.push(line);
      continue;
    }

    if (trimmed.startsWith('Format:')) {
      headerLines.push(line);
      const colsRaw = trimmed.substring(7).trim();
      eventFormatCols = colsRaw.split(',').map((c) => c.trim().toLowerCase());
      continue;
    }

    // FIX (B10): preserve Comment events verbatim — never translated, never displayed
    if (trimmed.startsWith('Comment:')) {
      headerLines.push(line);
      continue;
    }

    if (trimmed.startsWith('Dialogue:')) {
      const firstColonIdx = line.indexOf(':');
      if (firstColonIdx === -1) continue;

      const rest = line.substring(firstColonIdx + 1).trim();
      
      // Dynamic column parsing based on Format: specification
      const startColIdx = eventFormatCols.indexOf('start');
      const endColIdx = eventFormatCols.indexOf('end');
      const textColIdx = eventFormatCols.indexOf('text');
      const expectedFieldCount = eventFormatCols.length;

      // FIX (B16): first split WITHOUT limits to count the real fields on this line
      const allFields = rest.split(',').map((f) => f.trim());
      const isMalformed = allFields.length < expectedFieldCount;

      let startStr = '';
      let endStr = '';
      let rawText = '';
      let prefixParts: string[] = [];

      if (!isMalformed) {
        // Healthy line: split up to textColIdx commas so text can contain commas
        const splitLimit = Math.max(textColIdx !== -1 ? textColIdx : expectedFieldCount - 1, 1);
        const parts: string[] = [];
        let currentIdx = 0;

        for (let p = 0; p < splitLimit; p++) {
          const nextComma = rest.indexOf(',', currentIdx);
          if (nextComma === -1) break;
          parts.push(rest.substring(currentIdx, nextComma).trim());
          currentIdx = nextComma + 1;
        }
        parts.push(rest.substring(currentIdx)); // Remainder is text

        const startIdx = startColIdx !== -1 ? startColIdx : 1;
        const endIdx = endColIdx !== -1 ? endColIdx : 2;
        const textIdx = textColIdx !== -1 ? textColIdx : parts.length - 1;

        startStr = parts[startIdx] || '';
        endStr = parts[endIdx] || '';
        rawText = parts[textIdx] || '';
        prefixParts = parts.slice(0, textIdx);
      } else {
        // FIX (B16) salvage: locate the consecutive timestamp pair anywhere in the line.
        // Fields before the start timestamp remain the prefix; everything after the end
        // timestamp is the dialogue text (text may contain commas).
        let tsIdx = -1;
        for (let f = 0; f < allFields.length - 1; f++) {
          if (isAssTimestamp(allFields[f]) && isAssTimestamp(allFields[f + 1])) {
            tsIdx = f;
            break;
          }
        }

        if (tsIdx !== -1) {
          startStr = allFields[tsIdx];
          endStr = allFields[tsIdx + 1];
          prefixParts = allFields.slice(0, tsIdx);
          rawText = allFields.slice(tsIdx + 2).join(', ');
          if (warnings.length === 0) {
            warnings.push('تعدادی از رویدادهای ASS فیلد کمتری نسبت به خط Format داشتند و به‌صورت خودکار ترمیم شدند.');
          }
        } else {
          // No timestamps at all — cannot build a playable event; report and skip.
          if (warnings.length === 0) {
            warnings.push('یک یا چند رویداد ASS فاقد تایم‌استمپ معتبر بود و از خروجی حذف شد.');
          }
          continue;
        }
      }

      if (!startStr || !endStr) continue;

      const text = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n');

      const rawStart = timestampToSeconds(startStr);
      const rawEnd = timestampToSeconds(endStr);
      const { start: startSec, end: endSec } = validateAndSanitizeTimecodes(rawStart, rawEnd);

      items.push({
        id: autoId++,
        startTime: startStr,
        endTime: endStr,
        startSeconds: startSec,
        endSeconds: endSec,
        originalText: text,
        translatedText: '',
        styleTags: prefixParts.join(','),
      });
    } else {
      headerLines.push(line);
    }
  }

  return {
    items,
    format,
    rawHeader: headerLines.join('\n'),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * MicroDVD (.sub) Parser with header FPS auto-detection
 */
function parseSUB(content: string): { items: SubtitleItem[]; format: SubtitleFormat; subFps?: number } {
  const lines = content.trim().split('\n');
  const items: SubtitleItem[] = [];
  let autoId = 1;
  let detectedFps = 25;

  // Scan first 5 lines for {1}{1}23.976 or {1}{1}25.000 or {0}{0}25 FPS header
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const headerMatch = lines[i].trim().match(/^\{[01]\}\{[01]\}([0-9.]+)/);
    if (headerMatch) {
      const parsedFps = parseFloat(headerMatch[1]);
      if (isFinite(parsedFps) && parsedFps > 10 && parsedFps < 120) {
        detectedFps = parsedFps;
        break;
      }
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip the FPS definition line itself if present
    if (/^\{[01]\}\{[01]\}[0-9.]+$/.test(trimmed)) {
      continue;
    }

    const microDvdMatch = trimmed.match(/^\{(\d+)\}\{(\d+)\}(.*)/);
    if (microDvdMatch) {
      const startFrame = parseInt(microDvdMatch[1], 10);
      const endFrame = parseInt(microDvdMatch[2], 10);
      const rawStartSec = startFrame / detectedFps;
      const rawEndSec = endFrame / detectedFps;
      const { start: startSec, end: endSec } = validateAndSanitizeTimecodes(rawStartSec, rawEndSec);
      const text = microDvdMatch[3].replace(/\|/g, '\n');

      items.push({
        id: autoId++,
        startTime: secondsToSRT(startSec),
        endTime: secondsToSRT(endSec),
        startSeconds: startSec,
        endSeconds: endSec,
        originalText: text,
        translatedText: '',
      });
      continue;
    }

    if (trimmed.includes('-->') || trimmed.includes(',')) {
      const parts = trimmed.split(/-->|,/).map((s) => s.trim());
      if (parts.length >= 2 && parts[0].includes(':')) {
        const rawStart = timestampToSeconds(parts[0]);
        const rawEnd = timestampToSeconds(parts[1]);
        const { start: startSec, end: endSec } = validateAndSanitizeTimecodes(rawStart, rawEnd);
        items.push({
          id: autoId++,
          startTime: parts[0],
          endTime: parts[1],
          startSeconds: startSec,
          endSeconds: endSec,
          originalText: '',
          translatedText: '',
        });
      }
    }
  }

  // FIX (L8): expose the detected FPS so the export re-encodes with the SAME frame rate
  return { items, format: 'sub', subFps: detectedFps };
}

export const RTL_LANGUAGES = ['fa', 'ar', 'he', 'ur', 'ps'];

/**
 * Ensures proper rendering of RTL punctuation in media players
 */
export function fixRTLPunctuation(text: string): string {
  if (!text) return text;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.endsWith('\u200F')) return trimmed;
      return `${trimmed}\u200F`;
    })
    .join('\n');
}

/**
 * Export subtitles to requested format
 * FIX (L8): `subFps` lets MicroDVD exports keep the frame rate detected at parse time
 * instead of silently re-timing everything at 25fps.
 * FIX (B17): when appendRTLMarkers is false, any RTL markers that were already merged into
 * the text are stripped so the toggle is a true guarantee, not a suggestion.
 */
export function exportSubtitleFile(
  items: SubtitleItem[],
  targetFormat: SubtitleFormat,
  rawHeader?: string,
  isRTL?: boolean,
  appendRTLMarkers = true,
  subFps = 25
): string {
  const processedItems = items.map((item) => {
    const rawText = item.translatedText.trim() || item.originalText.trim();
    const containsRTL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(rawText);
    const applyRTLFix = appendRTLMarkers && (isRTL !== undefined ? isRTL : containsRTL);
    // FIX (B17): strip pre-existing hidden RTL marks when the option is OFF
    const markerFreeText = appendRTLMarkers ? rawText : rawText.replace(/\u200F/g, '');
    const textWithFix = applyRTLFix ? fixRTLPunctuation(markerFreeText) : markerFreeText;

    if (item.translatedText.trim()) {
      return { ...item, translatedText: textWithFix };
    }
    return { ...item, originalText: textWithFix };
  });

  switch (targetFormat) {
    case 'vtt':
      return exportVTT(processedItems, rawHeader);
    case 'ass':
    case 'ssa':
      return exportASS(processedItems, targetFormat, rawHeader);
    case 'sub':
      return exportSUB(processedItems, subFps);
    case 'srt':
    default:
      return exportSRT(processedItems);
  }
}

function exportSRT(items: SubtitleItem[]): string {
  return items
    .map((item, index) => {
      const text = item.translatedText.trim() || item.originalText.trim();
      const start = normalizeTimestampToSRT(item.startTime, item.startSeconds);
      const end = normalizeTimestampToSRT(item.endTime, item.endSeconds);
      return `${index + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

function isValidVttCueSettings(raw?: string): boolean {
  if (!raw || !raw.trim()) return false;
  const tokens = raw.trim().split(/\s+/);
  return tokens.every((tok) => /^(vertical|line|position|size|align|region):[^\s]+$/i.test(tok));
}

function exportVTT(items: SubtitleItem[], rawHeader?: string): string {
  const cleanedHeader = rawHeader && rawHeader.startsWith('WEBVTT')
    ? rawHeader
        .split('\n')
        .filter((l) => !/^X-TIMESTAMP-MAP=/i.test(l.trim()))
        .join('\n')
        .trim()
    : 'WEBVTT';
  const header = cleanedHeader.startsWith('WEBVTT') ? cleanedHeader : 'WEBVTT';
  const body = items
    .map((item) => {
      const text = item.translatedText.trim() || item.originalText.trim();
      const start = normalizeTimestampToVTT(item.startTime, item.startSeconds);
      const end = normalizeTimestampToVTT(item.endTime, item.endSeconds);
      const settingsStr = isValidVttCueSettings(item.styleTags) ? ` ${item.styleTags!.trim()}` : '';
      // FIX (L9): restore the cue identifier when the source file had one
      const idStr = item.cueId ? `${item.cueId}\n` : '';
      return `${idStr}${start} --> ${end}${settingsStr}\n${text}\n`;
    })
    .join('\n');

  return `${header}\n\n${body}`;
}

function exportASS(items: SubtitleItem[], _format: SubtitleFormat, rawHeader?: string): string {
  const header =
    rawHeader ||
    `[Script Info]
Title: Translated Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Vazirmatn,22,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const eventLines = items
    .map((item) => {
      const start = normalizeTimestampToASS(item.startTime, item.startSeconds);
      const end = normalizeTimestampToASS(item.endTime, item.endSeconds);
      const cleanText = (item.translatedText.trim() || item.originalText.trim()).replace(/\n/g, '\\N');
      let prefix = item.styleTags;
      if (prefix) {
        const parts = prefix.split(',');
        if (parts.length >= 3) {
          parts[1] = start;
          parts[2] = end;
          prefix = parts.join(',');
        } else {
          prefix = `0,${start},${end},Default,,0,0,0,`;
        }
      } else {
        prefix = `0,${start},${end},Default,,0,0,0,`;
      }
      return `Dialogue: ${prefix},${cleanText}`;
    })
    .join('\n');

  return `${header}\n${eventLines}\n`;
}

function exportSUB(items: SubtitleItem[], fps = 25): string {
  // FIX (L8): use the FPS detected from the source header (fallback 25) so the
  // frame-based timing in the output matches the original playback speed.
  const safeFps = isFinite(fps) && fps > 10 && fps < 120 ? fps : 25;
  const header = `{1}{1}${safeFps}\n`;
  const body = items
    .map((item) => {
      const startFrame = secondsToFrame(item.startSeconds, safeFps);
      const endFrame = secondsToFrame(item.endSeconds, safeFps);
      const text = (item.translatedText.trim() || item.originalText.trim()).replace(/\n/g, '|');
      return `{${startFrame}}{${endFrame}}${text}`;
    })
    .join('\n');
  return `${header}${body}`;
}
