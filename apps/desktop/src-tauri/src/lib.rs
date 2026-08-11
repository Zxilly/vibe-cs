mod agent;
mod bridge;
mod hlae_output;

use std::{io, path::PathBuf, sync::Arc};

use tauri::Manager;
use tokio::sync::OnceCell;
use tracing_subscriber::fmt::writer::MakeWriterExt;

const LOG_RETENTION_DAYS: usize = 14;
const GSI_RECEIVER_ADDRESS: &str = "127.0.0.1:47831";

struct LogGuard {
    _guard: tracing_appender::non_blocking::WorkerGuard,
}

/// Starts the desktop shell and its in-process command services.
///
/// # Panics
///
/// Panics when the process-wide tracing subscriber was already installed or when Tauri cannot
/// construct the platform application from the bundled configuration.
pub fn run() {
    let router = Arc::new(OnceCell::new());
    let setup_router = Arc::clone(&router);
    let bridge = bridge::DesktopBridge::new(router);
    let agent_dispatcher = bridge.clone();
    let media_bridge = bridge.clone();
    tauri::Builder::default()
        .manage(bridge)
        .invoke_handler(tauri::generate_handler![
            bridge::desktop_call,
            bridge::desktop_binary,
            bridge::desktop_upload,
            agent::agent_status,
            agent::agent_thread,
            agent::agent_chat,
            agent::agent_cancel,
            hlae_output::list_hlae_bundles,
            hlae_output::reveal_hlae_bundle
        ])
        .register_asynchronous_uri_scheme_protocol(
            "vibe-cs-media",
            move |_context, request, responder| {
                let bridge = media_bridge.clone();
                tauri::async_runtime::spawn(async move {
                    responder.respond(bridge.dispatch_media(request).await);
                });
            },
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let data_dir = app.path().app_data_dir().map_err(|error| {
                format!("failed to resolve application data directory: {error}")
            })?;
            let log_directory = data_dir.join("logs");
            std::fs::create_dir_all(&log_directory).map_err(|error| {
                format!(
                    "failed to create log directory {}: {error}",
                    log_directory.display()
                )
            })?;
            if let Err(error) =
                vibe_cs_runtime::prune_daily_logs(&log_directory, "vibe-cs.log", LOG_RETENTION_DAYS)
            {
                eprintln!("unable to prune old local logs: {error}");
            }
            let appender = tracing_appender::rolling::daily(log_directory, "vibe-cs.log");
            let (file_writer, guard) = tracing_appender::non_blocking(appender);
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "vibe_cs_desktop=info,vibe_cs_application=info".into()),
                )
                .with_writer(std::io::stdout.and(file_writer))
                .with_ansi(false)
                .with_target(false)
                .compact()
                .init();
            app.manage(LogGuard { _guard: guard });
            app.manage(hlae_output::ManagedHlaeRoot::new(&data_dir));
            let application =
                tauri::async_runtime::block_on(build_application(data_dir, agent_dispatcher))?;
            app.manage(application.agent_bridge.clone());
            setup_router
                .set(application.dispatcher)
                .map_err(|_| io::Error::other("desktop application state was initialized twice"))?;
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    axum::serve(application.gsi_listener, application.gsi_receiver).await
                {
                    tracing::error!(%error, "CS2 GSI receiver stopped");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run desktop application");
}

struct DesktopApplication {
    dispatcher: axum::Router,
    gsi_receiver: axum::Router,
    gsi_listener: tokio::net::TcpListener,
    agent_bridge: agent::AgentBridge,
}

async fn build_application(
    data_dir: PathBuf,
    agent_dispatcher: bridge::DesktopBridge,
) -> Result<DesktopApplication, Box<dyn std::error::Error>> {
    tokio::fs::create_dir_all(&data_dir).await?;
    if let Some(previous) = std::env::var_os("VIBE_CS_PREVIOUS_DATA_DIR")
        && !data_dir.join("vibe-cs.db").exists()
    {
        let previous = PathBuf::from(previous);
        let target = data_dir.clone();
        let report = tokio::task::spawn_blocking(move || {
            vibe_cs_storage::import_previous_data_directory(&previous, &target)
        })
        .await??;
        tracing::info!(
            cache_files = report.cache_files_imported,
            cache_bytes = report.cache_bytes_imported,
            managed_files = report.managed_files_imported,
            managed_bytes = report.managed_bytes_imported,
            "previous data directory imported"
        );
    } else if std::env::var_os("VIBE_CS_PREVIOUS_DATA_DIR").is_some() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "previous data import was requested but the target database already exists",
        )
        .into());
    }
    let storage = vibe_cs_storage::Storage::open(data_dir.join("vibe-cs.db")).await?;
    let agent_bridge = agent::AgentBridge::new(storage.clone(), data_dir.clone(), agent_dispatcher);
    let state = vibe_cs_runtime::build_app_state(storage, data_dir).await;
    let gsi_listener = tokio::net::TcpListener::bind(GSI_RECEIVER_ADDRESS).await?;
    tracing::info!(address = GSI_RECEIVER_ADDRESS, "CS2 GSI receiver ready");
    Ok(DesktopApplication {
        dispatcher: vibe_cs_application::build_dispatcher(state.clone()),
        gsi_receiver: vibe_cs_application::build_gsi_receiver(state),
        gsi_listener,
        agent_bridge,
    })
}
