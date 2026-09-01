// Turning one of Warp's command signatures into a schema this app can use.
//
// Pure, like railReorder.mjs: one parsed spec in, a much smaller one out.
// Nothing here reads a disk; scripts/import-command-signatures.mjs does that
// and calls this for each file.
//
// The signatures come from warpdotdev/command-signatures (MIT), which is the
// Fig spec format: name, description, subcommands, options, args. Two reasons
// they cannot be used as they are.
//
// They carry CODE. `generators`, `script`, `postProcess`, `generateSpec` and
// `loadSpec` are all JavaScript, some of it pre-compiled into a string, meant
// to be evaluated by the host to produce live suggestions. Running spec code
// is a subsystem of its own and a large amount of trust to hand a data file,
// so every one of those fields is dropped here rather than filtered later. A
// spec can ask for a generator BY NAME and nothing else, and the name has to
// be one this app already implements.
//
// And they are enormous: 498 specs, 31MB, because every option carries its
// full manual-page description. The list shows one ellipsised line, so the
// descriptions are cut to fit it.

// How long a description may be. The list gives it one line and ellipsises the
// rest, so anything past this is bytes nobody will ever see.
const DESCRIPTION_MAX = 80;

// Fig's argument templates, mapped onto the generators this app has. Anything
// not named here resolves to no generator at all, which is the safe direction:
// a node that offers nothing is a great deal better than one that offers
// something wrong.
const TEMPLATES = {
  filepaths: 'files',
  filepathsMayNotExist: 'files',
  folders: 'directories',
  foldersMayNotExist: 'directories'
};

// The handful of Warp generator names with a real equivalent here. There are
// 240 of them in the corpus and almost all describe things this app cannot
// produce (cloud resources, running containers, package indexes).
const GENERATORS = {
  local_branches: 'git-branches',
  branches: 'git-branches',
  remote_branches: 'git-branches',
  refs_remote_branches: 'git-branches',
  local_or_remote_branch: 'git-branches',
  local_and_remote_branches: 'git-branches',
  search_branches: 'git-branches',
  push_refspec_branches: 'git-branches',
  get_scripts_generator: 'npm-scripts',
  hosts: 'ssh-hosts',
  known_hosts: 'ssh-hosts',
  files_for_staging: 'files',
  tracked_files: 'files',
  get_changed_or_tracked_files: 'files',
  remote_paths: 'files',
  entry_dirs: 'directories'
};

function shorten(description) {
  if (typeof description !== 'string') return '';
  const oneLine = description.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= DESCRIPTION_MAX) return oneLine;
  return `${oneLine.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

// `name` is a string or an array of aliases (`["-q", "--quiet"]`). Kept as it
// arrives — expanding the aliases here would duplicate every description, and
// schema.mjs can offer each one at query time for nothing.
function names(node) {
  const value = node?.name;
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((n) => typeof n === 'string' && n);
  return [];
}

// A static list of values an argument accepts — `for … in`, sdkman's
// `init`/`install`, a flag's allowed words. Plain data, present on 4212 nodes,
// and dropping it threw away completions nothing else can supply: no generator
// can produce them because they are not looked up anywhere, they are simply
// what the command takes.
//
// Capped, because a few specs list hundreds of locale or timezone names and the
// list shows eight.
const SUGGESTIONS_MAX = 60;

function suggestionsFor(args) {
  const arg = Array.isArray(args) ? args[0] : args;
  const raw = arg?.suggestions;
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : item?.name;
    const first = Array.isArray(name) ? name[0] : name;
    if (typeof first !== 'string' || !first) continue;
    const entry = { name: first };
    const description = shorten(typeof item === 'string' ? '' : item?.description);
    if (description) entry.description = description;
    out.push(entry);
    if (out.length === SUGGESTIONS_MAX) break;
  }
  return out.length ? out : null;
}

function generatorFor(args) {
  const arg = Array.isArray(args) ? args[0] : args;
  if (!arg || typeof arg !== 'object') return null;
  // The NAMED generator first, and the generic template only after it. Many
  // nodes carry both, and taking the template because it was checked first got
  // `git checkout` completing filenames — its args say
  // generatorName: ["local_branches", …] and template: "filepaths", and the
  // branches are obviously the answer.
  for (const name of [].concat(arg.generatorName ?? [])) {
    if (GENERATORS[name]) return GENERATORS[name];
  }
  for (const template of [].concat(arg.template ?? [])) {
    if (TEMPLATES[template]) return TEMPLATES[template];
  }
  return null;
}

function trimOption(option) {
  const name = names(option);
  if (name.length === 0) return null;
  const out = { name: name.length === 1 ? name[0] : name };
  const description = shorten(option.description);
  if (description) out.description = description;
  return out;
}

// Depth is capped because a few specs nest absurdly and every level multiplies
// what is kept, for suggestions no one types.
function trimNode(node, depth) {
  const name = names(node);
  if (name.length === 0) return null;

  const out = { name: name.length === 1 ? name[0] : name };
  const description = shorten(node.description);
  if (description) out.description = description;

  const options = (node.options ?? []).map(trimOption).filter(Boolean);
  if (options.length) out.options = options;

  if (depth > 0) {
    const subcommands = (node.subcommands ?? [])
      .map((sub) => trimNode(sub, depth - 1))
      .filter(Boolean);
    if (subcommands.length) out.subcommands = subcommands;
  }

  const generator = generatorFor(node.args);
  const suggestions = suggestionsFor(node.args);
  if (generator || suggestions) {
    out.args = {};
    if (generator) out.args.generator = generator;
    if (suggestions) out.args.suggestions = suggestions;
  }

  return out;
}

export function trimSignature(spec, depth = 3) {
  const trimmed = trimNode(spec, depth);
  if (!trimmed) return null;
  // The top-level name is what the command is looked up by, so it has to be a
  // single string rather than a list of aliases.
  trimmed.name = Array.isArray(trimmed.name) ? trimmed.name[0] : trimmed.name;
  return trimmed;
}
