/** model-text.ts and the environment prompts: what the bot reads from this World, in Chinese and in English. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StopReason } from '../src/collect.ts';
import { IMAGE_MODES, SOCIAL_DEFAULTS, SOURCE_KINDS } from '../src/config.ts';
import { MODEL_TEXT, type Limits, type ModelText } from '../src/model-text.ts';
import type { NoTranscript } from '../src/platforms/adapter.ts';
import { PLATFORM_IDS } from '../src/posts.ts';
import { SocialWorld } from '../src/world.ts';

const STOPS: StopReason[] = ['count', 'time', 'end', 'interrupted'];
const NO_TRANSCRIPT: NoTranscript[] = ['no-captions', 'login', 'unavailable'];
const BLOCKS = ['login', 'captcha', 'consent', 'blocked'] as const;
const UNREAD = ['time', 'cap', 'download', 'decode', 'ocr'] as const;
const LIMITS: Limits = { posts: 3, maxPosts: 5, sec: 41, maxSec: 120 };

/**
 * Representative calls of every entry, with the arguments a caller passes in English. The mapped
 * type makes a new entry without calls here a type error.
 */
const CALLS: { [K in keyof ModelText]: (t: ModelText) => string[] } = {
  platform: (t) => PLATFORM_IDS.map((p) => t.platform[p]),
  source: (t) => SOURCE_KINDS.flatMap((k) => [t.source(k, 'ramen'), t.source(k, 'ramen', 'top', 'week')]),
  duration: (t) => [5_000, 125_000, 7_300_000].map((ms) => t.duration(ms)),
  posts: (t) => [t.posts(1, false), t.posts(2, false), t.posts(1, true), t.posts(4, true)],
  browseHead: (t) => [t.browseHead('Reddit', 'feed', '5 posts', '12 s')],
  leftOut: (t) => [t.leftOut(['2 ads', '1 video post'])],
  leftVideo: (t) => [t.leftVideo(1), t.leftVideo(3)],
  leftImage: (t) => [t.leftImage(1), t.leftImage(3)],
  leftAd: (t) => [t.leftAd(1), t.leftAd(3)],
  stopped: (t) => STOPS.map((s) => t.stopped[s]),
  generic: (t) => [t.generic],
  used: (t) => [t.used(LIMITS)],
  ocrFailed: (t) => [t.ocrFailed('download failed')],
  nothing: (t) => [t.nothing],
  postHead: (t) => [t.postHead(1, ['r/fixturetown', 'u/fixture_alice'])],
  title: (t) => [t.title('Quarterly numbers')],
  cut: (t) => [t.cut(2400)],
  imageOcr: (t) => [t.imageOcr(1, 'Ramen 12.50')],
  imageOcrNone: (t) => [t.imageOcrNone(2)],
  imageAlt: (t) => [t.imageAlt(1, 'A menu board')],
  imageAttached: (t) => [t.imageAttached(1, 2)],
  imageUnread: (t) => UNREAD.map((why) => t.imageUnread(1, why)),
  attachedCaption: (t) => [t.attachedCaption(1, 2, 3)],
  notRun: (t) => [t.notRun('social_browse', 'reason')],
  failed: (t) => [t.failed('social_read', 'reason')],
  platformOff: (t) => [t.platformOff('Reddit')],
  noSource: (t) => SOURCE_KINDS.map((k) => t.noSource('Threads', k, ['feed', 'search'])),
  needQuery: (t) => [t.needQuery],
  limitUsed: (t) => [t.limitUsed(LIMITS)],
  noBrowser: (t) => [t.noBrowser],
  noBrowserAt: (t) => [t.noBrowserAt('/opt/fixture/browser')],
  loginWindowOpen: (t) => [t.loginWindowOpen],
  blocked: (t) => BLOCKS.flatMap((k) => [t.blocked('Reddit', 'reddit', k, ''), t.blocked('Reddit', 'reddit', k, 'HTTP 429')]),
  busy: (t) => [t.busy(1), t.busy(2)],
  error: (t) => [t.error('socket hang up')],
  readHead: (t) => [t.readHead('Reddit', '3 s')],
  readNone: (t) => [t.readNone],
  notPlatformUrl: (t) => [t.notPlatformUrl],
  comments: (t) => [t.comments(3)],
  comment: (t) => [t.comment('u/fixture_gus', 'Agreed.', '12 points'), t.comment('u/fixture_gus', 'Agreed.')],
  transcriptHead: (t) => [t.transcriptHead('Harbour recap', 'Fixture Channel', '12:34', 'English', false), t.transcriptHead('Harbour recap', 'Fixture Channel', '12:34', 'English', true)],
  transcriptSpan: (t) => [t.transcriptSpan('0:00', '4:30', '12:34', false), t.transcriptSpan('4:30', '12:30', '12:34', true)],
  transcriptMore: (t) => [t.transcriptMore(270, 30000)],
  noTranscript: (t) => NO_TRANSCRIPT.map((r) => t.noTranscript(r, 'Harbour recap')),
  notVideo: (t) => [t.notVideo],
  untitled: (t) => [t.untitled],
  interruptedNothing: (t) => [t.interruptedNothing],
  loginOpened: (t) => [t.loginOpened('Instagram')],
  loginEvent: (t) => [t.loginEvent('Instagram', true), t.loginEvent('Instagram', false)],
  commentDrafted: (t) => [t.commentDrafted('c3')],
  commentsOff: (t) => [t.commentsOff],
  commentRedditOnly: (t) => [t.commentRedditOnly],
  commentShareLink: (t) => [t.commentShareLink],
  commentNoTarget: (t) => [t.commentNoTarget],
  commentEmpty: (t) => [t.commentEmpty],
  commentTooLong: (t) => [t.commentTooLong(10000)],
  commentDraftsFull: (t) => [t.commentDraftsFull(5)],
  commentDayFull: (t) => [t.commentDayFull(10)],
  commentPosted: (t) => [
    t.commentPosted('https://www.reddit.com/r/fixturetown/comments/abc/x/', 'https://www.reddit.com/r/fixturetown/comments/abc/x/def/', null),
    t.commentPosted('https://www.reddit.com/r/fixturetown/comments/abc/x/', null, 'Agreed, the ramen place is worth the wait.'),
  ],
  commentDiscarded: (t) => [t.commentDiscarded('https://www.reddit.com/r/fixturetown/comments/abc/x/')],
  commentPostedNow: (t) => [t.commentPostedNow('https://www.reddit.com/r/fixturetown/comments/abc/x/def/'), t.commentPostedNow(null)],
  commentHeld: (t) => [t.commentHeld('c4', t.heldLink), t.commentHeld('c4', t.heldAccount(2))],
  heldLink: (t) => [t.heldLink],
  heldAccount: (t) => [t.heldAccount(2)],
  heldUnsure: (t) => [t.heldUnsure],
  heldFailed: (t) => [t.heldFailed('reason')],
  commentRefused: (t) => [t.commentRefused('THREAD_LOCKED: Comments are locked.')],
  repliesEvent: (t) => [t.repliesEvent([t.replyLine('u/fixture_bob', 'Autumn trip ideas', 'Which temple?', 'https://www.reddit.com/r/fixturetown/comments/abc/x/def/')])],
  replyLine: (t) => [t.replyLine('u/fixture_bob', 'Autumn trip ideas', 'Which temple?', 'https://www.reddit.com/r/fixturetown/comments/abc/x/def/')],
  statsHead: (t) => [t.statsHead('2026-10-01 09:00')],
  statsLine: (t) => [t.statsLine('Reddit', '5 min 2 s', 40, 1, '2026-10-22 09:00'), t.statsLine('YouTube', '2 s', 0, 0)],
  statsNone: (t) => [t.statsNone],
  statsLogins: (t) => [t.statsLogins([], ['Reddit']), t.statsLogins(['Reddit'], ['X', 'Threads']), t.statsLogins(['Reddit'], [])],
  statsJobs: (t) => [t.statsJobs([]), t.statsJobs(['- line'])],
  jobLine: (t) => [t.jobLine('08:00', 'Reddit', 'feed', 100, false), t.jobLine('08:00', 'Reddit', 'feed', 100, true)],
  digestEvent: (t) => [t.digestEvent('Reddit, feed', '100 posts', '9 min', 'Left out: 2 ads. ', '2026-10-22-0800-reddit-abc123')],
  digestFailed: (t) => [t.digestFailed('Reddit, feed', 'reason')],
  digestHead: (t) => [t.digestHead('Reddit, feed', '2026-10-22 08:00', 100, 1, 20)],
  digestNext: (t) => [t.digestNext(20)],
  digestMissing: (t) => [t.digestMissing],
  digestPastEnd: (t) => [t.digestPastEnd(12)],
  digestNone: (t) => [t.digestNone],
  digestList: (t) => [t.digestList(['- line'])],
  digestListLine: (t) => [t.digestListLine('2026-10-22-0800-reddit-abc123', 'Reddit, feed', 100), t.digestListLine('2026-10-22-0800-reddit-abc123', 'Reddit, feed', 0, 'reason')],
  envPlatforms: (t) => [t.envPlatforms([]), t.envPlatforms(['Reddit', 'YouTube'])],
  envImages: (t) => IMAGE_MODES.map((m) => t.envImages[m]),
  envAutoscroll: (t) => [t.envAutoscroll([]), t.envAutoscroll(['- line'])],
  envComments: (t) => [
    t.envComments({ enabled: true, maxPerDay: 10, auto: false, autoReply: false }),
    t.envComments({ enabled: true, maxPerDay: 10, auto: true, autoReply: true }),
    t.envComments({ enabled: false, maxPerDay: 10, auto: true, autoReply: true }),
  ],
};

/** Han characters and the full-width punctuation Chinese text uses. */
const CJK = /[\p{Script=Han}　-〿＀-￯]/u;

describe('the model text tables', () => {
  it('give non-empty text for every call in both languages', () => {
    for (const [key, call] of Object.entries(CALLS)) {
      for (const language of ['zh', 'en'] as const) {
        for (const s of call(MODEL_TEXT[language])) expect(s.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  it('the English table writes no Chinese', () => {
    for (const [key, call] of Object.entries(CALLS)) {
      for (const s of call(MODEL_TEXT.en)) expect(s, `en.${key}`).not.toMatch(CJK);
    }
  });

  it('limit receipts state the counts used and the limits in force', () => {
    for (const language of ['zh', 'en'] as const) {
      const t = MODEL_TEXT[language];
      for (const s of [t.used(LIMITS), t.limitUsed(LIMITS)]) {
        for (const n of Object.values(LIMITS)) expect(s, `${language}: ${s}`).toContain(String(n));
      }
    }
  });

  it('a block receipt names the platform id social_login takes', () => {
    for (const language of ['zh', 'en'] as const) {
      for (const kind of ['login', 'captcha', 'consent'] as const) expect(MODEL_TEXT[language].blocked('Reddit', 'reddit', kind, '')).toContain('social_login');
    }
  });

  it('writes durations in seconds, then minutes, then hours', () => {
    const t = MODEL_TEXT.en;
    expect([5_000, 125_000, 7_300_000].map((ms) => t.duration(ms))).toEqual(['5 s', '2 min 5 s', '2 h 1 min']);
  });
});

describe('the environment prompts', () => {
  const zh = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
  const en = readFileSync(new URL('../src/ENV_PROMPT.en.md', import.meta.url), 'utf8');
  const vars = (s: string) => new Set([...s.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
  const dir = mkdtempSync(join(tmpdir(), 'social-env-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the English prompt writes no Chinese', () => {
    expect(en).not.toMatch(CJK);
  });

  it('both prompts use exactly the variables the World fills', () => {
    const world = new SocialWorld({ cfg: structuredClone(SOCIAL_DEFAULTS), timezone: 'UTC', dataDir: dir, ocrDir: join(dir, 'ocr'), persist: () => {} });
    const filled = new Set(Object.keys(world.envPromptVars()));
    expect(vars(zh)).toEqual(filled);
    expect(vars(en)).toEqual(filled);
  });
});
