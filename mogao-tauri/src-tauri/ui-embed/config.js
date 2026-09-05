/* 默认对接 OpenAI 兼容接口。请在设置中填写 Base URL 与 API Key。 */
window.NOVEL_APP_VERSION = "0.19.0";
const qualityRelease = window.NOVEL_QUALITY_RELEASE || {};
window.NOVEL_DEFAULTS = {
  baseUrl: "",
  /* 请在设置中填写 API Key，勿把真实 key 提交进仓库 */
  apiKey: "",
  model: "gemini-3.6-flash",
  /**
   * 写章上下文预算（字符近似）。
   * 需容纳：锁定+故事线+canon+RAG命中+上章文末+任务。
   * 反代建议 14k–18k。
   */
  contextBudgetChars: 16000,
  /** 写章输入预算的保守 token 估算上限；与字符上限同时生效 */
  contextBudgetTokens: 12000,
  /** 为约 2000 字正文及上游包装预留，不计入输入装配 */
  outputReserveTokens: 3500,
  /** 启用写章 Harness（Retrieve→Write→Handoff→Reindex） */
  harnessEnabled: true,
  /**
   * 候选叙事生产编排器：章节契约 → 整章连贯起草 → 语义批评 → 定向救稿 → 验收。
   * 默认值只能由固定语料的真实 A/B 发布结论开启；用户仍可手动试用候选引擎。
   */
  productionEngineEnabled: qualityRelease.productionDefaultEnabled === true,
  /** 默认整章连贯起草；scene 仅作为旧书/低上下文模型的兼容回退。 */
  productionMode: "chapter",
  /** plan/quality 的失败策略；strict 会阻止低质量正文进入 done */
  productionPlanPolicy: "strict",
  productionQualityPolicy: "strict",
  /** 质量闸门至少允许一次整章救稿；0 表示只审查不自动修订 */
  productionMaxRevisionPasses: 1,
  productionMinQualityScore: 7,
  productionMinSceneCoverage: 0.75,
  productionMinLengthRatio: 0.55,
  productionSceneContextChars: 10000,
  productionCriticBodyChars: 14000,
  /** 普通“续写/生成”完成后也自动写回摘要/设定/索引 */
  manualAutoHandoff: true,
  /** 章后交接前调用独立连续性审查器 */
  continuityReviewEnabled: true,
  /** 仅应用 search 唯一命中的局部补丁；可在设置关闭 */
  continuityAutoRepair: true,
  /** 写前先出本章细纲，再按场次写 */
  chapterBeatEnabled: true,
  /** warn=细纲失败仍写；strict=细纲失败停止 */
  chapterBeatPolicy: "warn",
  /** 写后检查套话/撞开场，记入连续性风险 */
  proseLintEnabled: true,
  /** warn=记录问题后交接；strict=blocker 未解决时停止交接 */
  continuityReviewPolicy: "warn",
  /** 启用本地混合 RAG */
  ragEnabled: true,
  /** warn=检索失败时明显告警后继续；strict=有历史正文时阻止无检索裸写 */
  ragFailurePolicy: "warn",
  /** 可选：经反代 /v1/embeddings 做向量重排（失败自动回退 BM25） */
  ragUseEmbeddings: false,
  embeddingModel: "text-embedding-004",
  ragTopK: 8,
  ragMaxChars: 3200,
  /** embeddings 模式的宽候选池：词法命中 + 权威记忆 + 相邻正文 */
  ragDenseCandidateK: 48,
  /** 续写时带上的「本章已写」正文尾部字数 */
  bodyTailChars: 2800,
  /** 写新章时带上的「上一章文末」字数（连贯性关键） */
  prevChapterTailChars: 1800,
  /** 滚动摘要条数（富字段） */
  memoryDepth: 12,
  /** 写章 prompt 中注入的锁定细节条数上限 */
  canonMaxFactsInPrompt: 36,
  /** 每章目标字数 */
  chapterTargetWords: 2000,
  /** 自动连写时章间暂停 ms（反代限流时可加大） */
  autoChapterDelayMs: 1200,
  /** Debounce whole-book disk writes while typing. */
  autosaveDelayMs: 1200,
  /** 界面主题：soft-paper | ink-night | qing-jian */
  theme: "soft-paper",
};
