'use strict';
// Minimal, typed bridge. The renderer never sees Node, fs or child_process.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, p) => ipcRenderer.invoke(ch, p).then(r => { if (!r.ok) throw new Error(r.error); return r.data; });
contextBridge.exposeInMainWorld('ca', {
  state: () => call('state:get'),
  addAccount: name => call('account:add', { name }),
  removeAccount: account => call('account:remove', { account }),
  deepStatus: account => call('account:deepStatus', { account }),
  bind: (repo, account, mode) => call('repo:bind', { repo, account, mode }),
  unbind: repo => call('repo:unbind', { repo }),
  pickRepo: () => call('dialog:pickRepo'),
  open: (repo, worktree) => call('action:open', { repo, worktree }),
  openTerminal: (repo, worktree) => call('action:terminal', { repo, worktree }),
  openDocker: (repo, engine) => call('action:docker', { repo, engine }),
  login: account => call('action:login', { account }),
  desktop: account => call('action:desktop', { account }),
  command: (kind, args) => call('command:get', { kind, ...args }),
  copy: text => call('clipboard:write', { text }),
  reveal: (target, args) => call('shell:reveal', { target, ...args }),
  setPrefs: patch => call('prefs:set', patch),
  cliStatus: () => call('cli:status'),
  installCli: () => call('cli:install'),
  hook: kind => call('hook:get', { kind }),
  onEvent: cb => { const h = (_e, ev) => cb(ev); ipcRenderer.on('app:event', h); return () => ipcRenderer.removeListener('app:event', h); },
});
