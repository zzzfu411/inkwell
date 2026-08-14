//! 编译期内嵌 novel-writer 关键 UI（由 build.rs 复制到 ui-embed/）
use axum::body::Body;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "ui-embed/"]
pub struct EmbeddedUi;

/// 是否有可用的内嵌 UI：需同时存在 index.html 与 app.js
/// （仅有占位 index 时不算完整 UI，避免起假壳）
pub fn has_embedded_index() -> bool {
    EmbeddedUi::get("index.html").is_some() && EmbeddedUi::get("app.js").is_some()
}

/// 列出内嵌资源文件名（用于错误提示）
pub fn embedded_file_list() -> Vec<String> {
    EmbeddedUi::iter().map(|s| s.to_string()).collect()
}

fn guess_mime(path: &str) -> &'static str {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
}

/// axum fallback：从内嵌资源提供静态文件
pub async fn serve_embedded(uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() || path.ends_with('/') {
        path = "index.html".into();
    }
    // 去掉 query
    if let Some(i) = path.find('?') {
        path.truncate(i);
    }

    match EmbeddedUi::get(&path) {
        Some(file) => {
            let mime = guess_mime(&path);
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(file.data.to_vec()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => {
            // SPA fallback：非 api 路径回 index.html
            if !path.starts_with("api/") {
                if let Some(file) = EmbeddedUi::get("index.html") {
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .body(Body::from(file.data.to_vec()))
                        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                }
            }
            (
                StatusCode::NOT_FOUND,
                format!("embedded asset not found: {path}"),
            )
                .into_response()
        }
    }
}
