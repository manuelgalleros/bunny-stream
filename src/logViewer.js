const fs = require('fs-extra');
const chalk = require('chalk');

function tailLines(content, maxLines) {
  const lines = String(content || '').split(/\r?\n/).filter((line) => line.length > 0);
  if (maxLines <= 0) {
    return lines;
  }
  return lines.slice(-maxLines);
}

async function printLogFile(filePath, title, maxLines) {
  const exists = await fs.pathExists(filePath);
  console.log('');
  console.log(chalk.bold(title));
  console.log(chalk.cyan(`Path: ${filePath}`));

  if (!exists) {
    console.log(chalk.yellow('No log file found yet.'));
    return;
  }

  const content = await fs.readFile(filePath, 'utf8');
  const lines = tailLines(content, maxLines);

  if (lines.length === 0) {
    console.log(chalk.yellow('Log file exists but has no entries.'));
    return;
  }

  lines.forEach((line) => {
    console.log(line);
  });
}

async function viewLogs({ runLogPath, errorLogPath, maxLines }) {
  await printLogFile(runLogPath, 'Run Log', maxLines);
  await printLogFile(errorLogPath, 'Error Log', maxLines);
  console.log('');
  console.log(chalk.green('Tip: run with --retry-failed to retry only failed uploads.'));
}

module.exports = {
  viewLogs
};
