import { SubtitleFolder, SubtitleFolderFile, SubtitleItem } from '../types';
import { isCodeOnlyOrSkippable } from './gameLocalizationParser';

const NON_LATIN_TARGET_REGEX: Record<string, RegExp> = {
  fa: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  ar: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  ur: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  ps: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  he: /[\u0590-\u05FF]/,
  ru: /[\u0400-\u04FF]/,
  uk: /[\u0400-\u04FF]/,
  bg: /[\u0400-\u04FF]/,
  el: /[\u0370-\u03FF]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/,
  zh: /[\u4E00-\u9FFF]/,
  'zh-cn': /[\u4E00-\u9FFF]/,
  'zh-tw': /[\u4E00-\u9FFF]/,
  hi: /[\u0900-\u097F]/,
  th: /[\u0E00-\u0E7F]/,
};

function stripFormattingAndBidi(text: string): string {
  return (text || '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\\[^}]+\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determines whether a subtitle/game item still needs translation into `targetLanguage`.
 * - Empty source lines or pure code/number/symbol cues do NOT block 100% completion.
 * - Empty translatedText counts as incomplete.
 * - For non-Latin target languages (e.g. Persian 'fa'), lines left verbatim in English
 *   or containing multi-word English text with zero target-script characters count as incomplete.
 */
export function isItemTranslationIncomplete(
  item: Pick<SubtitleItem, 'originalText' | 'translatedText'>,
  targetLanguage = 'fa'
): boolean {
  const cleanOriginal = stripFormattingAndBidi(item.originalText);
  if (!cleanOriginal || isCodeOnlyOrSkippable(cleanOriginal)) {
    return false;
  }

  const cleanTranslated = stripFormattingAndBidi(item.translatedText);
  if (!cleanTranslated) {
    return true;
  }

  const normTarget = (targetLanguage || 'fa').toLowerCase().trim();
  const targetScriptRegex = NON_LATIN_TARGET_REGEX[normTarget];

  if (targetScriptRegex) {
    const hasTargetScript = targetScriptRegex.test(cleanTranslated);
    if (!hasTargetScript) {
      const latinLetters = (cleanTranslated.match(/[A-Za-z]/g) || []).length;
      const latinWords = (cleanTranslated.match(/[A-Za-z]{2,}/g) || []).length;
      const isIdenticalToOriginal = cleanTranslated.toLowerCase() === cleanOriginal.toLowerCase();

      // Verbatim English line (e.g. "Wait for me", "Hello") left untranslated
      if (isIdenticalToOriginal && latinLetters >= 3) {
        // Ignore single short ALL-CAPS acronyms like "FBI", "CIA", "USA", "OK", "TV"
        const isShortAcronym = /^[A-Z0-9.\-!?]{2,4}$/.test(cleanOriginal);
        if (!isShortAcronym) {
          return true;
        }
      }

      // Multi-word or longer English phrase returned with zero target-language letters
      if (latinWords >= 2 || latinLetters >= 6) {
        return true;
      }
    }
  }

  return false;
}

export interface FileCompletionStats {
  total: number;
  completed: number;
  missingCount: number;
  missingItemIds: number[];
  pct: number;
  isDone: boolean;
}

export function getFileCompletionStats(
  file: SubtitleFolderFile,
  targetLanguage = 'fa'
): FileCompletionStats {
  const total = file.items.length;
  if (total === 0) {
    return { total: 0, completed: 0, missingCount: 0, missingItemIds: [], pct: 0, isDone: false };
  }

  const missingItemIds: number[] = [];
  for (const item of file.items) {
    if (isItemTranslationIncomplete(item, targetLanguage)) {
      missingItemIds.push(item.id);
    }
  }

  const missingCount = missingItemIds.length;
  const completed = total - missingCount;
  const pct = missingCount === 0 ? 100 : Math.min(99, Math.floor((completed / total) * 100));

  return {
    total,
    completed,
    missingCount,
    missingItemIds,
    pct,
    isDone: missingCount === 0,
  };
}

export interface FolderCompletionStats {
  fileCount: number;
  totalLines: number;
  completedLines: number;
  missingLines: number;
  incompleteFiles: SubtitleFolderFile[];
  incompleteFileCount: number;
  completedFileCount: number;
  pct: number;
  isDone: boolean;
}

export function getFolderCompletionStats(
  folder: SubtitleFolder,
  targetLanguage = 'fa'
): FolderCompletionStats {
  let totalLines = 0;
  let completedLines = 0;
  let missingLines = 0;
  let completedFileCount = 0;
  const incompleteFiles: SubtitleFolderFile[] = [];

  for (const file of folder.files) {
    const fStats = getFileCompletionStats(file, targetLanguage);
    totalLines += fStats.total;
    completedLines += fStats.completed;
    missingLines += fStats.missingCount;
    if (fStats.isDone) {
      completedFileCount++;
    } else if (fStats.missingCount > 0) {
      incompleteFiles.push(file);
    }
  }

  const pct =
    totalLines === 0
      ? 0
      : missingLines === 0
        ? 100
        : Math.min(99, Math.floor((completedLines / totalLines) * 100));

  return {
    fileCount: folder.files.length,
    totalLines,
    completedLines,
    missingLines,
    incompleteFiles,
    incompleteFileCount: incompleteFiles.length,
    completedFileCount,
    pct,
    isDone: folder.files.length > 0 && totalLines > 0 && missingLines === 0,
  };
}
