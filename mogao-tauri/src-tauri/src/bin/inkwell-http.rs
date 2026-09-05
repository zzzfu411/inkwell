//! Headless formal HTTP backend used by contract and browser E2E suites.
//!
//! This is deliberately a thin adapter over the exact Axum server embedded by Tauri. It has no
//! second routing table, so CI exercises the production handlers without opening a desktop window.

use mogao_tauri_lib::http_api::{self, SharedVault};
use mogao_tauri_lib::vault::Vault;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

fn required_env(name: &str) -> anyhow::Result<String> {
    std::env::var(name).map_err(|_| anyhow::anyhow!("{name} is required"))
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let vault_root = PathBuf::from(required_env("MOGAO_VAULT")?);
    let ui_dir = std::env::var_os("INKWELL_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("novel-writer")
        });
    let vault = Vault::open_at(vault_root)?;
    let shared: SharedVault = Arc::new(RwLock::new(vault));
    let (port, token) = http_api::start_server(shared, ui_dir).await?;

    println!("INKWELL_HTTP_READY port={port} token={token}");
    io::stdout().flush()?;
    std::future::pending::<()>().await;
    Ok(())
}
