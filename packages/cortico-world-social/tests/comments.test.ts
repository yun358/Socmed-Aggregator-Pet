/**
 * Comments: the store of drafts, posted comments and the inbox watch with its daily counts, what
 * counts as a link, what a Reddit link replies to, posting through Reddit's comment endpoint, and
 * the replies read from the inbox, on a scripted page.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchedText } from '../src/browser.ts';
import { PlatformBlocked } from '../src/collect.ts';
import { CommentRefused, CommentStore, POSTED_KEPT, SEEN_KEPT, hasLink } from '../src/comments.ts';
import { parseRedditInbox } from '../src/platforms/reddit-parse.ts';
import { postRedditComment, redditInbox, redditReplyTarget } from '../src/platforms/reddit.ts';
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
    first.record({ platform: 'reddit', url: 'one', link: `${REDDIT}/comments/abc123/_/def456/`, text: 'Edited reply', edited: true, auto: false }, one.id);
    const again = new CommentStore(file, () => now);
    expect(again.drafts()).toEqual([two]);
    expect(again.posted()).toEqual([{ platform: 'reddit', url: 'one', link: `${REDDIT}/comments/abc123/_/def456/`, text: 'Edited reply', edited: true, auto: false, at: new Date(now).toISOString() }]);
    expect([one.id, two.id]).not.toContain(again.add(reply('three')).id);
  });

  it('counts the comments posted on the local date only', () => {
    // Asia/Singapore is eight hours ahead of UTC: 15:59 UTC is 23:59 there, 16:01 UTC the next day
    let now = Date.parse('2026-10-22T15:59:00Z');
    const store = new CommentStore(storeFile(), () => now);
    for (const url of ['one', 'two']) store.record({ platform: 'reddit', url, link: null, text: url, edited: false, auto: false }, store.add(reply(url)).id);
    expect(store.today(TZ)).toBe(2);
    now = Date.parse('2026-10-22T16:01:00Z');
    expect(store.today(TZ)).toBe(0);
  });

  it(`keeps the last ${POSTED_KEPT} posted comments, newest first`, () => {
    const store = new CommentStore(storeFile());
    for (let i = 0; i < POSTED_KEPT + 3; i++) store.record({ platform: 'reddit', url: `post ${i}`, link: null, text: `comment ${i}`, edited: false, auto: false });
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

describe('the inbox watch', () => {
  it('starts on the first look after automatic replies are turned on, and again after they were off', () => {
    const file = storeFile();
    let now = Date.parse('2026-10-23T02:00:00Z');
    const store = new CommentStore(file, () => now);
    const first = store.watchSince();
    now += 60_000;
    expect(store.watchSince()).toBe(first);
    expect(new CommentStore(file, () => now).watchSince()).toBe(first);
    store.stopWatching();
    expect(store.watchSince()).toBe(new Date(now).toISOString());
  });

  it(`remembers the last ${SEEN_KEPT} replies looked at, across restarts, with the time of the look`, () => {
    const file = storeFile();
    const now = Date.parse('2026-10-23T02:00:00Z');
    const store = new CommentStore(file, () => now);
    store.looked(Array.from({ length: SEEN_KEPT + 5 }, (_, i) => `t1_r${i}`));
    const again = new CommentStore(file, () => now);
    expect(again.seen('t1_r0')).toBe(false);
    expect(again.seen(`t1_r${SEEN_KEPT + 4}`)).toBe(true);
    expect(again.checkedAt).toBe(new Date(now).toISOString());
  });

  it('counts the automatic answers to one account today, whatever its letter case', () => {
    const store = new CommentStore(storeFile());
    const answer = (to: string) => store.record({ platform: 'reddit', url: 'u', link: null, text: 'x', edited: false, auto: true, to });
    answer('fixture_bob');
    answer('Fixture_Bob');
    answer('fixture_carol');
    store.record({ platform: 'reddit', url: 'u', link: null, text: 'x', edited: false, auto: true });
    expect(store.answeredToday('FIXTURE_BOB', TZ)).toBe(2);
    expect(store.answeredToday('fixture_dan', TZ)).toBe(0);
  });
});

describe('what counts as a link', () => {
  it('is a web address, a Markdown link or a host on a common domain ending', () => {
    for (const text of ['see https://fixture.test/x', 'www.fixture.test', '[menu](/r/x)', 'go to fixture-shop.com now', 'FIXTURE.IO']) expect(hasLink(text), text).toBe(true);
  });

  it('is not a sentence with dots, an abbreviation or a subreddit', () => {
    for (const text of ['Go early. It fills up.', 'e.g. the U.S. branch', 'r/fixturetown has more', 'node.js and 3.5 stars']) expect(hasLink(text), text).toBe(false);
  });
});

describe('the replies in the inbox', () => {
  const item = (id: string, over: Record<string, unknown> = {}) => ({
    kind: 't1',
    data: { id, author: 'fixture_bob', body: `Reply  ${id}`, link_title: 'Fixture title', context: `/r/fixture/comments/abc123/x/${id}/?context=3`, created_utc: 1792634400, type: 'comment_reply', was_comment: true, ...over },
  });

  it('are the replies to comments and to posts, linked without the context query', () => {
    const replies = parseRedditInbox({
      kind: 'Listing',
      data: { children: [item('k1'), item('k2', { type: 'post_reply' }), item('k3', { type: 'username_mention' }), { kind: 't4', data: { id: 'm1', author: 'fixture_bob', body: 'A message', was_comment: false } }, item('k4', { context: '' })] },
    });
    expect(replies).toEqual([
      { target: 't1_k1', url: `${REDDIT}/r/fixture/comments/abc123/x/k1/`, author: 'fixture_bob', text: 'Reply k1', title: 'Fixture title', createdAtMs: 1792634400_000 },
      { target: 't1_k2', url: `${REDDIT}/r/fixture/comments/abc123/x/k2/`, author: 'fixture_bob', text: 'Reply k2', title: 'Fixture title', createdAtMs: 1792634400_000 },
    ]);
  });

  it('are read with the account logged in, without marking them read, and ask for a login without one', async () => {
    const asked: string[] = [];
    const page = (me: unknown) => new ScriptedBrowser({
      fetch: (url) => {
        asked.push(url);
        if (url === `${REDDIT}/api/me.json`) return json(me);
        return json({ kind: 'Listing', data: { children: [item('k1')] } });
      },
    });
    const read = (b: ScriptedBrowser) => b.withPage((p) => redditInbox(p), { timeLeft: () => 30_000 });
    const inbox = await read(page({ kind: 't2', data: { name: 'fixture_alice' } }));
    expect(inbox.me).toBe('fixture_alice');
    expect(inbox.replies.map((r) => r.target)).toEqual(['t1_k1']);
    expect(new URL(asked.find((u) => u.includes('/message/'))!).searchParams.get('mark')).toBe('false');
    await expect(read(page({}))).rejects.toMatchObject({ kind: 'login' });
  });
});
