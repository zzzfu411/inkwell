/**
 * Secret-free runtime diagnostics for local export.
 *
 * This module deliberately accepts rich runtime objects but only emits a fixed,
 * numeric/identifier allow-list. Prompt text, chapter text, credentials, URLs and
 * raw exception messages never cross this boundary.
 */
window.NOVEL_OBSERVABILITY = (() => {
  "use strict";

  const SCHEMA_VERSION = 1;
  const ERROR_CATEGORIES = Object.freeze([
    "model",
    "retrieval",
    "plan",
    "quality",
    "handoff",
    "storage",
    "conflict",
    "cancel",
  ]);
  const CATEGORY_SET = new Set(ERROR_CATEGORIES);
  const EVENT_TYPES = new Set(["context", "model", "handoff", "storage", "failure", "performance"]);
  const DEFAULT_LIMIT = 500;
  const PROJECT_LIMIT = 240;

  const CATEGORY_SUMMARY = Object.freeze({
    model: "模型请求未完成",
    retrieval: "上下文或检索未完成",
    plan: "规划或契约未完成",
    quality: "质量验收或修订未完成",
    handoff: "章后交接未完成",
    storage: "本地持久化未完成",
    conflict: "检测到并发版本冲突",
    cancel: "操作已取消",
  });

  const RETRY_POLICY = Object.freeze({
    model: { safe: true, mode: "retry-stage", reason: "模型调用不写入权威正文终态" },
    retrieval: { safe: true, mode: "rebuild-context", reason: "可重新构建同一证据包" },
    plan: { safe: true, mode: "retry-stage", reason: "规划失败不会提交正文" },
    quality: { safe: true, mode: "retry-from-authoritative-body", reason: "以当前权威正文重新验收或修订" },
    handoff: { safe: true, mode: "resume-handoff", reason: "正文身份不变时可补做交接" },
    storage: { safe: true, mode: "retry-save", reason: "在无版本冲突时可重复同一保存" },
    conflict: { safe: false, mode: "resolve-conflict", reason: "必须先选择磁盘版、本地版或合并稿" },
    cancel: { safe: true, mode: "restart-operation", reason: "取消不会提交未完成阶段" },
  });

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function count(value) {
    return Array.isArray(value) ? value.length : Math.max(0, Math.floor(finite(value)));
  }

  function safeId(value, fallback = "") {
    const result = String(value ?? "")
      .trim()
      .replace(/[^a-zA-Z0-9_.:@/-]+/g, "_")
      .slice(0, 120);
    return result || fallback;
  }

  function safeCode(value, fallback = "UNCLASSIFIED_ERROR") {
    const code = String(value || fallback)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_:-]+/g, "_")
      .slice(0, 80);
    return code || fallback;
  }

  function safeStage(value, fallback = "unknown") {
    const stage = String(value || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return stage || fallback;
  }

  function stableHash(value) {
    let hash = 2166136261;
    const source = String(value ?? "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function byteLength(value) {
    let serialized;
    try {
      serialized = typeof value === "string" ? value : JSON.stringify(value);
    } catch (_) {
      return 0;
    }
    if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
    return unescape(encodeURIComponent(serialized)).length;
  }

  function stageCategory(stage) {
    const value = safeStage(stage);
    if (/cancel|abort|stop/.test(value)) return "cancel";
    if (/conflict|concurr|version/.test(value)) return "conflict";
    if (/save|storage|persist|vault|file|checkpoint/.test(value)) return "storage";
    if (/handoff|digest|graph|index/.test(value)) return "handoff";
    if (/quality|review|revision|repair|continuity/.test(value)) return "quality";
    if (/retriev|rag|context|evidence|embed/.test(value)) return "retrieval";
    if (/plan|contract|outline|beat/.test(value)) return "plan";
    return "model";
  }

  function classifyError(error, context = {}) {
    const rawCode = error?.code || error?.name || context.code || "UNCLASSIFIED_ERROR";
    const code = safeCode(rawCode);
    const stage = safeStage(context.stage || error?.stage || error?.lastErrorStage || "unknown");
    let category = CATEGORY_SET.has(context.category) ? context.category : "";
    const fingerprint = `${code} ${stage}`;
    if (!category && /ABORT|CANCEL|STOP/.test(fingerprint)) category = "cancel";
    if (!category && Number(error?.status) === 409) category = "conflict";
    if (!category && /CONFLICT|CONCURRENT|SOURCE_MISMATCH|VERSION|ILLEGAL_.*TRANSITION|STATE_INVALID/.test(fingerprint)) {
      category = "conflict";
    }
    if (!category && /SAVE|STORAGE|PERSIST|VAULT|FILE|CHECKPOINT|DISK/.test(fingerprint)) category = "storage";
    if (!category && /HANDOFF|DIGEST|GRAPH|INDEX|PREV_HANDOFF/.test(fingerprint)) category = "handoff";
    if (!category && /QUALITY|REVIEW|REVISION|REPAIR|CONTINUITY|OUTPUT_TOO_SHORT/.test(fingerprint)) {
      category = "quality";
    }
    if (!category && /RAG|RETRIEV|CONTEXT|EVIDENCE|EMBED/.test(fingerprint)) category = "retrieval";
    if (!category && /PLAN|CONTRACT|OUTLINE|PROTOCOL|BEAT/.test(fingerprint)) category = "plan";
    if (!category) category = stageCategory(stage);
    return { category, code, stage };
  }

  function bodyIdentity(chapter) {
    if (!chapter || typeof chapter !== "object") return null;
    const body = String(chapter.body || "");
    return {
      chapterId: safeId(chapter.id),
      signature: stableHash(body),
      chars: body.length,
      revision: Math.max(0, Math.floor(finite(chapter.bodyRevision || chapter.revision))),
      authoritative: safeId(chapter.bodyAuthority || chapter.authoritativeBody || "chapter.body", "chapter.body"),
    };
  }

  function latestManifest(project, context = {}) {
    if (context.manifest && typeof context.manifest === "object") return context.manifest;
    if (project?._lastContextManifest && typeof project._lastContextManifest === "object") {
      return project._lastContextManifest;
    }
    const manifests = Array.isArray(project?.contextManifests) ? project.contextManifests : [];
    return manifests.length ? manifests[manifests.length - 1] : null;
  }

  function evidenceIdentity(project, context = {}) {
    const manifest = latestManifest(project, context);
    if (!manifest) return null;
    const used = Array.isArray(manifest.used) ? manifest.used : manifest.blocks;
    const omitted = manifest.omitted;
    const truncated = manifest.truncated;
    const ragHits = manifest.rag?.hits;
    const signatureSource = [
      manifest.id,
      manifest.stage,
      manifest.chars,
      manifest.tokens,
      ...(Array.isArray(used) ? used.map((item) => (typeof item === "string" ? item : item?.key || item?.id || "")) : []),
    ].join("|");
    return {
      manifestId: safeId(manifest.id),
      signature: stableHash(signatureSource),
      chars: Math.max(0, Math.floor(finite(manifest.chars))),
      tokens: Math.max(0, Math.floor(finite(manifest.tokens))),
      usedCount: count(used),
      omittedCount: count(omitted),
      truncatedCount: count(truncated),
      ragHits: count(ragHits),
    };
  }

  function runtimeState(project, chapter, task) {
    return {
      task: safeId(task?.status || "unknown", "unknown"),
      production: safeId(chapter?.production?.status || "unknown", "unknown"),
      productionStage: safeStage(chapter?.production?.stage || "unknown"),
      handoff: safeId(chapter?.handoffStatus || "unknown", "unknown"),
    };
  }

  function create({ clock = () => Date.now(), monotonic = null, eventLimit = DEFAULT_LIMIT } = {}) {
    const events = [];
    let sequence = 0;
    const monotonicClock =
      typeof monotonic === "function"
        ? monotonic
        : () => (typeof performance !== "undefined" && performance?.now ? performance.now() : clock());

    function startTimer() {
      return finite(monotonicClock());
    }

    function elapsedMs(startedAt) {
      return Math.max(0, Math.round((finite(monotonicClock()) - finite(startedAt)) * 1000) / 1000);
    }

    function nextId(type) {
      sequence += 1;
      return `diag_${Math.floor(finite(clock()))}_${safeId(type, "event")}_${sequence}`;
    }

    function retryFor(category, context = {}) {
      const base = RETRY_POLICY[category] || RETRY_POLICY.model;
      if (typeof context.retrySafe !== "boolean") return { ...base };
      return {
        safe: context.retrySafe,
        mode: safeId(context.retryMode || base.mode, base.mode),
        reason: context.retrySafe ? base.reason : "当前调用方判定必须先由作者确认状态",
      };
    }

    function failureEnvelope(error, context = {}) {
      const project = context.project || null;
      const chapter = context.chapter || null;
      const task = context.task || null;
      const classified = classifyError(error, context);
      return {
        schemaVersion: SCHEMA_VERSION,
        id: nextId("failure"),
        at: new Date(finite(clock())).toISOString(),
        category: classified.category,
        code: classified.code,
        stage: classified.stage,
        summary: CATEGORY_SUMMARY[classified.category],
        state: runtimeState(project, chapter, task),
        body: bodyIdentity(chapter),
        evidence: evidenceIdentity(project, context),
        retry: retryFor(classified.category, context),
      };
    }

    function safeUsage(value) {
      const usage = value && typeof value === "object" ? value : {};
      return {
        inputTokens: Math.max(0, Math.floor(finite(usage.inputTokens ?? usage.prompt_tokens))),
        outputTokens: Math.max(0, Math.floor(finite(usage.outputTokens ?? usage.completion_tokens))),
        totalTokens: Math.max(0, Math.floor(finite(usage.totalTokens ?? usage.total_tokens))),
      };
    }

    function safeMetric(type, fields = {}, base = {}) {
      const common = {
        schemaVersion: SCHEMA_VERSION,
        id: safeId(base.id || fields.id),
        at: String(base.at || fields.at || new Date(finite(clock())).toISOString()),
        type,
      };
      if (type === "context") {
        return {
          ...common,
          stage: safeStage(fields.stage || "context-build"),
          durationMs: Math.max(0, finite(fields.durationMs)),
          taskId: safeId(fields.taskId),
          chapterId: safeId(fields.chapterId),
          manifestId: safeId(fields.manifestId),
          chars: Math.max(0, Math.floor(finite(fields.chars))),
          tokens: Math.max(0, Math.floor(finite(fields.tokens))),
          budget: Math.max(0, Math.floor(finite(fields.budget))),
          tokenBudget: Math.max(0, Math.floor(finite(fields.tokenBudget))),
          usedCount: count(fields.usedCount ?? fields.used),
          omittedCount: count(fields.omittedCount ?? fields.omitted),
          truncatedCount: count(fields.truncatedCount ?? fields.truncated),
          ragHits: count(fields.ragHits),
        };
      }
      if (type === "model") {
        const classified = fields.ok === false ? classifyError({ code: fields.code }, fields) : null;
        return {
          ...common,
          stage: safeStage(fields.stage || "model"),
          durationMs: Math.max(0, finite(fields.durationMs)),
          ok: fields.ok !== false,
          model: safeId(fields.model, "unknown"),
          stream: Boolean(fields.stream),
          requestCount: Math.max(0, Math.floor(finite(fields.requestCount, 1))),
          inputChars: Math.max(0, Math.floor(finite(fields.inputChars))),
          outputChars: Math.max(0, Math.floor(finite(fields.outputChars))),
          finishReason: safeId(fields.finishReason, "unknown"),
          usage: safeUsage(fields.usage),
          category: classified?.category || "",
          code: classified?.code || "",
        };
      }
      if (type === "handoff") {
        const classified = fields.ok === false ? classifyError({ code: fields.code }, fields) : null;
        return {
          ...common,
          stage: safeStage(fields.stage || "handoff"),
          durationMs: Math.max(0, finite(fields.durationMs)),
          ok: fields.ok !== false,
          taskId: safeId(fields.taskId),
          chapterId: safeId(fields.chapterId),
          reviewIssues: count(fields.reviewIssues),
          digestFacts: count(fields.digestFacts),
          category: classified?.category || "",
          code: classified?.code || "",
        };
      }
      if (type === "storage") {
        const classified = fields.ok === false ? classifyError({ code: fields.code }, fields) : null;
        return {
          ...common,
          stage: safeStage(fields.stage || "save"),
          durationMs: Math.max(0, finite(fields.durationMs)),
          ok: fields.ok !== false,
          bytes: Math.max(0, Math.floor(finite(fields.bytes))),
          chapters: count(fields.chapters),
          warnings: count(fields.warnings),
          conflicts: count(fields.conflicts),
          category: classified?.category || "",
          code: classified?.code || "",
        };
      }
      if (type === "performance") {
        return {
          ...common,
          scenario: safeId(fields.scenario),
          operation: safeId(fields.operation),
          chapters: count(fields.chapters),
          medianMs: Math.max(0, finite(fields.medianMs)),
          p95Ms: Math.max(0, finite(fields.p95Ms)),
          budgetMs: Math.max(0, finite(fields.budgetMs)),
          passed: fields.passed !== false,
        };
      }
      if (type === "failure") {
        const source = fields.envelope || fields;
        const category = CATEGORY_SET.has(source.category) ? source.category : "model";
        return {
          ...common,
          category,
          code: safeCode(source.code),
          stage: safeStage(source.stage),
          summary: CATEGORY_SUMMARY[category],
          state: {
            task: safeId(source.state?.task || "unknown", "unknown"),
            production: safeId(source.state?.production || "unknown", "unknown"),
            productionStage: safeStage(source.state?.productionStage || "unknown"),
            handoff: safeId(source.state?.handoff || "unknown", "unknown"),
          },
          body: source.body
            ? {
                chapterId: safeId(source.body.chapterId),
                signature: safeId(source.body.signature),
                chars: Math.max(0, Math.floor(finite(source.body.chars))),
                revision: Math.max(0, Math.floor(finite(source.body.revision))),
                authoritative: safeId(source.body.authoritative || "chapter.body", "chapter.body"),
              }
            : null,
          evidence: source.evidence
            ? {
                manifestId: safeId(source.evidence.manifestId),
                signature: safeId(source.evidence.signature),
                chars: Math.max(0, Math.floor(finite(source.evidence.chars))),
                tokens: Math.max(0, Math.floor(finite(source.evidence.tokens))),
                usedCount: count(source.evidence.usedCount),
                omittedCount: count(source.evidence.omittedCount),
                truncatedCount: count(source.evidence.truncatedCount),
                ragHits: count(source.evidence.ragHits),
              }
            : null,
          retry: {
            safe: Boolean(source.retry?.safe),
            mode: safeId(source.retry?.mode || RETRY_POLICY[category].mode),
            reason: RETRY_POLICY[category].reason,
          },
        };
      }
      return null;
    }

    function appendProject(project, event) {
      if (!project || typeof project !== "object") return;
      try {
        const previous = Array.isArray(project.runtimeDiagnostics) ? project.runtimeDiagnostics : [];
        project.runtimeDiagnostics = [...previous, event].slice(-PROJECT_LIMIT);
      } catch (_) {
        // Read-only/future schema projects intentionally refuse diagnostic persistence.
      }
    }

    function record(type, fields = {}, project = null) {
      if (!EVENT_TYPES.has(type)) return null;
      const event = safeMetric(type, fields, {
        id: nextId(type),
        at: new Date(finite(clock())).toISOString(),
      });
      if (!event) return null;
      events.push(event);
      if (events.length > eventLimit) events.splice(0, events.length - eventLimit);
      appendProject(project, event);
      return event;
    }

    function captureFailure(project, error, context = {}) {
      if (error?.__inkwellFailureEnvelope) return error.__inkwellFailureEnvelope;
      const envelope = failureEnvelope(error, { ...context, project });
      record("failure", { envelope }, project);
      for (const target of [context.chapter, context.task, context.attachProject === false ? null : project]) {
        if (target && typeof target === "object") {
          try {
            target.lastFailure = envelope;
          } catch (_) {
            // Future schema objects can be frozen/read-only.
          }
        }
      }
      if (error && typeof error === "object") {
        try {
          Object.defineProperty(error, "__inkwellFailureEnvelope", {
            value: envelope,
            configurable: true,
          });
        } catch (_) {
          // Some host errors are non-extensible; the recorded envelope still exists.
        }
      }
      return envelope;
    }

    function percentile(values, ratio) {
      if (!values.length) return 0;
      const sorted = values.slice().sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
    }

    function exportReport(project = null) {
      const combined = [...(Array.isArray(project?.runtimeDiagnostics) ? project.runtimeDiagnostics : []), ...events];
      const seen = new Set();
      const sanitized = [];
      for (const raw of combined) {
        const type = EVENT_TYPES.has(raw?.type) ? raw.type : "";
        if (!type) continue;
        const event = safeMetric(type, raw, raw);
        if (!event || seen.has(event.id)) continue;
        seen.add(event.id);
        sanitized.push(event);
      }
      const durations = sanitized.map((event) => finite(event.durationMs, -1)).filter((value) => value >= 0);
      const failures = sanitized.filter((event) => event.type === "failure");
      const byCategory = Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, 0]));
      for (const failure of failures) byCategory[failure.category] += 1;
      return {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date(finite(clock())).toISOString(),
        product: "Inkwell",
        appVersion: safeId(window.NOVEL_DEFAULTS?.appVersion || window.NOVEL_APP_VERSION || "unknown", "unknown"),
        project: project
          ? {
              id: safeId(project.id),
              schemaVersion: Math.max(0, Math.floor(finite(project.schemaVersion))),
              chapters: count(project.chapters),
              tasks: count(project.tasks),
            }
          : null,
        summary: {
          events: sanitized.length,
          failures: failures.length,
          byCategory,
          durationMs: {
            median: Math.round(percentile(durations, 0.5) * 1000) / 1000,
            p95: Math.round(percentile(durations, 0.95) * 1000) / 1000,
          },
        },
        events: sanitized.slice(-DEFAULT_LIMIT),
      };
    }

    function clearSession() {
      events.length = 0;
    }

    return {
      classifyError,
      failureEnvelope,
      captureFailure,
      record,
      exportReport,
      startTimer,
      elapsedMs,
      stableHash,
      byteLength,
      clearSession,
      sessionEvents: () => events.slice(),
    };
  }

  const singleton = create();
  return {
    ...singleton,
    create,
    SCHEMA_VERSION,
    ERROR_CATEGORIES,
    RETRY_POLICY,
  };
})();
