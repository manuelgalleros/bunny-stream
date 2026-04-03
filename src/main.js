const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');

const {
  scanVideoFiles,
  bytesToHuman,
  SUPPORTED_EXTENSIONS
} = require('./utils');
const {
  loadUploadLog,
  saveUploadLog,
  syncLogWithScan,
  getUploadTargets,
  getMissingEntries,
  summarizeLog
} = require('./logStore');
const {
  loadVideoDb,
  saveVideoDb,
  applyVideoDbToLog,
  upsertUploadedVideo
} = require('./videoDb');
const { viewLogs } = require('./logViewer');
const { BunnyStreamClient } = require('./bunnyClient');
const { runUploads } = require('./uploadRunner');

function parseArgs(args) {
  const linesArg = args.find((value) => value.startsWith('--lines='));
  const index = args.indexOf('--lines');
  const linesValue =
    (linesArg ? linesArg.split('=')[1] : null) ||
    (index >= 0 && args[index + 1] ? args[index + 1] : null);
  const parsedLines = Number(linesValue);

  return {
    reset: args.includes('--reset'),
    retryFailed: args.includes('--retry-failed'),
    viewLogs: args.includes('--view-logs'),
    logLines: Number.isFinite(parsedLines) && parsedLines > 0 ? Math.floor(parsedLines) : 100
  };
}

function envValue(value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

async function saveCredentials(envPath, apiKey, libraryId) {
  const content = [
    `BUNNY_API_KEY=${envValue(apiKey)}`,
    `BUNNY_LIBRARY_ID=${envValue(libraryId)}`
  ].join(os.EOL);

  await fs.outputFile(envPath, `${content}${os.EOL}`, { mode: 0o600 });
  dotenv.config({ path: envPath, override: true });
}

async function promptForCredentials(existing = {}) {
  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Enter Bunny Stream API Key:',
      default: existing.apiKey || '',
      mask: '*',
      validate: (value) => (value && String(value).trim() ? true : 'API key is required.')
    },
    {
      type: 'input',
      name: 'libraryId',
      message: 'Enter Bunny Stream Library ID:',
      default: existing.libraryId || '',
      validate: (value) => (value && String(value).trim() ? true : 'Library ID is required.')
    }
  ]);

  return {
    apiKey: String(answers.apiKey).trim(),
    libraryId: String(answers.libraryId).trim()
  };
}

async function ensureCredentials(envPath, reset) {
  const envExists = await fs.pathExists(envPath);

  if (reset && envExists) {
    await fs.remove(envPath);
    console.log(chalk.yellow('Credentials reset: existing .env removed.'));
  }

  dotenv.config({ path: envPath, override: true });

  let apiKey = process.env.BUNNY_API_KEY;
  let libraryId = process.env.BUNNY_LIBRARY_ID;

  if (!apiKey || !libraryId) {
    console.log(chalk.cyan('No credentials found. Starting first-run setup...'));
    const answers = await promptForCredentials();
    await saveCredentials(envPath, answers.apiKey, answers.libraryId);
    apiKey = answers.apiKey;
    libraryId = answers.libraryId;
    console.log(chalk.green('Credentials saved in .env.'));
  }

  return {
    apiKey,
    libraryId
  };
}

async function promptForDirectory(cwd) {
  while (true) {
    const { inputDir } = await inquirer.prompt([
      {
        type: 'input',
        name: 'inputDir',
        message: 'Enter the input folder path (Windows style supported):',
        default: cwd
      }
    ]);

    const cleaned = String(inputDir || '').trim().replace(/^"|"$/g, '');
    const resolved = path.resolve(cleaned);

    if (!(await fs.pathExists(resolved))) {
      console.log(chalk.red(`Folder does not exist: ${resolved}`));
      continue;
    }

    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      console.log(chalk.red(`Path is not a folder: ${resolved}`));
      continue;
    }

    const spinner = ora(`Scanning ${resolved} for supported video files...`).start();
    let scanned;

    try {
      scanned = await scanVideoFiles(resolved);
    } catch (error) {
      spinner.fail('Failed to scan folder.');
      console.log(chalk.red(error.message));
      continue;
    }

    spinner.stop();

    if (scanned.length === 0) {
      console.log(
        chalk.yellow(
          `No supported videos found. Supported formats: ${Array.from(SUPPORTED_EXTENSIONS).join(', ')}`
        )
      );
      continue;
    }

    return {
      directory: resolved,
      scannedFiles: scanned
    };
  }
}

async function promptUploadPreferences() {
  const { concurrency } = await inquirer.prompt([
    {
      type: 'list',
      name: 'concurrency',
      message: 'Concurrent uploads:',
      choices: [
        { name: '1 (safest)', value: 1 },
        { name: '2 (balanced)', value: 2 },
        { name: '3 (faster)', value: 3 }
      ],
      default: 2
    }
  ]);

  const { normalizeTitle } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'normalizeTitle',
      message: 'Normalize titles by replacing underscores/hyphens with spaces?',
      default: true
    }
  ]);

  const { titlePrefix } = await inquirer.prompt([
    {
      type: 'input',
      name: 'titlePrefix',
      message: 'Optional title prefix (leave blank for none):',
      default: ''
    }
  ]);

  return {
    concurrency,
    titleOptions: {
      normalizeTitle,
      titlePrefix: String(titlePrefix || '').trim()
    }
  };
}

async function appendErrorLog(errorLogPath, message) {
  const timestamp = new Date().toISOString();
  await fs.appendFile(errorLogPath, `[${timestamp}] ${message}${os.EOL}`, 'utf8');
}

async function appendRunLog(runLogPath, message) {
  const timestamp = new Date().toISOString();
  await fs.appendFile(runLogPath, `[${timestamp}] ${message}${os.EOL}`, 'utf8');
}

function printScanSummary(scannedFiles) {
  const totalBytes = scannedFiles.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  console.log(chalk.cyan(`Detected ${scannedFiles.length} video files.`));
  console.log(chalk.cyan(`Total size: ${bytesToHuman(totalBytes)}`));
}

function installGracefulShutdown({ onShutdown }) {
  let receivedSignal = false;

  process.on('SIGINT', async () => {
    if (receivedSignal) {
      console.log(chalk.red('Forced exit requested.'));
      process.exit(130);
      return;
    }

    receivedSignal = true;
    console.log(chalk.yellow('\nGraceful shutdown requested. Finishing in-flight uploads...'));

    try {
      await onShutdown();
    } catch {
      // Best effort save on Ctrl+C.
    }
  });

  return {
    stopRequested: () => receivedSignal
  };
}

function printRunSummary(stats, label) {
  console.log('');
  console.log(chalk.bold(`${label} summary:`));
  console.log(chalk.green(`  Success: ${stats.success}`));
  console.log(chalk.red(`  Failed: ${stats.failed}`));
  console.log(chalk.yellow(`  Stopped: ${stats.stopped}`));
  console.log(chalk.cyan(`  Completed: ${stats.completed}`));
}

async function promptForCollection(client, writeRunLog) {
  const spinner = ora('Loading Bunny Stream collections...').start();
  let collections = [];

  try {
    collections = await client.listCollections();
    spinner.succeed(`Loaded ${collections.length} collection(s).`);
  } catch (error) {
    spinner.fail('Could not load collections.');
    console.log(
      chalk.yellow(
        `Collection list unavailable: ${error.message}. You can still continue without a collection.`
      )
    );
    await writeRunLog(`Collection list failed: ${error.message}`);
  }

  while (true) {
    const choices = [
      {
        name: 'No collection (upload to library root)',
        value: '__none'
      },
      {
        name: 'Create a new collection (video library folder)',
        value: '__create'
      },
      {
        name: 'Enter collection ID manually',
        value: '__manual'
      }
    ];

    if (collections.length > 0) {
      choices.splice(
        1,
        0,
        ...collections.map((collection) => ({
          name: `${collection.name} (${collection.id})`,
          value: collection.id
        }))
      );
    }

    const { selection } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selection',
        message: 'Select target collection for this upload run:',
        choices,
        pageSize: 15
      }
    ]);

    if (selection === '__none') {
      await writeRunLog('Upload target collection: library root (none selected).');
      return {
        collectionId: null,
        collectionName: 'Library root'
      };
    }

    if (selection === '__manual') {
      const { manualCollectionId } = await inquirer.prompt([
        {
          type: 'input',
          name: 'manualCollectionId',
          message: 'Enter collection ID:',
          validate: (value) =>
            value && String(value).trim() ? true : 'Collection ID cannot be empty.'
        }
      ]);

      const id = String(manualCollectionId).trim();
      await writeRunLog(`Upload target collection set manually: ${id}`);
      return {
        collectionId: id,
        collectionName: `Manual ${id}`
      };
    }

    if (selection === '__create') {
      const { newCollectionName } = await inquirer.prompt([
        {
          type: 'input',
          name: 'newCollectionName',
          message: 'Enter new collection name:',
          validate: (value) =>
            value && String(value).trim() ? true : 'Collection name cannot be empty.'
        }
      ]);

      const createSpinner = ora('Creating new collection...').start();
      try {
        const created = await client.createCollection(String(newCollectionName).trim());
        createSpinner.succeed(`Created collection: ${created.name} (${created.id})`);
        await writeRunLog(`Created new collection ${created.name} (${created.id}).`);
        return {
          collectionId: created.id,
          collectionName: created.name
        };
      } catch (error) {
        createSpinner.fail(`Failed to create collection: ${error.message}`);
        await writeRunLog(`Create collection failed: ${error.message}`);
      }

      continue;
    }

    const matched = collections.find((collection) => collection.id === selection);
    const collectionName = matched ? matched.name : selection;
    await writeRunLog(`Selected existing collection ${collectionName} (${selection}).`);
    return {
      collectionId: selection,
      collectionName
    };
  }
}

async function runCli({ args, cwd, envPath }) {
  const flags = parseArgs(args);
  const mode = flags.retryFailed ? 'retry-failed' : 'normal';
  const uploadLogPath = path.join(cwd, 'upload-log.json');
  const videoDbPath = path.join(cwd, 'uploaded-videos-db.json');
  const runLogPath = path.join(cwd, 'run.log');
  const errorLogPath = path.join(cwd, 'error.log');

  if (flags.viewLogs) {
    await viewLogs({
      runLogPath,
      errorLogPath,
      maxLines: flags.logLines
    });
    return;
  }

  const writeRunLog = (message) => appendRunLog(runLogPath, message);
  const writeErrorLog = async (message) => {
    await appendErrorLog(errorLogPath, message);
    await appendRunLog(runLogPath, `ERROR: ${message}`);
  };

  await writeRunLog(`Uploader started in ${mode} mode.`);

  const credentials = await ensureCredentials(envPath, flags.reset);
  const client = new BunnyStreamClient({
    apiKey: credentials.apiKey,
    libraryId: credentials.libraryId
  });

  const targetCollection = await promptForCollection(client, writeRunLog);
  console.log(chalk.cyan(`Target collection: ${targetCollection.collectionName}`));

  const { directory, scannedFiles } = await promptForDirectory(cwd);
  printScanSummary(scannedFiles);
  await writeRunLog(`Scanned ${scannedFiles.length} files in ${directory}.`);

  const preferences = await promptUploadPreferences();
  await writeRunLog(`Concurrency selected: ${preferences.concurrency}`);

  const state = {
    logData: await loadUploadLog(uploadLogPath),
    videoDb: await loadVideoDb(videoDbPath)
  };

  state.logData = syncLogWithScan(state.logData, directory, scannedFiles);
  const adoptedFromDb = applyVideoDbToLog(state.logData, scannedFiles, state.videoDb);

  await saveUploadLog(uploadLogPath, state.logData);
  await saveVideoDb(videoDbPath, state.videoDb);

  if (adoptedFromDb.length > 0) {
    console.log(
      chalk.green(
        `Database check: ${adoptedFromDb.length} file(s) already uploaded previously and skipped.`
      )
    );
    await writeRunLog(`Skipped ${adoptedFromDb.length} files from uploaded-videos database.`);
  }

  const currentSummary = summarizeLog(state.logData, scannedFiles);
  console.log('');
  console.log(chalk.bold('Current upload state:'));
  console.log(chalk.green(`  Success: ${currentSummary.success}`));
  console.log(chalk.red(`  Failed: ${currentSummary.failed}`));
  console.log(chalk.yellow(`  Pending: ${currentSummary.pending}`));

  let targets = getUploadTargets(state.logData, scannedFiles, mode);

  if (targets.length === 0) {
    console.log(
      mode === 'retry-failed'
        ? chalk.yellow('No failed uploads found to retry.')
        : chalk.green('Nothing to upload. All detected files are already marked as success.')
    );
    console.log(chalk.green.bold('Upload indicator: all uploads are already finished.'));
    await writeRunLog('No upload targets found after status and database checks.');
    await writeRunLog('Upload indicator: all uploads already finished.');
    return;
  }

  console.log(chalk.cyan(`Preparing to upload ${targets.length} file(s) in ${mode} mode.`));
  await writeRunLog(`Prepared ${targets.length} upload targets.`);

  const shutdown = installGracefulShutdown({
    onShutdown: async () => {
      await saveUploadLog(uploadLogPath, state.logData);
      await saveVideoDb(videoDbPath, state.videoDb);
      await writeRunLog('Graceful shutdown persisted log and database state.');
    }
  });

  const saveLog = async () => {
    await saveUploadLog(uploadLogPath, state.logData);
  };

  const saveState = async () => {
    await saveUploadLog(uploadLogPath, state.logData);
    await saveVideoDb(videoDbPath, state.videoDb);
  };

  const runOnce = async (selection, label) => {
    await writeRunLog(`${label} started for ${selection.length} file(s).`);

    const stats = await runUploads({
      targets: selection,
      client,
      collectionId: targetCollection.collectionId,
      concurrency: preferences.concurrency,
      maxRetries: 3,
      titleOptions: preferences.titleOptions,
      saveLog,
      appendError: writeErrorLog,
      appendRun: writeRunLog,
      onSuccessfulUpload: async (entry, title) => {
        upsertUploadedVideo(state.videoDb, entry, {
          title,
          collectionId: targetCollection.collectionId
        });
        await saveVideoDb(videoDbPath, state.videoDb);
      },
      stopRequested: shutdown.stopRequested
    });

    printRunSummary(stats, label);
    await writeRunLog(
      `${label} completed: success=${stats.success}, failed=${stats.failed}, stopped=${stats.stopped}`
    );
    return stats;
  };

  await runOnce(targets, 'Primary run');

  await saveState();

  let retryRound = 0;
  while (!shutdown.stopRequested()) {
    const failedTargets = getUploadTargets(state.logData, scannedFiles, 'retry-failed');
    if (failedTargets.length === 0) {
      break;
    }

    const { retryFailedNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retryFailedNow',
        message: `Detected ${failedTargets.length} failed upload(s). Retry now?`,
        default: true
      }
    ]);

    if (!retryFailedNow) {
      await writeRunLog('User skipped immediate retry for failed uploads.');
      break;
    }

    retryRound += 1;
    await runOnce(failedTargets, `Manual failed retry ${retryRound}`);
    await saveState();
  }

  let missing = getMissingEntries(state.logData, scannedFiles);

  if (missing.length > 0 && !shutdown.stopRequested()) {
    console.log(chalk.yellow(`Integrity check: ${missing.length} file(s) are still not successful.`));
    missing.slice(0, 20).forEach((entry) => {
      console.log(chalk.yellow(`  - ${entry.relativePath}`));
    });
    if (missing.length > 20) {
      console.log(chalk.yellow(`  ...and ${missing.length - 20} more.`));
    }

    const { retryMissing } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retryMissing',
        message: 'Retry only missing/failed files now?',
        default: true
      }
    ]);

    if (retryMissing) {
      targets = getUploadTargets(state.logData, scannedFiles, 'normal');
      await runOnce(targets, 'Integrity retry');
      await saveState();
      missing = getMissingEntries(state.logData, scannedFiles);
    }
  }

  const finalSummary = summarizeLog(state.logData, scannedFiles);
  console.log('');
  console.log(chalk.bold('Final status:'));
  console.log(chalk.green(`  Success: ${finalSummary.success}/${finalSummary.total}`));
  console.log(chalk.red(`  Failed: ${finalSummary.failed}`));
  console.log(chalk.yellow(`  Pending: ${finalSummary.pending}`));
  console.log(chalk.cyan(`  Target collection: ${targetCollection.collectionName}`));
  console.log(chalk.cyan(`  Video database: ${videoDbPath}`));
  console.log(chalk.cyan(`  Log file: ${uploadLogPath}`));
  console.log(chalk.cyan(`  Run log: ${runLogPath}`));
  console.log(chalk.cyan(`  Error log: ${errorLogPath}`));

  if (finalSummary.pending === 0 && finalSummary.failed === 0) {
    console.log(chalk.green.bold('Upload indicator: all uploads have finished successfully.'));
    await writeRunLog('Upload indicator: all uploads finished successfully.');
  } else if (finalSummary.pending === 0) {
    console.log(chalk.yellow.bold('Upload indicator: all uploads have finished, but some failed.'));
    await writeRunLog('Upload indicator: all uploads finished with failures.');
  } else {
    console.log(chalk.red.bold('Upload indicator: upload run ended with pending files.'));
    await writeRunLog('Upload indicator: upload run ended with pending files.');
  }

  await writeRunLog(
    `Final summary: success=${finalSummary.success}, failed=${finalSummary.failed}, pending=${finalSummary.pending}`
  );

  if (shutdown.stopRequested()) {
    console.log(chalk.yellow('Exited after graceful shutdown request. Resume with: node uploader.js'));
    process.exitCode = 130;
  }
}

module.exports = {
  runCli
};
