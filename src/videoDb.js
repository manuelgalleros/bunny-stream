const fs = require('fs-extra');

function createEmptyVideoDb() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    videos: {}
  };
}

async function loadVideoDb(dbPath) {
  const exists = await fs.pathExists(dbPath);
  if (!exists) {
    return createEmptyVideoDb();
  }

  try {
    const data = await fs.readJson(dbPath);
    if (!data || typeof data !== 'object') {
      return createEmptyVideoDb();
    }

    return {
      ...createEmptyVideoDb(),
      ...data,
      videos: data.videos && typeof data.videos === 'object' ? data.videos : {}
    };
  } catch {
    return createEmptyVideoDb();
  }
}

async function saveVideoDb(dbPath, dbData) {
  dbData.updatedAt = new Date().toISOString();
  const tmpPath = `${dbPath}.tmp`;
  await fs.outputFile(tmpPath, `${JSON.stringify(dbData, null, 2)}\n`, 'utf8');
  await fs.move(tmpPath, dbPath, { overwrite: true });
}

function applyVideoDbToLog(logData, scannedFiles, dbData) {
  const adopted = [];

  for (const scanned of scannedFiles) {
    const logEntry = logData.files[scanned.key];
    if (!logEntry) {
      continue;
    }

    const known = dbData.videos[scanned.fingerprint];
    if (!known) {
      continue;
    }

    // If we already uploaded identical content before, mark as success and reuse the video ID.
    if (logEntry.status !== 'success') {
      logEntry.status = 'success';
      logEntry.videoId = known.videoId;
      logEntry.lastError = null;
      logEntry.updatedAt = new Date().toISOString();
      adopted.push(logEntry);
    }
  }

  return adopted;
}

function upsertUploadedVideo(dbData, entry, options = {}) {
  if (!entry || !entry.fingerprint || !entry.videoId) {
    return;
  }

  const now = new Date().toISOString();
  const existing = dbData.videos[entry.fingerprint];

  dbData.videos[entry.fingerprint] = {
    fingerprint: entry.fingerprint,
    videoId: entry.videoId,
    title: options.title || '',
    collectionId: options.collectionId || null,
    sourceFile: entry.absolutePath,
    relativePath: entry.relativePath,
    sizeBytes: entry.sizeBytes,
    mtimeMs: entry.mtimeMs,
    firstUploadedAt: existing ? existing.firstUploadedAt : now,
    lastSeenAt: now
  };
}

module.exports = {
  loadVideoDb,
  saveVideoDb,
  applyVideoDbToLog,
  upsertUploadedVideo
};
