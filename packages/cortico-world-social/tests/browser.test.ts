/**
 * SocialBrowser and its pages in a real Chromium: the read's time and interruption bound every page
 * operation, resources come from the browser outside the page, logins are read from the profile's
 * cookies, and the browser closes itself once no page is open. Skipped when no Chromium-based
 * browser is installed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_ACCEPT, Interrupted, SocialBrowser, TimeUp, publicHttps, type PageLimits } from '../src/browser.ts';
import { Deadline } from '../src/collect.ts';
import { FixtureBrowser, FixtureServer, findTestBrowser, html, solidPng } from './helpers/live-browser.ts';

const EXE = findTestBrowser();
const ORIGIN = 'https://fixture.test';
const ample: PageLimits = { timeLeft: () => 30_000 };
const within = (deadline: Deadline, signal?: AbortSignal): PageLimits => ({ signal, timeLeft: () => deadline.leftMs });

describe('publicHttps', () => {
  it('allows https on a public host name only', () => {
    for (const ok of ['https://i.redd.it/a.png', 'https://pbs.twimg.com/media/a.jpg', 'https://i0.hdslb.com/bfs/a.webp']) expect(publicHttps(new URL(ok)), ok).toBe(true);
    for (const no of [
      'http://i.redd.it/a.png', 'https://127.0.0.1/a.png', 'https://192.168.1.1/reboot?x=.png', 'https://[::1]/a.png', 'https://localhost/a.png',
      'https://printer.local/a.png', 'https://router.lan/a.png', 'https://nas.home.arpa/a.png', 'https://intranet/a.png', 'file:///etc/passwd',
    ]) expect(publicHttps(new URL(no)), no).toBe(false);
  });
});

describe.skipIf(!EXE)('SocialBrowser', () => {
  let browser: FixtureBrowser;
  let server: FixtureServer;
  let dir: string;
  const cleanup: Array<() => unknown> = [];

  beforeAll(async () => {
    server = await FixtureServer.start();
    dir = mkdtempSync(join(tmpdir(), 'social-browser-'));
    browser = new FixtureBrowser(EXE!, join(dir, 'profile'), server);
  });

  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  afterAll(async () => {
    await browser?.shutdown();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A browser of its own, which closes itself after `idleMs`; counts its launches and closes. Its
   * fixture pages answer at once, except `/slow`, which never answers.
   */
  function ownBrowser(idleMs?: number) {
    const counts = { launches: 0, closes: 0, context: null as BrowserContext | null };
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const b = new SocialBrowser({
      profileDir: mkdtempSync(join(dir, 'own-')), executable: () => EXE, showWindow: () => false, warn: () => {}, idleMs,
      onLaunch: async (context) => {
        counts.launches++;
        counts.context = context;
        context.on('close', () => { counts.closes++; });
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (url === `${ORIGIN}/slow`) return await held;
          if (url.startsWith(ORIGIN)) return await route.fulfill({ contentType: 'text/html', body: '<p>fixture</p>' });
          return await route.abort();
        });
      },
    });
    cleanup.push(() => { release(); return b.close(); });
    return { b, counts };
  }

  it('does not start the browser for a read already interrupted', async () => {
    const { b, counts } = ownBrowser();
    const stop = new AbortController();
    stop.abort();
    await expect(b.withPage(async () => 'read', { signal: stop.signal, timeLeft: () => 30_000 })).rejects.toBeInstanceOf(Interrupted);
    expect(counts.launches).toBe(0);
  });

  it('presents itself without "Headless" in its user agent', async () => {
    browser.router = (u) => (u.href === `${ORIGIN}/` ? html('<p>fixture</p>') : null);
    const agent = await browser.withPage(async (page) => {
      await page.goto(`${ORIGIN}/`);
      return await page.run(() => navigator.userAgent, undefined);
    }, ample);
    expect(agent).toMatch(/Chrome\//);
    expect(agent).not.toMatch(/Headless/);
  });

  it('ends a navigation that outlasts the read in TimeUp', async () => {
    const { b } = ownBrowser();
    await b.withPage(async () => undefined, ample);
    const deadline = new Deadline(800);
    await expect(b.withPage((page) => page.goto(`${ORIGIN}/slow`), within(deadline))).rejects.toBeInstanceOf(TimeUp);
    expect(deadline.elapsedMs).toBeLessThan(5000);
  });

  it('ends a pause when the read is interrupted, and refuses the next operation', async () => {
    browser.router = (u) => (u.href === `${ORIGIN}/` ? html('<p>fixture</p>') : null);
    const stop = new AbortController();
    const started = Date.now();
    await expect(browser.withPage(async (page) => {
      await page.goto(`${ORIGIN}/`);
      setTimeout(() => stop.abort(), 100);
      await page.pause(10_000);
      expect(Date.now() - started).toBeLessThan(5000);
      await page.run(() => 1, undefined);
    }, { signal: stop.signal, timeLeft: () => 30_000 })).rejects.toBeInstanceOf(Interrupted);
  });

  it('ends a navigation cut off by an interruption at once, in Interrupted', async () => {
    const { b } = ownBrowser();
    await b.withPage(async () => undefined, ample);
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 300);
    await expect(b.withPage((page) => page.goto(`${ORIGIN}/slow`), { signal: stop.signal, timeLeft: () => 30_000 })).rejects.toBeInstanceOf(Interrupted);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('fetches outside the page only what its rule allows, each redirect checked again, and never a local address by default', async () => {
    const png = solidPng(8, 8);
    server.put('/raw/private.png', png, 'image/png');
    const hop = server.putRedirect('/raw/hop.png', '/raw/private.png');
    const b = new SocialBrowser({
      profileDir: mkdtempSync(join(dir, 'own-')), executable: () => EXE, showWindow: () => false, warn: () => {},
      rawAllowed: (u) => u.protocol === 'http:' && u.pathname === '/raw/hop.png',
    });
    const plain = new SocialBrowser({ profileDir: mkdtempSync(join(dir, 'own-')), executable: () => EXE, showWindow: () => false, warn: () => {} });
    cleanup.push(() => b.close(), () => plain.close());
    expect(await b.withPage((page) => page.fetchRaw(hop, `${ORIGIN}/`, IMAGE_ACCEPT), ample)).toBeNull();
    expect(server.hits.get('/raw/hop.png')).toBe(1);
    expect(await plain.withPage((page) => page.fetchRaw(`${server.origin}/raw/private.png`, `${ORIGIN}/`, IMAGE_ACCEPT), ample)).toBeNull();
    expect(server.hits.get('/raw/private.png')).toBeUndefined();
  });

  it('fetches a resource outside the page, asking for image types the readers take; null when it fails', async () => {
    const png = solidPng(8, 8);
    const url = server.put('/raw/a.png', png, 'image/png');
    browser.router = (u) => (u.href === `${ORIGIN}/` ? html('<p>fixture</p>') : null);
    const [got, missing] = await browser.withPage(async (page) => {
      await page.goto(`${ORIGIN}/`);
      return [await page.fetchRaw(url, `${ORIGIN}/`, IMAGE_ACCEPT), await page.fetchRaw(`${server.origin}/raw/missing.png`, `${ORIGIN}/`, IMAGE_ACCEPT)];
    }, ample);
    expect(got?.mime).toBe('image/png');
    expect(Buffer.from(got!.bytes).equals(png)).toBe(true);
    expect(missing).toBeNull();
  });

  it("names the profile's cookies for a domain and its subdomains", async () => {
    const { b, counts } = ownBrowser();
    await b.withPage(async () => undefined, ample);
    const later = Math.floor(Date.now() / 1000) + 3600;
    await counts.context!.addCookies([
      { name: 'session', value: '1', domain: '.fixture.test', path: '/', expires: later },
      { name: 'sub', value: '1', domain: 'www.fixture.test', path: '/', expires: -1 },
      { name: 'elsewhere', value: '1', domain: 'otherfixture.test', path: '/', expires: later },
    ]);
    expect((await b.cookieNames('.fixture.test')).sort()).toEqual(['session', 'sub']);
  });

  it('closes itself once no page has been open for its idle time, and starts again for the next read', async () => {
    const { b, counts } = ownBrowser(300);
    await b.withPage(async () => undefined, ample);
    await expect.poll(() => counts.closes, { timeout: 5000 }).toBe(1);
    await b.withPage(async () => undefined, ample);
    expect(counts.launches).toBe(2);
  });

  it('runs a read that starts as the browser closes in a new browser, which still closes itself when idle', async () => {
    const { b, counts } = ownBrowser(300);
    await b.withPage(async () => undefined, ample);
    const reading = b.withPage(async () => 'read', ample);
    await b.close();
    expect(await reading).toBe('read');
    expect(counts.launches).toBe(2);
    await expect.poll(() => counts.closes, { timeout: 5000 }).toBe(2);
  });
});
