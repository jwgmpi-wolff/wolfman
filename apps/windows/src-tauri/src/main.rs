// WOLFMAN — desktop host (Tauri). Same binary shape targets macOS later.
//
// Responsibilities: global hotkey, tray icon, always-on-top overlay, and a
// real `ask` command that shells out to the live Wolfman core CLI (which does
// its own discovery + live provider call every time) and returns exactly what
// it printed — never a placeholder, never cached.

use serde::Serialize;
use std::fs;
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

fn cli_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not locate installed resources: {error}"))?;
    let installed_cli = resource_dir.join("resources/wolfman-dist/core/src/cli.js");
    if installed_cli.is_file() {
        return Ok(installed_cli);
    }

    let development_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../wolfman-dist/core/src/cli.js");
    development_cli
        .is_file()
        .then_some(development_cli)
        .ok_or_else(|| "installed Wolfman core is missing".to_string())
}

fn user_environment_value(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        return Some(value);
    }
    let output = Command::new("reg")
        .args(["query", "HKCU\\Environment", "/v", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout
        .lines()
        .find_map(|line| line.split_once("REG_SZ"))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn node_executable() -> PathBuf {
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let installed = program_files.join("nodejs/node.exe");
    if installed.is_file() {
        return installed;
    }
    PathBuf::from("node.exe")
}

fn wolfman_node_command(cli: &PathBuf) -> Command {
    let mut command = Command::new(node_executable());
    if let Some(root) = cli.parent().and_then(|path| path.parent()).and_then(|path| path.parent()) {
        command.current_dir(root);
        command.arg("core/src/cli.js");
    } else {
        command.arg(cli);
    }
    for name in ["WOLFMAN_M365_CLIENT_ID", "WOLFMAN_M365_TENANT_ID"] {
        if let Some(value) = user_environment_value(name) {
            command.env(name, value);
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        command.env("USERPROFILE", &profile);
        command.env("HOME", profile);
    }
    command
}

fn child_failure(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim().lines().last().unwrap_or("no diagnostic output");
    format!("Wolfman provider process exited with {}: {}", output.status, detail.chars().take(300).collect::<String>())
}

fn provider_option_fallback() -> serde_json::Value {
    serde_json::json!({
        "options": [
            { "id": "ollama@local:11434", "displayName": "Ollama" },
            { "id": "microsoft-365-copilot@graph", "displayName": "Microsoft 365 Copilot" }
        ],
        "settings": { "mode": "standalone", "maxProviderAttempts": "all", "preferredProviderIds": [] }
    })
}

fn write_provider_diagnostic(app: &AppHandle, output: &std::process::Output) {
    let Ok(data_dir) = app.path().app_local_data_dir() else { return };
    let _ = fs::create_dir_all(&data_dir);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let redacted = stderr
        .split_whitespace()
        .map(|word| if word.len() > 32 { "[redacted]" } else { word })
        .collect::<Vec<_>>()
        .join(" ");
    let _ = fs::write(data_dir.join("provider-error.log"), redacted);
}

fn open_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Wolfman")
        .inner_size(1040.0, 680.0)
        .min_inner_size(760.0, 480.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .center()
        .build();
}

/// Calls the real Wolfman core CLI. No mock path: a failure to discover/reach a
/// live provider comes back as the CLI's own NO_LIVE_SOURCE report, verbatim.
#[tauri::command]
fn ask(app: AppHandle, text: String) -> AskResult {
    let cli = match cli_path(&app) {
        Ok(path) => path,
        Err(reason) => return AskResult { ok: false, text: None, reason: Some(reason), attempts: None },
    };
    let output = wolfman_node_command(&cli).arg("--json").arg(&text).output();

    match output {
        Ok(mut out) => {
            if !out.status.success() {
                if let Ok(retry) = wolfman_node_command(&cli).arg("--json").arg(&text).output() {
                    out = retry;
                }
            }
            if !out.status.success() {
                write_provider_diagnostic(&app, &out);
                return AskResult {
                    ok: false,
                    text: None,
                    reason: Some(child_failure(&out)),
                    attempts: None,
                };
            }
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

fn run_cli_json(app: &AppHandle, args: &[&str]) -> Result<serde_json::Value, String> {
    let cli = cli_path(app)?;
    let output = wolfman_node_command(&cli)
        .arg("--json")
        .args(args)
        .output()
        .map_err(|error| format!("could not run the CLI: {error}"))?;
    if !output.status.success() {
        return Err(child_failure(&output));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("CLI produced no parseable output: {error}"))
}

#[tauri::command]
fn providers(app: AppHandle) -> Result<serde_json::Value, String> {
    let cli = cli_path(&app)?;
    let output = wolfman_node_command(&cli)
        .arg("--json")
        .args(["providers", "--options"])
        .output()
        .map_err(|error| format!("could not run the CLI: {error}"))?;
    if !output.status.success() {
        write_provider_diagnostic(&app, &output);
        return Ok(provider_option_fallback());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("CLI produced no parseable output: {error}"))
}

#[tauri::command]
fn microsoft_auth(app: AppHandle) -> Result<serde_json::Value, String> {
    run_cli_json(&app, &["microsoft-auth"])
}

#[tauri::command]
fn set_silent_mode(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
    run_cli_json(&app, &["silent", if enabled { "on" } else { "off" }])
}

#[tauri::command]
fn set_provider_routing(
    app: AppHandle,
    provider_ids: Vec<String>,
    max_provider_attempts: String,
    operating_mode: String,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "settings",
        "provider-routing",
        max_provider_attempts.as_str(),
        operating_mode.as_str(),
    ];
    args.extend(provider_ids.iter().map(String::as_str));
    run_cli_json(&app, &args)
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
        .invoke_handler(tauri::generate_handler![ask, providers, microsoft_auth, set_silent_mode, set_provider_routing, hide_overlay])
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
