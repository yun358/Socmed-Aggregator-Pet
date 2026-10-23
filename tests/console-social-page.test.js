/**
 * 「社交媒体」 against a real Cortico bot with the social World: the page mounts the World's own
 * panel through the page host, and what the panel writes reaches the World's live config. Requests
 * go to the bot's port; the browser setting names a file that does not exist, so no browser starts.
 *
 * The file runs in Node: Core resolves its own files from `import.meta.url`, which the jsdom
 * environment rewrites for the browser. The window's globals come from Vitest's jsdom environment
 * once the bot runs, and the window's modules are imported after that.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { builtinEnvironments } from 'vitest/environments';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBot } from 'cortico/bot.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import { loadExtensions } from 'cortico/extensions.ts';
import { withWorlds } from 'cortico/world.ts';
import { CONSOLE } from 'cortico/worlds/console/definition.ts';
import { socialDefinition } from 'cortico-world-social';
import { SOCIAL_DEFAULTS, parseJobs } from '../packages/cortico-world-social/src/config.ts';
import { socialText } from '../packages/cortico-world-social/src/i18n/index.ts';
import { ADAPTERS } from '../packages/cortico-world-social/src/platforms/index.ts';
import { PLATFORM_IDS } from '../packages/cortico-world-social/src/posts.ts';

const CORTICO = resolve(import.meta.dirname, '../vendor/cortico');
const PANEL_SOURCE = resolve(import.meta.dirname, '../packages/cortico-world-social/src/webui/client.ts');
const realFetch = globalThis.fetch;
const NodeURL = globalThis.URL;

let dir, bot, base, live, jsdomEnv, requests, mounted, s;
/** The settings window's modules, imported into the window. */
let W;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'coo-social-page-'));
  mkdirSync(join(dir, 'providers', 'fixture'), { recursive: true });
  writeFileSync(join(dir, 'providers', 'fixture', 'config.json'), JSON.stringify({ kind: 'openai-responses-compat', baseUrl: 'http://127.0.0.1:9/v1', spec: { model: 'test-model', thinking: false } }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ activeProvider: 'fixture', worlds: { social: { browserFile: join(dir, 'no-browser') } } }));
  const SOCIAL = socialDefinition();
  const cormini = (await import(join(CORTICO, 'bots', 'cormini', 'index.ts'))).default;
  const definition = withWorlds({ ...cormini, declares: [...(cormini.declares ?? []), SOCIAL.id] }, [CONSOLE, SOCIAL]);
  const loaded = loadDeployment(definition, dir, CORTICO);
  loaded.config.web.port = 0;
  live = loaded.config.worlds.social;
  process.env.CORTICO_EXTENSIONS_DIR = join(dir, 'extensions');
  const extensions = await loadExtensions(CORTICO, { reserved: [CONSOLE.id, SOCIAL.id] });
  // the page's bundle is the panel's source here: the loader below imports it whatever URL the manifest names
  extensions.webUiAssets.push({ pageId: 'world:social', packageName: 'cortico-world-social', version: '0.0.0-test', jsFile: PANEL_SOURCE });
  bot = createBot(loaded, definition, { extensions });
  bot.core.bus.setPaused(true);
  base = `http://127.0.0.1:${(await bot.start()).port}`;

  jsdomEnv = await builtinEnvironments.jsdom.setup(globalThis, {});
  // Core keeps resolving file URLs while it serves
  globalThis.URL = NodeURL;
  W = {
    ...await import('../console/advanced/console-pages/builtins.ts'),
    ...await import('../console/advanced/console-pages/host.ts'),
    ...await import('../console/advanced/console-pages/loader.ts'),
    ...await import('../console/base/api.ts'),
    ...await import('../console/base/language.ts'),
    ...await import('../console/base/lifecycle.ts'),
    ...await import('../console/base/router.ts'),
    ...await import('../console/base/ui/index.ts'),
    ...await import('../console/index.ts'),
    ...await import('../console/features/social/index.ts'),
  };
  s = socialText(W.LANGUAGE).panel;
}, 30000);

afterAll(async () => {
  jsdomEnv?.teardown(globalThis);
  await bot?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mounted = [];
  requests = [];
  document.body.replaceChildren();
  // the window's requests go to the bot; jsdom's abort signals are not Node's, so an abort is checked here
  vi.stubGlobal('fetch', async (path, { signal, ...init } = {}) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (init.method === 'POST') requests.push({ path, body: JSON.parse(init.body) });
    return realFetch(`${base}${path}`, init);
  });
});

afterEach(() => {
  for (const life of mounted) life.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The page as console/index.ts mounts it: `mountPanel` loads the World's panel through a page host. */
async function mountPage() {
  const onError = (err) => { throw err; };
  const lifecycle = new W.Lifecycle(onError);
  mounted.push(lifecycle);
  const root = document.createElement('div');
  document.body.append(root);
  const memo = { get: (_, fallback) => fallback, set() {} };
  const ui = W.createConsoleUi({ doc: document, overlayHost: document.body, signal: lifecycle.signal, memo });
  const router = new W.Router({ win: window, confirmLeave: async () => true, onError });
  const imported = [];
  const loader = new W.ConsolePageLoader({
    importModule: (url) => { imported.push(url); return import(PANEL_SOURCE); },
    styleHost: document.head,
    createLink: () => document.createElement('link'),
  });
  const mountPanel = async (pageId, panelId, box) => {
    const host = new W.ConsolePageHost({
      doc: document, root: document.createElement('div'), overlayHost: document.body, loader, builtins: W.BUILTIN_PANELS, router, memo, onError,
      fetchManifest: () => W.fetchManifest(), createSocket: () => { throw new Error('no stream'); }, wsUrl: (path) => path, route: () => [W.socialPage.route],
    });
    await host.load();
    return host.mountConnection(pageId, panelId, box, {}, (context) => context);
  };
  await W.socialPage.mount({ root, lifecycle, signal: lifecycle.signal, ui, router, capabilities: {}, onError, mountPanel });
  // the first state has arrived
  await vi.waitFor(() => expect(root.querySelector('input[type=number]').value).not.toBe(''));
  const button = (label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  const jobLines = () => [...root.querySelectorAll('.social-job')];
  return { root, imported, button, jobLines };
}

const change = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

it('is a page of the normal mode, and mounts the social World\'s panel from the bundle the manifest names', async () => {
  expect(W.ENTRIES.find((e) => e.route === W.socialPage.route)).toMatchObject({ basic: true, page: W.socialPage });
  const { root, imported } = await mountPage();
  expect(imported).toEqual([expect.stringMatching(/^\/assets\/extensions\/cortico-world-social\//)]);
  const { comments: c, substack: sb } = socialText(W.LANGUAGE);
  expect([...root.querySelectorAll('.sheet h3')].map((h) => h.firstChild.textContent))
    .toEqual([c.waitingTitle, c.outboxTitle, s.limitsTitle, s.platformsTitle, s.autoscrollTitle, c.title, sb.title, s.lifetimeTitle]);
  // the drafts and the queued posts show first, and only while there are any
  const sheet = (title) => [...root.querySelectorAll('.sheet')].find((el) => el.querySelector('h3').firstChild.textContent === title);
  expect(sheet(c.waitingTitle).hidden).toBe(true);
  expect(sheet(c.outboxTitle).hidden).toBe(true);
  // the configured browser file is missing: the page says so and offers no login
  expect(root.textContent).toContain(s.browserFileMissing);
  expect(root.querySelector('.social-platform .btn').disabled).toBe(true);
});

it('writes a changed post limit through /api/config, and refuses one outside the declared bounds', async () => {
  const { root } = await mountPage();
  const posts = root.querySelector('input[type=number]');
  await vi.waitFor(() => expect(posts.value).toBe(String(SOCIAL_DEFAULTS.maxPosts)));
  const next = SOCIAL_DEFAULTS.maxPosts + 1;
  change(posts, String(next));
  await vi.waitFor(() => expect(live.maxPosts).toBe(next));
  expect(requests.filter((r) => r.path === '/api/config')).toEqual([{ path: '/api/config', body: { group: 'world:social', values: { 'worlds.social.maxPosts': next } } }]);
  change(posts, '0');
  await vi.waitFor(() => expect(root.querySelector('.msgline.bad')?.textContent).toMatch(/\d/));
  expect(live.maxPosts).toBe(next);
  expect(requests.filter((r) => r.path === '/api/config')).toHaveLength(1);
});

it('writes the Substack publication through /api/config, and says when it names no publication', async () => {
  const { root } = await mountPage();
  const sb = socialText(W.LANGUAGE).substack;
  const input = root.querySelector(`input[placeholder="${sb.publicationPlaceholder}"]`);
  change(input, ' Fixture Weekly ');
  await vi.waitFor(() => expect(live.substack.publication).toBe('Fixture Weekly'));
  await vi.waitFor(() => expect(root.textContent).toContain(sb.publicationBad));
  change(input, 'fixturewriter');
  await vi.waitFor(() => expect(live.substack.publication).toBe('fixturewriter'));
  await vi.waitFor(() => expect(root.textContent).not.toContain(sb.publicationBad));
  expect(requests.filter((r) => r.path === '/api/config').map((r) => r.body.values))
    .toEqual([{ 'worlds.social.substack.publication': 'Fixture Weekly' }, { 'worlds.social.substack.publication': 'fixturewriter' }]);
});

it('saves the job list whole and only while every job is complete', async () => {
  const { root, button, jobLines } = await mountPage();
  const setJobs = () => requests.filter((r) => r.path.endsWith('/setJobs')).map((r) => r.body.args[0]);
  button(s.addJob).click();
  await vi.waitFor(() => expect(live.autoscroll.jobs).toHaveLength(1));
  expect(live.autoscroll.jobs[0]).toMatchObject({ source: 'feed', query: '' });

  // a search with nothing to search for stays here, with the reason
  const [, source] = jobLines()[0].querySelectorAll('select');
  change(source, 'search');
  await vi.waitFor(() => expect(root.textContent).toContain(s.jobInvalid));
  expect(live.autoscroll.jobs[0].source).toBe('feed');
  change(jobLines()[0].querySelector('.social-query'), 'night markets');
  await vi.waitFor(() => expect(live.autoscroll.jobs[0]).toMatchObject({ source: 'search', query: 'night markets' }));

  button(s.addJob).click();
  await vi.waitFor(() => expect(live.autoscroll.jobs).toHaveLength(2));
  jobLines()[0].querySelector('.social-jobacts').lastChild.click();
  await vi.waitFor(() => expect(live.autoscroll.jobs).toHaveLength(1));
  expect(live.autoscroll.jobs[0].source).toBe('feed');
  // every list sent was one the World keeps whole
  expect(setJobs().length).toBeGreaterThanOrEqual(4);
  for (const jobs of setJobs()) expect(parseJobs(jobs)).toEqual(jobs);

  button(s.removeJob).click();
  await vi.waitFor(() => expect(live.autoscroll.jobs).toEqual([]));
  await vi.waitFor(() => expect(root.textContent).toContain(s.noJobs));
});

it('offers for each platform exactly the sources its adapter lists', async () => {
  const { button, jobLines } = await mountPage();
  button(s.addJob).click();
  await vi.waitFor(() => expect(jobLines()).toHaveLength(1));
  const [platform, source] = jobLines()[0].querySelectorAll('select');
  for (const id of PLATFORM_IDS) {
    change(platform, id);
    expect([...source.options].map((o) => o.value)).toEqual([...ADAPTERS[id].sources]);
  }
  button(s.removeJob).click();
  await vi.waitFor(() => expect(live.autoscroll.jobs).toEqual([]));
});
