mod agent;
mod bridge;
mod hlae_output;
mod overlay_prototype;

#[cfg(any(debug_assertions, test))]
use std::ffi::OsStr;
use std::{io, path::PathBuf, sync::Arc};

use tauri::Manager;
use tokio::sync::OnceCell;
use tracing_subscriber::fmt::writer::MakeWriterExt;

const LOG_RETENTION_DAYS: usize = 14;
const GSI_RECEIVER_ADDRESS: &str = "127.0.0.1:47831";
#[cfg(any(debug_assertions, test))]
const WRY_DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --autoplay-policy=no-user-gesture-required";

#[cfg(any(debug_assertions, test))]
fn cdp_browser_args(debug_build: bool, value: Option<&OsStr>) -> Option<String> {
    if !debug_build {
        return None;
    }
    let value = value?.to_str()?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = value.parse::<u16>().ok()?;
    if port < 1024 {
        return None;
    }
    Some(format!(
        "{WRY_DEFAULT_BROWSER_ARGS} --remote-debugging-address=127.0.0.1 \
         --remote-debugging-port={port}"
    ))
}

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
            hlae_output::reveal_hlae_bundle,
            overlay_prototype::toggle_ace_overlay_prototype
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
        .plugin(tauri_plugin_fs::init())
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
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run desktop application");
}

fn create_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    #[cfg(all(target_os = "windows", debug_assertions))]
    let builder = match cdp_browser_args(true, std::env::var_os("VIBE_CS_CDP_PORT").as_deref()) {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    builder.build()?;
    Ok(())
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
    let storage = vibe_cs_storage::Storage::open(data_dir.join("vibe-cs.db")).await?;
    let agent_bridge = agent::AgentBridge::new(storage.clone(), data_dir.clone(), agent_dispatcher);
    let demo_worker = bundled_demo_worker()?;
    let state =
        vibe_cs_runtime::build_app_state_with_demo_worker(storage, data_dir, demo_worker).await?;
    let gsi_listener = tokio::net::TcpListener::bind(GSI_RECEIVER_ADDRESS).await?;
    tracing::info!(address = GSI_RECEIVER_ADDRESS, "CS2 GSI receiver ready");
    Ok(DesktopApplication {
        dispatcher: vibe_cs_application::build_dispatcher(state.clone()),
        gsi_receiver: vibe_cs_application::build_gsi_receiver(state),
        gsi_listener,
        agent_bridge,
    })
}

fn bundled_demo_worker()
-> Result<Option<vibe_cs_runtime::DemoWorkerSidecar>, Box<dyn std::error::Error>> {
    let expected_sha256 = env!("VIBE_CS_DEMO_WORKER_SHA256");
    if expected_sha256.is_empty() {
        if cfg!(debug_assertions) {
            tracing::warn!(
                "demo worker integrity manifest is unavailable; using the cooperative parser in-process"
            );
            return Ok(None);
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "release build is missing the demo worker integrity manifest",
        )
        .into());
    }
    let executable = std::env::current_exe()?;
    let path = executable.with_file_name(if cfg!(windows) {
        "vibe-cs-demo-worker.exe"
    } else {
        "vibe-cs-demo-worker"
    });
    Ok(Some(
        vibe_cs_runtime::DemoWorkerSidecar::new(path, expected_sha256).map_err(io::Error::other)?,
    ))
}

#[cfg(test)]
mod demo_worker_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires pnpm demo-worker:sidecar before compiling the desktop crate"]
    async fn published_demo_worker_matches_the_build_manifest() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "vibe-cs-demo-worker-{}.exe",
                env!("VIBE_CS_TARGET_TRIPLE")
            ));
        let worker =
            vibe_cs_runtime::DemoWorkerSidecar::new(path, env!("VIBE_CS_DEMO_WORKER_SHA256"))
                .expect("generated worker descriptor");
        worker
            .verify_integrity()
            .await
            .expect("worker must match the compile-time SHA-256 manifest");
    }
}

#[cfg(test)]
mod desktop_window_tests {
    use std::ffi::OsStr;

    use super::cdp_browser_args;

    #[test]
    fn release_builds_never_enable_cdp() {
        assert_eq!(cdp_browser_args(false, Some(OsStr::new("9222"))), None);
    }

    #[test]
    fn debug_builds_require_an_explicit_port() {
        assert_eq!(cdp_browser_args(true, None), None);
    }

    #[test]
    fn debug_builds_bind_cdp_to_loopback_and_preserve_wry_defaults() {
        let args = cdp_browser_args(true, Some(OsStr::new("9222"))).expect("valid debug port");

        assert!(args.contains("--remote-debugging-address=127.0.0.1"));
        assert!(args.contains("--remote-debugging-port=9222"));
        assert!(args.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(args.contains("--autoplay-policy=no-user-gesture-required"));
    }

    #[test]
    fn debug_builds_reject_non_decimal_or_privileged_ports() {
        for value in [
            "",
            "1023",
            "65536",
            " 9222",
            "+9222",
            "9e3",
            "9222 --remote-allow-origins=*",
        ] {
            assert_eq!(
                cdp_browser_args(true, Some(OsStr::new(value))),
                None,
                "unexpectedly accepted {value:?}"
            );
        }
    }
}
