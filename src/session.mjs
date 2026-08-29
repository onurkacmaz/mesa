// What a closed app remembers, and the rules for trusting it again.
//
// Everything here is pure: it takes whatever was on disk — which may be
// half-written, hand-edited, or from a version that no longer exists — and
// returns either a session this app can be built from or nothing at all.
// Nothing in this file touches the filesystem or React, so the one part of
// persistence that can silently ruin a launch is also the part that is
// directly testable.
//
// The governing rule is that a bad file must never cost more than the layout
// it was holding. An app that will not open is a far worse failure than an app
// that opens empty, so every check here fails toward empty rather than toward
// an exception.

export const SESSION_VERSION = 2;

const PANE_KINDS = new Set(['terminal', 'browser']);

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// Everything a terminal would act on rather than display: returns, escape,
// every other C0, and DEL. Exported because the same strip has to happen where
// a command is entered — a paste carries whatever was on the clipboard, and a
// single-line input does not stop it.
export const stripControls = (text) =>
  // eslint-disable-next-line no-control-regex
  typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const isText = (s) => typeof s === 'string' && s.length > 0;

// A count read from a file is a hint, not a promise: it is corrected against
// the ids actually present, so a stale or edited number can never hand out an
// id that is already taken.
const countOf = (value) => (isNum(value) && value >= 0 ? Math.floor(value) : 0);

// `term-12` → 12. The id scheme is a prefix and a run of digits; anything else
// contributes nothing and is simply passed over.
function trailingNumber(id) {
  const match = /-(\d+)$/.exec(typeof id === 'string' ? id : '');
  return match ? Number(match[1]) : 0;
}

// The same idea for a default title ("Terminal 4"), which is numbered by a
// different counter and separated by a space rather than a hyphen. A renamed
// pane usually ends in no digits at all and contributes nothing, which is
// correct: its number is no longer the one the counter handed out.
function trailingCount(text) {
  const match = /(\d+)$/.exec(typeof text === 'string' ? text : '');
  return match ? Number(match[1]) : 0;
}

function normalizeView(raw) {
  const zoom = isNum(raw?.zoom) && raw.zoom > 0 ? raw.zoom : 1;
  const x = isNum(raw?.pan?.x) ? raw.pan.x : 0;
  const y = isNum(raw?.pan?.y) ? raw.pan.y : 0;
  return { zoom, pan: { x, y } };
}

// One session inside a pane. What used to be the pane itself: a terminal with
// a folder and a command, or a browser on an address. The pane is now the box
// they sit in, and the box holds any number of them.
function normalizeTab(raw, kind) {
  if (!isText(raw?.id)) return null;
  const tab = {
    id: raw.id,
    title: isText(raw.title) ? raw.title : kind === 'browser' ? 'Browser' : 'Terminal',
    // A name the user typed sticks; one derived from the folder or the page
    // keeps following what is in the session.
    titleLocked: raw.titleLocked === true
  };
  // The folder a terminal was last sitting in, and the page a browser was
  // last on. Absent is normal — a session that never reported a prompt, or a
  // browser still on its home screen — so neither is worth failing over.
  if (kind === 'terminal' && isText(raw.cwd)) tab.cwd = raw.cwd;
  // The startup command is submitted at the tab's prompt on open, so what is
  // stored here has to be exactly one line: an embedded return would run a
  // second command nobody typed, and this file is plain text that anything
  // could have edited. Every C0 goes, not just the returns — this app already
  // sends \x1b\r to the pty as a real key sequence — so one stored command can
  // only ever be one command.
  if (kind === 'terminal' && isText(raw.command)) {
    const command = stripControls(raw.command);
    if (command) tab.command = command;
  }
  // http(s) only. A saved address is replayed into a guest on launch with no
  // one watching, and this file is plain text on disk that anything could have
  // edited — so the one scheme a browser tab can be opened on is the one a
  // browser tab can reach by itself.
  if (kind === 'browser' && isText(raw.url) && /^https?:\/\//i.test(raw.url)) tab.url = raw.url;
  return tab;
}

function normalizePane(raw, seenTabIds) {
  if (!isText(raw?.id)) return null;
  const kind = PANE_KINDS.has(raw.kind) ? raw.kind : 'terminal';
  if (!isNum(raw.x) || !isNum(raw.y)) return null;
  // A pane with no size is a pane you cannot find again. Rather than guess a
  // box for it, drop it: the rest of the workflow is still worth restoring.
  if (!isNum(raw.width) || raw.width <= 0) return null;
  if (!isNum(raw.height) || raw.height <= 0) return null;

  const tabs = [];
  for (const candidate of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = normalizeTab(candidate, kind);
    // Tab ids come off the same counter pane ids do, so a duplicate would put
    // two live sessions on one id — one terminal's keystrokes arriving in
    // another's pty.
    if (!tab || seenTabIds.has(tab.id)) continue;
    seenTabIds.add(tab.id);
    tabs.push(tab);
  }
  // A pane with no sessions left in it is an empty box: there is nothing to
  // restore and nothing to look at.
  if (!tabs.length) return null;

  const activeTabId = tabs.some((t) => t.id === raw.activeTabId) ? raw.activeTabId : tabs[0].id;

  return {
    id: raw.id,
    kind,
    x: raw.x,
    y: raw.y,
    width: raw.width,
    height: raw.height,
    z: isNum(raw.z) ? raw.z : 1,
    tabs,
    activeTabId
  };
}

// A rope is only meaningful as the thing between two panes, so one whose ends
// did not both survive is dropped with them. Keeping it would draw a line to
// nowhere, which is the exact bug pruneConnections exists to prevent while the
// app is running.
function normalizeConnection(raw, paneIds) {
  if (!isText(raw?.id)) return null;
  if (!paneIds.has(raw.from) || !paneIds.has(raw.to)) return null;
  if (raw.from === raw.to) return null;
  return {
    id: raw.id,
    from: raw.from,
    fromSide: isText(raw.fromSide) ? raw.fromSide : 'right',
    fromT: isNum(raw.fromT) ? raw.fromT : 0.5,
    to: raw.to,
    toSide: isText(raw.toSide) ? raw.toSide : 'left',
    toT: isNum(raw.toT) ? raw.toT : 0.5,
    colorIndex: isNum(raw.colorIndex) ? Math.floor(raw.colorIndex) : 0
  };
}

function normalizeWorkflow(raw, seenPaneIds, seenTabIds) {
  if (!isText(raw?.id)) return null;

  const panes = [];
  const paneIds = new Set();
  for (const candidate of Array.isArray(raw.panes) ? raw.panes : []) {
    const pane = normalizePane(candidate, seenTabIds);
    // Pane ids are handed out from one counter shared by every workflow, so a
    // duplicate is not a local collision — it would put two panes in the app
    // answering to the same terminal session.
    if (!pane || seenPaneIds.has(pane.id)) continue;
    seenPaneIds.add(pane.id);
    paneIds.add(pane.id);
    panes.push(pane);
  }

  const connections = [];
  const connIds = new Set();
  for (const candidate of Array.isArray(raw.connections) ? raw.connections : []) {
    const conn = normalizeConnection(candidate, paneIds);
    if (!conn || connIds.has(conn.id)) continue;
    connIds.add(conn.id);
    connections.push(conn);
  }

  return {
    id: raw.id,
    name: isText(raw.name) ? raw.name : 'Workflow',
    view: normalizeView(raw.view),
    panes,
    connections
  };
}

// Version 1 knew nothing about tabs: a pane WAS a session, and carried the
// folder, the address and the startup command itself. Version 2 turns the pane
// into a box, so each of those panes becomes a box holding exactly the one
// session it already was.
//
// The tab keeps the pane's id. In v1 that id was the terminal's id — it is
// what the pty, the title, the folder and the address were all keyed by — so
// handing it to the tab is not a convenience, it is the same session keeping
// its name.
function migrateV1(raw) {
  return {
    ...raw,
    version: SESSION_VERSION,
    workflows: (Array.isArray(raw.workflows) ? raw.workflows : []).map((workflow) => ({
      ...workflow,
      panes: (Array.isArray(workflow?.panes) ? workflow.panes : []).map((pane) => ({
        ...pane,
        tabs: [
          {
            id: pane?.id,
            title: pane?.title,
            titleLocked: pane?.titleLocked,
            cwd: pane?.cwd,
            url: pane?.url,
            command: pane?.command
          }
        ],
        activeTabId: pane?.id
      }))
    }))
  };
}

// The only entry point. Returns a session that is safe to build the app from,
// or null — meaning "start as if there were no file", which is also what a
// first launch does. Callers never have to tell those two cases apart.
export function normalizeSession(input) {
  if (!input || typeof input !== 'object') return null;
  const raw = input.version === 1 ? migrateV1(input) : input;
  if (raw.version !== SESSION_VERSION) return null;
  if (!Array.isArray(raw.workflows)) return null;

  const seenPaneIds = new Set();
  const seenTabIds = new Set();
  const workflowIds = new Set();
  const workflows = [];
  for (const candidate of raw.workflows) {
    const workflow = normalizeWorkflow(candidate, seenPaneIds, seenTabIds);
    if (!workflow || workflowIds.has(workflow.id)) continue;
    workflowIds.add(workflow.id);
    workflows.push(workflow);
  }

  // No workflows left is indistinguishable from no file: either way the app
  // opens the way it always has, with one empty workflow.
  if (!workflows.length) return null;

  const activeWorkflowId = workflowIds.has(raw.activeWorkflowId)
    ? raw.activeWorkflowId
    : workflows[0].id;

  return {
    version: SESSION_VERSION,
    activeWorkflowId,
    counters: raw.counters && typeof raw.counters === 'object' ? raw.counters : {},
    workflows
  };
}

// Where the id counters have to resume from. They are module-level and start
// at zero every launch, so without this a restored `term-3` is followed by a
// freshly minted `term-1` — two panes, one id, one terminal session between
// them.
//
// Derived from the restored ids themselves and only then raised by whatever
// the file claims, so the seeds hold even if the counters block is stale,
// missing, or edited down by hand.
export function counterSeedsFrom(session) {
  const seeds = {
    pane: countOf(session?.counters?.pane),
    workflow: countOf(session?.counters?.workflow),
    conn: countOf(session?.counters?.conn),
    // Session numbers only name panes ("Terminal 4"), so a low seed costs a
    // confusing duplicate name rather than a collision — still worth getting
    // right, since a second "Terminal 4" reads as a bug.
    session: countOf(session?.counters?.session),
    z: 1
  };
  const raise = (key, value) => {
    if (value > seeds[key]) seeds[key] = value;
  };

  for (const workflow of session?.workflows ?? []) {
    raise('workflow', trailingNumber(workflow.id));
    for (const pane of workflow.panes) {
      raise('pane', trailingNumber(pane.id));
      raise('z', pane.z);
      // Tabs are numbered off the same counter as panes, so a seed that only
      // cleared the pane ids would hand the next tab an id a live session is
      // already answering to.
      for (const tab of pane.tabs) {
        raise('pane', trailingNumber(tab.id));
        raise('session', trailingCount(tab.title));
      }
    }
    for (const conn of workflow.connections) {
      raise('conn', trailingNumber(conn.id));
    }
  }
  return seeds;
}
