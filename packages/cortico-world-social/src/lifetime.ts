/**
 * The lifetime counter: time the bot has spent reading each platform, and what it read there, since
 * the counter started. Kept in `social-lifetime.json` in the deployment's data directory, written
 * at most every `SAVE_MS` and on stop. Time is wall time from the start of a read to its end,
 * daily autoscroll included; a login window the person uses is not counted.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PLATFORM_IDS, type PlatformId } from './posts.ts';

export interface PlatformTally {
  ms: number;
  posts: number;
  transcripts: number;
  /** ISO time of the last read. */
  lastAt?: string;
}

export interface LifetimeData {
  /** ISO time the counter started. */
  sinceAt: string;
  platforms: Record<PlatformId, PlatformTally>;
}

export const SAVE_MS = 5000;

const empty = (): PlatformTally => ({ ms: 0, posts: 0, transcripts: 0 });

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export class Lifetime {
  private data: LifetimeData;
  private timer: NodeJS.Timeout | null = null;

  /** `warn` hears of a failed write; the count stays in memory and the next write tries again. */
  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly warn: (message: string) => void = () => {}) {
    this.data = this.load();
  }

  private load(): LifetimeData {
    const fresh: LifetimeData = { sinceAt: new Date(this.now()).toISOString(), platforms: Object.fromEntries(PLATFORM_IDS.map((id) => [id, empty()])) as Record<PlatformId, PlatformTally> };
    if (!existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LifetimeData>;
      if (typeof raw.sinceAt === 'string') fresh.sinceAt = raw.sinceAt;
      for (const id of PLATFORM_IDS) {
        const t = (raw.platforms as Record<string, Partial<PlatformTally>> | undefined)?.[id];
        if (t) fresh.platforms[id] = { ms: count(t.ms), posts: count(t.posts), transcripts: count(t.transcripts), ...(typeof t.lastAt === 'string' ? { lastAt: t.lastAt } : {}) };
      }
    } catch {
      // an unreadable file starts a new count; the old one is kept beside it
      try { renameSync(this.file, `${this.file}.unreadable`); } catch { /* left as is */ }
    }
    return fresh;
  }

  /** Adds one read: its duration and what it returned. */
  add(platform: PlatformId, ms: number, read: { posts?: number; transcripts?: number }): void {
    const t = this.data.platforms[platform];
    t.ms += Math.max(0, Math.round(ms));
    t.posts += read.posts ?? 0;
    t.transcripts += read.transcripts ?? 0;
    t.lastAt = new Date(this.now()).toISOString();
    this.schedule();
  }

  snapshot(): LifetimeData {
    return structuredClone(this.data);
  }

  /** Starts the count again from now. */
  reset(): void {
    this.data = { sinceAt: new Date(this.now()).toISOString(), platforms: Object.fromEntries(PLATFORM_IDS.map((id) => [id, empty()])) as Record<PlatformId, PlatformTally> };
    this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_MS);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`social lifetime not saved: ${(err as Error).message}`);
    }
  }
}
