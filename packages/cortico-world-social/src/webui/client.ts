/**
 * The `social` panel: the limits of one request, the platforms with their logins and the browser, the
 * daily autoscroll jobs with their recent runs, and the lifetime counter. It renders the panel's
 * `state`, read again every `POLL_MS` while mounted. Scalar settings are written through
 * `/api/config` (`ctx.setConfig`) on each change; the job list goes through the panel's `setJobs`,
 * whole, whenever every job in it is complete.
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { IMAGE_MODES, SOCIAL_ID, parseJobs, socialConfigGroup, type AutoscrollJob, type ImageMode } from '../config.ts';
import { socialText } from '../i18n/index.ts';
import { PLATFORM_IDS, VIDEO_PLATFORMS, type PlatformId, type SourceKind } from '../posts.ts';
import type { SocialPanelState } from '../world.ts';
import './style.css';

const GROUP = `world:${SOCIAL_ID}`;
const K = `worlds.${SOCIAL_ID}`;
const POLL_MS = 3000;

/** The sources each platform's adapter lists: `sources` in src/platforms/<platform>.ts, which run in Node. */
const SOURCES: Readonly<Record<PlatformId, readonly SourceKind[]>> = {
  reddit: ['feed', 'search', 'account', 'community'],
  x: ['feed', 'search', 'account'],
  facebook: ['feed', 'search', 'account', 'community'],
  threads: ['feed', 'search', 'account'],
  instagram: ['feed', 'search', 'account'],
  youtube: ['feed', 'search', 'account'],
  bilibili: ['feed', 'search', 'account'],
  rednote: ['feed', 'search', 'account'],
};

/** `jobKey` of src/autoscroll.ts, which runs in Node. */
const jobKey = (j: AutoscrollJob): string => `${j.platform}|${j.source}|${j.query}|${j.at}`;

/** A new job's start time and posts. */
const NEW_JOB = { at: '09:00', maxPosts: 100 };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function mount(ctx: WebUiPanelContext): void {
  const { ui, signal } = ctx;
  const text = socialText(ctx.language);
  const s = text.panel;
  const doc = ctx.root.ownerDocument;
  const props = socialConfigGroup(ctx.language).schema.properties;
  const stamp = new Intl.DateTimeFormat(ctx.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(ctx.language, { year: 'numeric', month: 'long', day: 'numeric' });
  const count = (n: number) => n.toLocaleString(ctx.language);

  let st: SocialPanelState | null = null;
  // a `state` read that started before a write ended would put back what the write changed
  let writing = 0;
  let writes = 0;

  const say = (line: HTMLElement, msg: string, bad = false) => { line.textContent = msg; line.classList.toggle('bad', bad); };
  const focused = (el: Element) => doc.activeElement === el;
  const row = (label: string, control: HTMLElement, hint?: HTMLElement | string) => {
    const r = ui.h('div', 'companion-row');
    const c = control.classList.contains('companion-control') ? control : ui.h('div', 'companion-control');
    if (c !== control) c.append(control);
    if (hint) c.append(typeof hint === 'string' ? ui.h('p', 'home-note', hint) : hint);
    r.append(ui.h('div', 'companion-label', label), c);
    return r;
  };

  /**
   * Reads the state, or calls a method that changes no setting and returns it (a login check, a
   * login window); the reply is rendered unless a write began since, and `done` said in `line`.
   */
  const read = async (method = 'state', args: unknown[] = [], line = readMsg, done = ''): Promise<SocialPanelState | null> => {
    const before = writes;
    try {
      const next = await ctx.invoke<SocialPanelState>(method, args);
      say(line, done);
      if (!writing && before === writes) render(next);
      return next;
    } catch (err) {
      if (!signal.aborted) say(line, method === 'state' ? s.readFailed(errText(err)) : errText(err), true);
      return null;
    }
  };
  /** Runs one write; a failure shows in `line`. */
  const write = async <T>(run: () => Promise<T>, line: HTMLElement, failed: (err: string) => string): Promise<T | null> => {
    writing++; writes++;
    try {
      return await run();
    } catch (err) {
      if (!signal.aborted) say(line, failed(errText(err)), true);
      return null;
    } finally {
      writing--;
    }
  };
  const save = async (key: string, value: string | number | boolean, line: HTMLElement) => {
    if (await write(() => ctx.setConfig(GROUP, { [`${K}.${key}`]: value }), line, s.saveFailed) === null) return;
    say(line, '');
    await read();
  };
  /** Calls a panel method that changes the World, renders the state it returns and says `done` in `line`. */
  const call = async (method: string, args: unknown[], line: HTMLElement, done = '', failed: (err: string) => string = (e) => e) => {
    const next = await write(() => ctx.invoke<SocialPanelState>(method, args), line, failed);
    if (!next) return;
    say(line, done);
    render(next);
  };

  /** A whole number within the bounds the config group declares for `key`, which follow its unit; saved on change. */
  const numberSetting = (key: string, suffix: string, line: HTMLElement) => {
    const prop = props[`${K}.${key}`]!;
    const min = prop.minimum ?? 1;
    const max = prop.maximum ?? Number.MAX_SAFE_INTEGER;
    const input = ui.input({ type: 'number' });
    input.min = String(min); input.max = String(max); input.step = '1';
    let saved = '';
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < min || n > max) { say(line, s.outOfRange(min, max), true); input.value = saved; return; }
      void save(key, n, line);
    }, { signal });
    const box = ui.h('div', 'companion-rangebox');
    box.append(input, ui.h('span', 'companion-rangeval', `${suffix} (${count(min)}–${count(max)})`));
    return { box, set: (v: number) => { saved = String(v); if (!focused(input)) input.value = saved; } };
  };
  const switchSetting = (key: string, label: string, line: HTMLElement) =>
    ui.checkbox(label, { onChange: (on) => void save(key, on, line) });

  const readMsg = ui.msgline('');

  /* ---------- each request ---------- */
  const limits = ui.sheet({ title: s.limitsTitle, desc: s.limitsDesc });
  const limitsMsg = ui.msgline('');
  const posts = numberSetting('maxPosts', s.postsSuffix, limitsMsg);
  const time = numberSetting('maxSec', s.timeSuffix, limitsMsg);
  const imageHint = ui.h('p', 'home-note');
  const images = ui.segmented(IMAGE_MODES.map((value) => ({ value, label: s.imageModes[value] })), {
    size: 'sm',
    onSelect: (v) => { imageHint.textContent = s.imageHints[v as ImageMode]; void save('images', v, limitsMsg); },
  });
  const transcript = numberSetting('maxTranscriptChars', s.transcriptSuffix, limitsMsg);
  // a failed read of the state shows first
  limits.body.append(
    readMsg,
    row(s.posts, posts.box),
    row(s.time, time.box),
    row(s.images, images.el, imageHint),
    row(s.transcript, transcript.box),
    limitsMsg,
  );

  /* ---------- platforms ---------- */
  const platforms = ui.sheet({ title: s.platformsTitle, desc: s.platformsDesc });
  const platformsMsg = ui.msgline('');
  const platformRows = PLATFORM_IDS.map((id) => {
    const name = text.platforms[id];
    const control = ui.h('div', 'companion-control social-platform');
    const on = switchSetting(`platforms.${id}.enabled`, '', platformsMsg);
    on.input.setAttribute('aria-label', name);
    const login = ui.pill(s.unchecked);
    const open = ui.button(s.login, { size: 'sm', onClick: () => void read('login', [id], platformsMsg, s.loginOpened(name)) });
    control.append(on.el, login, open);
    return { id, el: row(name, control), on, login, open };
  });
  const check = ui.button(s.checkLogins, { size: 'sm', onClick: () => checkLogins() });
  const checkLogins = () => {
    check.disabled = true;
    check.textContent = s.checking;
    void read('checkLogins', [], platformsMsg);
  };
  const pathInput = ui.input({ placeholder: s.browserPathPlaceholder, cls: 'mono' });
  pathInput.spellcheck = false;
  pathInput.addEventListener('change', () => void save('browserFile', pathInput.value.trim(), platformsMsg), { signal });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) pathInput.blur(); }, { signal });
  const browserLine = ui.h('p', 'home-note');
  const showBrowser = switchSetting('showBrowser', s.showBrowserCheck, platformsMsg);
  platforms.body.append(
    ...platformRows.map((p) => p.el),
    row('', check),
    row(s.browser, pathInput, browserLine),
    row(s.showBrowser, showBrowser.el, s.showBrowserHint),
    platformsMsg,
  );

  /* ---------- daily autoscroll ---------- */
  const autoscroll = ui.sheet({ title: s.autoscrollTitle, desc: s.autoscrollDesc });
  const autoscrollMsg = ui.msgline('');
  const autoscrollOn = switchSetting('autoscroll.enabled', s.autoscrollCheck, autoscrollMsg);
  const minutes = numberSetting('autoscroll.maxMinutes', s.maxMinutesSuffix, autoscrollMsg);
  const jobsBox = ui.h('div', 'social-jobs');
  const jobsMsg = ui.msgline('');
  const add = ui.button(s.addJob, { size: 'sm', onClick: () => addJob() });
  add.disabled = true;
  const jobsBar = ui.rowbar();
  jobsBar.append(add, jobsMsg);
  const runs = ui.table({ head: [s.runAt, s.runJob, s.runResult] });
  runs.el.classList.add('social-table');
  autoscroll.body.append(
    row(s.autoscrollOn, autoscrollOn.el),
    row(s.maxMinutes, minutes.box),
    autoscrollMsg,
    jobsBox,
    jobsBar,
    ui.section(s.recentRuns),
    runs.el,
  );

  /** The jobs as edited here; saved whenever `parseJobs` keeps every one of them. */
  let draft: AutoscrollJob[] = [];
  /** The draft holds an incomplete job, which is not saved. */
  let incomplete = false;
  let jobRows: Array<{ set(job: AutoscrollJob): void; paint(): void }> = [];
  const describe = (j: AutoscrollJob) => [text.platforms[j.platform], text.sources[j.source], j.query].filter(Boolean).join(' · ');

  const commitJobs = async () => {
    if (parseJobs(draft).length !== draft.length) {
      incomplete = true;
      say(jobsMsg, s.jobInvalid, true);
      for (const r of jobRows) r.paint();
      return;
    }
    incomplete = false;
    await call('setJobs', [draft], jobsMsg, s.jobsSaved, s.saveFailed);
  };
  const editJob = (i: number, patch: Partial<AutoscrollJob>) => {
    draft[i] = { ...draft[i]!, ...patch };
    jobRows[i]!.set(draft[i]!);
    void commitJobs();
  };
  /** One job on one line, wrapped where the window is narrow; each field is named for screen readers. */
  const jobRow = (i: number) => {
    const named = <E extends HTMLElement>(el: E, name: string) => { el.setAttribute('aria-label', name); return el; };
    const platform = named(ui.select({ options: PLATFORM_IDS.map((p) => ({ value: p, label: text.platforms[p] })) }), s.jobPlatform);
    const source = named(ui.select(), s.jobSource);
    const query = named(ui.input({ cls: 'social-query' }), s.jobQuery);
    const maxPosts = named(ui.input({ type: 'number' }), s.jobPosts);
    maxPosts.min = '1'; maxPosts.step = '1';
    const postsBox = ui.h('span', 'social-jobposts');
    postsBox.append(maxPosts, ui.h('span', 'companion-rangeval', s.postsSuffix));
    const at = named(ui.input(), s.jobAt);
    at.type = 'time';
    const textOnly = ui.checkbox(s.jobTextOnly, { onChange: (on) => editJob(i, { images: on ? 'skip' : 'ocr' }) });
    const run = ui.button(s.runNow, { size: 'sm', onClick: () => void call('runNow', [jobKey(draft[i]!)], jobsMsg) });
    const remove = ui.button(s.removeJob, { size: 'sm', onClick: () => { draft.splice(i, 1); buildJobs(); void commitJobs(); } });
    const acts = ui.h('span', 'social-jobacts');
    acts.append(run, remove);
    const line = ui.h('div', 'social-job');
    line.append(platform, source, query, postsBox, at, textOnly.el, acts);
    jobsBox.append(line);

    platform.addEventListener('change', () => {
      const p = platform.value as PlatformId;
      const kept = SOURCES[p].includes(draft[i]!.source) ? draft[i]!.source : SOURCES[p][0]!;
      editJob(i, { platform: p, source: kept, query: kept === 'feed' ? '' : draft[i]!.query });
    }, { signal });
    source.addEventListener('change', () => {
      const kind = source.value as SourceKind;
      editJob(i, { source: kind, query: kind === 'feed' ? '' : draft[i]!.query });
      if (kind !== 'feed' && !draft[i]!.query) query.focus();
    }, { signal });
    query.addEventListener('change', () => editJob(i, { query: query.value }), { signal });
    query.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) query.blur(); }, { signal });
    maxPosts.addEventListener('change', () => {
      const n = Number(maxPosts.value);
      const cap = st?.caps.jobPosts ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isInteger(n) || n < 1 || n > cap) { say(jobsMsg, s.outOfRange(1, cap), true); return; }
      editJob(i, { maxPosts: n });
    }, { signal });
    // a time cleared in the field keeps the job's time
    at.addEventListener('change', () => { if (at.value) editJob(i, { at: at.value.slice(0, 5) }); else at.value = draft[i]!.at; }, { signal });

    const paint = () => {
      query.setAttribute('aria-invalid', String(incomplete && draft[i]!.source !== 'feed' && !draft[i]!.query.trim()));
      const key = jobKey(draft[i]!);
      run.disabled = !st?.jobs.some((j) => jobKey(j) === key) || !!st.running;
      run.textContent = st?.running === key ? s.running : s.runNow;
    };
    const set = (job: AutoscrollJob) => {
      if (!focused(platform)) platform.value = job.platform;
      if (source.dataset.platform !== job.platform) {
        source.dataset.platform = job.platform;
        source.replaceChildren(...SOURCES[job.platform].map((k) => { const o = ui.h('option', null, text.sources[k]); o.value = k; return o; }));
      }
      if (!focused(source)) source.value = job.source;
      // the feed reads no query: the field keeps its room, so the jobs' fields stay in columns
      query.style.visibility = job.source === 'feed' ? 'hidden' : '';
      query.placeholder = s.queryPlaceholder[job.source];
      if (!focused(query)) query.value = job.query;
      if (st) maxPosts.max = String(st.caps.jobPosts);
      if (!focused(maxPosts)) maxPosts.value = String(job.maxPosts);
      if (!focused(at)) at.value = job.at;
      textOnly.setChecked(job.images === 'skip');
      paint();
    };
    set(draft[i]!);
    return { set, paint };
  };
  const buildJobs = () => {
    jobsBox.replaceChildren(...(draft.length ? [] : [ui.placeholder(s.noJobs)]));
    jobRows = draft.map((_, i) => jobRow(i));
    add.disabled = !st || draft.length >= st.caps.jobs;
  };
  const addJob = () => {
    if (!st) return;
    const platform = PLATFORM_IDS.find((p) => st!.config.platforms[p]) ?? PLATFORM_IDS[0];
    draft.push({ platform, source: 'feed', query: '', maxPosts: Math.min(NEW_JOB.maxPosts, st.caps.jobPosts), at: NEW_JOB.at, images: 'ocr' });
    buildJobs();
    void commitJobs();
  };
  let shown = false;
  /** Takes the saved jobs, unless an incomplete edit is held here. */
  const syncJobs = (next: SocialPanelState) => {
    if (!shown || (!incomplete && JSON.stringify(next.jobs) !== JSON.stringify(draft))) {
      if (shown && next.jobs.length === draft.length) {
        draft = structuredClone(next.jobs);
        draft.forEach((job, i) => jobRows[i]!.set(job));
      } else if (!jobsBox.contains(doc.activeElement)) {
        draft = structuredClone(next.jobs);
        buildJobs();
        shown = true;
      }
    }
    add.disabled = draft.length >= next.caps.jobs;
    for (const r of jobRows) r.paint();
  };

  /* ---------- lifetime counter ---------- */
  const lifetime = ui.sheet({ title: s.lifetimeTitle, desc: s.lifetimeDesc(s.never) });
  const lifeTable = ui.table({ head: [s.platform, s.timeSpent, s.postsRead, s.transcripts, s.lastRead] });
  lifeTable.el.classList.add('social-table');
  lifeTable.el.querySelectorAll('th').forEach((th, i) => { if (i >= 1 && i <= 3) th.classList.add('num'); });
  const lifeMsg = ui.msgline('');
  const lifeBar = ui.actions();
  lifeBar.append(ui.button(s.reset, {
    size: 'sm',
    onClick: async () => { if (await ui.confirm({ title: s.reset, body: s.resetConfirm })) await call('resetLifetime', [], lifeMsg); },
  }), lifeMsg);
  lifetime.body.append(lifeTable.el, lifeBar);

  const sheets = [limits.el, platforms.el, autoscroll.el, lifetime.el];
  // nothing can be changed until the state has been read once
  for (const el of sheets) el.inert = true;
  ctx.root.append(...sheets);

  const num = (v: string) => ({ text: v, cls: 'num' });
  const when = (iso: string | undefined) => (iso ? stamp.format(new Date(iso)) : s.never);
  const render = (next: SocialPanelState) => {
    st = next;
    for (const el of sheets) el.inert = false;
    const c = next.config;
    posts.set(c.maxPosts);
    time.set(c.maxSec);
    transcript.set(c.maxTranscriptChars);
    images.setValue(c.images);
    imageHint.textContent = s.imageHints[c.images];

    for (const p of platformRows) {
      p.on.setChecked(c.platforms[p.id]);
      const known = next.logins[p.id];
      p.login.textContent = known === undefined ? s.unchecked : known ? s.loggedIn : s.loggedOut;
      p.login.className = known === undefined ? 'pill' : known ? 'pill on' : 'pill off';
      p.open.disabled = !next.browser;
    }
    check.disabled = next.checkingLogins || !next.browser;
    check.textContent = next.checkingLogins ? s.checking : s.checkLogins;
    if (!focused(pathInput)) pathInput.value = c.browserFile;
    browserLine.textContent = next.browser ? s.browserFound(next.browser) : c.browserFile ? s.browserFileMissing : s.browserMissing;
    browserLine.classList.toggle('social-bad', !next.browser);
    showBrowser.setChecked(c.showBrowser);

    autoscrollOn.setChecked(c.autoscroll.enabled);
    minutes.set(c.autoscroll.maxMinutes);
    syncJobs(next);
    runs.clear(next.digests.length ? undefined : s.noRuns);
    for (const d of next.digests) {
      runs.addRow([when(d.startedAt), describe(d.job), d.error ? { text: s.runFailed, cls: 'social-bad' } : s.runPosts(d.posts)]);
    }

    const life = next.lifetime;
    if (lifetime.desc) lifetime.desc.textContent = s.lifetimeDesc(day.format(new Date(life.sinceAt)));
    lifeTable.clear();
    const total = { ms: 0, posts: 0, transcripts: 0, lastAt: '' };
    for (const id of PLATFORM_IDS) {
      const t = life.platforms[id];
      total.ms += t.ms; total.posts += t.posts; total.transcripts += t.transcripts;
      if (t.lastAt && t.lastAt > total.lastAt) total.lastAt = t.lastAt;
      lifeTable.addRow([
        text.platforms[id],
        num(t.ms ? s.duration(t.ms) : s.never),
        num(count(t.posts)),
        num(VIDEO_PLATFORMS.has(id) ? count(t.transcripts) : s.never),
        when(t.lastAt),
      ]);
    }
    lifeTable.addRow([
      s.total,
      num(total.ms ? s.duration(total.ms) : s.never),
      num(count(total.posts)),
      num(count(total.transcripts)),
      when(total.lastAt || undefined),
    ]).classList.add('social-total');
  };

  void read().then((first) => {
    // the first look at the logins, once a browser is there to read them from
    if (first?.browser && !first.checkingLogins && !Object.keys(first.logins).length) checkLogins();
  });
  ctx.interval(() => void read(), POLL_MS);
}

const bundle: WebUiClientBundle = { panels: { social: { mount } } };
export default bundle;
