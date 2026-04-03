#!/usr/bin/env node

const path = require('path');
const { runPreflightChecks } = require('./src/prereq');

function printHelp() {
  console.log('Bunny Stream Bulk Uploader');
  console.log('');
  console.log('Usage:');
  console.log('  node uploader.js                 Run normal upload mode (choose/create collection)');
  console.log('  node uploader.js --reset         Reset credentials and continue');
  console.log('  node uploader.js --retry-failed  Retry only failed uploads');
  console.log('  node uploader.js --view-logs     Show recent run and error logs');
  console.log('  node uploader.js --view-logs --lines=200  Show last N log lines');
  console.log('  node uploader.js --help          Show this help');
}

(async () => {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const preflight = await runPreflightChecks({
    cwd: process.cwd(),
    dependencies: ['axios', 'fs-extra', 'cli-progress', 'dotenv', 'inquirer', 'chalk', 'ora']
  });

  if (!preflight.ok) {
    process.exitCode = 1;
    return;
  }

  const { runCli } = require('./src/main');

  await runCli({
    args,
    cwd: process.cwd(),
    envPath: path.join(process.cwd(), '.env')
  });
})().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exitCode = 1;
});
