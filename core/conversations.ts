/**
 * Saved conversations, as in a chat app. With `companion.conversations.enabled` on, the running
 * conversation (Core's main session) can be put away and a new one started, or a saved one brought back.
 *
 * A switch is a Core handoff (`requestContextHandoff`): it runs once Coo's turn ends, or at once while Coo is
 * idle, and the Persona's `onHandoff` asks `handoff()` here what to keep (`persona.ts`). The conversation being
 * left is saved, and the context kept is nothing (a new conversation) or the context a saved one was left with
 * (reopened, it carries on from there). A handoff the context's size forces stays Cormini's own (an empty
 * context and a handoff note); the stretch it clears is added to the running conversation's history, so a
 * saved conversation keeps everything that was said in it.
 *
 * Coo lists, reads and reopens the `companion.conversations.recent` most recently left ones (0–100); the
 * settings window's Conversations page lists them all and opens any of them. Workspace files and memory are
 * the same in every conversation.
 *
 * On disk under `<data>/conversations/`: `index.json` (the running conversation and the saved ones, most
 * recently left first) and `<id>.json` per conversation: its whole history, and the context it was left with.
 *
 * Tool descriptions are English; receipts and the lines Coo reads after a switch are in the model-text language.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextHandoffResult, ToolDef } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { ModelLanguage } from './language.ts';

/** The most saved conversations Coo may list and open; older ones are opened from the settings window. */
export const RECENT_MAX = 100;
export const RECENT_DEFAULT = 20;
/** Config keys of the `companion` group. */
export const ENABLED_KEY = 'companion.conversations.enabled';
export const RECENT_KEY = 'companion.conversations.recent';

/** Events that carry what the person said: typed or spoken to the pet, or sent from the chat page. */
const PERSON_EVENTS: ReadonlySet<string> = new Set(['desktop-pet.message', 'desktop-pet.speech', 'console.message']);
/** Cormini's handoff note: an account of the stretch before it, which the history already holds. */
const HANDOFF_NOTE = 'handoff-note';
const TITLE_CHARS = 48;
const PREVIEW_CHARS = 120;
/** Characters of one line in a transcript page. */
const LINE_CHARS = 600;
const PAGE_CHARS = 8000;
/** A switch whose handoff has not come by then is dropped: it was asked for while Core was stopping. */
const PENDING_MS = 30 * 60_000;

export interface ConversationSummary {
  id: number;
  title: string;
  /** Local `YYYY-MM-DD HH:MM` of its first record. */
  startedAt: string;
  /** Local `YYYY-MM-DD HH:MM` it was last left. */
  endedAt: string;
  /** Messages the person sent in it. */
  messages: number;
  /** The first thing the person said, cut. */
  preview: string;
}

interface Running { id: number; title: string | null }
interface Index { next: number; current: Running; saved: ConversationSummary[] }
interface Stored { history: ContextRecord[]; context: ContextRecord[] }

type Switch =
  | { kind: 'new'; by: 'coo' | 'person'; title: string | null }
  | { kind: 'open'; by: 'coo' | 'person'; id: number; title: string | null };

export interface ConversationSettings { enabled: boolean; recent: number }

export interface ConversationsOptions {
  dir: string;
  /** `companion.conversations` as the live config has it, read at each use. */
  settings: () => ConversationSettings;
  /** Asks Core for a handoff at its next safe point; false when one is already coming. */
  requestHandoff: () => boolean;
  /** The running conversation's records, for the settings window's line about it. */
  live?: () => readonly ContextRecord[];
  /** The model-text language, read at each use. */
  language: () => ModelLanguage;
  now?: () => number;
  timezone: string;
}

/** What the Persona's handoff lends: Cormini's own handoff, the speaking tools, and a line into the next batch. */
export interface HandoffHooks {
  overflow: () => Promise<ContextHandoffResult>;
  speech: ReadonlySet<string>;
  inject: (text: string) => void;
}

/** What the Conversations page shows. */
export interface ConversationsState {
  enabled: boolean;
  recent: number;
  recentMax: number;
  current: { messages: number; preview: string; startedAt: string | null };
  /** Every saved conversation, most recently left first; the first `recent` are the ones Coo may open. */
  saved: ConversationSummary[];
  /** The switch asked for and not yet made. */
  switching: { kind: 'new' } | { kind: 'open'; id: number } | null;
}

/** Reads a value of `companion.conversations` as the settings window and Coo see it. */
export function conversationSettings(read: (path: string) => unknown): ConversationSettings {
  const recent = Number(read(RECENT_KEY));
  return {
    enabled: read(ENABLED_KEY) !== false,
    recent: Number.isInteger(recent) ? Math.min(RECENT_MAX, Math.max(0, recent)) : RECENT_DEFAULT,
  };
}

/* ---------- reading records ---------- */

const role = (r: ContextRecord): string | undefined => (r.item as { role?: string }).role;

function textOf(r: ContextRecord): string {
  const item = r.item as { content?: unknown; output?: unknown };
  const parts = item.content ?? item.output;
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p as { text?: string }).text ?? '').join('');
}

/** What the conversation keeps of a context: no system prefix, no synthetic opening, nothing ephemeral. */
const kept = (records: readonly ContextRecord[]): ContextRecord[] =>
  records.filter((r) => role(r) !== 'system' && role(r) !== 'developer' && !r.context.head && !r.context.ephemeral);

const recordKey = (r: ContextRecord): string | null => (r.item as { id?: string }).id ?? null;

const local = (iso: string | undefined): string | null => {
  const m = iso ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso) : null;
  return m ? `${m[1]} ${m[2]}` : null;
};

/** The events of a delivered message, each with its type and time; a message without them is one untyped entry. */
function events(r: ContextRecord): Array<{ type: string | null; ts?: string; text: string }> {
  const text = textOf(r);
  const refs = r.context.frame?.events;
  if (!refs?.length) return text.trim() ? [{ type: null, ts: r.context.ts, text }] : [];
  return refs.map((e) => ({ type: e.type, ts: e.ts, text: text.slice(e.start, e.start + e.chars) })).filter((e) => e.text.trim());
}

/** A person's message without the event's own label: `[voice] Ann: hi` and `Ann: hi` read `hi`. */
function said(text: string): string {
  return text.replace(/^(\s*\[[^\]\n]{1,40}\])+\s*/, '').replace(/^[^\n:：]{1,30}[:：]\s*/, '').replace(/\s+/g, ' ').trim();
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** `ms` as local `YYYY-MM-DD HH:MM` in `timezone`. */
function stamp(ms: number, timezone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** What the person said in `records`, in order. */
function personLines(records: readonly ContextRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (role(r) !== 'user') continue;
    for (const e of events(r)) if (e.type && PERSON_EVENTS.has(e.type)) out.push(said(e.text));
  }
  return out.filter(Boolean);
}

/** What a call to a speaking tool said: pet_say's script without its markers, pet_ask's question, console_send's text. */
function spoken(args: string): string {
  let a: Record<string, unknown>;
  try { a = JSON.parse(args) as Record<string, unknown>; } catch { return ''; }
  const text = [a.script, a.question, a.text, a.message].find((v): v is string => typeof v === 'string') ?? '';
  const options = Array.isArray(a.options) ? ` (${a.options.filter((o) => typeof o === 'string').join(' / ')})` : '';
  return `${text.replace(/【[^】]*】|<[^>\n]*>/g, ' ').replace(/\s+/g, ' ').trim()}${options}`;
}

/** The conversation as lines to read: the events Coo received, and what it said with its speaking tools. */
export function transcriptLines(records: readonly ContextRecord[], speech: ReadonlySet<string>, coo: string): string[] {
  const out: string[] = [];
  for (const r of records) {
    const item = r.item as { type?: string; name?: string; arguments?: string };
    if (role(r) === 'user') {
      for (const e of events(r)) {
        // the Persona's own bracketed notes and Cormini's handoff notes are not part of the conversation
        if (e.type === HANDOFF_NOTE || (!e.type && /^\s*\[system\]/.test(e.text))) continue;
        out.push(`${local(e.ts) ?? ''} ${cut(e.text.replace(/\s+/g, ' ').trim(), LINE_CHARS)}`.trim());
      }
    } else if (item.type === 'function_call' && item.name && speech.has(item.name)) {
      const line = spoken(item.arguments ?? '');
      if (line) out.push(`${local(r.context.ts) ?? ''} ${coo}: ${cut(line, LINE_CHARS)}`.trim());
    }
  }
  return out;
}

/* ---------- model text ---------- */

const zh = {
  coo: 'Coo',
  untitled: (when: string) => `${when} 的对话`,
  newStarted: (by: 'coo' | 'person', saved: string | null) =>
    `[system] ${by === 'person' ? '对方在设置窗口开始了新对话。' : '新对话开始了。'}${saved ? `上一段已存为 ${saved},conversation_list 与 conversation_open 能找回。` : ''}工作区的文件和记忆都还在。`,
  reopened: (by: 'coo' | 'person', which: string, saved: string | null) =>
    `[system] ${by === 'person' ? '对方在设置窗口打开了' : '回到了'}已存的对话 ${which}:上面就是它离开时的上下文,从这里接着聊。${saved ? `刚才那段已存为 ${saved}。` : ''}`,
  ref: (id: number, title: string) => `#${id}「${title}」`,
  willNew: (title: string) => `[conversation_new] 这一轮结束时,当前对话存为「${title}」,随后开始新对话。想对对方说的,这一轮里说完。`,
  willOpen: (which: string) => `[conversation_open] 这一轮结束时,当前对话存档,回到 ${which} 离开时的地方。想对对方说的,这一轮里说完。`,
  already: (tool: string) => `[${tool} 没执行] 这一轮结束时已经要切换对话了。`,
  off: (tool: string) => `[${tool} 没执行] 对方在设置窗口关掉了保存对话。`,
  noRecent: '[conversation_list] 对方把你能打开的过往对话数设成了 0;对方可以在设置窗口的「对话」页打开任何一段。',
  none: '[conversation_list] 还没有存下的对话。',
  listHead: (n: number, total: number) => `[conversation_list] 最近存下的 ${n} 段对话(你能打开或阅读的${total > n ? `;更早的 ${total - n} 段只能由对方在设置窗口打开` : ''}):`,
  listLine: (s: ConversationSummary) => `- #${s.id}「${s.title}」 ${s.startedAt}–${s.endedAt},对方 ${s.messages} 条消息${s.preview ? `,开头:${s.preview}` : ''}`,
  missing: (tool: string, id: string) => `[${tool} 没执行] 没有存下的对话 ${id}。`,
  outside: (tool: string, id: number, n: number) => `[${tool} 没执行] #${id} 不在你能打开的最近 ${n} 段对话里;对方可以在设置窗口的「对话」页打开它。`,
  readHead: (which: string, from: number, to: number, total: number) => `[conversation_read] ${which},第 ${from}–${to} 行,共 ${total} 行:`,
  readEmpty: (which: string) => `[conversation_read] ${which} 里没有可读的内容。`,
  readMore: (next: number) => `后面还有:conversation_read 带 from=${next}。`,
  readPast: (total: number) => `[conversation_read 没执行] from 超出了范围,这段对话共 ${total} 行。`,
};

const en: typeof zh = {
  coo: 'Coo',
  untitled: (when) => `Conversation of ${when}`,
  newStarted: (by, saved) =>
    `[system] ${by === 'person' ? 'The person started a new conversation in the settings window.' : 'A new conversation has started.'}${saved ? ` The last one is saved as ${saved}; conversation_list and conversation_open bring it back.` : ''} Your workspace files and memory are all still there.`,
  reopened: (by, which, saved) =>
    `[system] ${by === 'person' ? 'The person opened' : 'You are back in'} the saved conversation ${which}: everything above is its context as it was left, and it carries on from here.${saved ? ` The conversation before it is saved as ${saved}.` : ''}`,
  ref: (id, title) => `#${id} "${title}"`,
  willNew: (title) => `[conversation_new] When this turn ends, this conversation is saved as "${title}" and a new one starts. Say what you want to say to the person in this turn.`,
  willOpen: (which) => `[conversation_open] When this turn ends, this conversation is saved and ${which} comes back where it was left. Say what you want to say to the person in this turn.`,
  already: (tool) => `[${tool} not run] A switch of conversations is already coming when this turn ends.`,
  off: (tool) => `[${tool} not run] The person has turned off saving conversations in the settings window.`,
  noRecent: '[conversation_list] The person has set the number of past conversations you may open to 0; they can open any of them on the Conversations page of the settings window.',
  none: '[conversation_list] No conversations are saved yet.',
  listHead: (n, total) => `[conversation_list] The ${n} most recently saved conversations (the ones you may open or read${total > n ? `; the ${total - n} older ones only the person can open, in the settings window` : ''}):`,
  listLine: (s) => `- #${s.id} "${s.title}" ${s.startedAt} to ${s.endedAt}, ${s.messages} messages from the person${s.preview ? `, began with: ${s.preview}` : ''}`,
  missing: (tool, id) => `[${tool} not run] There is no saved conversation ${id}.`,
  outside: (tool, id, n) => `[${tool} not run] #${id} is not among the ${n} most recent conversations you may open; the person can open it on the Conversations page of the settings window.`,
  readHead: (which, from, to, total) => `[conversation_read] ${which}, lines ${from}–${to} of ${total}:`,
  readEmpty: (which) => `[conversation_read] ${which} has nothing to read.`,
  readMore: (next) => `More follows: conversation_read with from=${next}.`,
  readPast: (total) => `[conversation_read not run] from is past the end; the conversation has ${total} lines.`,
};

const TEXT: Record<ModelLanguage, typeof zh> = { zh, en };

/* ---------- tools ---------- */

const TITLE = { type: 'string', description: 'A short title for the conversation being saved (the current one). Without one, the first thing the person said in it names it.' };
const ID = { type: 'integer', minimum: 1, description: 'The conversation\'s number, as conversation_list gives it.' };

export const CONVERSATION_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'conversation_new',
    tags: ['write'],
    description: 'Save the current conversation and start a new one, as in a chat app, once this turn ends: the context is cleared, and the saved conversation can be reopened or read later. Use it when the person asks for a new conversation or to start over on another subject. Workspace files and memory stay as they are.',
    parameters: { type: 'object', properties: { title: TITLE } },
  },
  {
    name: 'conversation_list',
    tags: ['read'],
    description: 'List the saved conversations you may reopen or read, most recently left first: number, title, when, how many messages the person sent and how each began.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'conversation_open',
    tags: ['write'],
    description: 'Save the current conversation and go back to a saved one, once this turn ends: the context becomes the one that conversation was left with, and it carries on from there. Use it when the person wants to continue an earlier conversation; conversation_list shows the ones you may open.',
    parameters: { type: 'object', properties: { id: ID, title: TITLE }, required: ['id'] },
  },
  {
    name: 'conversation_read',
    tags: ['read'],
    description: 'Read what was said in a saved conversation without leaving this one, a page at a time: what the person said and did, and what you said.',
    parameters: { type: 'object', properties: { id: ID, from: { type: 'integer', minimum: 1, description: 'The first line to show; default 1.' } }, required: ['id'] },
  },
];

/* ---------- the store ---------- */

export class Conversations {
  private index: Index;
  private asked: (Switch & { at: number }) | null = null;

  constructor(private readonly o: ConversationsOptions) {
    this.index = this.load();
  }

  private get t(): typeof zh { return TEXT[this.o.language()]; }
  private now(): number { return this.o.now?.() ?? Date.now(); }

  /** The switch asked for and not yet made. */
  private get pending(): Switch | null {
    if (this.asked && this.now() - this.asked.at > PENDING_MS) this.asked = null;
    return this.asked;
  }

  get settings(): ConversationSettings { return this.o.settings(); }

  private file(id: number): string { return join(this.o.dir, `${id}.json`); }

  private load(): Index {
    const fresh: Index = { next: 2, current: { id: 1, title: null }, saved: [] };
    const path = join(this.o.dir, 'index.json');
    if (!existsSync(path)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Index>;
      if (typeof raw.next !== 'number' || !raw.current || !Array.isArray(raw.saved)) return fresh;
      return { next: raw.next, current: raw.current, saved: raw.saved };
    } catch {
      // an unreadable index starts afresh; the conversation files stay beside it
      return fresh;
    }
  }

  private write(path: string, value: unknown): void {
    mkdirSync(this.o.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }

  private saveIndex(): void { this.write(join(this.o.dir, 'index.json'), this.index); }

  private stored(id: number): Stored {
    try {
      const raw = JSON.parse(readFileSync(this.file(id), 'utf8')) as Partial<Stored>;
      return { history: Array.isArray(raw.history) ? raw.history : [], context: Array.isArray(raw.context) ? raw.context : [] };
    } catch {
      return { history: [], context: [] };
    }
  }

  /** Adds `records` to the conversation's history, each record once (a reopened conversation's context is already in it). */
  private remember(id: number, records: readonly ContextRecord[], context?: readonly ContextRecord[]): Stored {
    const s = this.stored(id);
    const seen = new Set(s.history.map(recordKey).filter((k): k is string => k !== null));
    for (const r of records) {
      const key = recordKey(r);
      if (key !== null && seen.has(key)) continue;
      if (key !== null) seen.add(key);
      s.history.push(r);
    }
    if (context) s.context = [...context];
    this.write(this.file(id), s);
    return s;
  }

  /** Saved conversations, most recently left first: all of them, or the ones Coo may open. */
  list(all = true): ConversationSummary[] {
    return all ? [...this.index.saved] : this.index.saved.slice(0, this.settings.recent);
  }

  state(): ConversationsState {
    const { enabled, recent } = this.settings;
    const live = kept(this.o.live?.() ?? []);
    const lines = personLines(live);
    const first = live.find((r) => r.context.ts)?.context.ts;
    const p = this.pending;
    return {
      enabled, recent, recentMax: RECENT_MAX,
      current: { messages: lines.length, preview: cut(lines[0] ?? '', PREVIEW_CHARS), startedAt: local(first) },
      saved: this.list(),
      switching: !p ? null : p.kind === 'new' ? { kind: 'new' } : { kind: 'open', id: p.id },
    };
  }

  /** Asks for a switch; the reason it cannot be asked for, or null. Coo may open only the most recent `recent`. */
  private ask(s: Switch): 'off' | 'busy' | 'missing' | 'outside' | null {
    if (!this.settings.enabled) return 'off';
    if (this.pending) return 'busy';
    if (s.kind === 'open') {
      const at = this.index.saved.findIndex((c) => c.id === s.id);
      if (at < 0) return 'missing';
      if (s.by === 'coo' && at >= this.settings.recent) return 'outside';
    }
    this.asked = { ...s, at: this.now() };
    // false: a handoff is already coming (asked for this batch, or under way), and it takes this switch
    this.o.requestHandoff();
    return null;
  }

  /** The settings window's New conversation and Open: the reason it cannot, or null. */
  startNew(): string | null { return this.ask({ kind: 'new', by: 'person', title: null }); }
  open(id: number): string | null { return this.ask({ kind: 'open', by: 'person', id, title: null }); }

  /**
   * The running conversation was cleared (the System prompt page's Clear conversation and restart): what it
   * had is discarded, its history included, and what comes next is a conversation of its own.
   */
  cleared(): void {
    rmSync(this.file(this.index.current.id), { force: true });
    this.index.current = { id: this.index.next++, title: null };
    this.saveIndex();
  }

  /** Removes a saved conversation and its file. */
  delete(id: number): boolean {
    const at = this.index.saved.findIndex((c) => c.id === id);
    if (at < 0) return false;
    this.index.saved.splice(at, 1);
    this.saveIndex();
    rmSync(this.file(id), { force: true });
    return true;
  }

  /** A conversation's title: the one given, else what the person said first in it, else when it began. */
  private titleOf(given: string | null, records: readonly ContextRecord[]): string {
    const first = records.find((r) => r.context.ts)?.context.ts;
    return cut(given?.trim() || personLines(records)[0] || this.t.untitled(local(first) ?? stamp(this.now(), this.o.timezone)), TITLE_CHARS);
  }

  /** The summary of a conversation left now with `history`. */
  private summary(id: number, title: string | null, history: readonly ContextRecord[]): ConversationSummary {
    const lines = personLines(history);
    const now = stamp(this.now(), this.o.timezone);
    return {
      id,
      title: this.titleOf(title, history),
      startedAt: local(history.find((r) => r.context.ts)?.context.ts) ?? now,
      endedAt: now,
      messages: lines.length,
      preview: cut(lines[0] ?? '', PREVIEW_CHARS),
    };
  }

  /**
   * The Persona's handoff. With a switch asked for: the running conversation is saved with the context it is
   * left with, and the kept context is nothing or the reopened conversation's. Without one, the handoff is the
   * context's own: the stretch it clears goes into the running conversation's history first. A conversation
   * nobody said anything in, with nothing in its context, is not saved.
   */
  async handoff(snapshot: readonly ContextRecord[], hooks: HandoffHooks): Promise<ContextHandoffResult> {
    const s = this.pending;
    this.asked = null;
    const left = kept(snapshot);
    const running = this.index.current;
    if (!s) {
      if (this.settings.enabled && left.length) this.remember(running.id, left);
      return hooks.overflow();
    }
    const t = this.t;
    let saved: string | null = null;
    if (left.length) {
      const { history } = this.remember(running.id, left, left);
      const summary = this.summary(running.id, s.title ?? running.title, history);
      this.index.saved = [summary, ...this.index.saved.filter((c) => c.id !== running.id)];
      saved = t.ref(summary.id, summary.title);
    }
    if (s.kind === 'new') {
      this.index.current = { id: this.index.next++, title: null };
      this.saveIndex();
      hooks.inject(t.newStarted(s.by, saved));
      return { tail: [] };
    }
    const back = this.index.saved.find((c) => c.id === s.id);
    if (!back) {
      // deleted while the switch waited: a new conversation instead
      this.index.current = { id: this.index.next++, title: null };
      this.saveIndex();
      hooks.inject(t.newStarted(s.by, saved));
      return { tail: [] };
    }
    this.index.saved = this.index.saved.filter((c) => c.id !== s.id);
    this.index.current = { id: back.id, title: back.title };
    this.saveIndex();
    hooks.inject(t.reopened(s.by, t.ref(back.id, back.title), saved));
    // Core trims an old context that no longer fits the model from its start
    return { tail: this.stored(back.id).context, trim: true };
  }

  /** Coo's tools; `speech` names its speaking tools, for transcripts. */
  tools(speech: () => ReadonlySet<string>): ToolDef[] {
    const which = (s: ConversationSummary) => this.t.ref(s.id, s.title);
    const idOf = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const refuse = (tool: string, why: 'off' | 'busy' | 'missing' | 'outside', id?: unknown) => {
      const t = this.t;
      const text = why === 'busy' ? t.already(tool)
        : why === 'off' ? t.off(tool)
        : why === 'outside' ? t.outside(tool, Number(id), this.settings.recent)
        : t.missing(tool, `#${String(id)}`);
      return { text, failed: true as const };
    };
    const title = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const handlers: Record<string, ToolDef['handler']> = {
      conversation_new: async (args) => {
        const why = this.ask({ kind: 'new', by: 'coo', title: title(args.title) });
        if (why) return refuse('conversation_new', why);
        return { text: this.t.willNew(this.titleOf(title(args.title) ?? this.index.current.title, kept(this.o.live?.() ?? []))) };
      },
      conversation_list: async () => {
        const t = this.t;
        const { recent } = this.settings;
        if (recent === 0) return { text: t.noRecent };
        const shown = this.list(false);
        if (!shown.length) return { text: t.none };
        return { text: [t.listHead(shown.length, this.index.saved.length), ...shown.map((s) => t.listLine(s))].join('\n') };
      },
      conversation_open: async (args) => {
        const id = idOf(args.id);
        if (id === null) return refuse('conversation_open', 'missing', args.id);
        const why = this.ask({ kind: 'open', by: 'coo', id, title: title(args.title) });
        if (why) return refuse('conversation_open', why, id);
        return { text: this.t.willOpen(which(this.index.saved.find((c) => c.id === id)!)) };
      },
      conversation_read: async (args) => {
        const t = this.t;
        const id = idOf(args.id);
        const at = id === null ? -1 : this.index.saved.findIndex((c) => c.id === id);
        if (at < 0) return refuse('conversation_read', 'missing', args.id);
        if (at >= this.settings.recent) return refuse('conversation_read', 'outside', id);
        const s = this.index.saved[at]!;
        const lines = transcriptLines(this.stored(s.id).history, speech(), t.coo);
        if (!lines.length) return { text: t.readEmpty(which(s)) };
        const from = idOf(args.from) ?? 1;
        if (from > lines.length) return { text: t.readPast(lines.length), failed: true as const };
        let used = 0;
        let to = from - 1;
        while (to < lines.length && (to === from - 1 || used + lines[to]!.length <= PAGE_CHARS)) used += lines[to++]!.length + 1;
        return {
          text: [t.readHead(which(s), from, to, lines.length), ...lines.slice(from - 1, to), ...(to < lines.length ? [t.readMore(to + 1)] : [])].join('\n'),
        };
      },
    };
    return CONVERSATION_TOOL_DECLS.map((decl) => ({ ...decl, handler: handlers[decl.name]! }));
  }
}
