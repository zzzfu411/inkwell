#![recursion_limit = "256"]

mod embed_ui;
mod http_api;
mod preview;
mod settings;
mod vault;

use http_api::SharedVault;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogKind};
use tokio::sync::RwLock;
use vault::{classify_path, PathKind, Vault};

fn default_vault_dir() -> PathBuf {
    settings::data_dir().join("vault")
}

/// 启动时解析 vault：settings.vaultPath（存在） > MOGAO_VAULT > default
fn resolve_vault_dir() -> PathBuf {
    let s = settings::load_settings();
    if let Some(p) = s.vault_path {
        let pb = PathBuf::from(&p);
        if pb.is_dir() {
            return pb;
        }
    }
    if let Ok(env_p) = std::env::var("MOGAO_VAULT") {
        let pb = PathBuf::from(env_p);
        if !pb.as_os_str().is_empty() {
            return pb;
        }
    }
    default_vault_dir()
}

/// 启动开库：脏路径（BookDir / Unknown）不直接炸，回退默认 vault。
/// 返回 (Vault, vaultWarning)。回退时 warning 有值，**调用方不得 save_vault_path 覆盖 settings**。
/// VaultRoot / EmptyOrMissing → 正常 open_at；default 也失败才 Err。
fn open_vault_for_startup(path: PathBuf) -> Result<(Vault, Option<String>), String> {
    match classify_path(&path) {
        PathKind::VaultRoot | PathKind::EmptyOrMissing => {
            let v = Vault::open_at(path).map_err(|e| e.to_string())?;
            Ok((v, None))
        }
        kind @ (PathKind::BookDir | PathKind::Unknown) => {
            let fallback = default_vault_dir();
            let warning = format!(
                "启动书库路径不可用 kind={} path={} → 回退默认 {}",
                kind.as_str(),
                path.display(),
                fallback.display()
            );
            eprintln!("[mogao-tauri] {warning}");
            // 避免 settings 脏路径与 default 相同导致死循环式再失败时无信息
            if fallback == path {
                return Err(format!(
                    "书库路径不可用（{}）且与默认路径相同: {}",
                    kind.as_str(),
                    path.display()
                ));
            }
            match classify_path(&fallback) {
                PathKind::VaultRoot | PathKind::EmptyOrMissing => {
                    let mut v = Vault::open_at(fallback).map_err(|e| e.to_string())?;
                    v.vault_warning = Some(warning.clone());
                    Ok((v, Some(warning)))
                }
                PathKind::BookDir => Err(format!(
                    "默认书库路径是单书目录，无法启动: {}",
                    fallback.display()
                )),
                PathKind::Unknown => Err(format!(
                    "默认书库路径不是标准书库（非空未知目录）: {}",
                    fallback.display()
                )),
            }
        }
    }
}

fn static_frontend_dir() -> PathBuf {
    // 1) 发布：exe 旁 ui/ 或 novel-writer/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["ui", "novel-writer"] {
                let c = dir.join(name);
                if c.join("index.html").is_file() {
                    return c;
                }
            }
            // target/release 开发产物：../../../novel-writer
            let up = dir.join("..").join("..").join("..").join("novel-writer");
            if up.join("index.html").is_file() {
                return up;
            }
        }
    }
    // 2) 源码开发：CARGO_MANIFEST_DIR/../../novel-writer
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("novel-writer")
}

fn file_path_to_string(fp: FilePath) -> Option<String> {
    match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        FilePath::Url(u) => {
            // file:// URL → path
            u.to_file_path()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
                .or_else(|| Some(u.to_string()))
        }
    }
}

#[tauri::command]
async fn pick_vault_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let app2 = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(file_path_to_string)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(path)
}

fn map_switch_for_tauri(r: Result<Value, http_api::SwitchVaultError>) -> Result<Value, String> {
    match r {
        Ok(v) => Ok(v),
        // BookDir / Unknown：以 ok:false 结构化返回，前端可 confirm / 导入
        Err(http_api::SwitchVaultError::BookDir(body)) => Ok(body),
        Err(http_api::SwitchVaultError::Unknown(body)) => Ok(body),
        Err(http_api::SwitchVaultError::Msg(m)) => Err(m),
    }
}

#[tauri::command]
async fn pick_and_open_vault(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedVault>,
) -> Result<Value, String> {
    let app2 = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .set_title("打开 Inkwell 书库（选择已有文件夹）")
            .blocking_pick_folder()
            .and_then(file_path_to_string)
    })
    .await
    .map_err(|e| format!("选文件夹失败: {e}"))?;
    let Some(path_str) = folder else {
        return Ok(serde_json::json!({"ok": false, "cancelled": true}));
    };
    map_switch_for_tauri(http_api::switch_vault(&state, PathBuf::from(path_str)).await)
}

#[tauri::command]
async fn pick_and_create_vault(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedVault>,
) -> Result<Value, String> {
    let app2 = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .set_title("新建 Inkwell 书库（选择父目录）")
            .blocking_pick_folder()
            .and_then(file_path_to_string)
    })
    .await
    .map_err(|e| format!("选文件夹失败: {e}"))?;
    let Some(path_str) = folder else {
        return Ok(serde_json::json!({"ok": false, "cancelled": true}));
    };
    // 在所选父目录下创建默认名「Inkwell」
    map_switch_for_tauri(
        http_api::create_and_switch(&state, PathBuf::from(path_str), Some("Inkwell")).await,
    )
}

struct RuntimeHold(#[allow(dead_code)] tokio::runtime::Runtime);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let vault_dir = resolve_vault_dir();
            let static_dir = static_frontend_dir();

            let has_disk_ui = static_dir.join("index.html").is_file();
            let has_embed = embed_ui::has_embedded_index();
            if !has_disk_ui && !has_embed {
                let required = [
                    "index.html", "theme-init.js", "chapter-format.js", "styles.css", "app.js", "api.js", "config.js",
                    "store.js", "vault.js", "vault-ui.js", "workspace.js", "library.js",
                    "pipeline.js", "prompts.js", "craft.js", "context.js", "rag.js", "harness.js",
                    "graph-view.js", "write-ui.js",
                ];
                return Err(format!(
                    "找不到前端 UI。\n磁盘: {}\n需要文件: {}\n请将 novel-writer 与 mogao-tauri 保持同级，或在 exe 旁放置 ui/ 目录。\n内嵌: {:?}",
                    static_dir.display(),
                    required.join(", "),
                    embed_ui::embedded_file_list()
                )
                .into());
            }
            if !has_disk_ui {
                eprintln!(
                    "[mogao-tauri] disk UI missing at {} — will use embedded assets",
                    static_dir.display()
                );
            }

            let intended_path = vault_dir.clone();
            let (vault, vault_warning) = open_vault_for_startup(vault_dir)?;
            let actual_vault_root = vault.root.clone();
            // 仅当成功打开的 path == 用户 settings 意图（无回退）时才持久化；
            // 脏路径回退 default 时不 save，避免静默覆盖用户 settings
            if vault_warning.is_none() {
                let _ = settings::save_vault_path(&actual_vault_root);
            } else {
                eprintln!(
                    "[mogao-tauri] vaultWarning 保留 settings 原 path，未覆盖: intended={}",
                    intended_path.display()
                );
            }
            vault::start_vault_watcher(&actual_vault_root);

            let shared: SharedVault = Arc::new(RwLock::new(vault));

            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;

            let (port, api_token) = rt
                .block_on(http_api::start_server(shared.clone(), static_dir))
                .map_err(|e| e.to_string())?;

            app.manage(RuntimeHold(rt));
            app.manage(shared);

            let url = format!(
                "http://127.0.0.1:{port}/?desktop=1&engine=tauri&v={}&token={}",
                vault::VERSION,
                api_token
            );
            eprintln!("[mogao-tauri] UI    http://127.0.0.1:{port}/?desktop=1&engine=tauri&v={}&token=***", vault::VERSION);
            eprintln!("[mogao-tauri] vault {}", actual_vault_root.display());
            if let Some(ref w) = vault_warning {
                eprintln!("[mogao-tauri] vaultWarning {w}");
            }
            eprintln!(
                "[mogao-tauri] settings {}",
                settings::settings_path().display()
            );

            if let Some(w) = app.get_webview_window("main") {
                let parsed = url.parse().map_err(|e: url::ParseError| e.to_string())?;
                w.navigate(parsed).map_err(|e| e.to_string())?;
                let _ = w.set_title(&format!("Inkwell  v{}", vault::VERSION));
                let _ = w.show();
                let closer = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let window = closer.clone();
                        let js = r#"(function(){
  try {
    if (typeof window.__mogaoFlushSync === 'function') {
      return window.__mogaoFlushSync() !== false;
    }
    return true;
  } catch (e) {
    return false;
  }
})()"#;
                        let callback_window = window.clone();
                        if let Err(error) = window.eval_with_callback(js, move |result| {
                            if result.trim() == "true" {
                                let _ = callback_window.destroy();
                                return;
                            }
                            callback_window
                                .dialog()
                                .message("存盘失败或存在未解决的保存冲突，窗口未关闭。")
                                .title("Inkwell")
                                .kind(MessageDialogKind::Warning)
                                .show(|_| {});
                        }) {
                            eprintln!("[mogao-tauri] close flush eval failed: {error}");
                            closer
                                .dialog()
                                .message("无法执行关窗存盘，窗口未关闭。")
                                .title("Inkwell")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_vault_directory,
            pick_and_open_vault,
            pick_and_create_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
