//! Axum HTTP：兼容原 Python /api/* + 静态前端 + P0 vault/fs 生命周期
use crate::embed_ui;
use crate::preview;
use crate::settings;
use crate::vault::{
    book_dir_reject_value, chapter_baselines, classify_path, content_epoch, start_vault_watcher,
    unknown_reject_value, PathKind, Vault, VERSION,
};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::header::{CONTENT_SECURITY_POLICY, LOCATION, SET_COOKIE, X_CONTENT_TYPE_OPTIONS};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use uuid::Uuid;

const BOOK_SAVE_BODY_LIMIT: usize = 64 * 1024 * 1024;
const WEB_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: http: https:; connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

pub type SharedVault = Arc<RwLock<Vault>>;

#[derive(Clone)]
pub struct AppState {
    pub vault: SharedVault,
    #[allow(dead_code)]
    pub static_dir: PathBuf,
    /// 启动时生成的本机会话 token；/api/*（除 health）须带 X-Mogao-Token
    pub api_token: String,
}

/// 返回 (port, api_token)
pub async fn start_server(
    vault: SharedVault,
    static_dir: PathBuf,
) -> anyhow::Result<(u16, String)> {
    {
        let v = vault.read().await;
        v.ensure()?;
    }
    let api_token = Uuid::new_v4().to_string();
    let state = AppState {
        vault,
        static_dir: static_dir.clone(),
        api_token: api_token.clone(),
    };

    // 同源 WebView 不需要 CORS；去掉 allow Any 跨域面
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/search", get(search_books))
        .route("/api/preview/markdown", post(preview_markdown))
        .route("/api/vault/open", post(vault_open))
        .route("/api/vault/create", post(vault_create))
        .route("/api/vault/import-book", post(vault_import_book))
        .route("/api/library", get(library))
        .route("/api/library/rescan", post(library_rescan))
        .route("/api/books", post(create_book))
        .route(
            "/api/books/{slug}",
            get(get_book)
                .put(put_book)
                .delete(del_book)
                .layer(DefaultBodyLimit::max(BOOK_SAVE_BODY_LIMIT)),
        )
        .route("/api/books/{slug}/meta", get(book_meta))
        .route("/api/books/{slug}/reload", post(reload_book))
        .route("/api/books/{slug}/reveal", post(reveal_book))
        .route("/api/books/{slug}/snapshot", post(snapshot_book))
        .route("/api/books/{slug}/snapshots", get(list_snapshots))
        .route("/api/books/{slug}/restore", post(restore_snapshot))
        .route("/api/books/{slug}/rename", post(rename_book))
        .route("/api/books/{slug}/tree", get(file_tree))
        .route("/api/books/{slug}/watch", get(file_watch))
        .route(
            "/api/books/{slug}/file",
            get(read_file)
                .put(write_file)
                .layer(DefaultBodyLimit::max(BOOK_SAVE_BODY_LIMIT)),
        )
        .route("/api/books/{slug}/fs/mkdir", post(fs_mkdir))
        .route("/api/books/{slug}/fs/create", post(fs_create))
        .route("/api/books/{slug}/fs/rename", post(fs_rename))
        .route(
            "/api/books/{slug}/fs",
            delete(fs_delete).post(fs_delete_post),
        )
        .route("/api/reveal", post(reveal_path))
        .route(
            "/api/migrate",
            post(migrate).layer(DefaultBodyLimit::max(BOOK_SAVE_BODY_LIMIT)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_token,
        ))
        .with_state(state.clone());

    let has_disk_ui = static_dir.join("index.html").is_file();
    let app = if has_disk_ui {
        let index = static_dir.join("index.html");
        let static_service = ServeDir::new(static_dir).not_found_service(ServeFile::new(index));
        Router::new().merge(api).fallback_service(static_service)
    } else if embed_ui::has_embedded_index() {
        eprintln!("[mogao] disk UI missing — serving embedded assets");
        Router::new().merge(api).fallback(embed_ui::serve_embedded)
    } else {
        let required = [
            "index.html",
            "theme-init.js",
            "chapter-format.js",
            "styles.css",
            "app.js",
            "api.js",
            "config.js",
            "store.js",
            "vault.js",
            "vault-ui.js",
            "workspace.js",
            "library.js",
            "pipeline.js",
            "prompts.js",
            "craft.js",
            "context.js",
            "rag.js",
            "harness.js",
            "graph-view.js",
            "write-ui.js",
        ];
        anyhow::bail!(
            "找不到前端 UI。\n\
             磁盘路径: {}\n\
             需要文件: {}\n\
             请将 novel-writer 与 mogao-tauri 保持同级，或在 exe 旁放置 ui/ 目录。\n\
             内嵌资源: {:?}",
            static_dir.display(),
            required.join(", "),
            embed_ui::embedded_file_list()
        );
    };

    let app = app
        .layer(middleware::from_fn_with_state(
            state.clone(),
            steal_token_into_cookie,
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(WEB_CSP),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ));

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[mogao] http server error: {e}");
        }
    });
    Ok((port, api_token))
}

fn query_token(query: Option<&str>) -> Option<String> {
    for pair in query?.split('&') {
        if let Some(value) = pair.strip_prefix("token=") {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn cookie_token(req: &Request) -> Option<String> {
    let raw = req
        .headers()
        .get(axum::http::header::COOKIE)?
        .to_str()
        .ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("mogao_token=") {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// First HTML hit with ?token= becomes a cookie and a clean URL.
async fn steal_token_into_cookie(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") {
        if let Some(token) = query_token(req.uri().query()) {
            if token == st.api_token {
                let clean: Vec<&str> = req
                    .uri()
                    .query()
                    .unwrap_or("")
                    .split('&')
                    .filter(|pair| !pair.is_empty() && !pair.starts_with("token="))
                    .collect();
                let location = if clean.is_empty() {
                    path
                } else {
                    format!("{}?{}", path, clean.join("&"))
                };
                let cookie =
                    format!("mogao_token={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400");
                return (
                    StatusCode::FOUND,
                    [
                        (
                            LOCATION,
                            HeaderValue::from_str(&location)
                                .unwrap_or(HeaderValue::from_static("/")),
                        ),
                        (
                            SET_COOKIE,
                            HeaderValue::from_str(&cookie)
                                .unwrap_or(HeaderValue::from_static("mogao_token=")),
                        ),
                    ],
                    "",
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
}

/// /api/* 除 /api/health 外必须带 X-Mogao-Token 或会话 Cookie
async fn require_api_token(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let needs_auth = path.starts_with("/api/") && path != "/api/health";
    if needs_auth {
        let header_ok = req
            .headers()
            .get("X-Mogao-Token")
            .and_then(|v| v.to_str().ok())
            .map(|t| t == st.api_token)
            .unwrap_or(false);
        let cookie_ok = cookie_token(&req)
            .map(|t| t == st.api_token)
            .unwrap_or(false);
        if !header_ok && !cookie_ok {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "ok": false,
                    "error": {
                        "code": "UNAUTHORIZED",
                        "message": "unauthorized",
                        "status": StatusCode::UNAUTHORIZED.as_u16()
                    }
                })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

type ApiResult = Result<Json<Value>, ApiError>;

struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    /// 若有则直接作为响应体（用于 bookDir/unknown 等结构化错误）
    body: Option<Value>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = self.body.unwrap_or_else(|| {
            json!({
                "ok": false,
                "error": {
                    "code": self.code,
                    "message": self.message,
                    "status": self.status.as_u16()
                }
            })
        });
        (self.status, Json(body)).into_response()
    }
}

fn default_error_code(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "INVALID_REQUEST",
        StatusCode::UNAUTHORIZED => "UNAUTHORIZED",
        StatusCode::FORBIDDEN => "FORBIDDEN",
        StatusCode::NOT_FOUND => "NOT_FOUND",
        StatusCode::CONFLICT => "CONFLICT",
        StatusCode::PAYLOAD_TOO_LARGE => "PAYLOAD_TOO_LARGE",
        _ => "INTERNAL_ERROR",
    }
}

fn err(status: StatusCode, m: impl ToString) -> ApiError {
    ApiError {
        status,
        code: default_error_code(status),
        message: m.to_string(),
        body: None,
    }
}

fn storage_write_error(error: anyhow::Error, fallback: StatusCode) -> ApiError {
    let message = error.to_string();
    let code = message.split(':').next().unwrap_or("");
    let status = match code {
        "BOOK_CONFLICT" | "FILE_CONFLICT" => StatusCode::CONFLICT,
        "REVISION_REQUIRED" => StatusCode::PRECONDITION_REQUIRED,
        _ => return err(fallback, error),
    };
    err_body(
        status,
        json!({"ok": false, "error": {"code": code, "message": message, "status": status.as_u16()}}),
    )
}

fn err_body(status: StatusCode, body: Value) -> ApiError {
    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("error")
        .to_string();
    ApiError {
        status,
        code: default_error_code(status),
        message,
        body: Some(body),
    }
}

/// 开库/切换结果：成功 Value，或 BookDir/Unknown 结构化拒绝，或其它错误
#[derive(Debug)]
pub enum SwitchVaultError {
    BookDir(Value),
    Unknown(Value),
    Msg(String),
}

impl From<String> for SwitchVaultError {
    fn from(s: String) -> Self {
        SwitchVaultError::Msg(s)
    }
}

impl SwitchVaultError {
    fn from_open_err(e: anyhow::Error, path: &std::path::Path) -> Self {
        let s = e.to_string();
        if s.starts_with("BOOK_DIR:") {
            let p = s.trim_start_matches("BOOK_DIR:");
            let pb = if p.is_empty() {
                path.to_path_buf()
            } else {
                PathBuf::from(p)
            };
            SwitchVaultError::BookDir(book_dir_reject_value(&pb))
        } else if s.starts_with("UNKNOWN:") {
            let p = s.trim_start_matches("UNKNOWN:");
            let pb = if p.is_empty() {
                path.to_path_buf()
            } else {
                PathBuf::from(p)
            };
            SwitchVaultError::Unknown(unknown_reject_value(&pb))
        } else {
            SwitchVaultError::Msg(s)
        }
    }
}

/// 切换共享 vault 并持久化路径，返回 open_info（含 ok:true, kind:vaultRoot）
pub async fn switch_vault(shared: &SharedVault, path: PathBuf) -> Result<Value, SwitchVaultError> {
    switch_vault_with_force(shared, path, false).await
}

pub async fn switch_vault_with_force(
    shared: &SharedVault,
    path: PathBuf,
    force: bool,
) -> Result<Value, SwitchVaultError> {
    match classify_path(&path) {
        PathKind::BookDir => {
            return Err(SwitchVaultError::BookDir(book_dir_reject_value(&path)));
        }
        PathKind::Unknown if !force => {
            return Err(SwitchVaultError::Unknown(unknown_reject_value(&path)));
        }
        PathKind::VaultRoot | PathKind::EmptyOrMissing | PathKind::Unknown => {}
    }
    let new_vault = Vault::open_at_with_force(path.clone(), force)
        .map_err(|e| SwitchVaultError::from_open_err(e, &path))?;
    settings::save_vault_path(&new_vault.root).map_err(|e| e.to_string())?;
    let info = new_vault.open_info().map_err(|e| e.to_string())?;
    // 切换后重挂 filesystem watcher 到新 root
    start_vault_watcher(&new_vault.root);
    {
        let mut guard = shared.write().await;
        *guard = new_vault;
    }
    Ok(info)
}

/// 新建 vault 并切换
pub async fn create_and_switch(
    shared: &SharedVault,
    parent: PathBuf,
    name: Option<&str>,
) -> Result<Value, SwitchVaultError> {
    create_and_switch_with_force(shared, parent, name, false).await
}

pub async fn create_and_switch_with_force(
    shared: &SharedVault,
    parent: PathBuf,
    name: Option<&str>,
    force: bool,
) -> Result<Value, SwitchVaultError> {
    let root = match name {
        Some(n) if !n.trim().is_empty() => parent.join(n.trim()),
        _ => parent.clone(),
    };
    if matches!(classify_path(&root), PathKind::BookDir) {
        return Err(SwitchVaultError::BookDir(book_dir_reject_value(&root)));
    }
    if matches!(classify_path(&root), PathKind::Unknown) && !force {
        return Err(SwitchVaultError::Unknown(unknown_reject_value(&root)));
    }
    let new_vault = Vault::create_at_with_force(parent, name, force)
        .map_err(|e| SwitchVaultError::from_open_err(e, &root))?;
    settings::save_vault_path(&new_vault.root).map_err(|e| e.to_string())?;
    let info = new_vault.open_info().map_err(|e| e.to_string())?;
    start_vault_watcher(&new_vault.root);
    {
        let mut guard = shared.write().await;
        *guard = new_vault;
    }
    Ok(info)
}

fn map_switch_err(e: SwitchVaultError) -> ApiError {
    match e {
        SwitchVaultError::BookDir(body) => err_body(StatusCode::BAD_REQUEST, body),
        SwitchVaultError::Unknown(body) => err_body(StatusCode::BAD_REQUEST, body),
        SwitchVaultError::Msg(m) => err(StatusCode::BAD_REQUEST, m),
    }
}

async fn health(State(st): State<AppState>) -> Json<Value> {
    let v = st.vault.read().await;
    Json(v.health())
}

async fn get_settings(State(st): State<AppState>) -> ApiResult {
    let v = st.vault.read().await;
    let s = settings::load_settings();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .map(|p| p.to_string_lossy().to_string());
    let mut body = json!({
        "vaultPath": v.root.to_string_lossy(),
        "booksPath": v.books.to_string_lossy(),
        "version": VERSION,
        "engine": "tauri-rust",
        "settingsFile": settings::settings_path().to_string_lossy(),
        "credentialStorage": settings::credential_storage(),
        "exeDir": exe_dir,
        "epoch": content_epoch(),
        "clientCfg": s.client_cfg.clone().unwrap_or(json!({})),
        "uiState": s.ui_state.clone().unwrap_or(json!({})),
    });
    if let Some(w) = v.vault_warning.as_ref() {
        body["vaultWarning"] = json!(w);
    }
    Ok(Json(body))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutSettingsBody {
    /// 完整覆盖或与现有合并的客户端配置
    client_cfg: Option<Value>,
    /// 侧栏折叠等 UI
    ui_state: Option<Value>,
    /// true=整包替换 clientCfg；默认 merge
    replace_client_cfg: Option<bool>,
}

/// PUT /api/settings  持久化 API Key / 主题 / 模型等到 mogao-settings.json
async fn put_settings(Json(body): Json<PutSettingsBody>) -> ApiResult {
    let s = settings::update_settings(move |s| {
        if let Some(cfg) = body.client_cfg {
            if body.replace_client_cfg.unwrap_or(false) || s.client_cfg.is_none() {
                s.client_cfg = Some(cfg);
            } else if let Some(Value::Object(mut base)) = s.client_cfg.take() {
                if let Value::Object(patch) = cfg {
                    for (k, v) in patch {
                        base.insert(k, v);
                    }
                    s.client_cfg = Some(Value::Object(base));
                } else {
                    s.client_cfg = Some(cfg);
                }
            } else {
                s.client_cfg = Some(cfg);
            }
        }
        if let Some(ui) = body.ui_state {
            if let Some(Value::Object(mut base)) = s.ui_state.take() {
                if let Value::Object(patch) = ui {
                    for (k, v) in patch {
                        base.insert(k, v);
                    }
                    s.ui_state = Some(Value::Object(base));
                } else {
                    s.ui_state = Some(ui);
                }
            } else {
                s.ui_state = Some(ui);
            }
        }
    })
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({
        "ok": true,
        "settingsFile": settings::settings_path().to_string_lossy(),
        "credentialStorage": settings::credential_storage(),
        "clientCfg": s.client_cfg.unwrap_or(json!({})),
        "uiState": s.ui_state.unwrap_or(json!({})),
    })))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<usize>,
}

/// GET /api/search?q=...&limit=50
async fn search_books(State(st): State<AppState>, Query(q): Query<SearchQuery>) -> ApiResult {
    let query = q.q.unwrap_or_default();
    let limit = q.limit.unwrap_or(50);
    let v = st.vault.read().await;
    v.search(&query, limit)
        .map(Json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
struct PreviewMarkdownBody {
    content: Option<String>,
    /// 兼容字段名 markdown
    markdown: Option<String>,
}

async fn preview_markdown(Json(body): Json<PreviewMarkdownBody>) -> ApiResult {
    let src = body.content.or(body.markdown).unwrap_or_default();
    let html = preview::render_markdown(&src);
    Ok(Json(json!({ "html": html })))
}

#[derive(Deserialize)]
struct OpenBody {
    path: String,
    /// 强制将 Unknown 非空目录 ensure 成 vault
    force: Option<bool>,
}

#[derive(Deserialize)]
struct VaultPathBody {
    path: String,
}

async fn vault_open(State(st): State<AppState>, Json(body): Json<OpenBody>) -> ApiResult {
    let path = PathBuf::from(body.path.trim());
    if path.as_os_str().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "path required"));
    }
    let force = body.force.unwrap_or(false);
    switch_vault_with_force(&st.vault, path, force)
        .await
        .map(Json)
        .map_err(map_switch_err)
}

#[derive(Deserialize)]
struct CreateBody {
    path: String,
    name: Option<String>,
    force: Option<bool>,
}

async fn vault_create(State(st): State<AppState>, Json(body): Json<CreateBody>) -> ApiResult {
    let parent = PathBuf::from(body.path.trim());
    if parent.as_os_str().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "path required"));
    }
    let name = body
        .name
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let force = body.force.unwrap_or(false);
    create_and_switch_with_force(&st.vault, parent, name, force)
        .await
        .map(Json)
        .map_err(map_switch_err)
}

/// POST /api/vault/import-book  { "path": "D:/..." }
async fn vault_import_book(
    State(st): State<AppState>,
    Json(body): Json<VaultPathBody>,
) -> ApiResult {
    let path = PathBuf::from(body.path.trim());
    if path.as_os_str().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "path required"));
    }
    if !matches!(classify_path(&path), PathKind::BookDir) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!(
                "path is not a book directory (kind={}): {}",
                classify_path(&path).as_str(),
                path.display()
            ),
        ));
    }
    let v = st.vault.read().await;
    v.import_book_dir(&path)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

async fn library(State(st): State<AppState>) -> ApiResult {
    let v = st.vault.read().await;
    v.rescan_library()
        .map(Json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn library_rescan(State(st): State<AppState>) -> ApiResult {
    library(State(st)).await
}

#[derive(Deserialize)]
struct BookCreateBody {
    title: Option<String>,
    idea: Option<String>,
}

async fn create_book(State(st): State<AppState>, Json(body): Json<BookCreateBody>) -> ApiResult {
    let title = body.title.unwrap_or_else(|| "新书".into());
    let idea = body.idea.unwrap_or_default();
    let v = st.vault.read().await;
    v.create_book(&title, &idea)
        .map(Json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn get_book(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    v.load_book(&slug)
        .map(Json)
        .map_err(|e| err(StatusCode::NOT_FOUND, e))
}

async fn put_book(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult {
    if !body.is_object() {
        return Err(err(StatusCode::BAD_REQUEST, "body must be object"));
    }
    let v = st.vault.read().await;
    match v.save_book_checked(&slug, body) {
        Ok(saved) => Ok(Json(json!({
            "ok": true,
            "slug": slug,
            "updatedAt": saved.get("updatedAt"),
            "path": v.book_dir(&slug).map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            "mtime": v.book_meta(&slug).ok().and_then(|m| m.get("mtime").cloned()).unwrap_or(json!(0)),
            "saveWarnings": saved.get("_saveWarnings").cloned().unwrap_or(json!([])),
            "chapterBaselines": chapter_baselines(&saved),
            "bookRevision": saved.get("_bookRevision"),
            "version": VERSION,
            "epoch": content_epoch(),
        }))),
        Err(e) => Err(storage_write_error(e, StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

async fn del_book(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    v.delete_book(&slug)
        .map(|_| Json(json!({"ok": true, "epoch": content_epoch()})))
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn book_meta(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    v.book_meta(&slug)
        .map(Json)
        .map_err(|e| err(StatusCode::NOT_FOUND, e))
}

async fn reload_book(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    get_book(State(st), Path(slug)).await
}

async fn reveal_book(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    let p = v
        .book_dir(&slug)
        .map_err(|e| err(StatusCode::NOT_FOUND, e))?;
    v.reveal(&p.to_string_lossy())
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({"ok": true, "path": p.to_string_lossy()})))
}

#[derive(Deserialize)]
struct SnapshotBody {
    reason: Option<String>,
}

async fn snapshot_book(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<SnapshotBody>,
) -> ApiResult {
    let reason = body.reason.unwrap_or_else(|| "manual".into());
    let v = st.vault.read().await;
    let id = v
        .create_snapshot(&slug, &reason)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let snaps = v.list_snapshots(&slug).unwrap_or(json!({"snapshots":[]}));
    Ok(Json(
        json!({"ok": true, "id": id, "snapshots": snaps.get("snapshots")}),
    ))
}

async fn list_snapshots(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    v.list_snapshots(&slug)
        .map(Json)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
struct RestoreBody {
    id: String,
}

async fn restore_snapshot(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<RestoreBody>,
) -> ApiResult {
    let v = st.vault.read().await;
    v.restore_snapshot(&slug, &body.id)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
struct RenameBody {
    title: String,
    /// 是否同时物理重命名 books/<slug> 文件夹
    #[serde(default, alias = "renameFolder")]
    rename_folder: Option<bool>,
}

async fn rename_book(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<RenameBody>,
) -> ApiResult {
    let rename_folder = body.rename_folder.unwrap_or(false);
    let v = st.vault.read().await;
    match v.rename_book(&slug, &body.title, rename_folder) {
        Ok(val) => Ok(Json(val)),
        Err(e) => {
            let msg = e.to_string();
            if msg.starts_with("CONFLICT:") {
                Err(err(
                    StatusCode::CONFLICT,
                    msg.trim_start_matches("CONFLICT:").trim(),
                ))
            } else {
                Err(err(StatusCode::INTERNAL_SERVER_ERROR, msg))
            }
        }
    }
}

async fn file_tree(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    v.build_file_tree(&slug)
        .map(Json)
        .map_err(|e| err(StatusCode::NOT_FOUND, e))
}

/// GET /api/books/{slug}/watch
/// 返回 `{ slug, files: {rel: mtimeMs}, scannedAt, pollHintMs, epoch }`
async fn file_watch(State(st): State<AppState>, Path(slug): Path<String>) -> ApiResult {
    let v = st.vault.read().await;
    v.tree_mtimes(&slug)
        .map(Json)
        .map_err(|e| err(StatusCode::NOT_FOUND, e))
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

async fn read_file(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Query(q): Query<FileQuery>,
) -> ApiResult {
    let v = st.vault.read().await;
    v.read_file(&slug, &q.path)
        .map(Json)
        .map_err(|e| err(StatusCode::NOT_FOUND, e))
}

#[derive(Deserialize)]
struct WriteFileBody {
    path: String,
    content: String,
    #[serde(rename = "expectedRevision")]
    expected_revision: Option<String>,
}

async fn write_file(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<WriteFileBody>,
) -> ApiResult {
    let v = st.vault.read().await;
    v.write_file_checked(
        &slug,
        &body.path,
        &body.content,
        body.expected_revision.as_deref(),
    )
    .map(Json)
    .map_err(|e| storage_write_error(e, StatusCode::BAD_REQUEST))
}

#[derive(Deserialize)]
struct FsPathBody {
    path: String,
}

async fn fs_mkdir(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<FsPathBody>,
) -> ApiResult {
    let v = st.vault.read().await;
    v.fs_mkdir(&slug, &body.path)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
struct FsCreateBody {
    path: String,
    content: Option<String>,
}

async fn fs_create(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<FsCreateBody>,
) -> ApiResult {
    let content = body.content.unwrap_or_default();
    let v = st.vault.read().await;
    v.fs_create(&slug, &body.path, &content)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
struct FsRenameBody {
    from: String,
    to: String,
}

async fn fs_rename(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<FsRenameBody>,
) -> ApiResult {
    let v = st.vault.read().await;
    v.fs_rename(&slug, &body.from, &body.to)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
struct FsDeleteBody {
    path: Option<String>,
}

async fn fs_delete(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Query(q): Query<FileQuery>,
) -> ApiResult {
    let v = st.vault.read().await;
    v.fs_delete(&slug, &q.path)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

/// 兼容 body 传 path 的删除
async fn fs_delete_post(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    Json(body): Json<FsDeleteBody>,
) -> ApiResult {
    let path = body
        .path
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "path required"))?;
    let v = st.vault.read().await;
    v.fs_delete(&slug, &path)
        .map(Json)
        .map_err(|e| err(StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
struct RevealBody {
    path: Option<String>,
}

async fn reveal_path(State(st): State<AppState>, Json(body): Json<RevealBody>) -> ApiResult {
    let v = st.vault.read().await;
    let p = body
        .path
        .unwrap_or_else(|| v.root.to_string_lossy().to_string());
    v.reveal(&p)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({"ok": true, "path": p})))
}

#[derive(Deserialize)]
struct MigrateBody {
    projects: Option<Vec<Value>>,
}

async fn migrate(State(st): State<AppState>, Json(body): Json<MigrateBody>) -> ApiResult {
    // Rollback owns every book created by this request. Exclude concurrent handlers until the
    // whole migration commits, otherwise rollback could delete a book another window just edited.
    let v = st.vault.write().await;
    let projects = body.projects.unwrap_or_default();
    let expected = projects.len();
    let mut migrated = vec![];
    let mut created_slugs: Vec<String> = vec![];
    let rollback = |slugs: &[String]| {
        for slug in slugs.iter().rev() {
            let _ = v.delete_book(slug);
        }
    };
    for (index, mut p) in projects.into_iter().enumerate() {
        if !p.is_object() {
            rollback(&created_slugs);
            return Err(err(
                StatusCode::BAD_REQUEST,
                format!("migration project {} must be an object", index + 1),
            ));
        }
        let title = p
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("迁入作品")
            .to_string();
        let created = match v.create_book(&title, "") {
            Ok(created) => created,
            Err(error) => {
                rollback(&created_slugs);
                return Err(err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("migration project {} create failed: {error}", index + 1),
                ));
            }
        };
        let slug = created
            .get("slug")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if slug.is_empty() {
            rollback(&created_slugs);
            return Err(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("migration project {} returned an empty slug", index + 1),
            ));
        }
        created_slugs.push(slug.clone());
        p["slug"] = json!(slug.clone());
        let saved = match v.save_book(&slug, p, false) {
            Ok(saved) => saved,
            Err(error) => {
                rollback(&created_slugs);
                return Err(err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("migration project {} save failed: {error}", index + 1),
                ));
            }
        };
        migrated.push(json!({
            "slug": saved.get("slug"),
            "title": saved.get("title"),
            "id": saved.get("id"),
        }));
    }
    let lib = match v.rescan_library() {
        Ok(library) => library,
        Err(error) => {
            rollback(&created_slugs);
            return Err(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("migration library rescan failed: {error}"),
            ));
        }
    };
    Ok(Json(
        json!({"ok": true, "expected": expected, "migrated": migrated, "library": lib}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("inkwell-http-{tag}-{stamp}"))
    }

    async fn raw_request(port: u16, request: Vec<u8>) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream.write_all(&request).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            stream.read_to_end(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        String::from_utf8_lossy(&response).to_string()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn book_put_accepts_payload_larger_than_axum_default() {
        let root = temp_dir("large-put");
        let vault = Vault::open_at(root.clone()).unwrap();
        let created = vault.create_book("large-put", "").unwrap();
        let slug = created["slug"].as_str().unwrap().to_string();
        let shared = Arc::new(RwLock::new(vault));
        let (port, token) = start_server(shared, root.join("missing-ui")).await.unwrap();

        let body = serde_json::to_vec(&json!({
            "id": "large-put",
            "_bookRevision": created["_bookRevision"],
            "slug": slug,
            "title": "Large PUT",
            "chapters": [],
            "ideaInput": "x".repeat(3 * 1024 * 1024),
        }))
        .unwrap();
        assert!(body.len() > 2 * 1024 * 1024);
        let head = format!(
            "PUT /api/books/{slug} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Mogao-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut request = head.into_bytes();
        request.extend_from_slice(&body);
        let response = raw_request(port, request).await;
        assert!(response.starts_with("HTTP/1.1 200"), "response={response}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn migrate_accepts_payload_larger_than_axum_default() {
        let root = temp_dir("large-migrate");
        let vault = Vault::open_at(root.clone()).unwrap();
        let shared = Arc::new(RwLock::new(vault));
        let (port, token) = start_server(shared, root.join("missing-ui")).await.unwrap();

        let body = serde_json::to_vec(&json!({
            "projects": [{
                "id": "large-migrate",
                "title": "Large migration",
                "chapters": [],
                "ideaInput": "x".repeat(3 * 1024 * 1024),
            }]
        }))
        .unwrap();
        assert!(body.len() > 2 * 1024 * 1024);
        let head = format!(
            "POST /api/migrate HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Mogao-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut request = head.into_bytes();
        request.extend_from_slice(&body);
        let response = raw_request(port, request).await;
        assert!(response.starts_with("HTTP/1.1 200"), "response={response}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protected_api_rejects_missing_session_token() {
        let root = temp_dir("auth");
        let vault = Vault::open_at(root.clone()).unwrap();
        let shared = Arc::new(RwLock::new(vault));
        let (port, _) = start_server(shared, root.join("missing-ui")).await.unwrap();
        let request =
            b"GET /api/library HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".to_vec();
        let response = raw_request(port, request).await;
        assert!(response.starts_with("HTTP/1.1 401"), "response={response}");
        assert!(response
            .to_ascii_lowercase()
            .contains("content-security-policy"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn migrate_rejects_invalid_project_without_partial_books() {
        let root = temp_dir("migrate-atomic");
        let vault = Vault::open_at(root.clone()).unwrap();
        let shared = Arc::new(RwLock::new(vault));
        let inspect = shared.clone();
        let (port, token) = start_server(shared, root.join("missing-ui")).await.unwrap();
        let body = serde_json::to_vec(&json!({
            "projects": [
                {"title": "first", "chapters": []},
                42
            ]
        }))
        .unwrap();
        let head = format!(
            "POST /api/migrate HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Mogao-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut request = head.into_bytes();
        request.extend_from_slice(&body);
        let response = raw_request(port, request).await;
        assert!(response.starts_with("HTTP/1.1 400"), "response={response}");
        let library = inspect.read().await.rescan_library().unwrap();
        assert_eq!(
            library["books"].as_array().map(|books| books.len()),
            Some(0)
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
