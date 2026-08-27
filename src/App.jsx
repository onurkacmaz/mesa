import React, { useCallback, useEffect, useRef, useState } from 'react';
import Workspace from './Workspace.jsx';
import { THEME_MODES, readStoredMode, storeMode, systemTheme } from './theme.js';
import { CloseIcon, PlusIcon } from './icons.jsx';
import { getWorkspaceActions } from './workspaceActions.js';
import { Shortcut, hint, label } from './shortcuts.jsx';

// Bare bespoke mark: a prompt chevron + cursor, drawn as paths (no tile
// behind it). The chevron carries a tight two-stop amber gradient — the
// only gradient in the whole UI, reserved for this one small glyph.
function BrandMark({ theme }) {
  const [from, to] = theme === 'light' ? ['#c98f36', '#7c4f13'] : ['#f0c481', '#c97f2e'];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <defs>
        <linearGradient id="brandGradient" x1="2" y1="3" x2="14" y2="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <path
        d="M3.2 4L7.6 8L3.2 12"
        stroke="url(#brandGradient)"
        strokeWidth="1.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <line x1="9.4" y1="12" x2="13.2" y2="12" stroke="url(#brandGradient)" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };

let workflowCounter = 0;
function makeWorkflow() {
  workflowCounter += 1;
  return { id: `wf-${workflowCounter}`, name: `Workflow ${workflowCounter}` };
}

export default function App() {
  const [workflows, setWorkflows] = useState(() => [makeWorkflow()]);
  const [activeId, setActiveId] = useState(() => workflows?.[0]?.id);
  const [renamingId, setRenamingId] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [pendingClose, setPendingClose] = useState(null);
  const [paneCounts, setPaneCounts] = useState({});

  // ⌘T opens a workflow, ⌘1..9 jumps straight to one. Held in refs so the
  // listeners never go stale as workflows come and go.
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const paneCountsRef = useRef(paneCounts);
  paneCountsRef.current = paneCounts;

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

  const addWorkflow = useCallback(() => {
    const wf = makeWorkflow();
    setWorkflows((prev) => [...prev, wf]);
    setActiveId(wf.id);
  }, []);

  // Closing a workflow tears down every terminal in it, which happens simply
  // by unmounting: each session's cleanup kills its own process group.
  const closeWorkflow = useCallback((id) => {
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

  // Closing a workflow kills every terminal in it, so it asks — except when
  // the workflow is empty, where there is nothing to confirm and a dialog
  // would just be a speed bump.
  const requestCloseWorkflow = useCallback(
    (id) => {
      const target = id ?? activeIdRef.current;
      if (!target) return;
      if (workflowsRef.current.length === 1) return; // never close the last one
      if ((paneCountsRef.current[target] ?? 0) === 0) {
        closeWorkflow(target);
        return;
      }
      setPendingClose(target);
    },
    [closeWorkflow]
  );

  const confirmCloseWorkflow = useCallback(() => {
    setPendingClose((id) => {
      if (id) closeWorkflow(id);
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
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const target = workflowsRef.current[digit - 1];
        if (target) {
          e.preventDefault();
          setActiveId(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addWorkflow]);

  return (
    <div className="app">
      {/* The title bar is the workflow strip: the app's identity, then the
          workflows themselves, sitting in the window's own drag region beside
          the traffic lights. */}
      <header className={`titlebar${fullScreen ? ' titlebar-fullscreen' : ''}`}>
        <div className="titlebar-brand">
          <BrandMark theme={theme} />
        </div>

        <div className="workflow-tabs" role="tablist" aria-label="Workflows">
          {workflows.map((wf) => {
            const isActive = wf.id === activeId;
            return (
              <div
                key={wf.id}
                role="tab"
                aria-selected={isActive}
                className={`workflow-tab${isActive ? ' workflow-tab-active' : ''}`}
                onClick={() => setActiveId(wf.id)}
                onDoubleClick={() => {
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
            );
          })}

          <button
            className="workflow-add"
            onClick={addWorkflow}
            title={hint('newWorkflow')}
            aria-label={label('newWorkflow')}
          >
            <PlusIcon />
          </button>
        </div>

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
            onRequestClose={() => requestCloseWorkflow(wf.id)}
            onPaneCountChange={(count) =>
              setPaneCounts((prev) => (prev[wf.id] === count ? prev : { ...prev, [wf.id]: count }))
            }
          />
        ))}

        {pendingClose && (
          <div className="confirm-rail" role="alertdialog" aria-modal="true" aria-label="Confirm close">
            <span className="confirm-rail-count">{paneCounts[pendingClose] ?? 0}</span>
            <div className="confirm-rail-copy">
              <strong>
                {workflows.find((w) => w.id === pendingClose)?.name} will close
              </strong>
              <span>anything running inside it is terminated</span>
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
