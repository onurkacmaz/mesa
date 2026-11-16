//! The four cards a first launch is walked through, and the only time this
//! app explains itself. Shown once, on an install that has never had anything
//! on its canvas.
//!
//! Every card is the same height and every part of it sits in the same place
//! from one step to the next, so the buttons never shift under the pointer as
//! you page through them.

use gpui::{div, prelude::*, px, AnyElement, Context, EventEmitter, FocusHandle, Focusable, KeyDownEvent, SharedString, Window};

use super::{icon, kbd, Icon, Shortcut};
use crate::theme::Theme;

pub enum OnboardingEvent {
    Skip,
    Finish,
}

struct Step {
    title: &'static str,
    body: &'static str,
    keys: &'static [Shortcut],
}

const STEPS: [Step; 4] = [
    Step {
        title: "Every session gets a place.",
        body: "Mesa is one canvas with no edges. A terminal you put somewhere stays there, so what you come back to is a layout rather than a row of tabs you have to read.",
        keys: &[],
    },
    Step {
        title: "Open one, put it where you want.",
        body: "New panes land on the canvas and are yours to arrange. Drag a pane by its title bar to move it, or take an edge to resize it.",
        keys: &[Shortcut::NewTerminal, Shortcut::NewBrowser],
    },
    Step {
        title: "Zoom out to see the whole thing.",
        body: "Pan to move around the canvas and zoom to fit as much of it on screen as you need. Zooming out far enough shows every pane you have open at once.",
        keys: &[Shortcut::Space, Shortcut::Command, Shortcut::ZoomFit],
    },
    Step {
        title: "Keep separate work separate.",
        body: "A workflow is its own canvas, and the amber mark on the strip stands in front of the one you are in. Everything is where you left it the next time you open Mesa.",
        keys: &[Shortcut::NewWorkflow, Shortcut::SwitchWorkflow],
    },
];

pub struct Onboarding {
    step: usize,
    focus_handle: FocusHandle,
}

impl EventEmitter<OnboardingEvent> for Onboarding {}

impl Focusable for Onboarding {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Onboarding {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Onboarding { step: 0, focus_handle: cx.focus_handle() }
    }

    fn last(&self) -> bool {
        self.step == STEPS.len() - 1
    }

    /// Paged from the keyboard as well as the buttons. Modifiers are left
    /// alone so nothing here shadows an app shortcut.
    fn on_key_down(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let m = &e.keystroke.modifiers;
        if m.platform || m.alt || m.control {
            return;
        }
        match e.keystroke.key.as_str() {
            "escape" => cx.emit(OnboardingEvent::Skip),
            "right" if !self.last() => self.step += 1,
            "enter" if self.last() => cx.emit(OnboardingEvent::Finish),
            "enter" => self.step += 1,
            "left" => self.step = self.step.saturating_sub(1),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

/// A pane in outline — a box with a title bar scored across the top — so a
/// card shows the thing it is describing.
fn mini_pane(x: f32, y: f32, w: f32, h: f32, theme: &Theme) -> AnyElement {
    let line = theme.text_ghost;
    div()
        .absolute()
        .left(px(x))
        .top(px(y))
        .w(px(w))
        .h(px(h))
        .bg(theme.pane_screen)
        .border_1()
        .border_color(line)
        .child(div().absolute().top(px(6.)).left_0().right_0().h(px(1.)).bg(line).opacity(0.5))
        .into_any_element()
}

fn art(step: usize, theme: &Theme) -> AnyElement {
    let frame = div().relative().w(px(320.)).h(px(104.));
    let frame = match step {
        0 => frame
            .child(mini_pane(16., 14., 118., 52., theme))
            .child(mini_pane(150., 8., 90., 40., theme))
            .child(mini_pane(118., 60., 140., 36., theme)),
        1 => frame.child(mini_pane(20., 20., 112., 60., theme)).child(mini_pane(152., 26., 112., 52., theme)),
        2 => frame
            .child(mini_pane(18., 16., 104., 46., theme))
            .child(mini_pane(134., 10., 78., 38., theme))
            .child(mini_pane(96., 58., 126., 36., theme))
            .child(mini_pane(228., 52., 70., 42., theme)),
        _ => frame
            .child(
                div()
                    .absolute()
                    .left(px(16.))
                    .top(px(10.))
                    .w(px(288.))
                    .h(px(20.))
                    .bg(theme.pane_screen)
                    .border_1()
                    .border_color(theme.text_ghost)
                    .child(div().absolute().left(px(10.)).top(px(2.)).child(icon(Icon::Brand, 14., theme.accent)))
                    .child(div().absolute().left(px(26.)).top(px(8.)).w(px(42.)).h(px(4.)).bg(theme.text_dim))
                    .child(div().absolute().left(px(82.)).top(px(1.)).w(px(1.)).h(px(16.)).bg(theme.text_ghost))
                    .child(div().absolute().left(px(96.)).top(px(8.)).w(px(52.)).h(px(4.)).bg(theme.text_ghost))
                    .child(div().absolute().left(px(164.)).top(px(1.)).w(px(1.)).h(px(16.)).bg(theme.text_ghost))
                    .child(div().absolute().left(px(178.)).top(px(8.)).w(px(36.)).h(px(4.)).bg(theme.text_ghost)),
            )
            .child(mini_pane(16., 44., 126., 50., theme))
            .child(mini_pane(158., 50., 98., 44., theme)),
    };
    frame.into_any_element()
}

impl Render for Onboarding {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>().clone();
        let step = &STEPS[self.step];
        let last = self.last();
        let first = self.step == 0;
        let button = |id: &'static str, color| div().id(id).text_size(px(12.5)).text_color(color).cursor_pointer();

        div()
            .id("onboarding")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .pb(px(40.))
            .occlude()
            .font_family(crate::theme::ui_font())
            .child(
                div()
                    .w(px(460.))
                    .flex()
                    .flex_col()
                    .bg(theme.pane_frame)
                    .border_1()
                    .border_color(theme.pane_border)
                    .shadow_lg()
                    .child(
                        div()
                            .h(px(132.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .bg(theme.bg_canvas)
                            .border_b_1()
                            .border_color(theme.pane_border)
                            .child(art(self.step, &theme)),
                    )
                    .child(
                        div()
                            .h(px(148.))
                            .pt(px(22.))
                            .px(px(26.))
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .mb(px(10.))
                                    .text_size(px(17.))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(theme.text_strong)
                                    .child(step.title),
                            )
                            .child(div().text_size(px(12.5)).line_height(px(20.)).text_color(theme.text_mid).child(step.body))
                            .child(div().flex().gap(px(6.)).min_h(px(17.)).mt(px(14.)).children(step.keys.iter().map(|k| kbd(*k, &theme)))),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .pt(px(16.))
                            .pb(px(20.))
                            .px(px(26.))
                            .child(
                                div().flex_1().child(
                                    button("ob-skip", theme.text_dim)
                                        .hover(|s| s.text_color(theme.text_mid))
                                        .on_click(cx.listener(|_, _, _, cx| cx.emit(OnboardingEvent::Skip)))
                                        .child("Skip"),
                                ),
                            )
                            .child(div().flex().gap(px(6.)).children((0..STEPS.len()).map(|i| {
                                div().size(px(6.)).bg(if i == self.step { theme.accent } else { theme.border })
                            })))
                            .child(
                                div()
                                    .flex_1()
                                    .flex()
                                    .justify_end()
                                    .items_center()
                                    .gap(px(20.))
                                    .child(
                                        // Held rather than removed on the first card: a control
                                        // that appears from nowhere moves everything beside it.
                                        button("ob-back", theme.text_dim)
                                            .when(first, |d| d.invisible())
                                            .hover(|s| s.text_color(theme.text_strong))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.step = this.step.saturating_sub(1);
                                                cx.notify();
                                            }))
                                            .child("Back"),
                                    )
                                    .child(if last {
                                        button("ob-start", theme.text_strong)
                                            .flex()
                                            .items_center()
                                            .gap(px(7.))
                                            .on_click(cx.listener(|_, _, _, cx| cx.emit(OnboardingEvent::Finish)))
                                            .child(icon(Icon::Brand, 13., theme.accent))
                                            .child("Start")
                                            .into_any_element()
                                    } else {
                                        button("ob-next", theme.text_strong)
                                            .flex()
                                            .items_center()
                                            .gap(px(7.))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.step = (this.step + 1).min(STEPS.len() - 1);
                                                cx.notify();
                                            }))
                                            .child("Next")
                                            .child(div().text_size(px(14.)).child(SharedString::from("›")))
                                            .into_any_element()
                                    }),
                            ),
                    ),
            )
    }
}
