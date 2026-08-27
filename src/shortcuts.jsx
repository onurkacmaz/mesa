// One place that knows what every key combination is, so a shortcut cannot
// read as ⌘⇧0 in the legend and (⌘0) in a tooltip. Two renderers come off the
// same definition because the two destinations take different types: a cap is
// an element, and a native `title` tooltip can only hold a string.
//
// Legends are what is printed on the Mac keyboard itself. The modifiers are
// the glyphs on the key (⌘ ⇧ ⌥ ⌃); the named keys are the words on the key
// (esc, return, delete). That single rule settles the mixture this replaces,
// where a symbol ⏎ sat next to the word esc in the same row — no Mac key is
// labelled ⏎ or ⌫.
//
// Modifiers run in the order macOS composes them, ⌃⌥⇧⌘, with the character
// last: ⇧⌘0, never ⌘⇧0.

export const SHORTCUTS = {
  newWorkflow: { keys: '⌘T', label: 'New workflow' },
  switchWorkflow: { keys: '⌘1–9', label: 'Switch workflow' },
  newTerminal: { keys: '⌘N', label: 'New terminal' },
  newBrowser: { keys: '⌘B', label: 'New browser' },
  closeSelection: { keys: '⌘W', label: 'Close selection' },

  // The modifier on its own: held down, it turns the wheel into zoom. It is a
  // key like any other here, so it gets a cap like any other — what it must
  // not do is join to the next word with a "+", which in this app already
  // means the plus key (see zoomIn).
  command: { keys: '⌘', label: 'Command' },
  space: { keys: 'space', label: 'Space' },

  zoomIn: { keys: '⌘+', label: 'Zoom in' },
  zoomOut: { keys: '⌘−', label: 'Zoom out' },
  zoomReset: { keys: '⌘0', label: 'Actual size' },
  zoomFit: { keys: '⇧⌘0', label: 'Fit to content' },

  omnibox: { keys: '⌘L', label: 'Focus the address bar' },
  newline: { keys: '⇧return', label: 'New line without running' },

  confirm: { keys: 'return', label: 'Confirm' },
  cancel: { keys: 'esc', label: 'Cancel' },
  removeLink: { keys: 'delete', label: 'Remove link' }
};

// A whole combination stays inside one cap. Splitting ⇧⌘0 into three boxes
// would put six bordered chips on the one legend row that lists three
// shortcuts, and a Mac menu prints the run contiguously anyway.
export function Shortcut({ id }) {
  const spec = SHORTCUTS[id];
  if (!spec) return null;
  return <kbd className="kbd">{spec.keys}</kbd>;
}

// For `title` and `aria-label`, which are OS-rendered plain text: "New
// terminal (⌘N)". Nothing here can be styled, so the only thing worth
// getting right is that the words and the keys match what the page shows.
export function hint(id) {
  const spec = SHORTCUTS[id];
  if (!spec) return '';
  return spec.keys ? `${spec.label} (${spec.keys})` : spec.label;
}
