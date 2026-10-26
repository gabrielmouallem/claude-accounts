// Shapes shared by the main process, the preload and the renderer. Types only, with no imports: the renderer is
// type-checked without Node or Electron.

export type System = 'Darwin' | 'Windows' | 'Linux';
export type Mode = 'terminal' | 'docker' | 'desktop';
export type Engine = 'docker' | 'container';
export type LoginState = 'logged-in' | 'keychain?' | 'not-logged-in';

// config.json, which the ca CLI reads and writes too
export interface Account { config_dir: string; desktop_user_data_dir: string; docker_config_dir: string }
export interface Binding { account: string; mode?: Mode }
export interface Config { accounts: Record<string, Account>; repos: Record<string, Binding> }

// A bound repository as the app lists it
export interface Row {
  repo: string; name: string; account: string; mode: Mode; exists: boolean;
  login: LoginState | 'missing-account'; command: string;
}
// What `claude auth status` says about an account's CLI sign-in. `state` is null when it gave no clear answer, and
// `note` says what it did say, for a person to read.
export interface AuthStatus { state: LoginState | null; email: string | null; plan: string | null; org: string | null; note: string }
export interface AccountView extends Account {
  name: string; color: number; login: LoginState; docker_login: LoginState; repoCount: number;
  desktop_cmd: string; login_cmd: string;
  // who the CLI is signed in as, from the app's last `claude auth status`
  email: string | null; plan: string | null; org: string | null; note: string | null;
  // the app is asking `claude auth status` right now, or waiting for a sign-in it opened
  checking: boolean; signingIn: boolean;
  // its Claude Desktop folder is empty: that window has never opened, so it isn't signed in yet
  desktopNew: boolean;
}

// prefs.json in the app's user data: app-only, never in config.json
export type Theme = 'system' | 'dark' | 'light';
export type TerminalApp = 'Terminal' | 'iTerm' | 'default';
export interface Prefs { theme: Theme; terminal: TerminalApp; onboarded: boolean; tray: boolean }

export interface State {
  accounts: AccountView[]; repos: Row[]; configPath: string; system: System; previewPlatform: string; prefs: Prefs;
  launchDisabled: boolean; version: string; home: string;
}
// What a launch reports. `command` is the line it ran, or would have run; a failed launch copies it.
export interface Launch { ok: boolean; message: string; command: string }
export interface PickedRepo { path: string; name: string; isGit: boolean }
// `outdated`: something else is at `path`, such as an older ca, and installing replaces it
export interface CliStatus { installed: boolean; outdated: boolean; path: string; onPath: boolean }
export interface Hook { rc: string; file: string }
export type View = 'repos' | 'accounts' | 'settings';

// What the main process sends on 'app:event'
export type AppEvent =
  | { type: 'state-changed' | 'palette' | 'bind' | 'add-account' | 'refresh' }
  | { type: 'nav'; view: View }
  | { type: 'toast'; ok: boolean; message: string; command?: string }
  // how to sign in to an account's Desktop window that has never opened, then open it (or `repo`, which opens with it)
  | { type: 'desktop-guide'; account: string; repo?: string };

export type CommandRequest =
  | { kind: 'terminal' | 'open' | 'docker' | 'container' | 'direnv'; repo: string; worktree?: string }
  | { kind: 'desktop' | 'login'; account: string };
export type RevealRequest = { target: 'config' } | { target: 'repo'; repo: string } | { target: 'account'; account: string };

// What each IPC channel resolves to. src/validate.ts holds the payload each one takes.
export interface Results {
  'state:get': State;
  'account:add': string;
  'account:remove': void;
  'account:rename': string;
  'repo:bind': string;
  'repo:unbind': void;
  'dialog:pickRepo': PickedRepo | null;
  'action:open': Launch;
  'action:terminal': Launch;
  'action:docker': Launch;
  'action:login': Launch;
  'action:desktop': Launch;
  'command:get': string;
  'clipboard:write': true;
  'shell:reveal': true;
  'prefs:set': Prefs;
  'cli:status': CliStatus;
  'cli:install': CliStatus;
  'hook:get': Hook;
}
export type Channel = keyof Results;

// window.ca, the only API the renderer gets. Every call can reject with a message to show as it is.
export interface Api {
  // `fresh` asks `claude auth status` again for every account before answering
  state(fresh?: boolean): Promise<State>;
  addAccount(name: string): Promise<string>;
  removeAccount(account: string): Promise<void>;
  renameAccount(account: string, name: string): Promise<string>;
  bind(repo: string, account: string, mode: Mode): Promise<string>;
  unbind(repo: string): Promise<void>;
  pickRepo(): Promise<PickedRepo | null>;
  open(repo: string, worktree?: string): Promise<Launch>;
  openTerminal(repo: string, worktree?: string): Promise<Launch>;
  openDocker(repo: string, engine: Engine): Promise<Launch>;
  login(account: string): Promise<Launch>;
  desktop(account: string): Promise<Launch>;
  command(request: CommandRequest): Promise<string>;
  copy(text: string): Promise<true>;
  reveal(request: RevealRequest): Promise<true>;
  setPrefs(patch: Partial<Prefs>): Promise<Prefs>;
  cliStatus(): Promise<CliStatus>;
  installCli(): Promise<CliStatus>;
  hook(kind: 'zsh' | 'bash'): Promise<Hook>;
  onEvent(cb: (event: AppEvent) => void): () => void;
}
