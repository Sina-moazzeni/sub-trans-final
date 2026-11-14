import React, { useState, useEffect, useRef } from 'react';
import { UILanguage, TRANSLATIONS } from '../lib/i18n';
import { 
  StoredApiKey, 
  RemovedKeyReportItem,
  getStoredApiKeys, 
  saveStoredApiKeys,
  getActiveAiProvider,
  setActiveAiProvider,
  getStoredCustomProvider,
  saveStoredCustomProvider,
  getDefaultKeyRpm,
  saveDefaultKeyRpm,
  parseBatchApiKeysInput,
  maskApiKey,
  isKeyQuotaExhausted,
  resetAllApiKeysQuotaStatus
} from '../lib/apiKeyManager';
import { AIProvider, CustomProviderConfig } from '../types';
import { validateCustomProviderConfig } from '../lib/customProviderService';
import { 
  Key, 
  X, 
  Check, 
  Trash2, 
  Eye, 
  EyeOff, 
  ShieldCheck, 
  ExternalLink, 
  Activity, 
  CheckCircle2, 
  AlertCircle, 
  Loader2,
  Plus,
  Layers,
  Star,
  RefreshCw,
  Server,
  Sparkles,
  CheckCircle,
  ListPlus,
  Gauge,
  RotateCcw,
  Clock
} from 'lucide-react';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  uiLang: UILanguage;
  userApiKey?: string;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  activeProvider?: AIProvider;
  onProviderChange?: (provider: AIProvider) => void;
  customConfig?: CustomProviderConfig;
  onSaveCustomConfig?: (config: CustomProviderConfig) => void;
  onKeysUpdated?: () => void;
  onRemovedBrokenKeys?: (removed: RemovedKeyReportItem[]) => void;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onClose,
  uiLang,
  userApiKey = '',
  onSaveKey,
  onClearKey,
  activeProvider: externalProvider,
  onProviderChange,
  customConfig: externalCustomConfig,
  onSaveCustomConfig,
  onKeysUpdated,
  onRemovedBrokenKeys,
}) => {
  // Provider Selection: Gemini vs Custom Provider
  const [selectedProvider, setSelectedProvider] = useState<AIProvider>('gemini');

  // Gemini Multi-Key state
  const [keysList, setKeysList] = useState<StoredApiKey[]>([]);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [isTestingAll, setIsTestingAll] = useState(false);

  // Batch Import & RPM / Auto-Cleanup State
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchKeysInput, setBatchKeysInput] = useState('');
  const [batchNamePrefix, setBatchNamePrefix] = useState('');
  const [defaultRpm, setDefaultRpm] = useState<number>(() => getDefaultKeyRpm());
  const [isImportingBatch, setIsImportingBatch] = useState(false);
  const [removedKeysReport, setRemovedKeysReport] = useState<RemovedKeyReportItem[]>([]);

  // Custom Provider state
  const [customName, setCustomName] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [showCustomApiKey, setShowCustomApiKey] = useState(false);

  // Custom Provider Test state
  const [isTestingCustom, setIsTestingCustom] = useState(false);
  const [customTestStatus, setCustomTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  const [customTestMessage, setCustomTestMessage] = useState<string>('');
  const [customTestLatency, setCustomTestLatency] = useState<number | null>(null);

  const testAbortControllerRef = useRef<AbortController | null>(null);
  const t = TRANSLATIONS[uiLang];

  useEffect(() => {
    if (isOpen) {
      // 1. Provider
      const currentProvider = externalProvider || getActiveAiProvider();
      setSelectedProvider(currentProvider);

      // 2. Gemini Keys
      const stored = getStoredApiKeys();
      if (stored.length === 0 && userApiKey) {
        const initial: StoredApiKey = {
          id: `key_${Date.now()}`,
          label: 'Primary Key',
          key: userApiKey,
          status: 'untested',
          isPrimary: true,
          rpmLimit: getDefaultKeyRpm(),
          quotaStatus: 'healthy',
        };
        setKeysList([initial]);
        saveStoredApiKeys([initial]);
      } else {
        setKeysList(stored);
      }
      setNewKeyInput('');
      setNewKeyLabel('');
      setDefaultRpm(getDefaultKeyRpm());

      // 3. Custom Provider
      const savedCustom = externalCustomConfig || getStoredCustomProvider();
      setCustomName(savedCustom.name || '');
      setCustomBaseUrl(savedCustom.baseUrl || '');
      setCustomApiKey(savedCustom.apiKey || '');
      setCustomModel(savedCustom.model || '');
      setCustomTestStatus('idle');
      setCustomTestMessage('');
      setCustomTestLatency(null);
    } else {
      if (testAbortControllerRef.current) {
        testAbortControllerRef.current.abort();
        testAbortControllerRef.current = null;
      }
    }
  }, [isOpen, userApiKey, externalProvider, externalCustomConfig]);

  if (!isOpen) return null;

  // Handle Provider Switch
  const handleSwitchProvider = (provider: AIProvider) => {
    setSelectedProvider(provider);
    setActiveAiProvider(provider);
    if (onProviderChange) {
      onProviderChange(provider);
    }
  };

  // Custom Provider: Save configuration
  const persistCustomProviderConfig = (updates?: Partial<CustomProviderConfig>) => {
    const updated: CustomProviderConfig = {
      name: updates?.name !== undefined ? updates.name : customName,
      baseUrl: updates?.baseUrl !== undefined ? updates.baseUrl : customBaseUrl,
      apiKey: updates?.apiKey !== undefined ? updates.apiKey : customApiKey,
      model: updates?.model !== undefined ? updates.model : customModel,
    };
    saveStoredCustomProvider(updated);
    if (onSaveCustomConfig) {
      onSaveCustomConfig(updated);
    }
    return updated;
  };

  // Custom Provider: Real minimal Test Connection
  const handleTestCustomConnection = async () => {
    if (isTestingCustom) return;

    const validation = validateCustomProviderConfig({
      baseUrl: customBaseUrl,
      apiKey: customApiKey,
      model: customModel,
    });

    if (!validation.valid) {
      setCustomTestStatus('failed');
      setCustomTestMessage(validation.error || 'Please fill in all required fields.');
      return;
    }

    if (testAbortControllerRef.current) {
      testAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    testAbortControllerRef.current = controller;

    setIsTestingCustom(true);
    setCustomTestStatus('testing');
    setCustomTestMessage('');
    setCustomTestLatency(null);

    persistCustomProviderConfig();

    try {
      const response = await fetch('/api/custom-provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: customBaseUrl.trim(),
          apiKey: customApiKey.trim(),
          model: customModel.trim(),
        }),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      if (response.ok && data?.success) {
        setCustomTestStatus('success');
        setCustomTestLatency(data.latencyMs || null);
        setCustomTestMessage(
          uiLang === 'en'
            ? `Connection successful! Responded model: ${data.modelResponded || customModel.trim()}`
            : `ارتباط با موفقیت برقرار شد! مدل پاسخ‌دهنده: ${data.modelResponded || customModel.trim()}`
        );
      } else {
        setCustomTestStatus('failed');
        const errType = data?.errorType;
        let displayError = data?.error || (uiLang === 'en' ? 'Connection test failed.' : 'تست اتصال با خطا مواجه شد.');
        
        if (errType === 'invalid_key') {
          displayError = uiLang === 'en' ? 'Invalid API key / Authentication failed.' : 'کلید API نامعتبر است یا احراز هویت با خطا مواجه شد.';
        } else if (errType === 'model_not_found') {
          displayError = uiLang === 'en' ? `Model "${customModel.trim()}" not found.` : `مدل "${customModel.trim()}" در این سرویس‌دهنده یافت نشد.`;
        } else if (errType === 'endpoint_not_found') {
          displayError = uiLang === 'en' ? 'Endpoint not found (404). Check Base API URL.' : 'آدرس اندپوینت یافت نشد (404). Base API URL را بررسی کنید.';
        } else if (errType === 'network_error') {
          displayError = uiLang === 'en' ? 'Network error: Host unreachable or connection refused.' : 'خطای شبکه: هاست در دسترس نیست یا اتصال قطع شد.';
        } else if (errType === 'timeout') {
          displayError = uiLang === 'en' ? 'Connection timed out (45s).' : 'مهلت زمانی ارتباط (۴۵ ثانیه) به پایان رسید.';
        }

        setCustomTestMessage(displayError);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setCustomTestStatus('failed');
      setCustomTestMessage(err?.message || (uiLang === 'en' ? 'Network request failed.' : 'درخواست شبکه با خطا مواجه شد.'));
    } finally {
      setIsTestingCustom(false);
      testAbortControllerRef.current = null;
    }
  };

  const handleToggleShow = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const syncSavedKeysToParent = (nextKeys: StoredApiKey[]) => {
    if (nextKeys.length > 0) {
      const primary = nextKeys.find((k) => k.isPrimary) || nextKeys[0];
      onSaveKey(primary.key);
    } else {
      onClearKey();
    }
    onKeysUpdated?.();
  };

  const handleDefaultRpmChange = (rpm: number) => {
    const safeRpm = Math.max(1, Math.min(120, Math.round(rpm) || 12));
    setDefaultRpm(safeRpm);
    saveDefaultKeyRpm(safeRpm);
  };

  const handleKeyRpmChange = (id: string, rpm: number) => {
    const safeRpm = Math.max(1, Math.min(120, Math.round(rpm) || defaultRpm));
    const updated = keysList.map((k) => (k.id === id ? { ...k, rpmLimit: safeRpm } : k));
    setKeysList(updated);
    saveStoredApiKeys(updated);
    onKeysUpdated?.();
  };

  const handleResetAllQuotas = () => {
    const updated = resetAllApiKeysQuotaStatus();
    setKeysList(updated);
    syncSavedKeysToParent(updated);
  };

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = newKeyInput.trim();
    if (!cleanKey) return;

    const newId = `key_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const labelToSet = newKeyLabel.trim() || `Key #${keysList.length + 1}`;
    const isFirst = keysList.length === 0;

    const newEntry: StoredApiKey = {
      id: newId,
      label: labelToSet,
      key: cleanKey,
      status: 'untested',
      isPrimary: isFirst,
      rpmLimit: defaultRpm,
      quotaStatus: 'healthy',
    };

    const updated = [...keysList, newEntry];
    setKeysList(updated);
    saveStoredApiKeys(updated);
    syncSavedKeysToParent(updated);

    setNewKeyInput('');
    setNewKeyLabel('');

    // Immediately test newly added key (and auto-remove if broken)
    await handleTestSingleKey(newId, cleanKey);
  };

  const handleBatchImportKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isImportingBatch) return;

    const parsedKeys = parseBatchApiKeysInput(batchKeysInput);
    if (parsedKeys.length === 0) return;

    const existingSet = new Set(keysList.map((k) => k.key.trim()));
    const freshKeys = parsedKeys.filter((k) => !existingSet.has(k));
    if (freshKeys.length === 0) {
      setBatchKeysInput('');
      return;
    }

    setIsImportingBatch(true);
    const prefix = batchNamePrefix.trim() || (uiLang === 'en' ? 'Key' : 'کلید');
    let nextNum = keysList.length + 1;

    const newEntries: StoredApiKey[] = freshKeys.map((rawKey, idx) => ({
      id: `key_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      label: `${prefix} #${nextNum++}`,
      key: rawKey,
      status: 'untested',
      isPrimary: keysList.length === 0 && idx === 0,
      rpmLimit: defaultRpm,
      quotaStatus: 'healthy',
    }));

    const combined = [...keysList, ...newEntries];
    setKeysList(combined);
    saveStoredApiKeys(combined);
    syncSavedKeysToParent(combined);
    setBatchKeysInput('');

    // Auto-test all newly imported keys and automatically remove any broken keys
    try {
      const res = await fetch('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: newEntries.map((k) => k.key) }),
      });

      const data = await res.json().catch(() => null);
      if (res.ok && data?.results && Array.isArray(data.results)) {
        const resultMap = new Map<string, { success: boolean; error?: string; isBrokenKey?: boolean }>();
        data.results.forEach((r: any) => resultMap.set(r.key, r));

        const newlyRemoved: RemovedKeyReportItem[] = [];
        setKeysList((prevKeys) => {
          const nextRemaining: StoredApiKey[] = [];
          for (const k of prevKeys) {
            const resObj = resultMap.get(k.key);
            if (!resObj) {
              nextRemaining.push(k);
              continue;
            }
            if (resObj.success) {
              nextRemaining.push({ ...k, status: 'valid', lastError: undefined });
            } else if (resObj.isBrokenKey) {
              newlyRemoved.push({
                id: k.id,
                label: k.label,
                maskedKey: maskApiKey(k.key),
                reason: resObj.error || (uiLang === 'en' ? 'Invalid or broken API key' : 'کلید API نامعتبر یا خراب است'),
                removedAt: Date.now(),
              });
            } else {
              nextRemaining.push({
                ...k,
                status: 'invalid',
                lastError: resObj.error || (uiLang === 'en' ? 'Connection error' : 'خطا در بررسی کلید'),
              });
            }
          }

          if (nextRemaining.length > 0 && !nextRemaining.some((k) => k.isPrimary)) {
            nextRemaining[0] = { ...nextRemaining[0], isPrimary: true };
          }
          saveStoredApiKeys(nextRemaining);
          syncSavedKeysToParent(nextRemaining);
          return nextRemaining;
        });

        if (newlyRemoved.length > 0) {
          setRemovedKeysReport((prev) => [...newlyRemoved, ...prev]);
          onRemovedBrokenKeys?.(newlyRemoved);
        }
      }
    } catch (err) {
      console.error('Batch key import test error:', err);
    } finally {
      setIsImportingBatch(false);
    }
  };

  const handleDeleteKey = (id: string) => {
    const updated = keysList.filter((k) => k.id !== id);
    if (updated.length > 0 && !updated.some((k) => k.isPrimary)) {
      updated[0].isPrimary = true;
    }
    setKeysList(updated);
    saveStoredApiKeys(updated);
    syncSavedKeysToParent(updated);
  };

  const handleSetPrimary = (id: string) => {
    const updated = keysList.map((k) => ({
      ...k,
      isPrimary: k.id === id,
    }));
    setKeysList(updated);
    saveStoredApiKeys(updated);
    syncSavedKeysToParent(updated);
  };

  const handleTestSingleKey = async (id: string, keyStr: string) => {
    setTestingKeyId(id);
    try {
      const res = await fetch('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: keyStr }),
      });
      const data = await res.json().catch(() => ({}));
      const isValid = res.ok && data.success;
      const isBrokenKey = Boolean(!isValid && data.isBrokenKey);

      const newlyRemoved: RemovedKeyReportItem[] = [];
      setKeysList((prevKeys) => {
        if (isBrokenKey) {
          const target = prevKeys.find((k) => k.id === id);
          if (target) {
            newlyRemoved.push({
              id: target.id,
              label: target.label,
              maskedKey: maskApiKey(target.key),
              reason: data.error || (uiLang === 'en' ? 'Invalid or broken API key' : 'کلید API نامعتبر یا خراب است'),
              removedAt: Date.now(),
            });
          }
          const remaining = prevKeys.filter((k) => k.id !== id);
          if (remaining.length > 0 && !remaining.some((k) => k.isPrimary)) {
            remaining[0] = { ...remaining[0], isPrimary: true };
          }
          saveStoredApiKeys(remaining);
          syncSavedKeysToParent(remaining);
          return remaining;
        }

        const updated = prevKeys.map((k) =>
          k.id === id
            ? {
                ...k,
                status: (isValid ? 'valid' : 'invalid') as 'valid' | 'invalid',
                lastError: isValid ? undefined : data.error || (uiLang === 'en' ? 'Connection or Key Error' : 'ارتباط برقرار نشد یا کلید خراب است'),
              }
            : k
        );
        saveStoredApiKeys(updated);
        onKeysUpdated?.();
        return updated;
      });

      if (newlyRemoved.length > 0) {
        setRemovedKeysReport((prev) => [...newlyRemoved, ...prev]);
        onRemovedBrokenKeys?.(newlyRemoved);
      }
    } catch (err: any) {
      const errorMsg = uiLang === 'en' 
        ? `Connection failed: ${err?.message || 'Network error'}`
        : `ارتباط برقرار نشد: ${err?.message || 'خطای شبکه'}`;
      setKeysList((prevKeys) => {
        const updated = prevKeys.map((k) =>
          k.id === id
            ? { ...k, status: 'invalid' as const, lastError: errorMsg }
            : k
        );
        saveStoredApiKeys(updated);
        return updated;
      });
    } finally {
      setTestingKeyId(null);
    }
  };

  const handleTestAllKeys = async () => {
    if (keysList.length === 0) return;
    setIsTestingAll(true);

    try {
      const rawKeys = keysList.map((k) => k.key);
      const res = await fetch('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: rawKeys }),
      });

      const data = await res.json();
      if (res.ok && data.results && Array.isArray(data.results)) {
        const resultMap = new Map<string, { success: boolean; error?: string; isBrokenKey?: boolean }>();
        data.results.forEach((r: any) => resultMap.set(r.key, r));

        const newlyRemoved: RemovedKeyReportItem[] = [];
        setKeysList((prevKeys) => {
          const remaining: StoredApiKey[] = [];
          for (const k of prevKeys) {
            const resObj = resultMap.get(k.key);
            if (!resObj) {
              remaining.push(k);
              continue;
            }
            if (resObj.success) {
              remaining.push({ ...k, status: 'valid', lastError: undefined });
            } else if (resObj.isBrokenKey) {
              newlyRemoved.push({
                id: k.id,
                label: k.label,
                maskedKey: maskApiKey(k.key),
                reason: resObj.error || (uiLang === 'en' ? 'Invalid or broken API key' : 'کلید API نامعتبر یا خراب است'),
                removedAt: Date.now(),
              });
            } else {
              remaining.push({
                ...k,
                status: 'invalid',
                lastError: resObj.error || (uiLang === 'en' ? 'Connection or Key Error' : 'ارتباط برقرار نشد'),
              });
            }
          }

          if (remaining.length > 0 && !remaining.some((k) => k.isPrimary)) {
            remaining[0] = { ...remaining[0], isPrimary: true };
          }
          saveStoredApiKeys(remaining);
          syncSavedKeysToParent(remaining);
          return remaining;
        });

        if (newlyRemoved.length > 0) {
          setRemovedKeysReport((prev) => [...newlyRemoved, ...prev]);
          onRemovedBrokenKeys?.(newlyRemoved);
        }
      }
    } catch (err: any) {
      console.error('Batch testing error:', err);
    } finally {
      setIsTestingAll(false);
    }
  };

  const getKeyLinkText = () => {
    if (uiLang === 'en') return 'Get Free Gemini Keys';
    if (uiLang === 'ar') return 'احصل على مفاتيح Gemini مجانیة';
    return 'دریافت کلیدهای رایگان Gemini';
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl relative flex flex-col gap-5 transition-colors max-h-[90vh] overflow-y-auto">
        
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/20 text-indigo-600 dark:text-indigo-400">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span>{uiLang === 'en' ? 'AI Provider & Key Settings' : uiLang === 'ar' ? 'إعدادات مزود الذكاء الاصطناعي والمفاتيح' : 'تنظیمات سرویس‌دهنده هوش مصنوعی و کلیدها'}</span>
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                {uiLang === 'en' 
                  ? 'Choose between Google Gemini or configure your own Custom Provider (BYOK).'
                  : uiLang === 'ar'
                  ? 'اختر بين Google Gemini أو قم بتهيئة مزودك المخصص (BYOK).'
                  : 'بین گوگل جمینای یا سرویس‌دهنده سفارشی خودتان (BYOK) انتخاب کنید.'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-lg bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Provider Selector: Gemini (Default) vs Custom Provider */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              {uiLang === 'en' ? 'AI Provider' : 'سرویس‌دهنده هوش مصنوعی'}
            </label>
            <span className="text-[11px] text-slate-500">
              {selectedProvider === 'gemini' 
                ? (uiLang === 'en' ? 'Active: Google Gemini' : 'فعال: گوگل جمینای') 
                : (uiLang === 'en' ? 'Active: Custom Provider' : 'فعال: سرویس‌دهنده سفارشی')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 p-1.5 bg-slate-100 dark:bg-slate-950/80 rounded-xl border border-slate-200 dark:border-slate-800">
            {/* Gemini Tab / Radio */}
            <button
              type="button"
              onClick={() => handleSwitchProvider('gemini')}
              className={`flex items-center justify-center gap-2.5 py-2.5 px-3 rounded-lg text-xs font-bold transition-all ${
                selectedProvider === 'gemini'
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-slate-200/80 dark:border-slate-700'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <span className={`w-2 h-2 rounded-full transition-colors ${selectedProvider === 'gemini' ? 'bg-indigo-500 ring-4 ring-indigo-500/20' : 'bg-slate-300 dark:bg-slate-700'}`} />
              <Sparkles className="w-4 h-4 text-indigo-500" />
              <span>Gemini ({uiLang === 'en' ? 'Default' : 'پیش‌فرض'})</span>
            </button>

            {/* Custom Provider Tab / Radio */}
            <button
              type="button"
              onClick={() => handleSwitchProvider('custom')}
              className={`flex items-center justify-center gap-2.5 py-2.5 px-3 rounded-lg text-xs font-bold transition-all ${
                selectedProvider === 'custom'
                  ? 'bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-sm border border-slate-200/80 dark:border-slate-700'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <span className={`w-2 h-2 rounded-full transition-colors ${selectedProvider === 'custom' ? 'bg-emerald-500 ring-4 ring-emerald-500/20' : 'bg-slate-300 dark:bg-slate-700'}`} />
              <Server className="w-4 h-4 text-emerald-500" />
              <span>{uiLang === 'en' ? 'Custom Provider' : 'سرویس‌دهنده سفارشی'}</span>
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* VIEW 1: GEMINI PROVIDER (DEFAULT)                             */}
        {/* ------------------------------------------------------------- */}
        {selectedProvider === 'gemini' && (
          <>
            {/* Info Banner */}
            <div className="bg-slate-100 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex items-center justify-between text-xs text-slate-700 dark:text-slate-300">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>
                  {keysList.length > 0 
                    ? (uiLang === 'en' ? 'Auto-rotation active across all saved keys' : 'چرخش خودکار روی کلیدهای ثبت‌شده فعال است')
                    : t.defaultKeyActive}
                </span>
              </div>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 flex items-center gap-1 font-semibold underline underline-offset-2 shrink-0"
              >
                <span>{getKeyLinkText()}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            {/* Removed Broken Keys Report Box */}
            {removedKeysReport.length > 0 && (
              <div className="bg-rose-50 dark:bg-rose-950/50 border border-rose-300 dark:border-rose-800 rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-rose-800 dark:text-rose-200">
                    <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>
                      {uiLang === 'en'
                        ? `Auto-removed ${removedKeysReport.length} broken key(s):`
                        : `${removedKeysReport.length} کلید خراب یا نامعتبر به‌صورت خودکار حذف شد:`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRemovedKeysReport([])}
                    className="text-[11px] font-semibold text-rose-600 dark:text-rose-300 hover:underline"
                  >
                    {uiLang === 'en' ? 'Dismiss' : 'پاک کردن گزارش'}
                  </button>
                </div>

                <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto">
                  {removedKeysReport.map((rem) => (
                    <div
                      key={`${rem.id}_${rem.removedAt}`}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] bg-white/80 dark:bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-rose-200 dark:border-rose-900/70"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-rose-700 dark:text-rose-300">{rem.label}</span>
                        <span className="font-mono text-[10px] text-slate-500">{rem.maskedKey}</span>
                      </div>
                      <span className="text-slate-600 dark:text-slate-400 text-[10px] truncate max-w-xs" title={rem.reason}>
                        {rem.reason}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Global RPM Limiter Settings */}
            <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <Gauge className="w-4 h-4 text-indigo-500 shrink-0" />
                <div>
                  <span className="font-bold text-slate-800 dark:text-slate-200 block">
                    {uiLang === 'en' ? 'Per-Key Rate Limit (RPM Protection)' : 'سقف درخواست در دقیقه هر کلید (RPM)'}
                  </span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">
                    {uiLang === 'en'
                      ? 'Automatically spaces requests per key & switches on daily quota limit.'
                      : 'تنظیم خودکار فاصله درخواست‌ها برای جلوگیری از خطای 429 و سوئیچ خودکار هنگام اتمام سهمیه روزانه'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {[8, 12, 15, 30].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => handleDefaultRpmChange(val)}
                    className={`px-2 py-1 rounded-lg text-[10px] font-mono font-bold border transition-all ${
                      defaultRpm === val
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    {val}
                  </button>
                ))}
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={defaultRpm}
                  onChange={(e) => handleDefaultRpmChange(parseInt(e.target.value, 10) || 12)}
                  className="w-12 text-center text-[11px] font-mono font-bold bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg py-1 text-indigo-600 dark:text-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  title="Custom RPM"
                />
              </div>
            </div>

            {/* Saved Keys List */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-500" />
                  <span>{uiLang === 'en' ? 'Saved Gemini API Keys' : uiLang === 'ar' ? 'مجموعة المفاتيح' : 'لیست کلیدهای ذخیره‌شده'}</span>
                  <span className="text-[10px] bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-1.5 py-0.2 rounded-full font-bold">
                    {keysList.length}
                  </span>
                </h4>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {keysList.some((k) => isKeyQuotaExhausted(k)) && (
                    <button
                      type="button"
                      onClick={handleResetAllQuotas}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/50 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-[11px] font-bold transition-all"
                      title={uiLang === 'en' ? 'Clear daily exhausted flags' : 'بازنشانی وضعیت سهمیه کلیدها'}
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>{uiLang === 'en' ? 'Reset Quotas' : 'بازنشانی سهمیه‌ها'}</span>
                    </button>
                  )}

                  {keysList.length > 0 && (
                    <button
                      type="button"
                      onClick={handleTestAllKeys}
                      disabled={isTestingAll}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-bold transition-all disabled:opacity-50"
                      title={uiLang === 'en' ? 'Test all keys and auto-delete broken ones' : 'تست همه کلیدها و حذف خودکار کلیدهای خراب'}
                    >
                      <RefreshCw className={`w-3 h-3 ${isTestingAll ? 'animate-spin text-indigo-500' : ''}`} />
                      <span>
                        {isTestingAll
                          ? (uiLang === 'en' ? 'Testing & Cleaning...' : 'در حال تست و پاکسازی...')
                          : (uiLang === 'en' ? 'Test All & Auto-Clean' : 'تست همه و حذف خراب‌ها')}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {keysList.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-xs text-slate-500">
                  {uiLang === 'en' ? 'No custom API keys saved yet. Add your first key or batch list below.' : 'هنوز هیچ کلیدی ثبت نشده است. کلید تکی یا لیست گروهی خود را در کادر زیر وارد کنید.'}
                </div>
              ) : (
                <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                  {keysList.map((k) => {
                    const isMasked = !showKeys[k.id];
                    const maskedKey = maskApiKey(k.key);
                    const exhausted = isKeyQuotaExhausted(k);

                    return (
                      <div
                        key={k.id}
                        className={`p-3 rounded-xl border transition-all flex flex-col gap-2.5 ${
                          exhausted
                            ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800'
                            : k.isPrimary
                              ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800'
                              : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 flex-1 min-w-0">
                            <button
                              type="button"
                              onClick={() => handleSetPrimary(k.id)}
                              className={`p-1.5 rounded-lg border transition-colors ${
                                k.isPrimary
                                  ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800'
                                  : 'bg-slate-100 text-slate-400 border-slate-200 dark:bg-slate-800 dark:border-slate-700 hover:text-amber-500'
                              }`}
                              title={k.isPrimary ? 'Primary Key' : 'Set as Primary'}
                            >
                              <Star className={`w-3.5 h-3.5 ${k.isPrimary ? 'fill-amber-500' : ''}`} />
                            </button>

                            <div className="flex flex-col min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
                                  {k.label}
                                </span>
                                {k.isPrimary && (
                                  <span className="text-[9px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold px-1.5 py-0.2 rounded border border-amber-500/20">
                                    {uiLang === 'en' ? 'Primary' : 'اصلی'}
                                  </span>
                                )}
                                {k.status === 'valid' && !exhausted && (
                                  <span className="text-[9px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-500/20 flex items-center gap-0.5">
                                    <CheckCircle2 className="w-2.5 h-2.5" /> {uiLang === 'en' ? 'Valid' : 'معتبر و فعال'}
                                  </span>
                                )}
                                {exhausted && (
                                  <span className="text-[9px] bg-amber-500/15 text-amber-700 dark:text-amber-300 font-bold px-1.5 py-0.2 rounded border border-amber-500/30">
                                    {uiLang === 'en' ? 'Quota Exhausted' : 'اتمام سهمیه روزانه'}
                                  </span>
                                )}
                                {k.status === 'invalid' && (
                                  <span className="text-[9px] bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold px-1.5 py-0.2 rounded border border-rose-500/20 flex items-center gap-0.5">
                                    <AlertCircle className="w-2.5 h-2.5" /> {uiLang === 'en' ? 'Key Error' : 'خطای ارتباط'}
                                  </span>
                                )}
                              </div>

                              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5">
                                {isMasked ? maskedKey : k.key}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                            <select
                              value={k.rpmLimit || defaultRpm}
                              onChange={(e) => handleKeyRpmChange(k.id, parseInt(e.target.value, 10))}
                              className="text-[10px] font-mono font-bold bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-1.5 py-1 text-slate-700 dark:text-slate-300 focus:outline-none"
                              title={uiLang === 'en' ? 'Requests Per Minute limit' : 'محدودیت درخواست در دقیقه'}
                            >
                              {[5, 8, 10, 12, 15, 20, 30, 60].map((r) => (
                                <option key={r} value={r}>{r} RPM</option>
                              ))}
                            </select>

                            <button
                              type="button"
                              onClick={() => handleToggleShow(k.id)}
                              className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-white bg-slate-200/60 dark:bg-slate-800 rounded-lg transition-colors text-xs"
                            >
                              {isMasked ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                            </button>

                            <button
                              type="button"
                              onClick={() => handleTestSingleKey(k.id, k.key)}
                              disabled={testingKeyId === k.id}
                              className="px-2.5 py-1 text-[11px] font-semibold bg-slate-200/80 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-indigo-700 dark:text-indigo-300 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                            >
                              {testingKeyId === k.id ? (
                                <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
                              ) : (
                                <Activity className="w-3 h-3 text-indigo-500" />
                              )}
                              <span>{uiLang === 'en' ? 'Test' : 'بررسی'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDeleteKey(k.id)}
                              className="p-1.5 text-rose-600 hover:bg-rose-100 dark:hover:bg-rose-950/60 rounded-lg transition-colors"
                              title="Delete Key"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {k.lastError && (
                          <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900/80 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2 leading-relaxed break-words">
                            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                            <span className="font-medium flex-1">{k.lastError}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Add Single or Batch Keys Mode Switch */}
            <div className="bg-slate-50 dark:bg-slate-950 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  {showBatchImport ? <ListPlus className="w-4 h-4 text-indigo-500" /> : <Plus className="w-3.5 h-3.5 text-indigo-500" />}
                  <span>
                    {showBatchImport
                      ? (uiLang === 'en' ? 'Batch Import Gemini Keys (Auto-Named)' : 'افزودن گروهی لیست کلیدهای Gemini (نام‌گذاری خودکار)')
                      : (uiLang === 'en' ? 'Add Single Gemini Key' : uiLang === 'ar' ? 'إضافة مفتاح جديد' : 'افزودن کلید تکی')}
                  </span>
                </h4>

                <button
                  type="button"
                  onClick={() => setShowBatchImport(!showBatchImport)}
                  className="text-[11px] font-bold px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition-colors flex items-center gap-1"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  <span>
                    {showBatchImport
                      ? (uiLang === 'en' ? 'Switch to Single Key' : 'حالت کلید تکی')
                      : (uiLang === 'en' ? 'Batch Add List' : 'افزودن گروهی (لیست کلیدها)')}
                  </span>
                </button>
              </div>

              {!showBatchImport ? (
                <form onSubmit={handleAddKey} className="flex flex-col gap-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      type="text"
                      value={newKeyLabel}
                      onChange={(e) => setNewKeyLabel(e.target.value)}
                      placeholder={uiLang === 'en' ? 'Key Label (e.g. Work Key)' : 'عنوان کلید (یا خالی برای خودکار)'}
                      className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newKeyInput}
                      onChange={(e) => setNewKeyInput(e.target.value)}
                      placeholder="AIzaSy..."
                      className="sm:col-span-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={!newKeyInput.trim()}
                    className="self-end px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{uiLang === 'en' ? 'Add & Verify Key' : 'افزودن و بررسی کلید'}</span>
                  </button>
                </form>
              ) : (
                <form onSubmit={handleBatchImportKeys} className="flex flex-col gap-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={batchNamePrefix}
                      onChange={(e) => setBatchNamePrefix(e.target.value)}
                      placeholder={uiLang === 'en' ? 'Auto-name prefix (default: Key)' : 'پیشوند نام خودکار (پیش‌فرض: کلید)'}
                      className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center px-2">
                      {uiLang === 'en'
                        ? `Keys will be auto-named "${batchNamePrefix.trim() || 'Key'} #${keysList.length + 1}", ...`
                        : `نام خودکار: «${batchNamePrefix.trim() || 'کلید'} #${keysList.length + 1}»، «${batchNamePrefix.trim() || 'کلید'} #${keysList.length + 2}»...`}
                    </div>
                  </div>

                  <textarea
                    rows={4}
                    value={batchKeysInput}
                    onChange={(e) => setBatchKeysInput(e.target.value)}
                    placeholder={
                      uiLang === 'en'
                        ? 'Paste multiple Gemini API keys (one per line or comma-separated):\nAIzaSy...\nAIzaSy...'
                        : 'چندین کلید Gemini را پشت‌سرهم (هر خط یک کلید یا با کاما) اینجا وارد کنید:\nAIzaSy...\nAIzaSy...'
                    }
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none leading-relaxed"
                    dir="ltr"
                  />

                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">
                      {uiLang === 'en'
                        ? 'Broken/invalid keys are automatically deleted and listed by name.'
                        : 'کلیدهای خراب پس از بررسی خودکار حذف شده و نامشان به شما گزارش می‌شود.'}
                    </span>

                    <button
                      type="submit"
                      disabled={isImportingBatch || parseBatchApiKeysInput(batchKeysInput).length === 0}
                      className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                    >
                      {isImportingBatch ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ListPlus className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isImportingBatch
                          ? (uiLang === 'en' ? 'Importing & Testing...' : 'در حال افزودن و تست...')
                          : (uiLang === 'en'
                              ? `Import & Auto-Test (${parseBatchApiKeysInput(batchKeysInput).length})`
                              : `افزودن و تست خودکار (${parseBatchApiKeysInput(batchKeysInput).length} کلید)`)}
                      </span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          </>
        )}

        {/* ------------------------------------------------------------- */}
        {/* VIEW 2: CUSTOM PROVIDER (BYOK)                                */}
        {/* ------------------------------------------------------------- */}
        {selectedProvider === 'custom' && (
          <div className="flex flex-col gap-4">
            {/* Custom Provider Info */}
            <div className="bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60 rounded-xl p-3 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-2.5 leading-relaxed">
              <Server className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block mb-0.5">
                  {uiLang === 'en' ? 'OpenAI-Compatible Chat Completions Interface' : 'پشتیبانی از API سازگار با OpenAI Chat Completions'}
                </span>
                <span className="text-[11px] opacity-90">
                  {uiLang === 'en'
                    ? 'Connect any custom provider such as OpenAI, Ollama, OpenRouter, Groq, Together, DeepSeek, LocalAI, vLLM, or LM Studio.'
                    : 'امکان اتصال به هر سرویس‌دهنده سازگار نظیر OpenAI، Ollama، OpenRouter، Groq، DeepSeek، Together، سرورهای محلی یا vLLM.'}
                </span>
              </div>
            </div>

            {/* Form Fields */}
            <div className="flex flex-col gap-3.5 bg-slate-50 dark:bg-slate-950 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
              
              {/* Field 1: Provider Name (optional) */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>{uiLang === 'en' ? 'Provider Name' : 'نام سرویس‌دهنده'}</span>
                  <span className="text-[10px] text-slate-400 font-normal">{uiLang === 'en' ? '(optional)' : '(اختیاری)'}</span>
                </label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => {
                    setCustomName(e.target.value);
                    persistCustomProviderConfig({ name: e.target.value });
                  }}
                  placeholder="My Custom API"
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              {/* Field 2: Base API URL (required) */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>{uiLang === 'en' ? 'Base API URL' : 'آدرس پایه API (Base URL)'}</span>
                  <span className="text-[10px] text-rose-500 font-bold">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={customBaseUrl}
                    onChange={(e) => {
                      setCustomBaseUrl(e.target.value);
                      persistCustomProviderConfig({ baseUrl: e.target.value });
                    }}
                    placeholder="https://api.example.com/v1"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>
                <span className="text-[10px] text-slate-500">
                  {uiLang === 'en' 
                    ? 'Enter base URL (e.g. https://api.openai.com/v1). /chat/completions is appended automatically.'
                    : 'آدرس پایه (مانند https://api.openai.com/v1). اندپوینت /chat/completions خودکار اضافه می‌شود.'}
                </span>
              </div>

              {/* Field 3: API Key (required) */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>{uiLang === 'en' ? 'API Key' : 'کلید API'}</span>
                  <span className="text-[10px] text-rose-500 font-bold">*</span>
                </label>
                <div className="relative flex items-center">
                  <input
                    type={showCustomApiKey ? 'text' : 'password'}
                    value={customApiKey}
                    onChange={(e) => {
                      setCustomApiKey(e.target.value);
                      persistCustomProviderConfig({ apiKey: e.target.value });
                    }}
                    placeholder="•••••••••••••••••"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 pr-10 text-xs font-mono text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCustomApiKey(!showCustomApiKey)}
                    className="absolute right-2.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  >
                    {showCustomApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Field 4: Model (required) */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>{uiLang === 'en' ? 'Model ID' : 'شناسه مدل (Model ID)'}</span>
                  <span className="text-[10px] text-rose-500 font-bold">*</span>
                </label>
                <input
                  type="text"
                  value={customModel}
                  onChange={(e) => {
                    setCustomModel(e.target.value);
                    persistCustomProviderConfig({ model: e.target.value });
                  }}
                  placeholder="model-name (e.g. gpt-4o-mini, llama-3.3-70b, deepseek-chat)"
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              {/* Test Connection Action & Status */}
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800/80 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  {/* Status Indicator */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] font-medium text-slate-500">
                      {uiLang === 'en' ? 'Status:' : 'وضعیت:'}
                    </span>

                    {customTestStatus === 'idle' && (
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 bg-slate-200/70 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                        {uiLang === 'en' ? 'Not tested' : 'تست نشده'}
                      </span>
                    )}

                    {customTestStatus === 'testing' && (
                      <span className="text-[11px] font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 px-2 py-0.5 rounded-md flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                        <span>{uiLang === 'en' ? 'Testing connection...' : 'در حال بررسی اتصال...'}</span>
                      </span>
                    )}

                    {customTestStatus === 'success' && (
                      <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-md flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                        <span>{uiLang === 'en' ? 'Connection successful' : 'اتصال با موفقیت برقرار شد'}</span>
                        {customTestLatency && (
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-normal">
                            ({customTestLatency}ms)
                          </span>
                        )}
                      </span>
                    )}

                    {customTestStatus === 'failed' && (
                      <span className="text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 px-2 py-0.5 rounded-md flex items-center gap-1 truncate max-w-[220px]">
                        <AlertCircle className="w-3 h-3 text-rose-500 shrink-0" />
                        <span>{uiLang === 'en' ? 'Connection failed' : 'خطا در اتصال'}</span>
                      </span>
                    )}
                  </div>

                  {/* Test Connection Button */}
                  <button
                    type="button"
                    onClick={handleTestCustomConnection}
                    disabled={isTestingCustom || !customBaseUrl.trim() || !customApiKey.trim() || !customModel.trim()}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 shrink-0"
                  >
                    {isTestingCustom ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Activity className="w-3.5 h-3.5" />
                    )}
                    <span>{uiLang === 'en' ? 'Test Connection' : 'تست اتصال'}</span>
                  </button>
                </div>

                {/* Detailed Test Feedback Banner */}
                {customTestMessage && (
                  <div className={`p-2.5 rounded-lg text-xs flex items-start gap-2 leading-relaxed break-words ${
                    customTestStatus === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800'
                      : 'bg-rose-50 dark:bg-rose-950/60 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-800'
                  }`}>
                    {customTestStatus === 'success' ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    )}
                    <span className="flex-1 font-medium">{customTestMessage}</span>
                  </div>
                )}
              </div>

            </div>

            {/* Extended latency tolerance notice for intermediary/proxy keys */}
            <div className="bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800/60 rounded-xl p-3 text-[11px] text-sky-900 dark:text-sky-200 flex items-start gap-2 leading-relaxed">
              <Clock className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
              <span>
                {uiLang === 'en'
                  ? 'Extended proxy latency tolerance active: Ping tests wait up to 45s and each translation batch waits up to 240s (4 min) so slower intermediary keys do not disconnect prematurely.'
                  : 'حالت صبر طولانی برای کلیدهای واسط فعال است: تست اتصال تا ۴۵ ثانیه و ترجمه هر دسته تا ۲۴۰ ثانیه (۴ دقیقه) منتظر پاسخ می‌ماند تا تأخیر سرور واسط باعث قطع شدن ترجمه نشود.'}
              </span>
            </div>

            {/* Note about translation and streaming */}
            <p className="text-[11px] text-slate-500 leading-relaxed px-1">
              {uiLang === 'en'
                ? 'When Custom Provider is active, translations use this endpoint directly through the secure backend proxy with standardized JSON mapping.'
                : 'هنگام فعال بودن سرویس‌دهنده سفارشی، تمام ترجمه‌ها از طریق پروکسی امن سرور و با نگاشت یکپارچه JSON انجام می‌شوند.'}
            </p>
          </div>
        )}

        {/* Modal Footer */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
          <div className="text-[11px] text-slate-500 font-medium">
            {selectedProvider === 'gemini' ? (
              <span>{uiLang === 'en' ? 'Gemini mode active' : 'حالت گوگل جمینای فعال است'}</span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                <Check className="w-3 h-3" />
                <span>{uiLang === 'en' ? 'Custom Provider mode active' : 'حالت سرویس‌دهنده سفارشی فعال است'}</span>
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-all shadow-md"
          >
            {t.close}
          </button>
        </div>

      </div>
    </div>
  );
};

