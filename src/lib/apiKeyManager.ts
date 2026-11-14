import { AIProvider, CustomProviderConfig } from '../types';

export interface StoredApiKey {
  id: string;
  label: string;
  key: string;
  status: 'valid' | 'invalid' | 'untested';
  lastError?: string;
  isPrimary?: boolean;
  rpmLimit?: number;
  quotaStatus?: 'healthy' | 'daily_exhausted';
  quotaExhaustedUntil?: number;
}

export interface RemovedKeyReportItem {
  id: string;
  label: string;
  maskedKey: string;
  reason: string;
  removedAt: number;
}

export const DEFAULT_KEY_RPM_LIMIT = 12;

const LOCAL_STORAGE_KEYS_LIST = 'gemini_api_keys_v2';
const LOCAL_STORAGE_SINGLE_KEY = 'gemini_api_key';
const LOCAL_STORAGE_AI_PROVIDER = 'subgame_ai_provider';
const LOCAL_STORAGE_CUSTOM_PROVIDER = 'subgame_custom_provider_config';
const LOCAL_STORAGE_DEFAULT_RPM = 'subgame_default_key_rpm';

export function getDefaultKeyRpm(): number {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_DEFAULT_RPM);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 120) return parsed;
    }
  } catch {}
  return DEFAULT_KEY_RPM_LIMIT;
}

export function saveDefaultKeyRpm(rpm: number): void {
  const safeRpm = Math.max(1, Math.min(120, Math.round(rpm) || DEFAULT_KEY_RPM_LIMIT));
  try {
    localStorage.setItem(LOCAL_STORAGE_DEFAULT_RPM, String(safeRpm));
  } catch {}
}

export function maskApiKey(key: string): string {
  const clean = String(key || '').trim();
  if (clean.length <= 10) return '••••••••••••';
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

/**
 * Parses bulk key text separated by newlines, commas, semicolons, or whitespace.
 * Preserves input order and removes duplicates.
 */
export function parseBatchApiKeysInput(rawText: string): string[] {
  const tokens = String(rawText || '')
    .split(/[\r\n,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tok of tokens) {
    if (!seen.has(tok)) {
      seen.add(tok);
      unique.push(tok);
    }
  }
  return unique;
}

/**
 * Next UTC midnight (+5 min buffer) when Gemini free/tier RPD quotas normally reset.
 */
export function getNextUtcMidnightMs(fromMs = Date.now()): number {
  const d = new Date(fromMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5, 0, 0);
}

export function isKeyQuotaExhausted(k: StoredApiKey, now = Date.now()): boolean {
  if (k.quotaStatus !== 'daily_exhausted') return false;
  if (typeof k.quotaExhaustedUntil === 'number' && k.quotaExhaustedUntil <= now) {
    return false;
  }
  return true;
}

export function getActiveAiProvider(): AIProvider {
  try {
    const val = localStorage.getItem(LOCAL_STORAGE_AI_PROVIDER);
    if (val === 'custom') return 'custom';
  } catch (err) {
    console.error('Failed to parse AI provider from localStorage:', err);
  }
  return 'gemini';
}

export function setActiveAiProvider(provider: AIProvider): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_AI_PROVIDER, provider);
  } catch (err) {
    console.error('Failed to save AI provider to localStorage:', err);
  }
}

export function getStoredCustomProvider(): CustomProviderConfig {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_CUSTOM_PROVIDER);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          name: typeof parsed.name === 'string' ? parsed.name : '',
          baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
          model: typeof parsed.model === 'string' ? parsed.model : '',
        };
      }
    }
  } catch (err) {
    console.error('Failed to parse custom provider config from localStorage:', err);
  }
  return {
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
  };
}

export function saveStoredCustomProvider(config: CustomProviderConfig): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_CUSTOM_PROVIDER, JSON.stringify(config));
  } catch (err) {
    console.error('Failed to save custom provider config to localStorage:', err);
  }
}

export function getStoredApiKeys(): StoredApiKey[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEYS_LIST);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const now = Date.now();
        let mutated = false;
        const normalized = parsed.map((k: StoredApiKey) => {
          if (k.quotaStatus === 'daily_exhausted' && typeof k.quotaExhaustedUntil === 'number' && k.quotaExhaustedUntil <= now) {
            mutated = true;
            return { ...k, quotaStatus: 'healthy' as const, quotaExhaustedUntil: undefined };
          }
          return k;
        });
        if (mutated) {
          saveStoredApiKeys(normalized);
        }
        return normalized;
      }
    }
  } catch (err) {
    console.error('Failed to parse stored API keys:', err);
  }

  // Fallback to legacy single key if present
  const singleKey = localStorage.getItem(LOCAL_STORAGE_SINGLE_KEY);
  if (singleKey && singleKey.trim()) {
    const defaultList: StoredApiKey[] = [
      {
        id: 'default_key_1',
        label: 'Primary Key',
        key: singleKey.trim(),
        status: 'untested',
        isPrimary: true,
        rpmLimit: getDefaultKeyRpm(),
        quotaStatus: 'healthy',
      },
    ];
    saveStoredApiKeys(defaultList);
    return defaultList;
  }

  return [];
}

export function saveStoredApiKeys(keys: StoredApiKey[]): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEYS_LIST, JSON.stringify(keys));
    // Keep legacy key in sync with primary healthy key for backwards compatibility
    const healthyKeys = keys.filter((k) => !isKeyQuotaExhausted(k));
    const primary =
      healthyKeys.find((k) => k.isPrimary) ||
      healthyKeys[0] ||
      keys.find((k) => k.isPrimary) ||
      keys[0];
    if (primary && primary.key) {
      localStorage.setItem(LOCAL_STORAGE_SINGLE_KEY, primary.key);
    } else {
      localStorage.removeItem(LOCAL_STORAGE_SINGLE_KEY);
    }
  } catch (err) {
    console.error('Failed to save API keys to localStorage:', err);
  }
}

export function markApiKeyExhausted(keyString: string, untilMs = getNextUtcMidnightMs()): StoredApiKey | null {
  const clean = String(keyString || '').trim();
  if (!clean) return null;
  const keys = getStoredApiKeys();
  let matched: StoredApiKey | null = null;
  const updated = keys.map((k) => {
    if (k.key.trim() === clean) {
      matched = {
        ...k,
        quotaStatus: 'daily_exhausted',
        quotaExhaustedUntil: untilMs,
      };
      return matched;
    }
    return k;
  });
  if (matched) {
    saveStoredApiKeys(updated);
  }
  return matched;
}

export function resetAllApiKeysQuotaStatus(): StoredApiKey[] {
  const keys = getStoredApiKeys();
  const updated = keys.map((k) => ({
    ...k,
    quotaStatus: 'healthy' as const,
    quotaExhaustedUntil: undefined,
  }));
  saveStoredApiKeys(updated);
  return updated;
}

export function removeInvalidApiKeys(
  invalidKeyStrings: string[],
  reasonsByKey: Record<string, string> = {}
): { remaining: StoredApiKey[]; removed: RemovedKeyReportItem[] } {
  const invalidSet = new Set(invalidKeyStrings.map((k) => String(k || '').trim()).filter(Boolean));
  const keys = getStoredApiKeys();
  const removed: RemovedKeyReportItem[] = [];
  const remaining: StoredApiKey[] = [];

  for (const k of keys) {
    if (invalidSet.has(k.key.trim())) {
      removed.push({
        id: k.id,
        label: k.label,
        maskedKey: maskApiKey(k.key),
        reason: reasonsByKey[k.key.trim()] || k.lastError || 'کلید نامعتبر یا مسدود شده است',
        removedAt: Date.now(),
      });
    } else {
      remaining.push(k);
    }
  }

  if (remaining.length > 0 && !remaining.some((k) => k.isPrimary)) {
    remaining[0] = { ...remaining[0], isPrimary: true };
  }

  if (removed.length > 0) {
    saveStoredApiKeys(remaining);
  }

  return { remaining, removed };
}

/**
 * Orders keys for a job:
 * 1. If preferredKeyId is supplied and valid, places it FIRST (even if user specifically picked it),
 *    then all other healthy (non-exhausted) keys rotated by offsetIndex, then exhausted keys as last resort.
 * 2. Otherwise puts healthy keys first (starting with primary rotated by offsetIndex so concurrent
 *    workers naturally spread across different keys), followed by exhausted keys as fallback.
 */
export function getOrderedHealthyKeys(preferredKeyId?: string, offsetIndex = 0): StoredApiKey[] {
  const keys = getStoredApiKeys().filter((k) => k.key && k.key.trim().length > 0);
  if (keys.length === 0) return [];

  const now = Date.now();
  const healthy = keys.filter((k) => !isKeyQuotaExhausted(k, now));
  const exhausted = keys.filter((k) => isKeyQuotaExhausted(k, now));

  const preferred = preferredKeyId ? keys.find((k) => k.id === preferredKeyId) : undefined;
  if (preferred) {
    const otherHealthy = healthy.filter((k) => k.id !== preferred.id);
    const otherExhausted = exhausted.filter((k) => k.id !== preferred.id);
    return [preferred, ...otherHealthy, ...otherExhausted];
  }

  if (healthy.length > 1 && offsetIndex > 0) {
    const startIdx = offsetIndex % healthy.length;
    const rotatedHealthy = [...healthy.slice(startIdx), ...healthy.slice(0, startIdx)];
    return [...rotatedHealthy, ...exhausted];
  }

  // Primary first among healthy keys
  const primaryHealthy = healthy.filter((k) => k.isPrimary);
  const otherHealthy = healthy.filter((k) => !k.isPrimary);
  return [...primaryHealthy, ...otherHealthy, ...exhausted];
}

export function getActiveApiKeysArray(preferredKeyId?: string, offsetIndex = 0): string[] {
  const ordered = getOrderedHealthyKeys(preferredKeyId, offsetIndex);
  return ordered.map((k) => k.key.trim()).filter(Boolean);
}

export function getApiKeyArrayForHeader(preferredKeyId?: string, offsetIndex = 0): string[] {
  return getActiveApiKeysArray(preferredKeyId, offsetIndex);
}
