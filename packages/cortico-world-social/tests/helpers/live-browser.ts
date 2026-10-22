/**
 * A real `SocialBrowser` for the browser suites. Every request the browser makes is answered by
 * `router` from fixtures and aborted when the router has no answer, so the suites never reach the
 * network. Playwright's `context.request`, which `PageSession.fetchRaw` uses for images and
 * subtitle files, does not pass through the routes, so those files are served on 127.0.0.1 by a
 * `FixtureServer`; the routes answer a page's own requests for them from the same files, since
 * Chromium holds a public page's requests to the local network for a permission nobody grants.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Request, Route } from 'playwright-core';
import { SocialBrowser } from '../../src/browser.ts';
import { findBrowser } from '../../src/find-browser.ts';

/** Executable paths inside a Playwright `chromium-<rev>` directory, per OS. */
const PLAYWRIGHT_CHROMIUM = [
  ['chrome-linux', 'chrome'],
  ['chrome-linux64', 'chrome'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-win', 'chrome.exe'],
  ['chrome-win64', 'chrome.exe'],
];

/** An installed Chromium-based browser, else the first Chromium under `PLAYWRIGHT_BROWSERS_PATH`; null when there is neither. */
export function findTestBrowser(): string | null {
  const installed = findBrowser('');
  if (installed) return installed;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort()) {
    for (const rel of PLAYWRIGHT_CHROMIUM) {
      const exe = join(root, dir, ...rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

export interface Fixture {
  body: string | Buffer;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Router = (url: URL, request: Request) => Fixture | null | undefined;

export const html = (body: string, status = 200): Fixture => ({ body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`, status, contentType: 'text/html; charset=utf-8' });
export const jsonFixture = (value: unknown, headers: Record<string, string> = {}): Fixture => ({ body: JSON.stringify(value), contentType: 'application/json; charset=utf-8', headers });
export const redirect = (location: string): Fixture => ({ body: '', status: 302, headers: { location } });
/** `value` as a page script assignment, the way platforms embed their page data. */
export const pageData = (name: string, value: unknown): string => `<script>var ${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};</script>`;

export class FixtureBrowser extends SocialBrowser {
  router: Router = () => null;
  /** URLs the browser requested, routed or not. */
  readonly seen: string[] = [];

  constructor(executable: string, profileDir: string, private readonly server?: FixtureServer) {
    super({
      profileDir,
      executable: () => executable,
      showWindow: () => false,
      warn: () => {},
      // fixture images are served from 127.0.0.1
      rawAllowed: () => true,
      onLaunch: async (context) => {
        await context.route('**/*', (route) => this.serve(route));
      },
    });
  }

  private async serve(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    this.seen.push(url.href);
    const fixture = url.hostname === '127.0.0.1' ? this.server?.fixture(url) : this.router(url, request);
    if (!fixture) return route.abort('blockedbyclient');
    await route.fulfill({ status: fixture.status ?? 200, contentType: fixture.contentType, headers: fixture.headers, body: fixture.body });
  }

  /** Worlds close their browser when they stop; this one stays open for the suite until `shutdown`. */
  override async close(): Promise<void> {}

  async shutdown(): Promise<void> {
    await super.close();
  }
}

/** Serves files from memory on 127.0.0.1, keeping each request's path and query and counting the requests for each path. */
export class FixtureServer {
  readonly files = new Map<string, { body: Buffer | string; mime: string; location?: string }>();
  readonly hits = new Map<string, number>();
  readonly requested: string[] = [];

  private constructor(private readonly server: Server) {}

  static async start(): Promise<FixtureServer> {
    const server = createServer();
    const fs = new FixtureServer(server);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      fs.requested.push(path + url.search);
      fs.hits.set(path, (fs.hits.get(path) ?? 0) + 1);
      const file = fs.files.get(path);
      if (!file) { res.statusCode = 404; res.end(); return; }
      if (file.location) { res.statusCode = 302; res.setHeader('location', file.location); res.end(); return; }
      res.setHeader('content-type', file.mime);
      res.setHeader('access-control-allow-origin', '*');
      res.end(file.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return fs;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The file at `url` as a route answer, kept and counted as a request. */
  fixture(url: URL): Fixture | null {
    const file = this.files.get(url.pathname);
    this.requested.push(url.pathname + url.search);
    this.hits.set(url.pathname, (this.hits.get(url.pathname) ?? 0) + 1);
    return file ? { body: file.body, contentType: file.mime } : null;
  }

  /** Serves `body` at `path`; returns its URL. */
  put(path: string, body: Buffer | string, mime: string): string {
    this.files.set(path, { body, mime });
    return this.origin + path;
  }

  /** Redirects `path` to `location`; returns its URL. */
  putRedirect(path: string, location: string): string {
    this.files.set(path, { body: '', mime: '', location });
    return this.origin + path;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
};

/** A PNG of one colour, `width` by `height` pixels. */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [200, 120, 60]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
