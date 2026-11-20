import React, { useRef, useState } from 'react';
import { AIProvider, SubtitleFolder, SubtitleFolderFile } from '../types';
import { StoredApiKey, isKeyQuotaExhausted } from '../lib/apiKeyManager';
import { UILanguage, TRANSLATIONS } from '../lib/i18n';
import { getFileCompletionStats, getFolderCompletionStats } from '../lib/translationCompleteness';
import {
  FolderPlus,
  FolderOpen,
  Folder,
  Upload,
  FileText,
  Trash2,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  FileArchive,
  Settings2,
  Sparkles,
  Plus,
  Edit3,
  Check,
  X,
  FolderUp,
  Download,
  DatabaseBackup,
  Key,
  Layers,
  CheckSquare,
  Square,
  Play,
  RotateCcw,
  Wand2,
  AlertCircle,
} from 'lucide-react';

interface FolderWorkspaceProps {
  folders: SubtitleFolder[];
  activeFolder: SubtitleFolder | null;
  activeFileId: string | null;
  inTranslationView: boolean;
  isTranslating: boolean;
  translatingFileId?: string | null;
  translatingFileIds?: string[];
  fileKeyUsageMap?: Record<string, string>;
  savedGeminiKeys?: StoredApiKey[];
  activeProvider?: AIProvider;
  selectedFileIds?: string[];
  onToggleSelectFile?: (fileId: string) => void;
  onToggleSelectAllFiles?: () => void;
  concurrentFilesCount?: number;
  setConcurrentFilesCount?: (count: number) => void;
  onAssignFileKey?: (folderId: string, fileId: string, keyId: string | undefined) => void;
  onTranslateConcurrentFiles?: (fileIds?: string[]) => void;
  onRetranslateFolder?: (folderId: string) => void;
  onCompleteMissingFolder?: (folderId: string) => void;
  onBatchExportCompletedFiles?: (folderId: string, format: 'srt' | 'vtt') => void;
  onClearCompletedFilesBatch?: (folderId: string) => void;
  targetLanguage?: string;
  onExportFullBackup?: () => void;
  onImportFullBackup?: (file: File) => Promise<void>;
  selectedEncoding: string;
  setSelectedEncoding: (enc: string) => void;
  uiLang: UILanguage;
  onCreateFolder: (name: string) => SubtitleFolder;
  onRenameFolder: (folderId: string, newName: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onSelectFolder: (folderId: string) => void;
  onAddFilesToFolder: (files: FileList | File[], folderId: string, encoding?: string) => Promise<number>;
  onUploadSystemDirectory: (files: FileList) => Promise<void>;
  onRemoveFileFromFolder: (folderId: string, fileId: string) => void;
  onSelectFile: (fileId: string) => void;
  onEnterTranslationView: () => void;
  onExitTranslationView: () => void;
  onBatchExportFolder: (format: 'srt' | 'vtt') => void;
  onLoadSampleToFolder: () => void;
}

export const FolderWorkspace: React.FC<FolderWorkspaceProps> = ({
  folders,
  activeFolder,
  activeFileId,
  inTranslationView,
  isTranslating,
  translatingFileId,
  translatingFileIds = [],
  fileKeyUsageMap = {},
  savedGeminiKeys = [],
  activeProvider = 'gemini',
  selectedFileIds = [],
  onToggleSelectFile,
  onToggleSelectAllFiles,
  concurrentFilesCount = 2,
  setConcurrentFilesCount,
  onAssignFileKey,
  onTranslateConcurrentFiles,
  onRetranslateFolder,
  onCompleteMissingFolder,
  onBatchExportCompletedFiles,
  onClearCompletedFilesBatch,
  targetLanguage = 'fa',
  onExportFullBackup,
  onImportFullBackup,
  selectedEncoding,
  setSelectedEncoding,
  uiLang,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onSelectFolder,
  onAddFilesToFolder,
  onUploadSystemDirectory,
  onRemoveFileFromFolder,
  onSelectFile,
  onEnterTranslationView,
  onExitTranslationView,
  onBatchExportFolder,
  onLoadSampleToFolder,
}) => {
  const t = TRANSLATIONS[uiLang];
  const isEn = uiLang === 'en';
  const [newFolderName, setNewFolderName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const multiFileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const quickAddFileInputRef = useRef<HTMLInputElement>(null);
  const backupImportInputRef = useRef<HTMLInputElement>(null);

  const isFileCurrentlyTranslating = (fileId: string) =>
    translatingFileIds.includes(fileId) || translatingFileId === fileId;

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const getFileStats = (file: SubtitleFolderFile) => {
    const s = getFileCompletionStats(file, targetLanguage);
    return {
      total: s.total,
      translated: s.completed,
      missingCount: s.missingCount,
      pct: s.pct,
      isDone: s.isDone,
    };
  };

  const getFolderStats = (folder: SubtitleFolder) => {
    const s = getFolderCompletionStats(folder, targetLanguage);
    return {
      fileCount: s.fileCount,
      totalLines: s.totalLines,
      translatedLines: s.completedLines,
      missingLines: s.missingLines,
      incompleteFileCount: s.incompleteFileCount,
      completedFileCount: s.completedFileCount,
      pct: s.pct,
      isDone: s.isDone,
    };
  };

  const getCompletedBatchFiles = (folder: SubtitleFolder) => {
    const ids = folder.lastCompletedFileIds || [];
    if (ids.length === 0) return [];
    const idSet = new Set(ids);
    return folder.files.filter((fl) => idSet.has(fl.id));
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    const finalName = trimmed || (isEn ? `Project ${folders.length + 1}` : `پروژه ${folders.length + 1}`);
    onCreateFolder(finalName);
    setNewFolderName('');
  };

  const handleDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    let targetFolder = activeFolder;
    if (!targetFolder) {
      targetFolder = onCreateFolder(isEn ? `Folder ${folders.length + 1}` : `پوشه ${folders.length + 1}`);
    }
    await onAddFilesToFolder(e.dataTransfer.files, targetFolder.id, selectedEncoding);
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    let targetFolder = activeFolder;
    if (!targetFolder) {
      targetFolder = onCreateFolder(isEn ? `Folder ${folders.length + 1}` : `پوشه ${folders.length + 1}`);
    }
    await onAddFilesToFolder(fileList, targetFolder.id, selectedEncoding);
  };

  const handleBackupFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f && onImportFullBackup) {
      await onImportFullBackup(f);
    }
  };

  const renderBackupButtons = () => (
    <>
      {onExportFullBackup && (
        <button
          type="button"
          onClick={onExportFullBackup}
          disabled={isTranslating || folders.every((fld) => fld.files.length === 0)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/60 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800 disabled:opacity-45 transition-all"
          title={isEn ? 'Download full JSON backup of all folders & subtitles' : 'دانلود فایل پشتیبان (JSON) از تمام پوشه‌ها و زیرنویس‌ها'}
        >
          <Download className="w-3.5 h-3.5" />
          <span>{isEn ? 'Backup All' : 'پشتیبان‌گیری کل'}</span>
        </button>
      )}
      {onImportFullBackup && (
        <>
          <button
            type="button"
            onClick={() => backupImportInputRef.current?.click()}
            disabled={isTranslating}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-purple-50 hover:bg-purple-100 dark:bg-purple-950/40 dark:hover:bg-purple-900/60 text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-800 disabled:opacity-45 transition-all"
            title={isEn ? 'Restore folders & subtitles from a JSON backup file' : 'بازیابی و ایمپورت زیرنویس‌ها از فایل پشتیبان (JSON)'}
          >
            <DatabaseBackup className="w-3.5 h-3.5" />
            <span>{isEn ? 'Import Backup' : 'ایمپورت بکاپ'}</span>
          </button>
          <input
            ref={backupImportInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void handleBackupFileSelected(e)}
          />
        </>
      )}
    </>
  );

  // ============================================================================
  // COMPACT IN-TRANSLATION FOLDER BAR (when user is inside translation page)
  // ============================================================================
  if (inTranslationView && activeFolder) {
    const stats = getFolderStats(activeFolder);
    const completedBatchFiles = getCompletedBatchFiles(activeFolder);
    const completedBatchIdSet = new Set(completedBatchFiles.map((f) => f.id));
    const allSelected = activeFolder.files.length > 0 && activeFolder.files.every((f) => selectedFileIds.includes(f.id));
    const targetCountForConcurrent = selectedFileIds.length > 0
      ? selectedFileIds.length
      : stats.incompleteFileCount || activeFolder.files.length;

    return (
      <div className="w-full bg-white/95 dark:bg-slate-900/90 rounded-2xl border border-indigo-500/25 dark:border-indigo-500/35 p-4 lg:p-5 shadow-md dark:shadow-xl backdrop-blur-md flex flex-col gap-4 transition-all">
        {/* Top Row: Folder Info + Navigation + Backup + Fast Batch Export SRT & VTT */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3.5 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
              stats.isDone
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-600 dark:text-indigo-400'
            }`}>
              {stats.isDone ? <CheckCircle2 className="w-5 h-5" /> : <FolderOpen className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                  {activeFolder.name}
                </h2>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25">
                  {stats.fileCount} {isEn ? 'files' : 'فایل'}
                </span>
                <span className={`inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                  stats.isDone
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
                }`}>
                  {stats.isDone && <CheckCircle2 className="w-3 h-3" />}
                  <span>{stats.translatedLines}/{stats.totalLines} ({stats.pct}%)</span>
                </span>
                {stats.missingLines > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/25">
                    <AlertCircle className="w-3 h-3" />
                    <span>
                      {isEn
                        ? `${stats.incompleteFileCount} incomplete (${stats.missingLines} lines)`
                        : `${stats.incompleteFileCount} فایل ناقص • ${stats.missingLines} خط باقی‌مانده`}
                    </span>
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                {isEn
                  ? 'Assign a separate API key per file, complete only remaining untranslated lines, or batch-export in SRT / VTT.'
                  : 'برای هر فایل کلید دلخواه تعیین کنید، خطوط باقی‌مانده پوشه را تکمیل کنید یا کل پوشه را با تایم‌بندی دقیق خروجی بگیرید.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Manage / Switch Folder Button */}
            <button
              type="button"
              onClick={onExitTranslationView}
              disabled={isTranslating}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 disabled:opacity-50 transition-all"
            >
              <Folder className="w-3.5 h-3.5 text-indigo-500" />
              <span>{isEn ? 'Manage Folders' : 'مدیریت / تغییر پوشه'}</span>
            </button>

            {/* Add More Files Button */}
            <button
              type="button"
              onClick={() => quickAddFileInputRef.current?.click()}
              disabled={isTranslating}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/40 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-800 disabled:opacity-50 transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{isEn ? 'Add Files' : 'افزودن فایل'}</span>
            </button>
            <input
              ref={quickAddFileInputRef}
              type="file"
              multiple
              accept=".srt,.vtt,.ass,.ssa,.sub,.txt"
              className="hidden"
              onChange={(e) => {
                void handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
            />

            {renderBackupButtons()}

            {/* Fast Batch Export SRT ZIP */}
            <button
              type="button"
              onClick={() => onBatchExportFolder('srt')}
              disabled={isTranslating || activeFolder.files.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 border border-emerald-400/30 shadow-md disabled:opacity-50 transition-all active:scale-95"
              title={isEn ? 'Fast batch export all folder files as .SRT (.ZIP)' : 'خروجی سریع گروهی کل پوشه در فرمت SRT'}
            >
              <FileArchive className="w-3.5 h-3.5" />
              <span>{isEn ? 'Export .SRT' : 'خروجی SRT'}</span>
            </button>

            {/* Fast Batch Export VTT ZIP */}
            <button
              type="button"
              onClick={() => onBatchExportFolder('vtt')}
              disabled={isTranslating || activeFolder.files.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 border border-sky-400/30 shadow-md disabled:opacity-50 transition-all active:scale-95"
              title={isEn ? 'Fast batch export all folder files as .VTT (.ZIP)' : 'خروجی سریع گروهی کل پوشه در فرمت VTT'}
            >
              <FileArchive className="w-3.5 h-3.5" />
              <span>{isEn ? 'Export .VTT' : 'خروجی VTT'}</span>
            </button>
          </div>
        </div>

        {/* Concurrent Multi-File Controls Toolbar */}
        {activeFolder.files.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-slate-50/90 dark:bg-slate-950/60 px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2.5 flex-wrap">
              {onToggleSelectAllFiles && (
                <button
                  type="button"
                  onClick={onToggleSelectAllFiles}
                  disabled={isTranslating}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 disabled:opacity-50"
                >
                  {allSelected ? (
                    <CheckSquare className="w-4 h-4 text-indigo-500" />
                  ) : (
                    <Square className="w-4 h-4 text-slate-400" />
                  )}
                  <span>
                    {selectedFileIds.length > 0
                      ? (isEn ? `${selectedFileIds.length} selected` : `${selectedFileIds.length} فایل انتخاب‌شده`)
                      : (isEn ? 'Select files for batch run' : 'انتخاب فایل‌ها برای ترجمه همزمان')}
                  </span>
                </button>
              )}

              {setConcurrentFilesCount && (
                <div className="flex items-center gap-1.5 text-xs border-s border-slate-300 dark:border-slate-700 ps-2.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-500" />
                  <span className="text-[11px] text-slate-600 dark:text-slate-400">
                    {isEn ? 'Concurrent Workers:' : 'تعداد فایل همزمان:'}
                  </span>
                  <select
                    value={concurrentFilesCount}
                    onChange={(e) => setConcurrentFilesCount(parseInt(e.target.value, 10) || 2)}
                    disabled={isTranslating}
                    className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-[11px] font-bold text-indigo-700 dark:text-indigo-300 focus:outline-none disabled:opacity-50"
                  >
                    {[1, 2, 3, 4, 5, 6].map((cnt) => (
                      <option key={cnt} value={cnt}>
                        {isEn ? `${cnt} ${cnt === 1 ? 'file (serial)' : 'files parallel'}` : cnt === 1 ? '۱ فایل (تکی)' : `${cnt} فایل همزمان`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
              {onCompleteMissingFolder && stats.incompleteFileCount > 0 && (
                <button
                  type="button"
                  onClick={() => onCompleteMissingFolder(activeFolder.id)}
                  disabled={isTranslating}
                  className="flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 border border-emerald-400/30 shadow-md shadow-emerald-600/20 disabled:opacity-45 transition-all active:scale-95 shrink-0"
                  title={isEn ? 'Translate ONLY remaining missing or untranslated English lines in this folder' : 'ترجمه فقط خطوط باقی‌مانده و انگلیسی فایل‌های ناقص این پوشه'}
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  <span>
                    {isEn
                      ? `Complete Missing (${stats.incompleteFileCount}f / ${stats.missingLines}l)`
                      : `تکمیل خطوط باقی‌مانده (${stats.incompleteFileCount} فایل • ${stats.missingLines} خط)`}
                  </span>
                </button>
              )}

              {onRetranslateFolder && (
                <button
                  type="button"
                  onClick={() => onRetranslateFolder(activeFolder.id)}
                  disabled={isTranslating || activeFolder.files.length === 0}
                  className="flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-amber-800 dark:text-amber-200 bg-amber-100 hover:bg-amber-200 dark:bg-amber-950/50 dark:hover:bg-amber-900/60 border border-amber-300 dark:border-amber-700 disabled:opacity-45 transition-all active:scale-95 shrink-0"
                  title={isEn ? 'Re-translate all files in this folder from scratch (EN -> FA)' : 'ترجمه مجدد کامل همه فایل‌های این پوشه از ابتدا (انگلیسی به فارسی)'}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{isEn ? 'Re-translate Folder' : 'ترجمه مجدد پوشه'}</span>
                </button>
              )}

              {onTranslateConcurrentFiles && (
                <button
                  type="button"
                  onClick={() => onTranslateConcurrentFiles(selectedFileIds.length > 0 ? selectedFileIds : undefined)}
                  disabled={isTranslating || activeFolder.files.length === 0}
                  className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 shadow-md shadow-indigo-500/20 disabled:opacity-45 transition-all active:scale-95 shrink-0"
                >
                  {isTranslating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-white" />
                  )}
                  <span>
                    {selectedFileIds.length > 0
                      ? (isEn
                          ? `Translate ${selectedFileIds.length} Selected (${Math.min(concurrentFilesCount, selectedFileIds.length)}x Parallel)`
                          : `ترجمه همزمان ${selectedFileIds.length} فایل انتخاب‌شده`)
                      : (isEn
                          ? `Translate ${targetCountForConcurrent} File(s) (${Math.min(concurrentFilesCount, targetCountForConcurrent)}x Parallel)`
                          : `ترجمه همزمان فایل‌های پوشه (${targetCountForConcurrent} فایل)`)}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Dedicated Separate Download Strip for ONLY the Files Recently Completed */}
        {completedBatchFiles.length > 0 && onBatchExportCompletedFiles && (
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-3 rounded-xl bg-emerald-50/90 dark:bg-emerald-950/35 border border-emerald-400/50 dark:border-emerald-700/70 shadow-sm">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-emerald-900 dark:text-emerald-200 flex items-center gap-2 flex-wrap">
                  <span>
                    {isEn
                      ? `Completed Files Ready for Separate Download (${completedBatchFiles.length} file(s))`
                      : `فایل‌های تکمیل‌شده آماده دانلود جداگانه (${completedBatchFiles.length} فایل)`}
                  </span>
                </div>
                <div className="text-[11px] text-emerald-700 dark:text-emerald-300/90 mt-0.5 truncate font-mono" title={completedBatchFiles.map((f) => f.fileName).join(' • ')}>
                  {completedBatchFiles.slice(0, 4).map((f) => f.fileName).join('  •  ')}
                  {completedBatchFiles.length > 4 ? `  +${completedBatchFiles.length - 4}` : ''}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <button
                type="button"
                onClick={() => onBatchExportCompletedFiles(activeFolder.id, 'srt')}
                disabled={isTranslating}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 shadow-sm disabled:opacity-50 transition-all active:scale-95"
                title={isEn ? 'Download ONLY the completed files as .SRT' : 'دانلود یکجای فقط فایل‌های تکمیل‌شده با فرمت SRT'}
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isEn ? 'Download Completed (.SRT)' : 'دانلود فقط تکمیل‌شده‌ها (SRT)'}</span>
              </button>
              <button
                type="button"
                onClick={() => onBatchExportCompletedFiles(activeFolder.id, 'vtt')}
                disabled={isTranslating}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-teal-600 hover:bg-teal-500 shadow-sm disabled:opacity-50 transition-all active:scale-95"
                title={isEn ? 'Download ONLY the completed files as .VTT' : 'دانلود یکجای فقط فایل‌های تکمیل‌شده با فرمت VTT'}
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isEn ? 'Download Completed (.VTT)' : 'دانلود فقط تکمیل‌شده‌ها (VTT)'}</span>
              </button>
              {onClearCompletedFilesBatch && (
                <button
                  type="button"
                  onClick={() => onClearCompletedFilesBatch(activeFolder.id)}
                  className="p-1.5 rounded-lg text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 transition-colors"
                  title={isEn ? 'Dismiss notice' : 'بستن این نوار'}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* File Switcher Cards inside the Active Folder */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 max-h-72 overflow-y-auto pr-1">
          {activeFolder.files.map((file) => {
            const isActive = file.id === activeFileId;
            const fStats = getFileStats(file);
            const isCurrentlyTranslatingFile = isFileCurrentlyTranslating(file.id);
            const isSelected = selectedFileIds.includes(file.id);
            const runningKeyLabel = fileKeyUsageMap[file.id];

            return (
              <div
                key={file.id}
                onClick={() => onSelectFile(file.id)}
                className={`group flex flex-col gap-2 p-2.5 rounded-xl border transition-all cursor-pointer ${
                  isCurrentlyTranslatingFile
                    ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-400 dark:border-amber-600 ring-2 ring-amber-500/20'
                    : isActive
                      ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-500 ring-2 ring-indigo-500/20 shadow-sm'
                      : 'bg-slate-50 dark:bg-slate-950/50 border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {onToggleSelectFile && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleSelectFile(file.id);
                        }}
                        disabled={isTranslating}
                        className="text-slate-400 hover:text-indigo-500 disabled:opacity-40 shrink-0"
                        title={isEn ? 'Select for concurrent translation' : 'انتخاب برای ترجمه همزمان'}
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-indigo-500" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    )}

                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      isCurrentlyTranslatingFile
                        ? 'bg-amber-500/15 text-amber-500'
                        : fStats.isDone
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : isActive
                            ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400'
                            : 'bg-slate-200/80 dark:bg-slate-800 text-slate-500'
                    }`}>
                      {isCurrentlyTranslatingFile ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : fStats.isDone ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <FileText className="w-3.5 h-3.5" />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate font-mono" title={file.fileName}>
                          {file.fileName}
                        </div>
                        {completedBatchIdSet.has(file.id) && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 shrink-0">
                            {isEn ? 'Fixed' : 'تکمیل‌شده'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 flex-wrap">
                        <span className="uppercase font-mono font-bold text-indigo-600 dark:text-indigo-400">
                          .{file.sourceFormat}
                        </span>
                        <span>•</span>
                        <span className={`font-mono ${fStats.isDone ? 'text-emerald-600 dark:text-emerald-400 font-bold' : ''}`}>
                          {fStats.translated}/{fStats.total} ({fStats.pct}%)
                        </span>
                        {!fStats.isDone && fStats.missingCount > 0 && (
                          <>
                            <span>•</span>
                            <span className="text-amber-600 dark:text-amber-400 font-semibold">
                              {isEn ? `${fStats.missingCount} left` : `${fStats.missingCount} خط باقی‌مانده`}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {!isCurrentlyTranslatingFile && !isTranslating && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFileFromFolder(activeFolder.id, file.id);
                      }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 opacity-70 group-hover:opacity-100 transition-all shrink-0"
                      title={isEn ? 'Remove file' : 'حذف فایل'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Per-file live progress bar when active or partially done */}
                {(isCurrentlyTranslatingFile || (fStats.translated > 0 && !fStats.isDone)) && (
                  <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isCurrentlyTranslatingFile ? 'bg-amber-500' : 'bg-indigo-500'
                      }`}
                      style={{ width: `${fStats.pct}%` }}
                    />
                  </div>
                )}

                {/* Per-File API Key Selector (Gemini Mode) */}
                {activeProvider === 'gemini' && savedGeminiKeys.length > 0 && onAssignFileKey && (
                  <div
                    className="flex items-center gap-1.5 pt-1 border-t border-slate-200/70 dark:border-slate-800/70"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Key className="w-3 h-3 text-indigo-500 shrink-0" />
                    <select
                      value={file.assignedKeyId || ''}
                      onChange={(e) => onAssignFileKey(activeFolder.id, file.id, e.target.value || undefined)}
                      disabled={isCurrentlyTranslatingFile}
                      className="flex-1 min-w-0 text-[10px] font-medium bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-1.5 py-0.5 text-slate-700 dark:text-slate-300 focus:outline-none disabled:opacity-60 truncate"
                      title={isEn ? 'Dedicated Gemini API key for this file' : 'کلید API اختصاصی برای این فایل'}
                    >
                      <option value="">{isEn ? 'Auto (Key Pool Rotation)' : 'خودکار (چرخش کلیدها)'}</option>
                      {savedGeminiKeys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}{isKeyQuotaExhausted(k) ? (isEn ? ' (Exhausted)' : ' (سهمیه تمام)') : ''}
                        </option>
                      ))}
                    </select>
                    {runningKeyLabel && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-bold shrink-0">
                        {runningKeyLabel}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ============================================================================
  // STEP 1 & STEP 2 WIZARD VIEW (Create Folder -> Batch Upload Files -> Enter Translation Page)
  // ============================================================================
  const activeStats = activeFolder ? getFolderStats(activeFolder) : null;

  return (
    <div className="w-full flex flex-col gap-6">
      {/* 3-Step Workflow Banner */}
      <div className="bg-white/95 dark:bg-slate-900/90 rounded-2xl border border-indigo-500/20 dark:border-indigo-500/30 p-5 shadow-md dark:shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <FolderPlus className="w-5 h-5 text-indigo-500" />
              <span>
                {isEn ? 'Subtitle Folder & Batch Project Workspace' : 'مدیریت پوشه و بارگذاری گروهی زیرنویس'}
              </span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {isEn
                ? 'Step 1: Create or select a folder → Step 2: Batch-add subtitle files → Step 3: Enter the translation page.'
                : 'ابتدا پوشه بسازید یا انتخاب کنید، سپس فایل‌های زیرنویس را به‌صورت گروهی اضافه کنید و در نهایت وارد صفحه ترجمه پیش‌فرض شوید.'}
            </p>
          </div>

          {/* Encoding Selector & Full Backup Actions */}
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {renderBackupButtons()}

            <div className="flex items-center gap-2 text-xs">
              <label className="text-slate-600 dark:text-slate-400 flex items-center gap-1 font-medium">
                <Settings2 className="w-3.5 h-3.5" />
                <span>{t.encoding}:</span>
              </label>
              <select
                value={selectedEncoding}
                onChange={(e) => setSelectedEncoding(e.target.value)}
                className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-xs font-mono"
              >
                <option value="auto">{t.autoDetect}</option>
                <option value="UTF-8">UTF-8</option>
                <option value="Windows-1256">Windows-1256 (Persian/Arabic)</option>
                <option value="UTF-16LE">UTF-16 LE</option>
                <option value="ISO-8859-1">ISO-8859-1 (Latin)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Stepper Pills */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${
            activeFolder
              ? 'bg-emerald-50/70 dark:bg-emerald-950/25 border-emerald-400/50 text-emerald-800 dark:text-emerald-300'
              : 'bg-indigo-50/70 dark:bg-indigo-950/30 border-indigo-400/60 text-indigo-800 dark:text-indigo-200'
          }`}>
            <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
              {activeFolder ? <Check className="w-3.5 h-3.5" /> : '1'}
            </span>
            <div className="text-xs font-bold">
              {isEn ? 'Create or Select Folder' : '۱. ایجاد یا انتخاب پوشه'}
            </div>
          </div>

          <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${
            activeFolder && activeFolder.files.length > 0
              ? 'bg-emerald-50/70 dark:bg-emerald-950/25 border-emerald-400/50 text-emerald-800 dark:text-emerald-300'
              : activeFolder
                ? 'bg-indigo-50/70 dark:bg-indigo-950/30 border-indigo-400/60 text-indigo-800 dark:text-indigo-200'
                : 'bg-slate-50 dark:bg-slate-950/40 border-slate-200 dark:border-slate-800 text-slate-400'
          }`}>
            <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
              activeFolder ? 'bg-indigo-600 text-white' : 'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
            }`}>
              {activeFolder && activeFolder.files.length > 0 ? <Check className="w-3.5 h-3.5" /> : '2'}
            </span>
            <div className="text-xs font-bold">
              {isEn ? 'Batch Add Subtitle Files' : '۲. افزودن گروهی فایل‌های زیرنویس'}
            </div>
          </div>

          <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${
            activeFolder && activeFolder.files.length > 0
              ? 'bg-indigo-50/70 dark:bg-indigo-950/30 border-indigo-400/60 text-indigo-800 dark:text-indigo-200'
              : 'bg-slate-50 dark:bg-slate-950/40 border-slate-200 dark:border-slate-800 text-slate-400'
          }`}>
            <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
              activeFolder && activeFolder.files.length > 0 ? 'bg-indigo-600 text-white' : 'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
            }`}>
              3
            </span>
            <div className="text-xs font-bold">
              {isEn ? 'Enter Translation Page' : '۳. ورود به صفحه ترجمه پیش‌فرض'}
            </div>
          </div>
        </div>

        {/* Two-Column Split: Step 1 (Folders) & Step 2 (Batch File Upload) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* LEFT / START: Step 1 - Folder Manager */}
          <div className="lg:col-span-5 flex flex-col gap-3.5 bg-slate-50/80 dark:bg-slate-950/50 p-4 rounded-2xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <Folder className="w-4 h-4 text-indigo-500" />
                <span>{isEn ? 'Step 1: Project Folders' : 'مرحله ۱: پوشه‌های پروژه'}</span>
              </h3>
              <button
                type="button"
                onClick={() => dirInputRef.current?.click()}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition-colors"
                title={isEn ? 'Import an entire folder from your device' : 'وارد کردن مستقیم یک پوشه از سیستم'}
              >
                <FolderUp className="w-3.5 h-3.5" />
                <span>{isEn ? 'Import Folder' : 'آپلود پوشه از سیستم'}</span>
              </button>
              <input
                ref={dirInputRef}
                type="file"
                webkitdirectory=""
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    void onUploadSystemDirectory(e.target.files);
                  }
                  e.target.value = '';
                }}
              />
            </div>

            {/* New Folder Form */}
            <form onSubmit={handleCreateSubmit} className="flex items-center gap-2">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={isEn ? 'New folder name (e.g. Breaking Bad S01)...' : 'نام پوشه جدید (مثلاً فصل اول سریال)...'}
                className="flex-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition-all active:scale-95 shrink-0"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span>{isEn ? 'Add' : 'ایجاد پوشه'}</span>
              </button>
            </form>

            {/* Saved Folders List */}
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
              {folders.length === 0 ? (
                <div className="text-center py-8 px-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                  {isEn
                    ? 'No folders yet. Create your first folder above to organize batch subtitles.'
                    : 'هنوز پوشه‌ای ساخته نشده است. از کادر بالا اولین پوشه خود را ایجاد کنید.'}
                </div>
              ) : (
                folders.map((folder) => {
                  const isSelected = activeFolder?.id === folder.id;
                  const fStats = getFolderStats(folder);
                  const folderCompletedBatch = getCompletedBatchFiles(folder);
                  const isEditing = editingFolderId === folder.id;

                  return (
                    <div
                      key={folder.id}
                      onClick={() => !isEditing && onSelectFolder(folder.id)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer flex flex-col gap-2 ${
                        isSelected
                          ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-500 ring-2 ring-indigo-500/20 shadow-xs'
                          : 'bg-white dark:bg-slate-900/70 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className={`p-2 rounded-lg shrink-0 ${
                            fStats.isDone
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : isSelected
                                ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                          }`}>
                            {fStats.isDone ? (
                              <CheckCircle2 className="w-4 h-4" />
                            ) : isSelected ? (
                              <FolderOpen className="w-4 h-4" />
                            ) : (
                              <Folder className="w-4 h-4" />
                            )}
                          </div>

                          {isEditing ? (
                            <div className="flex items-center gap-1 flex-1" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="text"
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && editingName.trim()) {
                                    onRenameFolder(folder.id, editingName.trim());
                                    setEditingFolderId(null);
                                  } else if (e.key === 'Escape') {
                                    setEditingFolderId(null);
                                  }
                                }}
                                className="flex-1 bg-white dark:bg-slate-950 border border-indigo-400 rounded-lg px-2 py-1 text-xs text-slate-900 dark:text-white focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (editingName.trim()) {
                                    onRenameFolder(folder.id, editingName.trim());
                                  }
                                  setEditingFolderId(null);
                                }}
                                className="p-1 text-emerald-500 hover:bg-emerald-500/10 rounded"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingFolderId(null)}
                                className="p-1 text-slate-400 hover:bg-slate-500/10 rounded"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
                                {folder.name}
                              </div>
                              <div className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 flex-wrap">
                                <span>{fStats.fileCount} {isEn ? 'files' : 'فایل'}</span>
                                <span>•</span>
                                <span>{fStats.totalLines} {t.linesCount}</span>
                                {fStats.totalLines > 0 && (
                                  <>
                                    <span>•</span>
                                    <span className={`font-bold ${fStats.isDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                      {fStats.pct}%
                                    </span>
                                  </>
                                )}
                                {fStats.incompleteFileCount > 0 && (
                                  <>
                                    <span>•</span>
                                    <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                      {isEn
                                        ? `${fStats.incompleteFileCount} incomplete (${fStats.missingLines}l)`
                                        : `${fStats.incompleteFileCount} ناقص (${fStats.missingLines} خط)`}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {!isEditing && (
                          <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end" onClick={(e) => e.stopPropagation()}>
                            {onCompleteMissingFolder && fStats.incompleteFileCount > 0 && (
                              <button
                                type="button"
                                onClick={() => onCompleteMissingFolder(folder.id)}
                                disabled={isTranslating}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs disabled:opacity-40 transition-colors"
                                title={isEn ? 'Complete ONLY missing/English lines in this folder' : 'تکمیل فقط خطوط باقی‌مانده و انگلیسی این پوشه'}
                              >
                                <Wand2 className="w-3 h-3" />
                                <span>{isEn ? 'Complete' : 'تکمیل ترجمه'}</span>
                              </button>
                            )}
                            {onRetranslateFolder && (
                              <button
                                type="button"
                                onClick={() => onRetranslateFolder(folder.id)}
                                disabled={isTranslating || folder.files.length === 0}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/60 text-amber-700 dark:text-amber-300 border border-amber-300/70 dark:border-amber-800 disabled:opacity-40 transition-colors"
                                title={isEn ? 'Re-translate this folder (English -> Persian)' : 'ترجمه مجدد این پوشه (انگلیسی به فارسی)'}
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>{isEn ? 'Re-translate' : 'ترجمه مجدد'}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setEditingFolderId(folder.id);
                                setEditingName(folder.name);
                              }}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors"
                              title={isEn ? 'Rename folder' : 'تغییر نام پوشه'}
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteFolder(folder.id)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors"
                              title={isEn ? 'Delete folder' : 'حذف پوشه'}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Separate download row on folder card for recently completed files */}
                      {!isEditing && folderCompletedBatch.length > 0 && onBatchExportCompletedFiles && (
                        <div
                          className="flex items-center justify-between gap-2 pt-2 border-t border-emerald-500/25 text-[10px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="text-emerald-700 dark:text-emerald-300 font-bold truncate">
                            {isEn
                              ? `Completed batch (${folderCompletedBatch.length} files):`
                              : `دانلود فقط تکمیل‌شده‌ها (${folderCompletedBatch.length} فایل):`}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => onBatchExportCompletedFiles(folder.id, 'srt')}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-colors"
                            >
                              <Download className="w-2.5 h-2.5" />
                              <span>SRT</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onBatchExportCompletedFiles(folder.id, 'vtt')}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-teal-600 hover:bg-teal-500 text-white font-bold transition-colors"
                            >
                              <Download className="w-2.5 h-2.5" />
                              <span>VTT</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* RIGHT / END: Step 2 - Batch File Uploader into Selected Folder */}
          <div className="lg:col-span-7 flex flex-col gap-4 bg-slate-50/80 dark:bg-slate-950/50 p-4 rounded-2xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <Upload className="w-4 h-4 text-blue-500" />
                <span>
                  {activeFolder
                    ? isEn
                      ? `Step 2: Add Subtitle Files to "${activeFolder.name}"`
                      : `مرحله ۲: افزودن گروهی فایل به پوشه «${activeFolder.name}»`
                    : isEn
                      ? 'Step 2: Select or Create a Folder First'
                      : 'مرحله ۲: ابتدا یک پوشه ایجاد یا انتخاب کنید'}
                </span>
              </h3>

              <button
                type="button"
                onClick={onLoadSampleToFolder}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-blue-500/10 hover:bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/30 transition-colors"
              >
                <Sparkles className="w-3 h-3 text-blue-500" />
                <span>{t.loadSubtitleSample}</span>
              </button>
            </div>

            {/* Batch Drag & Drop Zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => void handleDropFiles(e)}
              onClick={() => multiFileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-2.5 ${
                isDragging
                  ? 'border-blue-500 bg-blue-500/10 scale-[1.01]'
                  : 'border-slate-300 dark:border-slate-700 hover:border-blue-500/60 bg-white/70 dark:bg-slate-900/50 hover:bg-blue-50/20 dark:hover:bg-blue-950/20'
              }`}
            >
              <input
                ref={multiFileInputRef}
                type="file"
                multiple
                accept=".srt,.vtt,.ass,.ssa,.sub,.txt"
                className="hidden"
                onChange={(e) => {
                  void handleFilesSelected(e.target.files);
                  e.target.value = '';
                }}
              />

              <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                <Upload className="w-6 h-6" />
              </div>

              <div>
                <p className="text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {isEn
                    ? 'Drag & drop multiple subtitle files here, or click to batch-select'
                    : 'چندین فایل زیرنویس را همزمان بکشید و رها کنید یا برای انتخاب گروهی کلیک کنید'}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  {isEn
                    ? 'Supports .SRT, .VTT, .ASS, .SSA, .SUB — exact original timestamps preserved 1:1'
                    : 'پشتیبانی از SRT, VTT, ASS, SSA, SUB — حفظ دقیق زمان‌بندی بدون جابه‌جایی'}
                </p>
              </div>
            </div>

            {/* Uploaded Files inside Active Folder */}
            {activeFolder && activeFolder.files.length > 0 && (
              <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                {activeFolder.files.map((file, idx) => {
                  const fStats = getFileStats(file);
                  return (
                    <div
                      key={file.id}
                      className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <span className="text-[10px] font-mono font-bold text-slate-400 w-5 text-center shrink-0">
                          {idx + 1}
                        </span>
                        {fStats.isDone ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                        ) : (
                          <FileText className="w-4 h-4 text-indigo-500 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate font-mono">
                            {file.fileName}
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400 flex-wrap">
                            <span className="uppercase font-mono font-bold text-indigo-600 dark:text-indigo-400">
                              .{file.sourceFormat}
                            </span>
                            <span>•</span>
                            <span>{formatBytes(file.fileSize)}</span>
                            <span>•</span>
                            <span>{fStats.total} {t.linesCount}</span>
                            {fStats.translated > 0 && (
                              <>
                                <span>•</span>
                                <span className={`font-bold ${fStats.isDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                  {fStats.translated}/{fStats.total} ({fStats.pct}%)
                                </span>
                              </>
                            )}
                            {!fStats.isDone && fStats.missingCount > 0 && fStats.translated > 0 && (
                              <>
                                <span>•</span>
                                <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                  {isEn ? `${fStats.missingCount} left` : `${fStats.missingCount} خط باقی‌مانده`}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {activeProvider === 'gemini' && savedGeminiKeys.length > 0 && onAssignFileKey && (
                          <select
                            value={file.assignedKeyId || ''}
                            onChange={(e) => onAssignFileKey(activeFolder.id, file.id, e.target.value || undefined)}
                            className="max-w-[130px] text-[10px] font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-slate-700 dark:text-slate-300 focus:outline-none"
                            title={isEn ? 'Assign key for this file' : 'انتخاب کلید برای این فایل'}
                          >
                            <option value="">{isEn ? 'Auto Key' : 'کلید خودکار'}</option>
                            {savedGeminiKeys.map((k) => (
                              <option key={k.id} value={k.id}>
                                {k.label}
                              </option>
                            ))}
                          </select>
                        )}

                        <button
                          type="button"
                          onClick={() => onRemoveFileFromFolder(activeFolder.id, file.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors shrink-0"
                          title={isEn ? 'Remove file' : 'حذف فایل'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Bottom CTA: Enter Default Translation Page */}
        <div className="mt-6 pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-slate-600 dark:text-slate-400">
            {activeFolder && activeStats && activeStats.fileCount > 0 ? (
              <span className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  {isEn
                    ? `Folder "${activeFolder.name}" is ready with ${activeStats.fileCount} file(s) and ${activeStats.totalLines} subtitle lines.`
                    : `پوشه «${activeFolder.name}» با ${activeStats.fileCount} فایل و ${activeStats.totalLines} خط زیرنویس آماده ورود به صفحه ترجمه است.`}
                </span>
              </span>
            ) : (
              <span>
                {isEn
                  ? 'Add at least one subtitle file to your folder to proceed to the translation page.'
                  : 'برای ورود به صفحه ترجمه، ابتدا یک پوشه بسازید و حداقل یک فایل زیرنویس اضافه کنید.'}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={onEnterTranslationView}
            disabled={!activeFolder || activeFolder.files.length === 0}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-bold text-xs sm:text-sm text-white bg-gradient-to-r from-indigo-600 via-blue-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 shadow-xl shadow-indigo-600/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
          >
            <span>{isEn ? 'Enter Default Translation Page' : 'ورود به صفحه ترجمه پیش‌فرض'}</span>
            {isEn ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
};

