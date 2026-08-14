//! Tauri build + 将 novel-writer 关键 UI 复制到 ui-embed/ 供 rust-embed 编译期内嵌
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // 复制关键 UI 到 ui-embed（rust-embed 源）
    embed_ui_files();
    tauri_build::build();
}

fn embed_ui_files() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("..").join("..").join("novel-writer");
    let dst = manifest.join("ui-embed");
    let _ = fs::create_dir_all(&dst);

    let manifest_path = manifest.join("..").join("ui-files.txt");
    let manifest_text = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|error| panic!("missing UI manifest {}: {error}", manifest_path.display()));
    let files: Vec<_> = manifest_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    assert!(!files.is_empty(), "UI manifest must list at least one file");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    for name in files {
        let from = src.join(name);
        let to = dst.join(name);
        if !from.is_file() {
            panic!("UI manifest entry is missing: {}", from.display());
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).unwrap_or_else(|error| {
                panic!(
                    "create UI asset directory {} failed: {error}",
                    parent.display()
                )
            });
        }
        fs::copy(&from, &to).unwrap_or_else(|error| {
            panic!(
                "copy UI asset {} -> {} failed: {error}",
                from.display(),
                to.display()
            )
        });
        println!("cargo:rerun-if-changed={}", from.display());
    }

    // 标记目录依赖
    println!("cargo:rerun-if-changed={}", src.display());
    touch_dir_marker(&dst);
}

fn touch_dir_marker(dst: &Path) {
    let marker = dst.join(".embed-built");
    let contents = b"generated from ui-files.txt\n";
    if fs::read(&marker).ok().as_deref() != Some(contents) {
        let _ = fs::write(marker, contents);
    }
}
