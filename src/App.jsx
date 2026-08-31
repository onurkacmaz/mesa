import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Workspace, { readCounters, seedCounters } from './Workspace.jsx';
import { SESSION_VERSION, counterSeedsFrom, normalizeSession } from './session.mjs';
import { THEME_MODES, readStoredMode, storeMode, systemTheme } from './theme.js';
import { BrandMark, CloseIcon, PlusIcon } from './icons.jsx';
import { getWorkspaceActions } from './workspaceActions.js';
import { Shortcut, hint, label } from './shortcuts.jsx';
import { normalizeFlags } from './flags.mjs';
import { clampOffset, dropIndex, gapBetween, reorder, slideFor } from './railReorder.mjs';
import Onboarding from './Onboarding.jsx';

const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };

// How far into a slot the mark stands. Every slot holds this lane open on its
// left, so the one the mark is in looks no different in width from the rest.
const MARK_INSET = 9;

// A session that has never held anything: no file at all, or one whose
// workflows are every one of them an empty canvas. Quitting straight out of
// the onboarding writes exactly that second shape — one empty workflow,
// saved on the way out — so counting it as "nothing yet" is what keeps the
// screen from being spent on a launch where nobody read it.
const isUntouched = (restored) =>
  !restored || restored.workflows.every((workflow) => workflow.panes.length === 0);

let workflowCounter = 0;
function makeWorkflow() {
  workflowCounter += 1;
  return { id: `wf-${workflowCounter}`, name: `Workflow ${workflowCounter}` };
}

// How long the app waits after the last change before writing the session.
// Panes are dragged and the canvas panned continuously, so a write per change
// would be a write per frame; a pause of this length means the file is written
// once the hand comes off, and never during the movement itself.
const SAVE_DEBOUNCE_MS = 800;

// How far the pointer travels before a press on a name becomes a drag rather
// than a click. Small enough that the gesture answers straight away, wide
// enough that the hand shake in a click never reorders the rail.
const DRAG_THRESHOLD = 4;

// A drop is followed by the click that ends the same press, and the press
// after that would otherwise arrive as a double click and open the rename
// field. This is the window in which a second press is read as the tail of the
// drag rather than as a new gesture — the length of the system's own double
// click interval, since that is exactly the pairing being undone.
const DRAG_SETTLE_MS = 500;

export default function App() {
  // null until the last session has been read back. Nothing is rendered
  // before then on purpose: opening a default workflow first would mount a
  // workspace, spawn a shell for it, and kill it again a moment later —
  // visible as a flash, and a process born only to die.
  const [workflows, setWorkflows] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  // The workflow a question is standing about, and how much work was in flight
  // at the moment it was asked. Snapshotted with the request rather than read
  // as it is answered, so the number on the rail is the one the question was
  // about even if a command finishes while you are reading it.
  const [pendingClose, setPendingClose] = useState(null);
  // The one-time screen a first launch opens on. False until the flags file
  // has been read and found to say nothing, so it can never flash over a
  // restored workspace on its way to being dismissed.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // The editor ⌘E opens a folder in, once someone has picked one. Held in
  // state because a workspace renders from it; the rest of the flags file is
  // only ever written, so it lives in the ref below.
  const [editorPref, setEditorPref] = useState(null);
  // The whole flags file as this app last understood it. Every write goes
  // through patchFlags and sends the merged whole, because saveFlags replaces
  // the file: writing one field on its own would silently drop the others.
  const flagsRef = useRef(normalizeFlags(null));

  // ⌘T opens a workflow, ⌥⌘1..9 jumps straight to one. Held in refs so the
  // listeners never go stale as workflows come and go.
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // What each workflow opens with, keyed by id. Kept out of state because it
  // is read exactly once per workflow — at the moment its workspace mounts —
  // and a workflow opened after the restore simply has no entry.
  const initialStatesRef = useRef(new Map());
  // Guards every write. Until the last session has been read there is nothing
  // worth saying, and saying it anyway would overwrite the file being read
  // with an empty app.
  const readyRef = useRef(false);
  const saveTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let restored = null;
      try {
        const text = await window.terminalApi.loadSession();
        restored = text ? normalizeSession(JSON.parse(text)) : null;
        // Text that came back but adds up to nothing this app can open — a
        // version it does not know, a shape it cannot trust. The app carries
        // on empty, but the file is put beyond the reach of the first save,
        // because it is the only copy of whatever it was holding.
        if (text && !restored) await window.terminalApi.archiveSession();
      } catch (err) {
        // A session that cannot be read is a lost layout, never a lost app.
        console.error('session restore failed:', err);
      }

      // What this install has already been told. Its own file, so a session
      // that had to be set aside does not also cost the answer to a question
      // already asked — and read here rather than later because the onboarding
      // has to be decided before the first paint, not after one.
      let flags = normalizeFlags(null);
      try {
        const text = await window.terminalApi.loadFlags();
        if (text) flags = normalizeFlags(JSON.parse(text));
      } catch (err) {
        // The worst an unreadable flags file can cost is one extra onboarding.
        console.error('flags restore failed:', err);
      }
      if (cancelled) return;

      flagsRef.current = flags;
      setEditorPref(flags.editor);

      // In front of an empty canvas only. Someone with a workspace to come
      // back to is not owed an introduction, whatever the flags file says.
      if (!flags.seenOnboarding && isUntouched(restored)) setShowOnboarding(true);

      if (restored) {
        // Before any workspace mounts: a workspace that mounted first would
        // ask for an id from a counter still sitting at zero.
        const seeds = counterSeedsFrom(restored);
        seedCounters(seeds);
        workflowCounter = Math.max(workflowCounter, seeds.workflow);
        for (const workflow of restored.workflows) {
          initialStatesRef.current.set(workflow.id, workflow);
        }
        setWorkflows(restored.workflows.map(({ id, name }) => ({ id, name })));
        setActiveId(restored.activeWorkflowId);
      } else {
        const workflow = makeWorkflow();
        setWorkflows([workflow]);
        setActiveId(workflow.id);
      }
      readyRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The whole app as one string. Every workflow is asked for its own half —
  // App holds no pane state and never has, so the only place that knows what
  // is on a canvas is the canvas.
  const snapshot = useCallback(() => {
    const open = workflowsRef.current ?? [];
    return JSON.stringify({
      version: SESSION_VERSION,
      activeWorkflowId: activeIdRef.current,
      counters: { ...readCounters(), workflow: workflowCounter },
      workflows: open.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        // A workspace that has somehow gone is saved as an empty canvas rather
        // than dropped: its name and its place on the rail are still real.
        ...(getWorkspaceActions(workflow.id)?.serialize() ?? {
          view: { zoom: 1, pan: { x: 0, y: 0 } },
          panes: []
        })
      }))
    });
  }, []);

  const scheduleSave = useCallback(() => {
    if (!readyRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      try {
        window.terminalApi.saveSession(snapshot());
      } catch (err) {
        console.error('session save failed:', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }, [snapshot]);

  // Anything the rail itself owns: a workflow opened, closed, renamed, or
  // switched to. What is inside a workflow reports itself through onDirty.
  useEffect(() => {
    scheduleSave();
  }, [workflows, activeId, scheduleSave]);

  // The way out. A debounced write has up to SAVE_DEBOUNCE_MS of work still
  // pending, and the renderer is about to stop existing — so the last write is
  // synchronous, and waits for the file to land rather than for a reply that
  // will never be read.
  useEffect(() => {
    const flush = () => {
      if (!readyRef.current) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      try {
        window.terminalApi.saveSessionSync(snapshot());
      } catch (err) {
        console.error('session flush failed:', err);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [snapshot]);

  const [themeMode, setThemeMode] = useState(readStoredMode);
  const [theme, setTheme] = useState(() =>
    readStoredMode() === 'auto' ? systemTheme() : readStoredMode()
  );

  // 'auto' keeps following the OS for as long as it is selected; picking a
  // side stops listening.
  useEffect(() => {
    storeMode(themeMode);
    if (themeMode !== 'auto') {
      setTheme(themeMode);
      return undefined;
    }
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => setTheme(media.matches ? 'light' : 'dark');
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // In fullscreen the traffic lights are gone, so the room held for them is
  // just a hole on the left of the tab strip.
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.terminalApi.onFullScreenChange(setFullScreen), []);

  // A key pressed inside a browser pane never reached the window, so every app
  // shortcut died the moment a page had focus. Main lifts the few the app owns
  // off the guest and sends them here, where they are replayed as a real
  // keydown on the window — so every existing handler answers it without
  // knowing it came from a page.
  useEffect(
    () =>
      window.terminalApi.onGuestShortcut?.((init) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
      }),
    []
  );

  // Where the mark stands. Every slot reserves the same lane for it, so the
  // names do not shift when it arrives — it travels along the rail from one to
  // the next instead, which is the one piece of motion up here and the only
  // one that is actually saying something: it shows you which way you moved.
  //
  // Measured rather than derived: a workflow's name is whatever the user typed,
  // so no arithmetic on this side can know where a slot begins.
  const railRef = useRef(null);
  const slotRefs = useRef(new Map());
  const [markX, setMarkX] = useState(MARK_INSET);

  useLayoutEffect(() => {
    const rail = railRef.current;
    const slot = slotRefs.current.get(activeId);
    if (!rail || !slot) return undefined;
    const measure = () => setMarkX(slot.offsetLeft + MARK_INSET);
    measure();
    // Renaming, a workflow closing, the window resizing: all of them move the
    // slot without React telling this effect anything new.
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [activeId, workflows]);

  // Taking a workflow along the rail to put it somewhere else in the row.
  //
  // The order in state changes exactly once, on release. Everything before
  // that is a transform: the name in hand tracks the pointer, the names it
  // passes step aside by the width of the hole it left, and nothing reflows —
  // which is what keeps the boxes measured at the start true for the whole
  // gesture, and what keeps a terminal from being re-laid-out because a name
  // above it moved.
  //
  // Pointer events rather than the drag-and-drop API: that one insists on
  // painting a translucent copy of the element and dropping it with a hop, and
  // the rail has no boxes to lift. Here the name simply goes where the hand
  // goes.
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const droppedAtRef = useRef(0);

  // The rest of the gesture is listened for on the window rather than on the
  // name, and setPointerCapture is not used at all. Capture is the tidy answer
  // and it does not hold here: a release measured over the title bar — the
  // strip the rail itself sits in, a hand's width from where the drag started
  // — never arrives, and the drop is silently lost. The window hears every
  // release wherever it lands.
  const moveDrag = useCallback((e) => {
    const state = dragRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    const travelled = e.clientX - state.startX;
    if (!state.moved) {
      if (Math.abs(travelled) < DRAG_THRESHOLD) return;
      state.moved = true;
    }
    const dx = clampOffset(state.rects, state.from, travelled);
    state.to = dropIndex(state.rects, state.from, dx);
    setDrag({ from: state.from, to: state.to, dx, distance: state.distance });
  }, []);

  // The reorder and the end of the drag are one commit, so the transforms come
  // off in the same frame the row is rewritten. Each name's new slot is
  // exactly where its transform had already carried it, which is why the drop
  // is still rather than a jump followed by a slide back.
  const endDrag = useCallback(
    (e) => {
      const state = dragRef.current;
      if (!state || e.pointerId !== state.pointerId) return;
      dragRef.current = null;
      window.removeEventListener('pointermove', moveDrag);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      setDrag(null);
      if (!state.moved) return;
      droppedAtRef.current = performance.now();
      if (state.to !== state.from) {
        setWorkflows((prev) => reorder(prev, state.from, state.to));
      }
    },
    [moveDrag]
  );

  const beginDrag = (e, index) => {
    if (e.button !== 0) return; // a right press is a menu, not a gesture
    if (renamingId) return; // the field owns the pointer while it is open
    if (e.target.closest('.workflow-tab-close')) return;
    const open = workflowsRef.current ?? [];
    if (open.length < 2) return; // one name is already in the only order there is
    const rects = open.map((wf) => {
      const el = slotRefs.current.get(wf.id);
      return { left: el?.offsetLeft ?? 0, width: el?.offsetWidth ?? 0 };
    });
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      from: index,
      to: index,
      rects,
      // The hole a name leaves behind is its own width plus the gap and the
      // cut scored beside it, both of which are the stylesheet's business — so
      // they are read off the rail rather than repeated here.
      distance: rects[index].width + gapBetween(rects),
      moved: false
    };
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  // A window this app is quitting out of mid-drag, which is the only way these
  // outlive the gesture that added them.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', moveDrag);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    },
    [moveDrag, endDrag]
  );

  const addWorkflow = useCallback(() => {
    const wf = makeWorkflow();
    setWorkflows((prev) => [...prev, wf]);
    setActiveId(wf.id);
  }, []);

  // Closing a workflow tears down every terminal in it, which happens simply
  // by unmounting: each session's cleanup kills its own process group.
  const closeWorkflow = useCallback((id) => {
    initialStatesRef.current.delete(id);
    setWorkflows((prev) => {
      if (prev.length === 1) return prev; // never leave the shell with nothing
      const index = prev.findIndex((w) => w.id === id);
      const remaining = prev.filter((w) => w.id !== id);
      setActiveId((current) =>
        current === id ? remaining[Math.max(0, index - 1)].id : current
      );
      return remaining;
    });
  }, []);

  // Closing a workflow kills every terminal in it, so it always asks — the ×
  // on the tab and ⌘W alike. An empty workflow used to close on the spot,
  // which made the same gesture mean two different things depending on state:
  // a question most of the time, and an irreversible close the rest of it. The
  // rail says how much is at stake instead, so an empty one is answered just
  // as fast without the shortcut ever being the odd one out.
  const requestCloseWorkflow = useCallback(
    (id) => {
      const target = id ?? activeIdRef.current;
      if (!target) return;
      if ((workflowsRef.current?.length ?? 0) <= 1) return; // never close the last one
      // The same rule the panes inside it follow: the question is for work in
      // flight, and a workflow of idle prompts and pages has none. App holds no
      // pane state, so it asks the workspace, exactly as it does for a save.
      const running = getWorkspaceActions(target)?.runningCount?.() ?? 0;
      if (!running) {
        closeWorkflow(target);
        return;
      }
      setPendingClose({ id: target, running });
    },
    [closeWorkflow]
  );

  const confirmCloseWorkflow = useCallback(() => {
    setPendingClose((target) => {
      if (target) closeWorkflow(target.id);
      return null;
    });
  }, [closeWorkflow]);

  useEffect(() => {
    if (!pendingClose) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPendingClose(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirmCloseWorkflow();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pendingClose, confirmCloseWorkflow]);

  const renameWorkflow = (id) => {
    const trimmed = nameDraft.trim();
    setRenamingId(null);
    if (trimmed) {
      setWorkflows((prev) => prev.map((w) => (w.id === id ? { ...w, name: trimmed } : w)));
    }
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      // A rename field owns the keyboard while it is open, otherwise typing a
      // "t" into a workflow name silently opens another workflow.
      if (e.target instanceof HTMLInputElement) return;
      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        addWorkflow();
        return;
      }
      // Held with alt, because the bare digits now reach the tabs inside the
      // selected window. Matched on the physical key: alt rewrites e.key into
      // whatever glyph the layout puts there (⌥1 is "¡" on some), so reading
      // the character would make this shortcut depend on the keyboard.
      if (!e.altKey) return;
      const match = /^Digit([1-9])$/.exec(e.code);
      if (match) {
        const target = workflowsRef.current?.[Number(match[1]) - 1];
        if (target) {
          e.preventDefault();
          setActiveId(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addWorkflow]);

  // One field at a time, but always the whole file on the way out. saveFlags
  // replaces what is on disk, so sending `{ seenOnboarding: true }` on its own
  // would take the editor preference with it — and sending `{ editor }` on its
  // own would take the answer the onboarding recorded.
  const patchFlags = useCallback((patch) => {
    const next = normalizeFlags({ ...flagsRef.current, ...patch });
    flagsRef.current = next;
    setEditorPref(next.editor);
    window.terminalApi.saveFlags(JSON.stringify(next));
  }, []);

  // Recorded as the screen goes rather than as it arrives, because what the
  // file is really saying is that someone was here to read it. A launch that
  // was quit out of leaves it unwritten, and isUntouched brings the screen
  // back next time.
  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    patchFlags({ seenOnboarding: true });
  }, [patchFlags]);

  const rememberEditor = useCallback((app) => patchFlags({ editor: app }), [patchFlags]);

  // The one frame between the window appearing and the session arriving. The
  // window's own background colour is the app's, so this reads as the app
  // opening rather than as an empty page — and no rail is drawn holding
  // workflows that are about to be replaced by the real ones.
  if (!workflows) return null;

  // The mark rides the same two rules as the names: carried with the one it
  // stands in front of, or stepped aside by the one going past it.
  const activeIndex = workflows.findIndex((wf) => wf.id === activeId);
  const markShift = !drag
    ? 0
    : activeIndex === drag.from
      ? drag.dx
      : slideFor(activeIndex, drag.from, drag.to, drag.distance);

  return (
    <div className="app">
      {/* The title bar is the workflow strip: the app's identity, then the
          workflows themselves, sitting in the window's own drag region beside
          the traffic lights. */}
      <header className={`titlebar${fullScreen ? ' titlebar-fullscreen' : ''}`}>
        <div
          className={`workflow-rail${drag ? ' workflow-rail-dragging' : ''}`}
          role="tablist"
          aria-label="Workflows"
          ref={railRef}
        >
          {/* One mark for the whole rail, riding above the slots on its own
              lane. aria-hidden because it says nothing a screen reader is not
              already told by aria-selected.

              It stands in front of a workflow, so when that workflow is the
              one being carried it goes with it — a mark left behind at the
              slot the name has just left would be pointing at nothing. Carried
              it travels with the hand and so keeps no transition; pushed aside
              by a name passing it, it moves on the same curve as the names. */}
          <span
            className={`rail-mark${
              drag ? (activeIndex === drag.from ? ' rail-mark-carried' : '') : ''
            }`}
            aria-hidden="true"
            style={{ transform: `translateX(${markX + markShift}px)` }}
          >
            <BrandMark theme={theme} />
          </span>

          {workflows.map((wf, index) => {
            const isActive = wf.id === activeId;
            const carried = drag?.from === index;
            const shift = !drag
              ? 0
              : carried
                ? drag.dx
                : slideFor(index, drag.from, drag.to, drag.distance);
            return (
              <React.Fragment key={wf.id}>
                {/* A cut between slots, not a border around them: the rail is
                    one length of material with the workflows scored into it. */}
                {index > 0 && <span className="rail-cut" aria-hidden="true" />}
              <div
                ref={(el) => {
                  if (el) slotRefs.current.set(wf.id, el);
                  else slotRefs.current.delete(wf.id);
                }}
                role="tab"
                aria-selected={isActive}
                className={`workflow-tab${isActive ? ' workflow-tab-active' : ''}${
                  carried ? ' workflow-tab-carried' : ''
                }`}
                style={shift ? { transform: `translateX(${shift}px)` } : undefined}
                onPointerDown={(e) => beginDrag(e, index)}
                onClick={() => setActiveId(wf.id)}
                onDoubleClick={() => {
                  // Two quick drags in a row end in a double click that was
                  // never one. The rename field opening on top of a rail
                  // someone is still rearranging is the worst kind of
                  // surprise: it swallows the next keystrokes.
                  if (performance.now() - droppedAtRef.current < DRAG_SETTLE_MS) return;
                  setNameDraft(wf.name);
                  setRenamingId(wf.id);
                }}
              >
                {renamingId === wf.id ? (
                  <input
                    autoFocus
                    className="workflow-tab-input"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => renameWorkflow(wf.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameWorkflow(wf.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  // No pane count beside the name. It was real information and
                  // it still read as a mistake: the workflows are called
                  // "Workflow 1" and "Workflow 2" until someone renames them,
                  // so a figure after the name came out as "Workflow 1 1". The
                  // dock along the bottom already names every open pane.
                  <span className="workflow-tab-label">{wf.name}</span>
                )}
                {workflows.length > 1 && (
                  <button
                    className="workflow-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestCloseWorkflow(wf.id);
                    }}
                    aria-label={`Close ${wf.name}`}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* Outside the rail, not the last thing on it. The rail scrolls once
            the workflows outgrow it, and anything inside scrolls away with
            them — which took the one control that makes a new workflow off
            screen exactly when there were enough of them to need it. No cut in
            front of it: it belongs to the row of names, and a cut there left it
            stranded between two scores with nothing to say which side it was
            on. */}
        <button
          className="workflow-add"
          onClick={addWorkflow}
          title={hint('newWorkflow')}
          aria-label={label('newWorkflow')}
        >
          <PlusIcon />
        </button>

        <div className="titlebar-spacer" />

        {/* Opening a pane belongs up here with the other thing that makes
            something new. It is aimed at whichever workflow is active, which
            the strip already knows — the workspace itself publishes what it
            can do rather than App holding it as state and re-rendering every
            open terminal to keep it. */}
        <div className="titlebar-actions">
          <button
            type="button"
            className="titlebar-action"
            onClick={() => getWorkspaceActions(activeId)?.addTerminal('terminal')}
            title={hint('newTerminal')}
          >
            <PlusIcon />
            <span>Terminal</span>
          </button>
          <button
            type="button"
            className="titlebar-action"
            onClick={() => getWorkspaceActions(activeId)?.addTerminal('browser')}
            title={hint('newBrowser')}
          >
            <PlusIcon />
            <span>Browser</span>
          </button>
        </div>

        {/* The same cut that scores the workflows apart, doing the same job at
            the other end of the strip: what makes a window on one side of it,
            a preference on the other. */}
        <span className="rail-cut" aria-hidden="true" />

        <div className="theme-switch" role="group" aria-label="Theme">
          {THEME_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="theme-option"
              aria-pressed={themeMode === mode}
              onClick={() => setThemeMode(mode)}
            >
              {THEME_LABELS[mode]}
            </button>
          ))}
        </div>
      </header>

      {/* Every workflow stays mounted so its terminals keep running while you
          work in another one. Only the active one is visible. */}
      <div className="workspaces">
        {workflows.map((wf) => (
          <Workspace
            key={wf.id}
            workflowId={wf.id}
            theme={theme}
            active={wf.id === activeId}
            initialState={initialStatesRef.current.get(wf.id)}
            hideEmptyHint={showOnboarding}
            editorPref={editorPref}
            onEditorChosen={rememberEditor}
            onDirty={scheduleSave}
            onRequestClose={() => requestCloseWorkflow(wf.id)}
          />
        ))}

        {showOnboarding && (
          <Onboarding
            theme={theme}
            onSkip={dismissOnboarding}
            onFinish={() => {
              dismissOnboarding();
              getWorkspaceActions(activeId)?.addTerminal('terminal');
            }}
          />
        )}

        {pendingClose && (
          <div className="confirm-rail" role="alertdialog" aria-modal="true" aria-label="Confirm close">
            <span className="confirm-rail-count">{pendingClose.running}</span>
            <div className="confirm-rail-copy">
              <strong>
                {workflows.find((w) => w.id === pendingClose.id)?.name} will close
              </strong>
              {/* What is actually at stake, which is the whole reason to ask.
                  A workflow with nothing running never gets here — it closes on
                  the spot — so this speaks plainly rather than hedging. */}
              <span>
                {pendingClose.running === 1
                  ? 'a command is running inside it'
                  : 'commands are running inside it'}
              </span>
            </div>
            <div className="confirm-rail-actions">
              <button type="button" className="confirm-cancel" onClick={() => setPendingClose(null)}>
                Cancel <Shortcut id="cancel" />
              </button>
              <button type="button" className="confirm-accept" onClick={confirmCloseWorkflow}>
                Close <Shortcut id="confirm" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
