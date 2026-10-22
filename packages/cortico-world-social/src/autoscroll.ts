/**
 * Daily autoscroll: each job reads up to its count of posts once a day, from its local start time
 * on; a job whose time passed while the app was not running runs when it next starts that day.
 * What a run read is kept as a digest in `social-digests/` (the last `KEEP_DAYS` days), which the bot
 * reads with `social_digest` after the `social.digest` event.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutoscrollJob } from './config.ts';
import type { Skipped, StopReason } from './collect.ts';
import type { Post } from './posts.ts';

/** Days a digest is kept. */
export const KEEP_DAYS = 14;

/** Identifies a job across edits to its count or image setting. */
export const jobKey = (j: AutoscrollJob): string => `${j.platform}|${j.source}|${j.query}|${j.at}`;

/** The date (`YYYY-MM-DD`) and minutes since midnight at `atMs` in `timezone`. */
export function localClock(atMs: number, timezone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const minutesOf = (at: string): number => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

/**
 * Jobs whose start time today has passed and that have not run today, earliest first. Jobs with the
 * same `jobKey` are one job: the first of them is due.
 */
export function dueJobs(jobs: readonly AutoscrollJob[], lastRun: Readonly<Record<string, string>>, atMs: number, timezone: string): AutoscrollJob[] {
  const now = localClock(atMs, timezone);
  const keys = new Set<string>();
  return jobs
    .filter((j) => {
      const key = jobKey(j);
      if (keys.has(key)) return false;
      keys.add(key);
      return minutesOf(j.at) <= now.minutes && lastRun[key] !== now.date;
    })
    .sort((a, b) => minutesOf(a.at) - minutesOf(b.at));
}

export interface Digest {
  id: string;
  job: AutoscrollJob;
  startedAt: string;
  ms: number;
  posts: Post[];
  skipped: Skipped;
  stopped: StopReason;
  /** Set when the run failed before reading anything. */
  error?: string;
}

export interface DigestSummary {
  id: string;
  job: AutoscrollJob;
  startedAt: string;
  posts: number;
  error?: string;
}

const isDigest = (v: unknown): v is Digest => {
  const d = v as Partial<Digest> | null;
  return typeof d === 'object' && d !== null && typeof d.id === 'string' && typeof d.startedAt === 'string'
    && typeof d.job === 'object' && d.job !== null && Array.isArray(d.posts);
};

/** Digests on disk, and the date each job last ran (kept in `state.json` beside them). */
export class DigestStore {
  constructor(private readonly dir: string) {}

  private get stateFile(): string { return join(this.dir, 'state.json'); }

  lastRuns(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { lastRun?: Record<string, string> };
      return raw.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : {};
    } catch {
      return {};
    }
  }

  /** Records the date `job` last ran; `undefined` forgets it, so the job runs when next due. */
  markRun(job: AutoscrollJob, date: string | undefined): void {
    const lastRun = { ...this.lastRuns(), [jobKey(job)]: date };
    if (date === undefined) delete lastRun[jobKey(job)];
    this.write(this.stateFile, { lastRun });
  }

  save(d: Digest): void {
    this.write(join(this.dir, `${d.id}.json`), d);
    this.prune();
  }

  /** The digest `id` names; null for any other file, the run dates included. */
  get(id: string): Digest | null {
    if (!/^[\w-]+$/.test(id)) return null;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      const d: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return isDigest(d) ? d : null;
    } catch {
      return null;
    }
  }

  /** Ids of the digests kept, newest first (an id starts with its date). */
  ids(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== 'state.json').sort().reverse().map((f) => f.slice(0, -5));
  }

  /** The newest `max` digests kept, newest first. */
  list(max = Infinity): DigestSummary[] {
    return this.ids().slice(0, max)
      .map((id) => this.get(id))
      .filter((d): d is Digest => d !== null)
      .map((d) => ({ id: d.id, job: d.job, startedAt: d.startedAt, posts: d.posts.length, ...(d.error ? { error: d.error } : {}) }));
  }

  /** Removes every digest; the run dates stay, so today's jobs do not run again. */
  clear(): void {
    for (const id of this.ids()) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  private prune(): void {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    for (const d of this.list()) if (d.startedAt < cutoff) rmSync(join(this.dir, `${d.id}.json`), { force: true });
  }

  private write(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, file);
  }
}

/** A digest id: the local date, start time and platform, and a hash of the job, unique within a day. */
export const digestId = (date: string, job: AutoscrollJob): string =>
  `${date}-${job.at.replace(':', '')}-${job.platform}-${createHash('sha1').update(jobKey(job)).digest('hex').slice(0, 6)}`;
