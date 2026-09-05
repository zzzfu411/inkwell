/**
 * Quality release decision for the default writing engine.
 *
 * This file is deliberately tiny and reviewable. A candidate engine may exist in the product
 * without becoming the default. Promotion requires a complete live A/B report plus human blind
 * ratings; fixture or model-only results are never release evidence.
 */
window.NOVEL_QUALITY_RELEASE_RECORD = Object.freeze({
  schemaVersion: 2,
  decision: "hold",
  productionDefaultEnabled: false,
  evaluatedReport: null,
  qualitySourceFingerprint: "72db5104bb710a8672f93afca10923f9cd148f2bc42a2c87bae82d21ca417090",
  reason: "等待固定语料的真实 A/B 与人工盲评；整章生产引擎可在设置中手动启用。",
});

const qualityReleasePolicy = window.NOVEL_QUALITY_RELEASE_POLICY;
window.NOVEL_QUALITY_RELEASE = qualityReleasePolicy?.resolve
  ? qualityReleasePolicy.resolve(window.NOVEL_QUALITY_RELEASE_RECORD)
  : Object.freeze({
      schemaVersion: 2,
      decision: "hold",
      productionDefaultEnabled: false,
      evaluatedReport: null,
      qualitySourceFingerprint: "",
      reason: "质量发布策略未加载，已安全回退到旧 Harness。",
      policyErrors: ["NOVEL_QUALITY_RELEASE_POLICY missing"],
    });
