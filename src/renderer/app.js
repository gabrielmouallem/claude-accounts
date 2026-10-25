'use strict';
/* global icon, logoMark */
const api = window.ca;
const PLATFORM = new URLSearchParams(location.search).get('platform') || 'darwin';
const IS_MAC = PLATFORM === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const SHIFT = IS_MAC ? '⇧' : 'Shift';
document.documentElement.classList.add(`platform-${PLATFORM}`);

const S = { data: null, view: 'repos', filter: 'all', query: '', sel: -1, deep: {}, onb: null, busy: {} };

// ------------------------------------------------------------------ tiny DOM helper (text only, never innerHTML with data)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
const kbd = (...keys) => h('span', { class: 'kbd' }, keys.map(k => h('kbd', {}, k)));
const tilde = p => (S.data && S.data.home && (p === S.data.home || p.startsWith(S.data.home + '/')) ? '~' + p.slice(S.data.home.length) : p);
const mid = (s, n) => s.length <= n ? s : s.slice(0, Math.ceil(n * .4)) + '…' + s.slice(s.length - Math.floor(n * .6) + 1);
const pathEl = (p, cls = 'repo-path', max = 0) => h('div', { class: cls, title: p }, h('bdi', {}, max ? mid(tilde(p), max) : tilde(p)));
const colorOf = name => { const a = S.data && S.data.accounts.find(x => x.name === name); return a ? `c${a.color % 8}` : 'c7'; };
const initials = s => (s.replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase();
const LOGIN = {
  'logged-in': ['ok', 'Signed in'], 'keychain?': ['warn', 'Keychain?'], 'not-logged-in': ['neutral', 'Not signed in'], 'missing-account': ['bad', 'Missing account'],
};
const loginBadge = s => { const [c, t] = LOGIN[s] || ['neutral', s]; return h('span', { class: `badge ${c}`, title: s === 'keychain?' ? 'macOS keeps the token in the Keychain. Use “Check status” to confirm.' : s }, t); };
const MODE_META = {
  terminal: { icon: 'terminal', label: 'Terminal', desc: 'Native CLI with its own config dir' },
  docker: { icon: 'box', label: 'Docker', desc: 'Isolated container, separate login' },
  desktop: { icon: 'monitor', label: 'Desktop', desc: 'Separate Claude Desktop instance' },
};

// ------------------------------------------------------------------ data
async function refresh() {
  try { S.data = await api.state(); } catch (e) { toast('bad', e.message); return; }
  applyTheme(); render();
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast('ok', okMsg); await refresh(); return r ?? true; }
  catch (e) { toast('bad', e.message); return false; }
}
async function launch(fn) {
  try {
    const r = await fn();
    toast(r.ok ? 'ok' : 'warn', r.message, r.command);
  } catch (e) { toast('bad', e.message); }
}
async function copyText(text, what = 'Command') { try { await api.copy(text); toast('ok', `${what} copied`, text); } catch (e) { toast('bad', e.message); } }
async function copyCmd(kind, args, what) { try { copyText(await api.command(kind, args), what); } catch (e) { toast('bad', e.message); } }

function applyTheme() {
  const t = S.data.prefs.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('light', !dark);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.data && applyTheme());

// ------------------------------------------------------------------ toasts
function toast(kind, msg, cmd) {
  const ic = { ok: 'checkCircle', warn: 'info', bad: 'alert' }[kind];
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, icon(ic, 16),
    h('div', { class: 'body' }, h('div', { class: 'msg' }, msg), cmd ? h('div', { class: 'cmd', title: cmd }, cmd) : null),
    h('button', { class: 'btn ghost sm icon-only', title: 'Dismiss', onclick: () => close() }, icon('x', 14)));
  const root = document.getElementById('toasts');
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  setTimeout(close, kind === 'bad' ? 7000 : 4200);
}

// ------------------------------------------------------------------ sidebar
function renderSidebar() {
  const d = S.data, sb = document.getElementById('sidebar');
  const nav = (id, ic, label, count) => h('button', { class: `nav ${S.view === id ? 'active' : ''}`, onclick: () => go(id) },
    icon(ic, 16), h('span', { class: 'label' }, label), count !== undefined ? h('span', { class: 'count' }, count) : null);
  sb.replaceChildren(
    h('div', { class: 'sb-top drag' }, IS_MAC ? null : h('div', { class: 'sb-brand' }, logoMark(22), h('span', { class: 'name' }, 'Claude Accounts'))),
    h('button', { class: 'sb-search', onclick: openPalette }, icon('search', 14), h('span', {}, 'Search…'), kbd(MOD, 'K')),
    h('div', { class: 'sb-scroll' },
      nav('repos', 'folder', 'Repositories', d.repos.length),
      nav('accounts', 'users', 'Accounts', d.accounts.length),
      nav('settings', 'settings', 'Settings'),
      h('div', { class: 'sb-section' }, 'Accounts',
        h('button', { class: 'btn ghost sm icon-only add', title: 'Add account', onclick: addAccountModal }, icon('plus', 14))),
      d.accounts.length ? d.accounts.map(a => h('button', {
        class: `nav ${S.view === 'repos' && S.filter === a.name ? 'active' : ''}`, title: `Show repositories bound to ${a.name}`,
        onclick: () => { S.filter = a.name; go('repos'); },
      }, h('span', { class: `dot c${a.color % 8}` }), h('span', { class: 'label' }, a.name),
        h('span', { class: 'count' }, a.repoCount),
        h('span', { class: `status-dot ${LOGIN[a.login]?.[0] || ''}`, title: LOGIN[a.login]?.[1] }))) :
        h('div', { class: 'faint', style: null }, h('div', { class: 'nav faint' }, 'No accounts yet'))),
    h('div', { class: 'sb-foot', title: 'No network calls. Credential files are only checked for existence.' }, icon('shield', 14), 'Local only · no network'),
  );
}

// ------------------------------------------------------------------ main
function go(view) { if (S.view !== view) S.sel = -1; S.view = view; render(true); }
function header(title, sub, ...actions) {
  return h('div', { class: 'header drag' }, h('h1', {}, title), sub ? h('span', { class: 'sub' }, sub) : null, h('div', { class: 'spacer' }), actions);
}
function render(animate = false) {
  if (!S.data) return;
  renderSidebar();
  const main = document.getElementById('main');
  const needOnb = S.onb || (!S.data.accounts.length && !S.data.prefs.onboarded);
  let content;
  if (needOnb && S.view !== 'settings') content = renderOnboarding();
  else if (S.view === 'accounts') content = renderAccounts();
  else if (S.view === 'settings') content = renderSettings();
  else content = renderRepos();
  main.replaceChildren(...content);
  if (animate) { const c = main.querySelector('.content, .onb'); if (c) { c.classList.remove('view-enter'); void c.offsetWidth; c.classList.add('view-enter'); } }
}

function visibleRepos() {
  const q = S.query.toLowerCase();
  return S.data.repos.filter(r => (S.filter === 'all' || r.account === S.filter) && (!q || r.repo.toLowerCase().includes(q) || r.account.toLowerCase().includes(q)));
}
function renderRepos() {
  const d = S.data;
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
  const counts = Object.fromEntries(d.accounts.map(a => [a.name, a.repoCount]));
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'filter' }, icon('search', 14), h('input', { class: 'input', id: 'repo-filter', placeholder: 'Filter repositories', value: S.query,
      oninput: e => { S.query = e.target.value; S.sel = -1; const l = document.getElementById('repo-list'); l.replaceWith(repoList(visibleRepos())); } })),
    h('div', { class: 'chips' },
      h('button', { class: `chipbtn ${S.filter === 'all' ? 'on' : ''}`, onclick: () => { S.filter = 'all'; render(); } }, 'All', h('span', { class: 'n' }, d.repos.length)),
      d.accounts.map(a => h('button', { class: `chipbtn ${S.filter === a.name ? 'on' : ''}`, onclick: () => { S.filter = a.name; render(); } },
        h('span', { class: `dot c${a.color % 8}` }), a.name, h('span', { class: 'n' }, counts[a.name] || 0)))));
  return [head, h('div', { class: 'content' }, toolbar, repoList(repos))];
}
function repoList(repos) {
  const list = h('div', { class: 'list', id: 'repo-list' },
    h('div', { class: 'list-head' }, h('span', {}, 'REPOSITORY'), h('span', {}, 'ACCOUNT'), h('span', {}, 'OPENS WITH'), h('span', {}, 'STATUS'), h('span', {})),
    repos.length ? repos.map((r, i) => repoRow(r, i)) : h('div', { class: 'pal-empty' }, 'No repositories match.'));
  return list;
}
function repoRow(r, i) {
  const c = colorOf(r.account);
  const accSel = h('div', { class: 'select-wrap chip' }, h('span', { class: `dot ${c}` }),
    h('select', { title: 'Account', onchange: e => act(() => api.bind(r.repo, e.target.value, r.mode), `${r.name} → ${e.target.value}`) },
      S.data.accounts.map(a => { const o = h('option', { value: a.name }, a.name); o.selected = a.name === r.account; return o; })),
    icon('chevronDown', 13, 'chev'));
  const seg = h('div', { class: 'select-wrap chip', title: MODE_META[r.mode].desc }, icon(MODE_META[r.mode].icon, 13),
    h('select', { title: 'Open with', onchange: e => act(() => api.bind(r.repo, r.account, e.target.value), `${r.name} now opens with ${MODE_META[e.target.value].label}`) },
      Object.entries(MODE_META).map(([m, meta]) => { const o = h('option', { value: m }, meta.label); o.selected = r.mode === m; return o; })),
    icon('chevronDown', 13, 'chev'));
  const more = h('button', { class: 'btn ghost sm icon-only', title: 'More actions' }, icon('more', 16));
  more.addEventListener('click', e => { e.stopPropagation(); repoMenu(r, more); });
  const row = h('div', { class: `row ${S.sel === i ? 'sel' : ''}`, 'data-i': i, ondblclick: () => launch(() => api.open(r.repo)), onclick: () => selectRow(i) },
    h('div', { class: 'repo-cell' }, h('div', { class: `avatar ${c}` }, initials(r.name)),
      h('div', { class: 'repo-text' }, h('div', { class: 'repo-name' }, r.name, r.exists ? null : h('span', { class: 'tag warn' }, 'MISSING')), pathEl(r.repo))),
    h('div', {}, accSel), h('div', {}, seg), h('div', {}, loginBadge(r.login)),
    h('div', { class: 'row-actions' }, more,
      h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); launch(() => api.open(r.repo)); }, title: r.command },
        icon(r.mode === 'desktop' ? 'monitor' : 'play', 12), 'Open')));
  return row;
}
function selectRow(i) {
  S.sel = i;
  document.querySelectorAll('#repo-list .row').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === i));
  const el = document.querySelector(`#repo-list .row[data-i="${i}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
}
function repoMenu(r, anchor) {
  menu(anchor, [
    ['play', 'Open (' + MODE_META[r.mode].label + ')', () => launch(() => api.open(r.repo)), '↵'],
    ['terminal', 'Open in Terminal', () => launch(() => api.openTerminal(r.repo))],
    ['branch', 'Open in new worktree…', () => worktreeModal(r)],
    ['monitor', 'Launch Desktop instance', () => launch(() => api.desktop(r.account))],
    ['box', 'Run in Docker', () => launch(() => api.openDocker(r.repo, 'docker'))],
    ['layers', 'Run in Apple container', () => launch(() => api.openDocker(r.repo, 'container'))],
    '-',
    ['copy', 'Copy command', () => copyCmd('open', { repo: r.repo }), `${SHIFT}${MOD}C`],
    ['code', 'Copy direnv line (.envrc)', () => copyCmd('direnv', { repo: r.repo }, 'direnv line')],
    ['folderOpen', IS_MAC ? 'Reveal in Finder' : 'Open folder', () => api.reveal('repo', { repo: r.repo })],
    ['logIn', `Sign in “${r.account}”…`, () => launch(() => api.login(r.account))],
    '-',
    ['unlink', 'Unbind repository', () => confirmModal(`Unbind ${r.name}?`, 'The folder and the account stay untouched. Only the binding is removed from config.json.', 'Unbind',
      () => act(() => api.unbind(r.repo), `${r.name} unbound`)), null, true],
  ]);
}

// ------------------------------------------------------------------ accounts
function renderAccounts() {
  const d = S.data;
  const head = header('Accounts', d.accounts.length ? `${d.accounts.length} configured` : null,
    h('button', { class: 'btn', onclick: () => refresh().then(() => toast('ok', 'Status refreshed')) }, icon('refresh', 14), 'Refresh'),
    h('button', { class: 'btn primary', onclick: addAccountModal }, icon('userPlus', 14), 'Add account'));
  const cards = d.accounts.map(a => {
    const c = `c${a.color % 8}`, deep = S.deep[a.name];
    const more = h('button', { class: 'btn ghost sm icon-only', title: 'More' }, icon('more', 16));
    more.addEventListener('click', e => { e.stopPropagation(); menu(more, [
      ['copy', 'Copy sign-in command', () => copyText(a.login_cmd)],
      ['copy', 'Copy Desktop command', () => copyText(a.desktop_cmd)],
      ['copy', 'Copy config dir path', () => copyText(a.config_dir, 'Path')],
      ['folderOpen', IS_MAC ? 'Reveal folder in Finder' : 'Open folder', () => api.reveal('account', { account: a.name })],
      '-',
      ['trash', 'Remove from list…', () => confirmModal(`Remove “${a.name}”?`, 'Removes the account from config.json. Its folders (login, history, Desktop data) are kept on disk.', 'Remove',
        () => act(() => api.removeAccount(a.name), `${a.name} removed`)), null, true],
    ]); });
    const loggedIn = a.login === 'logged-in';
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: `avatar round lg ${c}` }, initials(a.name)),
        h('div', {}, h('div', { class: 'title' }, a.name), h('div', { class: 'meta' }, `${a.repoCount} ${a.repoCount === 1 ? 'repository' : 'repositories'}`)), more),
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, 'CLI'), h('div', {}, loginBadge(a.login)),
        h('span', { class: 'k' }, 'Container'), h('div', {}, loginBadge(a.docker_login)),
        h('span', { class: 'k' }, 'Config dir'), pathEl(a.config_dir, 'path', 40)),
      deep ? h('div', { class: 'deep' }, deep === '…' ? icon('refresh', 13, 'spin') : icon('activity', 13), h('span', { class: 'selectable' }, deep === '…' ? 'Asking claude auth status…' : deep)) : null,
      h('div', { class: 'card-foot' },
        h('button', { class: `btn sm ${loggedIn ? '' : 'outline-accent'}`, onclick: () => launch(() => api.login(a.name)) }, icon('logIn', 13), loggedIn ? 'Re-sign in' : 'Sign in'),
        h('button', { class: 'btn sm', onclick: () => launch(() => api.desktop(a.name)) }, icon('monitor', 13), 'Desktop'),
        h('button', { class: 'btn sm ghost', title: 'Runs `claude auth status` locally (prints status, never the token)', onclick: () => deepCheck(a.name) }, icon('activity', 13), 'Check status')));
  });
  const content = d.accounts.length ? h('div', { class: 'grid' }, cards,
    h('button', { class: 'card add', onclick: addAccountModal }, h('div', { class: 'ring' }, icon('plus', 18)), 'Add account'))
    : h('div', { class: 'empty' }, h('div', { class: 'ill' }, icon('users', 24)), h('h3', {}, 'No accounts'),
      h('p', {}, 'Each account gets its own private config folder, so logins never mix.'), h('button', { class: 'btn primary lg', onclick: addAccountModal }, icon('userPlus', 15), 'Add account'));
  return [head, h('div', { class: 'content' }, content)];
}
async function deepCheck(name) {
  S.deep[name] = '…'; render();
  try { S.deep[name] = await api.deepStatus(name); } catch (e) { S.deep[name] = e.message; }
  render();
}

// ------------------------------------------------------------------ settings
function renderSettings() {
  const d = S.data, p = d.prefs;
  const setting = (t, desc, control) => h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, t), desc ? h('div', { class: 'd' }, desc) : null), control);
  const seg = (val, opts, on) => h('div', { class: 'seg' }, opts.map(([v, ic, l]) => h('button', { class: val === v ? 'on' : '', onclick: () => on(v) }, ic ? icon(ic, 13) : null, l)));
  const sw = (on, fn) => h('button', { class: `switch ${on ? 'on' : ''}`, role: 'switch', 'aria-checked': String(on), onclick: fn });
  const code = (text, label) => h('div', { class: 'codebox' }, h('code', { title: text }, text), h('button', { class: 'btn ghost sm icon-only', title: 'Copy', onclick: () => copyText(text, label) }, icon('copy', 13)));
  const cli = h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', { class: 't' }, 'Command-line tool'), h('div', { class: 'd', id: 'cli-status' }, 'Checking…')));
  api.cliStatus().then(st => {
    const el = document.getElementById('cli-status'); if (!el) return;
    el.textContent = st.installed ? `Installed at ${st.path}${st.onPath ? '' : ' (add ~/.local/bin to PATH)'}` : 'Installs the bundled `ca` script (needs python3) to ~/.local/bin. Same config as this app.';
    cli.append(h('button', { class: 'btn sm', onclick: () => act(() => api.installCli(), 'Command-line tool installed') }, icon('terminal', 13), st.installed ? 'Reinstall' : 'Install `ca`'));
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
        h('button', { class: 'btn sm', onclick: () => api.reveal('config', {}) }, icon('folderOpen', 13), IS_MAC ? 'Reveal' : 'Open')))),
    h('div', { class: 'group' }, h('h2', {}, 'Privacy & safety'),
      h('div', { class: 'panel' }, h('ul', { class: 'bullets' },
        ['No network access and no telemetry. The app only loads its own bundled files.',
         'Login status checks only whether a credentials file exists. Its contents are never opened, shown or sent.',
         'On macOS the token lives in the Keychain, so status shows “Keychain?” until you run Check status (`claude auth status`).',
         'ANTHROPIC_API_KEY is removed from every launch so the subscription login is used.',
         'Account folders are created private (0700).'].map(t => h('li', {}, icon('check', 14), t))))),
    h('div', { class: 'group' }, h('h2', {}, 'About'), h('div', { class: 'panel' },
      setting(`Claude Accounts ${d.version}`, 'Independent tool. Not affiliated with or endorsed by Anthropic. Check that your use of several accounts complies with the provider’s terms.', logoMark(28)),
      setting('Run onboarding again', null, h('button', { class: 'btn sm', onclick: () => { S.onb = { step: 0 }; go('repos'); } }, 'Start')))),
  ))];
}

// ------------------------------------------------------------------ onboarding
function renderOnboarding() {
  const d = S.data;
  if (!S.onb) S.onb = { step: 0 };
  const o = S.onb;
  const steps = ['Add account', 'Sign in', 'Bind a repo'];
  const stepper = h('div', { class: 'steps' }, steps.map((t, i) => h('div', { class: `step ${i === o.step ? 'on' : i < o.step ? 'done' : ''}` },
    h('span', { class: 'n' }, i < o.step ? icon('check', 11) : i + 1), t, i < steps.length - 1 ? h('span', { class: 'bar' }) : null)));
  let body;
  if (o.step === 0) {
    const inp = h('input', { class: 'input', placeholder: 'e.g. work', value: o.name || '', autofocus: true, onkeydown: e => e.key === 'Enter' && next() });
    const err = h('div', { class: 'error-text' });
    const next = async () => {
      const name = inp.value.trim(); if (!name) { err.textContent = 'Give the account a short name.'; return; }
      try { await api.addAccount(name); o.account = name; o.step = 1; await refresh(); } catch (e) { err.textContent = e.message; }
    };
    body = h('div', { class: 'onb-body' }, h('h3', {}, 'Name your first account'),
      h('p', {}, 'Use one account per subscription, like your work and personal Claude logins. Each gets a private folder.'),
      h('div', { class: 'field' }, inp, h('div', { class: 'suggest' }, ['work', 'personal', 'client'].map(s => h('button', { class: 'chipbtn', onclick: () => { inp.value = s; inp.focus(); } }, s))), err),
      h('div', { class: 'onb-actions' }, d.accounts.length ? h('button', { class: 'btn ghost', onclick: () => { o.step = 1; o.account = d.accounts[0].name; render(); } }, 'Use existing account')
        : h('button', { class: 'btn ghost', onclick: finishOnb }, 'Skip setup'),
      h('button', { class: 'btn primary', onclick: next }, 'Continue', icon('arrowRight', 14))));
    setTimeout(() => inp.focus(), 30);
  } else if (o.step === 1) {
    const a = d.accounts.find(x => x.name === o.account) || d.accounts[0];
    body = h('div', { class: 'onb-body' }, h('h3', {}, `Sign in to “${a.name}”`),
      h('p', {}, 'This opens a terminal running the official `claude auth login` with this account’s folder. Finish the sign-in in your browser.'),
      h('div', { class: 'codebox wrap' }, h('code', { title: a.login_cmd }, a.login_cmd.split(S.data.home).join('~')), h('button', { class: 'btn ghost sm icon-only', title: 'Copy', onclick: () => copyText(a.login_cmd) }, icon('copy', 13))),
      h('div', { class: 'onb-actions' }, h('button', { class: 'btn ghost', onclick: () => { o.step = 2; render(); } }, 'Skip for now'),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: () => launch(() => api.login(a.name)) }, icon('terminal', 14), 'Open sign-in'),
          h('button', { class: 'btn primary', onclick: () => { o.step = 2; render(); } }, 'I’m signed in', icon('arrowRight', 14)))));
  } else {
    const a = o.account || d.accounts[0]?.name;
    o.mode = o.mode || 'terminal';
    body = h('div', { class: 'onb-body' }, h('h3', {}, 'Bind a repository'),
      h('p', {}, `Sessions started in this folder (and its subfolders) will use “${a}”.`),
      h('div', { class: 'pick', onclick: async () => { const r = await api.pickRepo().catch(e => toast('bad', e.message)); if (r) { o.repo = r; render(); } } },
        h('div', { class: 'ill' }, icon(o.repo ? 'folder' : 'folderOpen', 18)),
        o.repo ? h('div', { class: 'repo-text' }, h('div', { class: 'repo-name' }, o.repo.name, o.repo.isGit ? h('span', { class: 'tag' }, 'GIT') : null), pathEl(o.repo.path)) : h('div', {}, h('div', { class: 'repo-name' }, 'Choose a folder…'), h('div', { class: 'faint' }, 'Usually a git repository'))),
      modeCards(o.mode, m => { o.mode = m; render(); }),
      h('div', { class: 'onb-actions' }, h('button', { class: 'btn ghost', onclick: finishOnb }, 'Skip for now'),
        h('button', { class: 'btn primary', disabled: !o.repo, onclick: async () => {
          if (await act(() => api.bind(o.repo.path, a, o.mode), `${o.repo.name} bound to ${a}`)) finishOnb();
        } }, 'Finish setup', icon('check', 14))));
  }
  return [h('div', { class: 'header drag bare' }), h('div', { class: 'onb' }, h('div', { class: 'onb-card' },
    h('div', { class: 'onb-hero' }, logoMark(56), h('h2', {}, 'Welcome to Claude Accounts'), h('p', {}, 'One Claude account per repository. Set it up once, then just open.')),
    stepper, body))];
}
async function finishOnb() { S.onb = null; await act(() => api.setPrefs({ onboarded: true })); go('repos'); }
function modeCards(val, on) {
  return h('div', { class: 'modes' }, Object.entries(MODE_META).map(([m, meta]) => h('button', { class: `mode-card ${val === m ? 'on' : ''}`, onclick: () => on(m) },
    icon(meta.icon, 16), h('span', { class: 't' }, meta.label), h('span', { class: 'd' }, meta.desc))));
}

// ------------------------------------------------------------------ overlays
let overlayClose = null;
function overlay(node, { center = false, onClose } = {}) {
  closeOverlay();
  const scrim = h('div', { class: `scrim ${center ? 'center' : ''}`, onmousedown: e => { if (e.target === scrim) closeOverlay(); } }, node);
  document.getElementById('overlay-root').append(scrim);
  overlayClose = () => { scrim.remove(); overlayClose = null; onClose && onClose(); };
}
function closeOverlay() { if (overlayClose) overlayClose(); closeMenu(); }
function modal(title, iconName, body, foot) {
  overlay(h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, iconName ? icon(iconName, 17) : null, h('h3', {}, title), h('button', { class: 'btn ghost sm icon-only', onclick: closeOverlay }, icon('x', 14))),
    h('div', { class: 'modal-body' }, body), h('div', { class: 'modal-foot' }, foot)), { center: true });
}
function addAccountModal() {
  const inp = h('input', { class: 'input', placeholder: 'e.g. client-x', onkeydown: e => e.key === 'Enter' && save() });
  const err = h('div', { class: 'error-text' });
  const save = async () => {
    try { await api.addAccount(inp.value.trim()); closeOverlay(); toast('ok', `Account “${inp.value.trim()}” added`); S.view = 'accounts'; await refresh(); }
    catch (e) { err.textContent = e.message; }
  };
  modal('Add account', 'userPlus', [h('p', {}, 'Creates private folders for this account’s CLI login, Desktop data and container login.'),
    h('div', { class: 'field' }, h('label', {}, 'Name'), inp, err)],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Add account')]);
  setTimeout(() => inp.focus(), 20);
}
function bindModal() {
  const d = S.data;
  if (!d.accounts.length) { toast('warn', 'Add an account first'); return addAccountModal(); }
  const st = { repo: null, account: S.filter !== 'all' ? S.filter : d.accounts[0].name, mode: 'terminal' };
  const draw = () => {
    const accSel = h('div', { class: 'select-wrap boxed chip' }, h('span', { class: `dot ${colorOf(st.account)}` }),
      h('select', { onchange: e => { st.account = e.target.value; draw(); } }, d.accounts.map(a => { const o = h('option', { value: a.name }, a.name); o.selected = a.name === st.account; return o; })),
      icon('chevronDown', 13, 'chev'));
    modal('Bind repository', 'link', [
      h('div', { class: 'field' }, h('label', {}, 'Folder'),
        h('div', { class: 'pick', onclick: async () => { const r = await api.pickRepo().catch(e => toast('bad', e.message)); if (r) { st.repo = r; draw(); } } },
          h('div', { class: 'ill' }, icon(st.repo ? 'folder' : 'folderOpen', 18)),
          st.repo ? h('div', { class: 'repo-text' }, h('div', { class: 'repo-name' }, st.repo.name, st.repo.isGit ? h('span', { class: 'tag' }, 'GIT') : null), pathEl(st.repo.path))
            : h('div', {}, h('div', { class: 'repo-name' }, 'Choose a folder…'), h('div', { class: 'faint' }, 'Subfolders inherit the binding')))),
      h('div', { class: 'field' }, h('label', {}, 'Account'), accSel),
      h('div', { class: 'field' }, h('label', {}, 'Open with'), modeCards(st.mode, m => { st.mode = m; draw(); }))],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'),
     h('button', { class: 'btn primary', disabled: !st.repo, onclick: async () => {
       if (await act(() => api.bind(st.repo.path, st.account, st.mode), `${st.repo.name} bound to ${st.account}`)) { closeOverlay(); go('repos'); }
     } }, 'Bind')]);
  };
  draw();
}
function worktreeModal(r) {
  const inp = h('input', { class: 'input mono', placeholder: 'feature-name (empty = let Claude pick)', onkeydown: e => e.key === 'Enter' && go2() });
  const go2 = () => { closeOverlay(); launch(() => api.openTerminal(r.repo, inp.value.trim())); };
  modal('Open in new worktree', 'branch', [h('p', {}, `Starts claude --worktree in ${r.name} with account “${r.account}”.`), h('div', { class: 'field' }, h('label', {}, 'Worktree name'), inp)],
    [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'), h('button', { class: 'btn primary', onclick: go2 }, icon('terminal', 14), 'Open')]);
  setTimeout(() => inp.focus(), 20);
}
function confirmModal(title, text, okLabel, fn) {
  modal(title, null, h('p', {}, text), [h('button', { class: 'btn', onclick: closeOverlay }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: () => { closeOverlay(); fn(); } }, okLabel)]);
}

let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.querySelectorAll('.btn.open').forEach(b => b.classList.remove('open')); } }
function menu(anchor, items) {
  closeMenu();
  anchor.classList.add('open');
  menuEl = h('div', { class: 'menu', role: 'menu' }, items.map(it => it === '-' ? h('hr') :
    h('button', { class: it[4] ? 'danger' : '', role: 'menuitem', onclick: () => { closeMenu(); it[2](); } }, icon(it[0], 14), it[1], it[3] ? h('span', { class: 'menu-kbd faint' }, it[3]) : null)));
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect(), m = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8))}px`;
  menuEl.style.top = `${r.bottom + m.height + 6 > innerHeight ? r.top - m.height - 6 : r.bottom + 6}px`;
  menuEl.querySelector('button').focus();
}
document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });

// ------------------------------------------------------------------ command palette
function paletteItems() {
  const d = S.data, items = [];
  for (const r of d.repos) {
    const meta = MODE_META[r.mode];
    items.push({ group: 'Repositories', icon: r.mode === 'desktop' ? 'monitor' : 'play', label: `Open ${r.name}`, sub: meta.label, account: r.account, run: () => launch(() => api.open(r.repo)), keys: `${r.name} ${r.repo} open ${r.account}` });
    if (r.mode !== 'terminal') items.push({ group: 'Repositories', icon: 'terminal', label: `Open ${r.name} in Terminal`, account: r.account, run: () => launch(() => api.openTerminal(r.repo)), keys: `${r.name} terminal ${r.account}` });
  }
  for (const r of d.repos) items.push({ group: 'Copy', icon: 'copy', label: `Copy command for ${r.name}`, account: r.account, run: () => copyCmd('open', { repo: r.repo }), keys: `${r.name} copy command ${r.account}` });
  for (const a of d.accounts) {
    items.push({ group: 'Accounts', icon: 'monitor', label: `Open Desktop instance`, sub: a.name, account: a.name, run: () => launch(() => api.desktop(a.name)), keys: `desktop ${a.name}` });
    items.push({ group: 'Accounts', icon: 'logIn', label: `Sign in`, sub: a.name, account: a.name, run: () => launch(() => api.login(a.name)), keys: `login sign in ${a.name}` });
    items.push({ group: 'Accounts', icon: 'activity', label: `Check status`, sub: a.name, account: a.name, run: () => { go('accounts'); deepCheck(a.name); }, keys: `status check auth ${a.name}` });
  }
  items.push(
    { group: 'General', icon: 'link', label: 'Bind repository…', hint: [MOD, 'N'], run: bindModal, keys: 'bind add repository new' },
    { group: 'General', icon: 'userPlus', label: 'Add account…', hint: [SHIFT, MOD, 'N'], run: addAccountModal, keys: 'add account new' },
    { group: 'General', icon: 'folder', label: 'Go to Repositories', hint: [MOD, '1'], run: () => go('repos'), keys: 'repositories view' },
    { group: 'General', icon: 'users', label: 'Go to Accounts', hint: [MOD, '2'], run: () => go('accounts'), keys: 'accounts view' },
    { group: 'General', icon: 'settings', label: 'Settings', hint: [MOD, ','], run: () => go('settings'), keys: 'settings preferences' },
    { group: 'General', icon: d.prefs.theme === 'light' ? 'moon' : 'sun', label: 'Toggle light / dark', run: () => act(() => api.setPrefs({ theme: document.documentElement.classList.contains('light') ? 'dark' : 'light' })), keys: 'theme dark light appearance' },
  );
  return items;
}
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return 1;
  if (s.includes(q)) return 100 - s.indexOf(q);
  let i = 0, score = 0;
  for (const c of s) { if (c === q[i]) { i++; score++; } if (i === q.length) return score; }
  return 0;
}
function openPalette(initial = '') {
  if (!S.data) return;
  const all = paletteItems();
  let sel = 0, shown = [];
  const input = h('input', { placeholder: 'Type a command or search repositories…', value: initial, 'aria-label': 'Command palette' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  const draw = () => {
    const q = input.value.trim();
    shown = all.map(it => ({ it, s: fuzzy(q, it.keys + ' ' + it.label) })).filter(x => x.s > 0);
    if (q) shown.sort((a, b) => b.s - a.s);
    shown = shown.map(x => x.it).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let last = null;
    const kids = [];
    shown.forEach((it, i) => {
      if (!q && it.group !== last) { kids.push(h('div', { class: 'pal-group' }, it.group)); last = it.group; }
      kids.push(h('div', { class: `pal-item ${i === sel ? 'sel' : ''}`, role: 'option', 'data-i': i, onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: () => run(i) },
        h('span', { class: 'ic' }, icon(it.icon, 14)), h('span', { class: 'lbl' }, it.label, it.sub ? h('em', {}, it.sub) : null),
        h('span', { class: 'hint' }, it.account ? [h('span', { class: `dot ${colorOf(it.account)}` }), it.account] : null, it.hint ? kbd(...it.hint) : null)));
    });
    list.replaceChildren(...(kids.length ? kids : [h('div', { class: 'pal-empty' }, 'No results')]));
  };
  const mark = () => { list.querySelectorAll('.pal-item').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === sel)); const el = list.querySelector('.pal-item.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); };
  const run = i => { const it = shown[i]; if (!it) return; closeOverlay(); it.run(); };
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
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') { if (menuEl) { closeMenu(); return; } if (overlayClose) { closeOverlay(); return; } if (typing) document.activeElement.blur(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); overlayClose ? closeOverlay() : openPalette(); return; }
  if (overlayClose) return;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); bindModal(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); addAccountModal(); return; }
  if (mod && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); go(['repos', 'accounts', 'settings'][Number(e.key) - 1]); return; }
  if (mod && e.key === ',') { e.preventDefault(); go('settings'); return; }
  if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh().then(() => toast('ok', 'Status refreshed')); return; }
  if (typing || S.view !== 'repos') return;
  const repos = visibleRepos();
  if (e.key === '/') { e.preventDefault(); document.getElementById('repo-filter')?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); selectRow(Math.min(S.sel + 1, repos.length - 1)); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); selectRow(Math.max(S.sel - 1, 0)); }
  else if (e.key === 'Enter' && repos[S.sel] && !menuEl) { e.preventDefault(); launch(() => api.open(repos[S.sel].repo)); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && repos[S.sel]) { e.preventDefault(); copyCmd('open', { repo: repos[S.sel].repo }); }
});

api.onEvent(ev => {
  if (ev.type === 'state-changed') refresh();
  else if (ev.type === 'toast') toast(ev.ok ? 'ok' : 'warn', ev.message, ev.command);
  else if (ev.type === 'nav') go(ev.view);
  else if (ev.type === 'palette') openPalette();
  else if (ev.type === 'bind') bindModal();
  else if (ev.type === 'add-account') addAccountModal();
  else if (ev.type === 'refresh') refresh();
});
window.addEventListener('focus', () => refresh());

refresh().then(() => {
  if (new URLSearchParams(location.search).get('preview') || S.data.previewPlatform) {
    document.documentElement.classList.add('preview');
    if (IS_MAC) document.body.append(h('div', { class: 'faux-lights', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  }
});
