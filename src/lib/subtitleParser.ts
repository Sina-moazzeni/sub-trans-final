import { SubtitleItem, SubtitleFormat, SubtitleCueSpan } from '../types';
import { detectEncodingAndDecodeText as detectEncodingAndDecode } from './encodingHelper';

export { detectEncodingAndDecode };

// ============================================================================
// SUBTITLE TIMING & FORMAT ENGINE
// ZERO-DRIFT INTEGER-MILLISECOND + LOSSLESS SOURCE-TEMPLATE SPLICING ARCHITECTURE
// ============================================================================

export const RTL_LANGUAGES = ['fa', 'ar', 'he', 'ur', 'ps', 'ckb', 'ku', 'sd'];

const PERSIAN_ARABIC_DIGITS: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

const HIDDEN_BIDI_RE = /[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Converts any Persian (۰-۹) or Arabic-Indic (٠-٩) numerals to standard ASCII English digits (0-9).
 */
export function toEnglishDigits(str: string): string {
  if (!str) return '';
  return String(str).replace(/[۰-۹٠-٩]/g, (ch) => PERSIAN_ARABIC_DIGITS[ch] ?? ch);
}

/**
 * Strict timestamp-to-integer-milliseconds parser.
 * Supports:
 * - HH:MM:SS.mmm / HH:MM:SS,mmm (1-4 digit hours, 1-6 fractional digits)
 * - MM:SS.mmm / MM:SS,mmm (W3C WebVTT short form)
 * - HH:MM:SS / MM:SS (no fractional component)
 * - H:MM:SS.cc (ASS/SSA centiseconds — 2 fractional digits -> *10 ms)
 *
 * Uses pure integer arithmetic to guarantee ZERO floating-point rounding drift.
 * Returns null if the input is not a valid timestamp.
 */
export function parseTimestampToMs(raw: string): number | null {
  if (!raw || typeof raw !== 'string') return null;

  const cleaned = toEnglishDigits(raw)
    .replace(HIDDEN_BIDI_RE, '')
    .trim();

  if (!cleaned) return null;

  // Require at least MM:SS (at least one colon) so plain numbers never parse as timestamps
  const match = cleaned.match(
    /^(\d{1,4}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,6}))?$/
  );
  if (!match) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (match[3] !== undefined) {
    // HH:MM:SS(.frac)
    hours = parseInt(match[1], 10);
    minutes = parseInt(match[2], 10);
    seconds = parseInt(match[3], 10);
  } else {
    // MM:SS(.frac)
    minutes = parseInt(match[1], 10);
    seconds = parseInt(match[2], 10);
  }

  let ms = 0;
  if (match[4] !== undefined) {
    const frac = match[4];
    if (frac.length === 1) {
      ms = parseInt(frac, 10) * 100;
    } else if (frac.length === 2) {
      ms = parseInt(frac, 10) * 10;
    } else if (frac.length === 3) {
      ms = parseInt(frac, 10);
    } else {
      // 4-6 fractional digits (microseconds) -> round cleanly to nearest integer ms
      ms = Math.round(parseInt(frac.slice(0, 6).padEnd(6, '0'), 10) / 1000);
    }
  }

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(ms) ||
    hours < 0 ||
    minutes < 0 ||
    seconds < 0
  ) {
    return null;
  }

  return ((hours * 3600) + (minutes * 60) + seconds) * 1000 + ms;
}

/**
 * Formats integer milliseconds into canonical ASCII SRT timestamp: HH:MM:SS,mmm
 */
export function formatMsToSRT(totalMs: number): string {
  const safeMs = Number.isFinite(totalMs) ? Math.max(0, Math.round(totalMs)) : 0;
  const hrs = Math.floor(safeMs / 3_600_000);
  const mins = Math.floor((safeMs % 3_600_000) / 60_000);
  const secs = Math.floor((safeMs % 60_000) / 1000);
  const ms = safeMs % 1000;

  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Formats integer milliseconds into canonical ASCII WebVTT timestamp: HH:MM:SS.mmm
 */
export function formatMsToVTT(totalMs: number): string {
  const safeMs = Number.isFinite(totalMs) ? Math.max(0, Math.round(totalMs)) : 0;
  const hrs = Math.floor(safeMs / 3_600_000);
  const mins = Math.floor((safeMs % 3_600_000) / 60_000);
  const secs = Math.floor((safeMs % 60_000) / 1000);
  const ms = safeMs % 1000;

  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Formats integer milliseconds into canonical ASCII ASS/SSA timestamp: H:MM:SS.cc
 */
export function formatMsToASS(totalMs: number): string {
  const safeMs = Number.isFinite(totalMs) ? Math.max(0, Math.round(totalMs)) : 0;
  const totalCs = Math.round(safeMs / 10);
  const hrs = Math.floor(totalCs / 360_000);
  const mins = Math.floor((totalCs % 360_000) / 6_000);
  const secs = Math.floor((totalCs % 6_000) / 100);
  const cs = totalCs % 100;

  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Parses a timestamp string into seconds (derived from exact integer ms).
 */
export function timestampToSeconds(timestamp: string): number {
  const ms = parseTimestampToMs(timestamp);
  return ms !== null ? ms / 1000 : 0;
}

/**
 * Formats seconds into canonical SRT format: HH:MM:SS,mmm
 */
export function secondsToSRT(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00,000';
  return formatMsToSRT(Math.round(seconds * 1000));
}

/**
 * Formats seconds into canonical WebVTT format: HH:MM:SS.mmm
 */
export function secondsToVTT(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00.000';
  return formatMsToVTT(Math.round(seconds * 1000));
}

/**
 * Formats seconds into canonical ASS/SSA format: H:MM:SS.cc
 */
export function secondsToASS(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00:00.00';
  return formatMsToASS(Math.round(seconds * 1000));
}

/**
 * Formats seconds into MicroDVD frame number.
 */
export function secondsToFrame(seconds: number, fps = 25): number {
  const safeFps = fps > 0 && fps < 200 ? fps : 25;
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.max(0, Math.round(seconds * safeFps));
}

/**
 * Normalizes any valid timestamp string directly to canonical SRT format (HH:MM:SS,mmm)
 * without passing through floating-point seconds.
 */
export function normalizeTimestampToSRT(rawTimestamp: string, fallbackSeconds = 0): string {
  const ms = parseTimestampToMs(rawTimestamp);
  if (ms !== null) return formatMsToSRT(ms);
  return secondsToSRT(fallbackSeconds);
}

/**
 * Normalizes any valid timestamp string directly to canonical VTT format (HH:MM:SS.mmm)
 * without passing through floating-point seconds.
 */
export function normalizeTimestampToVTT(rawTimestamp: string, fallbackSeconds = 0): string {
  const ms = parseTimestampToMs(rawTimestamp);
  if (ms !== null) return formatMsToVTT(ms);
  return secondsToVTT(fallbackSeconds);
}

/**
 * Normalizes any valid timestamp string directly to canonical ASS format (H:MM:SS.cc)
 * without passing through floating-point seconds.
 */
export function normalizeTimestampToASS(rawTimestamp: string, fallbackSeconds = 0): string {
  const ms = parseTimestampToMs(rawTimestamp);
  if (ms !== null) return formatMsToASS(ms);
  return secondsToASS(fallbackSeconds);
}

/**
 * Resolves exact integer start & end milliseconds for any SubtitleItem.
 * Priority:
 *  1) item.startTime / item.endTime (preserves manual edits & time shifts, parsed in pure integer ms)
 *  2) item.rawStartTime / item.rawEndTime (immutable original source timestamp)
 *  3) item.startMs / item.endMs (exact integer ms stored at parse time)
 *  4) item.startSeconds / item.endSeconds * 1000 (legacy fallback)
 *
 * Guarantees startMs >= 0 and endMs >= startMs WITHOUT altering valid timings by even 1ms.
 */
export function resolveItemTimingMs(item: SubtitleItem): { startMs: number; endMs: number } {
  let startMs =
    parseTimestampToMs(item.startTime) ??
    (item.rawStartTime ? parseTimestampToMs(item.rawStartTime) : null) ??
    (typeof item.startMs === 'number' && Number.isFinite(item.startMs) ? Math.round(item.startMs) : null) ??
    Math.round((Number.isFinite(item.startSeconds) ? item.startSeconds : 0) * 1000);

  let endMs =
    parseTimestampToMs(item.endTime) ??
    (item.rawEndTime ? parseTimestampToMs(item.rawEndTime) : null) ??
    (typeof item.endMs === 'number' && Number.isFinite(item.endMs) ? Math.round(item.endMs) : null) ??
    Math.round((Number.isFinite(item.endSeconds) ? item.endSeconds : 0) * 1000);

  if (startMs < 0) startMs = 0;
  if (endMs < startMs) endMs = startMs;

  return { startMs, endMs };
}

/**
 * Backward-compatible validator/sanitizer for start/end seconds pair.
 */
export function validateAndSanitizeTimecodes(
  startSeconds: number,
  endSeconds: number
): { startSeconds: number; endSeconds: number } {
  const start = Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds : 0;
  const end = Number.isFinite(endSeconds) && endSeconds >= start ? endSeconds : start;
  return { startSeconds: start, endSeconds: end };
}

/**
 * Fix RTL punctuation layout issues (e.g. question mark, semicolon)
 * while preserving tags, line breaks, and clean UTF-8 text.
 */
export function fixRTLPunctuation(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\s0-9.,!?؟،؛:"'()\-–—…«»]+$/.test(trimmed)) {
        return trimmed.replace(/\?/g, '؟').replace(/;/g, '؛');
      }
      return trimmed;
    })
    .join('\n');
}

/**
 * Strips any hallucinated/echoed SRT/VTT cue headers or timestamp lines from AI-returned text
 * so a rogue timestamp inside a translation can NEVER break VTT/SRT cue boundaries.
 */
export function stripHallucinatedTimestamps(text: string): string {
  if (!text || typeof text !== 'string') return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const cleanedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (matchTimingLine(line)) {
      // If the immediately preceding line we just pushed was a lone cue index number before this echoed timestamp, drop it too
      if (
        cleanedLines.length > 0 &&
        /^\d+$/.test(toEnglishDigits(cleanedLines[cleanedLines.length - 1]).trim())
      ) {
        cleanedLines.pop();
      }
      continue;
    }
    cleanedLines.push(line);
  }

  return cleanedLines.join('\n').trim();
}

/**
 * Sanitizes cue text payload for SRT / WebVTT output so it can NEVER break block boundaries
 * or trick video stream players into mis-parsing subsequent cues:
 * - Normalizes CRLF/CR to LF
 * - Strips hallucinated timestamp lines
 * - Removes empty blank lines inside a cue body (blank lines terminate VTT/SRT cues!)
 * - Replaces literal "-->" inside dialogue text with "→"
 */
export function sanitizeCuePayloadText(
  text: string,
  isRTL: boolean,
  appendRTLMarkers: boolean
): string {
  const withoutEchoedTimings = stripHallucinatedTimestamps(String(text ?? ''));
  const normalized = withoutEchoedTimings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/-->/g, '→');

  const lines = normalized
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return '';

  const joined = lines.join('\n');
  const formatted = isRTL ? fixRTLPunctuation(joined) : joined;

  if (isRTL && appendRTLMarkers) {
    return formatted
      .split('\n')
      .map((line) => (line.trim() && !line.endsWith('\u200F') ? `${line}\u200F` : line))
      .join('\n');
  }

  return formatted;
}

/**
 * Extracts ONLY valid W3C WebVTT cue settings tokens (vertical, line, position, size, align, region)
 * so arbitrary garbage or ASS style tags never corrupt a WebVTT timing line.
 */
function extractValidVttCueSettings(raw?: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const tokens = raw
    .replace(HIDDEN_BIDI_RE, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((tok) => /^(?:vertical|line|position|size|align|region):[^\s]+$/i.test(tok));
  return tokens.join(' ');
}

export interface ParsedSubtitleResult {
  items: SubtitleItem[];
  format: SubtitleFormat;
  rawHeader?: string;
  rawSourceText?: string;
  sourceCueSpans?: SubtitleCueSpan[];
  subFps?: number;
  warnings?: string[];
  hasXTimestampMap?: boolean;
}

export interface SourceTemplateExportMeta {
  rawSourceText?: string;
  sourceFormat?: SubtitleFormat;
  sourceCueSpans?: SubtitleCueSpan[];
}

// ============================================================================
// STRICT CUE TIMING REGEX (SHARED BY SRT & WEBVTT PARSERS)
// Requires at least MM:SS (one colon) on BOTH start and end so dialogue like
// "1 --> 2" can NEVER falsely split a subtitle cue!
// ============================================================================
const CUE_TIMING_LINE_RE =
  /^\s*((?:\d{1,4}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,6})?)\s*-->\s*((?:\d{1,4}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,6})?)(?:\s+(.*))?$/;

interface MatchedTimingLine {
  startRaw: string;
  endRaw: string;
  startMs: number;
  endMs: number;
  settings: string;
}

function matchTimingLine(line: string): MatchedTimingLine | null {
  if (!line || !line.includes('-->')) return null;
  const cleaned = toEnglishDigits(line).replace(HIDDEN_BIDI_RE, '');
  const m = cleaned.match(CUE_TIMING_LINE_RE);
  if (!m) return null;

  const startRaw = m[1].trim();
  const endRaw = m[2].trim();
  const startMs = parseTimestampToMs(startRaw);
  const endMs = parseTimestampToMs(endRaw);
  if (startMs === null || endMs === null) return null;

  return {
    startRaw,
    endRaw,
    startMs,
    endMs,
    settings: (m[3] || '').trim(),
  };
}

/**
 * Computes exact UTF-16 character start & end offsets for every line in LF-normalized text.
 * Enables 100% lossless byte-for-byte source-template splicing on export.
 */
function computeLineOffsets(normalizedText: string): {
  lines: string[];
  lineStarts: number[];
  lineEnds: number[];
} {
  const lines = normalizedText.split('\n');
  const lineStarts: number[] = new Array(lines.length);
  const lineEnds: number[] = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = pos;
    pos += lines[i].length;
    lineEnds[i] = pos;
    pos += 1; // '\n'
  }
  return { lines, lineStarts, lineEnds };
}

/**
 * Content-First Subtitle Format Detector:
 * Inspects actual file content signature BEFORE extension so renamed files
 * (e.g. a WebVTT file saved as .srt or .txt) are NEVER mis-parsed!
 */
export function detectFormat(content: string, fileName: string): SubtitleFormat {
  const cleanHead = String(content || '').replace(/^\uFEFF/, '').trimStart();

  // 1. Content signatures take highest precedence
  if (/^WEBVTT(?:\s|$)/i.test(cleanHead)) {
    return 'vtt';
  }
  if (/^\[Script Info\]/im.test(cleanHead.slice(0, 4000)) || /^Dialogue:\s*\d+,/im.test(cleanHead.slice(0, 4000))) {
    return cleanHead.toLowerCase().includes('[v4 styles]') ? 'ssa' : 'ass';
  }
  if (/^\{\d+\}\{\d+\}/.test(cleanHead)) {
    return 'sub';
  }

  // 2. Fall back to extension when content is standard timestamp-based
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass') return 'ass';
  if (ext === 'ssa') return 'ssa';
  if (ext === 'sub') return 'sub';

  return 'srt';
}

/**
 * Ground-Up W3C Spec-Compliant SRT Parser with Exact Source-Span Tracking
 * - Anchors strictly on validated timestamp lines
 * - Preserves exact integer millisecond timestamps, raw strings, and character spans
 * - Never injects fake 00:00:00,000 orphan cues that shift cue IDs
 */
export function parseSRT(content: string): ParsedSubtitleResult {
  const cleanContent = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const { lines, lineStarts, lineEnds } = computeLineOffsets(cleanContent);
  const items: SubtitleItem[] = [];
  const sourceCueSpans: SubtitleCueSpan[] = [];
  const warnings: string[] = [];

  // Identify all valid timing line indices first for unambiguous cue boundary detection
  const timingEntries: Array<{ lineIdx: number; timing: MatchedTimingLine }> = [];
  for (let i = 0; i < lines.length; i++) {
    const matched = matchTimingLine(lines[i]);
    if (matched) {
      timingEntries.push({ lineIdx: i, timing: matched });
    }
  }

  for (let idx = 0; idx < timingEntries.length; idx++) {
    const { lineIdx, timing } = timingEntries[idx];
    const nextTimingLineIdx = idx + 1 < timingEntries.length ? timingEntries[idx + 1].lineIdx : lines.length;

    // Determine end of current cue payload (stop before next cue's optional numeric index & blank lines)
    let payloadEnd = nextTimingLineIdx;
    if (idx + 1 < timingEntries.length) {
      let cursor = nextTimingLineIdx - 1;
      if (cursor > lineIdx) {
        const maybeIndexLine = toEnglishDigits(lines[cursor]).replace(HIDDEN_BIDI_RE, '').trim();
        if (/^\d+$/.test(maybeIndexLine)) {
          const beforeIndexIsBlank =
            cursor - 1 <= lineIdx || lines[cursor - 1].trim() === '';
          if (beforeIndexIsBlank || cursor > lineIdx + 1) {
            cursor--;
          }
        }
      }
      while (cursor > lineIdx && lines[cursor].trim() === '') {
        cursor--;
      }
      payloadEnd = cursor + 1;
    } else {
      let cursor = lines.length - 1;
      while (cursor > lineIdx && lines[cursor].trim() === '') {
        cursor--;
      }
      payloadEnd = cursor + 1;
    }

    // Find exact first and last non-empty payload line indices for lossless source splicing
    let firstPayloadLine = lineIdx + 1;
    while (firstPayloadLine < payloadEnd && lines[firstPayloadLine].trim() === '') {
      firstPayloadLine++;
    }
    let lastPayloadLine = payloadEnd - 1;
    while (lastPayloadLine >= firstPayloadLine && lines[lastPayloadLine].trim() === '') {
      lastPayloadLine--;
    }

    const textLines = firstPayloadLine <= lastPayloadLine
      ? lines.slice(firstPayloadLine, lastPayloadLine + 1).map((l) => l.replace(/\r/g, '').trimEnd())
      : [];

    const originalText = textLines.join('\n').trim();
    const startMs = Math.max(0, timing.startMs);
    let endMs = timing.endMs;
    if (endMs < startMs) {
      warnings.push(`Cue #${items.length + 1}: end timestamp was earlier than start timestamp; clamped to start.`);
      endMs = startMs;
    }

    const canonicalStart = formatMsToSRT(startMs);
    const canonicalEnd = formatMsToSRT(endMs);
    const cueNum = items.length + 1;

    items.push({
      id: cueNum,
      startTime: canonicalStart,
      endTime: canonicalEnd,
      startSeconds: startMs / 1000,
      endSeconds: endMs / 1000,
      startMs,
      endMs,
      rawStartTime: timing.startRaw,
      rawEndTime: timing.endRaw,
      originalText,
      translatedText: '',
    });

    if (firstPayloadLine <= lastPayloadLine) {
      sourceCueSpans.push({
        id: cueNum,
        textStart: lineStarts[firstPayloadLine],
        textEnd: lineEnds[lastPayloadLine],
        startMs,
        endMs,
        startTime: canonicalStart,
        endTime: canonicalEnd,
      });
    } else {
      // Empty payload cue — anchor zero-width span right at end of timing line
      sourceCueSpans.push({
        id: cueNum,
        textStart: lineEnds[lineIdx],
        textEnd: lineEnds[lineIdx],
        startMs,
        endMs,
        startTime: canonicalStart,
        endTime: canonicalEnd,
      });
    }
  }

  return {
    items,
    format: 'srt',
    rawSourceText: cleanContent,
    sourceCueSpans,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Ground-Up W3C Spec-Compliant WebVTT Parser with Exact Source-Span Tracking
 * - Preserves 100% of original file structure for lossless template splicing:
 *   WEBVTT, Kind:, Language:, X-TIMESTAMP-MAP, STYLE, REGION, mid-file NOTE blocks,
 *   exact cue IDs, exact timestamp format (MM:SS.mmm or HH:MM:SS.mmm), and cue settings!
 * - Properly ignores mid-file NOTE / STYLE / REGION blocks during cue parsing without
 *   contaminating cue text or shifting cue IDs
 * - Preserves exact integer millisecond startMs / endMs with 0ms drift
 */
export function parseVTT(content: string): ParsedSubtitleResult {
  const cleanContent = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const { lines, lineStarts, lineEnds } = computeLineOffsets(cleanContent);
  const items: SubtitleItem[] = [];
  const sourceCueSpans: SubtitleCueSpan[] = [];
  const warnings: string[] = [];

  // Find the first valid cue timing line so we cleanly separate the WebVTT header from cue blocks
  let firstTimingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (matchTimingLine(lines[i])) {
      firstTimingIdx = i;
      break;
    }
  }

  // Check if line immediately before firstTimingIdx is a cueId (not a VTT header/NOTE/STYLE/REGION)
  let headerEndLineIdx = firstTimingIdx === -1 ? lines.length : firstTimingIdx;
  if (firstTimingIdx > 0) {
    const prevLine = lines[firstTimingIdx - 1].trim();
    const prevPrevLine = firstTimingIdx >= 2 ? lines[firstTimingIdx - 2].trim() : '';
    const isHeaderDirective =
      /^WEBVTT\b/i.test(prevLine) ||
      /^(?:Kind|Language|X-TIMESTAMP-MAP)\s*[:=]/i.test(prevLine) ||
      /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(prevLine);
    const isCueIdAfterBlankOrWebvtt =
      prevLine !== '' &&
      !isHeaderDirective &&
      (prevPrevLine === '' || (/^\d+$/.test(toEnglishDigits(prevLine)) && /^WEBVTT\b/i.test(prevPrevLine)));

    if (isCueIdAfterBlankOrWebvtt) {
      headerEndLineIdx = firstTimingIdx - 1;
    }
  }

  // Build exact preserved VTT header (including X-TIMESTAMP-MAP, STYLE, REGION, Kind, Language)
  const rawHeaderLines = lines.slice(0, headerEndLineIdx);
  while (rawHeaderLines.length > 0 && rawHeaderLines[rawHeaderLines.length - 1].trim() === '') {
    rawHeaderLines.pop();
  }
  const rawHeaderText = rawHeaderLines.join('\n').trim();
  const hasXTimestampMap = /X-TIMESTAMP-MAP\s*=/i.test(rawHeaderText);
  const rawHeader = rawHeaderText && /^WEBVTT\b/i.test(rawHeaderText)
    ? rawHeaderText
    : 'WEBVTT';

  if (firstTimingIdx === -1) {
    return {
      items: [],
      format: 'vtt',
      rawHeader,
      rawSourceText: cleanContent,
      sourceCueSpans: [],
      hasXTimestampMap,
    };
  }

  // Parse all blocks starting from headerEndLineIdx using a strict W3C WebVTT block state machine
  let i = headerEndLineIdx;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') {
      i++;
    }
    if (i >= lines.length) break;

    const firstLine = lines[i].trim();

    // Skip mid-file NOTE, STYLE, REGION blocks completely (up to next blank line)
    if (
      /^NOTE(?:\s|$)/.test(firstLine) ||
      /^STYLE(?:\s|$)/.test(firstLine) ||
      /^REGION(?:\s|$)/.test(firstLine)
    ) {
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        i++;
      }
      continue;
    }

    // Check whether line `i` is a cue timing line OR a cue identifier followed by a timing line
    let cueId: string | undefined;
    let timing = matchTimingLine(lines[i]);
    let timingLineIdx = i;

    if (!timing) {
      if (i + 1 < lines.length && !lines[i].includes('-->')) {
        const nextTiming = matchTimingLine(lines[i + 1]);
        if (nextTiming) {
          cueId = lines[i].trim();
          timing = nextTiming;
          i++; // advance to timing line
          timingLineIdx = i;
        }
      }
    }

    if (!timing) {
      i++;
      continue;
    }

    // Advance past the timing line and collect cue payload lines with exact line indices
    i++;
    const payloadLineIndices: number[] = [];
    const payloadLines: string[] = [];
    while (i < lines.length) {
      const curLine = lines[i];
      const trimmedCur = curLine.trim();

      // Blank line terminates cue per W3C WebVTT spec
      if (trimmedCur === '') {
        i++;
        break;
      }

      // Defensive recovery for malformed VTTs missing blank lines between consecutive cues
      if (matchTimingLine(curLine)) {
        break;
      }
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(trimmedCur)) {
        break;
      }
      if (
        /^\d+$/.test(toEnglishDigits(trimmedCur).replace(HIDDEN_BIDI_RE, '')) &&
        i + 1 < lines.length &&
        matchTimingLine(lines[i + 1])
      ) {
        break;
      }

      payloadLineIndices.push(i);
      payloadLines.push(curLine.replace(/\r/g, '').trimEnd());
      i++;
    }

    const startMs = Math.max(0, timing.startMs);
    let endMs = timing.endMs;
    if (endMs < startMs) {
      warnings.push(`Cue #${items.length + 1}: end timestamp was earlier than start timestamp; clamped to start.`);
      endMs = startMs;
    }

    const canonicalStart = formatMsToVTT(startMs);
    const canonicalEnd = formatMsToVTT(endMs);
    const validCueSettings = extractValidVttCueSettings(timing.settings);
    const cueNum = items.length + 1;

    items.push({
      id: cueNum,
      startTime: canonicalStart,
      endTime: canonicalEnd,
      startSeconds: startMs / 1000,
      endSeconds: endMs / 1000,
      startMs,
      endMs,
      rawStartTime: timing.startRaw,
      rawEndTime: timing.endRaw,
      cueSettings: validCueSettings || undefined,
      cueId: cueId || undefined,
      originalText: payloadLines.join('\n').trim(),
      translatedText: '',
    });

    if (payloadLineIndices.length > 0) {
      const firstIdx = payloadLineIndices[0];
      const lastIdx = payloadLineIndices[payloadLineIndices.length - 1];
      sourceCueSpans.push({
        id: cueNum,
        textStart: lineStarts[firstIdx],
        textEnd: lineEnds[lastIdx],
        startMs,
        endMs,
        startTime: canonicalStart,
        endTime: canonicalEnd,
      });
    } else {
      sourceCueSpans.push({
        id: cueNum,
        textStart: lineEnds[timingLineIdx],
        textEnd: lineEnds[timingLineIdx],
        startMs,
        endMs,
        startTime: canonicalStart,
        endTime: canonicalEnd,
      });
    }
  }

  return {
    items,
    format: 'vtt',
    rawHeader,
    rawSourceText: cleanContent,
    sourceCueSpans,
    hasXTimestampMap,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Parse ASS / SSA Subtitle Format
 */
export function parseASS(content: string): ParsedSubtitleResult {
  const cleanContent = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = cleanContent.split('\n');
  const items: SubtitleItem[] = [];
  const headerLines: string[] = [];
  let inEventsSection = false;
  let formatColumns: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.toLowerCase() === '[events]') {
      inEventsSection = true;
      headerLines.push(line);
      continue;
    }

    if (!inEventsSection) {
      headerLines.push(line);
      continue;
    }

    if (trimmed.toLowerCase().startsWith('format:')) {
      headerLines.push(line);
      formatColumns = trimmed
        .substring(7)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      continue;
    }

    if (trimmed.toLowerCase().startsWith('dialogue:')) {
      const rest = line.substring(line.indexOf(':') + 1).trim();
      const expectedParts = formatColumns.length > 0 ? formatColumns.length : 10;
      const parts: string[] = [];
      let currentIdx = 0;

      for (let i = 0; i < expectedParts - 1; i++) {
        const commaIdx = rest.indexOf(',', currentIdx);
        if (commaIdx === -1) break;
        parts.push(rest.substring(currentIdx, commaIdx));
        currentIdx = commaIdx + 1;
      }
      parts.push(rest.substring(currentIdx));

      const startIdx = formatColumns.indexOf('start') !== -1 ? formatColumns.indexOf('start') : 1;
      const endIdx = formatColumns.indexOf('end') !== -1 ? formatColumns.indexOf('end') : 2;
      const textIdx = formatColumns.indexOf('text') !== -1 ? formatColumns.indexOf('text') : parts.length - 1;

      const rawStart = toEnglishDigits((parts[startIdx] || '0:00:00.00').trim());
      const rawEnd = toEnglishDigits((parts[endIdx] || '0:00:05.00').trim());
      const rawText = (parts[textIdx] || '').trim();
      const normalizedText = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n');
      const stylePrefix = parts.slice(0, textIdx).join(',');

      const parsedStartMs = parseTimestampToMs(rawStart) ?? 0;
      const parsedEndMs = Math.max(parsedStartMs, parseTimestampToMs(rawEnd) ?? parsedStartMs);

      items.push({
        id: items.length + 1,
        startTime: formatMsToASS(parsedStartMs),
        endTime: formatMsToASS(parsedEndMs),
        startSeconds: parsedStartMs / 1000,
        endSeconds: parsedEndMs / 1000,
        startMs: parsedStartMs,
        endMs: parsedEndMs,
        rawStartTime: rawStart,
        rawEndTime: rawEnd,
        originalText: normalizedText,
        translatedText: '',
        styleTags: stylePrefix,
      });
    } else if (!trimmed.startsWith('Comment:')) {
      headerLines.push(line);
    }
  }

  return {
    items,
    format: content.toLowerCase().includes('[v4 styles]') ? 'ssa' : 'ass',
    rawHeader: headerLines.join('\n'),
  };
}

/**
 * Parse MicroDVD (.sub) Format: {startFrame}{endFrame}Text
 */
export function parseSUB(content: string, fps = 25): ParsedSubtitleResult {
  const cleanContent = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = cleanContent.split('\n');
  const items: SubtitleItem[] = [];
  let effectiveFps = fps;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
    if (match) {
      const startFrame = parseInt(match[1], 10);
      const endFrame = parseInt(match[2], 10);
      const rawText = match[3].trim();

      if (startFrame === 1 && endFrame === 1 && /^\d+(?:\.\d+)?$/.test(rawText)) {
        const headerFps = parseFloat(rawText);
        if (headerFps > 0 && headerFps < 200) {
          effectiveFps = headerFps;
        }
        continue;
      }

      const startMs = Math.max(0, Math.round((startFrame / effectiveFps) * 1000));
      const endMs = Math.max(startMs, Math.round((endFrame / effectiveFps) * 1000));
      const normalizedText = rawText.replace(/\|/g, '\n');

      items.push({
        id: items.length + 1,
        startTime: formatMsToSRT(startMs),
        endTime: formatMsToSRT(endMs),
        startSeconds: startMs / 1000,
        endSeconds: endMs / 1000,
        startMs,
        endMs,
        rawStartTime: formatMsToSRT(startMs),
        rawEndTime: formatMsToSRT(endMs),
        originalText: normalizedText,
        translatedText: '',
      });
    }
  }

  return {
    items,
    format: 'sub',
    subFps: effectiveFps,
  };
}

/**
 * Master Auto-Detecting Subtitle Parser (Content-Signature First)
 */
export function parseSubtitleFile(content: string, fileName: string): ParsedSubtitleResult {
  const format = detectFormat(content, fileName);
  switch (format) {
    case 'vtt':
      return parseVTT(content);
    case 'ass':
    case 'ssa':
      return parseASS(content);
    case 'sub':
      return parseSUB(content);
    case 'srt':
    default:
      return parseSRT(content);
  }
}

// ============================================================================
// LOSSLESS SOURCE-TEMPLATE SPLICER + ZERO-DRIFT SYNTHETIC EXPORTERS
// ============================================================================

/**
 * Attempts 100% lossless source-template splicing for same-format SRT/VTT exports.
 * Replaces ONLY the cue text payload spans while leaving EVERY byte of headers,
 * X-TIMESTAMP-MAP, STYLE, REGION, NOTE blocks, cue IDs, exact timestamp strings,
 * cue settings, and blank lines 100.000% identical to the original English file.
 *
 * Returns null safely if timestamps were manually shifted/edited, rows were added/removed,
 * or source template metadata is absent — in which case the pure integer-ms exporter runs.
 */
function tryLosslessTemplateSplice(
  items: SubtitleItem[],
  targetFormat: 'srt' | 'vtt',
  isRTL: boolean,
  appendRTLMarkers: boolean,
  sourceMeta?: SourceTemplateExportMeta
): string | null {
  if (
    !sourceMeta ||
    sourceMeta.sourceFormat !== targetFormat ||
    typeof sourceMeta.rawSourceText !== 'string' ||
    sourceMeta.rawSourceText.length === 0 ||
    !Array.isArray(sourceMeta.sourceCueSpans) ||
    sourceMeta.sourceCueSpans.length === 0 ||
    sourceMeta.sourceCueSpans.length !== items.length
  ) {
    return null;
  }

  const raw = sourceMeta.rawSourceText;
  const spans = sourceMeta.sourceCueSpans;

  // For WebVTT, verify the raw template starts cleanly with WEBVTT (so stream players accept it)
  if (targetFormat === 'vtt' && !/^WEBVTT(?:\s|$)/i.test(raw.trimStart())) {
    return null;
  }

  // Verify every single item's resolved timing matches its source span with 0ms difference
  // and spans are strictly non-overlapping and within bounds
  let prevEnd = -1;
  for (let i = 0; i < items.length; i++) {
    const span = spans[i];
    if (
      !span ||
      span.textStart < 0 ||
      span.textEnd < span.textStart ||
      span.textEnd > raw.length ||
      span.textStart < prevEnd
    ) {
      return null;
    }
    prevEnd = span.textEnd;

    const currentTiming = resolveItemTimingMs(items[i]);
    if (currentTiming.startMs !== span.startMs || currentTiming.endMs !== span.endMs) {
      // User manually edited or time-shifted timestamps — fall back to pure-integer exporter
      return null;
    }
  }

  // Splice cue payloads from back to front so earlier character offsets never shift
  let result = raw;
  for (let i = items.length - 1; i >= 0; i--) {
    const span = spans[i];
    const item = items[i];
    const rawText = (item.translatedText && item.translatedText.trim().length > 0)
      ? item.translatedText
      : item.originalText;
    const sanitized = sanitizeCuePayloadText(rawText, isRTL, appendRTLMarkers);

    if (span.textStart === span.textEnd) {
      // Cue originally had empty payload: insert newline + payload if non-empty
      if (sanitized.length > 0) {
        result = result.slice(0, span.textStart) + '\n' + sanitized + result.slice(span.textEnd);
      }
    } else {
      // Preserve cue even if sanitized somehow came out empty by keeping a zero-width safe fallback
      const replacement = sanitized.length > 0 ? sanitized : raw.slice(span.textStart, span.textEnd);
      result = result.slice(0, span.textStart) + replacement + result.slice(span.textEnd);
    }
  }

  // Ensure clean UTF-8 without BOM and trailing newline
  const cleanResult = result.replace(/^\uFEFF/, '');
  const finalOutput = cleanResult.endsWith('\n') ? cleanResult : `${cleanResult}\n`;

  // Final round-trip self-audit: guarantee 0ms drift and exact 1:1 cue count before returning!
  const check = verifySubtitleTimingIntegrity(items, finalOutput, targetFormat);
  if (!check.valid) {
    return null;
  }

  return finalOutput;
}

/**
 * Export SubtitleItem[] to standard SRT format with 100% exact ASCII timestamps (0ms drift).
 */
export function exportSRT(
  items: SubtitleItem[],
  isRTL = false,
  appendRTLMarkers = false,
  sourceMeta?: SourceTemplateExportMeta
): string {
  if (!items || items.length === 0) return '';

  const spliced = tryLosslessTemplateSplice(items, 'srt', isRTL, appendRTLMarkers, sourceMeta);
  if (spliced !== null) return spliced;

  const blocks = items.map((item, idx) => {
    const { startMs, endMs } = resolveItemTimingMs(item);
    const startStr = formatMsToSRT(startMs);
    const endStr = formatMsToSRT(endMs);

    const rawText = (item.translatedText && item.translatedText.trim().length > 0)
      ? item.translatedText
      : item.originalText;
    const text = sanitizeCuePayloadText(rawText, isRTL, appendRTLMarkers);

    return `${idx + 1}\n${startStr} --> ${endStr}\n${text}`;
  });

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Export SubtitleItem[] to W3C Spec-Compliant & Video-Stream-Ready WebVTT format:
 * - Uses 100% lossless source-template splicing when source is WebVTT and timings are unmodified
 * - Clean UTF-8 (NO BOM — first 6 bytes are strictly "WEBVTT")
 * - Preserves source VTT header metadata including X-TIMESTAMP-MAP, STYLE, REGION, Kind, Language
 * - Uses 100% exact integer-ms ASCII HH:MM:SS.mmm timestamps (0ms drift!)
 * - Preserves valid W3C cue settings (align, line, position, size, vertical, region)
 * - Sanitizes cue payloads so blank lines or "-->" never break video stream parsing
 */
export function exportVTT(
  items: SubtitleItem[],
  isRTL = false,
  rawHeader?: string,
  appendRTLMarkers = false,
  sourceMeta?: SourceTemplateExportMeta
): string {
  if (items && items.length > 0) {
    const spliced = tryLosslessTemplateSplice(items, 'vtt', isRTL, appendRTLMarkers, sourceMeta);
    if (spliced !== null) return spliced;
  }

  // Build clean W3C WebVTT header
  let header = 'WEBVTT';
  if (rawHeader && typeof rawHeader === 'string') {
    const cleanHeader = rawHeader
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    if (/^WEBVTT(?:\s|$)/i.test(cleanHeader)) {
      header = cleanHeader;
    }
  }

  if (!items || items.length === 0) {
    return `${header}\n\n`;
  }

  const blocks = items.map((item) => {
    const { startMs, endMs } = resolveItemTimingMs(item);
    const startStr = formatMsToVTT(startMs);
    const endStr = formatMsToVTT(endMs);

    const settings = extractValidVttCueSettings(item.cueSettings || item.styleTags);
    const timingLine = settings
      ? `${startStr} --> ${endStr} ${settings}`
      : `${startStr} --> ${endStr}`;

    const rawText = (item.translatedText && item.translatedText.trim().length > 0)
      ? item.translatedText
      : item.originalText;
    const text = sanitizeCuePayloadText(rawText, isRTL, appendRTLMarkers);

    const safeCueId =
      item.cueId &&
      item.cueId.trim().length > 0 &&
      !item.cueId.includes('-->') &&
      !item.cueId.includes('\n') &&
      !item.cueId.includes('\r')
        ? item.cueId.trim()
        : '';

    const lines: string[] = [];
    if (safeCueId) lines.push(safeCueId);
    lines.push(timingLine);
    if (text.length > 0) lines.push(text);

    return lines.join('\n');
  });

  return `${header}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * Export SubtitleItem[] to ASS / SSA format
 */
export function exportASS(
  items: SubtitleItem[],
  rawHeader?: string,
  isRTL = false,
  appendRTLMarkers = false
): string {
  const defaultHeader = `[Script Info]
Title: SubGame Lab Translated Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Vazirmatn,22,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const hasAssHeader = Boolean(rawHeader && /\[Script Info\]/i.test(rawHeader));
  const header = hasAssHeader ? rawHeader!.trim() : defaultHeader;

  const eventLines = items
    .map((item) => {
      const { startMs, endMs } = resolveItemTimingMs(item);
      const startStr = formatMsToASS(startMs);
      const endStr = formatMsToASS(endMs);

      const rawText = (item.translatedText && item.translatedText.trim().length > 0)
        ? item.translatedText
        : item.originalText;
      const sanitized = sanitizeCuePayloadText(rawText, isRTL, appendRTLMarkers);
      const assText = sanitized.replace(/\n/g, '\\N');

      let prefix = item.styleTags;
      if (prefix && !/^(?:vertical|line|position|size|align|region):/i.test(prefix.trim())) {
        const parts = prefix.split(',');
        if (parts.length >= 9) {
          parts[1] = startStr;
          parts[2] = endStr;
          prefix = parts.join(',');
        } else {
          prefix = `0,${startStr},${endStr},Default,,0,0,0,`;
        }
      } else {
        prefix = `0,${startStr},${endStr},Default,,0,0,0,`;
      }

      return `Dialogue: ${prefix},${assText}`;
    })
    .join('\n');

  return `${header}\n${eventLines}\n`;
}

/**
 * Export SubtitleItem[] to MicroDVD (.sub) format
 */
export function exportSUB(
  items: SubtitleItem[],
  fps = 25,
  isRTL = false,
  appendRTLMarkers = false
): string {
  const safeFps = fps > 0 && fps < 200 ? fps : 25;
  return (
    items
      .map((item) => {
        const { startMs, endMs } = resolveItemTimingMs(item);
        const startFrame = Math.max(0, Math.round((startMs / 1000) * safeFps));
        const endFrame = Math.max(startFrame + 1, Math.round((endMs / 1000) * safeFps));
        const rawText = (item.translatedText && item.translatedText.trim().length > 0)
          ? item.translatedText
          : item.originalText;
        const text = sanitizeCuePayloadText(rawText, isRTL, appendRTLMarkers).replace(/\n/g, '|');
        return `{${startFrame}}{${endFrame}}${text}`;
      })
      .join('\n') + '\n'
  );
}

/**
 * Master Subtitle Exporter
 */
export function exportSubtitleFile(
  items: SubtitleItem[],
  targetFormat: SubtitleFormat,
  rawHeader?: string,
  isRTL = false,
  appendRTLMarkers = false,
  fps = 25,
  sourceMeta?: SourceTemplateExportMeta
): string {
  switch (targetFormat) {
    case 'vtt':
      return exportVTT(items, isRTL, rawHeader, appendRTLMarkers, sourceMeta);
    case 'ass':
    case 'ssa':
      return exportASS(items, rawHeader, isRTL, appendRTLMarkers);
    case 'sub':
      return exportSUB(items, fps, isRTL, appendRTLMarkers);
    case 'srt':
    default:
      return exportSRT(items, isRTL, appendRTLMarkers, sourceMeta);
  }
}

// ============================================================================
// BUILT-IN TIMING INTEGRITY VERIFIER & ORIGINAL-SOURCE RE-SYNC ENGINE
// ============================================================================

export interface TimingIntegrityReport {
  valid: boolean;
  totalCues: number;
  exportedCues: number;
  matchedCues: number;
  maxDriftMs: number;
  mismatchedIndices: number[];
  error?: string;
}

/**
 * Re-parses the generated SRT or VTT export string and verifies:
 *  1) Exact 1:1 cue count equality
 *  2) 0ms drift on BOTH start and end timestamps for EVERY SINGLE cue
 */
export function verifySubtitleTimingIntegrity(
  sourceItems: SubtitleItem[],
  exportedContent: string,
  targetFormat: 'srt' | 'vtt'
): TimingIntegrityReport {
  const reparsed = targetFormat === 'vtt'
    ? parseVTT(exportedContent)
    : parseSRT(exportedContent);

  const totalCues = sourceItems.length;
  const exportedCues = reparsed.items.length;
  const mismatchedIndices: number[] = [];
  let maxDriftMs = 0;
  let matchedCues = 0;

  const compareCount = Math.min(totalCues, exportedCues);
  for (let i = 0; i < compareCount; i++) {
    const src = resolveItemTimingMs(sourceItems[i]);
    const exp = resolveItemTimingMs(reparsed.items[i]);
    const driftStart = Math.abs(exp.startMs - src.startMs);
    const driftEnd = Math.abs(exp.endMs - src.endMs);
    const cueDrift = Math.max(driftStart, driftEnd);
    if (cueDrift > maxDriftMs) maxDriftMs = cueDrift;

    if (cueDrift === 0) {
      matchedCues++;
    } else {
      mismatchedIndices.push(i + 1);
    }
  }

  const valid = totalCues === exportedCues && mismatchedIndices.length === 0 && maxDriftMs === 0;
  return {
    valid,
    totalCues,
    exportedCues,
    matchedCues,
    maxDriftMs,
    mismatchedIndices,
    error: valid
      ? undefined
      : totalCues !== exportedCues
        ? `Cue count mismatch: expected ${totalCues}, exported ${exportedCues}`
        : `Timing drift detected (max ${maxDriftMs}ms) at cues: ${mismatchedIndices.slice(0, 5).join(', ')}`,
  };
}

export interface TimingResyncReport {
  items: SubtitleItem[];
  matchedCount: number;
  adjustedCount: number;
  maxFixedDriftMs: number;
  unmatchedCount: number;
}

export interface FullSourceResyncReport extends TimingResyncReport {
  sourceFormat: SubtitleFormat;
  rawHeader?: string;
  rawSourceText?: string;
  sourceCueSpans?: SubtitleCueSpan[];
  countMismatch: boolean;
  originalCount: number;
  existingCount: number;
  hasXTimestampMap?: boolean;
}

function normalizeTextForAnchorMatch(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\\[^}]+\}/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Re-locks 100% exact timestamps, cueSettings, and cueIds from an original English
 * reference subtitle file onto an already-translated SubtitleItem[] without losing
 * any translated Persian text (0 AI tokens!).
 */
export function resyncItemsFromReferenceSubtitles(
  existingItems: SubtitleItem[],
  referenceItems: SubtitleItem[]
): TimingResyncReport {
  if (existingItems.length === 0 || referenceItems.length === 0) {
    return {
      items: existingItems,
      matchedCount: 0,
      adjustedCount: 0,
      maxFixedDriftMs: 0,
      unmatchedCount: existingItems.length,
    };
  }

  let matchedCount = 0;
  let adjustedCount = 0;
  let maxFixedDriftMs = 0;
  let unmatchedCount = 0;

  // Fast exact 1:1 path when cue counts match
  if (existingItems.length === referenceItems.length) {
    const synced = existingItems.map((item, idx) => {
      const ref = referenceItems[idx];
      const oldTiming = resolveItemTimingMs(item);
      const refTiming = resolveItemTimingMs(ref);
      const drift = Math.max(
        Math.abs(oldTiming.startMs - refTiming.startMs),
        Math.abs(oldTiming.endMs - refTiming.endMs)
      );
      if (drift > 0) {
        adjustedCount++;
        if (drift > maxFixedDriftMs) maxFixedDriftMs = drift;
      }
      matchedCount++;
      return {
        ...item,
        startTime: ref.startTime,
        endTime: ref.endTime,
        startSeconds: ref.startSeconds,
        endSeconds: ref.endSeconds,
        startMs: ref.startMs,
        endMs: ref.endMs,
        rawStartTime: ref.rawStartTime,
        rawEndTime: ref.rawEndTime,
        cueSettings: ref.cueSettings,
        cueId: ref.cueId,
      };
    });

    return {
      items: synced,
      matchedCount,
      adjustedCount,
      maxFixedDriftMs,
      unmatchedCount: 0,
    };
  }

  // Fallback anchor-matching path when old parser had an orphan cue or split cue
  const existingQueueByText = new Map<string, SubtitleItem[]>();
  existingItems.forEach((ex) => {
    const key = normalizeTextForAnchorMatch(ex.originalText);
    if (!key) return;
    const list = existingQueueByText.get(key) || [];
    list.push(ex);
    existingQueueByText.set(key, list);
  });

  const rebuilt: SubtitleItem[] = referenceItems.map((ref, idx) => {
    const key = normalizeTextForAnchorMatch(ref.originalText);
    const candidates = key ? existingQueueByText.get(key) : undefined;
    const matchedExisting = candidates && candidates.length > 0
      ? candidates.shift()!
      : existingItems[idx];

    if (matchedExisting) {
      const oldTiming = resolveItemTimingMs(matchedExisting);
      const refTiming = resolveItemTimingMs(ref);
      const drift = Math.max(
        Math.abs(oldTiming.startMs - refTiming.startMs),
        Math.abs(oldTiming.endMs - refTiming.endMs)
      );
      if (drift > 0) {
        adjustedCount++;
        if (drift > maxFixedDriftMs) maxFixedDriftMs = drift;
      }
      matchedCount++;
      return {
        ...ref,
        id: idx + 1,
        translatedText: matchedExisting.translatedText || '',
      };
    }

    unmatchedCount++;
    return {
      ...ref,
      id: idx + 1,
    };
  });

  return {
    items: rebuilt,
    matchedCount,
    adjustedCount,
    maxFixedDriftMs,
    unmatchedCount,
  };
}

/**
 * Full zero-token re-sync from an original English subtitle file's raw text:
 * - Re-parses the authoritative original English file (capturing rawHeader, X-TIMESTAMP-MAP,
 *   rawSourceText, and exact sourceCueSpans)
 * - Re-locks every single cue timestamp onto the already-translated items
 * - Enables 100% lossless template-spliced export on existing translated folders!
 */
export function resyncFileFromOriginalSource(
  existingItems: SubtitleItem[],
  originalRawText: string,
  originalFileName: string
): FullSourceResyncReport {
  const parsed = parseSubtitleFile(originalRawText, originalFileName);
  const resync = resyncItemsFromReferenceSubtitles(existingItems, parsed.items);

  return {
    ...resync,
    sourceFormat: parsed.format,
    rawHeader: parsed.rawHeader,
    rawSourceText: parsed.rawSourceText,
    sourceCueSpans: parsed.sourceCueSpans,
    countMismatch: existingItems.length !== parsed.items.length,
    originalCount: parsed.items.length,
    existingCount: existingItems.length,
    hasXTimestampMap: parsed.hasXTimestampMap,
  };
}
