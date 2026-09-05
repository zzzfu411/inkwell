/** 全自动策划 + 短上下文写章流水线 */
window.NOVEL_PIPELINE = (() => {
  const P = () => window.NOVEL_PROMPTS;
  const C = () => window.NOVEL_CONTEXT;
  const API = () => window.NOVEL_API;
  function ChapterState() {
    const state = window.NOVEL_CHAPTER_STATE;
    if (!state) throw new Error("NOVEL_CHAPTER_STATE 未在 pipeline.js 前加载");
    return state;
  }
  const ProductionState = () => window.NOVEL_PRODUCTION_STATE;




  function log(project, msg) {
    if (!Array.isArray(project.pipelineLog)) project.pipelineLog = [];
    project.pipelineLog.push({ t: Date.now(), msg });
    if (project.pipelineLog.length > 200) project.pipelineLog.shift();
  }

  let planningService = null;

  function Planning() {
    const factory = window.NOVEL_PLANNING_SERVICE;
    if (!factory?.create) throw new Error("NOVEL_PLANNING_SERVICE 未在 pipeline.js 前加载");
    if (!planningService) {
      planningService = factory.create({
        getPrompts: P,
        getApi: API,
        log,
      });
    }
    return planningService;
  }

  function runPitch(...args) {
    return Planning().runPitch(...args);
  }

  function runWorld(...args) {
    return Planning().runWorld(...args);
  }

  function runCast(...args) {
    return Planning().runCast(...args);
  }

  function runSpine(...args) {
    return Planning().runSpine(...args);
  }

  function runFullPlan(...args) {
    return Planning().runFullPlan(...args);
  }

  function mergeTasksPreservingProgress(...args) {
    return Planning().mergeTasksPreservingProgress(...args);
  }

  function collectAuthorNameLocks(...args) {
    return Planning().collectAuthorNameLocks(...args);
  }

  function looksLikePersonName(...args) {
    return Planning().looksLikePersonName(...args);
  }

  function applyAuthorNamesToGraph(...args) {
    return Planning().applyAuthorNamesToGraph(...args);
  }

  function applyAuthorNamesToTextFields(...args) {
    return Planning().applyAuthorNamesToTextFields(...args);
  }

  function authorNameConstraintLine(...args) {
    return Planning().authorNameConstraintLine(...args);
  }

  function authorConstraintBlock(...args) {
    return Planning().authorConstraintBlock(...args);
  }

  function joinConstraintBlocks(...args) {
    return Planning().joinConstraintBlocks(...args);
  }

  function planningHasProgress(...args) {
    return Planning().planningHasProgress(...args);
  }

  function normalizeTargetChapters(...args) {
    return Planning().normalizeTargetChapters(...args);
  }

  function ensurePlanningState(...args) {
    return Planning().ensurePlanningState(...args);
  }

  function textSignature(...args) {
    return Planning().textSignature(...args);
  }

  let legacyGenerationAdapter = null;

  function LegacyGeneration() {
    const factory = window.NOVEL_LEGACY_GENERATION_ADAPTER;
    if (!factory?.create) throw new Error("NOVEL_LEGACY_GENERATION_ADAPTER 未在 pipeline.js 前加载");
    if (!legacyGenerationAdapter) {
      legacyGenerationAdapter = factory.create({
        getPrompts: P,
        getContext: C,
        getApi: API,
        getChapterState: ChapterState,
        getProductionState: ProductionState,
        getUid: () => window.NOVEL_STORE.uid(),
        getDefaults: () => window.NOVEL_DEFAULTS || {},
        getCraft: () => window.NOVEL_CRAFT,
        getProductionEngine: () => window.NOVEL_PRODUCTION_ENGINE,
        getHarness: () => window.NOVEL_HARNESS,
        getRag: () => window.NOVEL_RAG,
        getHandoffService: Handoff,
        textSignature,
        log,
      });
    }
    return legacyGenerationAdapter;
  }

  function ensureChapterForTask(...args) {
    return LegacyGeneration().ensureChapterForTask(...args);
  }

  function planChapterBeat(...args) {
    return LegacyGeneration().planChapterBeat(...args);
  }

  function writeOneChapter(...args) {
    return LegacyGeneration().writeOneChapter(...args);
  }

  function autoChapterCycle(...args) {
    return LegacyGeneration().autoChapterCycle(...args);
  }

  function authorSteer(...args) {
    return LegacyGeneration().authorSteer(...args);
  }

  function continueChapter(...args) {
    return LegacyGeneration().continueChapter(...args);
  }

  function applyCraftSignals(...args) {
    return LegacyGeneration().applyCraftSignals(...args);
  }

  function rewritePassage(...args) {
    return LegacyGeneration().rewritePassage(...args);
  }

  function reviseChapter(...args) {
    return LegacyGeneration().reviseChapter(...args);
  }

  let handoffService = null;

  function Handoff() {
    const factory = window.NOVEL_HANDOFF_SERVICE;
    if (!factory?.create) throw new Error("NOVEL_HANDOFF_SERVICE 未在 pipeline.js 前加载");
    if (!handoffService) {
      handoffService = factory.create({
        getPrompts: P,
        getContext: C,
        getApi: API,
        getChapterState: ChapterState,
        getProductionState: ProductionState,
        getCraft: () => window.NOVEL_CRAFT,
        getProductionEngine: () => window.NOVEL_PRODUCTION_ENGINE,
        getRag: () => window.NOVEL_RAG,
        getObservability: () => window.NOVEL_OBSERVABILITY,
        getApplyCraftSignals: () => applyCraftSignals,
        textSignature,
        log,
      });
    }
    return handoffService;
  }

  function digestChapter(...args) {
    return Handoff().digestChapter(...args);
  }

  function extractGraphDelta(...args) {
    return Handoff().extractGraphDelta(...args);
  }

  function reviewChapterContinuity(...args) {
    return Handoff().reviewChapterContinuity(...args);
  }

  function repairChapterContinuity(...args) {
    return Handoff().repairChapterContinuity(...args);
  }

  function reviewAndRepairChapter(...args) {
    return Handoff().reviewAndRepairChapter(...args);
  }

  function repairableIssues(...args) {
    return Handoff().repairableIssues(...args);
  }

  function handoffChapter(...args) {
    return Handoff().handoffChapter(...args);
  }

  function recoverStaleHandoffs(...args) {
    return Handoff().recoverStaleHandoffs(...args);
  }

  function pendingHandoffChapters(...args) {
    return Handoff().pendingHandoffChapters(...args);
  }

  function maybeHandoffAfterRevision(...args) {
    return Handoff().maybeHandoffAfterRevision(...args);
  }

  return {
    runPitch,
    runWorld,
    runCast,
    runSpine,
    runFullPlan,
    mergeTasksPreservingProgress,
    collectAuthorNameLocks,
    looksLikePersonName,
    applyAuthorNamesToGraph,
    applyAuthorNamesToTextFields,
    authorNameConstraintLine,
    authorConstraintBlock,
    joinConstraintBlocks,
    planningHasProgress,
    normalizeTargetChapters,
    ensurePlanningState,
    writeOneChapter,
    planChapterBeat,
    digestChapter,
    extractGraphDelta,
    reviewChapterContinuity,
    repairChapterContinuity,
    reviewAndRepairChapter,
    repairableIssues,
    handoffChapter,
    autoChapterCycle,
    continueChapter,
    rewritePassage,
    reviseChapter,
    recoverStaleHandoffs,
    pendingHandoffChapters,
    applyCraftSignals,
    authorSteer,
    ensureChapterForTask,
    log,
    textSignature,
  };
})();
