/** find-browser.ts: where an installed Chromium-based browser is looked for on each OS, and which one is run. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserCandidates, findBrowser } from '../src/find-browser.ts';

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
};

describe('browserCandidates', () => {
  it('on Windows looks under Program Files, Program Files (x86) and the local app data, Chrome first', () => {
    const c = browserCandidates('win32', WIN_ENV);
    expect(c.slice(0, 3)).toEqual(Object.values(WIN_ENV).map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    expect(c).toContain(join(WIN_ENV['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    expect(c).toContain(join(WIN_ENV.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    expect(c).toContain(join(WIN_ENV.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'));
    const order = ['chrome.exe', 'msedge.exe', 'brave.exe'].map((exe) => c.findIndex((p) => p.endsWith(exe)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('on Windows leaves out a root the environment does not name', () => {
    const c = browserCandidates('win32', { ProgramFiles: WIN_ENV.ProgramFiles });
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((p) => p.startsWith(WIN_ENV.ProgramFiles + '/') || p.startsWith(WIN_ENV.ProgramFiles + '\\'))).toBe(true);
  });

  it('on macOS looks in /Applications and the home Applications folder, Chrome first', () => {
    const c = browserCandidates('darwin', { HOME: '/Users/fixture' });
    expect(c.slice(0, 2)).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/fixture/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
    for (const app of ['Microsoft Edge', 'Brave Browser', 'Chromium']) expect(c).toContain(`/Applications/${app}.app/Contents/MacOS/${app}`);
  });

  it('on Linux looks for each browser on the PATH, then the snap', () => {
    const c = browserCandidates('linux', { PATH: '/usr/local/bin:/usr/bin' });
    expect(c[0]).toBe('/usr/local/bin/google-chrome-stable');
    expect(c.at(-1)).toBe('/snap/bin/chromium');
    expect(c.slice(0, -1).every((p) => p.startsWith('/usr/local/bin/') || p.startsWith('/usr/bin/'))).toBe(true);
    for (const name of ['chromium', 'microsoft-edge', 'brave-browser']) expect(c).toContain(`/usr/bin/${name}`);
    expect(browserCandidates('linux', {})).toEqual(['/snap/bin/chromium']);
  });
});

describe('findBrowser', () => {
  const ENV = { PATH: '/usr/bin' };

  it('runs the first candidate that exists', () => {
    const installed = new Set(['/usr/bin/brave-browser', '/usr/bin/chromium']);
    expect(findBrowser('', 'linux', ENV, (p) => installed.has(p))).toBe('/usr/bin/chromium');
    expect(findBrowser('', 'linux', ENV, (p) => p === '/snap/bin/chromium')).toBe('/snap/bin/chromium');
  });

  it('runs the configured browser when it exists, and none when it does not, whatever else is installed', () => {
    const installed = new Set(['/opt/fixture/chrome', '/usr/bin/chromium']);
    const exists = (p: string) => installed.has(p);
    expect(findBrowser('/opt/fixture/chrome', 'linux', ENV, exists)).toBe('/opt/fixture/chrome');
    expect(findBrowser('/opt/missing/chrome', 'linux', ENV, exists)).toBeNull();
  });

  it('finds none when nothing is installed', () => {
    expect(findBrowser('', 'darwin', { HOME: '/Users/fixture' }, () => false)).toBeNull();
  });
});
