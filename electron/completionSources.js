// Everything a completion needs that lives outside the renderer: the files in
// a directory, the executables on PATH, the branches in a repository, the
// scripts in a package.json, the hosts in an ssh config, and the shell's own
// history.
//
// It is all here, in the main process, for two reasons. The renderer cannot
// touch a disk, and every one of these is slow enough that doing it per
// keystroke would stall the pane — so each is cached, and the cache is keyed
// by the directory the pane is actually in.
//
// A generator is chosen by NAME from the table below. Nothing in a schema
// file reaches this code as a command, an argument or a path: a schema can
// only ask for a generator that already exists here.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

// Long enough that a burst of typing costs one read, short enough that a
// branch you just created shows up without restarting anything.
const TTL_MS = 5000;
const cache = new Map();

async function cached(key, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = [];
  try {
    value = await produce();
  } catch {
    // A directory that has gone, a repository that is not one, a package.json
    // that does not parse: a source that cannot answer offers nothing. It must
    // never take the pane down with it — the same guard the git:branch handler
    // already makes on a path crossing IPC.
    value = [];
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Directories that are almost never what you meant to type. They are usually
// the largest things in a project and they sort to the top of a plain readdir,
// so `ls ` opened with node_modules/ and dist/ ahead of the files actually
// being worked on. Still offered — you sometimes do mean them — but with no
// recency behind them, which puts them last.
const NOISE = new Set([
  'node_modules',
  'dist',
  'build',
  'release',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  '.next',
  'Pods'
]);

// How many entries are worth stat-ing for their modification time. A home
// directory or a monorepo root can hold thousands, and the list shows eight.
const STAT_LIMIT = 400;

async function entries(cwd, directoriesOnly) {
  const found = await fs.readdir(cwd, { withFileTypes: true });
  const wanted = found
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => (directoriesOnly ? e.isDirectory() : true))
    .slice(0, STAT_LIMIT);

  // Modification time, which is the only quality signal a directory listing
  // has. Without it every file weighed the same and they came out in whatever
  // order the filesystem returned them — so `ls ` offered node_modules/ and
  // release/ before the file being edited, and any past command outranked all
  // of them. What you touched an hour ago is what you are about to name.
  return Promise.all(
    wanted.map(async (e) => {
      // count 0 for the noise, which the ranking reads as "no use behind this"
      // and puts last. Leaving the timestamp off instead was not enough and
      // did the opposite: an entry with no recency at all falls through to the
      // neutral multiplier, which is HIGHER than the penalty a genuinely old
      // file gets — so node_modules/ and dist/ came out above the file being
      // worked on rather than below it.
      if (NOISE.has(e.name)) {
        return { value: `${e.name}/`, description: '', source: 'file', count: 0 };
      }
      let at;
      try {
        at = Math.floor((await fs.stat(path.join(cwd, e.name))).mtimeMs / 1000);
      } catch {
        at = undefined; // vanished between the readdir and the stat
      }
      return {
        value: e.isDirectory() ? `${e.name}/` : e.name,
        description: '',
        source: 'file',
        count: 1,
        at
      };
    })
  );
}

async function gitBranches(cwd) {
  const { stdout } = await run(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    { cwd }
  );
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((value) => ({ value, description: '', source: 'schema' }));
}

async function npmScripts(cwd) {
  const text = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
  const scripts = JSON.parse(text).scripts ?? {};
  return Object.entries(scripts).map(([value, command]) => ({
    value,
    description: command,
    source: 'schema'
  }));
}

async function sshHosts() {
  const text = await fs.readFile(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  const hosts = [];
  for (const line of text.split('\n')) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    // A pattern is not a host you can connect to.
    for (const name of match[1].split(/\s+/)) {
      if (name && !name.includes('*') && !name.includes('?')) hosts.push(name);
    }
  }
  return hosts.map((value) => ({ value, description: '', source: 'schema' }));
}

async function pathExecutables() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = new Set();
  for (const dir of dirs) {
    let found;
    try {
      found = await fs.readdir(dir);
    } catch {
      continue; // A PATH entry that does not exist is normal, not an error.
    }
    for (const name of found) names.add(name);
  }
  return [...names].map((value) => ({ value, description: '', source: 'path' }));
}

// Built once and kept. Unlike the others this is not keyed by a directory and
// does not go stale in a way that matters: commands run inside Mesa are added
// by the renderer, and the file itself only grows.
let historyCache = null;

async function history(parseZshHistory, unmetafy) {
  if (historyCache) return historyCache;
  try {
    const file = process.env.HISTFILE || path.join(os.homedir(), '.zsh_history');
    // Read as BYTES and unmetafied by the parser, not decoded here. zsh writes
    // this file in its own metafied encoding, and neither obvious decoding
    // survives it: `grep "^[a-z]" ığş` comes back as `Ä±Ä¿Å¿` through latin1
    // and as `ıă<?>Ń<?>` through UTF-8. Either way the command is not what the
    // user typed and would never match it again.
    const bytes = await fs.readFile(file);
    historyCache = parseZshHistory(unmetafy(bytes));
  } catch {
    historyCache = [];
  }
  return historyCache;
}

// A command just run in this app, put at the front of the history it offers.
//
// zsh does write it to the history file, but on its own schedule — usually
// when the shell exits — so without this the thing you ran a moment ago is not
// offered again until the app is restarted. That is the half of the feature
// that is supposed to feel like it is reading your mind.
//
// It goes only into this process's own list. The file itself is never written
// to: zsh owns it, another shell may be appending to it at this moment, and
// offering completions does not justify a second writer.
function rememberCommand(command) {
  if (!historyCache) return; // nothing read yet; the file will carry it
  const now = Math.floor(Date.now() / 1000);
  const at = historyCache.findIndex((entry) => entry.value === command);
  // Running it again is one more run of the same command, not a new one.
  // Dropping the count here would have quietly demoted the commands used most,
  // which are exactly the ones most likely to be run again.
  const count = at === -1 ? 1 : historyCache[at].count + 1;
  if (at !== -1) historyCache.splice(at, 1);
  // One past the highest recency there is, so it outranks everything read
  // from the file — it is, by definition, the most recent thing you ran.
  const newest = (historyCache[historyCache.length - 1]?.recency ?? 0) + 1;
  // freshness 1: it is, by definition, the most recent thing run. Without it
  // the command you just ran would be scored as though it had no recency at
  // all — worse than one read from the middle of the file.
  historyCache.push({
    value: command,
    source: 'history',
    recency: newest,
    count,
    at: now,
    freshness: 1
  });
}

// The whole table. A generator name that is not a key here resolves to
// nothing, which is what keeps a schema from reaching anything it likes.
function generators(parseZshHistory, unmetafy) {
  return {
    files: (cwd) => cached(`files:${cwd}`, () => entries(cwd, false)),
    directories: (cwd) => cached(`dirs:${cwd}`, () => entries(cwd, true)),
    'git-branches': (cwd) => cached(`branches:${cwd}`, () => gitBranches(cwd)),
    'npm-scripts': (cwd) => cached(`scripts:${cwd}`, () => npmScripts(cwd)),
    'ssh-hosts': () => cached('ssh', () => sshHosts()),
    path: () => cached('path', () => pathExecutables()),
    history: () => history(parseZshHistory, unmetafy)
  };
}

// How many candidates may cross IPC for one keystroke. Well past the eight
// the list can show, so ranking still has room to choose, and far short of
// the few thousand names PATH would otherwise send.
const WIRE_LIMIT = 200;

// Filtered HERE rather than in the renderer, because shipping every PATH
// executable per keystroke is the difference between a list that appears
// instantly and one that stutters.
//
// It uses rank.mjs's own matcher rather than a local one, so the two sides
// never disagree about what counts as a match: one judgement, one place.
//
// The cut is by SCORE, not by whoever the directory scan happened to reach
// first. Taking the first 200 looked equivalent and was not — a case-exact
// match could be pushed off the wire by two hundred case-insensitive ones and
// never reach the renderer at all.
function filterForWire(candidates, prefix, matchScore) {
  if (!prefix) return candidates.slice(0, WIRE_LIMIT);
  const scored = [];
  for (const candidate of candidates) {
    const score = matchScore(candidate.value, prefix);
    if (score !== null) scored.push({ candidate, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, WIRE_LIMIT).map((s) => s.candidate);
}

module.exports = { generators, filterForWire, rememberCommand };
