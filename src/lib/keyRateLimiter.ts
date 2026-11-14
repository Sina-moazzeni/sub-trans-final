/**
 * Per-key sliding-window Requests-Per-Minute (RPM) rate limiter.
 * Serializes concurrent acquisitions on the same key via a lightweight mutex
 * so simultaneous file workers never collide or exceed Gemini's per-key RPM limit.
 */

const WINDOW_MS = 60_000;
const WINDOW_BUFFER_MS = 250;
const MIN_REQUEST_GAP_MS = 350;

const keyRequestTimestamps = new Map<string, number[]>();
const keyMutexChains = new Map<string, Promise<void>>();

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pruneOldTimestamps(key: string, now: number): number[] {
  const list = keyRequestTimestamps.get(key) || [];
  const cutoff = now - WINDOW_MS;
  const fresh = list.filter((ts) => ts > cutoff);
  keyRequestTimestamps.set(key, fresh);
  return fresh;
}

/**
 * Waits until `keyString` has a free slot inside its `rpmLimit` requests/minute window,
 * then records the timestamp atomically so concurrent callers share the exact budget.
 */
export async function acquireKeyRpmSlot(
  keyString: string,
  rpmLimit: number,
  signal?: AbortSignal,
  onWait?: (waitSec: number) => void
): Promise<void> {
  const cleanKey = String(keyString || '').trim();
  if (!cleanKey) return;

  const effectiveLimit = Math.max(1, Math.min(120, Math.round(rpmLimit) || 12));

  const previousChain = keyMutexChains.get(cleanKey) || Promise.resolve();
  let releaseChain!: () => void;
  const currentChain = new Promise<void>((resolve) => {
    releaseChain = resolve;
  });
  keyMutexChains.set(cleanKey, previousChain.then(() => currentChain).catch(() => currentChain));

  try {
    await previousChain.catch(() => {});

    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    while (true) {
      const now = Date.now();
      const recent = pruneOldTimestamps(cleanKey, now);

      // 1. Sliding window capacity check
      if (recent.length >= effectiveLimit) {
        const oldestTs = recent[0];
        const waitMs = Math.max(250, oldestTs + WINDOW_MS + WINDOW_BUFFER_MS - now);
        onWait?.(Math.max(1, Math.ceil(waitMs / 1000)));
        await sleepAbortable(waitMs, signal);
        continue;
      }

      // 2. Smooth micro-pacing so concurrent batches don't burst at exact same ms
      if (recent.length > 0) {
        const lastTs = recent[recent.length - 1];
        const sinceLast = now - lastTs;
        // Minimum spacing proportional to RPM when RPM <= 15 (e.g. 12 RPM -> at least ~1.2s gap if busy)
        const minGap = effectiveLimit <= 15 ? Math.max(MIN_REQUEST_GAP_MS, Math.floor(15000 / effectiveLimit)) : MIN_REQUEST_GAP_MS;
        if (sinceLast < minGap) {
          const gapWait = minGap - sinceLast;
          if (gapWait >= 1000) {
            onWait?.(Math.ceil(gapWait / 1000));
          }
          await sleepAbortable(gapWait, signal);
          continue;
        }
      }

      // Reserve slot now
      const stampNow = Date.now();
      const updated = pruneOldTimestamps(cleanKey, stampNow);
      updated.push(stampNow);
      keyRequestTimestamps.set(cleanKey, updated);
      break;
    }
  } finally {
    releaseChain();
    // Clean up chain entry if idle
    if (keyMutexChains.get(cleanKey) === currentChain) {
      keyMutexChains.delete(cleanKey);
    }
  }
}

export function getKeyRecentRpmUsage(keyString: string): number {
  const cleanKey = String(keyString || '').trim();
  if (!cleanKey) return 0;
  return pruneOldTimestamps(cleanKey, Date.now()).length;
}

export function clearKeyRpmHistory(keyString?: string): void {
  if (keyString) {
    keyRequestTimestamps.delete(keyString.trim());
  } else {
    keyRequestTimestamps.clear();
  }
}
