# Inkwell immutable release manual

## Preconditions

- Rust stable, Node/npm and Windows WebView2 are installed.
- `mogao-tauri/` and sibling `novel-writer/` are the intended paired checkouts.
- A formal release requires both Git worktrees to be clean.
- `ui-files.txt`, the canonical UI and `src-tauri/ui-embed/` must agree.

Python is needed for the debug compatibility tests in the full CI gate; it is not the production backend.

## Formal local build

From `mogao-tauri/`:

```powershell
.\build-release.bat
```

The build transaction:

1. atomically syncs canonical UI only into `src-tauri/ui-embed/`;
2. runs the same complete gate as hosted CI;
3. performs `cargo build --release --locked`;
4. assembles executables, guide and the exact UI set in `output/release-stage-*`;
5. writes schema-v4 `manifest.json` and `manifest.sha256`;
6. verifies artifact hashes, exact file set, version and source provenance;
7. atomically replaces `release/` only after every check succeeds.

If any step fails, the old release remains intact and the failed stage remains under `output/` for diagnosis.

## Development build from dirty source

For local validation only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -AllowDirty
```

This does not masquerade as a formal release. The manifest records each repository's dirty flag, relevant change count and source-tree hash.

To validate a review candidate while retaining the historical release, use `./scripts/build-release.ps1 -AllowDirty -Candidate`. The same gates and manifest checks run, but the result is published to `output/candidate-release/` and `release/` is unchanged.

## Verification modes

Verify a historical artifact only against its own sealed manifest:

```powershell
npm run verify:release
```

This remains valid after canonical source changes.

Verify a just-built stage against both its manifest and the current source:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1 -CompareSource
```

`-CompareSource` is for the build transaction; it is not a reason to invalidate an older immutable release.

## Manifest v4

The manifest and checksum seal:

- product/schema/app versions and build time;
- both source repositories' commit, dirty state, relevant change count and source-tree hash;
- `Cargo.lock` and UI-manifest hashes;
- Rust/Node toolchain identity;
- build source, primary/compatibility executables and guide;
- exact byte size and SHA-256 for every declared artifact and UI file.

Verification rejects a changed file, a missing file, an undeclared extra file or a changed manifest.

## Development sync is not release

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-ui.ps1
```

This command only updates `src-tauri/ui-embed/` through a same-volume stage. It never reads, compares or writes `release/`. `check-ui-sync.ps1` similarly checks canonical UI against embed only.

## Hosted release

`.github/workflows/release-build.yml` accepts only a clean checkout. A manual run requires a full 40-character commit SHA in `writer_ref`; a tag run requires the same in `INKWELL_WRITER_REF`. Branch and tag aliases are rejected. The workflow invokes the same build transaction and uploads only the already self-verified release directory.

The two Windows CI workflows also require explicit pairing: set `INKWELL_WRITER_REF` on the Tauri repository and `INKWELL_TAURI_REF` on the writer repository to the tested sibling commit. Update these values when integrating a new paired change. Missing values fail the gate; there is no fallback to the sibling default branch. Local CI checks the actual working trees and records both source hashes.

For repositories with different sibling names, set `INKWELL_WRITER_REPOSITORY` / `INKWELL_TAURI_REPOSITORY`. A private sibling requires a read-only `INKWELL_SIBLING_TOKEN`.

## Recovery

- Build/test failure before publish: inspect `output/release-stage-*`; the previous `release/` is unchanged.
- Publish failure after backup creation: `Publish-DirectoryStage` rolls the backup back into place.
- Suspected artifact modification: run standalone verification before launching it.
- Source changed after release: standalone verification should still pass; create a new formal release only through the complete build transaction.

## GitHub 单仓布局

本 GitHub 仓库由根目录 `.github/workflows/` 启动 CI 和发布构建，两个子项目来自同一个提交。上述兄弟仓库配对变量仅适用于独立仓库布局；本布局不需要配置它们。来源记录支持 Git 子目录，并按子项目范围计算 dirty 状态和源树哈希。
