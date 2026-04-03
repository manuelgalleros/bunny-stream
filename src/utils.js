const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

function toFileKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function toRelativePath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath);
}

function isVideoFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function buildFileFingerprint({ absolutePath, sizeBytes, mtimeMs }) {
  const input = [
    path.basename(absolutePath).toLowerCase(),
    Number(sizeBytes || 0),
    Math.round(Number(mtimeMs || 0))
  ].join('|');

  return crypto.createHash('sha1').update(input).digest('hex');
}

async function scanVideoFiles(rootDir) {
  const results = [];
  const uniqueKeys = new Set();

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile() || !isVideoFile(absolutePath)) {
        continue;
      }

      const key = toFileKey(absolutePath);
      if (uniqueKeys.has(key)) {
        continue;
      }

      uniqueKeys.add(key);
      const stat = await fs.stat(absolutePath);

      results.push({
        key,
        absolutePath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        fingerprint: buildFileFingerprint({
          absolutePath,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs
        })
      });
    }
  }

  await walk(rootDir);
  results.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
  return results;
}

function bytesToHuman(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 2)} ${units[index]}`;
}

function sanitizeTitle(rawTitle) {
  return String(rawTitle)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildVideoTitle(relativePath, options) {
  const fileName = path.basename(relativePath, path.extname(relativePath));
  const baseTitle = options.normalizeTitle ? sanitizeTitle(fileName) : fileName;
  const prefix = options.titlePrefix ? `${options.titlePrefix} ` : '';
  return `${prefix}${baseTitle}`.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  toFileKey,
  toRelativePath,
  buildFileFingerprint,
  scanVideoFiles,
  bytesToHuman,
  buildVideoTitle,
  sleep
};
