use std::{ffi::OsString, net::SocketAddr, path::PathBuf};

use anyhow::{Context, bail};
use directories::ProjectDirs;
use tracing_subscriber::{EnvFilter, fmt::writer::MakeWriterExt};
use vibe_cs_api::ServerConfig;

const LOG_RETENTION_DAYS: usize = 14;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = parse_config(std::env::args_os().skip(1))?;
    tokio::fs::create_dir_all(&config.data_dir)
        .await
        .with_context(|| {
            format!(
                "unable to create data directory {}",
                config.data_dir.display()
            )
        })?;
    let _log_guard = init_tracing(&config.data_dir)?;
    import_previous_if_requested(&config.data_dir).await?;
    let storage = vibe_cs_storage::Storage::open(config.data_dir.join("vibe-cs.db"))
        .await
        .context("unable to open application database")?;
    let state =
        vibe_cs_runtime::build_app_state(storage, config.data_dir.clone(), config.web_dist.clone())
            .await;
    vibe_cs_api::serve_state(config.bind_addr, state, shutdown_signal()).await?;
    Ok(())
}

fn init_tracing(
    data_dir: &std::path::Path,
) -> anyhow::Result<tracing_appender::non_blocking::WorkerGuard> {
    let log_directory = data_dir.join("logs");
    std::fs::create_dir_all(&log_directory)
        .with_context(|| format!("unable to create log directory {}", log_directory.display()))?;
    if let Err(error) =
        vibe_cs_runtime::prune_daily_logs(&log_directory, "vibe-cs.log", LOG_RETENTION_DAYS)
    {
        eprintln!("unable to prune old local logs: {error}");
    }
    let appender = tracing_appender::rolling::daily(log_directory, "vibe-cs.log");
    let (file_writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stdout.and(file_writer))
        .with_target(false)
        .compact()
        .init();
    Ok(guard)
}

async fn import_previous_if_requested(data_dir: &std::path::Path) -> anyhow::Result<()> {
    let Some(previous) = std::env::var_os("VIBE_CS_PREVIOUS_DATA_DIR") else {
        return Ok(());
    };
    if data_dir.join("vibe-cs.db").exists() {
        bail!("previous data import was requested but the target database already exists");
    }
    let previous = PathBuf::from(previous);
    let target = data_dir.to_path_buf();
    let report = tokio::task::spawn_blocking(move || {
        vibe_cs_storage::import_previous_data_directory(&previous, &target)
    })
    .await
    .context("previous data import worker failed")?
    .context("previous data import failed")?;
    tracing::info!(
        cache_files = report.cache_files_imported,
        cache_bytes = report.cache_bytes_imported,
        managed_files = report.managed_files_imported,
        managed_bytes = report.managed_bytes_imported,
        "previous data directory imported"
    );
    Ok(())
}

fn parse_config(arguments: impl IntoIterator<Item = OsString>) -> anyhow::Result<ServerConfig> {
    parse_config_with_env(
        arguments,
        configured_env("VIBE_CS_BIND", "VIBE_BIND"),
        configured_env("VIBE_CS_DATA_DIR", "VIBE_DATA_DIR"),
        configured_env("VIBE_CS_WEB_DIST", "VIBE_WEB_DIST"),
    )
}

fn parse_config_with_env(
    arguments: impl IntoIterator<Item = OsString>,
    bind_env: Option<OsString>,
    data_dir_env: Option<OsString>,
    web_dist_env: Option<OsString>,
) -> anyhow::Result<ServerConfig> {
    let mut bind_addr = bind_env
        .unwrap_or_else(|| OsString::from("127.0.0.1:47831"))
        .to_string_lossy()
        .parse::<SocketAddr>()
        .context("VIBE_CS_BIND must be an IP socket address")?;
    let mut data_dir = data_dir_env.map_or_else(default_data_dir, PathBuf::from);
    let mut web_dist = web_dist_env.map(PathBuf::from);

    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].to_string_lossy();
        match argument.as_ref() {
            "--bind" => {
                index += 1;
                bind_addr = value(&arguments, index, "--bind")?
                    .to_string_lossy()
                    .parse()
                    .context("--bind must be an IP socket address")?;
            }
            "--data-dir" => {
                index += 1;
                data_dir = PathBuf::from(value(&arguments, index, "--data-dir")?);
            }
            "--web-dist" => {
                index += 1;
                web_dist = Some(PathBuf::from(value(&arguments, index, "--web-dist")?));
            }
            "--help" | "-h" => {
                println!(
                    "vibe-cs-server [--bind 127.0.0.1:47831] [--data-dir PATH] [--web-dist PATH]\n\
                     Environment: VIBE_CS_BIND, VIBE_CS_DATA_DIR, \
                     VIBE_CS_WEB_DIST, VIBE_CS_PREVIOUS_DATA_DIR, \
                     VIBE_CS_DEMO_WORKER, RUST_LOG"
                );
                std::process::exit(0);
            }
            unknown => bail!("unknown argument: {unknown}"),
        }
        index += 1;
    }

    if !bind_addr.ip().is_loopback() {
        bail!("the local API may only bind to a loopback address");
    }
    Ok(ServerConfig {
        bind_addr,
        data_dir,
        web_dist,
    })
}

fn configured_env(primary: &str, compatibility: &str) -> Option<OsString> {
    std::env::var_os(primary)
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os(compatibility).filter(|value| !value.is_empty()))
}

fn value<'a>(arguments: &'a [OsString], index: usize, name: &str) -> anyhow::Result<&'a OsString> {
    arguments
        .get(index)
        .with_context(|| format!("{name} requires a value"))
}

fn default_data_dir() -> PathBuf {
    ProjectDirs::from("dev", "Vibe CS", "Vibe CS").map_or_else(
        || PathBuf::from("data"),
        |dirs| dirs.data_local_dir().to_path_buf(),
    )
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to install Ctrl-C handler");
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_required_loopback_port() {
        let config = parse_config_with_env(Vec::<OsString>::new(), None, None, None)
            .expect("parse defaults");
        assert_eq!(config.bind_addr, SocketAddr::from(([127, 0, 0, 1], 47_831)));
    }

    #[test]
    fn rejects_non_loopback_bind() {
        let error = parse_config_with_env(
            [OsString::from("--bind"), OsString::from("0.0.0.0:47831")],
            None,
            None,
            None,
        )
        .expect_err("non-loopback must be rejected");
        assert!(error.to_string().contains("loopback"));
    }
}
