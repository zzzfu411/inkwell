/**
 * Explicit contract for the classic-script composition root.
 *
 * `requires` must be provided by an earlier script. `deferred` may be provided later but must exist
 * by application-ready time. `external` is injected by a host or evaluation sandbox. Optional
 * capabilities must be named explicitly instead of being hidden behind optional chaining.
 */
window.NOVEL_COMPOSITION_CONTRACT = (() => {
  "use strict";

  const m = (file, provides = [], requires = [], deferred = [], optional = [], external = []) =>
    Object.freeze({
      file,
      provides: Object.freeze(provides),
      requires: Object.freeze(requires),
      deferred: Object.freeze(deferred),
      optional: Object.freeze(optional),
      external: Object.freeze(external),
    });

  const modules = Object.freeze([
    m("theme-init.js"),
    m("quality-release-policy.js", ["NOVEL_QUALITY_RELEASE_POLICY"]),
    m(
      "quality-release.js",
      ["NOVEL_QUALITY_RELEASE", "NOVEL_QUALITY_RELEASE_RECORD"],
      ["NOVEL_QUALITY_RELEASE_POLICY"]
    ),
    m("runtime-observability.js", ["NOVEL_OBSERVABILITY"], [], ["NOVEL_APP_VERSION", "NOVEL_DEFAULTS"]),
    m("config.js", ["NOVEL_APP_VERSION", "NOVEL_DEFAULTS"], ["NOVEL_QUALITY_RELEASE"]),
    m("chapter-format.js", ["NOVEL_CHAPTER_FORMAT"]),
    m("prompts.js", ["NOVEL_PROMPTS"]),
    m("craft.js", ["NOVEL_CRAFT"]),
    m("chapter-state.js", ["NOVEL_CHAPTER_STATE"]),
    m("project-migrations.js", ["NOVEL_PROJECT_MIGRATIONS"], ["NOVEL_CHAPTER_STATE"]),
    m("production-state.js", ["NOVEL_PRODUCTION_STATE"], ["NOVEL_CHAPTER_STATE"]),
    m("conflict-use-cases.js", ["NOVEL_CONFLICT_USE_CASES"]),
    m("persistence-use-cases.js", ["NOVEL_PERSISTENCE_USE_CASES"]),
    m("write-use-cases.js", ["NOVEL_WRITE_USE_CASES"]),
    m("memory-reducers.js", ["NOVEL_MEMORY_REDUCERS"]),
    m("context-budget.js", ["NOVEL_CONTEXT_BUDGET"]),
    m("context-evidence.js", ["NOVEL_CONTEXT_EVIDENCE"]),
    m(
      "context.js",
      ["NOVEL_CONTEXT"],
      [
        "NOVEL_CONTEXT_BUDGET",
        "NOVEL_CONTEXT_EVIDENCE",
        "NOVEL_CRAFT",
        "NOVEL_DEFAULTS",
        "NOVEL_MEMORY_REDUCERS",
        "NOVEL_OBSERVABILITY",
        "NOVEL_PROMPTS",
      ],
      ["NOVEL_NARRATIVE", "NOVEL_RAG"]
    ),
    m("rag.js", ["NOVEL_RAG"], ["NOVEL_DEFAULTS"]),
    m(
      "store.js",
      ["NOVEL_STORE"],
      ["NOVEL_DEFAULTS", "NOVEL_PRODUCTION_STATE", "NOVEL_PROJECT_MIGRATIONS"]
    ),
    m("ui-shell.js", ["NOVEL_UI_SHELL"]),
    m("text-metrics.js", ["NOVEL_TEXT_METRICS"]),
    m(
      "vault.js",
      ["NOVEL_VAULT"],
      ["NOVEL_PRODUCTION_STATE", "NOVEL_PROJECT_MIGRATIONS", "NOVEL_RAG"]
    ),
    m("library.js", ["NOVEL_LIBRARY"], ["NOVEL_VAULT"]),
    m("workspace.js", ["NOVEL_WORKSPACE"], ["NOVEL_UI_SHELL", "NOVEL_VAULT"], ["NOVEL_MODAL_A11Y", "NOVEL_VAULT_UI"]),
    m("api.js", ["NOVEL_API"], ["NOVEL_OBSERVABILITY"], [], [], ["NOVEL_MODEL_AUDIT"]),
    m("planning-service.js", ["NOVEL_PLANNING_SERVICE"]),
    m("handoff-service.js", ["NOVEL_HANDOFF_SERVICE"]),
    m("legacy-generation-adapter.js", ["NOVEL_LEGACY_GENERATION_ADAPTER"]),
    m(
      "pipeline.js",
      ["NOVEL_PIPELINE"],
      [
        "NOVEL_API",
        "NOVEL_CHAPTER_STATE",
        "NOVEL_CONTEXT",
        "NOVEL_CRAFT",
        "NOVEL_DEFAULTS",
        "NOVEL_HANDOFF_SERVICE",
        "NOVEL_LEGACY_GENERATION_ADAPTER",
        "NOVEL_OBSERVABILITY",
        "NOVEL_PLANNING_SERVICE",
        "NOVEL_PRODUCTION_STATE",
        "NOVEL_PROMPTS",
        "NOVEL_RAG",
        "NOVEL_STORE",
      ],
      ["NOVEL_HARNESS", "NOVEL_PRODUCTION_ENGINE"]
    ),
    m(
      "harness.js",
      ["NOVEL_HARNESS"],
      ["NOVEL_CHAPTER_STATE", "NOVEL_CONTEXT", "NOVEL_DEFAULTS", "NOVEL_PIPELINE", "NOVEL_RAG"]
    ),
    m("chapter-drafting-service.js", ["NOVEL_CHAPTER_DRAFTING"]),
    m("production-quality.js", ["NOVEL_PRODUCTION_QUALITY"]),
    m(
      "production-engine.js",
      ["NOVEL_PRODUCTION_ENGINE"],
      [
        "NOVEL_API",
        "NOVEL_CHAPTER_DRAFTING",
        "NOVEL_CHAPTER_STATE",
        "NOVEL_CONTEXT",
        "NOVEL_CRAFT",
        "NOVEL_DEFAULTS",
        "NOVEL_HARNESS",
        "NOVEL_PIPELINE",
        "NOVEL_PRODUCTION_QUALITY",
        "NOVEL_PRODUCTION_STATE",
        "NOVEL_PROMPTS",
        "NOVEL_RAG",
      ]
    ),
    m("chapter-split.js", ["NOVEL_CHAPTER_SPLIT"]),
    m("narrative-model.js", ["NOVEL_NARRATIVE"]),
    m("graph-view.js", ["NOVEL_GRAPH_VIEW"]),
    m("graph-panel.js", ["NOVEL_GRAPH_PANEL"]),
    m("story-records.js", ["NOVEL_STORY_RECORDS"]),
    m("composer-review.js", ["NOVEL_COMPOSER_REVIEW"], ["NOVEL_CHAPTER_STATE"]),
    m("write-ui.js", ["NOVEL_WRITE_UI"], ["NOVEL_CRAFT"]),
    m(
      "analysis-runner.js",
      ["NOVEL_ANALYSIS"],
      ["NOVEL_API", "NOVEL_CHAPTER_SPLIT", "NOVEL_NARRATIVE", "NOVEL_PROMPTS"]
    ),
    m(
      "analyze-ui.js",
      ["NOVEL_ANALYZE_UI"],
      ["NOVEL_ANALYSIS", "NOVEL_CHAPTER_SPLIT", "NOVEL_GRAPH_VIEW", "NOVEL_NARRATIVE", "NOVEL_STORE", "NOVEL_VAULT"]
    ),
    m("vault-ui.js", ["NOVEL_VAULT_UI"], ["NOVEL_STORE", "NOVEL_VAULT", "NOVEL_WORKSPACE"]),
    m("runtime-diagnostics-ui.js", ["NOVEL_DIAGNOSTICS_UI"], ["NOVEL_OBSERVABILITY"]),
    m("composition-contract.js", ["NOVEL_COMPOSITION_CONTRACT"]),
    m(
      "app.js",
      ["NOVEL_MODAL_A11Y"],
      [
        "NOVEL_ANALYZE_UI",
        "NOVEL_API",
        "NOVEL_APP_VERSION",
        "NOVEL_CHAPTER_FORMAT",
        "NOVEL_CHAPTER_STATE",
        "NOVEL_COMPOSER_REVIEW",
        "NOVEL_COMPOSITION_CONTRACT",
        "NOVEL_CONFLICT_USE_CASES",
        "NOVEL_CONTEXT",
        "NOVEL_CRAFT",
        "NOVEL_DEFAULTS",
        "NOVEL_DIAGNOSTICS_UI",
        "NOVEL_GRAPH_PANEL",
        "NOVEL_GRAPH_VIEW",
        "NOVEL_HARNESS",
        "NOVEL_LIBRARY",
        "NOVEL_NARRATIVE",
        "NOVEL_OBSERVABILITY",
        "NOVEL_PERSISTENCE_USE_CASES",
        "NOVEL_PIPELINE",
        "NOVEL_PRODUCTION_ENGINE",
        "NOVEL_PRODUCTION_STATE",
        "NOVEL_PROJECT_MIGRATIONS",
        "NOVEL_RAG",
        "NOVEL_STORE",
        "NOVEL_STORY_RECORDS",
        "NOVEL_TEXT_METRICS",
        "NOVEL_UI_SHELL",
        "NOVEL_VAULT",
        "NOVEL_VAULT_UI",
        "NOVEL_WORKSPACE",
        "NOVEL_WRITE_UI",
        "NOVEL_WRITE_USE_CASES",
      ]
    ),
  ]);

  function valueExists(globals, name) {
    return globals != null && globals[name] != null;
  }

  function validateModules(input = modules) {
    const errors = [];
    const providers = new Map();
    const files = new Map(input.map((entry, index) => [entry.file, index]));
    if (files.size !== input.length) errors.push("composition contract contains duplicate file descriptors");
    input.forEach((entry, index) => {
      entry.provides.forEach((name) => {
        if (providers.has(name)) errors.push(`${name} has duplicate providers: ${providers.get(name).file}, ${entry.file}`);
        else providers.set(name, { file: entry.file, index });
      });
    });
    input.forEach((entry, index) => {
      entry.requires.forEach((name) => {
        const provider = providers.get(name);
        if (!provider) errors.push(`${entry.file} requires unknown provider ${name}`);
        else if (provider.index >= index) errors.push(`${entry.file} requires ${name} before ${provider.file} provides it`);
      });
      entry.deferred.forEach((name) => {
        if (!providers.has(name)) errors.push(`${entry.file} defers unknown provider ${name}`);
      });
    });
    return { ok: errors.length === 0, errors, providers };
  }

  function contractError(message, details) {
    const error = new Error(message);
    error.code = "COMPOSITION_CONTRACT_INVALID";
    error.details = details;
    return error;
  }

  function assertBeforeEntrypoint(file, globals = window) {
    const structural = validateModules(modules);
    const index = modules.findIndex((entry) => entry.file === file);
    const errors = [...structural.errors];
    if (index < 0) errors.push(`composition entrypoint not registered: ${file}`);
    if (index >= 0) {
      for (const entry of modules.slice(0, index)) {
        for (const name of entry.provides) {
          if (!valueExists(globals, name)) errors.push(`${entry.file} did not provide ${name}`);
        }
      }
      for (const name of modules[index].requires) {
        if (!valueExists(globals, name)) errors.push(`${file} is missing required global ${name}`);
      }
    }
    if (errors.length) throw contractError(`composition preflight failed for ${file}`, errors);
    return true;
  }

  function assertComplete(globals = window) {
    const structural = validateModules(modules);
    const errors = [...structural.errors];
    for (const entry of modules) {
      for (const name of [...entry.provides, ...entry.requires, ...entry.deferred]) {
        if (!valueExists(globals, name)) errors.push(`${entry.file} unresolved global ${name}`);
      }
    }
    if (errors.length) throw contractError("composition root is incomplete", [...new Set(errors)]);
    return true;
  }

  const structural = validateModules(modules);
  if (!structural.ok) throw contractError("composition contract is structurally invalid", structural.errors);

  return Object.freeze({
    schemaVersion: 1,
    modules,
    validateModules,
    assertBeforeEntrypoint,
    assertComplete,
  });
})();
