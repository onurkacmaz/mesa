//! A browser pane, whole: Chromium's toolbar plus the screen the page sits
//! on. The strip is deliberately outside the app's own square language — it
//! is whatever Chrome is: the pill omnibox, circular hover targets, Material
//! icons — so a page looks like a page.

use std::sync::Arc;

use gpui::{
    canvas, div, prelude::*, px, App, Bounds, ClipboardItem, Context, Entity, EventEmitter,
    FocusHandle, Focusable, MouseButton, Pixels, SharedString, Subscription, Window,
};
use mesa_webview::{Frame, PageEvent, WebView};

use super::{
    icon, r,
    text_input::{InputEvent, TextInput},
    Icon,
};
use crate::theme::Theme;

/// Chrome's own line is "Search Google or type a URL"; this does the same
/// job without assuming a search engine.
const OMNIBOX_HINT: &str = "Enter an address";

const ZOOM_STEPS: [f64; 17] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];

/// The omnibox is a search box too: an entry with no dot in it is a query,
/// not a host.
pub fn normalize_input(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let has_scheme = s.find("://").map(|i| {
        let scheme = &s[..i];
        !scheme.is_empty()
            && scheme.chars().next().unwrap().is_ascii_alphabetic()
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    if has_scheme == Some(true) {
        return Some(s.to_string());
    }
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let host_only = host.split(':').next().unwrap_or("");
    let is_ip = host_only.split('.').count() == 4 && host_only.split('.').all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()));
    if host_only.eq_ignore_ascii_case("localhost") || is_ip {
        return Some(format!("http://{s}"));
    }
    let dotted = !host.contains(char::is_whitespace)
        && host.find('.').map(|i| i > 0 && host[i + 1..].chars().filter(|c| !c.is_whitespace()).count() >= 2).unwrap_or(false);
    if !dotted || s.contains(' ') {
        let q: String = percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string();
        return Some(format!("https://duckduckgo.com/?q={q}"));
    }
    Some(format!("https://{s}"))
}

/// As Chrome shows it: https hidden, the host at full strength, the rest of
/// the path dimmed.
pub struct UrlParts {
    pub secure: bool,
    pub insecure: bool,
    pub prefix: String,
    pub host: String,
    pub rest: String,
}

pub fn split_url(url: &str) -> UrlParts {
    let (scheme, after) = match url.split_once("://") {
        Some((s, a)) => (s.to_ascii_lowercase(), a),
        None => return UrlParts { secure: false, insecure: false, prefix: String::new(), host: url.into(), rest: String::new() },
    };
    let split = after.find(['/', '?', '#']).unwrap_or(after.len());
    let host = after[..split].to_string();
    let mut rest = after[split..].to_string();
    if rest == "/" {
        rest.clear();
    }
    let secure = scheme == "https";
    UrlParts { secure, insecure: scheme == "http", prefix: if secure { String::new() } else { format!("{scheme}://") }, host, rest }
}

pub enum BrowserEvent {
    /// The title or the loading state moved.
    StatusChanged,
    /// The address moved, which the session has to remember.
    UrlChanged,
    /// One of the app's shortcuts, typed inside the page.
    Shortcut { key: String, shift: bool, alt: bool },
}

pub struct BrowserView {
    pub tab_id: String,
    /// Empty is a real answer: a pane still on its blank home page.
    pub url: String,
    pub page_title: Option<String>,
    pub loading: bool,
    zoom: f64,
    menu_open: bool,
    omnibox: Option<(Entity<TextInput>, Subscription)>,
    webview: Option<WebView>,
    webview_error: Option<String>,
    focus_handle: FocusHandle,
    /// Where the page area was last drawn, in window coordinates.
    frame: Option<Bounds<Pixels>>,
    /// Set by the workspace each frame: whether the page may be shown at all
    /// (the pane is in front, nothing is over it, its workflow is the active
    /// one). A native view cannot be clipped or covered, so when any of that
    /// fails it is hidden and a placeholder stands in.
    pub showable: bool,
    pub canvas_zoom: f32,
    events: Option<smol::channel::Receiver<PageEvent>>,
    _pump: Option<gpui::Task<()>>,
}

impl EventEmitter<BrowserEvent> for BrowserView {}

impl BrowserView {
    pub fn new(tab_id: String, initial_url: Option<String>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        BrowserView {
            tab_id,
            url: initial_url.unwrap_or_default(),
            page_title: None,
            loading: false,
            zoom: 1.0,
            menu_open: false,
            omnibox: None,
            webview: None,
            webview_error: None,
            focus_handle: cx.focus_handle(),
            frame: None,
            showable: false,
            canvas_zoom: 1.0,
            events: None,
            _pump: None,
        }
    }

    /// The page is created the first time it has somewhere to be, not when
    /// the pane is: a restored workflow that is never opened costs no pages.
    fn ensure_webview(&mut self, frame: Frame, window: &mut Window, cx: &mut Context<Self>) {
        if self.webview.is_some() || self.webview_error.is_some() || !mesa_webview::SUPPORTED {
            return;
        }
        let (tx, rx) = smol::channel::unbounded();
        let sink: mesa_webview::Sink = Arc::new(move |e| {
            let _ = tx.try_send(e);
        });
        let url = if self.url.is_empty() { "about:blank".to_string() } else { self.url.clone() };
        match WebView::new(window, &url, frame, sink) {
            Ok(w) => {
                w.set_zoom(self.zoom * self.canvas_zoom as f64);
                self.webview = Some(w);
                self.events = Some(rx.clone());
                self._pump = Some(cx.spawn_in(window, async move |this, cx| {
                    while let Ok(e) = rx.recv().await {
                        if this.update_in(cx, |this, window, cx| this.on_page_event(e, window, cx)).is_err() {
                            break;
                        }
                    }
                }));
            }
            Err(e) => self.webview_error = Some(e),
        }
    }

    fn on_page_event(&mut self, e: PageEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let shown = |u: &str| if u == "about:blank" { String::new() } else { u.to_string() };
        let before = self.url.clone();
        match e {
            PageEvent::LoadStarted(url) => {
                self.loading = true;
                self.url = shown(&url);
            }
            PageEvent::LoadFinished(url) => {
                self.loading = false;
                self.url = shown(&url);
            }
            PageEvent::Navigated(url) => self.url = shown(&url),
            // A blank page has no title; "about:blank" is not a name.
            PageEvent::Title(t) => self.page_title = (!t.is_empty() && t != "about:blank").then_some(t),
            PageEvent::OpenHere(url) => {
                if let Some(w) = &self.webview {
                    w.load(&url);
                }
            }
            PageEvent::Shortcut { key, shift, alt } => {
                cx.emit(BrowserEvent::Shortcut { key, shift, alt });
                return;
            }
        }
        cx.emit(if self.url != before { BrowserEvent::UrlChanged } else { BrowserEvent::StatusChanged });
        cx.notify();
    }

    pub fn navigate(&mut self, raw: &str, cx: &mut Context<Self>) {
        let Some(next) = normalize_input(raw) else { return };
        self.omnibox = None;
        self.url = next.clone();
        self.loading = true;
        match &self.webview {
            Some(w) => w.load(&next),
            // Without a page of its own the pane hands the address to the
            // system browser rather than doing nothing.
            None if !mesa_webview::SUPPORTED => cx.open_url(&next),
            None => {}
        }
        cx.emit(BrowserEvent::UrlChanged);
        cx.notify();
    }

    /// ⌘L: into the omnibox, with the address selected.
    pub fn begin_editing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let theme = cx.global::<Theme>().clone();
        let url = self.url.clone();
        let input = cx.new(|cx| {
            let mut t = TextInput::new(url, OMNIBOX_HINT, window, cx);
            t.cursor_color = theme.accent;
            t.placeholder_color = theme.text_faint;
            t.selection_color = crate::theme::mix(theme.accent, gpui::transparent_black(), 0.3);
            t
        });
        let sub = cx.subscribe_in(&input, window, |this, _, e: &InputEvent, window, cx| match e {
            InputEvent::Submit(text) => {
                let text = text.clone();
                this.navigate(&text, cx);
                if let Some(w) = &this.webview {
                    w.focus();
                }
                let _ = window;
            }
            InputEvent::Cancel | InputEvent::Blur(_) => {
                this.omnibox = None;
                cx.notify();
            }
        });
        window.focus(&input.focus_handle(cx));
        self.omnibox = Some((input, sub));
        cx.notify();
    }

    fn apply_zoom(&mut self, direction: i32) {
        let index = ZOOM_STEPS.iter().position(|z| (*z - self.zoom).abs() < 1e-6).unwrap_or(7) as i32;
        self.zoom = if direction == 0 { 1.0 } else { ZOOM_STEPS[(index + direction).clamp(0, 16) as usize] };
        if let Some(w) = &self.webview {
            w.set_zoom(self.zoom * self.canvas_zoom as f64);
        }
    }

    /// Called once the page area has been laid out this frame.
    fn place(&mut self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        self.frame = Some(bounds);
        let frame = Frame {
            x: f32::from(bounds.origin.x) as f64,
            y: f32::from(bounds.origin.y) as f64,
            width: f32::from(bounds.size.width) as f64,
            height: f32::from(bounds.size.height) as f64,
        };
        let show = self.showable && !self.menu_open && !self.url.is_empty();
        if show {
            self.ensure_webview(frame, window, cx);
        }
        if let Some(w) = &self.webview {
            w.set_frame(frame);
            w.set_zoom(self.zoom * self.canvas_zoom as f64);
            w.set_visible(show);
        }
    }

    pub fn hide(&mut self) {
        if let Some(w) = &self.webview {
            w.set_visible(false);
        }
    }

    pub fn focus_page(&self) {
        if let Some(w) = &self.webview {
            w.focus();
        }
    }

    fn toolbar_button(&self, id: &'static str, glyph: Icon, enabled: bool, theme: &Theme) -> gpui::Stateful<gpui::Div> {
        let hover = theme.hover;
        div()
            .id(id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(r(28.))
            .rounded_full()
            .when(enabled, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
            .child(icon(glyph, 16., if enabled { theme.text_mid } else { theme.text_ghost }))
    }
}

impl Focusable for BrowserView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Drop for BrowserView {
    fn drop(&mut self) {
        self.hide();
    }
}

impl Render for BrowserView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>().clone();
        let parts = split_url(&self.url);
        let has_page = self.webview.is_some();
        let loading = self.loading;

        let omnibox = match &self.omnibox {
            Some((input, _)) => div()
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(r(8.))
                .h(r(28.))
                .px(r(12.))
                .rounded_full()
                .bg(theme.pane_screen)
                .border_1()
                .border_color(theme.accent)
                .text_size(r(13.))
                .text_color(theme.text_strong)
                .child(icon(Icon::Search, 14., theme.text_dim))
                .child(input.clone())
                .into_any_element(),
            None => {
                let mark = if self.url.is_empty() {
                    Icon::Search
                } else if parts.secure {
                    Icon::Lock
                } else {
                    Icon::Info
                };
                div()
                    .id("omnibox")
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(r(8.))
                    .h(r(28.))
                    .px(r(12.))
                    .rounded_full()
                    .bg(theme.hover_soft)
                    .cursor_text()
                    .text_size(r(13.))
                    .overflow_hidden()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            cx.stop_propagation();
                            this.begin_editing(window, cx);
                        }),
                    )
                    .child(icon(mark, 14., if parts.insecure { theme.danger } else { theme.text_dim }))
                    .when(parts.insecure, |d| d.child(div().flex_none().text_color(theme.danger).child("Not secure")))
                    .child(if self.url.is_empty() {
                        div().text_color(theme.text_faint).child(OMNIBOX_HINT).into_any_element()
                    } else {
                        div()
                            .flex()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .when(!parts.prefix.is_empty() && !parts.insecure, |d| {
                                d.child(div().text_color(theme.text_dim).child(SharedString::from(parts.prefix.clone())))
                            })
                            .child(div().text_color(theme.text_strong).child(SharedString::from(parts.host.clone())))
                            .when(!parts.rest.is_empty(), |d| {
                                d.child(div().text_color(theme.text_dim).child(SharedString::from(parts.rest.clone())))
                            })
                            .into_any_element()
                    })
                    .into_any_element()
            }
        };

        let toolbar = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(r(2.))
            .h(r(40.))
            .px(r(6.))
            .bg(theme.titlebar_bottom)
            .border_b_1()
            .border_color(theme.titlebar_edge)
            .child(self.toolbar_button("back", Icon::Back, has_page, &theme).on_click(cx.listener(|this, _, _, _| {
                if let Some(w) = &this.webview {
                    w.back()
                }
            })))
            .child(self.toolbar_button("forward", Icon::Forward, has_page, &theme).on_click(cx.listener(|this, _, _, _| {
                if let Some(w) = &this.webview {
                    w.forward()
                }
            })))
            .child(
                self.toolbar_button("reload", if loading { Icon::Stop } else { Icon::Refresh }, has_page, &theme)
                    .on_click(cx.listener(move |this, _, _, _| {
                        if let Some(w) = &this.webview {
                            if this.loading {
                                w.stop()
                            } else {
                                w.reload()
                            }
                        }
                    })),
            )
            .child(div().w(r(6.)))
            .child(omnibox)
            .child(div().w(r(4.)))
            .child(
                self.toolbar_button("more", Icon::More, true, &theme)
                    .when(self.menu_open, |d| d.bg(theme.hover))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.menu_open = !this.menu_open;
                        cx.notify();
                    })),
            );

        let entity = cx.entity();
        let menu = self.menu_open.then(|| {
            let item = |id: &'static str, label: &'static str| {
                let hover = theme.hover;
                div()
                    .id(id)
                    .px(r(14.))
                    .h(r(30.))
                    .flex()
                    .items_center()
                    .text_size(r(12.5))
                    .text_color(theme.text)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .child(label)
            };
            let zoom_label = format!("{}%", (self.zoom * 100.0).round());
            div()
                .id("browser-menu")
                .absolute()
                .top(r(40.))
                .right(r(6.))
                .w(r(220.))
                .py(r(6.))
                .bg(theme.pane_frame)
                .border_1()
                .border_color(theme.pane_border)
                .rounded(r(8.))
                .shadow_lg()
                .occlude()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(r(6.))
                        .px(r(14.))
                        .h(r(32.))
                        .text_size(r(12.5))
                        .text_color(theme.text)
                        .child(div().flex_1().child("Zoom"))
                        .child(item("zoom-out", "−").px(r(8.)).on_click(cx.listener(|this, _, _, cx| {
                            this.apply_zoom(-1);
                            cx.notify();
                        })))
                        .child(div().w(r(44.)).flex().justify_center().child(zoom_label))
                        .child(item("zoom-in", "+").px(r(8.)).on_click(cx.listener(|this, _, _, cx| {
                            this.apply_zoom(1);
                            cx.notify();
                        })))
                        .child(item("zoom-reset", "Reset").px(r(8.)).on_click(cx.listener(|this, _, _, cx| {
                            this.apply_zoom(0);
                            cx.notify();
                        }))),
                )
                .child(div().h(px(1.)).my(r(4.)).bg(theme.border_soft))
                .child(item("menu-reload", "Reload").on_click(cx.listener(|this, _, _, cx| {
                    if let Some(w) = &this.webview {
                        w.reload();
                    }
                    this.menu_open = false;
                    cx.notify();
                })))
                .child(item("menu-copy", "Copy link").on_click(cx.listener(|this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(this.url.clone()));
                    this.menu_open = false;
                    cx.notify();
                })))
                .when(!mesa_webview::SUPPORTED && !self.url.is_empty(), |d| {
                    d.child(item("menu-open", "Open in system browser").on_click(cx.listener(|this, _, _, cx| {
                        cx.open_url(&this.url);
                        this.menu_open = false;
                        cx.notify();
                    })))
                })
                .child(div().h(px(1.)).my(r(4.)).bg(theme.border_soft))
                .child(item("menu-devtools", "Developer tools").on_click(cx.listener(|this, _, _, cx| {
                    if let Some(w) = &this.webview {
                        w.open_devtools();
                    }
                    this.menu_open = false;
                    cx.notify();
                })))
        });

        // What stands in the page area whenever the page itself cannot be
        // shown: the app's own screen surface for a blank page (never a white
        // rectangle glaring in the dark theme), and a quiet note otherwise.
        let placeholder = if self.url.is_empty() {
            None
        } else if let Some(err) = &self.webview_error {
            Some(err.clone())
        } else if !mesa_webview::SUPPORTED {
            Some("Pages open in your browser on this system.".to_string())
        } else if !self.showable || self.menu_open {
            self.page_title.clone().or_else(|| Some(parts.host.clone()))
        } else {
            None
        };

        let screen = div()
            .relative()
            .flex()
            .flex_1()
            .min_h_0()
            .bg(theme.pane_screen)
            .child(
                canvas(
                    move |bounds, window, cx| {
                        entity.update(cx, |this, cx| this.place(bounds, window, cx));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .when_some(placeholder, |d, text| {
                d.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(r(10.))
                        .text_size(r(13.))
                        .text_color(theme.text_dim)
                        .child(icon(Icon::Page, 22., theme.text_faint))
                        .child(SharedString::from(text)),
                )
            })
            .when(self.menu_open, |d| {
                // A click on the page area closes the menu, as Chrome's does.
                d.child(div().id("scrim").absolute().inset_0().on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.menu_open = false;
                        cx.notify();
                    }),
                ))
            });

        div()
            .id(SharedString::from(format!("browser-{}", self.tab_id)))
            .track_focus(&self.focus_handle)
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .size_full()
            .font_family(crate::theme::ui_font())
            .child(toolbar)
            .child(screen)
            .children(menu)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_omnibox_reads_addresses_and_queries() {
        assert_eq!(normalize_input("example.com").as_deref(), Some("https://example.com"));
        assert_eq!(normalize_input("https://a.b/c").as_deref(), Some("https://a.b/c"));
        assert_eq!(normalize_input("localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(normalize_input("127.0.0.1:8080/x").as_deref(), Some("http://127.0.0.1:8080/x"));
        assert_eq!(normalize_input("rust gpui").as_deref(), Some("https://duckduckgo.com/?q=rust%20gpui"));
        assert_eq!(normalize_input("  "), None);
    }

    #[test]
    fn urls_split_the_way_chrome_shows_them() {
        let p = split_url("https://news.ycombinator.com/item?id=1");
        assert!(p.secure && p.prefix.is_empty());
        assert_eq!(p.host, "news.ycombinator.com");
        assert_eq!(p.rest, "/item?id=1");
        let p = split_url("http://localhost:3000/");
        assert!(p.insecure);
        assert_eq!(p.rest, "");
    }
}
