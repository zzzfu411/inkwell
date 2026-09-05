/**
 * 连续性与写作品质评测。
 *
 * 离线打分（不花额度）：
 *   node scripts/eval-continuity.mjs --score path/to/project.json
 *   node scripts/eval-continuity.mjs --compare baseline.json current.json
 *
 * 真实模型多章回归（必须确认费用）：
 *   $env:INKWELL_EVAL_CONFIRM='YES'
 *   $env:INKWELL_API_KEY='...'
 *   node scripts/eval-continuity.mjs path/to/seed-project.json
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";
import { QUALITY_RUNTIME_FILES } from "./quality-source-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const CORE_KEYS = ["lock", "task", "beat", "storyline", "canon", "story", "entity", "prev", "body", "rag"];

export const DEFAULT_THRESHOLDS = Object.freeze({
  minCompletionRate: 0.75,
  maxBlockers: 0,
  maxCanonConflicts: 0,
  maxOpeningCollisionRate: 0.34,
  minBeatCoverage: 0.7,
  minBeatSceneCoverage: 0.45,
  minDialogueRate: 0.05,
  maxStyleIssueRate: 0.5,
  minProductionPassRate: 0.7,
  minProductionQualityScore: 7,
  minProductionSceneCoverage: 0.75,
});

function detectOpeningKindFallback(text) {
  const head = String(text || "").replace(/^\s+/, "").slice(0, 72);
  if (!head.trim()) return "other";
  if (/^[「“"]/.test(head) || /^(?:她|他|我)(?:说|问|道)/.test(head)) return "dialogue";
  if (/雾|夜色|晨光|风雨|大雪|月光|天色/.test(head)) return "weather";
  if (/醒来|睁开|梦魇|从梦/.test(head)) return "waking";
  if (/走[在上路回下]|脚步|迈步|踏上/.test(head)) return "walking";
  if (/眼[神眸]|冷笑|嘴角|眉头/.test(head)) return "expression";
  return "other";
}

function writtenChapters(project) {
  return (project.chapters || [])
    .filter((chapter) => String(chapter?.body || "").trim())
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function openingKindOf(chapter) {
  return chapter?.openingKind || detectOpeningKindFallback(chapter?.body);
}

function ratio(part, whole) {
  return whole ? part / whole : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
}

function loadCraft() {
  if (globalThis.__INKWELL_CRAFT) return globalThis.__INKWELL_CRAFT;
  const sandbox = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, "craft.js"), "utf8"), sandbox);
  globalThis.__INKWELL_CRAFT = sandbox.window.NOVEL_CRAFT;
  return globalThis.__INKWELL_CRAFT;
}

export function computeMetrics(project) {
  const tasks = project.tasks || [];
  const reviews = project.continuityReviews || [];
  const manifests = project.contextManifests || [];
  const issues = project.continuityIssues || [];
  const loops = project.plotLoops || [];
  const chapters = writtenChapters(project);
  const done = tasks.filter((t) => t.status === "done").length;
  const reviewIssues = reviews.flatMap((r) => r.issues || []);
  const blockers = reviewIssues.filter((x) => x.severity === "blocker");
  const majors = reviewIssues.filter((x) => x.severity === "major");
  const ragWithHistory = manifests.filter((m) => m.stale?.previousChapterHandoff !== "unknown" || m.rag?.indexSize > 0);
  const ragHit = ragWithHistory.filter((m) => (m.rag?.hits || []).length > 0);
  const truncatedCore = manifests.flatMap((m) => m.truncated || []).filter((x) => CORE_KEYS.includes(x.key));

  const kinds = chapters.map(openingKindOf);
  let openingCollisions = 0;
  for (let i = 1; i < kinds.length; i++) {
    if (kinds[i] !== "other" && kinds[i] === kinds[i - 1]) openingCollisions += 1;
  }
  const withBeats = chapters.filter((chapter) => (chapter.beatPlan?.scenes || []).length >= 2).length;
  const styleIssues = issues.filter((issue) => ["style", "repetition"].includes(issue.type));
  const staleHandoffs = chapters.filter((chapter) => chapter.handoffStatus === "stale").length;
  const wordCounts = chapters.map((chapter) => String(chapter.body || "").replace(/\s+/g, "").length);
  const meanWords = wordCounts.length
    ? wordCounts.reduce((sum, n) => sum + n, 0) / wordCounts.length
    : 0;
  const Craft = loadCraft();
  const sceneRates = chapters.map((chapter) => {
    if (Number.isFinite(chapter.craftScore?.beatCoverage?.rate)) return chapter.craftScore.beatCoverage.rate;
    return Craft?.scoreBeatCoverage?.(chapter.body, chapter.beatPlan)?.rate ?? 1;
  });
  const dialogueRates = chapters.map((chapter) => {
    if (Number.isFinite(chapter.craftScore?.dialogueRate)) return chapter.craftScore.dialogueRate;
    return Craft?.dialogueRate?.(chapter.body) ?? 0;
  });

  const productionChapters = chapters.filter(
    (chapter) => chapter?.production && (chapter.production.qualityReview || chapter.qualityReview)
  );
  const productionReviews = productionChapters
    .map((chapter) => chapter.production?.qualityReview || chapter.qualityReview)
    .filter(Boolean);
  const productionPassed = productionReviews.filter(
    (review) => review.verdict === "pass" && Number(review.overall) >= 7
  ).length;
  const productionScores = productionReviews.map((review) => Number(review.overall) || 0);
  const productionSceneCoverage = productionReviews
    .map((review) => Number(review.local?.sceneCoverage?.rate ?? review.local?.beatCoverage?.rate))
    .filter(Number.isFinite);
  const productionRevisions = productionChapters.reduce(
    (sum, chapter) => sum + (Number(chapter.production?.revisions) || 0),
    0
  );

  return {
    generatedAt: new Date().toISOString(),
    chapters: chapters.length,
    tasks: { total: tasks.length, done, completionRate: ratio(done, tasks.length) },
    continuity: {
      reviews: reviews.length,
      blockers: blockers.length,
      majors: majors.length,
      openIssues: issues.filter((x) => x.status === "open").length,
      handledIssues: issues.filter((x) => x.status === "handled").length,
      canonConflicts: project.detailCanon?.conflicts?.length || 0,
    },
    plotLoops: {
      total: loops.length,
      open: loops.filter((x) => ["open", "deferred"].includes(x.status)).length,
      resolved: loops.filter((x) => x.status === "resolved").length,
      reopened: loops.filter((x) => Number(x.reopenCount) > 0).length,
    },
    retrieval: {
      writes: manifests.length,
      historicalWrites: ragWithHistory.length,
      writesWithHits: ragHit.length,
      hitCoverage: ragWithHistory.length ? ragHit.length / ragWithHistory.length : 1,
      coreTruncations: truncatedCore.length,
    },
    craft: {
      openingKinds: kinds,
      openingCollisions,
      openingCollisionRate: ratio(openingCollisions, Math.max(0, chapters.length - 1)),
      beatCoverage: ratio(withBeats, chapters.length),
      beatSceneCoverage: mean(sceneRates),
      chaptersWithBeats: withBeats,
      dialogueRate: mean(dialogueRates),
      styleIssues: styleIssues.length,
      styleIssueRate: ratio(styleIssues.length, chapters.length),
      staleHandoffs,
      meanChars: Math.round(meanWords),
    },
    production: {
      chapters: productionChapters.length,
      reviews: productionReviews.length,
      passed: productionPassed,
      passRate: productionReviews.length ? productionPassed / productionReviews.length : 1,
      meanQualityScore: productionScores.length ? mean(productionScores) : 0,
      meanSceneCoverage: productionSceneCoverage.length ? mean(productionSceneCoverage) : 0,
      needsRevision: productionChapters.filter((chapter) => chapter.production?.status === "needs_revision").length,
      revisions: productionRevisions,
    },
  };
}

export function evaluateThresholds(metrics, thresholds = DEFAULT_THRESHOLDS) {
  const craft = metrics.craft || {};
  const checks = [
    {
      id: "completionRate",
      ok: (metrics.tasks?.completionRate || 0) >= thresholds.minCompletionRate,
      value: metrics.tasks?.completionRate || 0,
      limit: thresholds.minCompletionRate,
    },
    {
      id: "blockers",
      ok: (metrics.continuity?.blockers || 0) <= thresholds.maxBlockers,
      value: metrics.continuity?.blockers || 0,
      limit: thresholds.maxBlockers,
    },
    {
      id: "canonConflicts",
      ok: (metrics.continuity?.canonConflicts || 0) <= thresholds.maxCanonConflicts,
      value: metrics.continuity?.canonConflicts || 0,
      limit: thresholds.maxCanonConflicts,
    },
    {
      id: "openingCollisionRate",
      ok: (craft.openingCollisionRate || 0) <= thresholds.maxOpeningCollisionRate,
      value: craft.openingCollisionRate || 0,
      limit: thresholds.maxOpeningCollisionRate,
    },
    {
      id: "beatCoverage",
      ok: (craft.beatCoverage || 0) >= thresholds.minBeatCoverage,
      value: craft.beatCoverage || 0,
      limit: thresholds.minBeatCoverage,
    },
    {
      id: "beatSceneCoverage",
      ok: (craft.beatSceneCoverage || 0) >= thresholds.minBeatSceneCoverage,
      value: craft.beatSceneCoverage || 0,
      limit: thresholds.minBeatSceneCoverage,
    },
    {
      id: "dialogueRate",
      ok: (craft.dialogueRate || 0) >= thresholds.minDialogueRate,
      value: craft.dialogueRate || 0,
      limit: thresholds.minDialogueRate,
    },
    {
      id: "styleIssueRate",
      ok: (craft.styleIssueRate || 0) <= thresholds.maxStyleIssueRate,
      value: craft.styleIssueRate || 0,
      limit: thresholds.maxStyleIssueRate,
    },
  ];
  // 没有 production 报告的旧项目不受新门槛影响；新引擎一旦产生报告，
  // 离线评测就必须检查运行时同一组质量指标。
  if ((metrics.production?.chapters || 0) > 0) {
    checks.push(
      {
        id: "productionPassRate",
        ok: (metrics.production?.passRate || 0) >= thresholds.minProductionPassRate,
        value: metrics.production?.passRate || 0,
        limit: thresholds.minProductionPassRate,
      },
      {
        id: "productionQualityScore",
        ok: (metrics.production?.meanQualityScore || 0) >= thresholds.minProductionQualityScore,
        value: metrics.production?.meanQualityScore || 0,
        limit: thresholds.minProductionQualityScore,
      },
      {
        id: "productionSceneCoverage",
        ok: (metrics.production?.meanSceneCoverage || 0) >= thresholds.minProductionSceneCoverage,
        value: metrics.production?.meanSceneCoverage || 0,
        limit: thresholds.minProductionSceneCoverage,
      }
    );
  }
  return {
    pass: checks.every((check) => check.ok),
    checks,
  };
}

const LOWER_BETTER = new Set([
  "continuity.blockers",
  "continuity.majors",
  "continuity.canonConflicts",
  "continuity.openIssues",
  "craft.openingCollisionRate",
  "craft.styleIssueRate",
  "craft.staleHandoffs",
  "retrieval.coreTruncations",
  "production.needsRevision",
]);

function pick(metrics, dotted) {
  return dotted.split(".").reduce((value, key) => value?.[key], metrics);
}

export function compareMetrics(before, after) {
  const paths = [
    "tasks.completionRate",
    "continuity.blockers",
    "continuity.majors",
    "continuity.canonConflicts",
    "craft.openingCollisionRate",
    "craft.beatCoverage",
    "craft.beatSceneCoverage",
    "craft.dialogueRate",
    "craft.styleIssueRate",
    "retrieval.hitCoverage",
    "retrieval.coreTruncations",
    "production.passRate",
    "production.meanQualityScore",
    "production.meanSceneCoverage",
    "production.needsRevision",
  ];
  const deltas = [];
  const regressions = [];
  for (const pathName of paths) {
    const left = Number(pick(before, pathName) || 0);
    const right = Number(pick(after, pathName) || 0);
    const delta = right - left;
    deltas.push({ path: pathName, before: left, after: right, delta });
    const worse = LOWER_BETTER.has(pathName) ? delta > 1e-9 : delta < -1e-9;
    if (worse) regressions.push(pathName);
  }
  return { deltas, regressions, improved: regressions.length === 0 };
}

export function loadRuntime({ modelAudit = null } = {}) {
  const sandbox = {
    window: {
      NOVEL_STORE: {
        uid: () => globalThis.crypto.randomUUID(),
      },
      NOVEL_MODEL_AUDIT: modelAudit,
    },
    console,
    fetch: globalThis.fetch,
    TextDecoder: globalThis.TextDecoder,
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    setTimeout,
    clearTimeout,
  };
  for (const file of QUALITY_RUNTIME_FILES) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });
  }
  return sandbox.window;
}

export function ensureProjectShape(project) {
  project.chapters = Array.isArray(project.chapters) ? project.chapters : [];
  project.tasks = Array.isArray(project.tasks) ? project.tasks : [];
  project.memoryRoll = Array.isArray(project.memoryRoll) ? project.memoryRoll : [];
  project.plotLoops = Array.isArray(project.plotLoops) ? project.plotLoops : [];
  project.continuityIssues = Array.isArray(project.continuityIssues) ? project.continuityIssues : [];
  project.continuityReviews = Array.isArray(project.continuityReviews) ? project.continuityReviews : [];
  project.contextManifests = Array.isArray(project.contextManifests) ? project.contextManifests : [];
  project.entityStates = project.entityStates && typeof project.entityStates === "object" ? project.entityStates : {};
  project.timelineEvents = Array.isArray(project.timelineEvents) ? project.timelineEvents : [];
  project.continuityMeta = {
    loopSchema: 1,
    issueSchema: 1,
    entitySchema: 1,
    ...(project.continuityMeta || {}),
  };
  project.detailCanon = project.detailCanon || { facts: [], conflicts: [] };
  project.storyline = project.storyline || {};
  project.storyState = project.storyState || {};
  project.graph = project.graph || { nodes: [], edges: [] };
  project.locks = project.locks || { logline: project.spine?.logline || "", forbidden: [], mustHonor: [] };
  project.pipelineLog = Array.isArray(project.pipelineLog) ? project.pipelineLog : [];
  return project;
}

function readProjectish(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  if (raw?.metrics && raw?.project) return raw.project;
  if (raw?.report?.metrics && raw?.project) return raw.project;
  return raw;
}

export function scoreProjectFile(filePath) {
  const project = ensureProjectShape(readProjectish(filePath));
  const metrics = computeMetrics(project);
  const verdict = evaluateThresholds(metrics);
  return { metrics, verdict, source: path.resolve(filePath) };
}

export function compareProjectFiles(beforePath, afterPath) {
  const before = scoreProjectFile(beforePath);
  const after = scoreProjectFile(afterPath);
  return {
    before: before.metrics,
    after: after.metrics,
    comparison: compareMetrics(before.metrics, after.metrics),
    verdict: after.verdict,
  };
}

export async function runRealEvaluation(seedPath, env = process.env, options = {}) {
  if (env.INKWELL_EVAL_CONFIRM !== "YES") {
    throw new Error("真实评测会调用模型并可能产生费用；请显式设置 INKWELL_EVAL_CONFIRM=YES");
  }
  if (!env.INKWELL_API_KEY) throw new Error("缺少 INKWELL_API_KEY");
  if (!seedPath) throw new Error("请提供包含 story bible 与 tasks 的 seed-project.json");
  const project = ensureProjectShape(JSON.parse(fs.readFileSync(path.resolve(seedPath), "utf8")));
  const runtime = loadRuntime({ modelAudit: options.modelAudit || null });
  const defaults = runtime.NOVEL_DEFAULTS;
  const cfg = {
    ...defaults,
    baseUrl: env.INKWELL_BASE_URL || defaults.baseUrl,
    apiKey: env.INKWELL_API_KEY,
    model: env.INKWELL_MODEL || defaults.model || "gemini-3.6-flash",
    temperature: Number.isFinite(Number(env.INKWELL_EVAL_TEMPERATURE))
      ? Number(env.INKWELL_EVAL_TEMPERATURE)
      : undefined,
    seed: Number.isInteger(Number(env.INKWELL_EVAL_SEED)) ? Number(env.INKWELL_EVAL_SEED) : undefined,
    harnessEnabled: true,
    productionEngineEnabled: env.INKWELL_EVAL_PRODUCTION !== "0",
    productionMode: env.INKWELL_EVAL_PRODUCTION_MODE || defaults.productionMode || "chapter",
    productionQualityPolicy: env.INKWELL_EVAL_STRICT === "1" ? "strict" : "warn",
    ragEnabled: true,
    ragUseEmbeddings: env.INKWELL_EVAL_EMBEDDINGS === "1",
    continuityReviewEnabled: true,
    continuityAutoRepair: env.INKWELL_EVAL_AUTO_REPAIR !== "0",
    chapterBeatEnabled: env.INKWELL_EVAL_BEAT !== "0",
    proseLintEnabled: env.INKWELL_EVAL_LINT !== "0",
    continuityReviewPolicy: env.INKWELL_EVAL_STRICT === "1" ? "strict" : "warn",
    chapterTargetWords: Math.max(300, Number(env.INKWELL_EVAL_CHAPTER_TARGET) || defaults.chapterTargetWords || 2000),
    outputReserveTokens: Math.max(512, Number(env.INKWELL_EVAL_OUTPUT_TOKENS) || defaults.outputReserveTokens || 3500),
    productionChapterOutputTokens: Math.max(
      512,
      Number(env.INKWELL_EVAL_OUTPUT_TOKENS) || defaults.productionChapterOutputTokens || defaults.outputReserveTokens || 3500
    ),
    autoChapterDelayMs: 0,
  };
  const maxChapters = Math.max(1, Number(env.INKWELL_EVAL_MAX_CHAPTERS) || 30);
  const pending = project.tasks
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .filter((t) => t.status !== "done")
    .slice(0, maxChapters);
  const runErrors = [];
  for (const task of pending) {
    options.onTaskStart?.(task, project, cfg);
    try {
      await runtime.NOVEL_PIPELINE.autoChapterCycle(project, cfg, task, {
        onStatus: (status) => {
          options.onStatus?.(task, status);
          if (!options.quiet) console.log(`[${task.id}] ${status}`);
        },
        production: cfg.productionEngineEnabled,
      });
      options.onTaskComplete?.(task, project, cfg);
    } catch (error) {
      const failure = { taskId: task.id, code: error?.code || "EVAL_TASK_FAILED", message: error?.message || String(error) };
      runErrors.push(failure);
      options.onTaskError?.(task, error, project, cfg);
      if (!options.continueOnError) throw error;
      if (!options.quiet) console.error(`[${task.id}] ${failure.code}: ${failure.message}`);
    }
  }
  const metrics = computeMetrics(project);
  const verdict = evaluateThresholds(metrics);
  const report = {
    config: {
      model: cfg.model,
      temperature: cfg.temperature ?? null,
      seed: cfg.seed ?? null,
      maxChapters,
      embeddings: cfg.ragUseEmbeddings,
      chapterBeat: cfg.chapterBeatEnabled,
      proseLint: cfg.proseLintEnabled,
      productionEngine: cfg.productionEngineEnabled,
      productionMode: cfg.productionMode,
      qualityPolicy: cfg.productionQualityPolicy,
    },
    errors: runErrors,
    metrics,
    verdict,
  };
  if (env.INKWELL_EVAL_BASELINE) {
    const baseline = scoreProjectFile(env.INKWELL_EVAL_BASELINE);
    report.comparison = compareMetrics(baseline.metrics, metrics);
  }
  const out = path.resolve(env.INKWELL_EVAL_OUT || `inkwell-continuity-eval-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ report, project }, null, 2), "utf8");
  return { out, report, project };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args[0] === "--score") {
      if (!args[1]) throw new Error("用法: node scripts/eval-continuity.mjs --score project.json");
      const scored = scoreProjectFile(args[1]);
      printJson(scored);
      if (!scored.verdict.pass) process.exitCode = 2;
      return;
    }
    if (args[0] === "--compare") {
      if (!args[1] || !args[2]) {
        throw new Error("用法: node scripts/eval-continuity.mjs --compare baseline.json current.json");
      }
      const compared = compareProjectFiles(args[1], args[2]);
      printJson(compared);
      if (!compared.comparison.improved || !compared.verdict.pass) process.exitCode = 2;
      return;
    }
    const result = await runRealEvaluation(args[0]);
    printJson(result.report);
    console.log(`saved: ${result.out}`);
    if (!result.report.verdict.pass) process.exitCode = 2;
  };
  run().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
