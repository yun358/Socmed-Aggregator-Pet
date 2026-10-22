/** lifetime.ts: the lifetime counter of time spent and posts read on each platform, kept in a file. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lifetime, SAVE_MS } from '../src/lifetime.ts';
import { PLATFORM_IDS } from '../src/posts.ts';

describe('Lifetime', () => {
  let dir: string;
  let file: string;
  let now: number;
  const clock = () => now;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'social-lifetime-'));
    file = join(dir, 'data', 'social-lifetime.json');
    now = Date.parse('2026-10-22T08:00:00Z');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at zero for every platform, counting from now', () => {
    const snap = new Lifetime(file, clock).snapshot();
    expect(snap.sinceAt).toBe('2026-10-22T08:00:00.000Z');
    expect(Object.keys(snap.platforms).sort()).toEqual([...PLATFORM_IDS].sort());
    for (const id of PLATFORM_IDS) expect(snap.platforms[id]).toEqual({ ms: 0, posts: 0, transcripts: 0 });
  });

  it('adds up time, posts and transcripts per platform, with the time of the last read', () => {
    const life = new Lifetime(file, clock);
    life.add('youtube', 12_000.4, { posts: 5 });
    now += 60_000;
    life.add('youtube', 3_000, { posts: 1, transcripts: 1 });
    life.add('reddit', -50, {});
    const snap = life.snapshot();
    expect(snap.platforms.youtube).toEqual({ ms: 15_000, posts: 6, transcripts: 1, lastAt: '2026-10-22T08:01:00.000Z' });
    expect(snap.platforms.reddit).toEqual({ ms: 0, posts: 0, transcripts: 0, lastAt: '2026-10-22T08:01:00.000Z' });
    expect(snap.platforms.x).toEqual({ ms: 0, posts: 0, transcripts: 0 });
    life.flush();
  });

  it('hands out copies: a snapshot does not change the count', () => {
    const life = new Lifetime(file, clock);
    life.snapshot().platforms.x.ms = 99;
    expect(life.snapshot().platforms.x.ms).toBe(0);
  });

  it('a new counter on the same file continues from what was flushed', () => {
    const life = new Lifetime(file, clock);
    life.add('bilibili', 90_000, { posts: 20, transcripts: 2 });
    life.flush();
    const before = life.snapshot();
    now += 86_400_000;
    const again = new Lifetime(file, clock);
    expect(again.snapshot()).toEqual(before);
    again.add('bilibili', 10_000, { posts: 1 });
    expect(again.snapshot().platforms.bilibili.ms).toBe(100_000);
    again.flush();
  });

  it(`writes a read to the file within ${SAVE_MS} ms, once for a burst of reads`, () => {
    vi.useFakeTimers();
    const life = new Lifetime(file, clock);
    life.add('x', 1_000, { posts: 1 });
    life.add('x', 1_000, { posts: 1 });
    expect(existsSync(file)).toBe(false);
    vi.advanceTimersByTime(SAVE_MS);
    expect(new Lifetime(file, clock).snapshot().platforms.x.posts).toBe(2);
  });

  it('reset starts the count again from now and writes it at once', () => {
    const life = new Lifetime(file, clock);
    life.add('rednote', 5_000, { posts: 3 });
    life.flush();
    now += 3_600_000;
    life.reset();
    const fresh = new Lifetime(file, clock).snapshot();
    expect(fresh.sinceAt).toBe('2026-10-22T09:00:00.000Z');
    expect(fresh.platforms.rednote).toEqual({ ms: 0, posts: 0, transcripts: 0 });
  });

  it('keeps an unreadable file aside and starts a new count', () => {
    const life = new Lifetime(file, clock);
    life.flush();
    writeFileSync(file, '{ "sinceAt": "2026-01-01T00:00:00.000Z", "platforms": {');
    const fresh = new Lifetime(file, clock);
    expect(fresh.snapshot().sinceAt).toBe('2026-10-22T08:00:00.000Z');
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toContain('2026-01-01');
    fresh.add('threads', 1_000, { posts: 1 });
    fresh.flush();
    expect(new Lifetime(file, clock).snapshot().platforms.threads.posts).toBe(1);
  });

  it('warns of a write that fails and keeps counting in memory', () => {
    writeFileSync(join(dir, 'blocker'), '');
    const warnings: string[] = [];
    const life = new Lifetime(join(dir, 'blocker', 'social-lifetime.json'), clock, (m) => warnings.push(m));
    life.add('reddit', 1_000, { posts: 1 });
    life.flush();
    expect(warnings).toHaveLength(1);
    expect(life.snapshot().platforms.reddit.posts).toBe(1);
  });

  it('reads counts that are not counts as zero and ignores platforms it does not know', () => {
    const life = new Lifetime(file, clock);
    life.flush();
    writeFileSync(file, JSON.stringify({
      sinceAt: '2026-01-01T00:00:00.000Z',
      platforms: { reddit: { ms: -5, posts: 'many', transcripts: 2, lastAt: 7 }, myspace: { ms: 1 } },
    }));
    const snap = new Lifetime(file, clock).snapshot();
    expect(snap.sinceAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snap.platforms.reddit).toEqual({ ms: 0, posts: 0, transcripts: 2 });
    expect(snap.platforms).not.toHaveProperty('myspace');
    expect(snap.platforms.youtube).toEqual({ ms: 0, posts: 0, transcripts: 0 });
  });
});
