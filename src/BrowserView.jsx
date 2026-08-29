import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GUEST_FULLSCREEN_SHIM } from './guestFullscreen.js';
import { setPaneUrl } from './paneUrls.js';

// A browser pane, whole: Chromium's toolbar plus the screen the page sits on.
// This strip is deliberately outside the app's own square language — it is
// whatever Chrome is: the pill omnibox, circular hover targets, Material
// icons, Chrome's greys, and the throbber on the tab.

// A new pane opens empty. The guest really is parked on about:blank; what it
// must not do is write "about:blank" in the address bar or cover the screen
// with a white rectangle — both are answered below by the empty-address
// (url === '') case.
export const BROWSER_HOME = 'about:blank';

// Chrome's own line here is "Search Google or type a URL"; this does the same
// job without assuming a search engine.
const OMNIBOX_HINT = 'Enter an address';

// Electron appends the app's name and an "Electron/32.x" token to the end of
// the default User-Agent. Some sites — YouTube is the best known — build the
// page down a broken path when they do not recognise the UA: text and images
// arrive but the icon components stay empty. All this does is drop those two
// tokens and hand the guest the genuine Chrome string that is left; the
// version is not pinned, it is whatever the running Chromium reports.
const CHROME_UA = navigator.userAgent
  .replace(/\sElectron\/\S+/, '')
  .replace(/\s\S+\/\S+(?=\sChrome\/)/, '');

// Chrome's own zoom steps.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// The omnibox is a search box too: an entry with no dot in it is a query,
// not a host.
function normalizeInput(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (!/^[^\s/?#]+\.[^\s/?#]{2,}/.test(s)) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
  }
  return `https://${s}`;
}

// As Chrome does it: https is hidden, the host reads at full strength, the
// rest of the path dims. You cannot colour parts of an input's text — which is
// why the resting state is a button and the typing state an input.
function splitUrl(url) {
  try {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const insecure = u.protocol === 'http:';
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    if (!u.host) {
      return { secure: false, insecure: false, prefix: u.protocol, host: rest || u.href, rest: '' };
    }
    return { secure, insecure, prefix: secure ? '' : `${u.protocol}//`, host: u.host, rest };
  } catch {
    return { secure: false, insecure: false, prefix: '', host: url, rest: '' };
  }
}

/* ── Icons ────────────────────────────────────────────────────────────────
   The Material glyphs Chrome uses, as filled paths on a 24 grid, brought down
   to 16px. The stroked square icons the rest of the app uses do not apply
   here: this strip is meant to be Chromium, exactly. */
const icon = (path) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={path} />
  </svg>
);

const IconBack = () => icon('M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z');
const IconForward = () => icon('M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z');
const IconRefresh = () =>
  icon(
    'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'
  );
const IconStop = () =>
  icon('M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
const IconMore = () =>
  icon(
    'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'
  );

const IconLock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z" />
  </svg>
);

const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
  </svg>
);

const IconSearch = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

// What Chrome puts up for a page with no favicon is a globe.
export function PageMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

// The throbber on Chrome's tab: it takes the favicon's place while the page
// loads. It earns its motion because it reports a state that genuinely
// changes — and under reduced-motion it holds still instead of spinning.
export function Throbber() {
  return (
    <svg className="cr-throbber" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.22" />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function BrowserView({ paneId, initialUrl, focused, onStatus }) {
  const hostRef = useRef(null);
  const readyRef = useRef(false);
  const inputRef = useRef(null);
  const menuRef = useRef(null);

  // Empty address, empty page. about:blank is an absence rather than an
  // address, so it is held that way in state too: the address bar shows its
  // placeholder and the app's own surface covers the screen.
  //
  // A restored pane starts on the address it was left on. Seeded rather than
  // followed: the prop is where this pane opens, not something it stays tied
  // to — every navigation after the first belongs to the guest.
  const [url, setUrl] = useState(() => initialUrl ?? '');
  const [draft, setDraft] = useState(() => initialUrl ?? '');
  const [editing, setEditing] = useState(false);
  // about:blank has nothing to load, so it does not open on a throbber.
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [error, setError] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  // webview methods throw before dom-ready, so every call goes through this
  // gate.
  const guest = () => (readyRef.current ? hostRef.current : null);

  const syncNav = useCallback(() => {
    const w = guest();
    if (!w) return;
    try {
      setCanBack(w.canGoBack());
      setCanForward(w.canGoForward());
    } catch {
      // The guest is briefly unqueryable while it reattaches; the next
      // navigation event will ask again anyway.
    }
  }, []);

  useEffect(() => {
    const w = hostRef.current;
    if (!w) return undefined;

    const onDomReady = () => {
      readyRef.current = true;
      // Every navigation gets its own document, and each one has to be told
      // again that fullscreen stops at the edge of this pane. An in-page
      // navigation keeps the document, and with it the shim already on it.
      w.executeJavaScript(GUEST_FULLSCREEN_SHIM).catch(() => {
        // A page that navigated away mid-injection: the next dom-ready does it.
      });
      syncNav();
    };
    const onStart = () => {
      setLoading(true);
      setError(null);
    };
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    const onNavigate = (e) => {
      if (e.url) {
        const shown = e.url === BROWSER_HOME ? '' : e.url;
        setUrl(shown);
        setEditing(false);
        setDraft(shown);
        // Published as well as kept, for the same reason a terminal publishes
        // its folder: the session is written by Workspace, which never sees
        // inside a guest.
        setPaneUrl(paneId, shown);
      }
      setError(null);
      syncNav();
    };
    const onNavigateInPage = (e) => {
      if (e.isMainFrame && e.url) {
        const shown = e.url === BROWSER_HOME ? '' : e.url;
        setUrl(shown);
        setDraft(shown);
        setPaneUrl(paneId, shown);
      }
      syncNav();
    };
    // A blank page has no title; the "about:blank" Chromium supplies is not a
    // name, and must not stand as one in the pane's title bar.
    const onTitle = (e) =>
      onStatus?.(paneId, { pageTitle: e.title && e.title !== BROWSER_HOME ? e.title : null });
    const onFavicon = (e) => onStatus?.(paneId, { favicon: e.favicons?.[0] ?? null });
    const onFail = (e) => {
      // -3 (ABORTED) is an ordinary cancellation: a new address was entered
      // while a load was finishing. Showing an error screen would be wrong.
      if (!e.isMainFrame || e.errorCode === -3) return;
      setError({ code: e.errorCode, description: e.errorDescription, url: e.validatedURL });
      setLoading(false);
    };

    w.addEventListener('dom-ready', onDomReady);
    w.addEventListener('did-start-loading', onStart);
    w.addEventListener('did-stop-loading', onStop);
    w.addEventListener('did-navigate', onNavigate);
    w.addEventListener('did-navigate-in-page', onNavigateInPage);
    w.addEventListener('page-title-updated', onTitle);
    w.addEventListener('page-favicon-updated', onFavicon);
    w.addEventListener('did-fail-load', onFail);
    return () => {
      w.removeEventListener('dom-ready', onDomReady);
      w.removeEventListener('did-start-loading', onStart);
      w.removeEventListener('did-stop-loading', onStop);
      w.removeEventListener('did-navigate', onNavigate);
      w.removeEventListener('did-navigate-in-page', onNavigateInPage);
      w.removeEventListener('page-title-updated', onTitle);
      w.removeEventListener('page-favicon-updated', onFavicon);
      w.removeEventListener('did-fail-load', onFail);
    };
  }, [paneId, onStatus, syncNav]);

  // The tab's throbber lives in the pane title, so the loading state is
  // reported upward.
  useEffect(() => {
    onStatus?.(paneId, { loading });
  }, [loading, paneId, onStatus]);

  const navigate = useCallback((raw) => {
    const next = normalizeInput(raw);
    const w = guest();
    if (!next || !w) return;
    setEditing(false);
    w.loadURL(next).catch(() => {
      // A load failure already arrives via did-fail-load; swallowing it here
      // is only so no unhandled promise rejection is left behind.
    });
  }, []);

  const beginEditing = useCallback(() => {
    setDraft(url);
    setEditing(true);
  }, [url]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  // ⌘L goes to the omnibox. With focus inside the page, keys go to a separate
  // WebContents and never reach here — this shortcut works while the pane's
  // chrome holds focus.
  useEffect(() => {
    if (!focused) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        beginEditing();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, beginEditing]);

  // The menu closes on an outside click and on Escape — as Chrome's does.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const applyZoom = (direction) => {
    const w = guest();
    if (!w) return;
    const index = ZOOM_STEPS.indexOf(zoom);
    const base = index === -1 ? ZOOM_STEPS.indexOf(1) : index;
    const next =
      direction === 0 ? 1 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, base + direction))];
    w.setZoomFactor(next);
    setZoom(next);
  };

  const parts = splitUrl(url);

  return (
    <>
      <div className="cr-toolbar">
        <button
          type="button"
          className="cr-btn"
          disabled={!canBack}
          onClick={() => guest()?.goBack()}
          title="Back"
          aria-label="Back"
        >
          <IconBack />
        </button>
        <button
          type="button"
          className="cr-btn"
          disabled={!canForward}
          onClick={() => guest()?.goForward()}
          title="Forward"
          aria-label="Forward"
        >
          <IconForward />
        </button>
        <button
          type="button"
          className="cr-btn"
          onClick={() => (loading ? guest()?.stop() : guest()?.reload())}
          title={loading ? 'Stop loading' : 'Reload this page'}
          aria-label={loading ? 'Stop loading' : 'Reload this page'}
        >
          {loading ? <IconStop /> : <IconRefresh />}
        </button>

        {editing ? (
          <div className="cr-omnibox cr-omnibox-active">
            <span className="cr-omnibox-icon">
              <IconSearch />
            </span>
            <input
              ref={inputRef}
              className="cr-omnibox-input"
              value={draft}
              placeholder={OMNIBOX_HINT}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                // Keys must not leak to the canvas: ⌘B cannot open a new
                // pane from in here.
                e.stopPropagation();
                if (e.key === 'Enter') navigate(draft);
                if (e.key === 'Escape') {
                  setDraft(url);
                  setEditing(false);
                }
              }}
            />
          </div>
        ) : (
          <button type="button" className="cr-omnibox" onClick={beginEditing} title={url}>
            <span className={`cr-omnibox-icon${parts.insecure ? ' cr-omnibox-icon-warn' : ''}`}>
              {!url ? (
                <IconSearch />
              ) : parts.insecure ? (
                <IconInfo />
              ) : parts.secure ? (
                <IconLock />
              ) : (
                <IconInfo />
              )}
            </span>
            {parts.insecure && <span className="cr-notsecure">Not secure</span>}
            {url ? (
              <span className="cr-url">
                {parts.prefix && !parts.insecure && <span className="cr-url-dim">{parts.prefix}</span>}
                <span className="cr-url-host">{parts.host}</span>
                {parts.rest && <span className="cr-url-dim">{parts.rest}</span>}
              </span>
            ) : (
              <span className="cr-url cr-url-empty">{OMNIBOX_HINT}</span>
            )}
          </button>
        )}

        <div className="cr-menu-anchor" ref={menuRef}>
          <button
            type="button"
            className={`cr-btn${menuOpen ? ' cr-btn-open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="Customise and control"
            aria-label="Customise and control"
            aria-expanded={menuOpen}
          >
            <IconMore />
          </button>

          {menuOpen && (
            <div className="cr-menu" role="menu">
              <div className="cr-menu-zoom">
                <span className="cr-menu-zoom-label">Zoom</span>
                <button
                  type="button"
                  className="cr-zoom-btn"
                  onClick={() => applyZoom(-1)}
                  title="Zoom out"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="cr-menu-zoom-value">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className="cr-zoom-btn"
                  onClick={() => applyZoom(1)}
                  title="Zoom in"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button type="button" className="cr-zoom-reset" onClick={() => applyZoom(0)}>
                  Reset
                </button>
              </div>
              <div className="cr-menu-sep" />
              <button
                type="button"
                className="cr-menu-item"
                role="menuitem"
                onClick={() => {
                  guest()?.reload();
                  setMenuOpen(false);
                }}
              >
                Reload
              </button>
              <button
                type="button"
                className="cr-menu-item"
                role="menuitem"
                onClick={() => {
                  navigator.clipboard?.writeText(url);
                  setMenuOpen(false);
                }}
              >
                Copy link
              </button>
              <div className="cr-menu-sep" />
              <button
                type="button"
                className="cr-menu-item"
                role="menuitem"
                onClick={() => {
                  const w = guest();
                  if (w) (w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools());
                  setMenuOpen(false);
                }}
              >
                Developer tools
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="pane-screen browser-screen">
        <webview
          ref={hostRef}
          src={initialUrl || BROWSER_HOME}
          useragent={CHROME_UA}
          className="browser-webview"
        />
        {/* Chromium paints about:blank white, which leaves a rectangle glaring
            inside the pane in the dark theme. The blank page is covered with
            the app's own screen surface: genuinely empty, and the right
            colour. It lifts the moment the first address is opened. */}
        {!url && !error && <div className="browser-blank" />}
        {/* With the menu open, a click on the page never reaches the host
            document — the guest is a separate WebContents. This transparent
            layer over the page catches that click and closes the menu the way
            Chrome does. */}
        {menuOpen && <div className="cr-scrim" onMouseDown={() => setMenuOpen(false)} />}
        {error && (
          <div className="cr-error">
            <PageMark />
            <p className="cr-error-title">This site can’t be reached</p>
            <p className="cr-error-detail">
              {error.description || 'Unknown error'} ({error.code})
            </p>
            <button type="button" className="cr-error-retry" onClick={() => navigate(error.url || url)}>
              Reload
            </button>
          </div>
        )}
      </div>
    </>
  );
}
