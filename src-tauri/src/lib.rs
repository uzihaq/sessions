// Pretty-PTY desktop shell. Tauri loads the existing React frontend in a
// native WebView; the frontend talks to whichever prettyd server it's
// configured for (localhost on the Mac Mini, Tailscale IP from MacBook).
//
// Two pieces of native glue we need beyond "load a URL":
//
//   1. open_session_window — a command the frontend invokes to pop a
//      session out of the main tab strip into its own native macOS
//      window. Each popped-out window loads index.html with a query
//      string that the React app reads to render single-session mode.
//
//   2. plugins — notifications (working→idle alerts) and autostart
//      (boot the app at login, paired with launchd-managed prettyd so
//      the Mac Mini wakes up showing every Claude Code session).

use tauri::Manager;

#[tauri::command]
fn open_session_window(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let label = format!("session-{}", session_id);

    // If the user already popped out this session, just focus the
    // existing window instead of stacking duplicates.
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = format!("index.html?session={}&mode=single", session_id);
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(&title)
    .inner_size(900.0, 700.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![open_session_window])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
