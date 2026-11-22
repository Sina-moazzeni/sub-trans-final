import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from '@google/genai';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { 
  resolveModelId, 
  getTranslationFallbackChain, 
  DEFAULT_TRANSLATION_MODEL_ID, 
  DEFAULT_TRANSCRIPTION_MODEL_ID 
} from './src/modelRegistry';
import { 
  buildChatCompletionsUrl, 
  validateCustomProviderConfig, 
  sanitizeErrorMessage,
  normalizeOpenAiTranslationResponse,
  extractJsonFromText,
  classifyCustomProviderError,
  auditBatchAlignment,
  stripAccidentalTimestamps
} from './src/lib/customProviderService';

dotenv.config();

// Safe _dirname resolution compatible with both ESM (tsx) and compiled CommonJS (dist/server.cjs)
const _dirname = typeof __dirname !== 'undefined'
  ? __dirname
  : process.cwd();

// Runtime status of static frontend hosting, surfaced via /api/health for remote diagnosis.
// FIX (WHITE-SCREEN INCIDENT, Render 2026-09-14): when the platform build never ran
// (dist/ missing) the old code silently served the REPO ROOT, which returned the raw
// dev index.html (references /src/main.tsx -> blank white page) AND exposed the entire
// source tree (server.ts, package-lock.json, render.yaml...) via express.static.
let PROD_STATIC_STATE: 'build' | 'missing' | 'dev' = 'dev';

function resolvePort(): number {
  const portFlagIndex = process.argv.indexOf('--port');
  if (portFlagIndex !== -1 && process.argv[portFlagIndex + 1]) {
    const cliPort = Number(process.argv[portFlagIndex + 1]);
    if (!Number.isNaN(cliPort) && cliPort > 0) return cliPort;
  }
  const portEqArg = process.argv.find((arg) => arg.startsWith('--port='));
  if (portEqArg) {
    const cliPort = Number(portEqArg.split('=')[1]);
    if (!Number.isNaN(cliPort) && cliPort > 0) return cliPort;
  }
  return Number(process.env.PORT) || 3000;
}

const app = express();
const PORT = resolvePort();

// ─── FIX (B1): protect the server's own API key & expensive endpoints ─────────────
// 1) CORS lockdown: when ALLOWED_ORIGIN is set (e.g. "https://myapp.example.com"), only that
//    origin is echoed back instead of the wildcard that let any website burn the server quota.
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').trim();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN && origin) {
    const allowedList = ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
    if (allowedList.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    // Non-allowed origins get no CORS headers → browsers block the response
  } else {
    // Local development / unconfigured deployments keep the previous open behavior
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-gemini-api-key, x-gemini-api-keys');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 2) Per-IP rate limiting on every AI-endpoint (token-bucket per minute).
//    AI_RATE_LIMIT=0 disables it. Default: 30 requests/minute/IP — generous for real users,
//    deadly for quota-abuse bots hammering the free server key.
const AI_RATE_LIMIT = Number(process.env.AI_RATE_LIMIT ?? 30);
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  rateLimitBuckets.forEach((bucket, ip) => {
    if (bucket.resetAt < now) rateLimitBuckets.delete(ip);
  });
}, 60_000).unref?.();

function getUserProvidedKeyCount(req: express.Request): number {
  if (req.body?.provider === 'custom') return 1;
  const multiHeader = req.headers['x-gemini-api-keys'] as string;
  if (multiHeader) {
    try {
      const parsed = JSON.parse(multiHeader);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter(Boolean).length;
    } catch {
      const parts = multiHeader.split(',').map((k) => k.trim()).filter(Boolean);
      if (parts.length > 0) return parts.length;
    }
  }
  const singleHeader = req.headers['x-gemini-api-key'] as string;
  if (singleHeader && singleHeader.trim()) return 1;
  const authHeader = req.headers['authorization'] as string;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ') && authHeader.slice(7).trim()) return 1;
  return 0;
}

function aiRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AI_RATE_LIMIT || AI_RATE_LIMIT <= 0) return next();
  const userKeyCount = getUserProvidedKeyCount(req);
  // Scale per-minute allowance generously when the user brings their own key(s) or runs
  // concurrent multi-file translations, while keeping strict protection on the server's key.
  const effectiveLimit = userKeyCount > 0
    ? Math.min(300, Math.max(AI_RATE_LIMIT, userKeyCount * 60))
    : AI_RATE_LIMIT;

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || 'unknown';
  const bucketKey = userKeyCount > 0 ? `${ip}:byok` : ip;
  const now = Date.now();
  let bucket = rateLimitBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateLimitBuckets.set(bucketKey, bucket);
  }
  bucket.count++;
  if (bucket.count > effectiveLimit) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.header('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      success: false,
      error: `تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً پس از ${retryAfterSec} ثانیه دوباره تلاش کنید.`,
      errorType: 'rate_limit',
      retryable: true,
    });
  }
  return next();
}

// 3) The built-in server key may be disabled entirely for public deployments by setting
//    ALLOW_SERVER_KEY=false — then every user MUST bring their own key (BYOK).
const serverKeyAllowed = () => process.env.ALLOW_SERVER_KEY !== 'false' && Boolean(process.env.GEMINI_API_KEY?.trim());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Lazy initializer for GoogleGenAI
function getGenAIClient(customApiKey?: string): GoogleGenAI {
  const apiKey = customApiKey?.trim() || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('کلید API جمینای تنظیم نشده است. لطفا کلید خود را در منوی "کلید API" بالای صفحه وارد کنید.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      // FIX: GEMINI_BASE_URL allows pointing the SDK at a mock/self-hosted upstream —
      // essential for deterministic integration tests of failover/quota/stream behavior
      // (undefined in production = default Google endpoint, zero behavior change).
      baseUrl: process.env.GEMINI_BASE_URL?.trim() || undefined,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Tone descriptions map for prompt engineering
const TONE_PROMPTS: Record<string, string> = {
  cinematic: 'سینمایی و دراماتیک (لحن شیوا، دراماتیک و مناسب دوبله و فیلم‌های سینمایی فاخر)',
  conversational: 'عامیانه و گفتاری (زبان روزمره، صمیمی، روانی مکالمات خیابانی، اصطلاحات روز و ولاگ)',
  formal: 'رسمی، کتابی و دقیق (وفاداری کامل به واژگان با ادبیات معیار)',
  humorous: 'طنز و شوخ‌طبعانه (استفاده طبیعی و بدون سانسور از جوک‌ها، شوخی‌های بزرگسالانه، کنایه‌ها، متلک‌ها و اصطلاحات طنز متناسب با زبان و فرهنگ مقصد)',
  educational: 'آموزشی و علمی (رعایت ترمینولوژی تخصصی، صراحت و دقت مستندهای علمی)',
  epic: 'حماسی و تاریخی (مناسب بازی‌های نقش‌آفرینی RPG، بازی‌های ویدیویی، محتوای تاریخی، افسانه‌ای و فانتزی با لحن حماسی و اساطیری فاخر)',
  expose: 'افشاگری و بدون سانسور (ترجمه کاملاً بی‌پرده، صریح، افشاگرانه، مستند و بدون کوچک‌ترین سانسور، حذف، تعدیل یا نرم‌سازی واژگان، فحش‌ها، حقایق تلخ، مباحث سیاسی/اجتماعی حساس و عبارات صریح)',
  custom: 'دستورالعمل و لحن اختصاصی کاربر (پیروی دقیق از قوانین سفارشی و اصطلاحات اختصاصی کاربر)',
};

// Helper function to extract array of client API keys from headers or env
// FIX (B1): the server environment key is used ONLY as an explicit last resort (no user key at
// all) and only when ALLOW_SERVER_KEY !== 'false'. It is NEVER mixed into a user's key chain.
function getClientKeysFromHeader(req: express.Request): string[] {
  const multiKeysHeader = req.headers['x-gemini-api-keys'] as string;
  if (multiKeysHeader) {
    try {
      const parsed = JSON.parse(multiKeysHeader);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((k) => String(k).trim()).filter(Boolean);
      }
    } catch {
      const splitKeys = multiKeysHeader.split(',').map((k) => k.trim()).filter(Boolean);
      if (splitKeys.length > 0) return splitKeys;
    }
  }

  const singleKeyHeader = req.headers['x-gemini-api-key'] as string;
  if (singleKeyHeader && singleKeyHeader.trim()) {
    return [singleKeyHeader.trim()];
  }

  const authHeader = req.headers['authorization'] as string;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearerKey = authHeader.substring(7).trim();
    if (bearerKey) {
      if (bearerKey.startsWith('[') && bearerKey.endsWith(']')) {
        try {
          const parsed = JSON.parse(bearerKey);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((k) => String(k).trim()).filter(Boolean);
          }
        } catch {}
      }
      return [bearerKey];
    }
  }

  // FIX (B1): fallback to the server key only when the visitor sent NO key at all
  if (serverKeyAllowed()) {
    return [process.env.GEMINI_API_KEY!.trim()];
  }

  return [];
}

// Helper function to execute Gemini requests with multi-key rotation, intelligent model fallback, and rate-limit backoff
// FIX (Cancellation): accepts an optional AbortSignal so a client cancel/disconnect stops ALL upstream work
async function callGeminiWithRetryAndFallback(
  apiKeys: string[],
  generateParams: {
    contents: any;
    config?: any;
  },
  preferredModel?: string,
  abortSignal?: AbortSignal
): Promise<{
  response: any;
  modelUsed: string;
  isFallback: boolean;
  keyIndexUsed: number;
  exhaustedKeyIndices: number[];
  invalidKeyIndices: number[];
}> {
  // FIX: throw immediately if the client is already gone (no wasted API call at all)
  if (abortSignal?.aborted) {
    const abortErr: any = new Error('CLIENT_ABORTED: request cancelled before dispatch');
    abortErr.isClientAbort = true;
    throw abortErr;
  }

  const rawKeys = apiKeys.length > 0 ? apiKeys : [];
  const keysToTry: string[] = [];
  rawKeys.forEach((k) => {
    const trimmed = String(k || '').trim();
    if (trimmed && !keysToTry.includes(trimmed)) {
      keysToTry.push(trimmed);
    }
  });

  // FIX (B1): the server environment key is appended ONLY when the user sent NO keys.
  // Previously it was ALWAYS appended, so as soon as a user's quota ran dry the traffic
  // silently continued on the owner's paid key (cost leakage / financial DoS vector).
  if (keysToTry.length === 0 && serverKeyAllowed()) {
    const envKey = process.env.GEMINI_API_KEY!.trim();
    if (envKey) keysToTry.push(envKey);
  }

  if (keysToTry.length === 0) {
    throw new Error('کلید API جمینای تنظیم نشده است. لطفاً کلید API خود را وارد کنید.');
  }

  // Optimized fallback order based on the user's selected model archetype
  let models: string[] = [];
  const targetModel = preferredModel && preferredModel !== 'gemini-live-stream'
    ? resolveModelId(preferredModel)
    : DEFAULT_TRANSLATION_MODEL_ID;

  if (targetModel === 'gemini-3.5-transcribe') {
    models = ['gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.6-flash'];
  } else {
    models = getTranslationFallbackChain(targetModel);
  }

  let lastError: any = null;
  const exhaustedKeyIndices: number[] = [];
  const invalidKeyIndices: number[] = [];

  // FIX: interruptible sleep that returns early when the client aborts
  const sleepWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const aborted = new Promise<void>((resolve) => {
      if (abortSignal.aborted) resolve();
      else abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    await Promise.race([aborted, timeout]);
    if (timer) clearTimeout(timer);
    if (abortSignal.aborted) {
      const abortErr: any = new Error('CLIENT_ABORTED: cancelled during backoff');
      abortErr.isClientAbort = true;
      throw abortErr;
    }
  };

  for (let kIdx = 0; kIdx < keysToTry.length; kIdx++) {
    const currentKey = keysToTry[kIdx];
    if (!currentKey) continue;

    // FIX: stop key rotation when client is gone
    if (abortSignal?.aborted) {
      const abortErr: any = new Error('CLIENT_ABORTED: cancelled before key rotation');
      abortErr.isClientAbort = true;
      throw abortErr;
    }

    let ai: GoogleGenAI;
    try {
      ai = getGenAIClient(currentKey);
    } catch (e) {
      lastError = e;
      continue;
    }

    for (let mIdx = 0; mIdx < models.length; mIdx++) {
      const modelName = models[mIdx];
      let attempts = 0;
      const maxAttemptsPerModel = 2;

      while (attempts < maxAttemptsPerModel) {
        attempts++;

        // FIX: stop model/attempt rotation when client is gone
        if (abortSignal?.aborted) {
          const abortErr: any = new Error('CLIENT_ABORTED: cancelled before attempt');
          abortErr.isClientAbort = true;
          throw abortErr;
        }

        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: generateParams.contents,
            // FIX: wire the client abort signal into the SDK so the upstream HTTP call is cancelled
            config: { ...(generateParams.config || {}), abortSignal },
          });
          
          const isFallback = Boolean(modelName !== targetModel);
          return {
            response,
            modelUsed: modelName,
            isFallback,
            keyIndexUsed: kIdx,
            exhaustedKeyIndices,
            invalidKeyIndices,
          };
        } catch (err: any) {
          // FIX: client cancelled mid-call — unwind every loop immediately, no failover, no retry
          if (abortSignal?.aborted) {
            const abortErr: any = new Error(`CLIENT_ABORTED: cancelled during ${modelName} call`);
            abortErr.isClientAbort = true;
            throw abortErr;
          }

          const msg = err?.message || String(err);
          const lowerMsg = msg.toLowerCase();
          const is404 = msg.includes('404') || lowerMsg.includes('not found');

          if (!is404 || !lastError) {
            lastError = err;
          }

          const isRateLimit =
            msg.includes('429') ||
            lowerMsg.includes('quota') ||
            lowerMsg.includes('resource_exhausted') ||
            lowerMsg.includes('rate limit');

          const isAuthError =
            msg.includes('401') ||
            msg.includes('403') ||
            lowerMsg.includes('api_key_invalid') ||
            lowerMsg.includes('api key not valid') ||
            lowerMsg.includes('invalid api key') ||
            lowerMsg.includes('unauthorized') ||
            lowerMsg.includes('permission_denied') ||
            lowerMsg.includes('permission denied');

          if (isAuthError) {
            console.warn(`[Gemini Auth Error] Key #${kIdx + 1} is unauthorized or invalid. Skipping remaining models for this key...`);
            if (!invalidKeyIndices.includes(kIdx)) invalidKeyIndices.push(kIdx);
            mIdx = models.length; // exit inner model loop
            break; // exit attempts loop
          }

          if (isRateLimit) {
            if (!exhaustedKeyIndices.includes(kIdx)) exhaustedKeyIndices.push(kIdx);
            // 1. If we have more API keys, failover to the next key immediately — skipping ALL
            //    remaining models of this exhausted key.
            if (kIdx < keysToTry.length - 1) {
              console.warn(`[Gemini Rate Limit] Key #${kIdx + 1} exhausted quota for ${modelName}. Switching to Key #${kIdx + 2}...`);
              mIdx = models.length;
              break;
            }

            // 2. If we have more models to try, failover to the next tier model immediately
            //    (rate limits are per-model per-key, so the same key may still serve another model)
            if (mIdx < models.length - 1) {
              console.warn(`[Gemini Rate Limit] Model ${modelName} rate limited. Falling back to ${models[mIdx + 1]}...`);
              break; // exit attempts loop to try next model in inner loop
            }

            // 3. Otherwise wait for requested retry duration or exponential backoff
            let delayMs = 4000;
            const match = msg.match(/retry in ([0-9.]+)s/i);
            if (match && match[1]) {
              const parsedSec = parseFloat(match[1]);
              if (!isNaN(parsedSec) && parsedSec > 0) {
                delayMs = Math.min(Math.ceil(parsedSec * 1000) + 1000, 60000);
              }
            }
            console.warn(`[Gemini Rate Limit] Model: ${modelName}, Key: #${kIdx + 1}, Attempt: ${attempts}/${maxAttemptsPerModel}. Waiting ${Math.round(delayMs / 1000)}s...`);
            await sleepWithAbort(delayMs); // FIX: interruptible backoff — a cancel wakes it instantly
          } else {
            // Non-rate-limit error (e.g. 404 or bad syntax), move to next model
            break;
          }
        }
      }
    }
  }

  const finalErr: any = lastError || new Error('خطا در ارتباط با هوش مصنوعی. لطفاً کلید API جمینای خود را در تنظیمات بررسی یا به‌روزرسانی کنید.');
  finalErr.exhaustedKeyIndices = exhaustedKeyIndices;
  finalErr.invalidKeyIndices = invalidKeyIndices;
  throw finalErr;
}

// Custom Provider (BYOK) Connection Test
async function testCustomProviderConnection(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{
  success: boolean;
  error?: string;
  errorType?: string;
  latencyMs?: number;
  modelResponded?: string;
}> {
  const { baseUrl, apiKey, model } = config || {};
  const validation = validateCustomProviderConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      errorType: 'invalid_url',
      error: validation.error || 'تنظیمات سرویس‌دهنده سفارشی نامعتبر است.',
    };
  }

  let targetUrl: string;
  try {
    targetUrl = buildChatCompletionsUrl(baseUrl);
  } catch (err: any) {
    return {
      success: false,
      errorType: 'invalid_url',
      error: sanitizeErrorMessage(err?.message || 'فرمت آدرس نامعتبر است.', apiKey),
    };
  }

  const startTime = Date.now();
  const controller = new AbortController();
  // Allow 45 seconds for slow intermediary/proxy ("واسط") custom providers to respond
  const timeoutTimer = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: model.trim(),
        messages: [{ role: 'user', content: 'Ping' }],
        max_tokens: 5,
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    clearTimeout(timeoutTimer);
    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      const data: any = await response.json().catch(() => null);
      if (!data) {
        return {
          success: false,
          errorType: 'invalid_response',
          error: 'سرویس‌دهنده پاسخی خالی یا نامعتبر ارسال کرد.',
          latencyMs,
        };
      }
      return {
        success: true,
        latencyMs,
        modelResponded: data.model || model.trim(),
      };
    }

    // Handle non-200 responses
    const errData: any = await response.json().catch(() => null);
    const rawMsg =
      errData?.error?.message ||
      errData?.message ||
      errData?.error ||
      `HTTP ${response.status} ${response.statusText}`;
    const safeMsg = sanitizeErrorMessage(String(rawMsg), apiKey);

    if (response.status === 401) {
      return {
        success: false,
        errorType: 'invalid_key',
        error: 'Invalid API key / Authentication failed (401). Please check your API key.',
        latencyMs,
      };
    }
    if (response.status === 403) {
      return {
        success: false,
        errorType: 'auth_failed',
        error: `Authentication failed / Access forbidden (403): ${safeMsg}`,
        latencyMs,
      };
    }
    if (response.status === 404) {
      const isModelNotFound = /model/i.test(safeMsg);
      return {
        success: false,
        errorType: isModelNotFound ? 'model_not_found' : 'endpoint_not_found',
        error: isModelNotFound
          ? `Model "${model.trim()}" not found on this provider.`
          : 'Endpoint not found (404). Please verify your Base API URL.',
        latencyMs,
      };
    }
    if (response.status === 429) {
      return {
        success: false,
        errorType: 'rate_limit',
        error: `Rate limit / Quota exceeded (429): ${safeMsg}`,
        latencyMs,
      };
    }
    if (response.status >= 500) {
      return {
        success: false,
        errorType: 'provider_error',
        error: `Provider server error (${response.status}): ${safeMsg}`,
        latencyMs,
      };
    }

    return {
      success: false,
      errorType: 'provider_error',
      error: `Provider returned an error (${response.status}): ${safeMsg}`,
      latencyMs,
    };
  } catch (err: any) {
    clearTimeout(timeoutTimer);
    const latencyMs = Date.now() - startTime;
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      return {
        success: false,
        errorType: 'timeout',
        error: 'Connection timed out after 45 seconds.',
        latencyMs,
      };
    }
    const rawErr = String(err?.message || err);
    return {
      success: false,
      errorType: 'network_error',
      error: `Network error: ${sanitizeErrorMessage(rawErr, apiKey)}`,
      latencyMs,
    };
  }
}

// Concurrency Limiter for Custom Provider Requests (Requirement 11)
class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  private release() {
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get pendingCount() {
    return this.queue.length;
  }

  get activeCount() {
    return this.active;
  }
}

// Global limiter: Limit simultaneous outgoing requests to Custom Providers (e.g. 4 concurrent)
const customProviderLimiter = new ConcurrencyLimiter(4);

// Custom Provider Translation Handler with Full Lifecycle Deadline & Complete Body Stream Reader
async function translateWithCustomProvider(params: {
  customProvider: { baseUrl: string; apiKey: string; model: string };
  items: Array<{ id: number; text: string; key?: string; context?: string }>;
  sourceLanguage?: string;
  targetLanguage: string;
  tone?: string;
  customPrompt?: string;
  mode?: string;
  requestId: string;
  clientSignal?: AbortSignal;
}): Promise<{
  translations: Array<{ id: number; text: string }>;
  detectedSourceLanguage: string;
  modelUsed: string;
  isFallback: boolean;
  timings: any;
  responseBytes: number;
}> {
  const requestStart = Date.now();
  const { customProvider, items, sourceLanguage, targetLanguage, tone, customPrompt, mode, requestId, clientSignal } = params;

  // 1. Configuration Validation
  const validation = validateCustomProviderConfig(customProvider);
  if (!validation.valid) {
    const vErr: any = new Error(validation.error || 'Custom Provider configuration is invalid.');
    vErr.status = 400;
    vErr.errorType = 'invalid_config';
    vErr.retryable = false;
    throw vErr;
  }

  const targetUrl = buildChatCompletionsUrl(customProvider.baseUrl);
  const targetHost = new URL(targetUrl).hostname;
  const toneDescription = (tone && (TONE_PROMPTS as any)[tone]) || TONE_PROMPTS.cinematic;
  const userCustomPrompt = customPrompt?.trim() || '';

  const systemInstruction = `You are an expert translator for ${mode === 'game' ? 'video games' : 'movie & TV subtitles'}.
Translate every input item into ${targetLanguage} (Source language: ${sourceLanguage || 'Auto-detect'}).
Tone: ${toneDescription}
${userCustomPrompt ? `Custom Instruction: "${userCustomPrompt}"` : ''}

CRITICAL LOCALIZATION RULES:
1. STRICT 1:1 TIMING & CUE-BOUNDARY LOCK: Translate ONLY the text inside each item's "text" field. Retain every exact input "id" 1:1 with ZERO missing, extra, or duplicate IDs. Even when one English sentence spans two or three consecutive cues, translate ONLY the words belonging to cue N inside cue N — NEVER borrow words from cue N+1 into cue N or push words from cue N into cue N+1 (moving words across cue boundaries makes subtitles appear seconds early or late on video!). NEVER merge two cues, NEVER emit blank lines (\\n\\n) or "-->" inside text, and NEVER leave English lines untranslated into ${targetLanguage}.
2. VARIABLE & TAG ISOLATION: Retain tags (<i>, <b>, {\\pos(...)}), system variables ({player_name}, %s, $amount, [TAG]) exactly without translation or modification.
3. UNCENSORED FIDELITY: When the tone is 'expose', 'humorous', 'conversational', or 'epic', translate every statement, exposé claim, profanity, slang, and sensitive expression directly and authentically with zero censorship, softening, or omission.
4. OUTPUT FORMAT: Respond ONLY with a valid JSON object matching this schema:
{
  "detectedSourceLanguage": "...",
  "translations": [
    { "id": 1, "text": "..." }
  ]
}
Do NOT return any markdown wrapper, conversational filler, or text outside the JSON.`;

  const userPrompt = `Translate the following ${items.length} items into ${targetLanguage}:\n` +
    JSON.stringify(items.map((i) => ({ id: i.id, text: i.text, key: i.key, context: i.context })), null, 2);

  const requestPayloadObj = {
    model: customProvider.model.trim(),
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
  };

  const requestPayloadString = JSON.stringify(requestPayloadObj);

  // Request Size Check (Requirement 17: Bounded request size, max 2MB)
  if (requestPayloadString.length > 2 * 1024 * 1024) {
    const sizeErr: any = new Error('CUSTOM_PROVIDER_REQUEST_TOO_LARGE: Request payload exceeds 2MB limit.');
    sizeErr.status = 413;
    sizeErr.errorType = 'request_too_large';
    sizeErr.retryable = false;
    throw sizeErr;
  }

  // Requirement 3: Extended overall deadline (240s / 4 min) so slow intermediary/proxy ("واسط")
  // providers with high queue/generation latency are NOT treated as disconnected prematurely.
  const DEADLINE_MS = 240000;
  const deadlineController = new AbortController();
  let deadlineTimer: NodeJS.Timeout | null = setTimeout(() => {
    deadlineController.abort(new Error('CUSTOM_PROVIDER_TIMEOUT'));
  }, DEADLINE_MS);

  // Combine deadline and client cancellation signal
  const combinedSignal = clientSignal
    ? AbortSignal.any([deadlineController.signal, clientSignal])
    : deadlineController.signal;

  let releaseLock: (() => void) | null = null;
  let fetchStart = 0;
  let headersReceived = 0;
  let bodyStart = 0;
  let bodyComplete = 0;
  let jsonParsed = 0;
  let receivedBytes = 0;

  try {
    // Acquire concurrency slot
    releaseLock = await customProviderLimiter.acquire();

    if (combinedSignal.aborted) {
      throw new Error('Request aborted before dispatch');
    }

    fetchStart = Date.now();

    // Outgoing HTTP request to Custom Provider
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${customProvider.apiKey.trim()}`,
      },
      body: requestPayloadString,
      signal: combinedSignal,
      redirect: 'error', // Block automatic redirects (Requirement 14 & SSRF Protection)
    });

    headersReceived = Date.now();

    // Check HTTP Status
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const errJson = extractJsonFromText(errText);
      const rawMsg = errJson?.error?.message || errJson?.message || errText || `HTTP ${response.status} ${response.statusText}`;
      const safeMsg = sanitizeErrorMessage(rawMsg, customProvider.apiKey);
      const classified = classifyCustomProviderError(new Error(safeMsg), response.status);
      const errObj: any = new Error(classified.message);
      errObj.status = classified.status;
      errObj.errorType = classified.errorType;
      errObj.retryable = classified.retryable;
      throw errObj;
    }

    // Requirement 4 & 16: Safe & Complete Response Body Stream Reader with bounded limit
    bodyStart = Date.now();
    const reader = response.body?.getReader();
    if (!reader) {
      const bodyErr: any = new Error('Custom provider returned an empty response body stream.');
      bodyErr.status = 502;
      bodyErr.errorType = 'truncated_response';
      bodyErr.retryable = true;
      throw bodyErr;
    }

    const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB limit (Requirement 16)
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > MAX_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch {}
            const tooLargeErr: any = new Error('CUSTOM_PROVIDER_RESPONSE_TOO_LARGE: Response exceeded 10MB limit.');
            tooLargeErr.status = 502;
            tooLargeErr.errorType = 'response_too_large';
            tooLargeErr.retryable = false;
            throw tooLargeErr;
          }
          chunks.push(value);
        }
      }
    } catch (readErr: any) {
      if (combinedSignal.aborted) {
        if (deadlineController.signal.aborted) {
          const timeoutErr: any = new Error('CUSTOM_PROVIDER_TIMEOUT: Overall deadline expired while reading response body.');
          timeoutErr.status = 408;
          timeoutErr.errorType = 'timeout';
          timeoutErr.retryable = true;
          throw timeoutErr;
        }
        const cancelErr: any = new Error('Request was cancelled by client.');
        cancelErr.status = 499;
        cancelErr.errorType = 'cancelled';
        cancelErr.retryable = false;
        throw cancelErr;
      }
      const truncErr: any = new Error(`Connection dropped mid-stream while reading response: ${readErr.message}`);
      truncErr.status = 502;
      truncErr.errorType = 'truncated_response';
      truncErr.retryable = true;
      throw truncErr;
    }

    bodyComplete = Date.now();

    // Check Content-Length header if provided by provider
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const expected = parseInt(contentLengthHeader, 10);
      if (!isNaN(expected) && expected > 0 && receivedBytes < expected) {
        const truncErr: any = new Error(`CUSTOM_PROVIDER_TRUNCATED_BODY: Received ${receivedBytes} of expected ${expected} bytes.`);
        truncErr.status = 502;
        truncErr.errorType = 'truncated_response';
        truncErr.retryable = true;
        throw truncErr;
      }
    }

    // Requirement 4 & 5: Complete JSON parsing & truncation detection
    const fullText = Buffer.concat(chunks).toString('utf-8');
    if (!fullText || fullText.trim().length === 0) {
      const emptyErr: any = new Error('Custom provider returned an empty response body.');
      emptyErr.status = 502;
      emptyErr.errorType = 'truncated_response';
      emptyErr.retryable = true;
      throw emptyErr;
    }

    let rawJson: any;
    try {
      rawJson = JSON.parse(fullText);
    } catch (jsonErr: any) {
      // Detect partial/truncated JSON (Requirement 5)
      const isPartial = fullText.includes('choices') || fullText.includes('content') || fullText.includes('translations');
      const err: any = new Error(
        isPartial 
          ? 'Custom provider response was truncated in the middle of JSON data (truncated JSON).' 
          : 'Custom provider returned malformed non-JSON output.'
      );
      err.status = 502;
      err.errorType = isPartial ? 'truncated_response' : 'malformed_json';
      err.retryable = true;
      throw err;
    }

    jsonParsed = Date.now();

    // Requirement 24: Strict Normalization and Validation
    const normalized = normalizeOpenAiTranslationResponse(rawJson, items, customProvider.model.trim());

    // Calculate Telemetry timings (Requirement 2)
    const timings = {
      request_start: requestStart,
      provider_fetch_start: fetchStart,
      provider_headers_received: headersReceived,
      provider_body_start: bodyStart,
      provider_body_complete: bodyComplete,
      provider_json_parsed: jsonParsed,
      response_sent: Date.now(),
      request_complete: Date.now(),
      elapsed_ms: Date.now() - requestStart,
      status: response.status,
      response_bytes: receivedBytes,
      provider_host: targetHost,
      model: customProvider.model.trim(),
      batch_size: items.length,
    };

    return {
      ...normalized,
      timings,
      responseBytes: receivedBytes,
    };
  } catch (err: any) {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (err?.name === 'AbortError' || combinedSignal.aborted) {
      if (deadlineController.signal.aborted) {
        const timeoutErr: any = new Error('CUSTOM_PROVIDER_TIMEOUT: Overall deadline (240s) expired.');
        timeoutErr.status = 408;
        timeoutErr.errorType = 'timeout';
        timeoutErr.retryable = true;
        throw timeoutErr;
      }
      if (clientSignal?.aborted) {
        const cancelErr: any = new Error('Request was cancelled by client.');
        cancelErr.status = 499;
        cancelErr.errorType = 'cancelled';
        cancelErr.retryable = false;
        throw cancelErr;
      }
      // Upstream socket reset or internal fetch abort
      const netErr: any = new Error(`Connection was reset or aborted by upstream provider: ${err?.message || 'Network error'}`);
      netErr.status = 502;
      netErr.errorType = 'network_error';
      netErr.retryable = true;
      throw netErr;
    }
    throw err;
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (releaseLock) {
      releaseLock();
    }
  }
}

// API Endpoint: Translate batch of subtitle or game localization items
// FIX (Cancellation): single reusable helper — every long endpoint wires client disconnect to an AbortController.
// Must listen to res.on('close'), NOT req.on('close'): req 'close' fires as soon as the POST body finishes streaming,
// whereas res 'close' fires when the connection terminates before res.end() is called.
function attachClientAbort(res: import('express').Response): AbortController {
  const clientAbortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      clientAbortController.abort();
    }
  };
  res.on('close', onClientClose);
  res.on('finish', () => {
    res.off('close', onClientClose);
  });
  return clientAbortController;
}

// FIX (L7): client-supplied jobId is sanitized before it touches logs or JSON responses —
// free-form strings allowed log forging (fake stack traces / poisoned telemetry).
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
function sanitizeJobId(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_JOB_ID.test(s) ? s : 'job_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// API Endpoint: Translate batch of subtitle or game localization items
// FIX (B1): protected by the per-IP AI rate limiter (quota-abuse protection)
app.post('/api/translate', aiRateLimiter, async (req, res) => {
  const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  // FIX (L7): validated jobId — forged values are replaced by a server-generated one
  const jobId = sanitizeJobId(req.body.jobId);

  // Client Cancellation Listener (Requirement 9: Real Cancellation)
  const clientAbortController = attachClientAbort(res);

  try {
    const { items, sourceLanguage, targetLanguage, tone, customPrompt, mode, model, provider, customProvider } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'آیتمی برای ترجمه ارسال نشده است.',
        errorType: 'invalid_config',
        retryable: false,
        requestId,
        jobId,
      });
    }

    if (provider === 'custom') {
      if (!customProvider) {
        return res.status(400).json({ 
          success: false, 
          error: 'Custom Provider configuration is missing.',
          errorType: 'invalid_config',
          retryable: false,
          requestId,
          jobId,
        });
      }

      try {
        let customResult;
        try {
          customResult = await translateWithCustomProvider({
            customProvider,
            items,
            sourceLanguage,
            targetLanguage,
            tone,
            customPrompt,
            mode,
            requestId,
            clientSignal: clientAbortController.signal,
          });
        } catch (firstErr: any) {
          const isAlignmentOrMissing =
            firstErr?.errorType === 'id_alignment_mismatch' ||
            firstErr?.errorType === 'missing_translations';

          if (isAlignmentOrMissing && items.length > 8 && !clientAbortController.signal.aborted) {
            console.warn(
              `[CustomProvider Anti-Shift] ${requestId}: ${firstErr.errorType} on ${items.length}-line batch. Auto-splitting into safe 8-line sub-batches...`
            );
            const mergedTranslations: Array<{ id: number; text: string }> = [];
            let detectedLang = 'Auto-detect';
            let lastSubResult: any = null;
            const SAFE_SUB_BATCH = 8;

            for (let s = 0; s < items.length; s += SAFE_SUB_BATCH) {
              const subItems = items.slice(s, s + SAFE_SUB_BATCH);
              const subRes = await translateWithCustomProvider({
                customProvider,
                items: subItems,
                sourceLanguage,
                targetLanguage,
                tone,
                customPrompt,
                mode,
                requestId: `${requestId}_sub${Math.floor(s / SAFE_SUB_BATCH) + 1}`,
                clientSignal: clientAbortController.signal,
              });
              mergedTranslations.push(...subRes.translations);
              if (subRes.detectedSourceLanguage && subRes.detectedSourceLanguage !== 'Auto-detect') {
                detectedLang = subRes.detectedSourceLanguage;
              }
              lastSubResult = subRes;
            }

            customResult = {
              translations: mergedTranslations,
              detectedSourceLanguage: detectedLang,
              modelUsed: lastSubResult?.modelUsed || customProvider.model.trim(),
              isFallback: false,
              timings: lastSubResult?.timings || { request_start: Date.now(), elapsed_ms: 0 },
              responseBytes: lastSubResult?.responseBytes || 0,
            };
          } else {
            throw firstErr;
          }
        }

        // Telemetry Logging in Dev/Debug without logging API keys or prompts (Requirement 2)
        const t = customResult.timings;
        const headersDuration = t.provider_headers_received && t.provider_fetch_start ? (t.provider_headers_received - t.provider_fetch_start) : 0;
        const bodyDuration = t.provider_body_complete && t.provider_body_start ? (t.provider_body_complete - t.provider_body_start) : 0;
        const parseDuration = t.provider_json_parsed && t.provider_body_complete ? (t.provider_json_parsed - t.provider_body_complete) : 0;

        console.log(`[CustomProvider Telemetry] requestId=${requestId} jobId=${jobId} host=${t.provider_host} model=${t.model} status=${t.status} bytes=${customResult.responseBytes} batch=${items.length} elapsed=${t.elapsed_ms}ms (headers=${headersDuration}ms, body=${bodyDuration}ms, parse=${parseDuration}ms)`);

        return res.json({
          success: true,
          translations: customResult.translations,
          detectedSourceLanguage: customResult.detectedSourceLanguage,
          modelUsed: customResult.modelUsed,
          isFallback: customResult.isFallback,
          requestId,
          jobId,
          timings: customResult.timings,
        });
      } catch (err: any) {
        const classified = classifyCustomProviderError(err, err.status);
        console.error(`[CustomProvider Error] requestId=${requestId} jobId=${jobId} errorType=${classified.errorType} retryable=${classified.retryable} status=${classified.status} message=${classified.message}`);
        
        return res.status(classified.status).json({
          success: false,
          error: classified.message,
          errorType: classified.errorType,
          retryable: classified.retryable,
          requestId,
          jobId,
        });
      }
    } else {
      // Gemini Default Provider
      const apiKeys = getClientKeysFromHeader(req);
      const toneDescription = TONE_PROMPTS[tone] || TONE_PROMPTS.cinematic;
      const userCustomPrompt = customPrompt?.trim() || '';

      const systemInstruction = `SYSTEM INSTRUCTION FOR LOCALIZATION ENGINE:
You are an expert translator for movies and video games.

[TONE & INSTRUCTIONS]
Apply the selected default tone (${toneDescription}), OR if a custom instruction is provided, follow it strictly:
User Custom Instruction: "${userCustomPrompt || 'None'}"
${mode === 'game' ? 'Operational Mode: Video Game Localization Engine (Dialogue, UI, Quests, Items, Lore)' : 'Operational Mode: Movie & TV Subtitles (Cinema Engine)'}

[CRITICAL CONSTRAINTS - DO NOT VIOLATE]
1. PRESERVE STRUCTURE & 1:1 TIMING / CUE-BOUNDARY LOCK:
   - For Movies: NEVER alter or omit any timecode, index number, or line spacing. Keep strict 1:1 alignment between each input "id" and its exact corresponding output "id" with ZERO extra, missing, or duplicate IDs.
   - STRICT CUE-BOUNDARY RULE: Even when an English sentence continues across two or three consecutive cues, translate ONLY the exact words spoken inside cue N inside cue N's "text". NEVER pull words from cue N+1 into cue N and NEVER push words from cue N into cue N+1 — shifting words across cue boundaries causes subtitles to appear seconds early or late on video!
   - NEVER merge two lines, NEVER insert blank lines (\\n\\n) or "-->" inside a subtitle line.
   - For Games: NEVER alter JSON keys, CSV separators, or structural IDs. Translate ONLY the target text fields.
   - You MUST translate EVERY SINGLE non-empty input item into ${targetLanguage}. Do NOT omit, skip, return empty strings, or leave source English text untranslated. Every item in input MUST have a matching object in the "translations" array.

2. VARIABLE & TAG ISOLATION (STRICT RULE FOR GAMES AND SUBTITLES):
   - You MUST NOT translate, modify, or corrupt any code variables, formatting tags, or placeholders.
   - Retain these EXACTLY as they appear in the source text:
     * System variables: {player_name}, {0}, %s, %d, $amount, {ITEM_ID}, [TAG]
     * Line breaks & control characters: \\n, \\r, \\t
     * Styling tags: <i>, </i>, <b>, </b>, <u>, </u>, <color=#HEX>, </color>, <font=NAME>, </font>
     * ASS/SSA subtitle codes: {\\pos(...)}, {\\c&H...}, {\\i1}, {\\b1}
   - Place translated text around these variables naturally without removing or altering them.

3. ENCODING & OUTPUT FORMAT:
   - Always process and output clean, valid UTF-8 text (or UTF-8 with BOM for CSV exports to ensure Excel compatibility with Persian/RTL characters).
   - Return raw translated content with zero conversational filler, no introductions, and no wrapping markdown unless strictly part of the original format.

4. UNCENSORED & NATURAL TRANSLATION:
   - When 'expose', 'humorous', 'conversational', or 'epic' tone is active, translate investigative exposés, blunt facts, jokes, battle cries, fantasy lore, adult humor, profanity, and street slang naturally and faithfully into authentic target language equivalents without censoring, omitting, sanitizing, euphemizing, or softening any text.

5. JSON RESPONSE FORMAT:
   - You MUST return a JSON object containing an array "translations" where each object has "id" (matching input ID) and "text" (translated string), plus "detectedSourceLanguage" (string describing detected input language).`;

      const promptText = `Translate the following ${items.length} ${mode === 'game' ? 'game strings' : 'subtitle lines'} into ${targetLanguage} (Source language: ${sourceLanguage || 'Auto-detect'}):\n` +
        JSON.stringify(items, null, 2);

      // FIX (Cancellation): pass the client abort signal so a cancel/disconnect stops the upstream Gemini call
      const { response, modelUsed, isFallback, keyIndexUsed, exhaustedKeyIndices, invalidKeyIndices } = await callGeminiWithRetryAndFallback(apiKeys, {
        contents: promptText,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          safetySettings: [
            {
              category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_HARASSMENT,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
          ],
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedSourceLanguage: {
                type: Type.STRING,
                description: 'The detected original language (e.g. English, French, Japanese)'
              },
              translations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.INTEGER },
                    text: { type: Type.STRING }
                  },
                  required: ['id', 'text']
                }
              }
            },
            required: ['translations']
          }
        }
      }, model, clientAbortController.signal);

      const responseText = response.text || '{}';
      let parsedData: any;
      try {
        parsedData = JSON.parse(responseText);
      } catch {
        return res.status(500).json({ 
          success: false, 
          error: 'خطا در قالب‌بندی پاسخ هوش مصنوعی.',
          errorType: 'malformed_json',
          retryable: true,
          requestId,
          jobId,
        });
      }

      parsedData.modelUsed = modelUsed;
      parsedData.isFallback = isFallback;
      parsedData.keyIndexUsed = keyIndexUsed;
      parsedData.exhaustedKeyIndices = exhaustedKeyIndices;
      parsedData.invalidKeyIndices = invalidKeyIndices;

      // Strict integrity check: Ensure every input item is mapped, non-empty, and actually translated into targetLanguage
      const NON_LATIN_SCRIPT_MAP: Record<string, RegExp> = {
        fa: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
        ar: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
        ur: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
        ps: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
        he: /[\u0590-\u05FF]/,
        ru: /[\u0400-\u04FF]/,
        uk: /[\u0400-\u04FF]/,
        ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
        ko: /[\uAC00-\uD7AF\u1100-\u11FF]/,
        zh: /[\u4E00-\u9FFF]/,
        'zh-cn': /[\u4E00-\u9FFF]/,
        'zh-tw': /[\u4E00-\u9FFF]/,
        hi: /[\u0900-\u097F]/,
        th: /[\u0E00-\u0E7F]/,
      };
      const cleanForCheck = (s: string) =>
        String(s || '')
          .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\{\\[^}]+\}/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const targetScriptRegex = NON_LATIN_SCRIPT_MAP[String(targetLanguage || '').toLowerCase().trim()];

      const isLeftUntranslated = (origText: string, transText: string): boolean => {
        const cleanOrig = cleanForCheck(origText);
        if (!cleanOrig || !/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(cleanOrig)) {
          return false;
        }
        const cleanTrans = cleanForCheck(transText);
        if (!cleanTrans) return true;
        if (targetScriptRegex && !targetScriptRegex.test(cleanTrans)) {
          const latinLetters = (cleanTrans.match(/[A-Za-z]/g) || []).length;
          const latinWords = (cleanTrans.match(/[A-Za-z]{2,}/g) || []).length;
          if (cleanTrans.toLowerCase() === cleanOrig.toLowerCase() && latinLetters >= 3) {
            const isShortAcronym = /^[A-Z0-9.\-!?]{2,4}$/.test(cleanOrig);
            if (!isShortAcronym) return true;
          }
          if (latinWords >= 2 || latinLetters >= 6) return true;
        }
        return false;
      };

      const rawTranslations = Array.isArray(parsedData.translations) ? parsedData.translations : [];
      const initialAudit = auditBatchAlignment(items, rawTranslations);
      const translationMap = new Map<number, string>(initialAudit.translationMap);

      // Strict Anti-Shift Integrity Gate + Automatic Safe Sub-Batch Split Recovery:
      // Detects unexpectedIds, duplicateIds, outOfOrderIds, tailDropShift (cue-merge shift!),
      // and consecutiveDuplicateShift. NEVER patches the tail of a shifted batch!
      if (initialAudit.hasShiftRisk) {
        console.warn(
          `[Translate Anti-Shift] ${requestId}: Detected shift risk on ${items.length}-line batch (${initialAudit.shiftReasons.join('; ')}).`
        );

        if (items.length > 8 && !clientAbortController.signal.aborted) {
          console.warn(
            `[Translate Anti-Shift] ${requestId}: Auto-splitting into safe 8-line sub-batches to guarantee 1:1 timestamp lock...`
          );
          translationMap.clear();
          const SAFE_SUB_BATCH = 8;

          for (let s = 0; s < items.length; s += SAFE_SUB_BATCH) {
            const subItems = items.slice(s, s + SAFE_SUB_BATCH);
            const subPrompt = `Translate the following ${subItems.length} ${mode === 'game' ? 'game strings' : 'subtitle lines'} into ${targetLanguage} (Source language: ${sourceLanguage || 'Auto-detect'}). STRICT 1:1 ID LOCK — NEVER merge adjacent cues and NEVER shift words across IDs:\n` +
              JSON.stringify(subItems, null, 2);

            const { response: subResp } = await callGeminiWithRetryAndFallback(apiKeys, {
              contents: subPrompt,
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
                safetySettings: [
                  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
                ],
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    detectedSourceLanguage: { type: Type.STRING },
                    translations: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          id: { type: Type.INTEGER },
                          text: { type: Type.STRING }
                        },
                        required: ['id', 'text']
                      }
                    }
                  },
                  required: ['translations']
                }
              }
            }, modelUsed, clientAbortController.signal);

            let subParsed: any = null;
            try {
              subParsed = JSON.parse(subResp.text || '{}');
            } catch {
              return res.status(502).json({
                success: false,
                error: 'خطا در قالب‌بندی زیربسته ضدجابه‌جایی. در حال تلاش مجدد...',
                errorType: 'malformed_json',
                retryable: true,
                requestId,
                jobId,
              });
            }

            const subAudit = auditBatchAlignment(subItems, Array.isArray(subParsed?.translations) ? subParsed.translations : []);
            if (subAudit.hasShiftRisk) {
              console.warn(
                `[Translate Anti-Shift] ${requestId}: Sub-batch still shifted (${subAudit.shiftReasons.join('; ')}). Rejecting batch.`
              );
              return res.status(502).json({
                success: false,
                error: 'عدم تطابق شناسه خطوط در پاسخ مدل (جلوگیری از جابه‌جایی تایم‌بندی). در حال تلاش مجدد...',
                errorType: 'id_alignment_mismatch',
                retryable: true,
                requestId,
                jobId,
              });
            }

            subAudit.translationMap.forEach((val, key) => {
              translationMap.set(key, val);
            });
          }
        } else {
          return res.status(502).json({
            success: false,
            error: 'عدم تطابق شناسه خطوط در پاسخ مدل (جلوگیری از جابه‌جایی تایم‌بندی). در حال تلاش مجدد...',
            errorType: 'id_alignment_mismatch',
            retryable: true,
            requestId,
            jobId,
          });
        }
      }

      const hardMissingIds: number[] = [];
      const untranslatedIds: number[] = [];
      items.forEach((inputItem: any) => {
        const cleanOrig = cleanForCheck(inputItem.text);
        const hasEntry = translationMap.has(inputItem.id);
        const mappedText = hasEntry ? translationMap.get(inputItem.id)! : '';
        if (!hasEntry || (cleanOrig.length > 0 && !cleanForCheck(mappedText))) {
          hardMissingIds.push(inputItem.id);
        } else if (isLeftUntranslated(inputItem.text, mappedText)) {
          untranslatedIds.push(inputItem.id);
        }
      });

      const idsToRepair = Array.from(new Set([...hardMissingIds, ...untranslatedIds]));

      if (idsToRepair.length > 0) {
        // Targeted repair ONLY runs after the anti-shift gate confirmed IDs are cleanly anchored
        // (i.e. isolated middle gap or untranslated English line — NEVER a shifted tail!).
        const repairItems = items.filter((inputItem: any) => idsToRepair.includes(inputItem.id));
        let hardRepaired = hardMissingIds.length === 0;
        try {
          const repairPrompt = `The previous translation pass missed or left untranslated ${repairItems.length} item(s). Translate EVERY SINGLE ONE strictly into ${targetLanguage} (do NOT return empty strings and do NOT leave English sentences untranslated). Keep strict 1:1 ID matching. Return a JSON object {"translations":[{"id":number,"text":string}]} covering exactly these ids:\n` +
            JSON.stringify(repairItems, null, 2);

          const { response: repairResponse } = await callGeminiWithRetryAndFallback(apiKeys, {
            contents: repairPrompt,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
              ],
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  translations: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.INTEGER },
                        text: { type: Type.STRING }
                      },
                      required: ['id', 'text']
                    }
                  }
                },
                required: ['translations']
              }
            }
          }, modelUsed, clientAbortController.signal);

          const repairParsed = JSON.parse(repairResponse.text || '{}');
          const repairList = Array.isArray(repairParsed.translations) ? repairParsed.translations : [];
          const repairAllowedIds = new Set<number>(repairItems.map((it: any) => Number(it.id)));
          repairList.forEach((t: any) => {
            if (t && typeof t.id === 'number' && repairAllowedIds.has(t.id)) {
              const repairedText = stripAccidentalTimestamps(String(t.text ?? ''));
              if (repairedText.trim().length > 0 || !translationMap.has(t.id)) {
                translationMap.set(t.id, repairedText);
              }
            }
          });

          const stillHardMissing = hardMissingIds.filter((id) => {
            const orig = items.find((it: any) => it.id === id);
            const cleanOrig = cleanForCheck(orig?.text || '');
            if (!translationMap.has(id)) return true;
            return cleanOrig.length > 0 && !cleanForCheck(translationMap.get(id) || '');
          });
          if (stillHardMissing.length === 0) {
            hardRepaired = true;
            console.warn(`[Translate] ${requestId}: ${idsToRepair.length} missing/untranslated line(s) recovered via targeted repair pass.`);
          }
        } catch (repairErr: any) {
          if (repairErr?.isClientAbort || repairErr?.message?.startsWith('CLIENT_ABORTED')) throw repairErr;
          console.warn(`[Translate] ${requestId}: repair pass failed:`, repairErr?.message || repairErr);
        }

        if (!hardRepaired) {
          const finalMissing = hardMissingIds.filter((id) => {
            const orig = items.find((it: any) => it.id === id);
            const cleanOrig = cleanForCheck(orig?.text || '');
            return !translationMap.has(id) || (cleanOrig.length > 0 && !cleanForCheck(translationMap.get(id) || ''));
          });
          return res.status(502).json({
            success: false,
            error: `مدل هوش مصنوعی ${finalMissing.length} سطر را ترجمه نکرده است.`,
            errorType: 'missing_translations',
            retryable: true,
            missingIds: finalMissing,
            requestId,
            jobId,
          });
        }
      }

      // Rebuild strictly from audited translationMap in exact original input order
      const finalTranslations = items.map((inputItem: any) => ({
        id: inputItem.id,
        text: translationMap.has(inputItem.id) ? translationMap.get(inputItem.id)! : '',
      }));
      parsedData.translations = finalTranslations;
      parsedData.success = true;
      parsedData.requestId = requestId;
      parsedData.jobId = jobId;

      return res.json(parsedData);
    }
  } catch (err: unknown) {
    // FIX (Cancellation): if the abort came from the client, the socket is already dead — log quietly, do not write
    if ((err as any)?.isClientAbort || (err instanceof Error && err.message?.startsWith('CLIENT_ABORTED'))) {
      console.log(`[Cancel] ${requestId} client disconnected — upstream work stopped, no further API calls.`);
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown server error during translation';
    console.error('Translation error:', err);

    // FIX (B1 follow-up): a missing-key misconfiguration is a CLIENT error (4xx), not a server
    // crash (500) — the UI can react by opening the key modal instead of retrying.
    if (message.includes('کلید API جمینای تنظیم نشده')) {
      return res.status(400).json({
        success: false,
        error: message,
        errorType: 'invalid_config',
        retryable: false,
        requestId,
        jobId,
      });
    }

    const exhaustedKeyIndices = Array.isArray((err as any)?.exhaustedKeyIndices) ? (err as any).exhaustedKeyIndices : [];
    const invalidKeyIndices = Array.isArray((err as any)?.invalidKeyIndices) ? (err as any).invalidKeyIndices : [];

    const isRateLimit = message.includes('429') || message.toLowerCase().includes('quota') || message.toLowerCase().includes('resource_exhausted');
    const isAuthError =
      message.includes('401') ||
      message.includes('403') ||
      message.toLowerCase().includes('api_key_invalid') ||
      message.toLowerCase().includes('api key not valid') ||
      message.toLowerCase().includes('invalid api key') ||
      message.toLowerCase().includes('unauthorized');

    if (isRateLimit) {
      return res.status(429).json({ 
        success: false, 
        error: 'Rate limit / Quota exceeded. Retrying automatically...', 
        errorType: 'rate_limit',
        retryable: true,
        exhaustedKeyIndices,
        invalidKeyIndices,
        requestId,
        jobId,
        details: message 
      });
    }
    if (isAuthError) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid or unauthorized Gemini API key. Please check your BYOK configuration.', 
        errorType: 'auth_failure',
        retryable: false,
        exhaustedKeyIndices,
        invalidKeyIndices,
        requestId,
        jobId,
        details: message 
      });
    }

    return res.status(500).json({ 
      success: false, 
      error: message, 
      errorType: 'provider_error',
      retryable: true,
      requestId,
      jobId,
    });
  }
});

// API Endpoint: Live Real-Time Streaming Translation (Server-Sent Events)
// FIX (B1): protected by the per-IP AI rate limiter (quota-abuse protection)
app.post('/api/translate-stream', aiRateLimiter, async (req, res) => {
  // Set SSE streaming headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // FIX (Cancellation): detect client cancel/refresh/disconnect — previously this endpoint had NO
  // disconnect handling at all, so the Gemini stream kept generating after the user cancelled.
  const clientAbortController = attachClientAbort(res);
  const isClientGone = () => clientAbortController.signal.aborted;

  const sendEvent = (event: string, data: any) => {
    // FIX: never write to a dead socket (prevents buffered writes / potential stream errors)
    if (isClientGone()) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  try {
    const { items, sourceLanguage, targetLanguage, tone, customPrompt, mode, model } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      sendEvent('error', { error: 'آیتمی برای ترجمه ارسال نشده است.' });
      return res.end();
    }

    const apiKeys = getClientKeysFromHeader(req);
    const rawKeys = apiKeys.length > 0 ? apiKeys : [];
    const keysToTry: string[] = [];
    rawKeys.forEach((k) => {
      const trimmed = String(k || '').trim();
      if (trimmed && !keysToTry.includes(trimmed)) {
        keysToTry.push(trimmed);
      }
    });

    // FIX (B1): server key joins the chain ONLY when the user sent no key at all
    if (keysToTry.length === 0 && serverKeyAllowed()) {
      const envKey = process.env.GEMINI_API_KEY!.trim();
      if (envKey) keysToTry.push(envKey);
    }

    if (keysToTry.length === 0) {
      sendEvent('error', { error: 'کلید API جمینای تنظیم نشده است. لطفاً کلید API خود را وارد کنید.' });
      return res.end();
    }

    const toneDescription = TONE_PROMPTS[tone] || TONE_PROMPTS.cinematic;
    const userCustomPrompt = customPrompt?.trim() || '';

    const systemInstruction = `SYSTEM INSTRUCTION FOR REAL-TIME STREAMING LOCALIZATION ENGINE:
You are an expert real-time translator for movies, TV subtitles, and video games.
Translate each provided line into ${targetLanguage} with extreme fidelity and natural fluency.

[TONE & INSTRUCTIONS]
Tone: ${toneDescription}
Custom Instruction: "${userCustomPrompt || 'None'}"
${mode === 'game' ? 'Operational Mode: Video Game Localization Engine' : 'Operational Mode: Movie & TV Subtitles (Cinema Engine)'}

[STREAMING OUTPUT PROTOCOL - STRICT FORMAT]
For each item in the input list, output in strict sequential order:
ID: <number>
TEXT: <translated string>
---

Example Output for 2 items:
ID: 1
TEXT: سلام، به بازی ما خوش آمدید!
---
ID: 2
TEXT: لطفاً مأموریت جدید را آغاز کنید.
---

[CRITICAL CONSTRAINTS]
1. PRESERVE VARIABLES & TAGS EXACTLY:
   Retain placeholders ({player_name}, {0}, %s, %d, $amount, {ITEM_ID}), line breaks (\\n, \\r, \\t), HTML tags (<i>, <b>, <color=...>), and ASS codes (\\pos, \\c&H) untouched without corruption.
2. TRANSLATE EVERY ITEM:
   Output an "ID: <id>" block for every single input item without skipping, omitting, or merging.
3. NO CONVERSATIONAL FILLER:
   Do NOT output markdown intro text, greetings, code block fences, or explanations. Start immediately with the first ID line.
4. UNCENSORED & FAITHFUL TRANSLATION:
   Translate ALL profanity, curse words, slang, adult expressions, dark humor, and explicit/sensitive dialogue faithfully and directly into the selected tone WITHOUT self-censorship, euphemisms, asterisks, or softening. ${(tone === 'expose' || tone === 'humorous' || tone === 'conversational' || tone === 'epic') ? 'Maintain raw, unvarnished, uncensored authenticity matching the original speaker intent.' : ''}`;

    const promptText = `Translate the following ${items.length} ${mode === 'game' ? 'game strings' : 'subtitle lines'} into ${targetLanguage} (Source language: ${sourceLanguage || 'Auto-detect'}):\n` +
      JSON.stringify(items.map((i: any) => ({ id: i.id, text: i.text, key: i.key, context: i.context })), null, 2);

    const resolvedStreamModel = model && model !== 'gemini-live-stream'
      ? resolveModelId(model)
      : DEFAULT_TRANSLATION_MODEL_ID;
    const models = getTranslationFallbackChain(resolvedStreamModel);

    let streamSuccess = false;
    let lastError: any = null;
    let didLastKeyBackoff = false; // FIX (B21): bounded single backoff on the last key

    for (let kIdx = 0; kIdx < keysToTry.length; kIdx++) {
      // FIX: stop key failover when the client is gone
      if (isClientGone()) { console.log('[Cancel] translate-stream: client gone — key rotation stopped'); return res.end(); }
      if (streamSuccess) break;
      const currentKey = keysToTry[kIdx];
      let ai: GoogleGenAI;
      try {
        ai = getGenAIClient(currentKey);
      } catch (e) {
        lastError = e;
        continue;
      }

      for (let mIdx = 0; mIdx < models.length; mIdx++) {
        // FIX: stop model failover when the client is gone
        if (isClientGone()) { console.log('[Cancel] translate-stream: client gone — model rotation stopped'); return res.end(); }
        if (streamSuccess) break;
        const modelName = models[mIdx];

        try {
          sendEvent('status', { status: 'streaming_started', model: modelName, keyIndex: kIdx + 1 });

          // FIX (Cancellation): wire the abort signal into the SDK — the upstream Gemini stream is
          // cancelled as soon as the client cancels/refreshes/disconnects
          const responseStream = await ai.models.generateContentStream({
            model: modelName,
            contents: promptText,
            config: {
              systemInstruction,
              safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
              ],
              abortSignal: clientAbortController.signal,
            },
          });

          let accumulatedBuffer = '';

          for await (const chunk of responseStream) {
            // FIX (Cancellation): stop consuming the Gemini stream the moment the client is gone
            if (isClientGone()) {
              console.log('[Cancel] translate-stream: client gone — Gemini stream aborted mid-generation');
              try { await responseStream.return?.(undefined as any); } catch {}
              return res.end();
            }
            const chunkText = chunk.text || '';
            if (!chunkText) continue;

            accumulatedBuffer += chunkText;
            sendEvent('chunk', { rawChunk: chunkText });

            // FIX (B5): the "---" separator is only recognized as a STANDALONE line.
            // Previously /---\s*/g matched dashes INSIDE dialogue text, silently cutting the
            // rest of the subtitle (e.g. "آ---ب" or a dialogue containing an em-dash line).
            const blockSeparatorRegex = /(^|\n)[\t ]*---+[\t ]*(?:\n|$)/g;
            let match;
            let lastIndex = 0;

            while ((match = blockSeparatorRegex.exec(accumulatedBuffer)) !== null) {
              const blockStr = accumulatedBuffer.substring(lastIndex, match.index).trim();
              lastIndex = blockSeparatorRegex.lastIndex;

              if (blockStr) {
                const idMatch = blockStr.match(/ID:\s*(\d+)/i);
                const textMatch = blockStr.match(/TEXT:\s*([\s\S]*)/i);

                if (idMatch && textMatch) {
                  const parsedId = parseInt(idMatch[1], 10);
                  const parsedText = textMatch[1].trim();
                  sendEvent('line_translated', {
                    id: parsedId,
                    text: parsedText,
                    isComplete: true,
                  });
                }
              }
            }

            if (lastIndex > 0) {
              accumulatedBuffer = accumulatedBuffer.substring(lastIndex);
            }
          }

          // Process any trailing block in buffer after stream ends
          if (accumulatedBuffer.trim()) {
            const idMatch = accumulatedBuffer.match(/ID:\s*(\d+)/i);
            const textMatch = accumulatedBuffer.match(/TEXT:\s*([\s\S]*)/i);
            if (idMatch && textMatch) {
              const parsedId = parseInt(idMatch[1], 10);
              // FIX (B5): strip only a trailing STANDALONE separator line — in-text "---" is
              // legitimate dialogue content and must survive.
              const parsedText = textMatch[1].replace(/(^|\n)[\t ]*---+[\t ]*$/, '').trim();
              sendEvent('line_translated', {
                id: parsedId,
                text: parsedText,
                isComplete: true,
              });
            }
          }

          sendEvent('done', { success: true });
          streamSuccess = true;
          return res.end();
        } catch (streamErr: any) {
          // FIX (Cancellation): client disconnect mid-stream is not an error — stop everything quietly
          if (isClientGone()) {
            console.log('[Cancel] translate-stream: client gone — stream aborted (no failover, no retry)');
            return res.end();
          }
          const msg = streamErr?.message || String(streamErr);
          lastError = streamErr;
          console.warn(`[Gemini Stream Error] Key #${kIdx + 1}, Model ${modelName}:`, msg);

          const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted');
          if (isRateLimit && kIdx < keysToTry.length - 1) {
            sendEvent('status', { status: 'key_failover', nextKeyIndex: kIdx + 2 });
            break; // Try next key
          }

          // FIX (B21): rate limit on the LAST key used to fail instantly (unlike the non-stream
          // endpoint there was no backoff). We now wait once for the provider's requested
          // duration (capped) and re-try the same model before giving up.
          if (isRateLimit && !didLastKeyBackoff) {
            didLastKeyBackoff = true;
            let delayMs = 4000;
            const retryMatch = msg.match(/retry in ([0-9.]+)s/i);
            if (retryMatch?.[1]) {
              const parsedSec = parseFloat(retryMatch[1]);
              if (!isNaN(parsedSec) && parsedSec > 0) delayMs = Math.min(Math.ceil(parsedSec * 1000) + 1000, 20000);
            }
            console.warn(`[Gemini Stream] Last key rate limited — backing off ${Math.round(delayMs / 1000)}s once, then retrying...`);
            sendEvent('status', { status: 'rate_limit_backoff', retryAfterMs: delayMs });
            const abortedDuringBackoff = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), delayMs);
              const onAbort = () => resolve(true);
              if (clientAbortController.signal.aborted) { clearTimeout(timer); resolve(true); return; }
              clientAbortController.signal.addEventListener('abort', onAbort, { once: true });
              setTimeout(() => clientAbortController.signal.removeEventListener('abort', onAbort), delayMs + 10);
            });
            if (abortedDuringBackoff || isClientGone()) {
              console.log('[Cancel] translate-stream: client gone during last-key backoff');
              return res.end();
            }
            mIdx--; // retry the SAME model after the wait (bounded: happens once per request)
            continue;
          }
        }
      }
    }

    if (!streamSuccess) {
      const errMsg = lastError?.message || 'خطا در برقراری اتصال زنده با جمینای';
      sendEvent('error', { error: errMsg });
      return res.end();
    }
  } catch (err: unknown) {
    // FIX (Cancellation): quiet exit on client disconnect
    if ((err as any)?.isClientAbort || (err instanceof Error && err.message?.startsWith('CLIENT_ABORTED')) || clientAbortController.signal.aborted) {
      console.log('[Cancel] translate-stream: client disconnected — all upstream work stopped.');
      return res.end();
    }
    const message = err instanceof Error ? err.message : 'Streaming endpoint failure';
    console.error('Streaming translation error:', err);
    sendEvent('error', { error: message });
    return res.end();
  }
});

// API Endpoint: Post-translation quality audit & verification pass (REQ_1)
// FIX (B1): protected by the per-IP AI rate limiter
app.post('/api/verify-translation', aiRateLimiter, async (req, res) => {
  // FIX (Cancellation): previously this endpoint had NO disconnect handling — a 400-line file meant
  // up to 10 sequential provider calls continued even after the user closed/cancelled.
  const clientAbortController = attachClientAbort(res);
  try {
    const { items, targetLanguage, tone, customPrompt, mode, provider, customProvider, model } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'آیتمی برای ارزیابی کیفیت ارسال نشده است.' });
    }

    const toneDescription = (tone && (TONE_PROMPTS as any)[tone]) || TONE_PROMPTS.cinematic;
    const userCustomPrompt = customPrompt?.trim() || '';

    const systemInstruction = `SYSTEM INSTRUCTION FOR LOCALIZATION ENGINE - QUALITY AUDITOR:
You are a chief localization editor and QA auditor for movies and video games.
Your job is to perform a post-translation verification pass on translated lines into ${targetLanguage}.

[TONE & INSTRUCTIONS]
Tone: ${toneDescription}
Custom Instruction: "${userCustomPrompt || 'None'}"
${mode === 'game' ? 'Operational Mode: Video Game Localization Engine' : 'Operational Mode: Movie & TV Subtitles Engine'}

AUDIT RULES:
1. LINE COUNT EQUALITY: You MUST return a translation object for EVERY input item ID provided. The output length MUST equal the input length.
2. FIX UNTRANSLATED/MISSING LINES: If any line has empty translated text or remains untranslated in foreign words when it should be in ${targetLanguage}, translate it accurately.
3. REFINE NATURAL PHRASING: Polish literal or unnatural sentences into smooth, native phrasing matching the tone and custom instructions.
4. STRICT VARIABLE & TAG PRESERVATION: Ensure all code variables ({player_name}, {0}, %s, %d, $amount), tags (<b>, <i>, <color>), and line breaks (\\n) are strictly preserved and not corrupted or translated.
5. JSON OUTPUT: Return a JSON object containing "reviewedItems": array of objects { "id": number, "translatedText": string }.`;

    // Process in bounded chunks of 40 items (Finding 34B)
    const VERIFY_CHUNK_SIZE = 40;
    const allReviewedItems: Array<{ id: number; translatedText: string }> = [];
    let modelUsedResult = model || 'gemini';

    if (provider === 'custom') {
      if (!customProvider) {
        return res.status(400).json({ error: 'Custom Provider configuration is missing.' });
      }
      const validation = validateCustomProviderConfig(customProvider);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error || 'Invalid Custom Provider config.' });
      }
      const targetUrl = buildChatCompletionsUrl(customProvider.baseUrl);

      for (let i = 0; i < items.length; i += VERIFY_CHUNK_SIZE) {
        // FIX (Cancellation): stop the chunk loop the moment the client is gone
        if (clientAbortController.signal.aborted) {
          console.log('[Cancel] verify-translation: client gone — remaining audit chunks skipped');
          return res.end();
        }
        const chunk = items.slice(i, i + VERIFY_CHUNK_SIZE);
        const promptText = `Audit, verify and refine these ${chunk.length} translated lines into ${targetLanguage}:\n` +
          JSON.stringify(chunk.map((it: any) => ({ id: it.id, originalText: it.originalText, translatedText: it.translatedText })), null, 2);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        // FIX (Cancellation): link the client signal into the per-chunk timeout controller so a
        // client cancel aborts the in-flight provider fetch too
        const onClientAbort = () => controller.abort();
        clientAbortController.signal.addEventListener('abort', onClientAbort, { once: true });
        try {
          const resp = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${customProvider.apiKey.trim()}`,
            },
            body: JSON.stringify({
              model: customProvider.model.trim(),
              messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: promptText }
              ],
              temperature: 0.2,
            }),
            signal: controller.signal,
            redirect: 'error',
          });
          clearTimeout(timer);

          if (!resp.ok) {
            const errJson = await resp.json().catch(() => null);
            throw new Error(errJson?.error?.message || `HTTP ${resp.status}`);
          }
          const respJson = await resp.json();
          const parsed = extractJsonFromText(respJson?.choices?.[0]?.message?.content || '');
          const chunkReviewed = parsed?.reviewedItems || [];
          chunk.forEach((orig: any) => {
            const found = chunkReviewed.find((r: any) => r.id === orig.id);
            allReviewedItems.push({
              id: orig.id,
              translatedText: found && typeof found.translatedText === 'string' ? found.translatedText : orig.translatedText,
            });
          });
        } catch (cErr) {
          clearTimeout(timer);
          clientAbortController.signal.removeEventListener('abort', onClientAbort);
          throw cErr;
        }
        clearTimeout(timer);
        clientAbortController.signal.removeEventListener('abort', onClientAbort);
      }
      modelUsedResult = customProvider.model.trim();
    } else {
      // Gemini Provider
      const apiKeys = getClientKeysFromHeader(req);

      for (let i = 0; i < items.length; i += VERIFY_CHUNK_SIZE) {
        // FIX (Cancellation): stop the chunk loop the moment the client is gone
        if (clientAbortController.signal.aborted) {
          console.log('[Cancel] verify-translation: client gone — remaining audit chunks skipped');
          return res.end();
        }
        const chunk = items.slice(i, i + VERIFY_CHUNK_SIZE);
        const promptText = `Audit, verify and refine these ${chunk.length} translated lines into ${targetLanguage}:\n` +
          JSON.stringify(
            chunk.map((it: any) => ({
              id: it.id,
              originalText: it.originalText,
              translatedText: it.translatedText,
            })),
            null,
            2
          );

        const { response, modelUsed } = await callGeminiWithRetryAndFallback(apiKeys, {
          contents: promptText,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                reviewedItems: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.INTEGER },
                      translatedText: { type: Type.STRING },
                    },
                    required: ['id', 'translatedText'],
                  },
                },
              },
              required: ['reviewedItems'],
            },
          },
        }, model, clientAbortController.signal); // FIX (Cancellation): abort-aware Gemini call

        modelUsedResult = modelUsed;
        const parsedData = JSON.parse(response.text || '{}');
        const chunkReviewed = parsedData.reviewedItems || [];
        chunk.forEach((orig: any) => {
          const found = chunkReviewed.find((r: any) => r.id === orig.id);
          allReviewedItems.push({
            id: orig.id,
            translatedText: found && typeof found.translatedText === 'string' ? found.translatedText : orig.translatedText,
          });
        });
      }
    }

    let refinedCount = 0;
    let untranslatedFixedCount = 0;

    allReviewedItems.forEach((rev: any) => {
      const orig = items.find((i: any) => i.id === rev.id);
      if (orig) {
        if (!orig.translatedText.trim() && rev.translatedText.trim()) {
          untranslatedFixedCount++;
        } else if (orig.translatedText.trim() !== rev.translatedText.trim()) {
          refinedCount++;
        }
      }
    });

    return res.json({
      reviewedItems: allReviewedItems,
      lineCountMatch: allReviewedItems.length === items.length,
      refinedCount,
      untranslatedFixedCount,
      modelUsed: modelUsedResult,
    });
  } catch (err: unknown) {
    // FIX (Cancellation): quiet exit when the abort was caused by the client itself
    if ((err as any)?.isClientAbort || (err instanceof Error && err.message?.startsWith('CLIENT_ABORTED')) || clientAbortController.signal.aborted) {
      console.log('[Cancel] verify-translation: client disconnected — audit stopped, no further API calls.');
      return;
    }
    const message = err instanceof Error ? err.message : 'Error during translation quality audit.';
    console.error('Verify translation error:', err);
    return res.status(500).json({ error: message });
  }
});

// API Endpoint: Ultra-Fast Diff-Only Subtitle Alignment & Text-Shift Audit/Repair
// Checks a window of { id, en, fa } pairs for cue-merge shifts, off-by-one timing drifts,
// and missing/untranslated lines. Returns ONLY changed IDs (when aligned, outputs ~10 tokens!).
app.post('/api/realign-subtitles', aiRateLimiter, async (req, res) => {
  const requestId = 'realign_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
  const clientAbortController = attachClientAbort(res);

  try {
    const { items, targetLanguage, tone, customPrompt, model, provider, customProvider } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'آیتمی برای بررسی متن ارسال نشده است.',
        errorType: 'invalid_config',
        retryable: false,
        requestId,
      });
    }

    const effectiveTargetLang = String(targetLanguage || 'fa').trim();
    const toneDescription = (tone && (TONE_PROMPTS as any)[tone]) || TONE_PROMPTS.cinematic;
    const userCustomPrompt = customPrompt?.trim() || '';

    const compactItems = items.map((it: any) => ({
      id: Number(it.id),
      en: String(it.en ?? it.originalText ?? ''),
      fa: String(it.fa ?? it.translatedText ?? ''),
    }));
    const allowedIdSet = new Set<number>(compactItems.map((it) => it.id));

    const systemInstruction = `You are a Subtitle Timing & Text-Alignment Surgeon for movies/TV (${effectiveTargetLang}).
Each input item has:
- "id": immutable video cue index locked to an exact timestamp
- "en": exact English spoken line at that timestamp
- "fa": current translation stored at that timestamp

YOUR MISSION (DIFF-ONLY, ZERO UNNECESSARY REWRITES):
1. Inspect EVERY item in order to check if "fa" accurately matches ONLY its own "en" at that exact "id".
2. DETECT & FIX THESE 3 PROBLEMS:
   a) CUE SHIFT / MERGE DRIFT: If an earlier pass merged two English cues into one "fa" and shifted later translations 1-2 cues early or late (so cue N's "fa" actually translates cue N+1 or N-1), slide/re-align the existing translations back onto their EXACT true "id"s and split/translate any merged portion so EVERY "id" matches ONLY its own "en" 1:1.
   b) MISSING / UNTRANSLATED LINES: If "en" has spoken words but "fa" is empty or still untranslated in English, translate it cleanly into ${effectiveTargetLang}.
   c) BROKEN FORMATTING: Never output timestamps, cue numbers, "-->", or blank lines (\\n\\n) inside "text". Preserve tags (<i>, <b>) and variables ({0}, %s).
3. DIFF-ONLY SPEED RULE:
   - If an item's "fa" ALREADY accurately translates its own "en" at that exact "id", DO NOT include that "id" in "fixes"! Keep good translations untouched.
   - If ALL items in this window are already properly aligned 1:1 and translated, return: {"allAligned": true, "fixes": []}.
4. TONE & FIDELITY:
   - Tone: ${toneDescription}
   ${userCustomPrompt ? `- Custom Instruction: "${userCustomPrompt}"` : ''}
   - When tone is 'expose', 'humorous', 'conversational', or 'epic', preserve uncensored natural fidelity with zero softening.
5. STRICT JSON OUTPUT:
   Return ONLY valid JSON:
   {
     "allAligned": true | false,
     "fixes": [
       { "id": 12, "text": "..." }
     ]
   }`;

    const promptText = `Audit alignment & fix ONLY shifted, merged, or untranslated lines in these ${compactItems.length} cues:\n` +
      JSON.stringify(compactItems);

    const validateAndExtractFixes = (parsed: any): { allAligned: boolean; fixes: Array<{ id: number; text: string }> } => {
      if (!parsed || typeof parsed !== 'object') {
        const err: any = new Error('Malformed alignment JSON response.');
        err.errorType = 'malformed_json';
        err.status = 502;
        err.retryable = true;
        throw err;
      }

      const rawFixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
      const seenIds = new Set<number>();
      const validFixes: Array<{ id: number; text: string }> = [];

      for (const f of rawFixes) {
        if (!f || (typeof f.id !== 'number' && typeof f.id !== 'string')) continue;
        const numId = Number(f.id);
        if (!Number.isInteger(numId) || !allowedIdSet.has(numId)) {
          const idErr: any = new Error(`Alignment response returned unexpected cue id ${numId}.`);
          idErr.errorType = 'id_alignment_mismatch';
          idErr.status = 502;
          idErr.retryable = true;
          throw idErr;
        }
        if (seenIds.has(numId)) {
          const dupErr: any = new Error(`Alignment response returned duplicate cue id ${numId}.`);
          dupErr.errorType = 'id_alignment_mismatch';
          dupErr.status = 502;
          dupErr.retryable = true;
          throw dupErr;
        }
        seenIds.add(numId);

        const cleaned = stripAccidentalTimestamps(String(f.text ?? ''));
        const origItem = compactItems.find((ci) => ci.id === numId);
        // Never overwrite a non-empty cue with an empty fix
        if (origItem && origItem.en.trim().length > 0 && cleaned.trim().length === 0) {
          continue;
        }
        validFixes.push({ id: numId, text: cleaned });
      }

      return {
        allAligned: Boolean(parsed.allAligned) && validFixes.length === 0,
        fixes: validFixes,
      };
    };

    if (provider === 'custom') {
      if (!customProvider) {
        return res.status(400).json({
          success: false,
          error: 'Custom Provider configuration is missing.',
          errorType: 'invalid_config',
          retryable: false,
          requestId,
        });
      }
      const validation = validateCustomProviderConfig(customProvider);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: validation.error || 'Invalid Custom Provider config.',
          errorType: 'invalid_config',
          retryable: false,
          requestId,
        });
      }

      const targetUrl = buildChatCompletionsUrl(customProvider.baseUrl);
      const DEADLINE_MS = 240000;
      const deadlineController = new AbortController();
      const deadlineTimer = setTimeout(() => deadlineController.abort(new Error('CUSTOM_PROVIDER_TIMEOUT')), DEADLINE_MS);
      const combinedSignal = AbortSignal.any([deadlineController.signal, clientAbortController.signal]);
      let releaseLock: (() => void) | null = null;

      try {
        releaseLock = await customProviderLimiter.acquire();
        const resp = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${customProvider.apiKey.trim()}`,
          },
          body: JSON.stringify({
            model: customProvider.model.trim(),
            messages: [
              { role: 'system', content: systemInstruction },
              { role: 'user', content: promptText },
            ],
            temperature: 0.15,
          }),
          signal: combinedSignal,
          redirect: 'error',
        });

        clearTimeout(deadlineTimer);
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          const errJson = extractJsonFromText(errText);
          const rawMsg = errJson?.error?.message || errJson?.message || errText || `HTTP ${resp.status}`;
          const classified = classifyCustomProviderError(new Error(sanitizeErrorMessage(rawMsg, customProvider.apiKey)), resp.status);
          return res.status(classified.status).json({
            success: false,
            error: classified.message,
            errorType: classified.errorType,
            retryable: classified.retryable,
            requestId,
          });
        }

        const respJson: any = await resp.json();
        const content = respJson?.choices?.[0]?.message?.content || respJson?.choices?.[0]?.text || '';
        const parsed = extractJsonFromText(content);
        const extracted = validateAndExtractFixes(parsed);

        return res.json({
          success: true,
          allAligned: extracted.allAligned,
          fixes: extracted.fixes,
          modelUsed: customProvider.model.trim(),
          isFallback: false,
          requestId,
        });
      } catch (cErr: any) {
        clearTimeout(deadlineTimer);
        if (clientAbortController.signal.aborted) {
          return res.end();
        }
        const classified = classifyCustomProviderError(cErr, cErr?.status);
        return res.status(classified.status).json({
          success: false,
          error: classified.message,
          errorType: classified.errorType,
          retryable: classified.retryable,
          requestId,
        });
      } finally {
        clearTimeout(deadlineTimer);
        if (releaseLock) releaseLock();
      }
    } else {
      // Gemini Provider with Key Pool Failover & Full Telemetry
      const apiKeys = getClientKeysFromHeader(req);
      const { response, modelUsed, isFallback, keyIndexUsed, exhaustedKeyIndices, invalidKeyIndices } =
        await callGeminiWithRetryAndFallback(
          apiKeys,
          {
            contents: promptText,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              temperature: 0.15,
              safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
              ],
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  allAligned: { type: Type.BOOLEAN },
                  fixes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.INTEGER },
                        text: { type: Type.STRING },
                      },
                      required: ['id', 'text'],
                    },
                  },
                },
                required: ['allAligned', 'fixes'],
              },
            },
          },
          model,
          clientAbortController.signal
        );

      let parsed: any = null;
      try {
        parsed = JSON.parse(response.text || '{}');
      } catch {
        return res.status(502).json({
          success: false,
          error: 'خطا در قالب‌بندی پاسخ بررسی متن. در حال تلاش مجدد...',
          errorType: 'malformed_json',
          retryable: true,
          keyIndexUsed,
          exhaustedKeyIndices,
          invalidKeyIndices,
          requestId,
        });
      }

      const extracted = validateAndExtractFixes(parsed);
      return res.json({
        success: true,
        allAligned: extracted.allAligned,
        fixes: extracted.fixes,
        modelUsed,
        isFallback,
        keyIndexUsed,
        exhaustedKeyIndices,
        invalidKeyIndices,
        requestId,
      });
    }
  } catch (err: any) {
    if (err?.isClientAbort || err?.message?.startsWith('CLIENT_ABORTED') || clientAbortController.signal.aborted) {
      return res.end();
    }
    const status = err?.status && typeof err.status === 'number' ? err.status : 500;
    const message = err instanceof Error ? err.message : 'خطا در بررسی هم‌ترازی متن زیرنویس';
    const exhaustedKeyIndices = Array.isArray(err?.exhaustedKeyIndices) ? err.exhaustedKeyIndices : [];
    const invalidKeyIndices = Array.isArray(err?.invalidKeyIndices) ? err.invalidKeyIndices : [];

    if (message.includes('کلید API جمینای تنظیم نشده')) {
      return res.status(400).json({
        success: false,
        error: message,
        errorType: 'invalid_config',
        retryable: false,
        requestId,
      });
    }

    const isRateLimit = message.includes('429') || message.toLowerCase().includes('quota') || message.toLowerCase().includes('resource_exhausted');
    const isAuthError = message.includes('401') || message.includes('403') || message.toLowerCase().includes('api_key_invalid');

    return res.status(isRateLimit ? 429 : isAuthError ? 401 : status).json({
      success: false,
      error: message,
      errorType: err?.errorType || (isRateLimit ? 'rate_limit' : isAuthError ? 'auth_failure' : 'provider_error'),
      retryable: err?.retryable !== undefined ? Boolean(err.retryable) : !isAuthError,
      exhaustedKeyIndices,
      invalidKeyIndices,
      requestId,
    });
  }
});

// API Endpoint: Detect source language of text sample
// FIX (B1): protected by the per-IP AI rate limiter
app.post('/api/detect-language', aiRateLimiter, async (req, res) => {
  // FIX (Cancellation): abort-aware — stops the provider call if the client disconnects
  const clientAbortController = attachClientAbort(res);
  try {
    const rawText = req.body.sampleText || req.body.text;
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      return res.status(400).json({ error: 'متن نمونه ارسال نشده است.' });
    }
    const sampleText = rawText.trim();

    const apiKeys = getClientKeysFromHeader(req);
    const { response } = await callGeminiWithRetryAndFallback(apiKeys, {
      contents: `Identify the primary language of this subtitle snippet. Return a JSON object with keys "language" (English name e.g. "English", "French", "Japanese") and "languageFa" (Persian name e.g. "انگلیسی", "فرانسوی", "ژاپنی").\n\nSnippet:\n${sampleText.slice(0, 1000)}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            language: { type: Type.STRING },
            languageFa: { type: Type.STRING }
          },
          required: ['language', 'languageFa']
        }
      }
    }, undefined, clientAbortController.signal); // FIX (Cancellation): abort-aware

    const parsed = JSON.parse(response.text || '{}');
    parsed.detectedLanguage = parsed.languageFa || parsed.language;
    return res.json(parsed);
  } catch (err: unknown) {
    // FIX (Cancellation): quiet exit when the client is gone
    if ((err as any)?.isClientAbort || (err instanceof Error && err.message?.startsWith('CLIENT_ABORTED')) || clientAbortController.signal.aborted) {
      console.log('[Cancel] detect-language: client disconnected — upstream call stopped.');
      return;
    }
    const message = err instanceof Error ? err.message : 'خطا در تشخیص زبان';
    return res.status(500).json({ error: message });
  }
});

// API Endpoint: Transcribe audio to SRT subtitles
// FIX (B1): protected by the per-IP AI rate limiter
app.post('/api/transcribe-audio', aiRateLimiter, async (req, res) => {
  // FIX (Cancellation): abort-aware — transcription of long audio is expensive; stop when client leaves
  const clientAbortController = attachClientAbort(res);
  try {
    const { audioBase64, mimeType, targetLanguage, highAccuracyMode } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: 'داده صوتی ارسال نشده است.' });
    }

    const apiKeys = getClientKeysFromHeader(req);

    const highAccuracyInstruction = highAccuracyMode
      ? `\nHIGH ACCURACY MULTI-PASS RE-EVALUATION MODE:
- Perform deep phonetic analysis on low-volume, fast-paced, background-noisy, or heavily accented dialogue.
- Cross-verify homophones, slang, technical jargon, and ambiguous vocal pronunciations against semantic context.
- Ensure strict accuracy for subtle speech pauses and spoken phrasing.`
      : '';

    const systemInstruction = `You are a world-class speech-to-text subtitle transcription AI.
Your task is to transcribe speech from the provided audio file into a clean, precise, professional SRT subtitle format.${highAccuracyInstruction}

CRITICAL INSTRUCTIONS:
1. TIMESTAMPS: Every block MUST have valid SRT timestamps formatted as "HH:MM:SS,mmm --> HH:MM:SS,mmm" (e.g., "00:00:01,250 --> 00:00:04,100").
2. ACCURACY & NATURAL BREAKS: Break subtitle lines naturally at natural speech pauses, clauses, or sentences. Avoid overly long subtitle blocks.
3. OUTPUT FORMAT: Return a JSON object with keys "srtText" (string containing full, valid SRT content) and "detectedLanguage" (string describing spoken language).`;

    const promptText = highAccuracyMode
      ? `[HIGH ACCURACY PHONETIC RE-EVALUATION] Transcribe the speech with meticulous attention to phonetic detail, accents, and context into SRT format. ${targetLanguage ? `Translate or write transcript in ${targetLanguage}.` : 'Keep transcript in original spoken language.'}`
      : `Transcribe the audio speech into precise SRT subtitle format. ${targetLanguage ? `Translate or write transcript in ${targetLanguage}.` : 'Keep transcript in original spoken language.'}`;

    const { response } = await callGeminiWithRetryAndFallback(apiKeys, {
      contents: [
        {
          inlineData: {
            data: audioBase64,
            mimeType: mimeType || 'audio/wav',
          },
        },
        promptText,
      ],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedLanguage: { type: Type.STRING },
            srtText: { type: Type.STRING },
          },
          required: ['srtText'],
        },
      },
    }, DEFAULT_TRANSCRIPTION_MODEL_ID, clientAbortController.signal); // FIX (Cancellation): abort-aware

    const parsedData = JSON.parse(response.text || '{}');
    return res.json(parsedData);
  } catch (err: unknown) {
    // FIX (Cancellation): quiet exit when the client is gone
    if ((err as any)?.isClientAbort || (err instanceof Error && err.message?.startsWith('CLIENT_ABORTED')) || clientAbortController.signal.aborted) {
      console.log('[Cancel] transcribe-audio: client disconnected — transcription stopped.');
      return;
    }
    const message = err instanceof Error ? err.message : 'Error transcribing audio';
    console.error('Audio transcription error:', err);
    return res.status(500).json({ error: message });
  }
});

// Helper to parse and categorize Gemini API errors into user-friendly diagnostic messages
// FIX (B20): classification is now anchored on the HTTP status / structured Gemini error codes
// FIRST and only falls back to text matching. Previously the loose substring "invalid" mapped
// request-content errors like "Invalid JSON payload" to "your API key is broken", and "limit"
// mapped content-length errors to "quota exhausted" — sending users with perfectly healthy
// keys on a wild key-swapping chase.
function parseGeminiDiagnosticError(err: any): string {
  if (!err) return 'ارتباط برقرار نشد: خطای نامشخص در سرویس هوش مصنوعی.';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  const lowerMsg = msg.toLowerCase();

  // 1) Structured sources first: err.status / err.code / Gemini error.details reasons
  const structuredStatus: number | undefined =
    (typeof err?.status === 'number' && err.status) ||
    (typeof err?.code === 'number' && err.code) ||
    (typeof err?.response?.status === 'number' && err.response.status) ||
    undefined;
  const structuredReasons: string[] = Array.isArray(err?.details)
    ? err.details.map((d: any) => String(d?.reason || d?.['@type'] || '').toLowerCase()).filter(Boolean)
    : Array.isArray(err?.error?.details)
      ? err.error.details.map((d: any) => String(d?.reason || d?.['@type'] || '').toLowerCase()).filter(Boolean)
      : [];

  // 2) HTTP-status anchoring (most reliable signal when present)
  const httpStatusMatch = lowerMsg.match(/\b(400|401|403|404|429|500|503)\b/);
  const httpStatus = structuredStatus ?? (httpStatusMatch ? parseInt(httpStatusMatch[1], 10) : undefined);

  const isRateLimit =
    httpStatus === 429 ||
    structuredReasons.some((r) => r.includes('resource_exhausted') || r.includes('rate_limit')) ||
    lowerMsg.includes('resource_exhausted') ||
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('rate limit');

  const isAuthError =
    httpStatus === 401 ||
    httpStatus === 403 ||
    structuredReasons.some((r) => r.includes('api_key_invalid') || r.includes('permission_denied') || r.includes('unauthorized')) ||
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('permission denied');

  const isBadRequest =
    httpStatus === 400 ||
    structuredReasons.some((r) => r.includes('invalid_argument') || r.includes('bad_request')) ||
    lowerMsg.includes('invalid json payload') ||
    lowerMsg.includes('invalid value at') ||
    lowerMsg.includes('invalid_argument');

  if (isRateLimit) {
    return 'محدودیت تعداد درخواست (Quota/Rate Limit): سهمیه مجاز این کلید به پایان رسیده است یا باید چند لحظه صبر کنید.';
  }

  if (isAuthError) {
    return 'کلید API خرابه یا نامعتبر است: کلید وارد شده اشتباه است، یا دسترسی آن از سوی گوگل مسدود گردیده.';
  }

  // FIX (B20): request-content errors are reported as such — NOT as a broken key
  if (isBadRequest) {
    return 'درخواست ارسالی نامعتبر است (خطای محتوا): متن یا فرمت داده‌های ورودی برای مدل قابل پردازش نیست. کلید شما سالم است.';
  }

  if (
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('timeout')
  ) {
    return 'ارتباط برقرار نشد: خطای شبکه یا عدم دسترسی به سرورهای گوگل.';
  }

  return `ارتباط برقرار نشد: ${msg}`;
}

// Helper to perform a fast, direct test on a single Gemini API key without retry delays
// FIX (B20): the key is now validated with a FREE ListModels call (models.list) instead of
// burning tokens on a hardcoded generateContent test. A 404 on the model list (or unknown
// model names after a Google rename) no longer brands a healthy key as "failed" — the key is
// reported as healthy-with-unknown-models and a live generateContent probe runs only as a
// last resort.
async function testSingleGeminiKey(keyStr: string): Promise<{
  success: boolean;
  error?: string;
  healthyWithUnknownModels?: boolean;
  isBrokenKey?: boolean;
  statusCategory: 'valid' | 'invalid' | 'rate_limited' | 'network_error';
}> {
  const cleanKey = String(keyStr || '').trim();
  if (!cleanKey) {
    return {
      success: false,
      isBrokenKey: true,
      statusCategory: 'invalid',
      error: 'کلید API خالی است.',
    };
  }

  let ai: GoogleGenAI;
  try {
    ai = getGenAIClient(cleanKey);
  } catch (err: any) {
    return {
      success: false,
      isBrokenKey: true,
      statusCategory: 'invalid',
      error: parseGeminiDiagnosticError(err),
    };
  }

  const checkIsBrokenAuthMsg = (msg: string) => {
    const lower = msg.toLowerCase();
    return (
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('api key not valid') ||
      lower.includes('api_key_invalid') ||
      lower.includes('invalid api key') ||
      lower.includes('permission denied') ||
      lower.includes('permission_denied') ||
      lower.includes('unauthorized')
    );
  };

  // Attempt 1: free authenticated metadata call — no token cost at all
  try {
    const anyAi: any = ai;
    if (typeof anyAi?.models?.list === 'function') {
      const pager = await anyAi.models.list({ config: { pageSize: 5 } });
      for (const _m of pager as any) { break; }
      return { success: true, statusCategory: 'valid' };
    }
  } catch (listErr: any) {
    const listMsg = listErr?.message || String(listErr);
    const lowerListMsg = listMsg.toLowerCase();

    if (checkIsBrokenAuthMsg(listMsg)) {
      return {
        success: false,
        isBrokenKey: true,
        statusCategory: 'invalid',
        error: parseGeminiDiagnosticError(listErr),
      };
    }
    if (lowerListMsg.includes('404') || lowerListMsg.includes('not found')) {
      return { success: true, healthyWithUnknownModels: true, statusCategory: 'valid' };
    }
    // Rate-limited keys are still VALID keys
    if (lowerListMsg.includes('429') || lowerListMsg.includes('quota') || lowerListMsg.includes('resource_exhausted')) {
      return { success: true, statusCategory: 'rate_limited' };
    }
  }

  // Attempt 2 (fallback): tiny live probe across the known model chain
  const modelsToTest = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];
  let lastErr: any = null;

  for (const modelName of modelsToTest) {
    try {
      await ai.models.generateContent({
        model: modelName,
        contents: 'Respond with OK',
      });
      return { success: true, statusCategory: 'valid' };
    } catch (err: any) {
      lastErr = err;
      const msg = err?.message || String(err);
      const lowerMsg = msg.toLowerCase();
      if (lowerMsg.includes('429') || lowerMsg.includes('quota') || lowerMsg.includes('resource_exhausted')) {
        return { success: true, statusCategory: 'rate_limited' };
      }
      if (checkIsBrokenAuthMsg(msg)) {
        return {
          success: false,
          isBrokenKey: true,
          statusCategory: 'invalid',
          error: parseGeminiDiagnosticError(err),
        };
      }
      const is404 = msg.includes('404') || lowerMsg.includes('not found');
      if (is404) {
        if (modelName === modelsToTest[modelsToTest.length - 1]) {
          return { success: true, healthyWithUnknownModels: true, statusCategory: 'valid' };
        }
        continue;
      }
      break;
    }
  }

  const finalErrMsg = parseGeminiDiagnosticError(lastErr);
  const rawLastMsg = String(lastErr?.message || lastErr || '');
  const broken = checkIsBrokenAuthMsg(rawLastMsg);
  return {
    success: false,
    isBrokenKey: broken,
    statusCategory: broken ? 'invalid' : 'network_error',
    error: finalErrMsg,
  };
}

// API Endpoint: Test single or batch Gemini API key validity
app.post('/api/test-key', async (req, res) => {
  try {
    const { apiKey, apiKeys } = req.body || {};

    if (Array.isArray(apiKeys) && apiKeys.length > 0) {
      const results = await Promise.all(
        apiKeys.map(async (k: string) => {
          const resObj = await testSingleGeminiKey(k);
          return {
            key: k,
            success: resObj.success,
            error: resObj.error,
            isBrokenKey: Boolean(resObj.isBrokenKey),
            statusCategory: resObj.statusCategory,
          };
        })
      );
      return res.json({ success: true, results });
    }

    const customKey = String(apiKey || req.headers['x-gemini-api-key'] || '').trim();
    if (!customKey) {
      return res.status(400).json({ success: false, isBrokenKey: true, error: 'کلید API وارد نشده است.' });
    }

    const result = await testSingleGeminiKey(customKey);
    if (result.success) {
      return res.json({
        success: true,
        statusCategory: result.statusCategory,
        message: 'ارتباط برقرار شد و کلید API معتبر است.',
      });
    } else {
      return res.status(400).json({
        success: false,
        isBrokenKey: Boolean(result.isBrokenKey),
        statusCategory: result.statusCategory,
        error: result.error,
      });
    }
  } catch (err: unknown) {
    const errorMsg = parseGeminiDiagnosticError(err);
    console.error('API key test error:', err);
    return res.status(400).json({ success: false, isBrokenKey: false, error: errorMsg });
  }
});

// API Endpoint: Test Custom Provider (BYOK) Connection
app.post('/api/custom-provider/test', async (req, res) => {
  try {
    const { baseUrl, apiKey, model } = req.body || {};
    const result = await testCustomProviderConnection({ baseUrl, apiKey, model });
    if (result.success) {
      return res.json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (err: any) {
    const safeError = sanitizeErrorMessage(err?.message || 'Server error during connection test.');
    return res.status(500).json({
      success: false,
      errorType: 'provider_error',
      error: safeError,
    });
  }
});


// Health check route
app.get('/api/health', (req, res) => {
  const hasServerKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  res.json({
    status: 'ok',
    hasServerKey,
    static: PROD_STATIC_STATE, // 'build' = serving dist/, 'missing' = build output absent, 'dev' = vite middleware
    time: new Date().toISOString()
  });
});

// Helper to reliably locate the BUILT frontend: a dist directory whose index.html is a
// production build (loads hashed bundles from /assets/), not the dev source index.html.
// FIX (WHITE-SCREEN + SOURCE LEAK):
//  - The repo root (process.cwd()) is NO LONGER an acceptable candidate. Serving it
//    statically leaks server.ts / package-lock.json / deploy configs and yields a blank
//    page, because /src/main.tsx is only executable under the Vite dev server.
//  - A candidate's index.html must reference /assets/ (vite build output marker); if none
//    qualifies we return null and startServer() serves a self-explanatory 503 guide page
//    instead of pretending everything is fine.
function locateDistDirectory(): string | null {
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const candidates = [
    currentDir, // canonical layout: dist/server.cjs + dist/index.html + dist/assets/
    path.join(process.cwd(), 'dist'),
    path.join(currentDir, 'dist'),
    path.join(currentDir, '..', 'dist'),
    // SECURITY: process.cwd() (repo root) deliberately removed as a candidate.
  ];

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, 'index.html');
    if (!fs.existsSync(indexPath)) continue;
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      // Built index.html -> <script src="/assets/index-XXXX.js">; dev source -> /src/main.tsx
      if (html.includes('/assets/') && !html.includes('/src/main.tsx')) {
        return candidate;
      }
    } catch {
      /* unreadable index.html — keep searching */
    }
  }

  return null;
}

// Bilingual (fa/en) diagnostic page returned instead of a blank screen / leaked sources
// when the production build output (dist/index.html) is missing on the host.
function buildMissingPage(distHint: string): string {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SubGame Lab — Build missing / بیلد یافت نشد</title>
<style>
  body{font-family:system-ui,Vazirmatn,Tahoma,sans-serif;background:#020617;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:760px;background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:32px;line-height:1.9}
  h1{font-size:20px;margin:0 0 12px;color:#f87171}
  code{background:#1e293b;border-radius:6px;padding:2px 8px;font-size:13px;color:#a5b4fc;direction:ltr;display:inline-block}
  pre{background:#1e293b;border-radius:8px;padding:12px 16px;direction:ltr;text-align:left;overflow-x:auto;color:#a5b4fc;font-size:13px;margin:8px 0}
  .en{direction:ltr;text-align:left;border-top:1px solid #1e293b;margin-top:20px;padding-top:16px;color:#94a3b8;font-size:14px}
</style>
</head>
<body>
<div class="card">
  <h1>خروجی بیلد فرانت‌اند پیدا نشد</h1>
  <p>سرور اجرا است اما پوشه‌ی <code>dist</code> (نتیجه‌ی <code>npm run build</code>) روی سرور موجود نیست (${distHint}). در پنل پلتفرم استقرار این مقادیر را تنظیم و دوباره Deploy کنید:</p>
  <pre>Build Command:  npm ci &amp;&amp; npm run build
Start Command:  node dist/server.cjs
Health Check:   /api/health</pre>
  <p>اگر از Blueprint استفاده می‌کنید، فایل <code>render.yaml</code> همین تنظیمات را به‌صورت آماده دارد.</p>
  <div class="en"><strong>Frontend build not found.</strong> The API (<code>/api/*</code>) is healthy, but the built frontend (<code>dist/index.html</code>, produced by <code>npm run build</code>) is missing on the server (${distHint}). Set the platform <em>Build Command</em> to <code>npm ci &amp;&amp; npm run build</code> and the <em>Start Command</em> to <code>node dist/server.cjs</code>, then redeploy. For source safety the server no longer serves the repository root.</div>
</div>
</body>
</html>`;
}

// Setup Vite development server or serve static assets in production
async function startServer() {
  const isCjsBundle = typeof __filename !== 'undefined' && typeof __filename === 'string' && __filename.endsWith('.cjs');
  const isProduction = process.env.NODE_ENV === 'production' || isCjsBundle;
  const server = http.createServer(app);
  // Generous socket/request timeouts for slow custom proxy ("واسط") providers
  server.requestTimeout = 300_000;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (!isProduction) {
    console.log('[Server] Starting in DEVELOPMENT mode with Vite middleware...');
    viteServer = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server },
      },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  } else {
    const distDir = locateDistDirectory();

    if (distDir) {
      PROD_STATIC_STATE = 'build';
      console.log(`[Server] Starting in PRODUCTION mode. Serving assets from: ${distDir}`);

      // Defense-in-depth: never publish the server bundle or sourcemaps from dist/
      // (they reveal server internals; the browser never needs them at runtime).
      app.use((req, res, next) => {
        if (req.path.endsWith('.map') || req.path.includes('server.cjs')) {
          return res.status(404).json({ error: 'Not found' });
        }
        next();
      });

      app.use(express.static(distDir));
    } else {
      PROD_STATIC_STATE = 'missing';
      // BUILD MISSING (the actual root cause of the Render white-screen incident):
      // never fall back to serving the repo root — that leaked the whole source tree
      // and produced a blank page. Serve an actionable bilingual guide page instead,
      // while keeping /api/* fully functional so platform healthchecks still pass.
      console.error(
        '\n[Server] ==========================================================\n' +
        '[Server]  ⚠️  Frontend build NOT found (dist/index.html).\n' +
        '[Server]  Platform Build Command must be: npm ci && npm run build\n' +
        '[Server]  Platform Start Command must be: node dist/server.cjs\n' +
        '[Server]  Non-API routes will return a 503 guide page until then.\n' +
        '[Server] ==========================================================\n'
      );
      app.use((req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.status(503).type('html').send(buildMissingPage('hint: run "npm run build" first'));
      });
    }

    // SPA fallback: Return index.html for non-API routes
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint not found' });
      }

      if (!distDir) {
        return res.status(503).type('html').send(buildMissingPage('hint: run "npm run build" first'));
      }

      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(503).type('html').send(buildMissingPage(`expected at: ${indexPath}`));
      }
    });
  }

  // FIX (DEPLOY): keep a reference to the raw http.Server so platform lifecycle signals
  // (SIGTERM on Railway redeploys / teardown, SIGINT locally) shut the app down cleanly
  // instead of a forced kill that shows up as a "Crashed" deployment.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on http://0.0.0.0:${PORT} (PID: ${process.pid}, mode: ${isProduction ? 'production' : 'development'})`);
  });

  // FIX (DEPLOY): graceful shutdown for Railway-style lifecycle management.
  // Railway sends SIGTERM when a deployment is superseded or torn down; per the
  // official "NodeJS SIGTERM handling" guidance the process must catch it, stop
  // accepting new connections, close idle keep-alive sockets, and exit on its own.
  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} received — starting graceful shutdown...`);

    // Safety net: if something still keeps the process alive, force the exit so the
    // platform is never left hanging.
    const forceExitTimer = setTimeout(() => {
      console.error('[Server] Graceful shutdown timed out — forcing exit now.');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    // Stop accepting new connections; drop idle keep-alive sockets immediately.
    server.close(() => {
      clearTimeout(forceExitTimer);
      console.log('[Server] Server closed gracefully. Bye 👋');
      process.exit(0);
    });
    // Node >= 18.2: closes idle keep-alive connections so close() completes fast.
    (server as any).closeIdleConnections?.();

    // In dev mode the Vite middleware (HMR websocket + file watchers) keeps the event
    // loop alive — close it too so the process can actually terminate.
    if (viteServer) {
      void viteServer.close().catch(() => {});
    }

    // Drain grace: after 3s destroy ANY remaining connection (e.g. long translation
    // streams or a half-open socket) so shutdown stays deterministic; the 10s timer
    // above remains the absolute backstop.
    const destroyTimer = setTimeout(() => {
      console.log('[Server] Destroying remaining connections to finish shutdown.');
      (server as any).closeAllConnections?.();
    }, 3_000);
    destroyTimer.unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer();
