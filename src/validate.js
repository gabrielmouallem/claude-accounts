'use strict';
// Validation for every IPC payload coming from the renderer.
const path = require('node:path');
const { MODES, validAccountName } = require('./core');

class ValidationError extends Error {}
const fail = m => { throw new ValidationError(m); };

function str(v, name, max = 4096) {
  if (typeof v !== 'string' || !v.length || v.length > max || v.includes('\0')) fail(`invalid ${name}`);
  return v;
}
function newAccountName(v) {
  str(v, 'account name', 64);
  if (!validAccountName(v))
    fail('Use letters, numbers, dot, dash and underscore, up to 64. Start with a letter or number, don\'t end with a dot, and avoid Windows device names such as con or nul.');
  return v;
}
function existingAccount(cfg, v) { str(v, 'account', 256); if (!Object.prototype.hasOwnProperty.call(cfg.accounts, v)) fail('unknown account'); return v; }
function absPath(v) { str(v, 'path'); if (!path.isAbsolute(v)) fail('path must be absolute'); return v; }
function boundRepo(cfg, v) { absPath(v); if (!Object.prototype.hasOwnProperty.call(cfg.repos, v)) fail('repo not bound'); return v; }
function mode(v) { if (!MODES.includes(v)) fail('invalid mode'); return v; }
function engine(v) { if (v !== 'docker' && v !== 'container') fail('invalid engine'); return v; }
function worktree(v) {
  if (v === undefined || v === null) return null;
  if (v === '') return '';
  str(v, 'worktree', 100); if (!/^[A-Za-z0-9._\/-]+$/.test(v) || v.startsWith('-')) fail('invalid worktree name'); return v;
}
// A shell line the app types into a terminal or puts on the clipboard. Terminal and iTerm type it into the new
// window, and a terminal acts on control characters before the shell sees any quoting: a folder name holding ^U and
// a newline could run a command of its own. Pasting has the same problem, so such a line is neither run nor copied.
function typeable(line) {
  if (/[\x00-\x1f\x7f]/.test(line)) fail('A folder or account path holds a control character, so its command can\'t be run or copied safely. Rename the folder first.');
  return line;
}
function oneOf(v, list, name) { if (!list.includes(v)) fail(`invalid ${name}`); return v; }
function obj(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid payload'); return v; }

module.exports = { ValidationError, str, newAccountName, existingAccount, absPath, boundRepo, mode, engine, worktree, typeable, oneOf, obj };
