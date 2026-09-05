import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_SEED = "inkwell-scale-v1-2026-09";
export const SIZES = Object.freeze([20, 100, 400]);
export const BUDGETS = Object.freeze({
  20: {
    maxProjectBytes: 300_000,
    contextBuild: { medianMs: 12, p95Ms: 30 },
    saveSerialize: { medianMs: 8, p95Ms: 20 },
    exportMarkdown: { medianMs: 8, p95Ms: 25 },
    diagnosticsExport: { medianMs: 8, p95Ms: 20 },
  },
  100: {
    maxProjectBytes: 1_500_000,
    contextBuild: { medianMs: 30, p95Ms: 75 },
    saveSerialize: { medianMs: 25, p95Ms: 60 },
    exportMarkdown: { medianMs: 25, p95Ms: 60 },
    diagnosticsExport: { medianMs: 10, p95Ms: 30 },
  },
  400: {
    maxProjectBytes: 6_000_000,
    contextBuild: { medianMs: 60, p95Ms: 120 },
    saveSerialize: { medianMs: 75, p95Ms: 180 },
    exportMarkdown: { medianMs: 80, p95Ms: 200 },
    diagnosticsExport: { medianMs: 15, p95Ms: 50 },
  },
});

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function bodyFor(index) {
  const paragraph = `第${index}章的雨声掠过青石，林玄记住旧约、伤势与尚未偿还的代价。`;
  return Array.from({ length: 30 }, (_, paragraphIndex) => `${paragraph}${paragraphIndex + 1}。`).join("\n");
}

export function createFixture(chapterCount) {
  if (!SIZES.includes(chapterCount)) throw new Error(`unsupported fixture size: ${chapterCount}`);
  const tasks = [];
  const chapters = [];
  const memoryRoll = [];
  for (let index = 1; index <= chapterCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    tasks.push({
      id: `t${suffix}`,
      order: index,
      status: index === chapterCount ? "pending" : "done",
      chapter_title: `第${index}章 回声${suffix}`,
      goal: `推进线索${index % 17}并支付代价${index % 11}`,
      conflict: `阵营${index % 9}阻断证据链`,
      beats: [`抵达节点${index}`, `发现反证${index % 13}`, `作出不可逆选择${index % 7}`],
      must_include: [`旧约${index % 19}`, `伤势${index % 5}`],
      must_not: ["无因果逆转", "重复上一章高潮"],
      hook_end: `线索${(index + 1) % 17}浮出水面`,
      pov: "林玄",
      word_target: 2200,
    });
    chapters.push({
      id: `c${suffix}`,
      taskId: `t${suffix}`,
      order: index,
      title: `第${index}章 回声${suffix}`,
      body: index === chapterCount ? "" : bodyFor(index),
      bodyRevision: 1,
      bodyAuthority: "chapter.body",
      handoffStatus: index === chapterCount ? "empty" : "done",
      production: {
        status: index === chapterCount ? "pending" : "done",
        stage: index === chapterCount ? "idle" : "done",
      },
      updatedAt: 1_788_520_000_000 + index,
    });
    memoryRoll.push({
      chapter: `第${index}章 回声${suffix}`,
      taskId: `t${suffix}`,
      happened: [`线索${index % 17}推进`, `代价${index % 11}生效`],
      new_info: [`阵营${index % 9}留下证据`],
      must_carry: [`旧约${index % 19}仍有效`, `伤势${index % 5}未痊愈`],
      open_loops: [`线索${(index + 1) % 17}待验证`],
      state: `完成节点${index}`,
      location: `地点${index % 23}`,
      timeline: `第${index}日`,
    });
  }
  const activeTask = tasks[tasks.length - 1];
  const activeChapter = chapters[chapters.length - 1];
  return {
    id: `perf_${chapterCount}`,
    slug: `perf-${chapterCount}`,
    schemaVersion: 1,
    title: `性能基线 ${chapterCount} 章`,
    pitch: "以固定证据链验证长篇工程在规模增长时仍保持可交互。",
    tone: "克制悬疑",
    targetChapters: chapterCount,
    activeTaskId: activeTask.id,
    activeChapterId: activeChapter.id,
    tasks,
    chapters,
    memoryRoll,
    runtimeDiagnostics: [],
    locks: {
      logline: "林玄沿证据链偿还旧约，每次胜利都留下可追踪代价。",
      forbidden: ["无代价升级", "失忆式重置"],
      mustHonor: ["伤势连续", "旧约连续", "时间线单向"],
    },
    spine: {
      logline: "证据、旧约与代价组成单向推进的长篇主线。",
      volumes: [{ id: "v1", title: "证据之城", from: 1, to: chapterCount, focus: "追索与偿还" }],
      foreshadow: Array.from({ length: 24 }, (_, index) => ({
        id: `fs${index + 1}`,
        seed: `伏笔${index + 1}`,
        payoff_around: String(Math.min(chapterCount, index * 7 + 8)),
      })),
    },
    world: {
      era: "临川纪",
      power_system: "证据契约",
      rules: ["每个结论必须有证据", "力量变化必须支付代价", "时间不可倒流"],
      factions: Array.from({ length: 12 }, (_, index) => ({ id: `f${index}`, name: `阵营${index}` })),
    },
    graph: {
      nodes: Array.from({ length: 80 }, (_, index) => ({ id: `n${index}`, label: `人物${index}`, role: "support" })),
      edges: Array.from({ length: 120 }, (_, index) => ({
        source: `n${index % 80}`,
        target: `n${(index + 7) % 80}`,
        relationship: `关系${index % 9}`,
      })),
    },
    detailCanon: {
      facts: Array.from({ length: 180 }, (_, index) => ({
        key: `人物${index % 80}.事实${index}`,
        entity: `人物${index % 80}`,
        value: `固定值${index % 31}`,
        category: index % 3 === 0 ? "number" : "relationship",
        locked: true,
        status: "active",
      })),
      conflicts: [],
    },
    storyState: {
      protagonistState: "负伤但保持判断力",
      location: `地点${chapterCount % 23}`,
      timeline: `第${chapterCount}日`,
      powerOrSystem: "证据契约三级",
      establishedFacts: ["旧约仍有效", "伤势未痊愈", "阵营边界已公开"],
      recentHook: `线索${(chapterCount + 1) % 17}待验证`,
    },
    styleBible: {
      pov: "第三人称限知",
      tense: "过去时",
      pacing: "场景内紧、场景间留白",
      dialogue: "短句且带行动意图",
      rules: ["证据先于结论", "动作承担情绪"],
      forbiddenPhrases: ["不由得", "心中暗道"],
    },
  };
}

function loadRuntime() {
  const sandbox = {
    window: {
      NOVEL_APP_VERSION: "0.19.0",
      NOVEL_DEFAULTS: {
        appVersion: "0.19.0",
        contextBudgetChars: 16_000,
        contextBudgetTokens: 12_000,
        bodyTailChars: 2_800,
        prevChapterTailChars: 1_800,
        memoryDepth: 12,
        chapterTargetWords: 2_200,
        canonMaxFactsInPrompt: 36,
      },
    },
    console,
    Date,
    Math,
    Set,
    TextEncoder,
    performance,
  };
  for (const file of [
    "runtime-observability.js",
    "prompts.js",
    "craft.js",
    "memory-reducers.js",
    "context-budget.js",
    "context-evidence.js",
    "context.js",
    "persistence-use-cases.js",
  ]) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, {
      filename: path.join(ROOT, file),
    });
  }
  return sandbox.window;
}

function benchmark(operation, { samples, warmups = 5 }) {
  let sink = null;
  for (let index = 0; index < warmups; index += 1) sink = operation();
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    sink = operation();
    durations.push(performance.now() - startedAt);
  }
  if (sink === Symbol.for("unreachable")) throw new Error("benchmark sink failure");
  return {
    samples,
    medianMs: rounded(percentile(durations, 0.5)),
    p95Ms: rounded(percentile(durations, 0.95)),
    maxMs: rounded(Math.max(...durations)),
  };
}

function sampleCount(chapters, override) {
  if (override) return override;
  if (chapters >= 400) return 20;
  if (chapters >= 100) return 30;
  return 40;
}

export function evaluateResults(results, budgets = BUDGETS) {
  const failures = [];
  for (const result of results) {
    const budget = budgets[result.chapters];
    if (!budget) {
      failures.push(`${result.chapters}: missing budget`);
      continue;
    }
    if (result.projectBytes > budget.maxProjectBytes) {
      failures.push(
        `${result.chapters}: projectBytes ${result.projectBytes} > ${budget.maxProjectBytes}`
      );
    }
    for (const operation of ["contextBuild", "saveSerialize", "exportMarkdown", "diagnosticsExport"]) {
      const actual = result.operations[operation];
      const limit = budget[operation];
      if (actual.medianMs > limit.medianMs) {
        failures.push(
          `${result.chapters}/${operation}: median ${actual.medianMs}ms > ${limit.medianMs}ms`
        );
      }
      if (actual.p95Ms > limit.p95Ms) {
        failures.push(`${result.chapters}/${operation}: p95 ${actual.p95Ms}ms > ${limit.p95Ms}ms`);
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

export function runBenchmarks({ samples = 0 } = {}) {
  const Runtime = loadRuntime();
  const Ctx = Runtime.NOVEL_CONTEXT;
  const Persistence = Runtime.NOVEL_PERSISTENCE_USE_CASES;
  const Obs = Runtime.NOVEL_OBSERVABILITY;
  const results = [];
  for (const chapters of SIZES) {
    const project = createFixture(chapters);
    const fixtureHash = hash(JSON.stringify(project));
    const task = project.tasks[project.tasks.length - 1];
    const count = sampleCount(chapters, samples);
    const operations = {
      contextBuild: benchmark(
        () =>
          Ctx.packForWrite(project, task, {
            autoRag: false,
            budget: 16_000,
            tokenBudget: 12_000,
            memoryDepth: 12,
          }),
        { samples: count }
      ),
      saveSerialize: benchmark(() => JSON.stringify(project), { samples: count }),
      exportMarkdown: benchmark(() => Persistence.buildExportMarkdown(project), { samples: count }),
      diagnosticsExport: benchmark(() => JSON.stringify(Obs.exportReport(project)), { samples: count }),
    };
    const serialized = JSON.stringify(project);
    results.push({
      chapters,
      fixtureHash,
      projectBytes: Buffer.byteLength(serialized),
      operations,
    });
  }
  const evaluation = evaluateResults(results);
  return {
    schemaVersion: 1,
    protocol: "inkwell-performance-budget-v1",
    generatedAt: new Date().toISOString(),
    fixtureSeed: FIXTURE_SEED,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    budgets: BUDGETS,
    results,
    ...evaluation,
  };
}

function parseArgs(argv) {
  let out = path.join(process.cwd(), "output", "performance", "report.json");
  let samples = 0;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") out = path.resolve(argv[++index]);
    else if (argv[index] === "--samples") samples = Math.max(1, Number(argv[++index]) || 0);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return { out, samples };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runBenchmarks({ samples: options.samples });
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const result of report.results) {
    const timings = Object.entries(result.operations)
      .map(([name, value]) => `${name}=${value.medianMs}/${value.p95Ms}ms median/p95`)
      .join(" | ");
    console.log(`${result.chapters} chapters | ${result.projectBytes} bytes | ${timings}`);
  }
  console.log(`fixture seed: ${report.fixtureSeed}`);
  console.log(`report: ${options.out}`);
  if (!report.passed) {
    for (const failure of report.failures) console.error(`BUDGET FAILURE: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("PERFORMANCE BUDGET PASS");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
