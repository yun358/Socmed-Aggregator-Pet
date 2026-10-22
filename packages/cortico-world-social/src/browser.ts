/**
 * The browser the World reads platforms with: an installed Chromium-based browser (`find-browser.ts`)
 * driven by playwright-core over its own persistent profile, so a platform the person logs into once
 * stays logged in. It runs headless unless the person asks to see it, is launched on first use and
 * closed after `IDLE_MS` with no page open. A login window is the same browser on the same profile
 * started on its own, with no automation attached, since sign-in pages (Google's among them) refuse
 * an automated browser; reads wait until the person closes it.
 *
 * Adapters see a page only as a `PageSession`, which tests implement without a browser.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { isIP } from 'node:net';
import type { BrowserContext, Page } from 'playwright-core';

export const IDLE_MS = 3 * 60_000;
const NAV_TIMEOUT_MS = 30_000;

export class BrowserMissing extends Error {
  /** `configured`: the browser path the person set, which does not exist. */
  constructor(readonly configured = '') { super(configured ? `no browser at ${configured}` : 'no Chromium-based browser found'); }
}

/** The profile is in use by a login window; the browser cannot read until the person closes it. */
export class LoginWindowOpen extends Error {
  constructor() { super('a login window is open'); }
}

/** A window was asked for while the headless browser was reading; relaunching would cut those reads off. */
export class BrowserBusy extends Error {
  constructor(readonly pages: number) { super(`the browser is reading ${pages} page(s) in the background`); }
}

/** The tool was interrupted; what was read so far still counts. */
export class Interrupted extends Error {
  constructor() { super('interrupted'); }
}

/** The read's time ran out inside a page operation; what was read so far still counts. */
export class TimeUp extends Error {
  constructor() { super('time limit reached'); }
}

export interface FetchedText {
  status: number;
  text: string;
}

/**
 * One page, as the adapters use it. Every operation first throws `Interrupted` when the tool was
 * interrupted and `TimeUp` when the read's time is spent, and waits no longer than the time left.
 */
export interface PageSession {
  /** Opens `url`, waits for its DOM, and returns the URL it ended on. */
  goto(url: string): Promise<string>;
  /** Runs `fn(arg)` inside the page; `fn` must be self-contained (see `dom.ts`). */
  run<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** `fetch` from inside the page, with its cookies and origin. */
  fetchText(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchedText>;
  /**
   * A resource fetched with the browser's cookies but outside the page, so the page's CORS rules do
   * not apply (images, subtitle files on another host); null when it could not be fetched.
   */
  fetchRaw(url: string, referer: string, accept?: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Waits for `selector` up to `ms`; false when it did not appear. */
  waitFor(selector: string, ms: number): Promise<boolean>;
  /** The body of the first response whose URL matches `match` while `action` runs, waiting up to `ms`. */
  captureResponse(match: RegExp, action: () => Promise<unknown>, ms: number): Promise<FetchedText | null>;
  /** Waits `ms`, ending early when the tool is interrupted. */
  pause(ms: number): Promise<void>;
  check(): void;
  url(): string;
}

/** `fn` as an expression for the page: tsx names inner functions with `__name`, which the page lacks. */
export const pageExpression = (fn: (...args: never[]) => unknown, arg: unknown): string =>
  `(function (__name) { return (${fn.toString()})(${JSON.stringify(arg)}); })(function (f) { return f; })`;

/** Formats Tesseract and the model services read; AVIF is neither. */
export const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/*;q=0.5';
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MAX_RAW_REDIRECTS = 5;

/**
 * Whether `fetchRaw` may fetch `url`: https on a public host name. A post can name any URL as its
 * image, and this computer, the local network and bare IP addresses are never fetched for it.
 */
export function publicHttps(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

export interface PageLimits {
  signal?: AbortSignal;
  /** Milliseconds the read has left. */
  timeLeft(): number;
}

class LivePage implements PageSession {
  constructor(private readonly page: Page, private readonly limits: PageLimits, private readonly rawAllowed: (url: URL) => boolean) {}

  check(): void {
    if (this.limits.signal?.aborted) throw new Interrupted();
    if (this.limits.timeLeft() <= 0) throw new TimeUp();
  }

  /** `ms`, or less when the read has less time left. */
  private within(ms: number): number {
    return Math.max(1, Math.min(ms, this.limits.timeLeft()));
  }

  url(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<string> {
    this.check();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.within(NAV_TIMEOUT_MS) });
    } catch (err) {
      this.check();
      throw err;
    }
    this.check();
    return this.page.url();
  }

  async run<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    this.check();
    try {
      return await this.page.evaluate(pageExpression(fn as (...args: never[]) => unknown, arg)) as R;
    } catch (err) {
      this.check();
      throw err;
    }
  }

  async fetchText(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<FetchedText> {
    const timeoutMs = this.within(NAV_TIMEOUT_MS);
    try {
      return await this.run(async (a: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string }; timeoutMs: number }) => {
        const rep = await fetch(a.url, { credentials: 'include', ...a.init, signal: AbortSignal.timeout(a.timeoutMs) });
        return { status: rep.status, text: await rep.text() };
      }, { url, init, timeoutMs });
    } catch (err) {
      this.check();
      throw err;
    }
  }

  async fetchRaw(url: string, referer: string, accept = '*/*'): Promise<{ bytes: Uint8Array; mime: string } | null> {
    this.check();
    try {
      let at = new URL(url);
      for (let hop = 0; hop <= MAX_RAW_REDIRECTS; hop++) {
        // as Chromium does for an image on an https page
        if (at.protocol === 'http:' && !this.rawAllowed(at)) at.protocol = 'https:';
        if (!this.rawAllowed(at)) return null;
        const rep = await this.page.context().request.get(at.href, { headers: { referer, accept }, timeout: this.within(NAV_TIMEOUT_MS), maxRedirects: 0 });
        const location = rep.headers().location;
        if (rep.status() >= 300 && rep.status() < 400 && location) { at = new URL(location, at); continue; }
        if (!rep.ok() || Number(rep.headers()['content-length'] ?? 0) > MAX_RAW_BYTES) return null;
        const bytes = await rep.body();
        if (bytes.length > MAX_RAW_BYTES) return null;
        return { bytes: new Uint8Array(bytes), mime: (rep.headers()['content-type'] ?? '').split(';')[0].trim() };
      }
      return null;
    } catch {
      return null;
    }
  }

  async waitFor(selector: string, ms: number): Promise<boolean> {
    this.check();
    try {
      await this.page.waitForSelector(selector, { timeout: this.within(ms), state: 'attached' });
      return true;
    } catch {
      return false;
    }
  }

  async captureResponse(match: RegExp, action: () => Promise<unknown>, ms: number): Promise<FetchedText | null> {
    this.check();
    const waiting = this.page.waitForResponse((r) => match.test(r.url()), { timeout: this.within(ms) })
      .then(async (r) => ({ status: r.status(), text: await r.text() }))
      .catch(() => null);
    await action();
    return waiting;
  }

  async pause(ms: number): Promise<void> {
    this.check();
    const signal = this.limits.signal;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, this.within(ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

export interface SocialBrowserOptions {
  profileDir: string;
  /** The executable to run, read at each launch; null when none is installed. */
  executable(): string | null;
  /** The browser path the person set, empty for one found automatically; it names a missing browser. */
  configured?(): string;
  /** Whether the person wants to see the browser while Coo reads, read at each launch. */
  showWindow(): boolean;
  warn(message: string): void;
  /** Called with each launched browser before its first page; tests route requests to fixtures here. */
  onLaunch?(context: BrowserContext): Promise<void>;
  /** Milliseconds with no page open before the browser is closed; `IDLE_MS` when absent. */
  idleMs?: number;
  /** Which URLs `fetchRaw` may fetch; `publicHttps` when absent. */
  rawAllowed?(url: URL): boolean;
}

export class SocialBrowser {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private headless = true;
  private open = 0;
  private idle: NodeJS.Timeout | null = null;
  /** User agent without "Headless", learnt on the first headless launch of an executable. */
  private agent = new Map<string, string>();
  private login: ChildProcess | null = null;

  constructor(private readonly opts: SocialBrowserOptions) {}

  /** Runs `fn` on a new page within `limits`, closed afterwards. */
  async withPage<T>(fn: (page: PageSession) => Promise<T>, limits: PageLimits): Promise<T> {
    if (limits.signal?.aborted) throw new Interrupted();
    if (this.login) throw new LoginWindowOpen();
    let context: BrowserContext;
    // while other reads run, a change to the window setting waits for the next launch; a context
    // closed while it was readied opens no page (its newPage never settles), so a new one is readied
    do context = this.context && this.open > 0 ? this.context : await this.ensure(!this.opts.showWindow());
    while (context !== this.context);
    this.open++;
    this.disarm();
    let page: Page | null = null;
    // closing the page ends the operation under way, which then throws `Interrupted`
    const abort = () => void page?.close().catch(() => undefined);
    limits.signal?.addEventListener('abort', abort, { once: true });
    try {
      page = await context.newPage();
      return await fn(new LivePage(page, limits, (url) => (this.opts.rawAllowed ?? publicHttps)(url)));
    } catch (err) {
      if (limits.signal?.aborted) throw new Interrupted();
      throw err;
    } finally {
      limits.signal?.removeEventListener('abort', abort);
      this.open--;
      await page?.close().catch(() => undefined);
      this.arm();
    }
  }

  /**
   * Starts the browser on its profile at `url` for the person to log in, closing the automated one
   * first (the profile is open in one browser at a time). Resolves once the window is up;
   * `onClosed` is called when the person has closed it and the browser has exited.
   */
  async openLogin(url: string, onClosed: () => void): Promise<void> {
    if (this.login) throw new LoginWindowOpen();
    if (this.open > 0) throw new BrowserBusy(this.open);
    const executable = this.opts.executable();
    if (!executable) throw new BrowserMissing(this.opts.configured?.() ?? '');
    await this.close();
    const env = { ...process.env };
    // Core runs Electron as Node; the browser is no Electron, but the flag has no business there
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [`--user-data-dir=${this.opts.profileDir}`, '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore', env });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.login = child;
    child.once('exit', () => {
      if (this.login === child) this.login = null;
      onClosed();
    });
  }

  get loginOpen(): boolean {
    return this.login !== null;
  }

  /** Names of the cookies set for `domain` (a suffix such as `.reddit.com`) in the profile. */
  async cookieNames(domain: string): Promise<string[]> {
    if (this.login) throw new LoginWindowOpen();
    const context = this.context ?? await this.ensure(true);
    try {
      return (await context.cookies()).filter((c) => `.${c.domain.replace(/^\./, '')}`.endsWith(domain)).filter((c) => c.expires === -1 || c.expires * 1000 > Date.now()).map((c) => c.name);
    } finally {
      this.arm();
    }
  }

  /** A browser with a window serves headless reads too; a headless one is relaunched to show one. */
  private async ensure(headless: boolean): Promise<BrowserContext> {
    if (this.launching) await this.launching.catch(() => undefined);
    if (this.context && !headless && this.headless) {
      if (this.open > 0) throw new BrowserBusy(this.open);
      await this.close();
    }
    if (this.context) return this.context;
    this.launching = this.launch(headless);
    try {
      this.context = await this.launching;
      this.headless = headless;
      return this.context;
    } finally {
      this.launching = null;
    }
  }

  private async launch(headless: boolean): Promise<BrowserContext> {
    const executablePath = this.opts.executable();
    if (!executablePath) throw new BrowserMissing(this.opts.configured?.() ?? '');
    const { chromium } = await import('playwright-core');
    const options = {
      executablePath,
      headless,
      viewport: headless ? { width: 1280, height: 900 } : null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
      ...(headless && this.agent.has(executablePath) ? { userAgent: this.agent.get(executablePath) } : {}),
    };
    let context = await chromium.launchPersistentContext(this.opts.profileDir, options);
    if (headless && !this.agent.has(executablePath)) {
      const page = context.pages()[0] ?? await context.newPage();
      const ua = await page.evaluate(() => navigator.userAgent);
      if (ua.includes('HeadlessChrome')) {
        // sites turn away a browser that calls itself headless
        this.agent.set(executablePath, ua.replace('HeadlessChrome', 'Chrome'));
        await context.close();
        context = await chromium.launchPersistentContext(this.opts.profileDir, { ...options, userAgent: this.agent.get(executablePath) });
      } else {
        this.agent.set(executablePath, ua);
      }
    }
    await this.opts.onLaunch?.(context);
    context.on('close', () => {
      if (this.context === context) this.context = null;
    });
    return context;
  }

  private arm(): void {
    this.disarm();
    if (this.open > 0) return;
    this.idle = setTimeout(() => void this.close(), this.opts.idleMs ?? IDLE_MS);
    this.idle.unref();
  }

  private disarm(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Closes the automated browser. */
  async close(): Promise<void> {
    this.disarm();
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch((err: Error) => this.opts.warn(`browser close: ${err.message}`));
  }

  /** Closes the automated browser and a login window still open, without calling its `onClosed`. */
  async stop(): Promise<void> {
    this.login?.removeAllListeners('exit');
    this.login?.kill();
    this.login = null;
    await this.close();
  }
}
