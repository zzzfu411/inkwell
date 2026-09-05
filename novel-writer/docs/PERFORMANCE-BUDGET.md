# Performance budget

## Scope

The executable scale gate uses deterministic 20, 100 and 400 chapter projects. Each fixture includes tasks, chapter bodies, memory, Canon, graph, world, style and bounded diagnostics. It exercises the synchronous work most likely to make the writing desk feel blocked:

- context compilation for the active task;
- whole-project JSON serialization before save;
- merged Markdown export;
- sanitized diagnostics export;
- serialized project size.

The fixture seed is `inkwell-scale-v1-2026-09`. The base fixture SHA-256 is calculated before any timed operation, so it is stable even though measured durations and report timestamps are not.

## Budgets

All latency limits apply to both median and p95. The gate fails on any single violation.

| Chapters | Project bytes | Context median / p95 | Save serialization median / p95 | Markdown median / p95 | Diagnostics median / p95 |
|---:|---:|---:|---:|---:|---:|
| 20 | ≤ 300,000 | ≤ 12 / 30 ms | ≤ 8 / 20 ms | ≤ 8 / 25 ms | ≤ 8 / 20 ms |
| 100 | ≤ 1,500,000 | ≤ 30 / 75 ms | ≤ 25 / 60 ms | ≤ 25 / 60 ms | ≤ 10 / 30 ms |
| 400 | ≤ 6,000,000 | ≤ 60 / 120 ms | ≤ 75 / 180 ms | ≤ 80 / 200 ms | ≤ 15 / 50 ms |

The p95 context limit is the explicit interaction budget. It includes observability bookkeeping and therefore guards the actual production path rather than an isolated helper.

The absolute limits intentionally leave room for shared Windows CI runners while still catching accidental full-body scans, unbounded diagnostic growth and super-linear context assembly. A limit may only be raised with a saved before/after report and a documented product reason.

## Command and artifact

From `mogao-tauri/`:

```powershell
npm run test:performance
```

The command writes `output/performance/report.json`, prints fixture seed and median/p95 values, and exits non-zero on a regression. `scripts/ci.ps1` runs it after the deterministic quality fixture and before backend tests. Hosted CI uploads `output/` on failure.

The module-level test verifies fixture sizes, budget completeness and that a value just over the limit fails. The benchmark itself is a separate CI command so unit coverage timing does not distort latency.

## Interpreting a failure

- Context-only regression: inspect evidence selection, chapter lookup, Canon ranking, RAG preparation and diagnostic append bounds.
- Serialization and size regression: inspect newly persisted fields, body duplication and capped histories.
- Markdown-only regression: inspect chapter ordering and repeated concatenation.
- Diagnostics-only regression: inspect sanitization, deduplication and event caps; never bypass the privacy allow-list for speed.
- All operations regress: confirm the runner is not under unusual system pressure, rerun once, then compare the saved reports. Do not weaken a p95 budget based on one unexplained run.

