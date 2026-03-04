import fs from 'fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
  '/usr/bin/google-chrome-stable',  // Linux (google-chrome)
  '/usr/bin/google-chrome',         // Linux (alt)
  '/usr/bin/chromium-browser',      // Linux (chromium)
  '/usr/bin/chromium',              // Linux (snap/alt)
];

export function findChromeExecutable(): string | undefined {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

export const PUPPETEER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];
