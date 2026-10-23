/**
 * Comments the bot writes. A draft waits until the person posts or discards it on the Social media
 * page; the bot has no way to post one. With automatic comments or replies on, the World posts some
 * at once (`world.ts`). Drafts, the comments posted (the last `POSTED_KEPT`) and the watch on the
 * inbox are kept in `social-comments.json` in the deployment's data directory; the posted comments
 * count against the daily limit by their local date.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localClock } from './autoscroll.ts';
import { PLATFORM_IDS, type PlatformId } from './posts.ts';

/** Drafts that may wait at once. */
export const DRAFTS_MAX = 5;
/** Posted comments kept for the panel and the daily count. */
export const POSTED_KEPT = 50;
/** Replies looked at that are remembered, so none is told twice. */
export const SEEN_KEPT = 500;

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
  /** Posted without waiting for the person. */
  auto: boolean;
  /** The account an automatic answer to a reply answered. */
  to?: string;
  /** ISO time it was posted. */
  at: string;
}

/** A web address, a Markdown link, or a host on a common domain ending. */
const LINK = /https?:\/\/|www\.|\]\(|\b[a-z0-9-]+\.(com|net|org|io|co|me|ly|gg|xyz|info|biz|app|dev|link|site|shop|top|tv)\b/i;

/** Whether `text` holds a link; a comment that does is never posted without the person. */
export const hasLink = (text: string): boolean => LINK.test(text);

/** The platform turned a comment down; `detail` is its reason as it gave it. */
export class CommentRefused extends Error {
  constructor(readonly detail: string) { super(`the comment was refused: ${detail}`); }
}

/** The watch on the inbox while automatic replies are on. */
interface Watch {
  /** ISO time automatic replies were turned on; replies from before it get no answer. Null while off. */
  since: string | null;
  /** Ids of the replies looked at, the last `SEEN_KEPT`. */
  seen: string[];
  /** ISO time of the last look at the inbox. */
  checkedAt: string | null;
}

interface Data {
  /** The number of the next draft's id. */
  next: number;
  drafts: CommentDraft[];
  /** Oldest first. */
  posted: PostedComment[];
  watch: Watch;
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
    const fresh: Data = { next: 1, drafts: [], posted: [], watch: { since: null, seen: [], checkedAt: null } };
    if (!existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Record<keyof Data, unknown>>;
      if (Number.isInteger(raw.next) && (raw.next as number) > 0) fresh.next = raw.next as number;
      for (const d of Array.isArray(raw.drafts) ? raw.drafts as Array<Partial<CommentDraft>> : []) {
        if (str(d.id) && isPlatform(d.platform) && str(d.url) && str(d.target) && str(d.text) && str(d.at)) fresh.drafts.push({ id: d.id, platform: d.platform, url: d.url, target: d.target, text: d.text, at: d.at });
      }
      for (const p of Array.isArray(raw.posted) ? raw.posted as Array<Partial<PostedComment>> : []) {
        if (!isPlatform(p.platform) || !str(p.url) || !str(p.text) || !str(p.at)) continue;
        fresh.posted.push({ platform: p.platform, url: p.url, link: str(p.link) ? p.link : null, text: p.text, edited: p.edited === true, auto: p.auto === true, ...(str(p.to) ? { to: p.to } : {}), at: p.at });
      }
      const w = (raw.watch ?? {}) as Partial<Record<keyof Watch, unknown>>;
      fresh.watch = {
        since: str(w.since) ? w.since : null,
        seen: Array.isArray(w.seen) ? w.seen.filter(str).slice(-SEEN_KEPT) : [],
        checkedAt: str(w.checkedAt) ? w.checkedAt : null,
      };
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

  /** Records a comment posted, and takes away the draft `draftId` it was, if any. */
  record(posted: Omit<PostedComment, 'at'>, draftId?: string): void {
    this.data.drafts = this.data.drafts.filter((x) => x.id !== draftId);
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
    return this.postedToday(timezone).length;
  }

  /** Automatic answers posted to `account` on today's local date in `timezone`. */
  answeredToday(account: string, timezone: string): number {
    return this.postedToday(timezone).filter((p) => p.to?.toLowerCase() === account.toLowerCase()).length;
  }

  private postedToday(timezone: string): PostedComment[] {
    const date = localClock(this.now(), timezone).date;
    return this.data.posted.filter((p) => localClock(Date.parse(p.at), timezone).date === date);
  }

  /** When automatic replies were turned on: now, on the first look after they were. */
  watchSince(): string {
    if (!this.data.watch.since) {
      this.data.watch.since = new Date(this.now()).toISOString();
      this.save();
    }
    return this.data.watch.since;
  }

  /** Automatic replies are off: the next time they are on, replies from before then get no answer. */
  stopWatching(): void {
    if (!this.data.watch.since) return;
    this.data.watch.since = null;
    this.save();
  }

  get checkedAt(): string | null {
    return this.data.watch.checkedAt;
  }

  /** Whether the reply `target` was looked at already. */
  seen(target: string): boolean {
    return this.data.watch.seen.includes(target);
  }

  /** Remembers the replies looked at now, and when. */
  looked(targets: readonly string[]): void {
    const seen = this.data.watch.seen.filter((x) => !targets.includes(x));
    this.data.watch.seen = [...seen, ...targets].slice(-SEEN_KEPT);
    this.data.watch.checkedAt = new Date(this.now()).toISOString();
    this.save();
  }
}
