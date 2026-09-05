/**
 * Inkwell production quality domain v1.
 *
 * 只接收值与显式 ports，不读取 DOM、存储、网络或浏览器配置。生产引擎负责把
 * craft scorer、上一章查询和默认阈值注入；因此这些指标与放行规则可以独立覆盖、
 * 在 A/B 工具和浏览器运行时之间复用，也不会由编排状态反向“自证”质量。
 */
window.NOVEL_PRODUCTION_QUALITY = (() => {
  "use strict";

  const VERSION = 1;

  function text(value) {
    return String(value ?? "").trim();
  }

  function list(value, limit = 12) {
    const source = Array.isArray(value) ? value : value == null ? [] : [value];
    return source
      .map((item) => (typeof item === "string" ? item : item?.summary || item?.text || item?.value || ""))
      .map(text)
      .filter(Boolean)
      .slice(0, limit);
  }

  function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function coverageTokens(value) {
    const parts = String(value || "")
      .replace(/[\s，。；、·:：/|()（）【】[\]「」“”"'！？!?—-]+/g, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 12);
    const tokens = [];
    for (const part of parts) {
      tokens.push(part);
      if (/^[\u4e00-\u9fff]+$/.test(part) && part.length > 2) {
        for (let index = 0; index < part.length - 1 && tokens.length < 24; index++) {
          tokens.push(part.slice(index, index + 2));
        }
      }
    }
    return tokens.slice(0, 24);
  }

  function anyTokenInBody(value, body) {
    const haystack = String(body || "").replace(/\s+/g, "");
    return coverageTokens(value).some((token) => haystack.includes(token));
  }

  function sceneContractCoverage(body, contract, drafts = null) {
    const scenes = Array.isArray(contract?.scenes) ? contract.scenes : [];
    if (!scenes.length) return { rate: 0, total: 0, covered: 0, missing: [] };
    const rows = scenes.map((scene, index) => {
      const checks = [
        ["action", scene.action || scene.goal],
        ["turn", scene.turn],
        ["outcome", scene.outcome || scene.turn],
      ].filter(([, value]) => text(value));
      const draft = Array.isArray(drafts) ? drafts[index] : null;
      const draftBody = draft && typeof draft === "object" ? text(draft.text) : "";
      const checkBody = draftBody || body;
      const hits = checks.filter(([, value]) => anyTokenInBody(value, checkBody));
      const lexicalRatio = checks.length ? hits.length / checks.length : 1;
      // scene 模式的独立 checkpoint 可以证明该场存在；整章模式只证明契约被消费，
      // 必须继续依赖正文锚点，不能让运行状态给质量结论自签名。
      const generated = Boolean(draft && draft.status === "complete");
      const independentlyCommitted = generated && draft?.ledger?.wholeDraft !== true;
      return {
        index,
        id: scene.id,
        covered: independentlyCommitted || lexicalRatio >= 2 / 3,
        generated,
        ratio: lexicalRatio,
        lexicalRatio,
        missing: checks.filter(([, value]) => !anyTokenInBody(value, checkBody)).map(([key]) => key),
      };
    });
    const coveredRows = rows.filter((row) => row.covered);
    return {
      rate: coveredRows.length / rows.length,
      lexicalRate: rows.filter((row) => row.lexicalRatio >= 2 / 3).length / rows.length,
      structuralRate: rows.filter((row) => row.generated).length / rows.length,
      total: rows.length,
      covered: coveredRows.length,
      missing: rows.filter((row) => !row.covered),
      rows,
    };
  }

  function localQuality(project, task, chapter, contract, cfg = {}, ports = {}) {
    const craftPort = ports.craft;
    const body = text(chapter?.body);
    const plan = typeof ports.contractToBeatPlan === "function" ? ports.contractToBeatPlan(contract) : { scenes: [] };
    const previous = typeof ports.previousChapter === "function" ? ports.previousChapter(project, task) : null;
    const craft = craftPort?.scoreChapterCraft
      ? craftPort.scoreChapterCraft(body, plan, {
          prevBody: previous?.body || "",
          recentKinds: craftPort.recentOpeningKinds?.(project, task, 3) || [],
          styleBible: project?.styleBible,
        })
      : { beatCoverage: { rate: 0, missing: [] }, dialogueRate: 0, sensoryCount: 0, issues: [] };
    const lengthRatio = contract?.wordTarget ? body.length / Number(contract.wordTarget) : 0;
    const sceneCoverage = sceneContractCoverage(body, contract, chapter?.production?.scenes);
    const rawBeatCoverage = craft.beatCoverage || { rate: 0, covered: 0, total: 0, missing: [] };
    const beatCoverage = {
      ...rawBeatCoverage,
      lexicalRate: Number(rawBeatCoverage.rate) || 0,
      rate: Math.max(Number(rawBeatCoverage.rate) || 0, Number(sceneCoverage.rate) || 0),
      structuralRate: Number(sceneCoverage.structuralRate),
    };
    const tailChars = Math.max(240, Math.round(body.length * 0.3));
    const hookPresent = !text(contract?.hookEnd) || anyTokenInBody(contract.hookEnd, body.slice(-tailChars));
    const issues = Array.isArray(craft.issues) ? craft.issues : [];
    const penalty = issues.reduce(
      (sum, issue) => sum + (issue.severity === "major" ? 1.4 : issue.severity === "blocker" ? 2.5 : 0.35),
      0
    );
    return {
      bodyChars: body.length,
      targetChars: Number(contract?.wordTarget) || 0,
      lengthRatio,
      beatCoverage,
      sceneCoverage,
      hookPresent,
      dialogueRate: Number(craft.dialogueRate) || 0,
      sensoryCount: Number(craft.sensoryCount) || 0,
      issues,
      // 本地信号必须保持可解释；语义批评器仍负责主体判断。
      localProseScore: Math.max(0, Math.min(10, 8 - penalty)),
    };
  }

  function normalizeQualityIssue(raw) {
    if (!raw || typeof raw !== "object") return null;
    const summary = text(raw.summary || raw.message || raw.issue);
    if (!summary) return null;
    const severity = ["blocker", "major", "minor", "info"].includes(raw.severity) ? raw.severity : "major";
    return {
      type: text(raw.type || "quality"),
      severity,
      summary: summary.slice(0, 180),
      evidence: text(raw.evidence || raw.quote).slice(0, 300),
      fix: text(raw.fix || raw.suggestion || raw.recommendation).slice(0, 300),
    };
  }

  function normalizeQuality(raw, local, contract, cfg = {}, options = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const inputScores = source.scores && typeof source.scores === "object" ? source.scores : {};
    const keys = ["causalProgression", "characterAgency", "sceneCompletion", "povConsistency", "tension", "voice", "hook", "prose"];
    const scores = {};
    const missingScores = [];
    for (const key of keys) {
      if (!Number.isFinite(Number(inputScores[key]))) missingScores.push(key);
      scores[key] = clamp(inputScores[key], 0, 10, 0);
    }
    if (!scores.sceneCompletion && local?.beatCoverage) {
      scores.sceneCompletion = clamp(Number(local.beatCoverage.rate) * 10, 0, 10, 0);
    }
    if (!scores.prose && local) scores.prose = clamp(local.localProseScore, 0, 10, 0);
    const suppliedOverall = Number(source.overall);
    const overall =
      Number.isFinite(suppliedOverall) && suppliedOverall > 0
        ? clamp(suppliedOverall, 0, 10, 0)
        : Math.round((keys.reduce((sum, key) => sum + scores[key], 0) / keys.length) * 10) / 10;
    let verdict = text(source.verdict).toLowerCase();
    if (!["pass", "revise", "fail"].includes(verdict)) verdict = overall >= 7 ? "pass" : "revise";
    const issues = (Array.isArray(source.issues) ? source.issues : [])
      .map(normalizeQualityIssue)
      .filter(Boolean)
      .slice(0, 16);
    for (const missing of list(source.missing_contract || source.missingContract, 8)) {
      if (!issues.some((issue) => issue.summary.includes(missing))) {
        issues.push({
          type: "contract",
          severity: "major",
          summary: `契约未完成：${missing}`,
          evidence: "",
          fix: `补齐：${missing}`,
        });
      }
    }
    const defaults = options.defaults || {};
    const minCoverage = Number(cfg.productionMinSceneCoverage) || Number(defaults.productionMinSceneCoverage) || 0.75;
    if (local?.beatCoverage && Number(local.beatCoverage.rate) < minCoverage) {
      const missing = local.beatCoverage.missing?.[0];
      const summary = `场面落地不足：${missing?.place || "至少一个契约场面"}`;
      if (!issues.some((issue) => issue.type === "local-coverage")) {
        issues.push({
          type: "local-coverage",
          severity: "major",
          summary,
          evidence: missing?.action || "",
          fix: "补写该场面的动作、转折和结果",
        });
      }
      if (verdict === "pass") verdict = "revise";
    }
    const now = typeof options.now === "function" ? options.now : Date.now;
    return {
      schemaVersion: VERSION,
      verdict,
      overall,
      scores,
      issues,
      completedContract: list(source.completed_contract || source.completedContract, 16),
      missingContract: list(source.missing_contract || source.missingContract, 16),
      strengths: list(source.strengths, 8),
      missingScores,
      local,
      contractId: contract?.id || "",
      at: now(),
    };
  }

  function qualityGate(review, cfg = {}, options = {}) {
    const policy = cfg.productionQualityPolicy === "warn" ? "warn" : "strict";
    const reasons = [];
    if (!review || typeof review !== "object") reasons.push("没有可用的质量报告");
    if (review && review.verdict !== "pass") reasons.push(`批评器结论：${review.verdict}`);
    const defaults = options.defaults || {};
    const minScore = Number(cfg.productionMinQualityScore) || Number(defaults.productionMinQualityScore) || 7;
    if (review && Number(review.overall) < minScore) {
      reasons.push(`综合分 ${Number(review.overall || 0).toFixed(1)} 低于 ${minScore}`);
    }
    if (review && policy === "strict" && Array.isArray(review.missingScores) && review.missingScores.length) {
      reasons.push(`质量报告缺少 ${review.missingScores.length} 项评分`);
    }
    const minCoverage = Number(cfg.productionMinSceneCoverage) || Number(defaults.productionMinSceneCoverage) || 0.75;
    const beatCoverage = Number(review?.local?.beatCoverage?.rate);
    if (Number.isFinite(beatCoverage) && beatCoverage < minCoverage) {
      reasons.push(`场面落地 ${Math.round(beatCoverage * 100)}% 低于 ${Math.round(minCoverage * 100)}%`);
    }
    const sceneCoverage = Number(review?.local?.sceneCoverage?.rate);
    if (Number.isFinite(sceneCoverage) && sceneCoverage < minCoverage) {
      reasons.push(`因果场面完成 ${Math.round(sceneCoverage * 100)}% 低于 ${Math.round(minCoverage * 100)}%`);
    }
    if (review?.local && review.local.hookPresent === false) reasons.push("章末钩子没有在正文结尾落地");
    const minLength = Number(cfg.productionMinLengthRatio) || Number(defaults.productionMinLengthRatio) || 0.55;
    const lengthRatio = Number(review?.local?.lengthRatio);
    if (Number.isFinite(lengthRatio) && lengthRatio > 0 && lengthRatio < minLength) {
      reasons.push(`正文长度仅为目标的 ${Math.round(lengthRatio * 100)}%`);
    }
    const hardIssues = (review?.issues || []).filter((issue) => ["blocker", "major"].includes(issue.severity));
    if (hardIssues.length) reasons.push(`存在 ${hardIssues.length} 条 blocker/major 结构问题`);
    return {
      accepted: policy === "warn" ? Boolean(review) : reasons.length === 0,
      policy,
      reasons,
      hardIssues,
    };
  }

  return Object.freeze({
    VERSION,
    coverageTokens,
    anyTokenInBody,
    sceneContractCoverage,
    localQuality,
    normalizeQualityIssue,
    normalizeQuality,
    qualityGate,
  });
})();
