import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { clamp, f, ICONS, linked } from '../packages/cortico-world-desktop-pet/web/ui.js';
import { COO_CSS, mini, normalizeSkin, skinCss } from '../packages/cortico-world-desktop-pet/web/coo/coo.js';
import { t } from '../packages/cortico-world-desktop-pet/web/i18n.js';

const WEB = new URL('../packages/cortico-world-desktop-pet/web/', import.meta.url);
const source = readFileSync(new URL('pet-app.js', WEB), 'utf8').replace(/^import .*;$/gm, '');
const html = readFileSync(new URL('pet.html', WEB), 'utf8');
const pages = [];
afterEach(() => { for (const p of pages.splice(0)) p.close(); });

/** Run the actual page with a quiet socket and body; the test advances the page's frame clock. */
function page() {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/pet', runScripts: 'outside-only' });
  const win = dom.window;
  pages.push(win);
  const bodyChanges = [];
  const body = {
    layout: { busy: false, facing: 1, cursor: '', bubble: { x: 500, y: 400 } },
    set: (change) => bodyChanges.push(change), cue() {}, talk() {},
  };
  win.requestAnimationFrame = () => 0;
  win.WebSocket = class { readyState = 1; send() {} };
  win.deps = {
    applyTheme: (theme) => { win.document.documentElement.dataset.theme = theme; }, clamp, f, ICONS, linked: (text, n) => linked(text, n, win.document),
    COO_CSS, mini, normalizeSkin, skinCss,
    createSfx: () => ({ pop() {}, babble() {}, blub() {}, configure() {}, set() {}, listenStart() {}, listenEnd() {}, select() {}, tick() {}, unlock() {} }),
    createSpeech: () => ({ configure() {}, begin() {}, reveal() { return false; }, stop() {}, active: false }),
    textSteps: () => 1,
    loadBody: async () => body, body,
    t, language: () => 'zh', useLanguage: async () => {},
    // the tab's stage (stage.js) is decoration the activity bubble does not depend on
    lightWall() {}, dressFloor() {}, modeButton: () => ({ show() {} }), glowColor: () => null, setGlow() {}, bindAppearance() {}, announcePainted() {},
  };
  win.eval(`const { applyTheme, clamp, f, ICONS, linked, COO_CSS, mini, normalizeSkin, skinCss, createSfx, createSpeech, textSteps, loadBody, t, language, useLanguage, lightWall, dressFloor, modeButton, glowColor, setGlow, bindAppearance, announcePainted } = window.deps;\n${source}\nbody = window.deps.body; window.page = { onOrder, openInput, closeBubble, step: (dt) => { T += dt; stepDialog(dt); stepLines(); stepStatus(); layout(dt); }, interactive: () => bubble.matches(UI_SELECTOR), lines: () => lines, overUi: (el) => el.matches(UI_SELECTOR), clickable: (el) => !!el.closest(UI_SELECTOR), REPLIED_FADE, UNANSWERED_FADE, MAX_LINES, MAX_REPLIES, BROWSE_IDLE };`);
  return { ...win.page, bubble: win.document.querySelector('#bubble'), bodyChanges, doc: win.document, win };
}
const read = { kind: 'read', text: '在看', detail: '日记.md' };
const think = { kind: 'think', text: '' };
const show = (p, status) => p.onOrder({ t: 'status', status });

describe('activity in the shared speech bubble', () => {
  it('shows activity by default and applies the switch without changing the thinking face', () => {
    const p = page();
    show(p, think); p.step(1);
    expect(p.bubble.getAttribute('aria-label')).toBe(t('status.thinking'));
    expect(p.bubble.hidden).toBe(false);
    expect(p.bodyChanges).toContainEqual({ thinking: true });
    p.onOrder({ t: 'prefs', statusBubble: false }); p.step(.01);
    expect(p.bubble.hidden).toBe(true);
    p.onOrder({ t: 'prefs', statusBubble: true }); p.step(.01);
    expect(p.bubble.getAttribute('aria-label')).toBe(t('status.thinking'));
    expect(p.bubble.hidden).toBe(false);
    expect(p.bodyChanges.filter(c => 'thinking' in c)).toEqual([{ thinking: true }]);
  });

  it('applies init and prefs to the body immediately, but waits .6 seconds before showing thought', () => {
    const p = page();
    p.onOrder({ t: 'init', status: think, statusBubble: true });
    expect(p.bodyChanges).toContainEqual({ thinking: true });
    p.step(.59);
    expect(p.bubble.hidden).toBe(true);
    p.step(.02);
    expect(p.bubble.getAttribute('aria-label')).toBe(t('status.thinking'));
    expect(p.bubble.classList.contains('status')).toBe(true);
    p.onOrder({ t: 'prefs', status: think, statusBubble: false });
    p.step(.01);
    expect(p.bubble.hidden).toBe(true);
    expect(p.bodyChanges.filter(c => 'thinking' in c)).toEqual([{ thinking: true }]);
  });

  it('never flashes thought for a quick reply', () => {
    const p = page();
    show(p, think); p.step(.18);
    show(p, null); p.step(1);
    expect(p.bubble.hidden).toBe(true);
  });

  it('holds each activity for 1.2 seconds, then replaces it or fades for .2 seconds', () => {
    const p = page();
    show(p, read); p.step(.01);
    show(p, { kind: 'write', text: '在写' }); p.step(1.19);
    expect(p.bubble.dataset.kind).toBe('read');
    p.step(.02);
    expect(p.bubble.dataset.kind).toBe('write');
    show(p, null); p.step(1.19);
    expect(p.bubble.classList.contains('fading')).toBe(false);
    p.step(.02);
    expect(p.bubble.classList.contains('fading')).toBe(true);
    p.step(.21);
    expect(p.bubble.hidden).toBe(true);
  });

  it('updates detail and count in place without restarting the icon', () => {
    const p = page();
    show(p, read); p.step(.01);
    const icon = p.bubble.querySelector('svg');
    show(p, { ...read, detail: '<记忆>.md', count: 3 }); p.step(.01);
    expect(p.bubble.querySelector('svg')).toBe(icon);
    expect(p.bubble.textContent).toBe('在看 · <记忆>.md 和另外 2 个');
    expect(p.bubble.querySelector('记忆')).toBeNull();
  });

  it('speech takes the same element immediately, stays above incoming status and returns to the latest activity', () => {
    const p = page();
    show(p, read); p.step(.01);
    expect(p.interactive()).toBe(false);
    p.onOrder({ t: 'say', id: 's', beats: [{ text: '你好', actions: [], anchors: [] }] });
    p.step(.01);
    expect(p.bubble.classList.contains('say')).toBe(true);
    expect(p.bubble.classList.contains('status')).toBe(false);
    expect(p.bubble.hasAttribute('aria-label')).toBe(false);
    expect(p.interactive()).toBe(true);
    show(p, { kind: 'search', text: '在搜' }); p.step(.01);
    expect(p.bubble.classList.contains('say')).toBe(true);
    expect(p.doc.querySelectorAll('.status')).toHaveLength(0);
    p.closeBubble(); p.step(.01);
    expect(p.bubble.dataset.kind).toBe('search');
    expect(p.interactive()).toBe(false);
  });

  it('turns an address in speech into a link once it has typed out', () => {
    const p = page();
    p.onOrder({ t: 'say', id: 's', beats: [{ text: '来 https://github.com/Pal-AI-Lab/Coopanion 点星', actions: [], anchors: [] }] });
    p.step(.01); p.step(.5);
    expect(p.bubble.querySelector('a')).toBeNull();
    p.step(3);
    expect(p.bubble.querySelector('a')?.getAttribute('href')).toBe('https://github.com/Pal-AI-Lab/Coopanion');
  });

  it.each(['ask', 'confirm', 'dialog', 'input', 'listen'])('%s takes priority over activity', (kind) => {
    const p = page();
    show(p, read); p.step(.01);
    if (kind === 'input') p.openInput();
    else if (kind === 'listen') p.onOrder({ t: 'listen', phase: 'start' });
    else if (kind === 'dialog') p.onOrder({ t: 'dialog', id: 'd', text: '你好', input: { kind: 'text', submit: '好' } });
    else p.onOrder({ t: kind, id: 'q', question: '继续吗', options: ['继续'] });
    p.step(.01);
    show(p, think); p.step(.7);
    expect(p.bubble.hidden || !p.bubble.classList.contains('status')).toBe(true);
    p.onOrder({ t: 'prefs', status: think, statusBubble: false }); p.step(.01);
    if (kind !== 'listen') expect(p.bubble.hidden).toBe(false);
  });
});

describe("the person's lines above Coo", () => {
  const up = (p) => p.lines().filter((l) => l.fadeAt === null);
  const said = (p, text, cursor) => p.onOrder({ t: 'said', via: 'chat', text, images: 0, cursor });

  it("a line stays while Coo works on it and while its reply is up, and fades REPLIED_FADE seconds after the reply closes", () => {
    const p = page();
    p.onOrder({ t: 'listen', phase: 'start' });
    p.onOrder({ t: 'listen', phase: 'heard', text: '今天天气怎么样' });
    show(p, think);
    // thinking for longer than an unanswered line lasts
    p.step(p.UNANSWERED_FADE + 1);
    expect(up(p)).toHaveLength(1);
    p.onOrder({ t: 'say', id: 's', beats: [{ text: '晴天', actions: [], anchors: [] }] });
    show(p, null);
    p.step(.01);
    expect(p.bubble.classList.contains('say')).toBe(true);
    for (let i = 0; i < 200 && !p.bubble.hidden; i++) { p.step(.05); expect(up(p)).toHaveLength(1); }
    expect(p.bubble.hidden).toBe(true);
    p.step(p.REPLIED_FADE - .1);
    expect(up(p)).toHaveLength(1);
    p.step(.2);
    expect(up(p)).toHaveLength(0);
  });

  it('holds MAX_LINES lines at most: past it the oldest fades even while Coo works on it, and the newest stays', () => {
    const p = page();
    show(p, think);
    for (let i = 1; i <= p.MAX_LINES + 1; i++) { said(p, `第 ${i} 句`, i); p.step(.01); }
    expect(up(p).map((l) => l.cursor)).toEqual(Array.from({ length: p.MAX_LINES }, (_, i) => i + 2));
  });

  it('a click closes a settled line, which then lets the pointer through; a line being heard closes only by its cancel button', () => {
    const p = page();
    said(p, '在吗', 1);
    p.onOrder({ t: 'listen', phase: 'start' });
    p.step(.01);
    const [sent, heard] = p.lines();
    heard.el.click();
    expect(heard.fadeAt).toBeNull();
    expect(p.overUi(sent.el)).toBe(true);
    sent.el.click();
    expect(sent.fadeAt).not.toBeNull();
    expect(p.overUi(sent.el)).toBe(false);
  });

  it('stacks the lines above Coo, the newest lowest, with no side picked from where Coo faces', () => {
    const p = page();
    show(p, think);
    for (let i = 1; i <= 3; i++) { said(p, `第 ${i} 句`, i); p.step(.01); }
    const tops = p.lines().map((l) => parseFloat(l.el.style.top));
    expect(tops.every((top) => top < 400)).toBe(true);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    // centred over Coo's head (the body's layout.bubble.x; jsdom lays everything out zero wide)
    expect(p.lines().map((l) => l.el.style.left)).toEqual(['500px', '500px', '500px']);
    expect(p.doc.querySelector('#trail')).toBeNull();
  });

  it('with the switch off nothing typed or sent stays, and a heard line fades once it is settled', () => {
    const p = page();
    said(p, '留着', 1); p.step(.01);
    p.onOrder({ t: 'prefs', saidBubbles: false });
    expect(up(p)).toHaveLength(0);
    said(p, '在吗', 2);
    expect(p.lines().filter((l) => l.cursor === 2)).toHaveLength(0);
    p.onOrder({ t: 'listen', phase: 'start' });
    expect(up(p)).toHaveLength(1);
    p.onOrder({ t: 'listen', phase: 'heard', text: '今天天气怎么样' });
    expect(up(p)).toHaveLength(0);
  });
});

describe("Coo's earlier bubbles", () => {
  const say = (p, id, ...texts) => p.onOrder({ t: 'say', id, beats: texts.map((text) => ({ text, actions: [], anchors: [] })) });
  const text = (p) => (p.bubble.hidden ? null : p.bubble.querySelector('.b-text')?.textContent ?? null);
  const nav = (p) => p.bubble.querySelector('.b-nav');
  const pos = (p) => p.bubble.querySelector('.b-pos').textContent;
  const prev = (p) => p.bubble.querySelector('.b-prev');
  const next = (p) => p.bubble.querySelector('.b-next');
  const copy = (p) => p.bubble.querySelector('.b-copy');
  /** The texts the page put on the clipboard. */
  const clipboard = (p) => {
    const copied = [];
    Object.defineProperty(p.win.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } } });
    return copied;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const point = (p, on) => p.bubble.dispatchEvent(new p.win.Event(on ? 'pointerenter' : 'pointerleave'));
  /** Runs the page clock in frames of .1 s until `done` after one, for at most `limit` seconds. */
  const until = (p, done, limit = 30) => { for (let t = 0; t < limit; t += .1) { p.step(.1); if (done()) return; } };
  const repliesButton = (p) => p.doc.querySelector('#tools [data-action="replies"]');
  /** A page with the arrows on and the replies action among the hover buttons. */
  const arrowsPage = () => {
    const p = page();
    p.onOrder({ t: 'prefs', showReplyArrows: true, hoverButtons: ['chat', 'replies'] });
    return p;
  };

  it('keeps every line shown: previous shows the one before in full, next returns to the line on screen', () => {
    const p = arrowsPage();
    say(p, 's', '早上好', '今天下雨');
    p.step(.01);
    // one line and one more coming: the arrows count it, and next is on
    expect(nav(p).hidden).toBe(false);
    expect(pos(p)).toBe('1/1 +1');
    expect(prev(p).disabled).toBe(true);
    expect(next(p).disabled).toBe(false);
    until(p, () => text(p) === '今天下雨');
    expect(nav(p).hidden).toBe(false);
    expect(pos(p)).toBe('2/2');
    expect(next(p).disabled).toBe(true);
    prev(p).click();
    expect(text(p)).toBe('早上好');
    expect(pos(p)).toBe('1/2');
    expect(prev(p).disabled).toBe(true);
    expect(next(p).disabled).toBe(false);
    next(p).click();
    expect(text(p)).toBe('今天下雨');
    expect(next(p).disabled).toBe(true);
    until(p, () => p.bubble.hidden);
    expect(p.bubble.hidden).toBe(true);
  });

  it('the arrows take the mouse like the rest of the bubble', () => {
    const p = arrowsPage();
    say(p, 's', '一', '二');
    until(p, () => text(p) === '二');
    expect(p.clickable(prev(p))).toBe(true);
    expect(p.clickable(next(p))).toBe(true);
  });

  it('while browsing the queue waits: a say that arrives is counted on the label and starts once browsing ends', () => {
    const p = arrowsPage();
    say(p, 'a', '第一句', '第二句');
    until(p, () => text(p) === '第二句');
    prev(p).click();
    say(p, 'b', '新的一句');
    expect(pos(p)).toBe('1/2 +1');
    point(p, true);
    until(p, () => text(p) !== '第一句', p.BROWSE_IDLE * 2);
    expect(text(p)).toBe('第一句');
    // the say set aside comes back typed out and held anew, still counting the one waiting, then that one follows
    next(p).click();
    expect(text(p)).toBe('第二句');
    expect(pos(p)).toBe('2/2 +1');
    point(p, false);
    p.step(.1);
    expect(text(p)).toBe('第二句');
    until(p, () => text(p) === '新的一句');
    expect(text(p)).toBe('新的一句');
    expect(pos(p)).toBe('3/3');
  });

  it('browsing ends BROWSE_IDLE seconds after the pointer leaves the bubble', () => {
    const p = arrowsPage();
    say(p, 's', '一', '二');
    until(p, () => text(p) === '二');
    prev(p).click();
    point(p, true);
    until(p, () => text(p) !== '一', p.BROWSE_IDLE + 1);
    point(p, false);
    p.step(p.BROWSE_IDLE - .5);
    expect(text(p)).toBe('一');
    p.step(1);
    expect(text(p)).toBe('二');
  });

  it('each step back or forward keeps browsing; BROWSE_IDLE seconds after the last one, with the pointer off the bubble, it ends', () => {
    const p = arrowsPage();
    say(p, 's', '一', '二', '三', '四');
    until(p, () => p.bubble.hidden);
    for (const [button, expected] of [[repliesButton, '4/4'], [repliesButton, '3/4'], [repliesButton, '2/4'], [next, '3/4']]) {
      button(p).click();
      expect(pos(p)).toBe(expected);
      p.step(p.BROWSE_IDLE * .6);
    }
    expect(text(p)).toBe('三');
    p.step(p.BROWSE_IDLE * .6);
    expect(p.bubble.hidden).toBe(true);
  });

  it('a browsed bubble keeps its right edge, so the arrows stay under the pointer', () => {
    const p = arrowsPage();
    // jsdom lays nothing out: the bubble is as wide as its text
    Object.defineProperty(p.bubble, 'offsetWidth', { configurable: true, get: () => 20 + 10 * (p.bubble.querySelector('.b-text')?.textContent.length ?? 0) });
    const right = () => parseFloat(p.bubble.style.left) + p.bubble.offsetWidth;
    say(p, 's', '短', '这是一句长得多的话');
    until(p, () => text(p) === '这是一句长得多的话');
    const edge = right();
    prev(p).click();
    p.step(.01);
    expect(text(p)).toBe('短');
    expect(right()).toBe(edge);
  });

  it('a question waiting behind a say is shown: the hold lets go, browsing ends and back stays off', () => {
    const p = arrowsPage();
    say(p, 's', '一', '二');
    until(p, () => text(p) === '二');
    point(p, true);
    prev(p).click();
    p.onOrder({ t: 'confirm', id: 'q', question: '继续吗', options: ['继续'] });
    expect(text(p)).toBe('二');
    expect(prev(p).disabled).toBe(true);
    prev(p).click();
    repliesButton(p).click();
    expect(text(p)).toBe('二');
    until(p, () => p.bubble.classList.contains('ask'));
    expect(p.bubble.classList.contains('ask')).toBe(true);
  });

  it('the replies action does nothing once the arrows are off, from a button drawn before', () => {
    const p = arrowsPage();
    say(p, 's', '一');
    until(p, () => p.bubble.hidden);
    const stale = repliesButton(p);
    p.onOrder({ t: 'prefs', showReplyArrows: false });
    stale.click();
    expect(p.bubble.hidden).toBe(true);
  });

  it('after the last bubble closed the replies action shows the newest line and keeps the activity bubble away; with nothing after it next is off', () => {
    const p = arrowsPage();
    say(p, 's', '一', '二');
    until(p, () => p.bubble.hidden);
    show(p, read); p.step(.01);
    expect(p.bubble.classList.contains('status')).toBe(true);
    repliesButton(p).click();
    p.step(1);
    expect(p.bubble.classList.contains('status')).toBe(false);
    expect(text(p)).toBe('二');
    expect(pos(p)).toBe('2/2');
    expect(next(p).disabled).toBe(true);
    until(p, () => p.bubble.dataset.kind === 'read', p.BROWSE_IDLE * 2);
    expect(p.bubble.dataset.kind).toBe('read');
  });

  it('with the pointer on the bubble, next shows the next line at once, and is off once nothing comes after', () => {
    const p = arrowsPage();
    say(p, 's', '一', '二', '三');
    until(p, () => text(p) === '一');
    point(p, true);
    expect(pos(p)).toBe('1/1 +2');
    until(p, () => text(p) !== '一', 10);
    expect(text(p)).toBe('一');
    next(p).click();
    until(p, () => text(p) === '二', 2);
    expect(pos(p)).toBe('2/2 +1');
    next(p).click();
    until(p, () => text(p) === '三', 2);
    expect(pos(p)).toBe('3/3');
    expect(next(p).disabled).toBe(true);
  });

  it.each(['ask', 'confirm', 'dialog'])('a %s ends browsing as it arrives', (kind) => {
    const p = arrowsPage();
    say(p, 's', '一');
    until(p, () => p.bubble.hidden);
    repliesButton(p).click();
    point(p, true);
    if (kind === 'dialog') p.onOrder({ t: 'dialog', id: 'd', text: '你好', input: { kind: 'text', submit: '好' } });
    else p.onOrder({ t: kind, id: 'q', question: '继续吗', options: ['继续'] });
    p.step(.01);
    expect(p.bubble.classList.contains(kind === 'dialog' ? 'talk' : 'ask')).toBe(true);
  });

  it('Esc ends browsing', () => {
    const p = arrowsPage();
    say(p, 's', '一');
    until(p, () => p.bubble.hidden);
    repliesButton(p).click();
    expect(text(p)).toBe('一');
    p.doc.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.bubble.hidden).toBe(true);
  });

  it('the typing box ends browsing, and a say it cuts short keeps the lines it had not shown', () => {
    const p = arrowsPage();
    say(p, 'a', '甲');
    until(p, () => p.bubble.hidden);
    say(p, 'b', '乙', '丙', '丁');
    until(p, () => text(p) === '乙');
    prev(p).click();
    expect(text(p)).toBe('甲');
    p.openInput();
    expect(p.bubble.querySelector('textarea')).not.toBeNull();
    p.closeBubble();
    repliesButton(p).click();
    expect(text(p)).toBe('丁');
    expect(pos(p)).toBe('4/4');
  });

  it('keeps the last MAX_REPLIES lines', () => {
    const p = arrowsPage();
    say(p, 's', ...Array.from({ length: p.MAX_REPLIES + 1 }, (_, i) => `第 ${i} 句`));
    until(p, () => p.bubble.hidden, 200);
    repliesButton(p).click();
    expect(pos(p)).toBe(`${p.MAX_REPLIES}/${p.MAX_REPLIES}`);
    for (let i = 1; i < p.MAX_REPLIES; i++) prev(p).click();
    expect(text(p)).toBe('第 1 句');
    expect(prev(p).disabled).toBe(true);
  });

  it('with the arrows on a say bubble stays while the pointer is on it', () => {
    const p = arrowsPage();
    say(p, 's', '一');
    p.step(.01);
    point(p, true);
    until(p, () => p.bubble.hidden);
    expect(text(p)).toBe('一');
    point(p, false);
    until(p, () => p.bubble.hidden);
    expect(p.bubble.hidden).toBe(true);
  });

  it('with the arrows off a say bubble shows its copy button but no arrows, and still stays while the pointer is on it', () => {
    const p = arrowsPage();
    p.onOrder({ t: 'prefs', showReplyArrows: false });
    say(p, 's', '一', '二');
    until(p, () => text(p) === '二');
    expect([prev(p), p.bubble.querySelector('.b-pos'), next(p)].map((el) => el.hidden)).toEqual([true, true, true]);
    expect(copy(p).hidden).toBe(false);
    expect(p.clickable(copy(p))).toBe(true);
    point(p, true);
    until(p, () => p.bubble.hidden);
    expect(text(p)).toBe('二');
  });

  it('copies the whole reply, lines still to come included, or only the text selected in the bubble', async () => {
    const p = arrowsPage();
    const copied = clipboard(p);
    say(p, 's', '第一句', '第二句', '第三句');
    until(p, () => text(p) === '第二句');
    copy(p).click();
    await settle();
    expect(copied).toEqual(['第一句\n第二句\n第三句']);
    const box = p.bubble.querySelector('.b-text');
    const range = p.doc.createRange();
    range.setStart(box.firstChild, 1);
    range.setEnd(box.firstChild, 3);
    p.win.getSelection().removeAllRanges();
    p.win.getSelection().addRange(range);
    copy(p).click();
    await settle();
    expect(copied[1]).toBe('二句');
  });

  it('copies the reply an earlier bubble belongs to while looking back', async () => {
    const p = arrowsPage();
    const copied = clipboard(p);
    say(p, 'a', '一', '二');
    until(p, () => text(p) === '二');
    say(p, 'b', '三');
    until(p, () => text(p) === '三');
    prev(p).click();
    expect(text(p)).toBe('二');
    copy(p).click();
    await settle();
    expect(copied).toEqual(['一\n二']);
  });

  it('offers the replies action once a line was shown, and only while the arrows are on', () => {
    const p = arrowsPage();
    expect(repliesButton(p)).toBeNull();
    say(p, 's', '一');
    p.step(.01);
    expect(repliesButton(p)).not.toBeNull();
    p.onOrder({ t: 'prefs', showReplyArrows: false });
    expect(repliesButton(p)).toBeNull();
    p.onOrder({ t: 'prefs', showReplyArrows: true });
    expect(repliesButton(p)).not.toBeNull();
  });
});
