import { SubtitleItem } from '../types';
import { formatMsToSRT, formatMsToVTT, resolveItemTimingMs } from './subtitleParser';

/**
 * Adjusts all subtitle timestamps by a given offset in exact integer milliseconds.
 * Positive offset moves subtitles forward in time.
 * Negative offset moves subtitles backward in time.
 * Preserves VTT (dot) vs SRT (comma) timestamp format and updates all timing anchors cleanly.
 */
export function shiftSubtitleTimestamps(
  items: SubtitleItem[],
  offsetMs: number
): SubtitleItem[] {
  const deltaMs = Math.round(offsetMs || 0);
  if (!deltaMs || items.length === 0) return items;

  return items.map((item) => {
    const { startMs, endMs } = resolveItemTimingMs(item);
    const durationMs = Math.max(0, endMs - startMs);
    const newStartMs = Math.max(0, startMs + deltaMs);
    const newEndMs = Math.max(newStartMs, endMs + deltaMs);
    const finalEndMs = newStartMs === 0 && startMs + deltaMs < 0
      ? Math.max(newEndMs, durationMs)
      : newEndMs;

    const isVttStyle = item.startTime.includes('.');
    const formattedStart = isVttStyle ? formatMsToVTT(newStartMs) : formatMsToSRT(newStartMs);
    const formattedEnd = isVttStyle ? formatMsToVTT(finalEndMs) : formatMsToSRT(finalEndMs);

    return {
      ...item,
      startMs: newStartMs,
      endMs: finalEndMs,
      startSeconds: newStartMs / 1000,
      endSeconds: finalEndMs / 1000,
      startTime: formattedStart,
      endTime: formattedEnd,
      rawStartTime: formattedStart,
      rawEndTime: formattedEnd,
    };
  });
}
