//! Mesa: terminals on an infinite canvas.
//!
//! Put a shell where you want it, leave it there, and come back to it in the
//! same place tomorrow.

mod completion;
mod ids;
mod platform;
mod storage;
mod terminal;
mod theme;
mod ui;

use gpui::{point, prelude::*, px, size, App, Focusable, Application, Bounds, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowOptions};

use ui::{
    app::{MesaApp, Minimize, Quit, ToggleFullScreen},
    terminal_element::measure_cell,
    Assets,
};

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    Application::new().with_assets(Assets).run(|cx: &mut App| {
        ui::app::bind_keys(cx);
        ui::text_input::bind_keys(cx);
        ui::terminal_view::bind_keys(cx);
        cx.set_global(theme::Theme::dark());
        let cell = measure_cell(cx);
        cx.set_global(cell);
        cx.on_action(|_: &Quit, cx| cx.quit());

        // The stock Window menu binds ⌘W to "Close Window", which would quit
        // the whole workspace out from under a stray keystroke; the app owns
        // that key (it closes the selection). And there is no Reload: one
        // stray ⌘R would take every terminal with it.
        cx.set_menus(vec![
            Menu { name: "Mesa".into(), items: vec![MenuItem::action("Quit Mesa", Quit)] },
            Menu {
                name: "View".into(),
                items: vec![MenuItem::action("Toggle Full Screen", ToggleFullScreen)],
            },
            Menu { name: "Window".into(), items: vec![MenuItem::action("Minimize", Minimize)] },
        ]);

        let bounds = Bounds::centered(None, size(px(1600.), px(1000.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Mesa".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(20.), px(19.))),
            }),
            window_min_size: Some(size(px(860.), px(560.))),
            app_id: Some("com.onurkacmaz.mesa".into()),
            ..Default::default()
        };
        let window = cx
            .open_window(options, |window, cx| cx.new(|cx| MesaApp::new(window, cx)))
            .expect("open the window");
        window
            .update(cx, |app, window, cx| {
                window.focus(&app.focus_handle(cx));
                cx.activate(true);
            })
            .ok();
    });
}
