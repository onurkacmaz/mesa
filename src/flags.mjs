// The handful of things the app remembers about the person using it, rather
// than about their work. A layout belongs in session.json; this file is for
// answers to questions the app should only ask once.
//
// It is kept apart from the session on purpose. session.json is rewritten on
// every change and is archived out of the way whenever it cannot be parsed
// (see src/App.jsx) — so a layout rescued from a bad file would also, silently,
// forget that the onboarding had ever been shown. These two facts have different
// lifetimes and different failure modes, so they get different files.
//
// Pure, for the same reason session.mjs is: what arrives here is text off a
// disk that anything could have edited, and the rules for trusting it should
// be the testable part.

// Nothing has been seen yet, nothing has been chosen. Also what any unreadable
// file resolves to: the worst a corrupt flags file can cost is one extra run of
// the onboarding and one extra question about editors, which is the correct
// price.
const DEFAULTS = { seenOnboarding: false, editor: null };

// The bundle name of the editor ⌘E opens folders in — "Zed", "Cursor". Only a
// non-empty string can be one; whether that editor is still installed is a
// question for src/editors.mjs, which can see what is on the disk. This file
// only says the file held a name.
const asName = (value) => (typeof value === 'string' && value ? value : null);

// seenOnboarding is strictly `true`, never merely truthy. The same rule
// normalizeTab applies to `titleLocked`, and for the same reason — a string, a
// 1, or an object that happens to be present is not someone having answered yes.
export function normalizeFlags(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULTS,
    seenOnboarding: source.seenOnboarding === true,
    editor: asName(source.editor)
  };
}
