//! A browser pane's page: a native webview parented to Mesa's window.
//!
//! GPUI draws everything else on the canvas itself; a web page it cannot draw.
//! So the page is the platform's own webview (WKWebView on a Mac, through
//! wry) laid over the pane's page area and moved with it. Being a native view
//! it sits above everything GPUI paints — the app is careful to hide it
//! whenever something should be in front of it (another pane, a menu, the
//! onboarding), and to stand a placeholder in its place.
//!
//! Kept in a crate of its own, free of GPUI, so the macOS half can be checked
//! with `cargo check --target aarch64-apple-darwin -p mesa-webview` on any
//! machine.

use std::sync::Arc;

use raw_window_handle::HasWindowHandle;

/// What a page reports back to the pane holding it.
#[derive(Clone, Debug, PartialEq)]
pub enum PageEvent {
    LoadStarted(String),
    LoadFinished(String),
    Title(String),
    /// A history move inside the page (pushState, hash change).
    Navigated(String),
    /// One of the app's own shortcuts, typed while the page had the keyboard.
    /// A page is a separate input target, so without this nothing typed
    /// inside one reaches the window — ⌘W did nothing until you clicked back
    /// onto the canvas.
    Shortcut { key: String, shift: bool, alt: bool },
    /// A link that asked for a new window. It opens in the same pane: there
    /// is no window for this app to open, and the canvas is the tab model.
    OpenHere(String),
}

/// The page area, in window coordinates (logical pixels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub type Sink = Arc<dyn Fn(PageEvent) + Send + Sync + 'static>;

/// The keys the app owns even while a page has the keyboard. Deliberately a
/// short list: everything else stays with the page, because ⌘C, ⌘V, ⌘F and
/// ⌘0 belong to it. Digits are matched on the physical key, because with
/// Option held the character depends on the layout and ⌥⌘1..9 is how the
/// workflow rail is reached.
pub const APP_KEYS: &[&str] = &["w", "n", "b", "t", "l"];

/// Run in every page before its own scripts.
///
/// Fullscreen is answered inside the page: a webview that enters real
/// fullscreen is pinned to the whole window and swallows the workspace, so
/// the element a site asks to fullscreen is stretched over the page's own
/// viewport — exactly the pane — and the page is told it got what it asked
/// for. And the app's shortcuts are lifted off the page and handed over.
pub fn init_script() -> String {
    let keys = APP_KEYS.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(",");
    format!(
        r#"(() => {{
  if (window.__mesa) return;
  window.__mesa = true;
  const appKeys = new Set([{keys}]);
  window.addEventListener('keydown', (e) => {{
    if (!(e.metaKey || e.ctrlKey)) return;
    const digit = /^Digit[1-9]$/.test(e.code);
    const key = (e.key || '').toLowerCase();
    if (!digit && !appKeys.has(key)) return;
    e.preventDefault();
    e.stopPropagation();
    window.ipc.postMessage(JSON.stringify({{ kind: 'shortcut', key: digit ? e.code.slice(-1) : key, shift: e.shiftKey, alt: e.altKey }}));
  }}, true);
  const report = () => window.ipc.postMessage(JSON.stringify({{ kind: 'navigated', url: location.href }}));
  const wrap = (name) => {{
    const original = history[name];
    history[name] = function (...args) {{ const r = original.apply(this, args); report(); return r; }};
  }};
  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', report);
  window.addEventListener('hashchange', report);
  {fullscreen}
}})();"#,
        fullscreen = FULLSCREEN_SHIM
    )
}

const FULLSCREEN_SHIM: &str = r#"
  let active = null, savedCss = '', savedRootCss = '', savedMedia = null;
  const FILL = { position: 'fixed', top: '0px', right: '0px', bottom: '0px', left: '0px', width: '100%',
    height: '100%', 'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
    margin: '0', transform: 'none', 'z-index': '2147483647', 'background-color': '#000' };
  const restore = () => {
    if (!active) return null;
    const was = active;
    was.style.cssText = savedCss;
    document.documentElement.style.cssText = savedRootCss;
    if (savedMedia) savedMedia.el.style.cssText = savedMedia.css;
    active = null; savedMedia = null;
    return was;
  };
  const enter = (el) => {
    if (active === el) return;
    if (active) restore();
    active = el; savedCss = el.style.cssText; savedRootCss = document.documentElement.style.cssText;
    for (const [p, v] of Object.entries(FILL)) el.style.setProperty(p, v, 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    const media = el.matches('video, img') ? el : el.querySelector('video');
    if (media) {
      savedMedia = { el: media, css: media.style.cssText };
      media.style.setProperty('width', '100%', 'important');
      media.style.setProperty('height', '100%', 'important');
      media.style.setProperty('object-fit', 'contain', 'important');
    }
  };
  const announce = (el) => { for (const t of ['fullscreenchange', 'webkitfullscreenchange']) el.dispatchEvent(new Event(t, { bubbles: true, composed: true })); };
  const request = function () { enter(this); announce(this); return Promise.resolve(); };
  const exit = () => { const was = restore(); if (was) announce(was); return Promise.resolve(); };
  Element.prototype.requestFullscreen = request;
  Element.prototype.webkitRequestFullscreen = request;
  document.exitFullscreen = exit;
  document.webkitExitFullscreen = exit;
  for (const name of ['fullscreenElement', 'webkitFullscreenElement']) {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, name);
    Object.defineProperty(Document.prototype, name, { configurable: true, get() { return active || (d && d.get ? d.get.call(this) : null); } });
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) { e.stopPropagation(); exit(); } }, true);
"#;

/// A genuine Safari string. An embedded WebKit announces itself by leaving
/// the `Version/… Safari/…` tokens off, and sign-in pages (Google's above
/// all) refuse a browser they take for an embedded one.
pub const SAFARI_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

fn is_http(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Pages may open only http(s) and the blank page they start on. Anything
/// else (mailto:, a custom protocol, file:) is refused silently.
pub fn allowed(url: &str) -> bool {
    is_http(url) || url == "about:blank"
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use wry::{
        dpi::{LogicalPosition, LogicalSize},
        NewWindowResponse, PageLoadEvent, Rect, WebViewBuilder,
    };

    pub struct WebView {
        inner: wry::WebView,
    }

    fn rect(f: Frame) -> Rect {
        Rect {
            position: LogicalPosition::new(f.x, f.y).into(),
            size: LogicalSize::new(f.width.max(1.0), f.height.max(1.0)).into(),
        }
    }

    impl WebView {
        pub fn new(parent: &impl HasWindowHandle, url: &str, frame: Frame, sink: Sink) -> Result<Self, String> {
            let ipc = sink.clone();
            let title = sink.clone();
            let load = sink.clone();
            let builder = WebViewBuilder::new()
                .with_url(if allowed(url) { url } else { "about:blank" })
                .with_bounds(rect(frame))
                .with_user_agent(SAFARI_UA)
                .with_devtools(true)
                .with_initialization_script(init_script())
                .with_ipc_handler(move |req| {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(req.body()) else { return };
                    match v.get("kind").and_then(|k| k.as_str()) {
                        Some("shortcut") => ipc(PageEvent::Shortcut {
                            key: v.get("key").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
                            shift: v.get("shift").and_then(|s| s.as_bool()).unwrap_or(false),
                            alt: v.get("alt").and_then(|s| s.as_bool()).unwrap_or(false),
                        }),
                        Some("navigated") => {
                            if let Some(u) = v.get("url").and_then(|u| u.as_str()) {
                                ipc(PageEvent::Navigated(u.to_string()))
                            }
                        }
                        _ => {}
                    }
                })
                .with_navigation_handler(|url| allowed(&url))
                .with_document_title_changed_handler(move |t| title(PageEvent::Title(t)))
                .with_on_page_load_handler(move |event, url| match event {
                    PageLoadEvent::Started => load(PageEvent::LoadStarted(url)),
                    PageLoadEvent::Finished => load(PageEvent::LoadFinished(url)),
                });
            let open = sink.clone();
            let builder = builder.with_new_window_req_handler(move |url, _features| {
                if is_http(&url) {
                    open(PageEvent::OpenHere(url));
                }
                NewWindowResponse::Deny
            });
            let inner = builder.build_as_child(parent).map_err(|e| e.to_string())?;
            Ok(WebView { inner })
        }

        pub fn set_frame(&self, frame: Frame) {
            let _ = self.inner.set_bounds(rect(frame));
        }

        pub fn set_visible(&self, visible: bool) {
            let _ = self.inner.set_visible(visible);
        }

        pub fn load(&self, url: &str) {
            if allowed(url) {
                let _ = self.inner.load_url(url);
            }
        }

        pub fn back(&self) {
            let _ = self.inner.evaluate_script("history.back()");
        }

        pub fn forward(&self) {
            let _ = self.inner.evaluate_script("history.forward()");
        }

        pub fn reload(&self) {
            let _ = self.inner.reload();
        }

        pub fn stop(&self) {
            let _ = self.inner.evaluate_script("window.stop()");
        }

        /// The page's own zoom times the canvas's, so the page is laid out
        /// at the pane's unzoomed size and shown at the canvas's scale.
        pub fn set_zoom(&self, zoom: f64) {
            let _ = self.inner.zoom(zoom);
        }

        pub fn open_devtools(&self) {
            self.inner.open_devtools();
        }

        pub fn focus(&self) {
            let _ = self.inner.focus();
        }

        pub fn focus_parent(&self) {
            let _ = self.inner.focus_parent();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    /// Off a Mac there is no webview to parent: wry's Linux backend needs a
    /// GTK window, and GPUI's is not one. The pane shows its chrome and offers
    /// to open the address in the system browser instead.
    pub struct WebView;

    impl WebView {
        pub fn new(_parent: &impl HasWindowHandle, _url: &str, _frame: Frame, _sink: Sink) -> Result<Self, String> {
            Err("embedded pages are only available on macOS".into())
        }
        pub fn set_frame(&self, _frame: Frame) {}
        pub fn set_visible(&self, _visible: bool) {}
        pub fn load(&self, _url: &str) {}
        pub fn back(&self) {}
        pub fn forward(&self) {}
        pub fn reload(&self) {}
        pub fn stop(&self) {}
        pub fn set_zoom(&self, _zoom: f64) {}
        pub fn open_devtools(&self) {}
        pub fn focus(&self) {}
        pub fn focus_parent(&self) {}
    }
}

pub use imp::WebView;

pub const SUPPORTED: bool = cfg!(target_os = "macos");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_are_allowed() {
        assert!(allowed("https://example.com"));
        assert!(allowed("HTTP://example.com"));
        assert!(allowed("about:blank"));
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("mailto:a@b.c"));
        assert!(!allowed("javascript:alert(1)"));
    }

    #[test]
    fn the_init_script_names_every_app_key() {
        let s = init_script();
        for k in APP_KEYS {
            assert!(s.contains(&format!("'{k}'")));
        }
    }
}
