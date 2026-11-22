import { SubtitleFolder, SubtitleFolderFile, SubtitleItem } from '../types';
import {
  formatMsToASS,
  formatMsToSRT,
  formatMsToVTT,
  parseTimestampToMs,
  resolveItemTimingMs,
  stripHallucinatedTimestamps,
  toEnglishDigits,
  verifySubtitleTimingIntegrity,
  exportSubtitleFile,
  RTL_LANGUAGES,
} from './subtitleParser';

export interface FileTimingUpgradeReport {
  file: SubtitleFolderFile;
  totalCues: number;
  fixedTimestampsCount: number;
  sanitizedPayloadsCount: number;
  removedOrphanHeadersCount: number;
  clampedInvalidDurationsCount: number;
  suspectedShiftCuesCount: number;
  verifiedZeroDrift: boolean;
  hasLosslessTemplate: boolean;
  changed: boolean;
}

export interface FolderTimingUpgradeReport {
  folder: SubtitleFolder;
  filesProcessed: number;
  filesChanged: number;
  totalFixedTimestamps: number;
  totalSanitizedPayloads: number;
  totalRemovedOrphanHeaders: number;
  filesWithSuspectedTextShift: string[];
  allVerifiedZeroDrift: boolean;
}

const LEGACY_VTT_HEADER_ORPHAN_RE =
  /^(?:WEBVTT(?:\s|$)|Kind\s*:|Language\s*:|X-TIMESTAMP-MAP\s*=|STYLE(?:\s|$)|REGION(?:\s|$)|NOTE(?:\s|$))/i;

const HIDDEN_BIDI_RE = /[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function hasLegacyOrphanHeaderCue(item: SubtitleItem, index: number): boolean {
  if (index > 2) return false;
  const orig = String(item.originalText || '').replace(HIDDEN_BIDI_RE, '').trim();
  if (!orig) return false;
  if (!LEGACY_VTT_HEADER_ORPHAN_RE.test(orig)) return false;

  // Orphan cues injected by legacy parsers typically sit at 00:00:00 -> 00:00:00 or 00:00:05
  const { startMs, endMs } = resolveItemTimingMs(item);
  return startMs === 0 && (endMs === 0 || endMs === 5000);
}

/**
 * Cleans cue-breaking artifacts inside translatedText without altering the actual Persian translation:
 * - Strips hallucinated/echoed SRT/VTT timestamps and cue numbers
 * - Replaces literal "-->" with "→"
 * - Removes empty blank lines (\n\n) that prematurely terminate VTT/SRT blocks in video players
 */
function cleanTranslatedPayloadPreservingText(rawText: string): { text: string; changed: boolean } {
  if (!rawText || typeof rawText !== 'string') {
    return { text: '', changed: false };
  }
  const withoutTimestamps = stripHallucinatedTimestamps(rawText);
  const normalized = withoutTimestamps
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/-->/g, '→');

  const lines = normalized
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const cleaned = lines.join('\n').trim();
  return {
    text: cleaned,
    changed: cleaned !== rawText.trim(),
  };
}

/**
 * Read-only offline heuristic detector for legacy LLM cue-merge text shifts.
 * NEVER mutates text — only counts strong signals where an older translation pass may have
 * merged two lines and shifted subsequent Persian translations onto adjacent timestamps.
 */
function detectSuspectedLegacyTextShift(items: SubtitleItem[]): number {
  if (items.length < 6) return 0;

  const normalize = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(HIDDEN_BIDI_RE, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{\\[^}]+\}/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  let suspected = 0;

  // Signal 1: Consecutive identical Persian translations for clearly distinct English cues
  for (let i = 0; i + 1 < items.length; i++) {
    const srcA = normalize(items[i].originalText);
    const srcB = normalize(items[i + 1].originalText);
    if (srcA.length < 10 || srcB.length < 10 || srcA === srcB) continue;

    const trA = normalize(items[i].translatedText);
    const trB = normalize(items[i + 1].translatedText);
    if (trA.length >= 8 && trA === trB) {
      suspected++;
    }
  }

  // Signal 2: Distinct numeric anchors (e.g. years/amounts like 1998, 250, 45) present in
  // English cue N, absent from Persian cue N, yet present in Persian cue N-1!
  const extractDistinctNums = (s: string): string[] => {
    const ascii = toEnglishDigits(s);
    const matches = ascii.match(/\b\d{2,4}\b/g) || [];
    return Array.from(new Set(matches));
  };

  let shiftedNumberHits = 0;
  for (let i = 1; i < items.length; i++) {
    const origNums = extractDistinctNums(items[i].originalText);
    if (origNums.length === 0) continue;

    const curTrNums = new Set(extractDistinctNums(items[i].translatedText));
    const prevOrigNums = new Set(extractDistinctNums(items[i - 1].originalText));
    const prevTrNums = new Set(extractDistinctNums(items[i - 1].translatedText));

    for (const num of origNums) {
      if (!curTrNums.has(num) && !prevOrigNums.has(num) && prevTrNums.has(num)) {
        shiftedNumberHits++;
        break;
      }
    }
  }

  if (shiftedNumberHits >= 2) {
    suspected += shiftedNumberHits;
  }

  return suspected;
}

/**
 * Upgrades any legacy or already-translated SubtitleFolderFile to the new Zero-Drift
 * integer-millisecond timing engine WITHOUT re-translating a single line (0 AI tokens!).
 */
export function upgradeFileWithNewTimingEngine(
  file: SubtitleFolderFile,
  targetLanguage = 'fa',
  appendRTLMarkers = false
): FileTimingUpgradeReport {
  const originalItems = Array.isArray(file.items) ? file.items : [];
  let fixedTimestampsCount = 0;
  let sanitizedPayloadsCount = 0;
  let removedOrphanHeadersCount = 0;
  let clampedInvalidDurationsCount = 0;

  const extractedHeaderLines: string[] = [];
  const filteredItems: SubtitleItem[] = [];

  originalItems.forEach((item, idx) => {
    if (hasLegacyOrphanHeaderCue(item, idx)) {
      removedOrphanHeadersCount++;
      extractedHeaderLines.push(String(item.originalText || '').trim());
      return;
    }
    filteredItems.push(item);
  });

  // Preserve or salvage rawHeader if orphan VTT header lines were extracted
  let nextRawHeader = file.rawHeader;
  if (extractedHeaderLines.length > 0 && file.sourceFormat === 'vtt') {
    const combined = extractedHeaderLines.join('\n').trim();
    if (/^WEBVTT\b/i.test(combined) && (!nextRawHeader || !/^WEBVTT\b/i.test(nextRawHeader))) {
      nextRawHeader = combined;
    } else if (/X-TIMESTAMP-MAP\s*=/i.test(combined) && nextRawHeader && !/X-TIMESTAMP-MAP\s*=/i.test(nextRawHeader)) {
      nextRawHeader = `${nextRawHeader.trim()}\n${combined}`;
    }
  }

  const formatCanonical = (ms: number): string => {
    if (file.sourceFormat === 'vtt') return formatMsToVTT(ms);
    if (file.sourceFormat === 'ass' || file.sourceFormat === 'ssa') return formatMsToASS(ms);
    return formatMsToSRT(ms);
  };

  const upgradedItems: SubtitleItem[] = filteredItems.map((item, idx) => {
    const rawStartParsed = parseTimestampToMs(item.startTime);
    const rawEndParsed = parseTimestampToMs(item.endTime);

    const { startMs, endMs } = resolveItemTimingMs(item);
    const hadInvertedDuration = rawStartParsed !== null && rawEndParsed !== null && rawEndParsed < rawStartParsed;
    if (hadInvertedDuration) {
      clampedInvalidDurationsCount++;
    }

    const canonicalStart = formatCanonical(startMs);
    const canonicalEnd = formatCanonical(endMs);

    const hasNonAsciiStart = item.startTime !== toEnglishDigits(item.startTime);
    const hasNonAsciiEnd = item.endTime !== toEnglishDigits(item.endTime);
    const timingFormatChanged =
      hasNonAsciiStart ||
      hasNonAsciiEnd ||
      item.startTime !== canonicalStart ||
      item.endTime !== canonicalEnd ||
      item.startMs !== startMs ||
      item.endMs !== endMs ||
      Math.abs((item.startSeconds || 0) - startMs / 1000) > 0.0005 ||
      Math.abs((item.endSeconds || 0) - endMs / 1000) > 0.0005;

    if (timingFormatChanged) {
      fixedTimestampsCount++;
    }

    const cleanedPayload = cleanTranslatedPayloadPreservingText(item.translatedText);
    if (cleanedPayload.changed && item.translatedText.trim().length > 0) {
      sanitizedPayloadsCount++;
    }

    // Re-index sequentially ONLY if an orphan header cue was removed so IDs stay contiguous 1..N
    const nextId = removedOrphanHeadersCount > 0 ? idx + 1 : item.id;

    return {
      ...item,
      id: nextId,
      startTime: canonicalStart,
      endTime: canonicalEnd,
      startSeconds: startMs / 1000,
      endSeconds: endMs / 1000,
      startMs,
      endMs,
      rawStartTime: item.rawStartTime ? toEnglishDigits(item.rawStartTime) : canonicalStart,
      rawEndTime: item.rawEndTime ? toEnglishDigits(item.rawEndTime) : canonicalEnd,
      translatedText: item.translatedText.trim().length > 0 ? cleanedPayload.text : item.translatedText,
    };
  });

  const suspectedShiftCuesCount = detectSuspectedLegacyTextShift(upgradedItems);
  const hasLosslessTemplate = Boolean(
    file.rawSourceText &&
    file.sourceCueSpans &&
    file.sourceCueSpans.length === upgradedItems.length &&
    removedOrphanHeadersCount === 0
  );

  const upgradedFile: SubtitleFolderFile = {
    ...file,
    rawHeader: nextRawHeader,
    // If orphan cues were removed, invalidate stale spans so the pure integer-ms exporter runs cleanly
    sourceCueSpans: removedOrphanHeadersCount > 0 ? undefined : file.sourceCueSpans,
    items: upgradedItems,
    timingUpgradedAt: Date.now(),
    suspectedShiftCuesCount,
  };

  // Self-verify zero-drift exportability in VTT (the streaming target format)
  const isRTL = RTL_LANGUAGES.includes(targetLanguage);
  let verifiedZeroDrift = true;
  if (upgradedItems.length > 0) {
    const testFormat: 'vtt' | 'srt' = file.sourceFormat === 'srt' ? 'srt' : 'vtt';
    const testExport = exportSubtitleFile(
      upgradedItems,
      testFormat,
      upgradedFile.rawHeader,
      isRTL,
      appendRTLMarkers,
      upgradedFile.subFps || 25,
      hasLosslessTemplate
        ? {
            rawSourceText: upgradedFile.rawSourceText,
            sourceFormat: upgradedFile.sourceFormat,
            sourceCueSpans: upgradedFile.sourceCueSpans,
          }
        : undefined
    );
    const audit = verifySubtitleTimingIntegrity(upgradedItems, testExport, testFormat);
    verifiedZeroDrift = audit.valid;
  }

  const changed =
    fixedTimestampsCount > 0 ||
    sanitizedPayloadsCount > 0 ||
    removedOrphanHeadersCount > 0 ||
    !file.timingUpgradedAt ||
    file.suspectedShiftCuesCount !== suspectedShiftCuesCount;

  return {
    file: upgradedFile,
    totalCues: upgradedItems.length,
    fixedTimestampsCount,
    sanitizedPayloadsCount,
    removedOrphanHeadersCount,
    clampedInvalidDurationsCount,
    suspectedShiftCuesCount,
    verifiedZeroDrift,
    hasLosslessTemplate,
    changed,
  };
}

/**
 * Upgrades EVERY file inside a SubtitleFolder using the new zero-drift timing engine (0 AI tokens).
 */
export function upgradeFolderWithNewTimingEngine(
  folder: SubtitleFolder,
  targetLanguage = 'fa',
  appendRTLMarkers = false
): FolderTimingUpgradeReport {
  let filesChanged = 0;
  let totalFixedTimestamps = 0;
  let totalSanitizedPayloads = 0;
  let totalRemovedOrphanHeaders = 0;
  let allVerifiedZeroDrift = true;
  const filesWithSuspectedTextShift: string[] = [];

  const nextFiles = folder.files.map((file) => {
    const rep = upgradeFileWithNewTimingEngine(file, targetLanguage, appendRTLMarkers);
    if (rep.changed) filesChanged++;
    totalFixedTimestamps += rep.fixedTimestampsCount;
    totalSanitizedPayloads += rep.sanitizedPayloadsCount;
    totalRemovedOrphanHeaders += rep.removedOrphanHeadersCount;
    if (!rep.verifiedZeroDrift) allVerifiedZeroDrift = false;
    if (rep.suspectedShiftCuesCount > 0) {
      filesWithSuspectedTextShift.push(file.fileName);
    }
    return rep.file;
  });

  return {
    folder: {
      ...folder,
      updatedAt: Date.now(),
      files: nextFiles,
    },
    filesProcessed: folder.files.length,
    filesChanged,
    totalFixedTimestamps,
    totalSanitizedPayloads,
    totalRemovedOrphanHeaders,
    filesWithSuspectedTextShift,
    allVerifiedZeroDrift,
  };
}
