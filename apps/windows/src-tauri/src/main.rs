// WOLFMAN — desktop host (Tauri). Same binary shape targets macOS later.
//
// Responsibilities: global hotkey, tray icon, always-on-top overlay, and a
// real `ask` command that shells out to the live Wolfman core CLI (which does
// its own discovery + live provider call every time) and returns exactly what
// it printed — never a placeholder, never cached.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewWindowBuilder, WebviewUrl,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Clone, Serialize)]
struct AskResult {
    ok: bool,
    text: Option<String>,
    reason: Option<String>,
    attempts: Option<serde_json::Value>,
}

fn repo_root() -> PathBuf {
    // apps/windows/src-tauri/target/<profile>/ -> walk up to the repo root.
    let exe = std::env::current_exe().expect("current exe path");
    exe.ancestors().nth(5).expect("repo root").to_path_buf()
}

fn open_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Wolfman")
        .inner_size(720.0, 460.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build();
}

/// Calls the real Wolfman core CLI. No mock path: a failure to discover/reach a
/// live provider comes back as the CLI's own NO_LIVE_SOURCE report, verbatim.
#[tauri::command]
fn ask(text: String) -> AskResult {
    let cli = repo_root().join("wolfman-dist/core/src/cli.js");
    let output = Command::new("node").arg(&cli).arg("--json").arg(&text).output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                Ok(json) => AskResult {
                    ok: json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                    text: json.get("text").and_then(|v| v.as_str()).map(String::from),
                    reason: json.get("reason").and_then(|v| v.as_str()).map(String::from),
                    attempts: json.get("attempts").cloned(),
                },
                Err(_) => AskResult {
                    ok: false,
                    text: None,
                    reason: Some(format!("CLI produced no parseable output: {}", stdout)),
                    attempts: None,
                },
            }
        }
        Err(e) => AskResult { ok: false, text: None, reason: Some(format!("could not run the CLI: {e}")), attempts: None },
    }
}

#[tauri::command]
fn hide_overlay(app: AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ask, hide_overlay])
        .setup(|app| {
            app.global_shortcut().on_shortcut(
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space),
                move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        open_overlay(app);
                    }
                },
            )?;

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "ask", "Ask Wolfman…", true, Some("Ctrl+Shift+Space"))?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;

            TrayIconBuilder::with_id("wolfman")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-idle.png"))?)
                .menu(&menu)
                .tooltip("Wolfman — press Ctrl+Shift+Space")
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "ask" => open_overlay(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        open_overlay(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("wolfman failed to start");
}
