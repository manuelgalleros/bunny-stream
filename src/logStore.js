const path = require('path');
const fs = require('fs-extra');
const { toRelativePath } = require('./utils');

function createEmptyLog() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    rootDir: '',
    files: {}
  };
}

async function loadUploadLog(logPath) {
  const exists = await fs.pathExists(logPath);
  if (!exists) {
    return createEmptyLog();
  }

  try {
    const data = await fs.readJson(logPath);
    if (!data || typeof data !== 'object') {
      return createEmptyLog();
    }

    return {
      ...createEmptyLog(),
      ...data,
      files: data.files && typeof data.files === 'object' ? data.files : {}
    };
  } catch {
    // Keep malformed logs from blocking uploads by starting with a safe structure.
    return createEmptyLog();
  }
}

async function saveUploadLog(logPath, logData) {
  const now = new Date().toISOString();
  logData.updatedAt = now;

  const tmpPath = `${logPath}.tmp`;
  await fs.outputFile(tmpPath, `${JSON.stringify(logData, null, 2)}\n`, 'utf8');
  await fs.move(tmpPath, logPath, { overwrite: true });
}

function syncLogWithScan(logData, rootDir, scannedFiles) {
  const now = new Date().toISOString();
  logData.rootDir = rootDir;

  for (const scanned of scannedFiles) {
    const current = logData.files[scanned.key];
    const relativePath = toRelativePath(rootDir, scanned.absolutePath);

    if (!current) {
      logData.files[scanned.key] = {
        key: scanned.key,
        absolutePath: scanned.absolutePath,
        relativePath,
        sizeBytes: scanned.sizeBytes,
        mtimeMs: scanned.mtimeMs,
        fingerprint: scanned.fingerprint,
        status: 'pending',
        videoId: null,
        attempts: 0,
        lastError: null,
        updatedAt: now
      };
      continue;
    }

    const changed =
      current.sizeBytes !== scanned.sizeBytes ||
      Number(current.mtimeMs || 0) !== scanned.mtimeMs ||
      current.fingerprint !== scanned.fingerprint;

    current.absolutePath = scanned.absolutePath;
    current.relativePath = relativePath;
    current.sizeBytes = scanned.sizeBytes;
    current.mtimeMs = scanned.mtimeMs;
    current.fingerprint = scanned.fingerprint;

    if (changed && current.status === 'success') {
      current.status = 'pending';
      current.videoId = null;
    }

    current.updatedAt = now;
  }

  return logData;
}

function getLogEntriesForScannedFiles(logData, scannedFiles) {
  const entries = [];
  for (const scanned of scannedFiles) {
    const entry = logData.files[scanned.key];
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function getUploadTargets(logData, scannedFiles, mode) {
  const scannedEntries = getLogEntriesForScannedFiles(logData, scannedFiles);

  if (mode === 'retry-failed') {
    return scannedEntries.filter((entry) => entry.status === 'failed');
  }

  return scannedEntries.filter((entry) => entry.status !== 'success');
}

function getMissingEntries(logData, scannedFiles) {
  const missing = [];

  for (const scanned of scannedFiles) {
    const entry = logData.files[scanned.key];
    if (!entry || entry.status !== 'success') {
      missing.push(entry || {
        key: scanned.key,
        absolutePath: scanned.absolutePath,
        relativePath: toRelativePath(logData.rootDir, scanned.absolutePath),
        sizeBytes: scanned.sizeBytes,
        status: 'pending'
      });
    }
  }

  return missing;
}

function summarizeLog(logData, scannedFiles) {
  const scannedEntries = getLogEntriesForScannedFiles(logData, scannedFiles);
  let success = 0;
  let failed = 0;
  let pending = 0;

  for (const entry of scannedEntries) {
    if (entry.status === 'success') {
      success += 1;
    } else if (entry.status === 'failed') {
      failed += 1;
    } else {
      pending += 1;
    }
  }

  return {
    total: scannedEntries.length,
    success,
    failed,
    pending
  };
}

module.exports = {
  loadUploadLog,
  saveUploadLog,
  syncLogWithScan,
  getUploadTargets,
  getMissingEntries,
  summarizeLog
};
