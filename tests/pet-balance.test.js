/** The pet page's balance bubble: asked of the World and shown beside Coo on hover and after a poke. */
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

/** Coo's body stands at (500, 420): a point within 60 pixels of it is on the body. */
const ON = { x: 500, y: 420 }, OFF = { x: 900, y: 100 };

/** The actual page with a recording socket and a body that answers hits; the test moves the page's clock. */
async function page() {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/pet', runScripts: 'outside-only' });
  const win = dom.window;
  pages.push(win);
  const sent = [];
  const body = {
    layout: { busy: false, pressing: false, facing: 1, cursor: '', bubble: { x: 500, y: 360 }, side: { x: 500, y: 420, reach: 60 } },
    hit: (p) => Math.hypot(p.x - 500, p.y - 420) < 60,
    set() {}, cue() {}, talk() {}, tick() {}, pointer() {},
  };
  win.requestAnimationFrame = () => 0;
  win.WebSocket = class { readyState = 1; send(m) { sent.push(JSON.parse(m)); } };
  win.deps = {
    applyTheme() {}, clamp, f, ICONS, linked: (text, n) => linked(text, n, win.document),
    COO_CSS, mini, normalizeSkin, skinCss,
    createSfx: () => ({ pop() {}, babble() {}, blub() {}, configure() {}, set() {}, listenStart() {}, listenEnd() {}, select() {}, tick() {}, unlock() {} }),
    createSpeech: () => ({ configure() {}, begin() {}, reveal() { return false; }, stop() {}, active: false }),
    textSteps: () => 1,
    loadBody: async () => body, body,
    t, language: () => 'zh', useLanguage: async () => {},
    lightWall() {}, dressFloor() {}, modeButton: () => ({ show() {} }), glowColor: () => null, setGlow() {}, bindAppearance() {}, announcePainted() {},
  };
  win.eval(`const { applyTheme, clamp, f, ICONS, linked, COO_CSS, mini, normalizeSkin, skinCss, createSfx, createSpeech, textSteps, loadBody, t, language, useLanguage, lightWall, dressFloor, modeButton, glowColor, setGlow, bindAppearance, announcePainted } = window.deps;\n${source}\nbody = window.deps.body; window.page = { onOrder, onBody, cursor, openMenu, step: (dt) => { T += dt; stepTools(); stepBalance(); layout(dt); }, BALANCE_AFTER_POKE, BALANCE_ASK_EVERY, TOOLS_LINGER };`);
  // the socket opens once the page's language has loaded
  await new Promise((r) => setTimeout(r, 0));
  const el = win.document.querySelector('#balance');
  const asks = () => sent.filter((m) => m.t === 'balance').length;
  return { ...win.page, el, asks, body, win };
}
const lent = { t: 'prefs', bot: { buttons: { balance: true } } };
const deepseek = { t: 'balance', service: 'DeepSeek', amounts: [{ currency: 'CNY', amount: 12.5 }] };

describe('the balance bubble', () => {
  it('asks the World while the pointer rests on Coo, and shows the answer beside it a moment after the pointer leaves', async () => {
    const p = await page();
    p.onOrder(lent);
    p.cursor.at = ON;
    p.step(.1);
    expect(p.asks()).toBe(1);
    // nothing to show until the World answers
    expect(p.el.hidden).toBe(true);
    p.onOrder(deepseek);
    p.step(.1);
    expect(p.el.hidden).toBe(false);
    expect(p.el.textContent).toBe(t('balance.left', { amount: '¥12.50' }));
    p.cursor.at = OFF;
    p.step(p.TOOLS_LINGER / 2);
    expect(p.el.hidden).toBe(false);
    p.step(p.TOOLS_LINGER);
    expect(p.el.hidden).toBe(true);
  });

  it('shows after a poke for a few seconds, and hides while Coo is held or the menu is open', async () => {
    const p = await page();
    p.onOrder(lent);
    p.onOrder(deepseek);
    p.cursor.at = OFF;
    p.onBody('touch', { kind: 'poke' });
    p.step(.1);
    expect(p.el.hidden).toBe(false);
    p.body.layout.pressing = true;
    p.step(.1);
    expect(p.el.hidden).toBe(true);
    p.body.layout.pressing = false;
    p.openMenu(500, 420);
    p.step(.1);
    expect(p.el.hidden).toBe(true);
    p.win.document.querySelector('#menu').hidden = true;
    p.step(.1);
    expect(p.el.hidden).toBe(false);
    p.step(p.BALANCE_AFTER_POKE);
    expect(p.el.hidden).toBe(true);
  });

  it(`asks again only after ${20} seconds of showing, however often the pointer comes back`, async () => {
    const p = await page();
    p.onOrder(lent);
    p.cursor.at = ON;
    for (let i = 0; i < 10; i++) p.step(1);
    expect(p.asks()).toBe(1);
    p.step(p.BALANCE_ASK_EVERY);
    expect(p.asks()).toBe(2);
  });

  it('says why there is no balance: the service tells none, no key is set, or the read failed', async () => {
    const p = await page();
    p.onOrder(lent);
    p.cursor.at = ON;
    p.onOrder({ t: 'balance', service: 'Anthropic', none: 'service' });
    expect(p.el.textContent).toBe(t('balance.none', { service: 'Anthropic' }));
    p.onOrder({ t: 'balance', service: '', none: 'service' });
    expect(p.el.textContent).toBe(t('balance.none', { service: t('balance.someService') }));
    p.onOrder({ t: 'balance', service: 'DeepSeek', none: 'key' });
    expect(p.el.textContent).toBe(t('balance.noKey'));
    p.onOrder({ t: 'balance', service: 'DeepSeek', failed: 'HTTP 401' });
    expect(p.el.textContent).toBe(t('balance.failed'));
  });

  it('neither shows nor asks while the app lends no balance', async () => {
    const p = await page();
    p.cursor.at = ON;
    p.onBody('touch', { kind: 'poke' });
    p.step(.1);
    p.onOrder(deepseek);
    p.step(.1);
    expect(p.asks()).toBe(0);
    expect(p.el.hidden).toBe(true);
  });
});
