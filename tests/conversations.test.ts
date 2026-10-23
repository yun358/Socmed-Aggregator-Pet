/**
 * Saved conversations (core/conversations.ts): what a switch saves and keeps, the handoff the context's size
 * forces, what Coo may list, read and open against what the person may, and, on a real Core with Coo's
 * Persona, a new conversation and a reopened one as the main session ends up with them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ContextHandoffResult, World } from 'cortico/core/types.ts';
import { functionCall, functionResult, message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { Conversations, conversationSettings, transcriptLines, RECENT_DEFAULT, type ConversationSettings } from '../core/conversations.ts';
import { coopanionPersona } from '../core/persona.ts';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

const ctx = { role: 'main', log: { emit: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } } as never;

let at = Date.parse('2026-10-23T09:00:00Z');
const ts = () => new Date(at += 60_000).toISOString();

/** A message the person typed to the pet, as Core delivers it: one event in a frame. */
function said(text: string): ContextRecord {
  const body = `[typed] Ann: ${text}`;
  const t = ts();
  return message('user', body, { ts: t, frame: { events: [{ cursor: at, ts: t, type: 'desktop-pet.message', source: 'desktop-pet', start: 0, chars: body.length }] } });
}
/** Coo saying `script` with pet_say, and its receipt. */
function coo(script: string): ContextRecord[] {
  const id = `call_${at}`;
  return [functionCall(id, 'pet_say', JSON.stringify({ script }), { ts: ts() }), functionResult(id, '[pet_say] shown', { ts: ts() })];
}
const system = message('system', 'prefix');

function store(settings: Partial<ConversationSettings> = {}, live: () => readonly ContextRecord[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'coo-conversations-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = { enabled: true, recent: RECENT_DEFAULT, ...settings };
  const asked: number[] = [];
  const c = new Conversations({
    dir, settings: () => s, requestHandoff: () => { asked.push(1); return true; }, live,
    language: () => 'en', timezone: 'UTC', now: () => at,
  });
  const injected: string[] = [];
  let overflows = 0;
  const hooks = {
    overflow: async (): Promise<ContextHandoffResult> => { overflows++; return { tail: [] }; },
    speech: new Set(['pet_say']),
    inject: (text: string) => { injected.push(text); },
  };
  const tools = Object.fromEntries(c.tools(() => new Set(['pet_say'])).map((t) => [t.name, (args: Record<string, unknown> = {}) => t.handler(args, ctx)]));
  const text = async (p: Promise<unknown>) => { const r = await p; return typeof r === 'string' ? r : (r as { text: string }).text; };
  return { c, dir, s, asked, hooks, injected, overflows: () => overflows, tools, text };
}

/** Saves a conversation in which the person said `line`, through a new conversation. */
async function save(x: ReturnType<typeof store>, line: string) {
  expect(x.c.startNew()).toBeNull();
  return x.c.handoff([system, said(line), ...coo('Sure.')], x.hooks);
}

describe('switching conversations', () => {
  it('starts a new one: the one left is saved with its context, titled by what the person said first, and nothing is kept', async () => {
    const x = store();
    expect(x.c.startNew()).toBeNull();
    expect(x.asked).toHaveLength(1);
    expect(x.c.state().switching).toEqual({ kind: 'new' });
    const head = message('user', 'opening', { head: true });
    const result = await x.c.handoff([system, head, said('Plan a trip to Kyoto'), ...coo('Happy to【happy】help')], x.hooks);
    expect(result).toEqual({ tail: [] });
    expect(x.overflows()).toBe(0);
    expect(x.c.list()).toEqual([expect.objectContaining({ id: 1, title: 'Plan a trip to Kyoto', messages: 1, preview: 'Plan a trip to Kyoto' })]);
    expect(x.injected).toEqual([expect.stringContaining('#1 "Plan a trip to Kyoto"')]);
    expect(x.c.state().switching).toBeNull();
  });

  it('reopens a saved one where it was left, saving the running one; left again, its history holds each record once', async () => {
    const x = store();
    await save(x, 'Kyoto trip');
    const second = [said('Fix my bike'), ...coo('Which part is broken?')];
    expect(x.c.open(1)).toBeNull();
    const back = await x.c.handoff([system, ...second], x.hooks);
    expect(back.trim).toBe(true);
    expect(back.tail?.map((r) => (r.item as { id: string }).id)).toEqual(expect.arrayContaining([expect.stringMatching(/^msg_/)]));
    expect(transcriptLines(back.tail!, new Set(['pet_say']), 'Coo').join('\n')).toContain('Kyoto trip');
    // the bike conversation is saved, and the Kyoto one runs again
    expect(x.c.list().map((s) => s.title)).toEqual(['Fix my bike']);
    expect(x.injected.at(-1)).toMatch(/The person opened the saved conversation #1 "Kyoto trip".*saved as #2 "Fix my bike"/s);
    // the Kyoto conversation carries on and is left again: its history has the old records once, then the new
    const later = said('And hotels near the station?');
    expect(x.c.startNew()).toBeNull();
    await x.c.handoff([system, ...back.tail!, later], x.hooks);
    const lines = await x.text(x.tools.conversation_read({ id: 1 }));
    expect(lines.match(/\[typed\] Ann: Kyoto trip/g)).toHaveLength(1);
    expect(lines).toContain('And hotels near the station?');
    expect(x.c.list().map((s) => [s.id, s.messages])).toEqual([[1, 2], [2, 1]]);
  });

  it('leaves a handoff without a switch to Cormini, keeping the stretch it clears in the running conversation', async () => {
    const x = store();
    await x.c.handoff([system, said('First stretch'), ...coo('Noted.')], x.hooks);
    expect(x.overflows()).toBe(1);
    expect(x.c.list()).toEqual([]);
    await save(x, 'Second stretch');
    const read = await x.text(x.tools.conversation_read({ id: 1 }));
    expect(read).toContain('First stretch');
    expect(read).toContain('Second stretch');
    expect(read).toContain('Coo: Noted.');
    expect(x.c.list()[0]!.title).toBe('First stretch');
  });

  it('with saving off, switches nothing and saves nothing', async () => {
    const x = store({ enabled: false });
    expect(x.c.startNew()).toBe('off');
    expect(x.asked).toEqual([]);
    await x.c.handoff([system, said('hello')], x.hooks);
    expect(x.overflows()).toBe(1);
    expect(existsSync(join(x.dir, 'index.json'))).toBe(false);
  });

  it('takes one switch at a time, saves no conversation with nothing in it, and deletes one with its file', async () => {
    const x = store();
    expect(x.c.startNew()).toBeNull();
    expect(x.c.startNew()).toBe('busy');
    await x.c.handoff([system], x.hooks);
    expect(x.c.list()).toEqual([]);
    expect(x.injected).toEqual([expect.not.stringContaining('saved as')]);
    await save(x, 'gone soon');
    const id = x.c.list()[0]!.id;
    expect(existsSync(join(x.dir, `${id}.json`))).toBe(true);
    expect(x.c.delete(id)).toBe(true);
    expect(x.c.delete(id)).toBe(false);
    expect(existsSync(join(x.dir, `${id}.json`))).toBe(false);
    expect(x.c.open(id)).toBe('missing');
  });

  it('discards what a cleared conversation had, its history included', async () => {
    const x = store();
    await x.c.handoff([system, said('cleared away')], x.hooks);
    x.c.cleared();
    await save(x, 'after the clear');
    const read = await x.text(x.tools.conversation_read({ id: x.c.list()[0]!.id }));
    expect(read).not.toContain('cleared away');
    expect(read).toContain('after the clear');
  });

  it('keeps what it saved across a restart', async () => {
    const x = store();
    await save(x, 'remember me');
    const again = new Conversations({ dir: x.dir, settings: () => x.s, requestHandoff: () => true, language: () => 'en', timezone: 'UTC' });
    expect(again.list().map((s) => s.title)).toEqual(['remember me']);
  });
});

describe("Coo's tools", () => {
  it('list, read and open only the most recent conversations the setting allows; the person opens any', async () => {
    const x = store({ recent: 2 });
    for (const line of ['oldest', 'middle', 'newest']) await save(x, line);
    const list = await x.text(x.tools.conversation_list());
    expect(list).toContain('#3 "newest"');
    expect(list).toContain('#2 "middle"');
    expect(list).not.toContain('oldest');
    expect(list).toContain('the 1 older ones only the person can open');
    const refused = await x.tools.conversation_open({ id: 1 }) as { text: string; failed?: boolean };
    expect(refused.failed).toBe(true);
    expect(refused.text).toContain('not among the 2 most recent');
    expect(((await x.tools.conversation_read({ id: 1 })) as { failed?: boolean }).failed).toBe(true);
    expect(x.c.open(1)).toBeNull();
  });

  it('say when no past conversation may be opened, and when a switch is already coming', async () => {
    const x = store({ recent: 0 });
    await save(x, 'something');
    expect(await x.text(x.tools.conversation_list())).toContain('set the number of past conversations you may open to 0');
    expect(await x.text(x.tools.conversation_new({ title: 'Trip plans' }))).toContain('saved as "Trip plans"');
    expect(await x.text(x.tools.conversation_new())).toContain('already coming');
  });

  it('save the conversation under the title Coo gives', async () => {
    const x = store();
    await x.tools.conversation_new({ title: 'Bike repair' });
    await x.c.handoff([system, said('my chain fell off')], x.hooks);
    expect(x.c.list()[0]!.title).toBe('Bike repair');
  });

  it('read a conversation a page at a time: what the person said and what Coo spoke', async () => {
    const x = store();
    const many = Array.from({ length: 40 }, (_, i) => said(`line ${i} ${'x'.repeat(300)}`));
    expect(x.c.startNew()).toBeNull();
    await x.c.handoff([system, ...many, ...coo('Done【nod】<happy>now')], x.hooks);
    const first = await x.text(x.tools.conversation_read({ id: 1 }));
    expect(first.split('\n')[0]).toMatch(/lines 1–\d+ of 41/);
    const next = Number(/from=(\d+)/.exec(first)![1]);
    const last = await x.text(x.tools.conversation_read({ id: 1, from: 39 }));
    expect(last).toContain('Coo: Done now');
    expect(next).toBeGreaterThan(1);
  });
});

describe('the settings', () => {
  it('read on by default with 20 conversations Coo may open, and clamp the number to 0–100', () => {
    expect(conversationSettings(() => undefined)).toEqual({ enabled: true, recent: RECENT_DEFAULT });
    expect(conversationSettings((p) => (p.endsWith('enabled') ? false : 500))).toEqual({ enabled: false, recent: 100 });
    expect(conversationSettings((p) => (p.endsWith('recent') ? -3 : true))).toEqual({ enabled: true, recent: 0 });
  });
});

describe('on a real Core with Coo’s Persona', () => {
  it('a new conversation clears the main session and a reopened one puts its context back', async () => {
    const CORTICO = resolve(import.meta.dirname, '../vendor/cortico');
    const { Cormini } = await import('../vendor/cortico/bots/cormini/persona/persona.ts');
    const { createBot } = await import('cortico/bot.ts');
    const { loadDeployment } = await import('cortico/deploy.ts');
    const { withWorlds } = await import('cortico/world.ts');
    const { CONSOLE } = await import('cortico/worlds/console/definition.ts');
    const cormini = (await import(join(CORTICO, 'bots', 'cormini', 'index.ts'))).default;
    const dir = mkdtempSync(join(tmpdir(), 'coo-conversations-core-'));
    mkdirSync(join(dir, 'providers', 'fixture'), { recursive: true });
    writeFileSync(join(dir, 'providers', 'fixture', 'config.json'), JSON.stringify({ kind: 'openai-responses-compat', baseUrl: 'http://127.0.0.1:9/v1', spec: { model: 'test-model', thinking: false } }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ activeProvider: 'fixture' }));
    const Persona = coopanionPersona(Cormini);
    let bot: Awaited<ReturnType<typeof createBot>> | null = null;
    let conversations: Conversations | null = null;
    const definition = withWorlds({
      ...cormini,
      build: (loaded: { config: { context: never; rounds: { soft: number; hard: number } }; memoryDir: string; dataDir: string }, worlds: World[]) => {
        const persona = new Persona({ memoryDir: loaded.memoryDir, context: () => loaded.config.context, rounds: { ...loaded.config.rounds }, worlds });
        conversations = new Conversations({
          dir: join(loaded.dataDir, 'conversations'), settings: () => ({ enabled: true, recent: 20 }),
          requestHandoff: () => bot!.core.loop.requestContextHandoff(), live: () => bot!.core.session.records,
          language: () => 'en', timezone: 'UTC',
        });
        persona.conversations = conversations;
        return { persona };
      },
    }, [CONSOLE]);
    const loaded = loadDeployment(definition, dir, CORTICO);
    loaded.config.web.port = 0;
    bot = createBot(loaded, definition, {});
    bot.core.bus.setPaused(true);
    await bot.start();
    cleanup.push(async () => { await bot!.shutdown('test'); rmSync(dir, { recursive: true, force: true }); });
    const session = bot.core.session;
    const texts = () => session.records.map((r) => JSON.stringify(r.item));

    for (const r of [said('Plan a trip to Kyoto'), ...coo('Gladly.')]) session.append(r);
    expect(conversations!.state().current).toMatchObject({ messages: 1, preview: 'Plan a trip to Kyoto' });
    expect(conversations!.startNew()).toBeNull();
    await expect.poll(() => conversations!.list().length).toBe(1);
    await expect.poll(() => texts().some((t) => t.includes('Kyoto'))).toBe(false);
    expect(session.records.every((r) => (r.item as { role?: string }).role === 'system')).toBe(true);

    session.append(said('Fix my bike'));
    expect(conversations!.open(1)).toBeNull();
    await expect.poll(() => texts().some((t) => t.includes('Kyoto'))).toBe(true);
    expect(texts().some((t) => t.includes('Gladly.'))).toBe(true);
    expect(texts().some((t) => t.includes('Fix my bike'))).toBe(false);
    expect(conversations!.list().map((s) => s.title)).toEqual(['Fix my bike']);
  });
});
