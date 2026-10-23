/**
 * Comments the bot drafts and the person posts. A draft waits until the person posts or discards it
 * on the Social media page; the bot has no way to post one. Drafts and the comments posted (the last
 * `POSTED_KEPT`) are kept in `social-comments.json` in the deployment's data directory; the posted
 * ones count against the daily limit by their local date.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localClock } from './autoscroll.ts';
import { PLATFORM_IDS, type PlatformId } from './posts.ts';

/** Drafts that may wait at once. */
export const DRAFTS_MAX = 5;
/** Posted comments kept for the panel and the daily count. */
export const POSTED_KEPT = 50;

export interface CommentDraft {
  id: string;
  platform: PlatformId;
  /** The post or comment it replies to, as the bot gave it. */
  url: string;
  /** The platform's id of what it replies to; on Reddit `t3_` for a post, `t1_` for a comment. */
  target: string;
  text: string;
  /** ISO time it was drafted. */
  at: string;
}

export interface PostedComment {
  platform: PlatformId;
  url: string;
  /** The comment's own link, when the platform gave one. */
  link: string | null;
  text: string;
  /** The person changed the draft before posting it. */
  edited: boolean;
  /** ISO time it was posted. */
  at: string;
}

/** The platform turned a comment down; `detail` is its reason as it gave it. */
export class CommentRefused extends Error {
  constructor(readonly detail: string) { super(`the comment was refused: ${detail}`); }
}

interface Data {
  /** The number of the next draft's id. */
  next: number;
  drafts: CommentDraft[];
  /** Oldest first. */
  posted: PostedComment[];
}

const str = (v: unknown): v is string => typeof v === 'string';
const isPlatform = (v: unknown): v is PlatformId => (PLATFORM_IDS as readonly unknown[]).includes(v);

export class CommentStore {
  private data: Data;

  /** `warn` hears of a failed write; the store stays in memory and the next write tries again. */
  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly warn: (message: string) => void = () => {}) {
    this.data = this.load();
  }

  private load(): Data {
    const fresh: Data = { next: 1, drafts: [], posted: [] };
    if (!existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Record<keyof Data, unknown>>;
      if (Number.isInteger(raw.next) && (raw.next as number) > 0) fresh.next = raw.next as number;
      for (const d of Array.isArray(raw.drafts) ? raw.drafts as Array<Partial<CommentDraft>> : []) {
        if (str(d.id) && isPlatform(d.platform) && str(d.url) && str(d.target) && str(d.text) && str(d.at)) fresh.drafts.push({ id: d.id, platform: d.platform, url: d.url, target: d.target, text: d.text, at: d.at });
      }
      for (const p of Array.isArray(raw.posted) ? raw.posted as Array<Partial<PostedComment>> : []) {
        if (isPlatform(p.platform) && str(p.url) && str(p.text) && str(p.at)) fresh.posted.push({ platform: p.platform, url: p.url, link: str(p.link) ? p.link : null, text: p.text, edited: p.edited === true, at: p.at });
      }
    } catch {
      // an unreadable file starts again empty; the old one is kept beside it
      try { renameSync(this.file, `${this.file}.unreadable`); } catch { /* left as is */ }
    }
    return fresh;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`social comments not saved: ${(err as Error).message}`);
    }
  }

  /** The drafts waiting, oldest first. */
  drafts(): CommentDraft[] {
    return structuredClone(this.data.drafts);
  }

  draft(id: string): CommentDraft | undefined {
    const d = this.data.drafts.find((x) => x.id === id);
    return d && structuredClone(d);
  }

  add(d: Omit<CommentDraft, 'id' | 'at'>): CommentDraft {
    const draft: CommentDraft = { id: `c${this.data.next++}`, ...d, at: new Date(this.now()).toISOString() };
    this.data.drafts.push(draft);
    this.save();
    return structuredClone(draft);
  }

  /** Takes a draft away; the draft, or undefined when there was none. */
  remove(id: string): CommentDraft | undefined {
    const i = this.data.drafts.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [d] = this.data.drafts.splice(i, 1);
    this.save();
    return d;
  }

  /** Records the comment the draft `id` became, and takes the draft away. */
  record(id: string, posted: Omit<PostedComment, 'at'>): void {
    this.data.drafts = this.data.drafts.filter((x) => x.id !== id);
    this.data.posted.push({ ...posted, at: new Date(this.now()).toISOString() });
    this.data.posted = this.data.posted.slice(-POSTED_KEPT);
    this.save();
  }

  /** The comments posted, newest first. */
  posted(limit = POSTED_KEPT): PostedComment[] {
    return structuredClone(this.data.posted.slice(-limit).reverse());
  }

  /** Comments posted on today's local date in `timezone`. */
  today(timezone: string): number {
    const date = localClock(this.now(), timezone).date;
    return this.data.posted.filter((p) => localClock(Date.parse(p.at), timezone).date === date).length;
  }
}
