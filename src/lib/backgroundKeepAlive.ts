/**
 * Background Translation Keep-Alive & Anti-Throttling Engine
 *
 * Prevents browsers (Chrome / Edge / Firefox / Safari) from throttling timers,
 * freezing background tabs, or dropping long-running translation loops when the
 * user switches to another tab or application while keeping the browser open.
 */

const WORKER_SCRIPT = `
const timers = new Map();
let heartbeatId = null;

self.onmessage = (e) => {
  const { type, id, ms } = e.data || {};
  if (type === 'sleep') {
    const t = setTimeout(() => {
      timers.delete(id);
      self.postMessage({ type: 'wake', id });
    }, Math.max(0, Number(ms) || 0));
    timers.set(id, t);
  } else if (type === 'cancel') {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  } else if (type === 'start_heartbeat') {
    if (heartbeatId === null) {
      heartbeatId = setInterval(() => {
        self.postMessage({ type: 'heartbeat' });
      }, Math.max(5000, Number(ms) || 20000));
    }
  } else if (type === 'stop_heartbeat') {
    if (heartbeatId !== null) {
      clearInterval(heartbeatId);
      heartbeatId = null;
    }
  }
};
`;

let sharedWorker: Worker | null = null;
let workerFailed = false;
let sleepSeq = 1;
const pendingSleeps = new Map<number, () => void>();
let lastHealthPingTs = 0;

function getTimerWorker(): Worker | null {
  if (workerFailed) return null;
  if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    return null;
  }
  if (sharedWorker) return sharedWorker;

  try {
    const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);

    worker.onmessage = (e: MessageEvent) => {
      const { type, id } = e.data || {};
      if (type === 'wake' && typeof id === 'number') {
        const resolve = pendingSleeps.get(id);
        if (resolve) {
          pendingSleeps.delete(id);
          resolve();
        }
      } else if (type === 'heartbeat') {
        if (activeSessionCount > 0) {
          const now = Date.now();
          if (now - lastHealthPingTs >= 20_000) {
            lastHealthPingTs = now;
            void fetch('/api/health', { method: 'GET', cache: 'no-store' }).catch(() => {});
          }
        }
      }
    };

    worker.onerror = () => {
      workerFailed = true;
      sharedWorker = null;
      // Flush any waiting sleeps back through window.setTimeout fallback if worker dies
      pendingSleeps.forEach((resolve) => resolve());
      pendingSleeps.clear();
    };

    sharedWorker = worker;
    return sharedWorker;
  } catch {
    workerFailed = true;
    return null;
  }
}

/**
 * Background-resilient sleep powered by a dedicated Web Worker timer
 * (immune to Chrome/Edge DOM setTimeout background-tab clamping).
 */
export function backgroundSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  const worker = getTimerWorker();
  if (!worker) {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer !== null) clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return new Promise<void>((resolve, reject) => {
    const id = sleepSeq++;
    const onAbort = () => {
      if (pendingSleeps.delete(id)) {
        try {
          worker.postMessage({ type: 'cancel', id });
        } catch {}
        reject(new DOMException('Aborted', 'AbortError'));
      }
    };

    pendingSleeps.set(id, () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      worker.postMessage({ type: 'sleep', id, ms });
    } catch {
      pendingSleeps.delete(id);
      signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}

// ============================================================================
// Active Translation Keep-Alive Session (Web Lock + Silent Audio + Wake Lock)
// ============================================================================

let activeSessionCount = 0;
let lockReleaseResolver: (() => void) | null = null;
let wakeLockSentinel: any = null;
let silentAudioCtx: AudioContext | null = null;
let silentAudioSource: AudioBufferSourceNode | null = null;
let visibilityListenerAttached = false;
const DEFAULT_DOCUMENT_TITLE = 'SubGame Lab | AI Subtitle & Game Translator';

async function requestScreenWakeLock(): Promise<void> {
  if (typeof navigator === 'undefined') return;
  const wl = (navigator as any).wakeLock;
  if (!wl || typeof wl.request !== 'function') return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  try {
    if (wakeLockSentinel && !wakeLockSentinel.released) return;
    wakeLockSentinel = await wl.request('screen');
  } catch {
    // Graceful fallback if denied or unsupported
  }
}

function releaseScreenWakeLock(): void {
  if (wakeLockSentinel) {
    try {
      void wakeLockSentinel.release();
    } catch {}
    wakeLockSentinel = null;
  }
}

function handleVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (activeSessionCount > 0 && document.visibilityState === 'visible') {
    void requestScreenWakeLock();
    if (silentAudioCtx && silentAudioCtx.state === 'suspended') {
      void silentAudioCtx.resume().catch(() => {});
    }
  }
}

function startSilentAudioKeepAlive(): void {
  if (typeof window === 'undefined') return;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    if (!silentAudioCtx) {
      silentAudioCtx = new AudioCtx();
    }
    if (silentAudioCtx.state === 'suspended') {
      void silentAudioCtx.resume().catch(() => {});
    }
    if (silentAudioSource) return;

    // 1-second silent buffer at 0 gain: prevents browser background throttling without any audible output
    const buffer = silentAudioCtx.createBuffer(1, silentAudioCtx.sampleRate, silentAudioCtx.sampleRate);
    const source = silentAudioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = silentAudioCtx.createGain();
    gain.gain.value = 0;

    source.connect(gain);
    gain.connect(silentAudioCtx.destination);
    source.start(0);
    silentAudioSource = source;
  } catch {
    // Ignore autoplay or AudioContext restrictions cleanly
  }
}

function stopSilentAudioKeepAlive(): void {
  if (silentAudioSource) {
    try {
      silentAudioSource.stop();
      silentAudioSource.disconnect();
    } catch {}
    silentAudioSource = null;
  }
  if (silentAudioCtx) {
    try {
      void silentAudioCtx.close();
    } catch {}
    silentAudioCtx = null;
  }
}

function acquireWebLock(): void {
  if (typeof navigator === 'undefined') return;
  const locks = (navigator as any).locks;
  if (!locks || typeof locks.request !== 'function' || lockReleaseResolver) return;

  try {
    void locks
      .request('subgamelab_active_translation', () => {
        return new Promise<void>((resolve) => {
          lockReleaseResolver = resolve;
          if (activeSessionCount <= 0) {
            lockReleaseResolver = null;
            resolve();
          }
        });
      })
      .catch(() => {});
  } catch {}
}

function releaseWebLock(): void {
  if (lockReleaseResolver) {
    try {
      lockReleaseResolver();
    } catch {}
    lockReleaseResolver = null;
  }
}

/**
 * Call when a translation run starts (ideally inside the click handler) to keep
 * background execution, network pings, and timers alive. Returns a release callback.
 */
export function acquireTranslationKeepAlive(): () => void {
  activeSessionCount++;
  let released = false;

  if (activeSessionCount === 1) {
    const worker = getTimerWorker();
    try {
      worker?.postMessage({ type: 'start_heartbeat', ms: 20_000 });
    } catch {}
    acquireWebLock();
    startSilentAudioKeepAlive();
    void requestScreenWakeLock();

    if (typeof document !== 'undefined' && !visibilityListenerAttached) {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = true;
    }
  }

  return () => {
    if (released) return;
    released = true;
    activeSessionCount = Math.max(0, activeSessionCount - 1);
    if (activeSessionCount === 0) {
      try {
        sharedWorker?.postMessage({ type: 'stop_heartbeat' });
      } catch {}
      releaseWebLock();
      stopSilentAudioKeepAlive();
      releaseScreenWakeLock();
      if (typeof document !== 'undefined') {
        document.title = DEFAULT_DOCUMENT_TITLE;
        if (visibilityListenerAttached) {
          document.removeEventListener('visibilitychange', handleVisibilityChange);
          visibilityListenerAttached = false;
        }
      }
    }
  };
}

/**
 * Shows live translation progress in the browser tab title while active so the user
 * can monitor progress from other tabs without switching back in.
 */
export function updateTranslationTabTitle(
  isActive: boolean,
  translatedLines: number,
  totalLines: number
): void {
  if (typeof document === 'undefined') return;
  if (!isActive || totalLines <= 0) {
    document.title = DEFAULT_DOCUMENT_TITLE;
    return;
  }
  const pct = Math.min(100, Math.round((translatedLines / totalLines) * 100));
  document.title = `⏳ ${pct}% (${translatedLines}/${totalLines}) — SubGame Lab`;
}
