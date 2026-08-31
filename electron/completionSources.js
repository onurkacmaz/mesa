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

async function entries(cwd, directoriesOnly) {
  const found = await fs.readdir(cwd, { withFileTypes: true });
  return found
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => (directoriesOnly ? e.isDirectory() : true))
    .map((e) => ({
      value: e.isDirectory() ? `${e.name}/` : e.name,
      description: '',
      source: 'file'
    }));
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

async function history(parseZshHistory) {
  if (historyCache) return historyCache;
  try {
    const file = process.env.HISTFILE || path.join(os.homedir(), '.zsh_history');
    // zsh writes this file in its own eight-bit metafied encoding, so a stray
    // byte is normal and must not throw. 'latin1' keeps every byte and never
    // rejects one; UTF-8 text still compares correctly against a prefix that
    // came through the same door.
    const text = await fs.readFile(file, 'latin1');
    historyCache = parseZshHistory(text);
  } catch {
    historyCache = [];
  }
  return historyCache;
}

// The whole table. A generator name that is not a key here resolves to
// nothing, which is what keeps a schema from reaching anything it likes.
function generators(parseZshHistory) {
  return {
    files: (cwd) => cached(`files:${cwd}`, () => entries(cwd, false)),
    directories: (cwd) => cached(`dirs:${cwd}`, () => entries(cwd, true)),
    'git-branches': (cwd) => cached(`branches:${cwd}`, () => gitBranches(cwd)),
    'npm-scripts': (cwd) => cached(`scripts:${cwd}`, () => npmScripts(cwd)),
    'ssh-hosts': () => cached('ssh', () => sshHosts()),
    path: () => cached('path', () => pathExecutables()),
    history: () => history(parseZshHistory)
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
// It uses rank.mjs's own matcher rather than a local startsWith, and that is
// not tidiness: a plain prefix test here would silently kill the fuzzy match,
// because `gco` would be discarded in this process and never reach the file
// that would have turned it into `git checkout`. One judgement, one place.
// The cut is by SCORE, not by whoever the directory scan happened to reach
// first. Taking the first 200 matches looked equivalent and was not: `git`
// also matches `antigravity` and `mysql_config_editor` as a subsequence, and
// on a PATH of two thousand names those filled the wire and pushed `git`
// itself off it. The renderer would then have ranked a list that never
// contained the obvious answer.
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

module.exports = { generators, filterForWire };
