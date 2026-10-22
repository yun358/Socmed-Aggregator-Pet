/**
 * A `SocialBrowser` without a browser, for World tests: each page is a `ScriptedPage` that answers
 * from a `PageScript`. It keeps `LivePage`'s rules: every operation first throws `Interrupted` once
 * the signal is aborted and `TimeUp` once the read's time is spent, and a call that would take
 * longer than the time left takes that long on the test clock and then throws `TimeUp`.
 *
 * Only adapters that read through `goto`, `fetchText` and `fetchRaw` (Reddit, Bilibili) can run on
 * it; in-page functions need `script.run`.
 */
import { Interrupted, SocialBrowser, TimeUp, type FetchedText, type PageLimits, type PageSession } from '../../src/browser.ts';

/** A clock the test moves; the World reads it through `SocialWorldOptions.now`. */
export class TestClock {
  constructor(public now = Date.now()) {}
  readonly read = (): number => this.now;
}

export interface PageScript {
  /** The answer to `fetchText(url)`; a 404 when absent. */
  fetch?(url: string): FetchedText | undefined | Promise<FetchedText | undefined>;
  /** The answer to `fetchRaw(url)`; null (not fetched) when absent. */
  raw?(url: string): { bytes: Uint8Array; mime: string } | null | undefined;
  /** Where `goto(url)` ends up; `url` itself when absent. */
  redirect?(url: string): string | undefined;
  run?(fn: (...args: never[]) => unknown, arg: unknown): unknown;
  /** Test-clock milliseconds each `goto`, `fetchText` and `fetchRaw` takes. */
  costMs?: number;
}

export const json = (value: unknown, status = 200): FetchedText => ({ status, text: JSON.stringify(value) });

class ScriptedPage implements PageSession {
  private at = 'about:blank';

  constructor(private readonly browser: ScriptedBrowser, private readonly limits: PageLimits) {}

  check(): void {
    if (this.limits.signal?.aborted) throw new Interrupted();
    if (this.limits.timeLeft() <= 0) throw new TimeUp();
  }

  /** Moves the test clock by one call's cost, or to the deadline and `TimeUp` when the call would outlast it. */
  private spend(): void {
    const cost = this.browser.script.costMs ?? 0;
    const left = this.limits.timeLeft();
    if (cost > left) {
      this.browser.clock.now += left;
      throw new TimeUp();
    }
    this.browser.clock.now += cost;
  }

  url(): string { return this.at; }

  async goto(url: string): Promise<string> {
    this.check();
    this.browser.requests.push(url);
    this.spend();
    this.at = this.browser.script.redirect?.(url) ?? url;
    this.check();
    return this.at;
  }

  async run<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    this.check();
    if (!this.browser.script.run) throw new Error(`the scripted page has no stand-in for ${fn.name}`);
    return await this.browser.script.run(fn as (...args: never[]) => unknown, arg) as R;
  }

  async fetchText(url: string): Promise<FetchedText> {
    this.check();
    this.browser.requests.push(url);
    this.spend();
    return (await this.browser.script.fetch?.(url)) ?? { status: 404, text: '' };
  }

  async fetchRaw(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    this.check();
    this.browser.requests.push(url);
    this.spend();
    return this.browser.script.raw?.(url) ?? null;
  }

  async waitFor(): Promise<boolean> {
    this.check();
    return false;
  }

  async captureResponse(_match: RegExp, action: () => Promise<unknown>): Promise<FetchedText | null> {
    this.check();
    await action();
    return null;
  }

  async pause(ms: number): Promise<void> {
    this.check();
    this.browser.clock.now += Math.min(ms, this.limits.timeLeft());
  }
}

export class ScriptedBrowser extends SocialBrowser {
  /** Every URL a page opened or fetched, in order. */
  readonly requests: string[] = [];
  /** Login pages opened, with the callback the World gave for the window closing. */
  readonly logins: Array<{ url: string; close: () => void }> = [];
  /** Cookie names in the profile per domain suffix, as `cookieNames` reports them. */
  cookies: Record<string, string[]> = {};

  constructor(public script: PageScript = {}, readonly clock = new TestClock()) {
    super({ profileDir: '', executable: () => null, showWindow: () => false, warn: () => {} });
  }

  override async withPage<T>(fn: (page: PageSession) => Promise<T>, limits: PageLimits): Promise<T> {
    if (limits.signal?.aborted) throw new Interrupted();
    return await fn(new ScriptedPage(this, limits));
  }

  private loginsOpen = 0;

  override async openLogin(url: string, onClosed: () => void): Promise<void> {
    this.loginsOpen++;
    this.logins.push({ url, close: () => { this.loginsOpen--; onClosed(); } });
  }

  override get loginOpen(): boolean {
    return this.loginsOpen > 0;
  }

  override async cookieNames(domain: string): Promise<string[]> {
    return this.cookies[domain] ?? [];
  }

  override async close(): Promise<void> {}
}
