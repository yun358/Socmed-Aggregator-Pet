/**
 * Comments: the store of drafts and posted comments with its daily count, what a Reddit link
 * replies to, and posting through Reddit's comment endpoint on a scripted page.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchedText } from '../src/browser.ts';
import { PlatformBlocked } from '../src/collect.ts';
import { CommentRefused, CommentStore, POSTED_KEPT } from '../src/comments.ts';
import { postRedditComment, redditReplyTarget } from '../src/platforms/reddit.ts';
import { ScriptedBrowser, json, type FetchInit } from './helpers/scripted-browser.ts';

const TZ = 'Asia/Singapore';
const REDDIT = 'https://www.reddit.com';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'social-comments-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'social-comments.json');
}

const reply = (url: string) => ({ platform: 'reddit' as const, url, target: 't3_abc123', text: `Reply to ${url}` });

describe('the comment store', () => {
  it('keeps drafts and posted comments across restarts, and never gives a draft id twice', () => {
    const file = storeFile();
    const now = Date.parse('2026-10-23T02:00:00Z');
    const first = new CommentStore(file, () => now);
    const one = first.add(reply('one'));
    const two = first.add(reply('two'));
    first.record(one.id, { platform: 'reddit', url: 'one', link: `${REDDIT}/comments/abc123/_/def456/`, text: 'Edited reply', edited: true });
    const again = new CommentStore(file, () => now);
    expect(again.drafts()).toEqual([two]);
    expect(again.posted()).toEqual([{ platform: 'reddit', url: 'one', link: `${REDDIT}/comments/abc123/_/def456/`, text: 'Edited reply', edited: true, at: new Date(now).toISOString() }]);
    expect([one.id, two.id]).not.toContain(again.add(reply('three')).id);
  });

  it('counts the comments posted on the local date only', () => {
    // Asia/Singapore is eight hours ahead of UTC: 15:59 UTC is 23:59 there, 16:01 UTC the next day
    let now = Date.parse('2026-10-22T15:59:00Z');
    const store = new CommentStore(storeFile(), () => now);
    for (const url of ['one', 'two']) store.record(store.add(reply(url)).id, { platform: 'reddit', url, link: null, text: url, edited: false });
    expect(store.today(TZ)).toBe(2);
    now = Date.parse('2026-10-22T16:01:00Z');
    expect(store.today(TZ)).toBe(0);
  });

  it(`keeps the last ${POSTED_KEPT} posted comments, newest first`, () => {
    const store = new CommentStore(storeFile());
    for (let i = 0; i < POSTED_KEPT + 3; i++) store.record('none', { platform: 'reddit', url: `post ${i}`, link: null, text: `comment ${i}`, edited: false });
    const posted = store.posted();
    expect(posted).toHaveLength(POSTED_KEPT);
    expect(posted[0]!.text).toBe(`comment ${POSTED_KEPT + 2}`);
    expect(posted.at(-1)!.text).toBe('comment 3');
    expect(store.posted(2).map((p) => p.text)).toEqual([`comment ${POSTED_KEPT + 2}`, `comment ${POSTED_KEPT + 1}`]);
  });

  it('starts empty from a file it cannot read, keeping that file beside it', () => {
    const file = storeFile();
    writeFileSync(file, '{"drafts": [');
    const store = new CommentStore(file);
    expect(store.drafts()).toEqual([]);
    expect(store.posted()).toEqual([]);
    expect(existsSync(`${file}.unreadable`)).toBe(true);
  });
});

describe('what a Reddit link replies to', () => {
  it('is the comment the link names, else its post', () => {
    expect(redditReplyTarget(`${REDDIT}/r/fixture/comments/abc123/some_title/`)).toBe('t3_abc123');
    expect(redditReplyTarget('https://old.reddit.com/r/fixture/comments/abc123/some_title/def456/?context=3')).toBe('t1_def456');
    expect(redditReplyTarget(`${REDDIT}/r/fixture/comments/abc123/comment/def456/`)).toBe('t1_def456');
    expect(redditReplyTarget(`${REDDIT}/comments/abc123`)).toBe('t3_abc123');
    expect(redditReplyTarget('https://redd.it/abc123')).toBe('t3_abc123');
    expect(redditReplyTarget(`${REDDIT}/gallery/abc123`)).toBe('t3_abc123');
  });

  it('is null for a share link, a subreddit, another site, and a link that is no http(s) link', () => {
    for (const url of [`${REDDIT}/r/fixture/s/AbCdEf123`, `${REDDIT}/r/fixture/`, 'https://fixture.test/comments/abc123/x/', 'not a link', 'javascript://www.reddit.com/r/fixture/comments/abc123/x/%0Aalert(1)']) {
      expect(redditReplyTarget(url), url).toBeNull();
    }
  });
});

describe('posting a Reddit comment', () => {
  const ME = `${REDDIT}/api/me.json`;
  const COMMENT = `${REDDIT}/api/comment`;
  const posted = (data: Record<string, unknown>) => json({ json: { errors: [], data: { things: [{ kind: 't1', data }] } } });

  /** A browser logged in with `modhash` (none: logged out), answering the comment endpoint with `answer`. */
  function reddit(modhash: string | null, answer: FetchedText) {
    const sent: NonNullable<FetchInit>[] = [];
    const browser = new ScriptedBrowser({
      fetch: (url, init) => {
        if (url === ME) return json(modhash ? { kind: 't2', data: { name: 'fixture_alice', modhash } } : {});
        if (url !== COMMENT) return undefined;
        sent.push(init ?? {});
        return answer;
      },
    });
    const post = (target: string, text: string) => browser.withPage((page) => postRedditComment(page, target, text), { timeLeft: () => 30_000 });
    return { post, sent };
  }

  it("sends the comment with the login's modhash and returns the comment's link", async () => {
    const { post, sent } = reddit('fixturehash', posted({ id: 'def456', link_id: 't3_abc123', permalink: '/r/fixture/comments/abc123/x/def456/' }));
    expect(await post('t3_abc123', 'Line one\n\n**bold**')).toEqual({ link: `${REDDIT}/r/fixture/comments/abc123/x/def456/` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', 'x-modhash': 'fixturehash' });
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ api_type: 'json', raw_json: '1', thing_id: 't3_abc123', text: 'Line one\n\n**bold**' });
  });

  it('builds the link from the comment and post ids when Reddit gives no permalink, and gives none without them', async () => {
    expect(await reddit('h', posted({ id: 'def456', link_id: 't3_abc123' })).post('t1_xyz', 'x')).toEqual({ link: `${REDDIT}/comments/abc123/_/def456/` });
    expect(await reddit('h', json({ json: { errors: [] } })).post('t1_xyz', 'x')).toEqual({ link: null });
  });

  it('asks for a login when the browser has none, without sending the comment', async () => {
    const { post, sent } = reddit(null, posted({ id: 'def456' }));
    const err = await post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformBlocked);
    expect((err as PlatformBlocked).kind).toBe('login');
    expect(sent).toEqual([]);
  });

  it("gives Reddit's reasons when it turns the comment down", async () => {
    const err = await reddit('h', json({ json: { errors: [['RATELIMIT', 'Take a break for 5 minutes.', 'ratelimit'], ['TOO_LONG', 'This is too long.', 'text']] } }))
      .post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommentRefused);
    expect((err as CommentRefused).detail).toBe('RATELIMIT: Take a break for 5 minutes.; TOO_LONG: This is too long.');
  });

  it('names a refusal by its HTTP status, and takes 429 as a block and 401 as a missing login', async () => {
    const forbidden = await reddit('h', { status: 403, text: '' }).post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(CommentRefused);
    expect((forbidden as CommentRefused).detail).toBe('HTTP 403');
    const limited = await reddit('h', { status: 429, text: '' }).post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(limited).toMatchObject({ kind: 'blocked' });
    const loggedOut = await reddit('h', { status: 401, text: '' }).post('t3_abc123', 'x').catch((e: unknown) => e);
    expect(loggedOut).toMatchObject({ kind: 'login' });
  });
});
