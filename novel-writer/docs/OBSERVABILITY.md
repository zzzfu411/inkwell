# Runtime observability contract

## Purpose

Inkwell diagnostics must answer five questions after a failure:

1. Which stage failed?
2. What were the task, production and handoff states?
3. Which authoritative body was used?
4. Which evidence manifest was used?
5. Is repeating the operation safe?

It must answer them without copying creative text or credentials into telemetry. All diagnostics are local and user-exported; there is no telemetry upload path.

## Error taxonomy

`runtime-observability.js` exposes one closed category enum:

| Category | Typical stages/codes | Default retry policy |
|---|---|---|
| `model` | `model-call`, HTTP/upstream failures | retry the same model stage |
| `retrieval` | RAG, embeddings, context/evidence build | rebuild context, then retry |
| `plan` | pitch/world/cast/spine/beat/chapter contract | retry before committing body |
| `quality` | critic, continuity review, revision, repair | retry from current authoritative body |
| `handoff` | digest, graph delta, index | resume handoff if body identity is unchanged |
| `storage` | Vault save, checkpoint, file persistence | retry when no conflict exists |
| `conflict` | HTTP 409, source mismatch, disk concurrency | unsafe until the author resolves versions |
| `cancel` | `AbortError`, stop/cancel | restart the operation |

Callers may narrow `retry.safe` to `false`; they cannot add a ninth category. Presentation text is derived from category/code and is separate from the persisted envelope.

## Failure envelope

```json
{
  "schemaVersion": 1,
  "id": "diag_..._failure_...",
  "at": "2026-09-05T...Z",
  "category": "quality",
  "code": "CONTINUITY_REVIEW_FAILED",
  "stage": "quality-review",
  "summary": "质量验收或修订未完成",
  "state": {
    "task": "writing",
    "production": "needs_revision",
    "productionStage": "quality-review",
    "handoff": "stale"
  },
  "body": {
    "chapterId": "c002",
    "signature": "fnv1a_...",
    "chars": 8241,
    "revision": 7,
    "authoritative": "chapter.body"
  },
  "evidence": {
    "manifestId": "ctx_...",
    "signature": "fnv1a_...",
    "chars": 9100,
    "tokens": 5300,
    "usedCount": 9,
    "omittedCount": 2,
    "truncatedCount": 1,
    "ragHits": 5
  },
  "retry": {
    "safe": true,
    "mode": "retry-from-authoritative-body",
    "reason": "以当前权威正文重新验收或修订"
  }
}
```

`body.signature` is an identity token, not a content sample. `evidence.signature` hashes manifest identity and selected block identifiers; RAG snippets and evidence strings are never included.

The same thrown `Error` is recorded once even if it crosses service and controller boundaries. The envelope is attached to the relevant project/task/chapter as `lastFailure` and also recorded as a bounded diagnostic event.

## Metric events

The allow-listed event types are:

- `context`: stage/duration, character/token budgets, selected/omitted/truncated counts and RAG hit count;
- `model`: stage/duration, model identifier, stream flag, input/output character counts, token counts and finish reason;
- `handoff`: stage/duration, success, chapter/task IDs and aggregate result counts;
- `storage`: stage/duration, serialized payload bytes, chapter/warning/conflict counts;
- `failure`: the safe envelope above;
- `performance`: scenario/operation, chapter count, median/p95 and pass/fail.

Project persistence keeps the newest 240 safe events. The current runtime keeps the newest 500. Export deduplicates them and re-sanitizes every event, including events loaded from disk.

## Data that is forbidden

The runtime report never contains:

- API keys, `Authorization`, session token or DPAPI payload;
- base URL or request URL;
- messages, prompt text, context block text or RAG snippets;
- chapter body, selected passage, author instruction or raw model output;
- raw exception messages or upstream response bodies.

The optional `NOVEL_MODEL_AUDIT` used by an explicitly confirmed live A/B experiment is a different, research-only artifact path and may contain prompts for reproducibility. It is not included in runtime diagnostics.

This privacy contract is enforced by `test_runtime_observability.mjs`, API integration tests and a source boundary assertion. Adding a metric field requires extending the allow-list and tests.

## Export and triage

Open Settings → Advanced → Local diagnostic report → Export sanitized diagnostics JSON. The report contains its schema/app version, aggregate counts, p50/p95 duration and recent safe events.

Triage order:

1. inspect the newest `failure` event and its category/stage;
2. compare `body.signature` with the current chapter identity;
3. compare `evidence.manifestId/signature` with the last context manifest;
4. follow `retry.safe/mode` rather than repeating a conflict blindly;
5. correlate the nearest context/model/handoff/storage duration events by time.

