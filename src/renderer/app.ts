// The UI. It builds the DOM with h() and text nodes, never markup from data, and reaches the app only through
// window.ca (src/preload.ts).
import { icon, logoMark, type IconName } from './icons.ts';
import type { AccountView, Api, CommandRequest, Launch, LoginState, Mode, PickedRepo, Row, State, View } from '../types.ts';

declare global { interface Window { ca: Api } }

const api = window.ca;
const PLATFORM = new URLSearchParams(location.search).get('platform') || 'darwin';
const IS_MAC = PLATFORM === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const SHIFT = IS_MAC ? '⇧' : 'Shift';
document.documentElement.classList.add(`platform-${PLATFORM}`);

interface Onboarding { step: number; name?: string; account?: string; repo?: PickedRepo; mode?: Mode }
const S: { data: State | null; view: View; filter: string; query: string; sel: number; onb: Onboarding | null } =
  { data: null, view: 'repos', filter: 'all', query: '', sel: -1, onb: null };
// The state, which every view renders from once refresh() has loaded it
function data(): State { if (!S.data) throw new Error('The app state has not loaded yet.'); return S.data; }
function byId(id: string): HTMLElement { const el = document.getElementById(id); if (!el) throw new Error(`#${id} is missing from index.html`); return el; }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ tiny DOM helper (text only, never innerHTML with data)
type Kid = Node | string | number | null | undefined | false | Kid[];
type Listener<E extends Event> = (e: E) => unknown;
interface Attrs {
  [name: string]: string | number | boolean | null | undefined | Listener<never>;
  onclick?: Listener<MouseEvent>; ondblclick?: Listener<MouseEvent>; onmousedown?: Listener<MouseEvent>; onmousemove?: Listener<MouseEvent>;
  onkeydown?: Listener<KeyboardEvent>; oninput?: Listener<Event>; onchange?: Listener<Event>;
}
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on')) { if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener); }
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (k: Kid): void => {
    if (Array.isArray(k)) k.forEach(add);
    else if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}
const kbd = (...keys: string[]) => h('span', { class: 'kbd' }, keys.map(k => h('kbd', {}, k)));
const tilde = (p: string) => (S.data && S.data.home && (p === S.data.home || p.startsWith(S.data.home + '/')) ? '~' + p.slice(S.data.home.length) : p);
const mid = (s: string, n: number) => s.length <= n ? s : s.slice(0, Math.ceil(n * .4)) + '…' + s.slice(s.length - Math.floor(n * .6) + 1);
const pathEl = (p: string, cls = 'repo-path', max = 0) => h('div', { class: cls, title: p }, h('bdi', {}, max ? mid(tilde(p), max) : tilde(p)));
const colorOf = (name: string) => { const a = S.data?.accounts.find(x => x.name === name); return a ? `c${a.color % 8}` : 'c7'; };
const initials = (s: string) => (s.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
const LOGIN: Record<LoginState | 'missing-account', [string, string]> = {
  'logged-in': ['ok', 'Signed in'], 'keychain?': ['warn', 'Unconfirmed'], 'not-logged-in': ['neutral', 'Not signed in'], 'missing-account': ['bad', 'Missing account'],
};
// 'keychain?' is an account whose folder has files that `claude auth status` hasn't confirmed: the check failed,
// or it hasn't run yet
const loginBadge = (s: LoginState | 'missing-account', note?: string | null) => { const [c, t] = LOGIN[s] || ['neutral', s];
  return h('span', { class: `badge ${c}`, title: s === 'keychain?' ? (note ? `claude auth status: ${note}` : 'Refresh to ask claude auth status') : t }, t); };
// An account's CLI status, or what the app is doing about it: asking `claude auth status`, or waiting for a sign-in
function accountBadge(a: AccountView) {
  const busy = (t: string) => h('span', { class: 'badge neutral busy' }, icon('refresh', 11, 'spin'), t);
  if (a.login !== 'logged-in' && a.signingIn) return busy('Waiting for sign-in');
  if (a.login === 'keychain?' && a.checking) return busy('Checking');
  return loginBadge(a.login, a.note);
}
const PLANS: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
const planName = (p: string) => PLANS[p.toLowerCase()] ?? p;
const accountOf = (name: string) => S.data?.accounts.find(a => a.name === name);
// Who the account's CLI is signed in as, under its name
function who(a: AccountView) {
  if (a.login === 'logged-in') return h('div', { class: 'meta who' },
    h('span', { class: 'email selectable', title: [a.email, a.org].filter(Boolean).join(' · ') || 'Signed in' }, a.email ?? 'Signed in'),
    a.plan ? h('span', { class: 'tag' }, planName(a.plan)) : null);
  return h('div', { class: 'meta' }, a.signingIn ? 'Waiting for sign-in…' : a.login === 'keychain?' ? (a.checking ? 'Checking sign-in…' : 'Sign-in unconfirmed') : 'Not signed in');
}
const MODE_META: Record<Mode, { icon: IconName; label: string; desc: string }> = {
  terminal: { icon: 'terminal', label: 'Terminal', desc: 'Native CLI with its own config dir' },
  docker: { icon: 'box', label: 'Docker', desc: 'Isolated container, separate login' },
  desktop: { icon: 'monitor', label: 'Desktop', desc: 'Separate Claude Desktop instance' },
};

// ------------------------------------------------------------------ data
async function refresh(fresh = false): Promise<boolean> {
  try { S.data = await api.state(fresh); } catch (e) { toast('bad', errText(e)); return false; }
  applyTheme(); render(); return true;
}
// Asks `claude auth status` again for every account. The window otherwise asks only when an answer is old.
async function recheck(btn?: HTMLButtonElement) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try { if (await refresh(true)) toast('ok', 'Sign-in status refreshed'); } finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
}
async function act(fn: () => Promise<unknown>, okMsg?: string): Promise<boolean> {
  try { await fn(); if (okMsg) toast('ok', okMsg); await refresh(); return true; }
  catch (e) { toast('bad', errText(e)); return false; }
}
async function launch(fn: () => Promise<Launch>): Promise<void> {
  try {
    const r = await fn();
    toast(r.ok ? 'ok' : 'warn', r.message, r.command);
  } catch (e) { toast('bad', errText(e)); }
}
// Opens a repository. One that opens with Claude Desktop shows the sign-in guide first when its account's window has
// never opened.
function openRepo(r: Row) {
  const a = accountOf(r.account);
  if (r.mode === 'desktop' && a?.desktopNew) desktopGuide(a, () => api.open(r.repo));
  else launch(() => api.open(r.repo));
}
function openDesktop(a: AccountView) {
  if (a.desktopNew) desktopGuide(a, () => api.desktop(a.name));
  else launch(() => api.desktop(a.name));
}
async function copyText(text: string, what = 'Command') { try { await api.copy(text); toast('ok', `${what} copied`, text); } catch (e) { toast('bad', errText(e)); } }
async function copyCmd(request: CommandRequest, what?: string) { try { await copyText(await api.command(request), what); } catch (e) { toast('bad', errText(e)); } }

function applyTheme() {
  const t = data().prefs.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('light', !dark);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.data) applyTheme(); });

// ------------------------------------------------------------------ toasts
type Tone = 'ok' | 'warn' | 'bad';
const TOAST_ICON: Record<Tone, IconName> = { ok: 'checkCircle', warn: 'info', bad: 'alert' };
function toast(kind: Tone, msg: string, cmd?: string) {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, icon(TOAST_ICON[kind], 16),
    h('div', { class: 'body' }, h('div', { class: 'msg' }, msg), cmd ? h('div', { class: 'cmd', title: cmd }, cmd) : null),
    h('button', { class: 'btn ghost sm icon-only', title: 'Dismiss', onclick: () => close() }, icon('x', 14)));
  const root = byId('toasts');
  root.append(el);
  while (root.children.length > 3) root.firstElementChild?.remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  setTimeout(close, kind === 'bad' ? 7000 : 4200);
}

// ------------------------------------------------------------------ sidebar
function renderSidebar() {
  const d = data(), sb = byId('sidebar');
  const nav = (id: View, ic: IconName, label: string, count?: number) => h('button', { class: `nav ${S.view === id ? 'active' : ''}`, onclick: () => go(id) },
    icon(ic, 16), h('span', { class: 'label' }, label), count !== undefined ? h('span', { class: 'count' }, count) : null);
  sb.replaceChildren(
    h('div', { class: 'sb-top drag' }, IS_MAC ? null : h('div', { class: 'sb-brand' }, logoMark(22), h('span', { class: 'name' }, 'Claude Accounts'))),
    h('button', { class: 'sb-search', onclick: () => openPalette() }, icon('search', 14), h('span', { class: 'label' }, 'Search…'), kbd(MOD, 'K')),
    h('div', { class: 'sb-scroll' },
      nav('repos', 'folder', 'Repositories', d.repos.length),
      nav('accounts', 'users', 'Accounts', d.accounts.length),
      nav('settings', 'settings', 'Settings'),
      h('div', { class: 'sb-section' }, 'Accounts',
        h('button', { class: 'btn ghost sm icon-only add', title: 'Add account', onclick: addAccountModal }, icon('plus', 14))),
      d.accounts.length ? d.accounts.map(a => h('button', {
        class: `nav ${S.view === 'repos' && S.filter === a.name ? 'active' : ''}`, title: `${a.email ? `${a.email}. ` : ''}Show repositories bound to ${a.name}`,
        onclick: () => { S.filter = a.name; go('repos'); },
      }, h('span', { class: `dot c${a.color % 8}` }), h('span', { class: 'label' }, a.name),
        h('span', { class: 'count' }, a.repoCount),
        h('span', { class: `status-dot ${LOGIN[a.login]?.[0] || ''}`, title: LOGIN[a.login]?.[1] }))) :
        h('div', { class: 'faint' }, h('div', { class: 'nav faint' }, 'No accounts yet'))),
    h('div', { class: 'sb-foot', title: 'No network calls. Credential files are never opened.' }, icon('shield', 14), 'Local only · no network'),
  );
}

// ------------------------------------------------------------------ main
function go(view: View) { if (S.view !== view) S.sel = -1; S.view = view; render(true); }
function header(title: string, sub?: string | null, ...actions: Kid[]) {
  return h('div', { class: 'header drag' }, h('h1', {}, title), sub ? h('span', { class: 'sub' }, sub) : null, h('div', { class: 'spacer' }), actions);
}
function render(animate = false) {
  if (!S.data) return;
  renderSidebar();
  const main = byId('main');
  const needOnb = S.onb || (!S.data.accounts.length && !S.data.prefs.onboarded);
  let content: HTMLElement[];
  if (needOnb && S.view !== 'settings') content = renderOnboarding();
  else if (S.view === 'accounts') content = renderAccounts();
  else if (S.view === 'settings') content = renderSettings();
  else content = renderRepos();
  main.replaceChildren(...content);
  if (animate) { const c = main.querySelector<HTMLElement>('.content, .onb'); if (c) { c.classList.remove('view-enter'); void c.offsetWidth; c.classList.add('view-enter'); } }
}

function visibleRepos(): Row[] {
  const q = S.query.toLowerCase();
  return data().repos.filter(r => (S.filter === 'all' || r.account === S.filter) && (!q || r.repo.toLowerCase().includes(q) || r.account.toLowerCase().includes(q)));
}
function renderRepos() {
  const d = data();
  if (S.filter !== 'all' && !d.accounts.some(a => a.name === S.filter)) S.filter = 'all';
  const repos = visibleRepos();
  const head = header('Repositories', d.repos.length ? `${d.repos.length} bound` : null,
    h('button', { class: 'btn primary', onclick: bindModal }, icon('plus', 14), 'Bind repository', kbd(MOD, 'N')));
  if (!d.repos.length) {
    return [head, h('div', { class: 'content' }, h('div', { class: 'empty' },
      h('div', { class: 'ill' }, icon('folderOpen', 24)),
      h('h3', {}, 'No repositories yet'),
      h('p', {}, 'Bind a folder to an account and every Claude session started there uses that account’s login, settings and history.'),
      h('button', { class: 'btn primary lg', onclick: bindModal }, icon('link', 15), 'Bind a repository'),
      h('div', { class: 'shortcuts' },
        h('span', {}, 'Command palette'), kbd(MOD, 'K'), h('span', {}, 'Bind repository'), kbd(MOD, 'N'),
        h('span', {}, 'Add account'), kbd(SHIFT, MOD, 'N'), h('span', {}, 'Switch view'), kbd(MOD, '1–3'))))];
  }
  const counts = new Map(d.accounts.map(a => [a.name, a.repoCount]));
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'filter' }, icon('search', 14), h('input', { class: 'input', id: 'repo-filter', placeholder: 'Filter repositories', value: S.query,
      oninput: e => { S.query = (e.target as HTMLInputElement).value; S.sel = -1; document.getElementById('repo-list')?.replaceWith(repoList(visibleRepos())); } })),
    h('div', { class: 'chips' },
      h('button', { class: `chipbtn ${S.filter === 'all' ? 'on' : ''}`, onclick: () => { S.filter = 'all'; render(); } }, 'All', h('span', { class: 'n' }, d.repos.length)),
      d.accounts.map(a => h('button', { class: `chipbtn ${S.filter === a.name ? 'on' : ''}`, onclick: () => { S.filter = a.name; render(); } },
        h('span', { class: `dot c${a.color % 8}` }), a.name, h('span', { class: 'n' }, counts.get(a.name) || 0)))));
  return [head, h('div', { class: 'content' }, toolbar, repoList(repos))];
}
function repoList(repos: Row[]) {
  const list = h('div', { class: 'list', id: 'repo-list' },
    h('div', { class: 'list-head' }, h('span', {}, 'REPOSITORY'), h('span', {}, 'ACCOUNT'), h('span', {}, 'OPENS WITH'), h('span', {}, 'STATUS'), h('span', {})),
    repos.length ? repos.map((r, i) => repoRow(r, i)) : h('div', { class: 'pal-empty' }, 'No repositories match.'));
  return list;
}
function repoRow(r: Row, i: number) {
  const c = colorOf(r.account);
  const email = accountOf(r.account)?.email;
  const accSel = h('div', { class: 'select-wrap chip', title: email ? `${r.account}: ${email}` : r.account }, h('span', { class: `dot ${c}` }),
    h('select', { title: 'Account', onchange: e => { const v = (e.target as HTMLSelectElement).value; act(() => api.bind(r.repo, v, r.mode), `${r.name} → ${v}`); } },
      data().accounts.map(a => { const o = h('option', { value: a.name }, a.name); o.selected = a.name === r.account; return o; })),
    icon('chevronDown', 13, 'chev'));
  const seg = h('div', { class: 'select-wrap chip', title: MODE_META[r.mode].desc }, icon(MODE_META[r.mode].icon, 13),
    h('select', { title: 'Open with', onchange: e => { const m = (e.target as HTMLSelectElement).value as Mode; act(() => api.bind(r.repo, r.account, m), `${r.name} now opens with ${MODE_META[m].label}`); } },
      Object.entries(MODE_META).map(([m, meta]) => { const o = h('option', { value: m }, meta.label); o.selected = r.mode === m; return o; })),
    icon('chevronDown', 13, 'chev'));
  const more = h('button', { class: 'btn ghost sm icon-only', title: 'More actions' }, icon('more', 16));
  more.addEventListener('click', e => { e.stopPropagation(); repoMenu(r, more); });
  const row = h('div', { class: `row ${S.sel === i ? 'sel' : ''}`, 'data-i': i, ondblclick: () => openRepo(r), onclick: () => selectRow(i) },
    h('div', { class: 'repo-cell' }, h('div', { class: `avatar mark ${c}` }, icon('claude', 18)),
      h('div', { class: 'repo-text' }, h('div', { class: 'repo-name' }, r.name, r.exists ? null : h('span', { class: 'tag warn' }, 'MISSING')), pathEl(r.repo))),
    h('div', {}, accSel), h('div', {}, seg), h('div', {}, loginBadge(r.login)),
    h('div', { class: 'row-actions' }, more,
      h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); openRepo(r); }, title: r.command },
        icon(r.mode === 'desktop' ? 'monitor' : 'play', 12), 'Open')));
  return row;
}
function selectRow(i: number) {
  S.sel = i;
  document.querySelectorAll<HTMLElement>('#repo-list .row').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === i));
  document.querySelector(`#repo-list .row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
}
function repoMenu(r: Row, anchor: HTMLElement) {
  menu(anchor, [
    ['play', 'Open (' + MODE_META[r.mode].label + ')', () => openRepo(r), '↵'],
    ['terminal', 'Open in Terminal', () => launch(() => api.openTerminal(r.repo))],
    ['branch', 'Open in new worktree…', () => worktreeModal(r)],
    ['monitor', 'Launch Desktop instance', () => { const a = accountOf(r.account); if (a) openDesktop(a); }],
    ['box', 'Run in Docker', () => launch(() => api.openDocker(r.repo, 'docker'))],
    IS_MAC ? ['layers', 'Run in Apple container', () => launch(() => api.openDocker(r.repo, 'container'))] : null,
    '-',
    ['copy', 'Copy command', () => copyCmd({ kind: 'open', repo: r.repo }), `${SHIFT}${MOD}C`],
    ['code', 'Copy direnv line (.envrc)', () => copyCmd({ kind: 'direnv', repo: r.repo }, 'direnv line')],
    ['folderOpen', IS_MAC ? 'Reveal in Finder' : 'Open folder', () => api.reveal({ target: 'repo', repo: r.repo })],
    ['logIn', `Sign in “${r.account}”…`, () => launch(() => api.login(r.account))],
    '-',
    ['unlink', 'Unbind repository', () => confirmModal(`Unbind ${r.name}?`, 'The folder and the account stay untouched. Only the binding is removed from config.json.', 'Unbind',
      () => act(() => api.unbind(r.repo), `${r.name} unbound`)), null, true],
  ]);
}

// ------------------------------------------------------------------ accounts
function renderAccounts() {
  const d = data();
  const again: HTMLButtonElement = h('button', { class: 'btn', title: 'Asks claude auth status again for every account', onclick: () => recheck(again) }, icon('refresh', 14), 'Refresh');
  const head = header('Accounts', d.accounts.length ? `${d.accounts.length} configured` : null, again,
    h('button', { class: 'btn primary', onclick: addAccountModal }, icon('userPlus', 14), 'Add account'));
  const cards = d.accounts.map(a => {
    const c = `c${a.color % 8}`, repos = d.repos.filter(r => r.account === a.name).map(r => r.name);
    const more = h('button', { class: 'btn ghost sm icon-only', title: 'More' }, icon('more', 16));
    more.addEventListener('click', e => { e.stopPropagation(); menu(more, [
      ['pencil', 'Rename…', () => renameModal(a.name)],
      ['monitor', 'Sign in to Claude Desktop…', () => desktopGuide(a, () => api.desktop(a.name))],
      ['copy', 'Copy sign-in command', () => copyText(a.login_cmd)],
      ['copy', 'Copy Desktop command', () => copyText(a.desktop_cmd)],
      ['copy', 'Copy config dir path', () => copyText(a.config_dir, 'Path')],
      ['folderOpen', IS_MAC ? 'Reveal folder in Finder' : 'Open folder', () => api.reveal({ target: 'account', account: a.name })],
      !d.dock ? null : a.launcher?.docked ? ['pinOff', 'Remove from Dock', () => setDock(a, false)] : ['pin', 'Keep in Dock', () => setDock(a, true)],
      '-',
      ['trash', 'Remove account…', () => removeModal(a), null, true],
    ]); });
    const loggedIn = a.login === 'logged-in';
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: `avatar round lg ${c}` }, initials(a.name)),
        h('div', { class: 'card-id' }, h('div', { class: 'title' }, a.name), who(a)), more),
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, 'CLI'), h('div', {}, accountBadge(a)),
        h('span', { class: 'k' }, 'Container'), h('div', {}, loginBadge(a.docker_login)),
        h('span', { class: 'k' }, 'Repositories'), h('div', { class: 'v', title: repos.join(', ') },
          repos.length ? (repos.length > 3 ? `${repos.slice(0, 3).join(', ')} +${repos.length - 3}` : repos.join(', ')) : h('span', { class: 'faint' }, 'None yet')),
        h('span', { class: 'k' }, 'Config dir'), pathEl(a.config_dir, 'path', 40),
        d.dock ? [h('span', { class: 'k' }, 'Dock'), dockValue(a)] : null),
      a.signingIn && !loggedIn ? h('div', { class: 'deep' }, icon('info', 13), h('span', {}, 'Finish the sign-in in your browser. This card updates by itself.')) : null,
      h('div', { class: 'card-foot' },
        h('button', { class: `btn sm ${loggedIn ? '' : 'outline-accent'}`, onclick: () => launch(() => api.login(a.name)) }, icon('logIn', 13), loggedIn ? 'Re-sign in' : 'Sign in'),
        h('button', { class: 'btn sm', title: 'Opens this account’s own Claude Desktop window', onclick: () => openDesktop(a) }, icon('monitor', 13), 'Desktop')));
  });
  const content = d.accounts.length ? h('div', { class: 'grid' }, cards,
    h('button', { class: 'card add', onclick: addAccountModal }, h('div', { class: 'ring' }, icon('plus', 18)), 'Add account'))
    : h('div', { class: 'empty' }, h('div', { class: 'ill' }, icon('users', 24)), h('h3', {}, 'No accounts'),
      h('p', {}, 'Each account gets its own private config folder, so logins never mix.'), h('button', { class: 'btn primary lg', onclick: addAccountModal }, icon('userPlus', 15), 'Add account'));
  return [head, h('div', { class: 'content' }, content)];
}
// The account's launcher in the Dock: the word on its icon
function dockValue(a: AccountView) {
  const l = a.launcher;
  if (l?.docked) return h('div', { class: 'v' }, `${l.label}, in the Dock`);
  return h('div', {}, h('button', { class: 'btn ghost sm', title: 'Adds an app for this account to the Dock, with its name on its icon', onclick: () => setDock(a, true) },
    icon('pin', 13), 'Keep in Dock'));
}
async function setDock(a: AccountView, keep: boolean) {
  try { toast('ok', await api.setDock(a.name, keep)); await refresh(); } catch (e) { toast('bad', errText(e)); }
}
// Removing an account signs it out and deletes its own folders unless you turn that off. Repositories that open with
// it have to move first.
function removeModal(a: AccountView) {
  const title = `Remove “${a.name}”?`, them = a.repoCount === 1 ? 'it' : 'them';
  if (a.repoCount) return modal(title, 'trash', h('p', {}, `${a.repoCount === 1 ? 'A repository opens' : `${a.repoCount} repositories open`} with this account. Bind ${them} to another account or unbind ${them} first.`),
    h('button', { class: 'btn', onclick: closeOverlay }, 'OK'));
  let purge = true;
  const says = () => purge ? `Signs it out of Claude Code on this ${IS_MAC ? 'Mac' : 'computer'}, then moves its folders to the Trash: its Claude Code settings and history, its Claude Desktop data and its container sign-in.`
    : 'Its folders stay on disk, and Claude Code stays signed in with them.';
  const note = h('div', { class: 'd' }, says());
  const sw: HTMLButtonElement = h('button', { class: 'switch on', role: 'switch', 'aria-checked': 'true', 'aria-label': 'Sign out and move its folders to the Trash', onclick: () => {
    purge = !purge; sw.classList.toggle('on', purge); sw.setAttribute('aria-checked', String(purge)); note.textContent = says();
  } });
  modal(title, 'trash', [h('p', {}, 'Removes the account from Claude Accounts.'),
    h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, 'Sign out and move its folders to the Trash'), note), sw)],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'),
     h('button', { class: 'btn primary', onclick: async () => {
       closeOverlay();
       try { toast('ok', await api.removeAccount(a.name, purge)); await refresh(); } catch (e) { toast('bad', errText(e)); }
     } }, 'Remove account')]);
}
function renderSettings() {
  const d = data(), p = d.prefs;
  const setting = (t: string, desc: string | null, control: Kid) => h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, t), desc ? h('div', { class: 'd' }, desc) : null), control);
  const seg = <T extends string>(val: T, opts: [T, IconName | null, string][], on: (v: T) => unknown) =>
    h('div', { class: 'seg' }, opts.map(([v, ic, l]) => h('button', { class: val === v ? 'on' : '', onclick: () => on(v) }, ic ? icon(ic, 13) : null, l)));
  const sw = (on: boolean, fn: () => unknown) => h('button', { class: `switch ${on ? 'on' : ''}`, role: 'switch', 'aria-checked': String(on), onclick: fn });
  const code = (text: string, label: string) => h('div', { class: 'codebox' }, h('code', { title: text }, text), h('button', { class: 'btn ghost sm icon-only', title: 'Copy', onclick: () => copyText(text, label) }, icon('copy', 13)));
  const cli = h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, 'Command-line tool'), h('div', { class: 'd', id: 'cli-status' }, 'Checking…')));
  api.cliStatus().then(st => {
    const el = document.getElementById('cli-status'); if (!el) return;
    el.textContent = st.installed ? `Installed at ${tilde(st.path)}${st.onPath ? '' : ' (add ~/.local/bin to PATH)'}`
      : st.outdated ? `An older \`ca\` is at ${tilde(st.path)}. Update replaces it with this version.` : 'Installs the bundled `ca` command to ~/.local/bin. Same config as this app.';
    cli.append(h('button', { class: 'btn sm', onclick: () => act(() => api.installCli(), 'Command-line tool installed') }, icon('terminal', 13), st.installed ? 'Reinstall' : st.outdated ? 'Update `ca`' : 'Install `ca`'));
  }).catch(() => {});
  return [header('Settings'), h('div', { class: 'content' }, h('div', { class: 'settings' },
    h('div', { class: 'group' }, h('h2', {}, 'Appearance'), h('p', {}, 'Designed dark-first. “System” follows your OS appearance.'),
      h('div', { class: 'panel' }, setting('Theme', null, seg(p.theme, [['system', 'monitor', 'System'], ['dark', 'moon', 'Dark'], ['light', 'sun', 'Light']], v => act(() => api.setPrefs({ theme: v }))))),
    ),
    h('div', { class: 'group' }, h('h2', {}, 'Launching'), h('p', {}, 'Where “Open” and “Sign in” run their command.'),
      h('div', { class: 'panel' },
        IS_MAC ? setting('Terminal app', 'Used for terminal and Docker modes.', seg(p.terminal, [['Terminal', null, 'Terminal'], ['iTerm', null, 'iTerm2']], v => act(() => api.setPrefs({ terminal: v })))) : null,
        IS_MAC || PLATFORM === 'win32' ? setting(IS_MAC ? 'Menu bar item' : 'Tray icon', 'Quick-launch any repository from the menu bar.', sw(p.tray, () => act(() => api.setPrefs({ tray: !p.tray })))) : null,
        d.launchDisabled && setting('Demo / safe mode', d.launchDisabled ? 'Launching is disabled (CA_NO_LAUNCH=1). Commands are copied instead.' : 'Off. Buttons open terminals and Desktop instances.', h('span', { class: `badge ${d.launchDisabled ? 'warn' : 'neutral'}` }, d.launchDisabled ? 'On' : 'Off')))),
    h('div', { class: 'group' }, h('h2', {}, 'Shell integration'), h('p', {}, 'Make plain `claude` pick the right account when you cd into a bound repo.'),
      h('div', { class: 'panel' }, cli,
        h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, 'zsh'), h('div', { class: 'd' }, 'Add to ~/.zshrc')), code('eval "$(ca shell-hook zsh)"', 'zsh hook')),
        h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, 'bash'), h('div', { class: 'd' }, 'Add to ~/.bashrc')), code('eval "$(ca shell-hook bash)"', 'bash hook')))),
    h('div', { class: 'group' }, h('h2', {}, 'Data'), h('p', {}, 'Shared with the `ca` CLI. Edits from either side show up live.'),
      h('div', { class: 'panel' }, h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, 'Config file'), pathEl(d.configPath, 'repo-path')),
        h('button', { class: 'btn sm', onclick: () => api.reveal({ target: 'config' }) }, icon('folderOpen', 13), IS_MAC ? 'Reveal' : 'Open')))),
    h('div', { class: 'group' }, h('h2', {}, 'Privacy & safety'),
      h('div', { class: 'panel' }, h('ul', { class: 'bullets' },
        ['No network access and no telemetry. The app only loads its own bundled files.',
         'Credential files are never opened, shown or sent. Sign-in status comes from whether they exist and from `claude auth status`, which reports the email and plan, never the token.',
         'ANTHROPIC_API_KEY is removed from every launch so the subscription login is used.',
         'Account folders are created private (0700).'].map(t => h('li', {}, icon('check', 14), t))))),
    h('div', { class: 'group' }, h('h2', {}, 'About'), h('div', { class: 'panel' },
      setting(`Claude Accounts ${d.version}`, 'Independent tool. Not affiliated with or endorsed by Anthropic. Check that your use of several accounts complies with the provider’s terms.', logoMark(28)),
      setting('Run onboarding again', null, h('button', { class: 'btn sm', onclick: () => { S.onb = { step: 0 }; go('repos'); } }, 'Start')))),
  ))];
}

// ------------------------------------------------------------------ onboarding
function renderOnboarding(): HTMLElement[] {
  const d = data();
  if (!S.onb) S.onb = { step: 0 };
  const o = S.onb;
  const steps = ['Add account', 'Sign in', 'Bind a repo'];
  const stepper = h('div', { class: 'steps' }, steps.map((t, i) => h('div', { class: `step ${i === o.step ? 'on' : i < o.step ? 'done' : ''}` },
    h('span', { class: 'n' }, i < o.step ? icon('check', 11) : i + 1), t, i < steps.length - 1 ? h('span', { class: 'bar' }) : null)));
  // the account can be gone by now (removed from the CLI), and then setup starts over
  const a = o.step > 0 ? d.accounts.find(x => x.name === o.account) || d.accounts[0] : undefined;
  if (o.step > 0 && !a) o.step = 0;
  let body: HTMLElement;
  if (o.step === 0 || !a) {
    const inp = h('input', { class: 'input', placeholder: 'e.g. work', value: o.name || '', autofocus: true, oninput: e => { o.name = (e.target as HTMLInputElement).value; }, onkeydown: e => e.key === 'Enter' && next() });
    const err = h('div', { class: 'error-text' });
    const next = async () => {
      const name = inp.value.trim(); if (!name) { err.textContent = 'Give the account a short name.'; return; }
      try { await api.addAccount(name); o.account = name; o.step = 1; await refresh(); } catch (e) { err.textContent = errText(e); }
    };
    const first = d.accounts[0];
    body = h('div', { class: 'onb-body' }, h('h3', {}, 'Name your first account'),
      h('p', {}, 'Use one account per subscription, like your work and personal Claude logins. Each gets a private folder.'),
      h('div', { class: 'field' }, inp, h('div', { class: 'suggest' }, ['work', 'personal', 'client'].map(s => h('button', { class: 'chipbtn', onclick: () => { inp.value = o.name = s; inp.focus(); } }, s))), err),
      h('div', { class: 'onb-actions' }, first ? h('button', { class: 'btn ghost', onclick: () => { o.step = 1; o.account = first.name; render(); } }, 'Use existing account')
        : h('button', { class: 'btn ghost', onclick: finishOnb }, 'Skip setup'),
      h('button', { class: 'btn primary', onclick: next }, 'Continue', icon('arrowRight', 14))));
    setTimeout(() => inp.focus(), 30);
  } else if (o.step === 1) {
    const signedIn = a.login === 'logged-in', next = () => { o.step = 2; render(); };
    const status = signedIn ? h('div', { class: 'onb-status ok' }, icon('checkCircle', 15),
        h('span', {}, 'Signed in', a.email ? [' as ', h('strong', { class: 'selectable' }, a.email)] : null, a.plan ? ` (${planName(a.plan)})` : null))
      : a.signingIn ? h('div', { class: 'onb-status' }, icon('refresh', 15, 'spin'), h('span', {}, 'Waiting for the sign-in to finish in your browser…'))
      : null;
    body = h('div', { class: 'onb-body' }, h('h3', {}, `Sign in to “${a.name}”`),
      h('p', {}, 'This opens a terminal running the official `claude auth login` with this account’s folder. Finish the sign-in in your browser.'),
      h('div', { class: 'codebox wrap' }, h('code', { title: a.login_cmd }, a.login_cmd.split(d.home).join('~')), h('button', { class: 'btn ghost sm icon-only', title: 'Copy', onclick: () => copyText(a.login_cmd) }, icon('copy', 13))),
      status,
      h('div', { class: 'onb-actions' }, signedIn ? h('span') : h('button', { class: 'btn ghost', onclick: next }, 'Skip for now'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: () => launch(() => api.login(a.name)) }, icon('terminal', 14), signedIn ? 'Sign in again' : 'Open sign-in'),
          h('button', { class: 'btn primary', onclick: next }, signedIn ? 'Continue' : 'I’m signed in', icon('arrowRight', 14)))));
  } else {
    const name = a.name, repo = o.repo;
    o.mode = o.mode || 'terminal';
    body = h('div', { class: 'onb-body' }, h('h3', {}, 'Bind a repository'),
      h('p', {}, `Sessions started in this folder (and its subfolders) will use “${name}”.`),
      h('div', { class: 'pick', onclick: async () => { const r = await api.pickRepo().catch(e => toast('bad', errText(e))); if (r) { o.repo = r; render(); } } },
        h('div', { class: 'ill' }, icon(repo ? 'folder' : 'folderOpen', 18)),
        repo ? h('div', { class: 'repo-text' }, h('div', { class: 'repo-name' }, repo.name, repo.isGit ? h('span', { class: 'tag' }, 'GIT') : null), pathEl(repo.path)) : h('div', {}, h('div', { class: 'repo-name' }, 'Choose a folder…'), h('div', { class: 'faint' }, 'Usually a git repository'))),
      modeCards(o.mode, m => { o.mode = m; render(); }),
      h('div', { class: 'onb-actions' }, h('button', { class: 'btn ghost', onclick: finishOnb }, 'Skip for now'),
        h('button', { class: 'btn primary', disabled: !repo, onclick: async () => {
          if (repo && await act(() => api.bind(repo.path, name, o.mode || 'terminal'), `${repo.name} bound to ${name}`)) finishOnb();
        } }, 'Finish setup', icon('check', 14))));
  }
  return [h('div', { class: 'header drag bare' }), h('div', { class: 'onb' }, h('div', { class: 'onb-card' },
    h('div', { class: 'onb-hero' }, logoMark(56), h('h2', {}, 'Welcome to Claude Accounts'), h('p', {}, 'One Claude account per repository. Set it up once, then just open.')),
    stepper, body))];
}
async function finishOnb() { S.onb = null; await act(() => api.setPrefs({ onboarded: true })); go('repos'); }
function modeCards(val: Mode, on: (m: Mode) => void) {
  return h('div', { class: 'modes' }, (Object.entries(MODE_META) as [Mode, (typeof MODE_META)[Mode]][]).map(([m, meta]) => h('button', { class: `mode-card ${val === m ? 'on' : ''}`, onclick: () => on(m) },
    icon(meta.icon, 16), h('span', { class: 't' }, meta.label), h('span', { class: 'd' }, meta.desc))));
}

// ------------------------------------------------------------------ overlays
let overlayClose: (() => void) | null = null;
function overlay(node: Node, { center = false } = {}) {
  closeOverlay();
  const scrim = h('div', { class: `scrim ${center ? 'center' : ''}`, onmousedown: e => { if (e.target === scrim) closeOverlay(); } }, node);
  byId('overlay-root').append(scrim);
  overlayClose = () => { scrim.remove(); overlayClose = null; };
}
function closeOverlay() { if (overlayClose) overlayClose(); closeMenu(); }
function modal(title: string, iconName: IconName | null, body: Kid, foot: Kid) {
  overlay(h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, iconName ? icon(iconName, 17) : null, h('h3', {}, title), h('button', { class: 'btn ghost sm icon-only', onclick: closeOverlay }, icon('x', 14))),
    h('div', { class: 'modal-body' }, body), h('div', { class: 'modal-foot' }, foot)), { center: true });
}
function addAccountModal() {
  const inp = h('input', { class: 'input', placeholder: 'e.g. client-x', onkeydown: e => e.key === 'Enter' && save() });
  const err = h('div', { class: 'error-text' });
  const save = async () => {
    try { await api.addAccount(inp.value.trim()); closeOverlay(); toast('ok', `Account “${inp.value.trim()}” added`); S.view = 'accounts'; await refresh(); }
    catch (e) { err.textContent = errText(e); }
  };
  modal('Add account', 'userPlus', [h('p', {}, 'Creates private folders for this account’s CLI login, Desktop data and container login.'),
    h('div', { class: 'field' }, h('label', {}, 'Name'), inp, err)],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Add account')]);
  setTimeout(() => inp.focus(), 20);
}
function renameModal(name: string) {
  const inp = h('input', { class: 'input', value: name, onkeydown: e => e.key === 'Enter' && save() });
  const err = h('div', { class: 'error-text' });
  const save = async () => {
    const next = inp.value.trim();
    if (next === name) { closeOverlay(); return; }
    try {
      await api.renameAccount(name, next);
      closeOverlay();
      if (S.filter === name) S.filter = next;
      if (S.onb?.account === name) S.onb.account = next;
      toast('ok', `“${name}” is now “${next}”`);
      await refresh();
    } catch (e) { err.textContent = errText(e); }
  };
  modal('Rename account', 'pencil', [h('p', {}, `Repositories bound to “${name}” move with it. Its folders stay where they are, so it stays signed in.`),
    h('div', { class: 'field' }, h('label', {}, 'Name'), inp, err)],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Rename')]);
  setTimeout(() => { inp.focus(); inp.select(); }, 20);
}
// Each account's Claude Desktop window signs in once and keeps it in its own folder. A sign-in that finishes in the
// browser comes back as a claude:// link, and macOS hands that to the Claude that was open first: Desktop drops a
// Google sign-in that window didn't start, and the email's link can sign that window in instead. The code from the
// email, typed in the account's window, never leaves it.
function desktopGuide(a: AccountView, run: () => Promise<Launch>) {
  const open = () => { closeOverlay(); launch(run); };
  modal(`Claude Desktop for “${a.name}”`, 'monitor', [
    h('p', {}, 'This account has its own Claude Desktop window. Sign in to it once, and it stays signed in.'),
    h('ol', { class: 'guide-steps' },
      h('li', {}, 'Open the window with the button below.'),
      h('li', {}, 'Choose ', h('strong', {}, 'Continue with email'), ' and enter ', a.email ? h('strong', { class: 'selectable' }, a.email) : 'this account’s email', '.'),
      h('li', {}, 'Type the code from the email into that window. Don’t click the link in the email.')),
    h('p', { class: 'guide-note' }, 'A sign-in that finishes in your browser, like Continue with Google or the email’s link, goes back to the Claude that was open first, not to this window. To sign in with Google, quit your other Claude windows first.')],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'), h('button', { class: 'btn primary', onclick: open }, icon('monitor', 14), 'Open Claude Desktop')]);
}
function bindModal() {
  const d = S.data;
  if (!d) return;
  const first = d.accounts[0];
  if (!first) { toast('warn', 'Add an account first'); return addAccountModal(); }
  const st: { repo: PickedRepo | null; account: string; mode: Mode } = { repo: null, account: S.filter !== 'all' ? S.filter : first.name, mode: 'terminal' };
  const draw = () => {
    const repo = st.repo;
    const accSel = h('div', { class: 'select-wrap boxed chip' }, h('span', { class: `dot ${colorOf(st.account)}` }),
      h('select', { onchange: e => { st.account = (e.target as HTMLSelectElement).value; draw(); } }, d.accounts.map(a => { const o = h('option', { value: a.name }, a.name); o.selected = a.name === st.account; return o; })),
      icon('chevronDown', 13, 'chev'));
    modal('Bind repository', 'link', [
      h('div', { class: 'field' }, h('label', {}, 'Folder'),
        h('div', { class: 'pick', onclick: async () => { const r = await api.pickRepo().catch(e => toast('bad', errText(e))); if (r) { st.repo = r; draw(); } } },
          h('div', { class: 'ill' }, icon(repo ? 'folder' : 'folderOpen', 18)),
          repo ? h('div', { class: 'repo-text' }, h('div', { class: 'repo-name' }, repo.name, repo.isGit ? h('span', { class: 'tag' }, 'GIT') : null), pathEl(repo.path))
            : h('div', {}, h('div', { class: 'repo-name' }, 'Choose a folder…'), h('div', { class: 'faint' }, 'Subfolders inherit the binding')))),
      h('div', { class: 'field' }, h('label', {}, 'Account'), accSel),
      h('div', { class: 'field' }, h('label', {}, 'Open with'), modeCards(st.mode, m => { st.mode = m; draw(); }))],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'),
     h('button', { class: 'btn primary', disabled: !repo, onclick: async () => {
       if (repo && await act(() => api.bind(repo.path, st.account, st.mode), `${repo.name} bound to ${st.account}`)) { closeOverlay(); go('repos'); }
     } }, 'Bind')]);
  };
  draw();
}
function worktreeModal(r: Row) {
  const inp = h('input', { class: 'input mono', placeholder: 'feature-name (empty = let Claude pick)', onkeydown: e => e.key === 'Enter' && go2() });
  const go2 = () => { closeOverlay(); launch(() => api.openTerminal(r.repo, inp.value.trim())); };
  modal('Open in new worktree', 'branch', [h('p', {}, `Starts claude --worktree in ${r.name} with account “${r.account}”.`), h('div', { class: 'field' }, h('label', {}, 'Worktree name'), inp)],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'), h('button', { class: 'btn primary', onclick: go2 }, icon('terminal', 14), 'Open')]);
  setTimeout(() => inp.focus(), 20);
}
function confirmModal(title: string, text: string, okLabel: string, fn: () => unknown) {
  modal(title, null, h('p', {}, text), [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: () => { closeOverlay(); fn(); } }, okLabel)]);
}

// [icon, label, run, key hint, danger], or '-' for a separator
type MenuItem = [icon: IconName, label: string, run: () => unknown, hint?: string | null, danger?: boolean] | '-' | null;
let menuEl: HTMLElement | null = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.querySelectorAll('.btn.open').forEach(b => b.classList.remove('open')); } }
function menu(anchor: HTMLElement, items: MenuItem[]) {
  closeMenu();
  anchor.classList.add('open');
  const el = menuEl = h('div', { class: 'menu', role: 'menu' }, items.filter(it => it !== null).map(it => it === '-' ? h('hr') :
    h('button', { class: it[4] ? 'danger' : '', role: 'menuitem', onclick: () => { closeMenu(); it[2](); } }, icon(it[0], 14), it[1], it[3] ? h('span', { class: 'menu-kbd faint' }, it[3]) : null)));
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), m = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8))}px`;
  el.style.top = `${r.bottom + m.height + 6 > innerHeight ? r.top - m.height - 6 : r.bottom + 6}px`;
  el.querySelector('button')?.focus();
}
document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target as Node | null)) closeMenu(); });

// ------------------------------------------------------------------ command palette
interface PaletteItem { group: string; icon: IconName; label: string; sub?: string; account?: string; hint?: string[]; run: () => unknown; keys: string }
function paletteItems(): PaletteItem[] {
  const d = data(), items: PaletteItem[] = [];
  for (const r of d.repos) {
    const meta = MODE_META[r.mode];
    items.push({ group: 'Repositories', icon: r.mode === 'desktop' ? 'monitor' : 'play', label: `Open ${r.name}`, sub: meta.label, account: r.account, run: () => openRepo(r), keys: `${r.name} ${r.repo} open ${r.account}` });
    if (r.mode !== 'terminal') items.push({ group: 'Repositories', icon: 'terminal', label: `Open ${r.name} in Terminal`, account: r.account, run: () => launch(() => api.openTerminal(r.repo)), keys: `${r.name} terminal ${r.account}` });
  }
  for (const r of d.repos) items.push({ group: 'Copy', icon: 'copy', label: `Copy command for ${r.name}`, account: r.account, run: () => copyCmd({ kind: 'open', repo: r.repo }), keys: `${r.name} copy command ${r.account}` });
  for (const a of d.accounts) {
    const id = `${a.name} ${a.email ?? ''}`;
    items.push({ group: 'Accounts', icon: 'monitor', label: `Open Desktop instance`, sub: a.name, account: a.name, run: () => openDesktop(a), keys: `desktop ${id}` });
    items.push({ group: 'Accounts', icon: 'monitor', label: `Sign in to Claude Desktop…`, sub: a.name, account: a.name, run: () => desktopGuide(a, () => api.desktop(a.name)), keys: `desktop sign in login ${id}` });
    items.push({ group: 'Accounts', icon: 'logIn', label: `Sign in`, sub: a.name, account: a.name, run: () => launch(() => api.login(a.name)), keys: `login sign in ${id}` });
    items.push({ group: 'Accounts', icon: 'pencil', label: `Rename account…`, sub: a.name, account: a.name, run: () => renameModal(a.name), keys: `rename account ${id}` });
    if (d.dock) items.push({ group: 'Accounts', icon: a.launcher?.docked ? 'pinOff' : 'pin', label: a.launcher?.docked ? 'Remove from Dock' : 'Keep in Dock',
                             sub: a.name, account: a.name, run: () => setDock(a, !a.launcher?.docked), keys: `dock pin launcher ${id}` });
  }
  items.push(
    { group: 'General', icon: 'link', label: 'Bind repository…', hint: [MOD, 'N'], run: bindModal, keys: 'bind add repository new' },
    { group: 'General', icon: 'userPlus', label: 'Add account…', hint: [SHIFT, MOD, 'N'], run: addAccountModal, keys: 'add account new' },
    { group: 'General', icon: 'folder', label: 'Go to Repositories', hint: [MOD, '1'], run: () => go('repos'), keys: 'repositories view' },
    { group: 'General', icon: 'users', label: 'Go to Accounts', hint: [MOD, '2'], run: () => go('accounts'), keys: 'accounts view' },
    { group: 'General', icon: 'settings', label: 'Settings', hint: [MOD, ','], run: () => go('settings'), keys: 'settings preferences' },
    { group: 'General', icon: 'refresh', label: 'Refresh sign-in status', hint: [MOD, 'R'], run: () => recheck(), keys: 'refresh status sign in check auth' },
    { group: 'General', icon: d.prefs.theme === 'light' ? 'moon' : 'sun', label: 'Toggle light / dark', run: () => act(() => api.setPrefs({ theme: document.documentElement.classList.contains('light') ? 'dark' : 'light' })), keys: 'theme dark light appearance' },
  );
  return items;
}
// How well a palette item matches, 0 for not at all: the whole query in its text ranks first, then every word of the
// query somewhere in it ("rename work"), then the query's letters in order. Within a tier, an earlier match wins.
function fuzzy(q: string, s: string): number {
  q = q.toLowerCase().trim(); s = s.toLowerCase();
  if (!q) return 1;
  const at = s.indexOf(q);
  if (at >= 0) return 3 + 1 / (1 + at);
  const words = q.split(/\s+/);
  if (words.every(w => s.includes(w))) return 2 + 1 / (1 + words.reduce((n, w) => n + s.indexOf(w), 0));
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return 1;
  return 0;
}
function openPalette(initial = '') {
  if (!S.data) return;
  const all = paletteItems();
  let sel = 0, shown: PaletteItem[] = [];
  const input = h('input', { placeholder: 'Type a command or search repositories…', value: initial, 'aria-label': 'Command palette' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  const draw = () => {
    const q = input.value.trim();
    const scored = all.map(it => ({ it, s: fuzzy(q, it.keys + ' ' + it.label) })).filter(x => x.s > 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    shown = scored.map(x => x.it).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let last: string | null = null;
    const kids: HTMLElement[] = [];
    shown.forEach((it, i) => {
      if (!q && it.group !== last) { kids.push(h('div', { class: 'pal-group' }, it.group)); last = it.group; }
      kids.push(h('div', { class: `pal-item ${i === sel ? 'sel' : ''}`, role: 'option', 'data-i': i, onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: () => run(i) },
        h('span', { class: 'ic' }, icon(it.icon, 14)), h('span', { class: 'lbl' }, it.label, it.sub ? h('em', {}, it.sub) : null),
        h('span', { class: 'hint' }, it.account ? [h('span', { class: `dot ${colorOf(it.account)}` }), it.account] : null, it.hint ? kbd(...it.hint) : null)));
    });
    list.replaceChildren(...(kids.length ? kids : [h('div', { class: 'pal-empty' }, 'No results')]));
  };
  const mark = () => { list.querySelectorAll<HTMLElement>('.pal-item').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === sel)); list.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' }); };
  const run = (i: number) => { const it = shown[i]; if (!it) return; closeOverlay(); it.run(); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  overlay(h('div', { class: 'palette' }, h('div', { class: 'pal-input' }, icon('search', 17), input, kbd('esc')), list,
    h('div', { class: 'pal-foot' }, h('span', {}, kbd('↑', '↓'), 'Navigate'), h('span', {}, kbd('↵'), 'Run'), h('span', {}, kbd('esc'), 'Close'),
      h('span', { class: 'brand' }, logoMark(14), 'Claude Accounts'))));
  draw(); setTimeout(() => input.focus(), 10);
}

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', e => {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const active = document.activeElement as HTMLElement | null;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(active?.tagName ?? '');
  if (e.key === 'Escape') { if (menuEl) { closeMenu(); return; } if (overlayClose) { closeOverlay(); return; } if (typing) active?.blur(); return; }
  if (!S.data) return;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (overlayClose) closeOverlay(); else openPalette(); return; }
  if (overlayClose) return;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); bindModal(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); addAccountModal(); return; }
  if (mod && (e.key === '1' || e.key === '2' || e.key === '3')) { e.preventDefault(); go((['repos', 'accounts', 'settings'] as const)[Number(e.key) - 1]!); return; }
  if (mod && e.key === ',') { e.preventDefault(); go('settings'); return; }
  if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); recheck(); return; }
  if (typing || S.view !== 'repos') return;
  const repos = visibleRepos(), current = repos[S.sel];
  if (e.key === '/') { e.preventDefault(); document.getElementById('repo-filter')?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); selectRow(Math.min(S.sel + 1, repos.length - 1)); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); selectRow(Math.max(S.sel - 1, 0)); }
  else if (e.key === 'Enter' && current && !menuEl) { e.preventDefault(); openRepo(current); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && current) { e.preventDefault(); copyCmd({ kind: 'open', repo: current.repo }); }
});

api.onEvent(ev => {
  switch (ev.type) {
    case 'state-changed': refresh(); break;
    case 'refresh': recheck(); break;
    case 'toast': toast(ev.ok ? 'ok' : 'warn', ev.message, ev.command); break;
    case 'nav': go(ev.view); break;
    case 'palette': openPalette(); break;
    case 'bind': bindModal(); break;
    case 'add-account': addAccountModal(); break;
    case 'desktop-guide': {
      const { account, repo } = ev;
      void refresh().then(() => { const a = accountOf(account); if (a) desktopGuide(a, () => repo ? api.open(repo) : api.desktop(account)); });
      break;
    }
  }
});
window.addEventListener('focus', () => refresh());

refresh().then(() => {
  if (new URLSearchParams(location.search).get('preview') || S.data?.previewPlatform) {
    document.documentElement.classList.add('preview');
    if (IS_MAC) document.body.append(h('div', { class: 'faux-lights', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  }
});
