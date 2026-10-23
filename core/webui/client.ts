/**
 * Console panels of the coopanion World, built by scripts/stage.ts into build/panels/coopanion/:
 *
 * - `alarms`: the alarms Coo has set for itself, soonest first, each with a button that deletes it (the
 *   World tells Coo). Times are shown in the deployment's time zone, as Coo set them.
 * - `conversations`: saved conversations (`conversations.ts`): the switch and how many of the most recent Coo
 *   may open, the running conversation with New conversation, and every saved one with Open and Delete.
 *   The two settings are keys of Coopanion's `companion` config group, written through `/api/config`.
 */
import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import type { Alarm } from '../alarms.ts';
import type { ConversationSummary, ConversationsState } from '../conversations.ts';
import type { AlarmsState } from '../notice.ts';
import { panelText } from './strings.ts';
import './style.css';

/** `MM-DD HH:MM` in `timezone`, as Coo reads its alarms (`localLabel` in alarms.ts). */
function clock(timezone: string): { format(ms: number): string } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return {
    format: (ms) => {
      const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
      return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
    },
  };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The unit `Intl.RelativeTimeFormat` says a span of `ms` in, rounded. */
function relative(format: Intl.RelativeTimeFormat, ms: number): string {
  const min = Math.round(ms / 60_000);
  if (Math.abs(min) < 60) return format.format(min, 'minute');
  const hours = Math.round(min / 60);
  if (Math.abs(hours) < 48) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}

const alarmsPanel: WebUiPanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const t = panelText(ctx.language);
    const card = ui.sheet({ title: t.title, en: 'alarms', desc: t.desc });
    root.appendChild(card.el);
    const msg = ui.msgline('');
    const table = ui.table({ head: t.head });
    card.body.append(table.el, msg);

    const rel = new Intl.RelativeTimeFormat(ctx.language, { numeric: 'auto' });
    let shown = '';
    const render = (st: AlarmsState) => {
      const at = clock(st.timezone);
      // the relative time moves by the minute: redraw only when the list or that changes
      const key = JSON.stringify([st, Math.floor(Date.now() / 60_000)]);
      if (key === shown) return;
      shown = key;
      if (!st.alarms.length) { table.clear(t.empty); return; }
      table.clear();
      for (const alarm of st.alarms) table.addRow(row(alarm, at));
    };
    const row = (alarm: Alarm, at: ReturnType<typeof clock>) => {
      const when = ui.h('div', 'coo-alarm-when');
      when.append(ui.h('span', 'coo-alarm-time', at.format(alarm.at)));
      if (alarm.daily) when.append(ui.chip(t.daily, 'accent'));
      when.append(ui.h('small', 'muted', relative(rel, alarm.at - Date.now())));
      const remove = ui.button(t.remove, { size: 'sm', variant: 'danger', onClick: () => void cancel(alarm, at.format(alarm.at), remove) });
      return [
        { el: when },
        { text: alarm.note, cls: 'txt' },
        { text: at.format(alarm.setAt), cls: 'mono' },
        { el: remove, cls: 'coo-alarm-act' },
      ];
    };
    const cancel = async (alarm: Alarm, when: string, btn: HTMLButtonElement) => {
      if (!await ui.confirm({ title: t.confirmTitle(when), body: alarm.note })) return;
      const lock = ui.disable(btn);
      try {
        render(await ctx.invoke<AlarmsState>('cancel', [alarm.id]));
        msg.textContent = '';
        ui.toast(t.removed);
      } catch (err) {
        lock.dispose();
        ui.toast(t.failed(errText(err)), 'bad');
      }
    };
    const refresh = async () => {
      try { render(await ctx.invoke<AlarmsState>('list')); msg.textContent = ''; } catch (err) { msg.textContent = t.loadFailed(errText(err)); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 5000);
  },
};

/** `ENABLED_KEY` and `RECENT_KEY` of conversations.ts, which runs in Node. */
const ENABLED_KEY = 'companion.conversations.enabled';
const RECENT_KEY = 'companion.conversations.recent';

const conversationsPanel: WebUiPanel = {
  mount(ctx) {
    const { ui, root, signal } = ctx;
    const t = panelText(ctx.language).conversations;
    const card = ui.sheet({ title: t.sheet, en: 'conversations', desc: t.desc });
    root.appendChild(card.el);
    const msg = ui.msgline('');
    let st: ConversationsState | null = null;
    const row = (label: string, control: HTMLElement, hint?: string) => {
      const r = ui.h('div', 'companion-row');
      const c = ui.h('div', 'companion-control');
      c.append(control);
      if (hint) c.append(ui.h('p', 'home-note', hint));
      r.append(ui.h('div', 'companion-label', label), c);
      return r;
    };
    const save = async (key: string, value: boolean | number) => {
      try {
        await ctx.setConfig('companion', { [key]: value });
        msg.textContent = '';
        await refresh();
      } catch (err) {
        msg.textContent = t.failed(errText(err));
      }
    };

    // the row names the switch
    const on = ui.checkbox('', { onChange: (v) => void save(ENABLED_KEY, v) });
    on.input.setAttribute('aria-label', t.enabled);
    const recent = ui.input({ type: 'number' });
    recent.min = '0'; recent.step = '1';
    const recentBox = ui.h('div', 'companion-rangebox');
    const recentSuffix = ui.h('span', 'companion-rangeval');
    recentBox.append(recent, recentSuffix);
    recent.addEventListener('change', () => {
      const n = Number(recent.value);
      const max = st?.recentMax ?? 100;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        msg.textContent = t.outOfRange(max);
        recent.value = String(st?.recent ?? '');
        return;
      }
      void save(RECENT_KEY, n);
    }, { signal });

    const current = ui.h('div', 'coo-conv-current');
    const currentLine = ui.h('span', 'home-note');
    const newButton = ui.button(t.newConversation, { size: 'sm', onClick: () => void act('new', [], t.confirmNew, newButton) });
    current.append(currentLine, newButton);
    const switching = ui.h('p', 'home-note coo-conv-switching');
    const table = ui.table({ head: t.head });
    card.body.append(row(t.enabled, on.el, t.enabledHint), row(t.recent, recentBox), row(t.current, current), switching, table.el, msg);

    /** Asks the World for `method`; a refusal shows as a toast. */
    const act = async (method: string, args: unknown[], question: string, button: HTMLButtonElement, danger = false) => {
      if (!await ui.confirm({ title: question, danger })) return;
      const lock = ui.disable(button);
      try {
        render(await ctx.invoke<ConversationsState>(method, args));
        msg.textContent = '';
      } catch (err) {
        ui.toast(t.failed(errText(err)), 'bad');
      } finally {
        lock.dispose();
      }
    };
    const entry = (c: ConversationSummary, coo: boolean, busy: boolean) => {
      const title = ui.h('div', 'coo-conv-title');
      title.append(ui.h('span', null, c.title));
      if (coo) title.append(ui.chip(t.cooCan, 'accent'));
      if (c.preview && c.preview !== c.title) title.append(ui.h('small', 'muted', c.preview));
      const acts = ui.h('span', 'coo-conv-acts');
      const open = ui.button(t.open, { size: 'sm', onClick: () => void act('open', [c.id], t.confirmOpen(c.title), open) });
      const remove = ui.button(t.remove, { size: 'sm', variant: 'danger', onClick: () => void act('delete', [c.id], t.confirmDelete(c.title), remove, true) });
      open.disabled = busy;
      acts.append(open, remove);
      return [{ el: title }, { text: c.startedAt, cls: 'mono' }, { text: c.endedAt, cls: 'mono' }, { text: String(c.messages), cls: 'num' }, { el: acts, cls: 'coo-alarm-act' }];
    };

    let shown = '';
    const render = (next: ConversationsState) => {
      st = next;
      on.setChecked(next.enabled);
      recent.max = String(next.recentMax);
      if (document.activeElement !== recent) recent.value = String(next.recent);
      recentSuffix.textContent = `${t.recentSuffix} (0–${next.recentMax})`;
      const busy = !next.enabled || next.switching !== null;
      currentLine.textContent = next.current.messages
        ? [next.current.startedAt, t.messages(next.current.messages), next.current.preview].filter(Boolean).join(' · ')
        : t.currentEmpty;
      newButton.disabled = busy;
      switching.textContent = next.switching ? t.switching : next.enabled ? '' : t.off;
      const key = JSON.stringify([next.saved, next.recent, busy]);
      if (key === shown) return;
      shown = key;
      if (!next.saved.length) { table.clear(t.empty); return; }
      table.clear();
      next.saved.forEach((c, i) => table.addRow(entry(c, next.enabled && i < next.recent, busy)));
    };
    const refresh = async () => {
      try { render(await ctx.invoke<ConversationsState>('state')); } catch (err) { msg.textContent = t.loadFailed(errText(err)); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 3000);
  },
};

const bundle: WebUiClientBundle = { panels: { alarms: alarmsPanel, conversations: conversationsPanel } };
export default bundle;
