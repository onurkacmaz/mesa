// What a CLI can be asked to do next, according to a hand-written schema.
//
// Pure, like railReorder.mjs: a schema object, the words already on the line
// and the prefix being typed go in; candidates come out. Nothing here reads a
// disk or runs a command.
//
// `args.generator` is the reason this stays pure. A node that takes live
// values — the branches `git checkout` accepts, the scripts `npm run`
// accepts — names a generator rather than carrying code for one, and the name
// is looked up in a fixed table in the main process. That is the whole
// argument for hand-writing these instead of adopting Fig's ~600-CLI spec
// repository: Fig's generators are executable TypeScript, and running spec
// code safely is a subsystem of its own.

function matches(name, prefix) {
  return prefix === '' || name.startsWith(prefix);
}

// Follow the words down the schema. `git checkout` lands on the checkout
// node; a word belonging to no node ends the walk, because past that point
// nothing in the schema describes what is being typed.
function walk(schema, words) {
  let node = schema;
  for (const word of words.slice(1)) {
    const next = node.subcommands?.find((s) => s.name === word);
    if (!next) return null;
    node = next;
  }
  return node;
}

export function schemaCandidates(schema, words, prefix) {
  const node = walk(schema, words);
  if (!node) return [];

  const option = (o) => ({
    value: o.name,
    description: o.description ?? '',
    source: 'schema'
  });

  // A prefix that opens with a dash is asking for flags, so offering
  // subcommands alongside them would only be noise.
  if (prefix.startsWith('-')) {
    return (node.options ?? []).filter((o) => matches(o.name, prefix)).map(option);
  }

  const subcommands = (node.subcommands ?? [])
    .filter((s) => matches(s.name, prefix))
    .map((s) => ({
      value: s.name,
      description: s.description ?? '',
      source: 'schema'
    }));

  // The marker carries no value of its own: it tells the caller which
  // generator to resolve for this node, and is dropped once it has.
  const generator = node.args?.generator;
  return generator
    ? [...subcommands, { value: '', description: '', source: 'schema', generator }]
    : subcommands;
}
