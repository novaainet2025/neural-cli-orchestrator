const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

function getStableVersion(versions) {
  const stableVersions = versions.filter(v => !v.includes('-'));
  return stableVersions.length > 0 ? stableVersions[0] : versions[0];
}

function resolvePlaywright() {
  const playWrightModule = process.env.PLAYWRIGHT_MODULE;
  if (playWrightModule && fs.existsSync(path.join(playWrightModule, 'package.json')) {
    return playWrightModule;
  }

  const rootPlaywright = path.join(process.cwd(), 'node_modules', 'playwright');
  if (fs.existsSync(rootPlaywright)) {
    return rootPlaywright;
  }

  try {
    const npxDir = execSync(`find ~/.npm/_npx -name 'node_modules/playwright' -maxdepth 3 | head -n 1`).toString().trim();
    if (npxDir && fs.existsSync(npxDir)) {
      return npxDir;
    }
  } catch (e) {}

  throw new Error(
    'Playwright module not found. Please run `npm ci` or set PLAYWRIGHT_MODULE environment variable.'
  );
}

module.exports = {
  resolvePlaywright
};