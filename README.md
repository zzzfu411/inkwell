# Inkwell

A local-first desktop AI novel studio (**墨稿**, `v0.19.0`) built with Rust and Tauri 2—structuring outline planning, stateless disk-grounded chapter drafting, continuity review, post-chapter handoff, and narrative analysis for long-form fiction.

English · [简体中文](README.zh-CN.md)

## Capabilities

- **One-folder-per-book Vault** — Plain-disk book directories (`章节/*.md`, `book.json`, character and worldbuilding files) protected by SHA-256 revision checks and two-way conflict preservation, directly editable in File Explorer or Obsidian.
- **Stateless chapter loop** — Every generation request assembles bounded context from disk memory rather than accumulating chat history: `Retrieve → Beat Sheet → Draft → Continuity Review → Optional Repair → Handoff → RAG Re-index`.
- **Local hybrid retrieval** — Built-in BM25 lexical search with optional embeddings to recall prior chapters, character states, and open plot threads within explicit context budgets.
- **Narrative analysis** — Manuscript chapter splitting, character dossiers, relationship graphs, and timeline views over existing drafts or imported works.
- **OpenAI-compatible & DPAPI-sealed keys** — Connects to any user-configured OpenAI-compatible endpoint; the formal Windows client encrypts API keys via current-user Windows DPAPI (never plaintext JSON) and exports redacted local diagnostics.

## Quick Start

Requires **Windows (WebView2)**, **Rust stable**, **Node.js 24+**, and **Python 3** (used by CI and optional debug mode).

```powershell
git clone https://github.com/zzzfu411/inkwell.git
cd inkwell\mogao-tauri
npm ci
npm run tauri dev
```

For lightweight UI debugging without Tauri (`server.py` implements shared HTTP contract v2, without production session tokens or DPAPI storage):

```powershell
cd novel-writer
python server.py
```

## Build & Verification

```powershell
cd mogao-tauri
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ci.ps1  # Rust, Node, Python, HTTP v2, E2E, perf & visual gates
.\build-release.bat                                                   # clean-tree build -> release/Inkwell.exe + ui/ + manifest.json
npm run verify:release                                                # verify release/ against its SHA-256 manifest
```

For dirty-worktree validation without touching `release/`, run `.\scripts\build-release.ps1 -AllowDirty -Candidate` (outputs to `output/candidate-release/`). Note: distribute `Inkwell.exe` together with its sibling `ui/` directory.

## Project Structure

Keep `novel-writer/` and `mogao-tauri/` as sibling directories—build and sync scripts rely on this layout:

```text
inkwell/
├── novel-writer/  Canonical frontend source, pure domain/application layer, and Python debug server
└── mogao-tauri/   Production Rust HTTP/Vault backend, Tauri 2 desktop shell, UI mirror, and release scripts
```

## Documentation & License

- [mogao-tauri/使用说明.md](mogao-tauri/使用说明.md) — End-user desktop guide (Chinese)
- [novel-writer/docs/ARCHITECTURE.md](novel-writer/docs/ARCHITECTURE.md) & [FRONTEND-ARCHITECTURE.md](novel-writer/docs/FRONTEND-ARCHITECTURE.md) — Layer boundaries and state authority
- [novel-writer/docs/RAG-HARNESS.md](novel-writer/docs/RAG-HARNESS.md) & [BACKEND-CONTRACT.md](novel-writer/docs/BACKEND-CONTRACT.md) — Context compiler, continuity harness, and HTTP v2 contract
- [mogao-tauri/docs/RELEASE.md](mogao-tauri/docs/RELEASE.md) & [novel-writer/CHANGELOG.md](novel-writer/CHANGELOG.md) — Immutable release transaction and changelog

MIT License — see [LICENSE](LICENSE).
