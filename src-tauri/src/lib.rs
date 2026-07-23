// Sessions v1 is a native window and tray layer. The v2 lifecycle manager is
// kept separate from this UI code: it may install or kickstart sessionsd, but the
// app process never owns sessionsd or a runner, so quitting it cannot affect a
// durable session.

mod lifecycle;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap, env, fs, path::PathBuf, process::Command, sync::Mutex, thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const TRAY_ID: &str = "sessions-status";
const SOMEWHERE_PACKAGE: &str = "@somewhere-tech/cli";
const SOMEWHERE_LATEST_URL: &str = "https://registry.npmjs.org/@somewhere-tech%2Fcli/latest";

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
    port: Mutex<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeConnectionSettings {
    port: u16,
    runtime: lifecycle::RuntimeStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeConnectionCommand {
    data: Value,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SomewhereCliStatus {
    installed: bool,
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    install_command: String,
    update_command: String,
    detail: String,
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

#[tauri::command]
fn native_connection_settings(app: AppHandle) -> Result<NativeConnectionSettings, String> {
    let state = app.state::<RuntimeState>();
    let port = *state.port.lock().map_err(|error| error.to_string())?;
    let runtime = state
        .status
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    Ok(NativeConnectionSettings { port, runtime })
}

#[tauri::command]
async fn set_runtime_port(app: AppHandle, port: u16) -> Result<NativeConnectionSettings, String> {
    let worker = app.clone();
    let status =
        tauri::async_runtime::spawn_blocking(move || lifecycle::reconfigure_port(&worker, port))
            .await
            .map_err(|error| format!("port-change worker failed: {error}"))??;
    {
        let state = app.state::<RuntimeState>();
        *state.port.lock().map_err(|error| error.to_string())? = port;
        *state.status.lock().map_err(|error| error.to_string())? = status.clone();
    }
    let app_for_menu = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = refresh_tray(&app_for_menu) {
            log::warn!("refresh tray after port change: {error}");
        }
    })
    .map_err(|error| error.to_string())?;
    Ok(NativeConnectionSettings {
        port,
        runtime: status,
    })
}

#[tauri::command]
async fn native_connection_action(
    app: AppHandle,
    kind: String,
    action: String,
    name: Option<String>,
) -> Result<NativeConnectionCommand, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_connection_action(&app, &kind, &action, name.as_deref())
    })
    .await
    .map_err(|error| format!("connection worker failed: {error}"))?
}

#[tauri::command]
async fn native_backup_action(
    app: AppHandle,
    action: String,
    project: Option<String>,
) -> Result<NativeConnectionCommand, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_backup_action(&app, &action, project.as_deref())
    })
    .await
    .map_err(|error| format!("backup worker failed: {error}"))?
}

#[tauri::command]
async fn somewhere_cli_status() -> Result<SomewhereCliStatus, String> {
    tauri::async_runtime::spawn_blocking(inspect_somewhere_cli)
        .await
        .map_err(|error| format!("Somewhere CLI status worker failed: {error}"))
}

fn inspect_somewhere_cli() -> SomewhereCliStatus {
    let install_command = format!("npm install -g {SOMEWHERE_PACKAGE}");
    let update_command = "somewhere update".to_string();
    let Some(executable) = find_executable("somewhere") else {
        return SomewhereCliStatus {
            installed: false,
            installed_version: None,
            latest_version: fetch_somewhere_latest(),
            update_available: false,
            install_command,
            update_command,
            detail: "Somewhere CLI is not installed".to_string(),
        };
    };
    let installed_version = Command::new(executable)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| clean_version(&String::from_utf8_lossy(&output.stdout)));
    let latest_version = fetch_somewhere_latest();
    let update_available = installed_version
        .as_deref()
        .zip(latest_version.as_deref())
        .is_some_and(|(installed, latest)| version_is_newer(latest, installed));
    let detail = match (&installed_version, &latest_version, update_available) {
        (Some(installed), Some(latest), true) => {
            format!("Somewhere CLI {installed} is installed; {latest} is available")
        }
        (Some(installed), Some(_), false) => {
            format!("Somewhere CLI {installed} is installed and up to date")
        }
        (Some(installed), None, _) => {
            format!("Somewhere CLI {installed} is installed; update check unavailable")
        }
        (None, _, _) => "Somewhere CLI was found but did not report a valid version".to_string(),
    };
    SomewhereCliStatus {
        installed: true,
        installed_version,
        latest_version,
        update_available,
        install_command,
        update_command,
        detail,
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let home = env::var_os("HOME").map(PathBuf::from);
    [
        Some(PathBuf::from("/opt/homebrew/bin").join(name)),
        Some(PathBuf::from("/usr/local/bin").join(name)),
        home.map(|directory| directory.join(".local/bin").join(name)),
    ]
    .into_iter()
    .flatten()
    .find(|candidate| candidate.is_file())
}

fn fetch_somewhere_latest() -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?;
    let response = client
        .get(SOMEWHERE_LATEST_URL)
        .header("accept", "application/json")
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    let body = response.json::<Value>().ok()?;
    clean_version(body.get("version")?.as_str()?)
}

fn clean_version(value: &str) -> Option<String> {
    let version = value.lines().next()?.trim().trim_start_matches('v');
    if version.is_empty()
        || version.len() > 40
        || !version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        })
    {
        return None;
    }
    Some(version.to_string())
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    fn parts(value: &str) -> Option<[u64; 3]> {
        let stable = value.split('-').next()?;
        let parsed = stable
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        (parsed.len() == 3).then(|| [parsed[0], parsed[1], parsed[2]])
    }
    parts(candidate)
        .zip(parts(current))
        .is_some_and(|(candidate, current)| candidate > current)
}

fn run_connection_action(
    app: &AppHandle,
    kind: &str,
    action: &str,
    name: Option<&str>,
) -> Result<NativeConnectionCommand, String> {
    let mut command_args = match (kind, action) {
        ("lan", "status" | "enable" | "disable") => vec!["lan".to_string(), action.to_string()],
        ("remote", "status" | "enable" | "disable") => {
            vec!["remote".to_string(), action.to_string()]
        }
        ("pair", "create") => vec!["pair".to_string()],
        _ => return Err("unsupported native connection action".to_string()),
    };
    if kind == "pair" {
        if let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) {
            if name.len() > 80 || name.chars().any(char::is_control) {
                return Err(
                    "device name must be at most 80 characters without control characters"
                        .to_string(),
                );
            }
            command_args.extend(["--name".to_string(), name.to_string()]);
        }
    }
    run_bundled_sessions_json(app, &command_args, "connection")
}

fn run_backup_action(
    app: &AppHandle,
    action: &str,
    project: Option<&str>,
) -> Result<NativeConnectionCommand, String> {
    let command_args = match action {
        "status" => vec!["backup".to_string(), "status".to_string()],
        "now" => vec!["backup".to_string(), "now".to_string()],
        "enable" => {
            let project = project
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "choose a Somewhere project for Sessions backups".to_string())?;
            if project.len() > 120
                || matches!(project, "." | "..")
                || !project.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
            {
                return Err(
                    "Somewhere project must use only letters, numbers, dots, dashes, or underscores"
                        .to_string(),
                );
            }
            vec![
                "backup".to_string(),
                "enable".to_string(),
                "--project".to_string(),
                project.to_string(),
                "--interval".to_string(),
                "15m".to_string(),
                "--encrypt".to_string(),
            ]
        }
        _ => return Err("unsupported native backup action".to_string()),
    };
    run_bundled_sessions_json(app, &command_args, "backup")
}

fn run_bundled_sessions_json(
    app: &AppHandle,
    command_args: &[String],
    response_kind: &str,
) -> Result<NativeConnectionCommand, String> {
    let port = *app
        .state::<RuntimeState>()
        .port
        .lock()
        .map_err(|error| error.to_string())?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve Sessions resources: {error}"))?;
    let executable = resources.join("runtime").join("sessions");
    if !executable.is_file() {
        return Err(format!(
            "bundled Sessions CLI is missing: {}",
            executable.display()
        ));
    }
    let mut command = Command::new(executable);
    let port_string = port.to_string();
    command.args([
        "--json",
        "--host",
        "127.0.0.1",
        "--port",
        port_string.as_str(),
    ]);
    command.args(command_args);
    let inherited_path = env::var("PATH").unwrap_or_default();
    command.env(
        "PATH",
        format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{inherited_path}"),
    );
    let output = command
        .output()
        .map_err(|error| format!("run bundled Sessions CLI: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!(
                "sessions {response_kind} command failed with {}",
                output.status
            )
        } else {
            detail
        });
    }
    let data = serde_json::from_str(&stdout)
        .map_err(|error| format!("Sessions returned invalid {response_kind} data: {error}"))?;
    Ok(NativeConnectionCommand {
        data,
        detail: stderr,
    })
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

fn fetch_tray_snapshot(client: &reqwest::blocking::Client, port: u16) -> TraySnapshot {
    client
        .get(format!("http://localhost:{port}/api/sessions"))
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
            let port = *app
                .state::<RuntimeState>()
                .port
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let next = fetch_tray_snapshot(&client, port);
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TrayState::default())
        .invoke_handler(tauri::generate_handler![
            open_scoped_window,
            set_tray_servers,
            runtime_status,
            native_connection_settings,
            set_runtime_port,
            native_connection_action,
            native_backup_action,
            somewhere_cli_status
        ])
        .setup(|app| {
            let configured_port =
                lifecycle::configured_port(app.handle()).unwrap_or_else(|error| {
                    log::error!("Sessions native connection settings: {error}");
                    lifecycle::default_port()
                });
            let runtime_status = lifecycle::install_for_app(app.handle());
            if runtime_status.state == "error" {
                log::error!("Sessions background service: {}", runtime_status.detail);
            }
            app.manage(RuntimeState {
                status: Mutex::new(runtime_status),
                port: Mutex::new(configured_port),
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

    #[test]
    fn somewhere_versions_compare_numerically() {
        assert!(version_is_newer("0.27.3", "0.21.0"));
        assert!(version_is_newer("1.10.0", "1.9.9"));
        assert!(!version_is_newer("1.9.0", "1.10.0"));
        assert!(!version_is_newer("invalid", "1.0.0"));
        assert_eq!(clean_version("v0.27.3\n"), Some("0.27.3".to_string()));
    }
}
