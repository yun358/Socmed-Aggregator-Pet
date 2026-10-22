/** autoscroll.ts: the local clock, which daily jobs are due, and the digests kept on disk. */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigestStore, KEEP_DAYS, digestId, dueJobs, jobKey, localClock, type Digest } from '../src/autoscroll.ts';
import type { AutoscrollJob } from '../src/config.ts';
import type { Post } from '../src/posts.ts';

const at = (iso: string) => Date.parse(iso);

describe('localClock', () => {
  it('gives the date and minutes since midnight in the time zone, the date rolling over at local midnight', () => {
    expect(localClock(at('2026-10-22T15:59:00Z'), 'Asia/Singapore')).toEqual({ date: '2026-10-22', minutes: 23 * 60 + 59 });
    expect(localClock(at('2026-10-22T16:00:00Z'), 'Asia/Singapore')).toEqual({ date: '2026-10-23', minutes: 0 });
    expect(localClock(at('2026-10-22T16:00:00Z'), 'America/Los_Angeles')).toEqual({ date: '2026-10-22', minutes: 9 * 60 });
    expect(localClock(at('2026-10-22T11:00:00Z'), 'Pacific/Kiritimati')).toEqual({ date: '2026-10-23', minutes: 60 });
    expect(localClock(at('2026-10-22T11:00:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-10-22', minutes: 16 * 60 + 30 });
  });

  it('follows daylight saving time: an hour skipped in spring, an hour repeated in autumn', () => {
    // New York moves from 02:00 EST to 03:00 EDT on 2026-03-08
    expect(localClock(at('2026-03-08T06:59:00Z'), 'America/New_York')).toEqual({ date: '2026-03-08', minutes: 1 * 60 + 59 });
    expect(localClock(at('2026-03-08T07:00:00Z'), 'America/New_York')).toEqual({ date: '2026-03-08', minutes: 3 * 60 });
    // London moves from 02:00 BST back to 01:00 GMT on 2026-10-25
    expect(localClock(at('2026-10-25T00:30:00Z'), 'Europe/London')).toEqual({ date: '2026-10-25', minutes: 90 });
    expect(localClock(at('2026-10-25T01:30:00Z'), 'Europe/London')).toEqual({ date: '2026-10-25', minutes: 90 });
  });
});

describe('dueJobs', () => {
  const TZ = 'Asia/Singapore';
  /** `HH:MM` on 2026-10-22 in Singapore (UTC+8). */
  const sg = (hhmm: string, date = '2026-10-22') => at(`${date}T${hhmm}:00+08:00`);
  const job = (time: string, over: Partial<AutoscrollJob> = {}): AutoscrollJob => ({ platform: 'reddit', source: 'feed', query: '', maxPosts: 20, at: time, images: 'ocr', ...over });
  const morning = job('08:00');
  const noon = job('12:30', { platform: 'x' });
  const evening = job('20:00', { platform: 'youtube' });
  const jobs = [evening, morning, noon];

  it('lists the jobs whose time has come, earliest first, including one whose time passed while the app was not running', () => {
    expect(dueJobs(jobs, {}, sg('07:59'), TZ)).toEqual([]);
    expect(dueJobs(jobs, {}, sg('08:00'), TZ)).toEqual([morning]);
    expect(dueJobs(jobs, {}, sg('13:00'), TZ)).toEqual([morning, noon]);
  });

  it('does not list a job that ran today, and lists it again the next day', () => {
    const ran = { [jobKey(morning)]: '2026-10-22' };
    expect(dueJobs(jobs, ran, sg('13:00'), TZ)).toEqual([noon]);
    expect(dueJobs(jobs, ran, sg('08:00', '2026-10-23'), TZ)).toEqual([morning]);
    expect(dueJobs(jobs, { [jobKey(morning)]: '2026-10-21' }, sg('09:00'), TZ)).toEqual([morning]);
  });

  it('leaves a run missed yesterday to its time today', () => {
    expect(dueJobs([evening], {}, sg('00:30', '2026-10-23'), TZ)).toEqual([]);
  });

  it("reads the start time in the person's time zone", () => {
    const now = at('2026-10-22T01:00:00Z');
    expect(dueJobs(jobs, {}, now, 'Asia/Singapore')).toEqual([morning]);
    expect(dueJobs(jobs, {}, now, 'Europe/London')).toEqual([]);
  });

  it('runs a job set inside the hour skipped by daylight saving time once that hour has passed', () => {
    const night = job('02:30');
    expect(dueJobs([night], {}, at('2026-03-08T06:59:00Z'), 'America/New_York')).toEqual([]);
    expect(dueJobs([night], {}, at('2026-03-08T07:00:00Z'), 'America/New_York')).toEqual([night]);
  });

  it('treats jobs that differ only in count or image setting as one job, due once', () => {
    const twin = { ...morning, maxPosts: 90, images: 'skip' as const };
    expect(jobKey(twin)).toBe(jobKey(morning));
    expect(dueJobs([morning, twin], {}, sg('09:00'), TZ)).toEqual([morning]);
  });

  it('tells jobs apart by platform, source, query and time', () => {
    const keys = [morning, job('08:00', { platform: 'x' }), job('08:00', { source: 'search', query: 'ramen' }), job('08:00', { source: 'search', query: 'sushi' }), job('08:01')].map(jobKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('DigestStore', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'social-digests-'));
    dir = join(root, 'social-digests');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const job = (over: Partial<AutoscrollJob> = {}): AutoscrollJob => ({ platform: 'reddit', source: 'community', query: 'r/fixturetown', maxPosts: 20, at: '08:00', images: 'ocr', ...over });
  const post = (id: string): Post => ({ platform: 'reddit', id, url: `https://www.reddit.com/comments/${id}`, text: `post ${id}`, stats: [], images: [], video: false, extraction: 'adapter' });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const digest = (date: string, j: AutoscrollJob, startedAt: string, over: Partial<Digest> = {}): Digest => ({
    id: digestId(date, j), job: j, startedAt, ms: 61_000, posts: [post('a'), post('b')], skipped: { video: 1, image: 0, ad: 2 }, stopped: 'count', ...over,
  });

  it('starts empty before anything is written', () => {
    const store = new DigestStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.lastRuns()).toEqual({});
    expect(existsSync(dir)).toBe(false);
  });

  it('gives back a saved digest by its id', () => {
    const store = new DigestStore(dir);
    const d = digest('2026-10-22', job(), daysAgo(0));
    store.save(d);
    expect(store.get(d.id)).toEqual(d);
    expect(new DigestStore(dir).get(d.id)).toEqual(d);
  });

  it('lists digests newest first with their post counts and errors', () => {
    const store = new DigestStore(dir);
    const older = digest('2026-10-21', job(), daysAgo(1));
    const morning = digest('2026-10-22', job(), daysAgo(0));
    const failed = digest('2026-10-22', job({ at: '20:00', platform: 'x', source: 'feed', query: '' }), daysAgo(0), { posts: [], error: 'X asked for a login.' });
    for (const d of [morning, older, failed]) store.save(d);
    expect(store.list()).toEqual([
      { id: failed.id, job: failed.job, startedAt: failed.startedAt, posts: 0, error: 'X asked for a login.' },
      { id: morning.id, job: morning.job, startedAt: morning.startedAt, posts: 2 },
      { id: older.id, job: older.job, startedAt: older.startedAt, posts: 2 },
    ]);
    expect(store.list(2).map((d) => d.id)).toEqual([failed.id, morning.id]);
  });

  it('clears the digests and keeps the run dates, so the day\'s jobs do not run again', () => {
    const store = new DigestStore(dir);
    const j = job();
    store.markRun(j, '2026-10-22');
    store.save(digest('2026-10-22', j, daysAgo(0)));
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.lastRuns()).toEqual({ [jobKey(j)]: '2026-10-22' });
  });

  it(`keeps digests for ${KEEP_DAYS} days: saving removes older ones`, () => {
    const store = new DigestStore(dir);
    const stale = digest('2026-10-01', job(), daysAgo(KEEP_DAYS + 1));
    const kept = digest('2026-10-10', job(), daysAgo(KEEP_DAYS - 1));
    store.save(stale);
    store.save(kept);
    expect(store.list().map((d) => d.id)).toEqual([kept.id]);
    expect(store.get(stale.id)).toBeNull();
    expect(readdirSync(dir).sort()).toEqual([`${kept.id}.json`]);
  });

  it('gives distinct ids to different jobs on one day, each usable to get the digest back', () => {
    const store = new DigestStore(dir);
    const a = digest('2026-10-22', job({ query: 'r/fixturetown' }), daysAgo(0));
    const b = digest('2026-10-22', job({ query: 'r/othertown' }), daysAgo(0));
    expect(a.id).not.toBe(b.id);
    store.save(a);
    store.save(b);
    expect(store.get(a.id)?.job.query).toBe('r/fixturetown');
    expect(store.get(b.id)?.job.query).toBe('r/othertown');
  });

  it('records the date each job last ran, beside the digests and outside the list', () => {
    const store = new DigestStore(dir);
    const a = job();
    const b = job({ platform: 'youtube', source: 'search', query: 'ramen' });
    store.markRun(a, '2026-10-21');
    store.markRun(b, '2026-10-22');
    store.markRun(a, '2026-10-22');
    expect(new DigestStore(dir).lastRuns()).toEqual({ [jobKey(a)]: '2026-10-22', [jobKey(b)]: '2026-10-22' });
    expect(store.list()).toEqual([]);
    expect(dueJobs([a, b], store.lastRuns(), at('2026-10-22T12:00:00Z'), 'UTC')).toEqual([]);
    store.markRun(b, undefined);
    expect(store.lastRuns()).toEqual({ [jobKey(a)]: '2026-10-22' });
  });

  it('refuses an id that is not a digest id', () => {
    const store = new DigestStore(dir);
    store.markRun(job(), '2026-10-22');
    for (const id of ['state', '../state', 'a/b', '', 'missing']) expect(store.get(id), id).toBeNull();
  });

  it('skips a file that is not a readable digest, and starts the run dates over when their file is unreadable', () => {
    const store = new DigestStore(dir);
    const d = digest('2026-10-22', job(), daysAgo(0));
    store.save(d);
    writeFileSync(join(dir, '2026-10-22-0900-x-broken.json'), '{ not json');
    writeFileSync(join(dir, '2026-10-22-0930-x-other.json'), '{ "note": "not a digest" }');
    writeFileSync(join(dir, 'state.json'), '[1, 2');
    expect(store.get('2026-10-22-0900-x-broken')).toBeNull();
    expect(store.get('2026-10-22-0930-x-other')).toBeNull();
    expect(store.list().map((x) => x.id)).toEqual([d.id]);
    store.save(digest('2026-10-22', job({ at: '10:00' }), daysAgo(0)));
    expect(store.lastRuns()).toEqual({});
    store.markRun(job(), '2026-10-22');
    expect(store.lastRuns()).toEqual({ [jobKey(job())]: '2026-10-22' });
  });
});
