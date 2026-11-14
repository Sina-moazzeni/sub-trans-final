import { SubtitleFolder, SubtitleFolderFile, SubtitleFormat, SubtitleItem } from '../types';

export interface SubtitlesBackupPayload {
  app: 'SubGameLab';
  version: number;
  exportedAt: string;
  activeFolderId: string | null;
  activeFileId: string | null;
  folders: SubtitleFolder[];
}

export function createSubtitlesBackupBlob(
  folders: SubtitleFolder[],
  activeFolderId: string | null,
  activeFileId: string | null
): Blob {
  const payload: SubtitlesBackupPayload = {
    app: 'SubGameLab',
    version: 2,
    exportedAt: new Date().toISOString(),
    activeFolderId,
    activeFileId,
    folders,
  };
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
}

function sanitizeSubtitleItem(raw: any, fallbackIndex: number): SubtitleItem {
  const id = typeof raw?.id === 'number' && !isNaN(raw.id) ? raw.id : fallbackIndex + 1;
  return {
    id,
    startTime: typeof raw?.startTime === 'string' ? raw.startTime : '00:00:00,000',
    endTime: typeof raw?.endTime === 'string' ? raw.endTime : '00:00:05,000',
    startSeconds: typeof raw?.startSeconds === 'number' && !isNaN(raw.startSeconds) ? raw.startSeconds : 0,
    endSeconds: typeof raw?.endSeconds === 'number' && !isNaN(raw.endSeconds) ? raw.endSeconds : 5,
    originalText: typeof raw?.originalText === 'string' ? raw.originalText : String(raw?.originalText ?? ''),
    translatedText: typeof raw?.translatedText === 'string' ? raw.translatedText : String(raw?.translatedText ?? ''),
    styleTags: typeof raw?.styleTags === 'string' ? raw.styleTags : undefined,
    cueId: typeof raw?.cueId === 'string' ? raw.cueId : undefined,
    sourceModified: Boolean(raw?.sourceModified),
    gameKey: typeof raw?.gameKey === 'string' ? raw.gameKey : undefined,
    context: typeof raw?.context === 'string' ? raw.context : undefined,
    variables: Array.isArray(raw?.variables) ? raw.variables : undefined,
    rawRowData: raw?.rawRowData && typeof raw.rawRowData === 'object' ? raw.rawRowData : undefined,
  };
}

function sanitizeFolderFile(raw: any, idx: number): SubtitleFolderFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: SubtitleItem[] = rawItems.map((it: any, i: number) => sanitizeSubtitleItem(it, i));
  const validFormats = new Set<SubtitleFormat>(['srt', 'vtt', 'ass', 'ssa', 'sub']);
  const format: SubtitleFormat = validFormats.has(raw.sourceFormat) ? raw.sourceFormat : 'srt';
  const allDone = items.length > 0 && items.every((it) => it.translatedText && it.translatedText.trim().length > 0);

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `file_${Date.now().toString(36)}_${idx}`,
    fileName: typeof raw.fileName === 'string' && raw.fileName.trim() ? raw.fileName.trim() : `Subtitle_${idx + 1}.${format}`,
    fileSize: typeof raw.fileSize === 'number' ? raw.fileSize : 0,
    sourceFormat: format,
    rawHeader: typeof raw.rawHeader === 'string' ? raw.rawHeader : undefined,
    detectedEncoding: typeof raw.detectedEncoding === 'string' ? raw.detectedEncoding : 'UTF-8',
    subFps: typeof raw.subFps === 'number' ? raw.subFps : 25,
    items,
    status: allDone ? 'done' : 'pending',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    assignedKeyId: typeof raw.assignedKeyId === 'string' ? raw.assignedKeyId : undefined,
  };
}

export function parseAndValidateBackupJson(rawText: string): {
  folders: SubtitleFolder[];
  activeFolderId: string | null;
  activeFileId: string | null;
  totalFiles: number;
  totalLines: number;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('فایل بکاپ JSON نامعتبر است و قابل تجزیه نیست.');
  }

  const rawFolders = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.folders)
      ? parsed.folders
      : null;

  if (!rawFolders) {
    throw new Error('ساختار فایل پشتیبان معتبر نیست (لیست پوشه‌ها یافت نشد).');
  }

  const folders: SubtitleFolder[] = [];
  let totalFiles = 0;
  let totalLines = 0;

  rawFolders.forEach((rf: any, fIdx: number) => {
    if (!rf || typeof rf !== 'object') return;
    const rawFiles = Array.isArray(rf.files) ? rf.files : [];
    const files: SubtitleFolderFile[] = [];
    rawFiles.forEach((rfile: any, fileIdx: number) => {
      const cleanFile = sanitizeFolderFile(rfile, fileIdx);
      if (cleanFile) {
        files.push(cleanFile);
        totalFiles++;
        totalLines += cleanFile.items.length;
      }
    });

    folders.push({
      id: typeof rf.id === 'string' && rf.id.trim() ? rf.id.trim() : `fld_${Date.now().toString(36)}_${fIdx}`,
      name: typeof rf.name === 'string' && rf.name.trim() ? rf.name.trim() : `پوشه بازیابی شده ${fIdx + 1}`,
      createdAt: typeof rf.createdAt === 'number' ? rf.createdAt : Date.now(),
      updatedAt: typeof rf.updatedAt === 'number' ? rf.updatedAt : Date.now(),
      files,
    });
  });

  if (folders.length === 0) {
    throw new Error('هیچ پوشه یا زیرنویسی در فایل پشتیبان یافت نشد.');
  }

  return {
    folders,
    activeFolderId: typeof parsed?.activeFolderId === 'string' ? parsed.activeFolderId : folders[0]?.id || null,
    activeFileId: typeof parsed?.activeFileId === 'string' ? parsed.activeFileId : folders[0]?.files[0]?.id || null,
    totalFiles,
    totalLines,
  };
}
