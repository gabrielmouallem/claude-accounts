// The only API the renderer gets (window.ca). The renderer never sees Node, fs or child_process.
// Import types only: the sandbox gives a preload nothing but electron, and the bundle should hold this file alone.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api, AppEvent, Channel, Results } from './types.ts';
import type { Payload } from './validate.ts';

type Reply<C extends Channel> = { ok: true; data: Results[C] } | { ok: false; error: string };
function call<C extends Channel>(channel: C, payload?: Payload<C>): Promise<Results[C]> {
  return ipcRenderer.invoke(channel, payload).then((r: Reply<C>) => { if (!r.ok) throw new Error(r.error); return r.data; });
}

const api: Api = {
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
  command: request => call('command:get', request),
  copy: text => call('clipboard:write', { text }),
  reveal: request => call('shell:reveal', request),
  setPrefs: patch => call('prefs:set', patch),
  cliStatus: () => call('cli:status'),
  installCli: () => call('cli:install'),
  hook: kind => call('hook:get', { kind }),
  onEvent: cb => {
    const h = (_e: IpcRendererEvent, ev: AppEvent) => cb(ev);
    ipcRenderer.on('app:event', h);
    return () => { ipcRenderer.removeListener('app:event', h); };
  },
};
contextBridge.exposeInMainWorld('ca', api);
