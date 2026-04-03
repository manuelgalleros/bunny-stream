const fs = require('fs/promises');
const path = require('path');
const https = require('https');

function getNodeMajorVersion() {
  const major = Number(String(process.versions.node || '0').split('.')[0]);
  return Number.isFinite(major) ? major : 0;
}

function checkNodeVersion() {
  const major = getNodeMajorVersion();
  if (major < 18) {
    return {
      ok: false,
      message: `Node.js ${process.versions.node} detected. Node.js >= 18 is required.`,
      fixes: [
        'Install a newer Node.js version from https://nodejs.org/',
        'Verify with: node -v'
      ]
    };
  }

  return { ok: true };
}

function checkDependencies(dependencies) {
  const missing = [];

  for (const dep of dependencies) {
    try {
      require.resolve(dep, { paths: [process.cwd()] });
    } catch {
      missing.push(dep);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      message: `Missing dependencies: ${missing.join(', ')}`,
      fixes: [
        'Install required packages with:',
        `npm install ${dependencies.join(' ')}`
      ]
    };
  }

  return { ok: true };
}

function checkInternetConnectivity() {
  return new Promise((resolve) => {
    const request = https.request(
      {
        method: 'GET',
        hostname: 'video.bunnycdn.com',
        path: '/',
        timeout: 7000
      },
      (response) => {
        response.resume();
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 500 });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Connection timed out.'));
    });

    request.on('error', (error) => {
      resolve({
        ok: false,
        message: `Unable to reach Bunny API host: ${error.message}`,
        fixes: [
          'Check your internet connection',
          'Verify firewall/proxy settings for video.bunnycdn.com'
        ]
      });
    });

    request.end();
  });
}

async function checkWritePermission(cwd) {
  const testFile = path.join(cwd, `.write-test-${Date.now()}.tmp`);

  try {
    await fs.writeFile(testFile, 'write-check');
    await fs.unlink(testFile);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `No write permission in current directory: ${cwd}`,
      fixes: [
        'Run terminal with proper permissions',
        'Choose a writable directory',
        `Original error: ${error.message}`
      ]
    };
  }
}

function printFailureReport(issues) {
  console.error('\nPre-requisite checks failed:\n');

  issues.forEach((issue, index) => {
    console.error(`${index + 1}. ${issue.message}`);
    if (issue.fixes && issue.fixes.length > 0) {
      for (const fix of issue.fixes) {
        console.error(`   - ${fix}`);
      }
    }
    console.error('');
  });
}

async function runPreflightChecks({ cwd, dependencies }) {
  const checks = [];

  checks.push(checkNodeVersion());
  checks.push(checkDependencies(dependencies));
  checks.push(await checkInternetConnectivity());
  checks.push(await checkWritePermission(cwd));

  const issues = checks.filter((check) => !check.ok);

  if (issues.length > 0) {
    printFailureReport(issues);
    return { ok: false, issues };
  }

  console.log('All pre-requisite checks passed.');
  return { ok: true };
}

module.exports = {
  runPreflightChecks
};
