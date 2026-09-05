# Inkwell 当前架构

本文是 Inkwell 0.19.x 的唯一架构入口。它描述当前可执行边界；历史设想不参与实现决策。

## 1. 仓库与权威

```text
novel-writer/                         canonical UI + domain/application code
  index.html                          explicit composition root
  chapter-state.js                    only runtime state transition boundary
  project-migrations.js               versioned, adjacent, idempotent migrations
  write/persistence/conflict-*.js     application use cases with injected ports
  planning/handoff/legacy-*.js        generation application services
  context*.js / memory-reducers.js    context compiler and evidence budget
  production-*.js                     candidate whole-chapter production + quality gate
  runtime-observability.js            secret-free failure and metric domain
  quality-release-policy.js           fail-closed default-engine release policy
  composition-contract.js             explicit classic-script dependency contract
  api.js / vault.js / store.js        model, Vault and recovery adapters
  app.js                              browser composition and DOM ports

mogao-tauri/                           formal Rust/Tauri desktop client
  src-tauri/src/http_api.rs            formal HTTP route composition
  src-tauri/src/vault/                 authoritative Vault persistence
  src-tauri/ui-embed/                  atomic build mirror of canonical UI
  release/                             immutable, manifest-sealed artifact only
```

`novel-writer/` is the only UI source. `src-tauri/ui-embed/` is a generated build mirror. `release/ui/` is part of an immutable release and is never a development sync target. Rust/Tauri is the production backend; `server.py` is a frozen debug compatibility backend.

## 2. Runtime layers

```text
Presentation
  app.js / write-ui.js / runtime-diagnostics-ui.js
       │ DOM values and narrow callback ports
       ▼
Application
  write-use-cases / persistence-use-cases / conflict-use-cases
  planning-service / handoff-service / legacy-generation-adapter
       │ transactions, cancellation, checkpoints
       ▼
Domain
  project-migrations / chapter-state / production-state
  context-budget / context-evidence / memory-reducers
  production-quality / quality-release-policy / runtime-observability
       │ explicit ports
       ▼
Adapters
  api.js / vault.js / store.js / Rust HTTP / Python debug HTTP
```

Domain and application modules do not access the DOM, browser storage or the network. `tests/test_architecture_boundaries.mjs` enforces this boundary, script order and line/byte debt ceilings. `composition-contract.js` additionally classifies every `window.NOVEL_*` dependency as eager, deferred, optional or host-injected; Node validates provider uniqueness/order and `app.js` runs a fail-fast preflight before capturing ports, then verifies deferred globals before declaring the application ready.

## 3. Authoritative data and state

- Vault is the durable authority. `章节/*.md` is the authoritative chapter text on disk; `book.json` holds the aggregate and metadata.
- `chapter.body` is the in-memory authoritative projection. Textarea/workspace changes must first pass the body-mutation boundary before a save or handoff.
- localStorage is a bounded recovery cache, never an alternate durable authority.
- `chapter-state.js` is the only runtime writer for task, production and handoff business states.
- Every accepted quality result is bound to `bodySig/bodyRevision`. Any body mismatch invalidates the gate and makes handoff stale.
- Unknown future `schemaVersion` data is read-only. Migrations are adjacent and idempotent.

The state path is:

```text
pending → generating → reviewing
                       ├─ needs_revision → revising → reviewing
                       └─ accepted_pending_handoff → handing_off → done

accepted/done + body signature mismatch → needs_revision + stale handoff
```

Detailed data contracts live in `PROJECT-SCHEMA.md`; the executable transition tests remain the final authority.

## 4. Writing pipeline

The installed default remains the legacy Harness because the paid live A/B release gate is still `hold`. The schema-v2 release record is fail-closed at runtime and verified in CI. The candidate production path is opt-in and uses:

```text
Retrieve → compile chapter/scene contract → one coherent whole-chapter draft
         → deterministic signals + semantic critic → bounded revision
         → quality gate → handoff → reindex
```

The candidate does not commit partial scene output as authoritative body. Strict quality failure preserves the latest body in `needs_revision`; it cannot masquerade as a completed handoff. The fixed 6×8 corpus, live A/B artifacts, independent judge and human blind-review protocol are defined in `QUALITY-EVALUATION.md`. Every experiment also records the ordered SHA-256 manifest of the 27 quality-critical source files; a report becomes stale as soon as prompt, context, generation, scoring or gate code changes.

## 5. Backend and persistence contract

Rust and Python execute the same HTTP contract v1 fixture for health, library, book create/load/save/reload, file watch and conflict behavior. Rust remains the formal semantic authority. All ordinary errors use the structured backend envelope; save conflicts preserve the disk body and return fresh chapter baselines. The exact fixture and intentional production/debug differences are documented in `BACKEND-CONTRACT.md`.

## 6. Observability and performance

`runtime-observability.js` maps failures to exactly eight categories: `model`, `retrieval`, `plan`, `quality`, `handoff`, `storage`, `conflict`, `cancel`. A failure envelope identifies stage, state projection, chapter body signature, context-manifest signature and retry policy without exporting body, prompt, credential, URL or raw exception text.

The advanced settings panel exports a local JSON report. Context build, model call, handoff and save metrics are bounded. The 20/100/400 chapter performance gate measures context compilation, serialization, Markdown export, diagnostics export and project bytes. See `OBSERVABILITY.md` and `PERFORMANCE-BUDGET.md` for schemas and budgets.

## 7. Executable gates

The single local/hosted entry is `mogao-tauri/scripts/ci.ps1`. It runs:

1. version, release-helper and UI-sync contracts;
2. ESLint correctness;
3. Rust format/check/tests;
4. all Node behavior tests plus pure-domain coverage;
5. deterministic article-quality fixture, source-bound release-decision verification and 20/100/400 performance budgets;
6. Python debug tests and the shared Rust/Python HTTP fixture;
7. formal Rust browser E2E, layout smoke and approved visual baseline.

Release assembly is a separate immutable transaction described by the release manual. Source checks never mutate an existing release.

## 8. Supporting current contracts

These files are current subordinate specifications, not competing plans:

- `PROJECT-SCHEMA.md` — root/production schema, migrations and state invariants.
- `FRONTEND-ARCHITECTURE.md` — browser composition and controller boundaries.
- `GENERATION-ARCHITECTURE.md` — context, drafting and quality pipeline.
- `BACKEND-CONTRACT.md` — Rust/Python HTTP contract and compatibility cutoff.
- `QUALITY-EVALUATION.md` — reproducible A/B and default-engine release decision.
- `OBSERVABILITY.md` — failure/metric privacy contract.
- `PERFORMANCE-BUDGET.md` — scale fixtures and executable latency limits.
