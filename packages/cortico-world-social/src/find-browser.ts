/**
 * Finds an installed Chromium-based browser (Chrome, Edge, Brave, Chromium) to drive. The World runs
 * it with its own profile, so the person's everyday browser profile is never touched.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Candidate executables for `platform`, most preferred first. */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const under = (...rel: string[]) => roots.map((r) => join(r, ...rel));
    return [
      ...under('Google', 'Chrome', 'Application', 'chrome.exe'),
      ...under('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...under('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ...under('Chromium', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', join(env.HOME ?? homedir(), 'Applications')];
    const bundles: Array<[string, string]> = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Brave Browser.app', 'Brave Browser'],
      ['Chromium.app', 'Chromium'],
    ];
    return bundles.flatMap(([app, bin]) => apps.map((dir) => join(dir, app, 'Contents', 'MacOS', bin)));
  }
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge', 'brave-browser'];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return [...names.flatMap((n) => dirs.map((d) => join(d, n))), '/snap/bin/chromium'];
}

/** The configured executable, null when it does not exist; with none configured, the first candidate that exists. */
export function findBrowser(configured: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (configured) return exists(configured) ? configured : null;
  return browserCandidates(platform, env).find((p) => exists(p)) ?? null;
}
