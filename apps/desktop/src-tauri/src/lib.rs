use std::{net::SocketAddr, sync::Mutex};

use tauri::{Manager, RunEvent};
use tokio::sync::oneshot;
use tracing_subscriber::fmt::writer::MakeWriterExt;

const API_PORT: u16 = 47_831;
const LOG_RETENTION_DAYS: usize = 14;

#[derive(Debug)]
struct ApiShutdown(Mutex<Option<oneshot::Sender<()>>>);

struct LogGuard {
    _guard: tracing_appender::non_blocking::WorkerGuard,
}

/// Starts the desktop shell and its loopback API service.
///
/// # Panics
///
/// Panics when the process-wide tracing subscriber was already installed or when Tauri cannot
/// construct the platform application from the bundled configuration.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("failed to resolve application data directory: {error}"))?;
            let log_directory = data_dir.join("logs");
            std::fs::create_dir_all(&log_directory).map_err(|error| {
                format!("failed to create log directory {}: {error}", log_directory.display())
            })?;
            if let Err(error) = vibe_cs_runtime::prune_daily_logs(
                &log_directory,
                "vibe-cs.log",
                LOG_RETENTION_DAYS,
            ) {
                eprintln!("unable to prune old local logs: {error}");
            }
            let appender = tracing_appender::rolling::daily(log_directory, "vibe-cs.log");
            let (file_writer, guard) = tracing_appender::non_blocking(appender);
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "vibe_cs_desktop=info,vibe_cs_api=info".into()),
                )
                .with_writer(std::io::stdout.and(file_writer))
                .with_ansi(false)
                .with_target(false)
                .compact()
                .init();
            app.manage(LogGuard { _guard: guard });
            let (shutdown_sender, shutdown_receiver) = oneshot::channel();
            app.manage(ApiShutdown(Mutex::new(Some(shutdown_sender))));

            tauri::async_runtime::spawn(async move {
                if let Err(error) = tokio::fs::create_dir_all(&data_dir).await {
                    tracing::error!(%error, path = %data_dir.display(), "unable to create application data directory");
                    return;
                }
                if let Some(previous) = std::env::var_os("VIBE_CS_PREVIOUS_DATA_DIR")
                    && !data_dir.join("vibe-cs.db").exists()
                {
                    let previous = std::path::PathBuf::from(previous);
                    let target = data_dir.clone();
                    match tokio::task::spawn_blocking(move || {
                        vibe_cs_storage::import_previous_data_directory(&previous, &target)
                    })
                    .await
                    {
                        Ok(Ok(report)) => tracing::info!(
                            cache_files = report.cache_files_imported,
                            cache_bytes = report.cache_bytes_imported,
                            managed_files = report.managed_files_imported,
                            managed_bytes = report.managed_bytes_imported,
                            "previous data directory imported"
                        ),
                        Ok(Err(error)) => {
                            tracing::error!(%error, "previous data import failed");
                            return;
                        }
                        Err(error) => {
                            tracing::error!(%error, "previous data import worker failed");
                            return;
                        }
                    }
                } else if std::env::var_os("VIBE_CS_PREVIOUS_DATA_DIR").is_some() {
                    tracing::error!("previous data import was requested but the target database already exists");
                    return;
                }
                let storage = match vibe_cs_storage::Storage::open(data_dir.join("vibe-cs.db")).await {
                    Ok(storage) => storage,
                    Err(error) => {
                        tracing::error!(%error, "unable to open application database");
                        return;
                    }
                };
                let state = vibe_cs_runtime::build_app_state(storage, data_dir, None).await;
                if let Err(error) = vibe_cs_api::serve_state(
                    SocketAddr::from(([127, 0, 0, 1], API_PORT)),
                    state,
                    async move {
                    let _ = shutdown_receiver.await;
                    },
                )
                .await
                {
                    tracing::error!(%error, "embedded API stopped unexpectedly");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let state = handle.state::<ApiShutdown>();
            if let Ok(mut guard) = state.0.lock()
                && let Some(sender) = guard.take()
            {
                let _ = sender.send(());
            }
        }
    });
}
