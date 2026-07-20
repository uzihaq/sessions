// Sessions v1 is a native window and tray layer. The v2 lifecycle manager is
// kept separate from this UI code: it may install or kickstart prettyd, but the
// app process never owns prettyd or a runner, so quitting it cannot affect a
// durable session.

mod lifecycle;

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex, thread, time::Duration};
use tauri::{
    menu::{Menu, MenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const TRAY_ID: &str = "pretty-status";
const LOCAL_SESSIONS_URL: &str = "http://localhost:8787/api/sessions";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayServer {
    id: String,
    name: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TraySnapshot {
    working: usize,
    idle: usize,
    attention: usize,
    reachable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraySession {
    working: bool,
    exited: bool,
    exit_code: Option<i32>,
    last_user_message_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SessionsResponse {
    sessions: Vec<TraySession>,
}

#[derive(Clone, Debug)]
struct WindowSpec {
    label: String,
    query: String,
    title: String,
    width: f64,
    height: f64,
}

#[derive(Default)]
struct TrayState {
    servers: Mutex<Vec<TrayServer>>,
    snapshot: Mutex<TraySnapshot>,
    server_targets: Mutex<HashMap<String, WindowSpec>>,
}

struct RuntimeState {
    status: Mutex<lifecycle::RuntimeStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

struct WindowGeometryStore {
    path: PathBuf,
    bounds: Mutex<HashMap<String, WindowBounds>>,
}

impl WindowGeometryStore {
    fn load(path: PathBuf) -> Self {
        let bounds = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            bounds: Mutex::new(bounds),
        }
    }

    fn get(&self, label: &str) -> Option<WindowBounds> {
        self.bounds.lock().ok()?.get(label).cloned()
    }

    fn remember(&self, label: String, bounds: WindowBounds) {
        let Ok(mut all_bounds) = self.bounds.lock() else {
            return;
        };
        all_bounds.insert(label, bounds);
        let Ok(json) = serde_json::to_vec_pretty(&*all_bounds) else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&self.path, json);
    }
}

fn stable_label_part(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "scope".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn parse_scoped_window(query: &str, title: String) -> Result<WindowSpec, String> {
    let pairs: Vec<(String, String)> =
        url::form_urlencoded::parse(query.trim().trim_start_matches('?').as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();

    let title = if title.trim().is_empty() {
        "Sessions".to_string()
    } else {
        title
    };

    if pairs.len() == 1 && pairs[0].0 == "server" && !pairs[0].1.trim().is_empty() {
        let id = pairs[0].1.trim();
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("server", id)
            .finish();
        return Ok(WindowSpec {
            label: format!("win-server-{}", stable_label_part(id)),
            query,
            title,
            width: 1100.0,
            height: 760.0,
        });
    }

    if pairs.len() == 1 && pairs[0].0 == "tool" {
        let tool = pairs[0].1.as_str();
        if matches!(tool, "codex" | "claude" | "shell") {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("tool", tool)
                .finish();
            return Ok(WindowSpec {
                label: format!("win-tool-{tool}"),
                query,
                title,
                width: 1100.0,
                height: 760.0,
            });
        }
    }

    if pairs.len() == 2 {
        let session_id = pairs
            .iter()
            .find_map(|(key, value)| (key == "session").then_some(value.as_str()));
        let single = pairs
            .iter()
            .any(|(key, value)| key == "mode" && value == "single");
        if let Some(session_id) = session_id.filter(|id| !id.trim().is_empty()) {
            if single {
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("session", session_id.trim())
                    .append_pair("mode", "single")
                    .finish();
                return Ok(WindowSpec {
                    label: format!("win-session-{}", stable_label_part(session_id)),
                    query,
                    title,
                    width: 900.0,
                    height: 700.0,
                });
            }
        }
    }

    Err(
        "scope must be server=<id>, tool=codex|claude|shell, or session=<id>&mode=single"
            .to_string(),
    )
}

fn main_window_spec() -> WindowSpec {
    WindowSpec {
        label: "main".to_string(),
        query: String::new(),
        title: "Sessions".to_string(),
        width: 1200.0,
        height: 800.0,
    }
}

fn focus_window(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn restore_window(window: &WebviewWindow) {
    let Some(saved) = window
        .app_handle()
        .state::<WindowGeometryStore>()
        .get(window.label())
    else {
        return;
    };
    if saved.width >= 400 && saved.height >= 300 {
        let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
    }
    let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
    if saved.maximized {
        let _ = window.maximize();
    }
}

fn remember_window(window: &WebviewWindow) {
    let (Ok(position), Ok(size), Ok(maximized)) = (
        window.outer_position(),
        window.outer_size(),
        window.is_maximized(),
    ) else {
        return;
    };
    if size.width < 400 || size.height < 300 {
        return;
    }
    window.app_handle().state::<WindowGeometryStore>().remember(
        window.label().to_string(),
        WindowBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized,
        },
    );
}

fn track_window(window: &WebviewWindow) {
    let tracked = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            remember_window(&tracked);
        }
    });
}

fn open_window(app: &AppHandle, spec: WindowSpec) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(&spec.label) {
        return focus_window(&existing);
    }

    let path = if spec.query.is_empty() {
        "index.html".to_string()
    } else {
        format!("index.html?{}", spec.query)
    };
    let window = WebviewWindowBuilder::new(app, &spec.label, WebviewUrl::App(path.into()))
        .title(&spec.title)
        .inner_size(spec.width, spec.height)
        .resizable(true)
        .build()
        .map_err(|error| error.to_string())?;
    restore_window(&window);
    track_window(&window);
    focus_window(&window)
}

#[tauri::command]
fn open_scoped_window(app: AppHandle, query: String, title: String) -> Result<(), String> {
    open_window(&app, parse_scoped_window(&query, title)?)
}

#[tauri::command]
fn set_tray_servers(app: AppHandle, servers: Vec<TrayServer>) -> Result<(), String> {
    if servers.len() > 100 {
        return Err("too many configured servers".to_string());
    }
    let servers: Vec<TrayServer> = servers
        .into_iter()
        .filter_map(|server| {
            let id = server.id.trim();
            if id.is_empty() {
                return None;
            }
            let name = server.name.trim();
            Some(TrayServer {
                id: id.to_string(),
                name: if name.is_empty() { id } else { name }.to_string(),
            })
        })
        .collect();
    *app.state::<TrayState>()
        .servers
        .lock()
        .map_err(|e| e.to_string())? = servers;

    let app_for_menu = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = refresh_tray(&app_for_menu) {
            log::warn!("update tray servers: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn runtime_status(app: AppHandle) -> Result<lifecycle::RuntimeStatus, String> {
    app.state::<RuntimeState>()
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| error.to_string())
}

fn tray_tooltip(snapshot: TraySnapshot) -> String {
    let suffix = if snapshot.reachable {
        String::new()
    } else {
        " — daemon unreachable".to_string()
    };
    format!(
        "Sessions — ● {} working, ○ {} idle, ⚠ {} needing attention{}",
        snapshot.working, snapshot.idle, snapshot.attention, suffix
    )
}

fn tray_snapshot(response: SessionsResponse) -> TraySnapshot {
    let mut snapshot = TraySnapshot {
        reachable: true,
        ..TraySnapshot::default()
    };
    for session in response.sessions {
        // These are mutually-exclusive menu buckets. A completed/crashed
        // session, or an idle conversational session that has received a
        // user message, is actionable; untouched idle shells remain idle.
        if session.exited && session.exit_code.unwrap_or_default() != 0 {
            snapshot.attention += 1;
        } else if session.working {
            snapshot.working += 1;
        } else if session.last_user_message_at.is_some() {
            snapshot.attention += 1;
        } else {
            snapshot.idle += 1;
        }
    }
    snapshot
}

fn fetch_tray_snapshot(client: &reqwest::blocking::Client) -> TraySnapshot {
    client
        .get(LOCAL_SESSIONS_URL)
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json::<SessionsResponse>())
        .map(tray_snapshot)
        .unwrap_or_default()
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<TrayState>();
    let snapshot = *state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    let servers = state
        .servers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let working = MenuItem::with_id(
        app,
        "status-working",
        format!("● {} working", snapshot.working),
        false,
        None::<&str>,
    )?;
    let idle = MenuItem::with_id(
        app,
        "status-idle",
        format!("○ {} idle", snapshot.idle),
        false,
        None::<&str>,
    )?;
    let attention = MenuItem::with_id(
        app,
        "status-attention",
        format!("⚠ {} needing attention", snapshot.attention),
        false,
        None::<&str>,
    )?;
    let runtime = app
        .state::<RuntimeState>()
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let runtime = MenuItem::with_id(
        app,
        "runtime-status",
        runtime.menu_label(),
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open-main", "Open Sessions", true, None::<&str>)?;

    let mut targets = HashMap::new();
    let mut new_window = SubmenuBuilder::new(app, "New window for…");
    if servers.is_empty() {
        let empty = MenuItem::with_id(
            app,
            "no-servers",
            "No configured servers",
            false,
            None::<&str>,
        )?;
        new_window = new_window.item(&empty);
    } else {
        for (index, server) in servers.iter().enumerate() {
            let menu_id = format!("new-server-{index}");
            let item = MenuItem::with_id(app, &menu_id, &server.name, true, None::<&str>)?;
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("server", &server.id)
                .finish();
            if let Ok(spec) = parse_scoped_window(&query, format!("{} — Sessions", server.name)) {
                targets.insert(menu_id, spec);
            }
            new_window = new_window.item(&item);
        }
    }
    new_window = new_window
        .separator()
        .text("new-tool-codex", "Codex")
        .text("new-tool-claude", "Claude")
        .text("new-tool-shell", "Shell");
    let new_window = new_window.build()?;
    *state
        .server_targets
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = targets;

    let quit = MenuItem::with_id(
        app,
        "quit-sessions",
        "Quit Sessions (work keeps running)",
        true,
        None::<&str>,
    )?;
    let menu = Menu::new(app)?;
    menu.append(&working)?;
    menu.append(&idle)?;
    menu.append(&attention)?;
    menu.append(&runtime)?;
    menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
    menu.append(&open)?;
    menu.append(&new_window)?;
    menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

fn refresh_tray(app: &AppHandle) -> tauri::Result<()> {
    let snapshot = *app
        .state::<TrayState>()
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(tray_tooltip(snapshot)))?;
        tray.set_menu(Some(build_tray_menu(app)?))?;
    }
    Ok(())
}

fn handle_tray_menu(app: &AppHandle, id: &str) {
    let result = match id {
        "open-main" => open_window(app, main_window_spec()),
        "new-tool-codex" => parse_scoped_window("tool=codex", "Codex — Sessions".to_string())
            .and_then(|spec| open_window(app, spec)),
        "new-tool-claude" => parse_scoped_window("tool=claude", "Claude — Sessions".to_string())
            .and_then(|spec| open_window(app, spec)),
        "new-tool-shell" => parse_scoped_window("tool=shell", "Shell — Sessions".to_string())
            .and_then(|spec| open_window(app, spec)),
        "quit-sessions" => {
            app.exit(0);
            Ok(())
        }
        _ => {
            let spec = app
                .state::<TrayState>()
                .server_targets
                .lock()
                .ok()
                .and_then(|targets| targets.get(id).cloned());
            match spec {
                Some(spec) => open_window(app, spec),
                None => Ok(()),
            }
        }
    };
    if let Err(error) = result {
        log::warn!("tray action {id}: {error}");
    }
}

fn start_tray_poll(app: AppHandle) {
    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(3))
            .build()
            .expect("build loopback session client");
        loop {
            let next = fetch_tray_snapshot(&client);
            let changed = {
                let state = app.state::<TrayState>();
                let mut snapshot = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
                if *snapshot == next {
                    false
                } else {
                    *snapshot = next;
                    true
                }
            };
            if changed {
                let app_for_menu = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = refresh_tray(&app_for_menu) {
                        log::warn!("refresh tray status: {error}");
                    }
                });
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TrayState::default())
        .invoke_handler(tauri::generate_handler![
            open_scoped_window,
            set_tray_servers,
            runtime_status
        ])
        .setup(|app| {
            let runtime_status = lifecycle::install_for_app(app.handle());
            if runtime_status.state == "error" {
                log::error!("Sessions background service: {}", runtime_status.detail);
            }
            app.manage(RuntimeState {
                status: Mutex::new(runtime_status),
            });

            let geometry_path = app.path().app_config_dir()?.join("window-geometry.json");
            app.manage(WindowGeometryStore::load(geometry_path));

            if let Some(main) = app.get_webview_window("main") {
                restore_window(&main);
                track_window(&main);
            }

            let menu = build_tray_menu(app.handle())?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .menu(&menu)
                .tooltip(tray_tooltip(TraySnapshot::default()))
                .icon_as_template(true)
                .on_menu_event(|app, event| handle_tray_menu(app, event.id().as_ref()));
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app.handle())?;
            start_tray_poll(app.handle().clone());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            let _ = open_window(app, main_window_spec());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_queries_are_validated_and_stable() {
        let server = parse_scoped_window("?server=studio%20mac", "Studio".to_string()).unwrap();
        assert_eq!(server.label, "win-server-studio-mac");
        assert_eq!(server.query, "server=studio+mac");

        let tool = parse_scoped_window("tool=claude", "Claude".to_string()).unwrap();
        assert_eq!(tool.label, "win-tool-claude");

        let session =
            parse_scoped_window("session=abc-123&mode=single", "Session".to_string()).unwrap();
        assert_eq!(session.label, "win-session-abc-123");
        assert!(parse_scoped_window("tool=unknown", String::new()).is_err());
        assert!(parse_scoped_window("server=x&tool=codex", String::new()).is_err());
    }

    #[test]
    fn tray_counts_are_mutually_exclusive() {
        let snapshot = tray_snapshot(SessionsResponse {
            sessions: vec![
                TraySession {
                    working: true,
                    exited: false,
                    exit_code: None,
                    last_user_message_at: Some(1),
                },
                TraySession {
                    working: false,
                    exited: false,
                    exit_code: None,
                    last_user_message_at: None,
                },
                TraySession {
                    working: false,
                    exited: false,
                    exit_code: None,
                    last_user_message_at: Some(1),
                },
                TraySession {
                    working: false,
                    exited: true,
                    exit_code: Some(1),
                    last_user_message_at: None,
                },
            ],
        });
        assert_eq!(snapshot.working, 1);
        assert_eq!(snapshot.idle, 1);
        assert_eq!(snapshot.attention, 2);
        assert!(snapshot.reachable);
    }
}
