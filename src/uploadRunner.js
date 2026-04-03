const path = require('path');
const cliProgress = require('cli-progress');
const { buildVideoTitle, sleep, bytesToHuman } = require('./utils');

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  const responseMessage =
    error.response && error.response.data
      ? typeof error.response.data === 'string'
        ? error.response.data
        : JSON.stringify(error.response.data)
      : '';

  return [error.message, responseMessage].filter(Boolean).join(' | ');
}

async function processOneFile({
  entry,
  displayName,
  client,
  collectionId,
  maxRetries,
  titleOptions,
  saveLog,
  appendError,
  appendRun,
  onSuccessfulUpload,
  fileBar,
  stopRequested
}) {
  const startedWithFailedStatus = entry.status === 'failed';
  let replacedVideoIdFromPreviousFailure = false;

  fileBar.update(0, {
    label: `${displayName} | 0 B/s`
  });

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (stopRequested()) {
      entry.status = 'pending';
      await saveLog();
      return { status: 'stopped' };
    }

    const startedAt = Date.now();
    const title = buildVideoTitle(entry.relativePath, titleOptions);

    try {
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.status = 'pending';
      entry.updatedAt = new Date().toISOString();
      await saveLog();

      await appendRun(
        `Uploading ${entry.relativePath} (${attempt}/${maxRetries})`
      );

      if (!entry.videoId) {
        entry.videoId = await client.createVideo(title, collectionId);
        entry.updatedAt = new Date().toISOString();
        await saveLog();
      }

      await client.uploadVideo({
        videoId: entry.videoId,
        filePath: entry.absolutePath,
        fileSize: entry.sizeBytes,
        onProgress: (uploaded, total) => {
          const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
          const speed = uploaded / elapsedSeconds;
          fileBar.update(uploaded, {
            label: `${displayName} | ${bytesToHuman(uploaded)}/${bytesToHuman(total)} | ${bytesToHuman(speed)}/s`
          });
        }
      });

      fileBar.update(entry.sizeBytes, {
        label: `${displayName} | done`
      });

      entry.status = 'success';
      entry.lastError = null;
      entry.updatedAt = new Date().toISOString();
      await saveLog();

      await onSuccessfulUpload(entry, title);
      await appendRun(`Upload succeeded for ${entry.relativePath} (videoId=${entry.videoId})`);
      return { status: 'success' };
    } catch (error) {
      const formatted = formatError(error);
      entry.status = 'failed';
      entry.lastError = formatted;
      entry.updatedAt = new Date().toISOString();
      await saveLog();

      await appendError(
        `Upload failed for ${entry.absolutePath} on attempt ${attempt}/${maxRetries}: ${formatted}`
      );
      await appendRun(
        `Upload failed for ${entry.relativePath} on attempt ${attempt}/${maxRetries}: ${formatted}`
      );

      const statusCode = Number((error && error.response && error.response.status) || 0);
      const apiRejectedCurrentVideoId = [400, 404, 409, 410, 422].includes(statusCode);
      const shouldRotateVideoId =
        Boolean(entry.videoId) &&
        attempt < maxRetries &&
        (apiRejectedCurrentVideoId || (startedWithFailedStatus && !replacedVideoIdFromPreviousFailure));

      if (shouldRotateVideoId) {
        const oldVideoId = entry.videoId;
        entry.videoId = null;
        entry.updatedAt = new Date().toISOString();
        replacedVideoIdFromPreviousFailure = true;
        await saveLog();
        await appendRun(
          `Retry strategy: switching to a new Bunny video entry for ${entry.relativePath} (old videoId=${oldVideoId}).`
        );
      }

      if (attempt >= maxRetries) {
        return { status: 'failed', error: formatted };
      }

      await appendRun(`Retrying ${entry.relativePath} after backoff...`);
      await sleep(1000 * attempt);
    }
  }

  return { status: 'failed', error: 'Unknown failure state' };
}

async function runUploads({
  targets,
  client,
  collectionId,
  concurrency,
  maxRetries,
  titleOptions,
  saveLog,
  appendError,
  appendRun,
  onSuccessfulUpload,
  stopRequested
}) {
  const safeAppendRun = typeof appendRun === 'function' ? appendRun : async () => {};
  const safeOnSuccessfulUpload =
    typeof onSuccessfulUpload === 'function' ? onSuccessfulUpload : async () => {};

  if (targets.length === 0) {
    return { completed: 0, success: 0, failed: 0, stopped: 0 };
  }

  const workerCount = Math.min(Math.max(1, concurrency), targets.length);
  let cursor = 0;
  let completed = 0;
  let success = 0;
  let failed = 0;
  let stopped = 0;

  const progress = new cliProgress.MultiBar(
    {
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
      format: '{bar} {percentage}% | ETA {eta_formatted}s | {label}'
    },
    cliProgress.Presets.shades_classic
  );

  const overallBar = progress.create(targets.length, 0, {
    label: 'Overall files'
  });

  async function worker() {
    while (true) {
      if (stopRequested()) {
        return;
      }

      const index = cursor;
      cursor += 1;

      if (index >= targets.length) {
        return;
      }

      const entry = targets[index];
      const labelName = path.basename(entry.absolutePath);
      const shortenedLabel = labelName.length > 28 ? `${labelName.slice(0, 25)}...` : labelName;
      const fileBar = progress.create(entry.sizeBytes || 1, 0, {
        label: `${shortenedLabel} | 0 B/s`
      });

      const result = await processOneFile({
        entry,
        displayName: shortenedLabel,
        client,
        collectionId,
        maxRetries,
        titleOptions,
        saveLog,
        appendError,
        appendRun: safeAppendRun,
        onSuccessfulUpload: safeOnSuccessfulUpload,
        fileBar,
        stopRequested
      });

      const speedLabel = result.status === 'success' ? 'done' : 'failed';
      fileBar.update(entry.sizeBytes || 1, {
        label: `${shortenedLabel} | ${speedLabel}`
      });
      fileBar.stop();

      completed += 1;
      if (result.status === 'success') {
        success += 1;
      } else if (result.status === 'stopped') {
        stopped += 1;
      } else {
        failed += 1;
      }

      overallBar.update(completed, {
        label: `Overall files (${completed}/${targets.length})`
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  overallBar.stop();
  progress.stop();

  return {
    completed,
    success,
    failed,
    stopped
  };
}

module.exports = {
  runUploads,
  formatError
};
