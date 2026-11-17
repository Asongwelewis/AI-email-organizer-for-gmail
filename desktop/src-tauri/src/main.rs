// No console window behind the island in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! AMO Island: the AMO island on the Windows desktop itself.
//!
//! One see-through, borderless window that stays above other windows and out of the taskbar,
//! showing AMO's own pages from www.mailmindai.tech — the page draws the island, sizes the window
//! around it and moves it when it is dragged (`apps/web/src/components/app/islandFrame.ts`). This
//! program adds only what a web page cannot do for itself: the window, starting with Windows, one
//! copy at a time, and an icon by the clock to bring the island back or quit.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const ISLAND: &str = "island";

/// The top centre of the main screen, where the island starts until it is dragged somewhere else.
/// The page moves it to wherever it was left as soon as it loads.
fn place_top_centre(window: &WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = window.primary_monitor()? {
        let screen = monitor.size();
        let origin = monitor.position();
        let size = window.outer_size()?;
        let x = origin.x + (screen.width as i32 - size.width as i32) / 2;
        let y = origin.y + (10.0 * monitor.scale_factor()) as i32;
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

fn show_island(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(ISLAND) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // A second launch brings the running island forward instead of opening another.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_island(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Starts with Windows from the first run. Asked once: after that the choice in the
            // tray menu is the person's, and a later start does not overrule it.
            let chosen = app.path().app_data_dir()?.join("start-with-windows-chosen");
            if !chosen.exists() {
                let _ = app.autolaunch().enable();
                if let Some(folder) = chosen.parent() {
                    let _ = std::fs::create_dir_all(folder);
                }
                let _ = std::fs::write(&chosen, b"1");
            }

            if let Some(window) = app.get_webview_window(ISLAND) {
                let _ = place_top_centre(&window);
            }

            let starts = app.autolaunch().is_enabled().unwrap_or(false);
            let show = MenuItem::with_id(app, "show", "Show the island", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start with Windows",
                true,
                starts,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit AMO Island", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &autostart, &separator, &quit])?;

            let toggle = autostart.clone();
            let mut tray = TrayIconBuilder::with_id("amo-island")
                .tooltip("AMO Island")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_island(app),
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let enabled = launcher.is_enabled().unwrap_or(false);
                        let _ = if enabled {
                            launcher.disable()
                        } else {
                            launcher.enable()
                        };
                        let _ = toggle.set_checked(launcher.is_enabled().unwrap_or(!enabled));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // The island has no close button, but Alt+F4 still asks: hide it rather than lose the
        // window, so "Show the island" can bring it back. Quitting is in the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("AMO Island could not start");
}
