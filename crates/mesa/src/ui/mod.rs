//! The window: the workflow strip, the canvas each workflow is drawn on, and
//! everything that sits on a canvas.

pub mod app;
pub mod browser_view;
pub mod onboarding;
pub mod terminal_element;
pub mod terminal_view;
pub mod text_input;
pub mod workspace;

use gpui::{
    div, prelude::*, rems, svg, AnyElement, App, Bounds, Div, Element, ElementId, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, LayoutId, Pixels, Rems, SharedString, Window,
};

use crate::theme::Theme;

/// A length in the stylesheet's pixels, as rems. Everything drawn inside a
/// pane is sized this way, so that changing the rem size scales the pane's
/// whole contents with the canvas zoom — the job `transform: scale()` did in
/// the browser build.
pub fn r(px: f32) -> Rems {
    rems(px / 16.0)
}

pub const BASE_REM: f32 = 16.0;

/// Draws its child with a different rem size: the canvas zoom, applied to
/// everything inside a pane at once.
pub struct WithRem {
    rem: Pixels,
    child: AnyElement,
}

pub fn with_rem(rem: Pixels, child: impl IntoElement) -> WithRem {
    WithRem { rem, child: child.into_any_element() }
}

impl IntoElement for WithRem {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for WithRem {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let rem = self.rem;
        let child = &mut self.child;
        (window.with_rem_size(Some(rem), |window| child.request_layout(window, cx)), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let rem = self.rem;
        let child = &mut self.child;
        window.with_rem_size(Some(rem), |window| child.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let rem = self.rem;
        let child = &mut self.child;
        window.with_rem_size(Some(rem), |window| child.paint(window, cx));
    }
}

/// One of the app's own glyphs, drawn rather than typed and kept in one
/// place: square caps and mitred joins throughout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Icon {
    Close,
    Plus,
    Minus,
    Startup,
    Tick,
    Prompt,
    Brand,
    Page,
    Back,
    Forward,
    Refresh,
    Stop,
    More,
    Lock,
    Info,
    Search,
}

impl Icon {
    fn path(self) -> &'static str {
        match self {
            Icon::Close => "icons/close.svg",
            Icon::Plus => "icons/plus.svg",
            Icon::Minus => "icons/minus.svg",
            Icon::Startup => "icons/startup.svg",
            Icon::Tick => "icons/tick.svg",
            Icon::Prompt => "icons/prompt.svg",
            Icon::Brand => "icons/brand.svg",
            Icon::Page => "icons/page.svg",
            Icon::Back => "icons/back.svg",
            Icon::Forward => "icons/forward.svg",
            Icon::Refresh => "icons/refresh.svg",
            Icon::Stop => "icons/stop.svg",
            Icon::More => "icons/more.svg",
            Icon::Lock => "icons/lock.svg",
            Icon::Info => "icons/info.svg",
            Icon::Search => "icons/search.svg",
        }
    }
}

pub fn icon(icon: Icon, size: f32, color: Hsla) -> impl IntoElement {
    svg().path(icon.path()).size(r(size)).flex_none().text_color(color)
}

/// The icons, compiled in.
pub struct Assets;

impl gpui::AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        macro_rules! icons {
            ($($name:literal),*) => {
                match path {
                    $(concat!("icons/", $name, ".svg") => Some(include_bytes!(concat!("../../assets/icons/", $name, ".svg")).as_slice()),)*
                    _ => None,
                }
            };
        }
        let bytes = icons!(
            "close", "plus", "minus", "startup", "tick", "prompt", "brand", "page", "back", "forward",
            "refresh", "stop", "more", "lock", "info", "search"
        );
        Ok(bytes.map(std::borrow::Cow::Borrowed))
    }

    fn list(&self, _path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

/// What every key combination is, so a shortcut cannot read one way in the
/// legend and another in a tooltip. Legends are what is printed on the Mac
/// keyboard: the modifier glyphs, then the character, in the order macOS
/// composes them (⌃⌥⇧⌘).
#[derive(Clone, Copy, Debug)]
pub enum Shortcut {
    NewWorkflow,
    SwitchWorkflow,
    NewTerminal,
    NewBrowser,
    OpenInEditor,
    Command,
    Space,
    ZoomReset,
    ZoomFit,
    Confirm,
    Cancel,
}

impl Shortcut {
    pub fn keys(self) -> &'static str {
        let mac = cfg!(target_os = "macos");
        match self {
            Shortcut::NewWorkflow => if mac { "⌘T" } else { "Ctrl⇧T" },
            Shortcut::SwitchWorkflow => if mac { "⌥⌘1–9" } else { "Alt1–9" },
            Shortcut::NewTerminal => if mac { "⌘N" } else { "Ctrl⇧N" },
            Shortcut::NewBrowser => if mac { "⌘B" } else { "Ctrl⇧B" },
            Shortcut::OpenInEditor => if mac { "⌘E" } else { "Ctrl⇧E" },
            Shortcut::Command => if mac { "⌘" } else { "Ctrl" },
            Shortcut::Space => "space",
            Shortcut::ZoomReset => if mac { "⌘0" } else { "Ctrl0" },
            Shortcut::ZoomFit => if mac { "⇧⌘0" } else { "Ctrl⌥⇧0" },
            Shortcut::Confirm => "return",
            Shortcut::Cancel => "esc",
        }
    }
}

/// A key cap. A whole combination stays inside one cap.
pub fn kbd(shortcut: Shortcut, theme: &Theme) -> Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .min_w(r(17.))
        .h(r(17.))
        .px(r(4.))
        .bg(theme.kbd_bg)
        .border_1()
        .border_color(theme.kbd_border)
        .text_size(r(10.5))
        .text_color(theme.text_dim)
        .child(shortcut.keys())
}

/// A bare glyph button of a fixed square, the shape every small control in
/// the chrome takes. The glyph is lit along with the square on hover.
pub fn glyph_button(id: impl Into<ElementId>, glyph: Icon, size: f32, theme: &Theme) -> gpui::Stateful<Div> {
    glyph_button_tinted(id, glyph, size, theme.text_faint, theme)
}

pub fn glyph_button_tinted(
    id: impl Into<ElementId>,
    glyph: Icon,
    size: f32,
    color: Hsla,
    theme: &Theme,
) -> gpui::Stateful<Div> {
    let id: ElementId = id.into();
    let group: SharedString = format!("glyph-{id:?}").into();
    let hover = theme.hover;
    let strong = theme.text_strong;
    div()
        .id(id)
        .group(group.clone())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(r(size))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .child(
            svg()
                .path(glyph.path())
                .size(r(11.))
                .flex_none()
                .text_color(color)
                .group_hover(group, move |s| s.text_color(strong)),
        )
}

