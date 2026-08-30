// Which editors this Mac has, and which one you meant.
//
// Mesa does not embed an editor. Embedding a native one would mean adopting
// another process's window into this app's view hierarchy, which macOS has no
// public API for; the editors that could be embedded are the ones with a web
// build, which is not the same set as the ones people use. So ⌘E hands the
// folder to the editor already installed and gets out of the way.
//
// Pure, like session.mjs and flags.mjs: what arrives is a list of file names
// read off a disk and a preference read out of a JSON file, and the rules for
// making sense of them are the part worth testing.

// Matched on the bundle name because that is what `open -a` takes, and because
// it is stable in a way a path is not — an editor moved from /Applications to
// ~/Applications is the same editor.
//
// The order here is the order the chooser offers them in, and it is fixed on
// purpose: a list built in the order the filesystem happened to return would
// put a different editor under the pointer on different machines.
// This list will never be complete, and it is not meant to be — it is the set
// worth offering without being asked. Anything missing is reachable through
// the picker instead, and once picked it is carried here by `pinned` below.
const KNOWN_EDITORS = [
  { app: 'Visual Studio Code', label: 'VS Code' },
  { app: 'Visual Studio Code - Insiders', label: 'VS Code Insiders' },
  { app: 'VSCodium', label: 'VSCodium' },
  { app: 'Cursor', label: 'Cursor' },
  { app: 'Windsurf', label: 'Windsurf' },
  { app: 'Zed', label: 'Zed' },
  { app: 'Sublime Text', label: 'Sublime Text' },
  { app: 'Nova', label: 'Nova' },
  { app: 'BBEdit', label: 'BBEdit' },
  { app: 'TextMate', label: 'TextMate' },
  { app: 'Emacs', label: 'Emacs' },
  { app: 'MacVim', label: 'MacVim' },
  // The JetBrains family, which is most of the reason a fixed list of two or
  // three was never going to hold: someone with RubyMine installed had no way
  // in at all.
  { app: 'IntelliJ IDEA', label: 'IntelliJ IDEA' },
  { app: 'IntelliJ IDEA Ultimate', label: 'IntelliJ IDEA' },
  { app: 'IntelliJ IDEA Community Edition', label: 'IntelliJ IDEA CE' },
  { app: 'WebStorm', label: 'WebStorm' },
  { app: 'PhpStorm', label: 'PhpStorm' },
  { app: 'PyCharm', label: 'PyCharm' },
  { app: 'PyCharm Community Edition', label: 'PyCharm CE' },
  { app: 'RubyMine', label: 'RubyMine' },
  { app: 'GoLand', label: 'GoLand' },
  { app: 'CLion', label: 'CLion' },
  { app: 'Rider', label: 'Rider' },
  { app: 'RustRover', label: 'RustRover' },
  { app: 'DataGrip', label: 'DataGrip' },
  { app: 'Fleet', label: 'Fleet' },
  { app: 'Android Studio', label: 'Android Studio' },
  { app: 'Xcode', label: 'Xcode' }
];

// `['Zed.app', 'Chess.app']` → the editors among them. Anything unrecognised
// is passed over rather than guessed at: listing every installed application
// would put 1Password and Discord in a menu about editors, and macOS has no
// honest flag for "this one edits code" — every app that can open a folder,
// Finder included, looks the same to LaunchServices.
//
// `pinned` is the way out of that, and the reason the fixed list above is not
// a ceiling: an application chosen by hand through the picker is offered from
// then on, whether or not this file has ever heard of it. It is still checked
// against what is installed, so an editor deleted last week quietly stops
// being offered rather than failing at launch.
export function editorsFrom(fileNames, pinned = null) {
  const found = new Set();
  for (const name of Array.isArray(fileNames) ? fileNames : []) {
    if (typeof name !== 'string') continue;
    found.add(name.endsWith('.app') ? name.slice(0, -'.app'.length) : name);
  }
  const editors = KNOWN_EDITORS.filter((editor) => found.has(editor.app));
  if (
    typeof pinned === 'string' &&
    pinned &&
    found.has(pinned) &&
    !editors.some((editor) => editor.app === pinned)
  ) {
    // Last, and labelled with its own bundle name: there is nothing else to
    // call an application this file has never seen.
    editors.push({ app: pinned, label: pinned });
  }
  return editors;
}

// The stored preference, checked against what is actually installed. Null
// means "ask" — and it is also what a preference for an editor that has since
// been deleted resolves to, because silently opening a different editor than
// the one someone chose is worse than asking again.
//
// One installed editor is not an answer either. The preference records a
// decision, and a machine with a single editor today can have two tomorrow;
// choosing on someone's behalf now would leave them with a setting they never
// made and no memory of making it.
export function resolveEditor(preference, available) {
  if (typeof preference !== 'string' || !preference) return null;
  return available.find((editor) => editor.app === preference) ?? null;
}
