// Validation for every IPC payload from the renderer: one zod schema per channel, and the checks that need the
// config (an account that exists, a repository that is bound). A failure throws ValidationError, whose message the
// renderer shows as it is.
import path from 'node:path';
import * as z from 'zod';
import { MODES, validAccountName } from './core.ts';
import type { Account, Binding, Channel, Config, Prefs, TerminalApp, Theme } from './types.ts';

export class ValidationError extends Error {}
const fail = (message: string): never => { throw new ValidationError(message); };

export const THEMES = ['system', 'dark', 'light'] as const satisfies readonly Theme[];
export const TERMINALS = ['Terminal', 'iTerm', 'default'] as const satisfies readonly TerminalApp[];

// A string of 1 to `max` characters, without NUL
function text(name: string, max = 4096) {
  const error = `invalid ${name}`;
  return z.string({ error }).min(1, { error }).max(max, { error }).regex(/^[^\0]*$/, { error });
}
const accountName = text('account name', 64).refine(validAccountName, {
  error: 'Use letters, numbers, dot, dash and underscore, up to 64. Start with a letter or number, don\'t end with a dot, and avoid Windows device names such as con or nul.',
});
const account = text('account', 256);
const repo = text('path').refine(p => path.isAbsolute(p), { error: 'path must be absolute' });
// null for no worktree, '' to let Claude Code name it
const worktree = z.string().max(100).regex(/^(?!-)[A-Za-z0-9._/-]*$/, { error: 'invalid worktree name' })
  .nullish().transform(v => v ?? null);
const none = z.strictObject({});

export const PAYLOADS = {
  'state:get': none,
  'account:add': z.strictObject({ name: accountName }),
  'account:remove': z.strictObject({ account }),
  'account:deepStatus': z.strictObject({ account }),
  'repo:bind': z.strictObject({ repo, account, mode: z.enum(MODES).default('terminal') }),
  'repo:unbind': z.strictObject({ repo }),
  'dialog:pickRepo': none,
  'action:open': z.strictObject({ repo, worktree }),
  'action:terminal': z.strictObject({ repo, worktree }),
  'action:docker': z.strictObject({ repo, engine: z.enum(['docker', 'container']).default('docker'), worktree }),
  'action:login': z.strictObject({ account }),
  'action:desktop': z.strictObject({ account }),
  'command:get': z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['terminal', 'open', 'docker', 'container', 'direnv']), repo, worktree }),
    z.strictObject({ kind: z.enum(['desktop', 'login']), account }),
  ]),
  'clipboard:write': z.strictObject({ text: text('text', 20000) }),
  'shell:reveal': z.discriminatedUnion('target', [
    z.strictObject({ target: z.literal('config') }),
    z.strictObject({ target: z.literal('repo'), repo }),
    z.strictObject({ target: z.literal('account'), account }),
  ]),
  'prefs:set': z.strictObject({
    theme: z.enum(THEMES).optional(), terminal: z.enum(TERMINALS).optional(),
    onboarded: z.boolean().optional(), tray: z.boolean().optional(),
  }),
  'cli:status': none,
  'cli:install': none,
  'hook:get': z.strictObject({ kind: z.enum(['zsh', 'bash']) }),
} satisfies Record<Channel, z.ZodType>;

// What the preload sends on a channel, and what its handler gets
export type Payload<C extends Channel> = z.input<(typeof PAYLOADS)[C]>;
export type Parsed<C extends Channel> = z.output<(typeof PAYLOADS)[C]>;

// A failure reads "invalid <field>" unless the schema says more. A channel without a payload gets {}.
export function parse<C extends Channel>(channel: C, payload: unknown): Parsed<C> {
  const schema: z.ZodType = PAYLOADS[channel];
  const r = schema.safeParse(payload ?? {}, { error: iss => `invalid ${String(iss.path?.[0] ?? 'payload')}` });
  if (!r.success) fail(r.error.issues[0]?.message ?? 'invalid payload');
  return r.data as Parsed<C>;
}

// The account a payload names, which has to be in the config
export function knownAccount(cfg: Config, name: string): Account {
  return (Object.hasOwn(cfg.accounts, name) ? cfg.accounts[name] : undefined) ?? fail('unknown account');
}
// The binding of the repository a payload names, which has to be bound
export function boundRepo(cfg: Config, repo: string): Binding {
  return (Object.hasOwn(cfg.repos, repo) ? cfg.repos[repo] : undefined) ?? fail('repo not bound');
}

// A shell line the app types into a terminal or puts on the clipboard. Terminal and iTerm type it into the new
// window, and a terminal acts on control characters before the shell sees any quoting: a folder name holding ^U and
// a newline could run a command of its own. Pasting has the same problem, so such a line is neither run nor copied.
export function typeable(line: string): string {
  if (/[\x00-\x1f\x7f]/.test(line)) fail('A folder or account path holds a control character, so its command can\'t be run or copied safely. Rename the folder first.');
  return line;
}

// prefs.json as saved. A field that doesn't fit, or a file that isn't an object, falls back to the defaults.
export function savedPrefs(saved: unknown, defaults: Prefs): Prefs {
  return z.object({
    theme: z.enum(THEMES).catch(defaults.theme),
    terminal: z.enum(TERMINALS).catch(defaults.terminal),
    onboarded: z.boolean().catch(defaults.onboarded),
    tray: z.boolean().catch(defaults.tray),
  }).catch(defaults).parse(saved);
}
