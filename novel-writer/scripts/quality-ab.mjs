#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUALITY_SCHEMA_VERSION,
  artifactId,
  buildBlindPacket,
  computeDeterministicMetrics,
  createHumanRatingsTemplate,
  evaluateReleaseGate,
  pairId,
  sha256,
  validateArtifacts,
  validateCorpus,
} from "./quality-eval-core.mjs";
import { runRealEvaluation } from "./eval-continuity.mjs";
import { computeQualitySourceManifest } from "./quality-source-contract.mjs";
import {
  buildPromotionEvidence,
  releaseEvidenceReference,
} from "./quality-release-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const defaultCorpusPath = path.join(root, "evaluation", "corpus-v1.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function option(args, name, fallback = "") {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
}

function flag(args, name) {
  return args.includes(name);
}

function loadCorpus(args) {
  const corpusPath = path.resolve(option(args, "--corpus", defaultCorpusPath));
  const corpus = readJson(corpusPath);
  return { corpus, corpusPath, meta: validateCorpus(corpus) };
}

function ensureOutputDirectory(outputPath, force = false) {
  const resolved = path.resolve(outputPath);
  const rootResolved = path.parse(resolved).root;
  if (resolved === rootResolved || resolved === path.resolve(root)) {
    throw new Error(`refusing unsafe output directory: ${resolved}`);
  }
  if (fs.existsSync(resolved)) {
    const entries = fs.readdirSync(resolved);
    if (entries.length && !force) throw new Error(`output directory is not empty: ${resolved} (use --force)`);
    if (entries.length) fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function taskFor(seed, chapter, chapterIndex) {
  return {
    id: `${seed.id}-t${String(chapterIndex + 1).padStart(2, "0")}`,
    order: chapterIndex + 1,
    chapter_title: chapter.title,
    title: chapter.title,
    goal: chapter.goal,
    conflict: chapter.conflict,
    beats: chapter.beats,
    must_include: chapter.mustInclude,
    must_not: chapter.mustAvoid,
    hook_end: chapter.hookEnd,
    pov: chapter.pov || seed.pov,
    status: "pending",
  };
}

export function materializeProject(seed, protocol) {
  const now = 1_700_000_000_000;
  const tasks = seed.chapters.map((chapter, index) => taskFor(seed, chapter, index));
  return {
    schemaVersion: 1,
    id: `quality-${seed.id}`,
    slug: `quality-${seed.id}`,
    title: seed.title,
    name: seed.title,
    genre: seed.genre,
    pitch: seed.pitch,
    tone: seed.tone,
    createdAt: now,
    updatedAt: now,
    targetChapters: protocol.chaptersPerSeed,
    styleBible: {
      pov: `第三人称限知（${seed.pov}）`,
      pacing: seed.tone,
      dialogue: "对白由人物目的与身份差驱动",
      rules: ["单一 POV", "以动作结果推进因果", "不复述刚发生的事件"],
      forbiddenPhrases: ["心中暗道", "空气仿佛凝固", "嘴角勾起一抹弧度"],
    },
    graph: {
      nodes: seed.cast.map((item, index) => ({
        id: `${seed.id}-n${index + 1}`,
        label: item.name,
        type: "character",
        role: item.role,
        voice: item.voice,
      })),
      edges: [],
    },
    locks: {
      logline: seed.pitch,
      mustHonor: seed.canon,
      forbidden: ["更改锁定专名或数字", "无铺垫改变人物能力"],
    },
    spine: { logline: seed.pitch, theme: "人物选择产生不可逆后果", tasks },
    storyline: { position: "固定八章评测弧", direction: "每章结果成为下一章约束" },
    storyState: { current_location: "", current_time: "开篇", active_conflict: tasks[0].conflict },
    detailCanon: {
      facts: seed.canon.map((fact, index) => ({ id: `${seed.id}-canon-${index + 1}`, text: fact, locked: true })),
      conflicts: [],
    },
    tasks,
    chapters: [],
    memoryRoll: [],
    plotLoops: [],
    continuityIssues: [],
    continuityReviews: [],
    contextManifests: [],
    entityStates: {},
    timelineEvents: [],
    pipelineLog: [],
  };
}

function fitSyntheticBody(parts, targetChars) {
  const sentences = [
    "人物没有停下来解释，而是检查手边能够验证的东西，再承担下一步的代价。",
    "门外的动静逼近，桌面细小的震动先于脚步传来，选择因此只剩下几息。",
    "对话没有给出答案，却改变了双方能做的事；刚刚得到的结果立刻成为新的限制。",
    "他把证据换到另一只手，确认时间、地点和在场者都没有被一句含糊的话抹去。",
    "动作落下之后，局势没有恢复原样，人物只能带着已经发生的后果继续向前。",
    "空气里有潮湿金属的气味，远处机械声一顿，近处的人先作出了可见的反应。",
    "这不是总结，也不是预感；眼前的物件、位置和伤痕把判断钉在了现实里。",
    "每个人都只说对自己有利的部分，剩下的真相必须靠下一次具体行动去换。"
  ];
  let body = parts.filter(Boolean).join("。") + "。";
  let index = 0;
  while (body.length < targetChars * 0.72) {
    body += sentences[index % sentences.length].replace("人物", index % 2 ? "对手" : "当事人");
    index += 1;
  }
  return body;
}

function syntheticBody(seed, task, variant, targetChars) {
  const mustInclude = task.mustInclude || task.must_include || [];
  const hookEnd = task.hookEnd || task.hook_end || "";
  if (variant === "baseline") {
    const repeated = `${seed.pov}看着眼前的一切，心里一沉，却一时没有回答。`;
    return fitSyntheticBody(
      [
        `夜色沉沉，${seed.pov}来到这里，想要${task.goal}`,
        `事情并不顺利，因为${task.conflict}`,
        mustInclude[0],
        repeated.repeat(9),
        "他决定以后再想办法"
      ],
      targetChars
    );
  }
  const openings = [
    `「先看证据。」${seed.pov}把手边的物件推到光下`,
    `${seed.pov}先听见门外骤停的脚步，才抬手压住桌角`,
    `那件不该出现的东西正横在路中央，${seed.pov}没有绕开`,
    `${seed.pov}在对方说完以前已经动手核对第一处痕迹`
  ];
  const beatLines = task.beats.map((beat, index) => `${seed.pov}没有等待旁人替他决定，第${index + 1}次行动直接落在${beat}上`);
  const body = fitSyntheticBody(
    [
      openings[(task.order - 1) % openings.length],
      `正在发生的阻力是${task.conflict}`,
      `他要完成的不是一句愿望，而是${task.goal}`,
      ...mustInclude.map((item) => `可核对的细节“${item}”改变了下一步选择`),
      ...beatLines,
      `前一动作造成的结果没有消失，反而逼出新的具体代价`
    ],
    targetChars
  );
  return `${body}局势最终落到可观察的变化：${hookEnd}。`;
}

function fixturePrompt(seed, task, variant, protocol) {
  return {
    requestId: `${pairId(seed.id, task.order)}-${variant}-write`,
    taskId: task.id,
    stage: "write",
    model: "fixture-model-not-a-real-generation",
    stream: true,
    temperature: protocol.generation.temperature,
    seed: protocol.generation.seed,
    outputTokens: protocol.generation.outputTokens,
    messages: [
      { role: "system", content: variant === "candidate" ? "契约化整章候选写作协议" : "旧 Harness 写作协议" },
      {
        role: "user",
        content: JSON.stringify({ canon: seed.canon, task, tone: seed.tone, provenance: "fixture" }),
      },
    ],
    response: { status: "fixture", chars: 0 },
  };
}

function makeFixtureArtifacts(corpus) {
  const artifacts = [];
  const targetChars = corpus.protocol.generation.chapterTargetChars;
  const previous = { baseline: new Map(), candidate: new Map() };
  for (const seed of corpus.seeds) {
    seed.chapters.forEach((chapter, chapterIndex) => {
      const task = taskFor(seed, chapter, chapterIndex);
      for (const variant of ["baseline", "candidate"]) {
        const body = syntheticBody(seed, task, variant, targetChars);
        const prompt = fixturePrompt(seed, task, variant, corpus.protocol);
        prompt.response.chars = body.length;
        const artifact = {
          schemaVersion: QUALITY_SCHEMA_VERSION,
          artifactId: artifactId(seed.id, chapterIndex + 1, variant),
          pairId: pairId(seed.id, chapterIndex + 1),
          provenance: "fixture",
          seedId: seed.id,
          genre: seed.genre,
          chapterOrder: chapterIndex + 1,
          variant,
          task,
          promptRequests: [prompt],
          contextManifests: [
            {
              schemaVersion: 1,
              taskId: task.id,
              stage: "write",
              authority: ["locked", "continuity", "state", "instruction", "reference"],
              fixture: true,
            },
          ],
          body,
          bodyHash: sha256(body),
          engineCritic:
            variant === "candidate"
              ? { provenance: "fixture-engine-self-critic", verdict: "pass", overall: 8, warning: "not release evidence" }
              : null,
          continuity: { blockers: 0, canonConflicts: 0 },
          localMetrics: computeDeterministicMetrics({
            body,
            task: chapter,
            targetChars,
            previousBody: previous[variant].get(seed.id) || "",
          }),
        };
        previous[variant].set(seed.id, body);
        artifacts.push(artifact);
      }
    });
  }
  return artifacts;
}

function fixtureRatings(corpus, blindKey, provenance, candidateBonus) {
  const assignmentByPair = new Map(blindKey.assignments.map((row) => [row.pairId, row]));
  return blindKey.assignments.map((assignment, index) => {
    const baseline = Object.fromEntries(corpus.rubric.dimensions.map((dimension, dimIndex) => [dimension, 5 + ((index + dimIndex) % 2)]));
    const candidate = Object.fromEntries(
      corpus.rubric.dimensions.map((dimension, dimIndex) => [dimension, Math.min(10, baseline[dimension] + candidateBonus)])
    );
    const current = assignmentByPair.get(assignment.pairId);
    return {
      pairId: assignment.pairId,
      raterId: `${provenance}-${String(index + 1).padStart(2, "0")}`,
      A: current.A === "baseline" ? baseline : candidate,
      B: current.B === "baseline" ? baseline : candidate,
      note: "synthetic calibration score; never release evidence",
    };
  });
}

function persistArtifacts(output, artifacts) {
  for (const artifact of artifacts) {
    writeJson(path.join(output, "artifacts", artifact.seedId, `${artifact.artifactId}.json`), artifact);
  }
  writeJson(path.join(output, "artifacts.json"), artifacts);
}

function baseManifest(corpus, meta, provenance, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const qualitySource = options.qualitySource;
  if (!qualitySource?.fingerprint) throw new Error("quality source manifest is required");
  const model = options.model || null;
  const judgeModel = options.judgeModel || null;
  const identity = {
    provenance,
    corpusId: corpus.id,
    corpusHash: meta.corpusHash,
    qualitySourceFingerprint: qualitySource.fingerprint,
    model,
    judgeModel,
    generatedAt,
  };
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    runId: `${provenance}-${sha256(identity).slice(0, 24)}`,
    provenance,
    corpusId: corpus.id,
    corpusHash: meta.corpusHash,
    protocol: corpus.protocol,
    model,
    judgeModel,
    generatedAt,
    qualitySource,
  };
}

async function fixtureCommand(args) {
  const { corpus, corpusPath, meta } = loadCorpus(args);
  const output = ensureOutputDirectory(option(args, "--out", path.join(root, ".quality", "fixture-v1")), flag(args, "--force"));
  const qualitySource = computeQualitySourceManifest(root);
  const artifacts = makeFixtureArtifacts(corpus);
  const { packet, key } = buildBlindPacket(corpus, artifacts);
  const judgeRatings = fixtureRatings(corpus, key, "fixture-judge", 1);
  const humanRatings = fixtureRatings(corpus, key, "fixture-human", 0.5);
  const runManifest = {
    ...baseManifest(corpus, meta, "fixture", {
      model: "fixture-model-not-a-real-generation",
      judgeModel: "fixture-judge-not-a-real-model",
      generatedAt: "2000-01-01T00:00:00.000Z",
      qualitySource,
    }),
    warning: "Fixture mode validates the experiment machinery only. It is not evidence about prose quality.",
  };
  const report = evaluateReleaseGate({
    corpus,
    runManifest,
    currentQualitySource: computeQualitySourceManifest(root),
    artifacts,
    blindKey: key,
    judgeRatings,
    humanRatings,
    allowFixture: true,
  });
  writeJson(path.join(output, "corpus.json"), corpus);
  writeJson(path.join(output, "run.json"), { ...runManifest, sourceCorpus: path.relative(root, corpusPath).replaceAll("\\", "/") });
  persistArtifacts(output, artifacts);
  writeJson(path.join(output, "blind-packet.json"), packet);
  writeJson(path.join(output, "blind-key.json"), key);
  writeJson(path.join(output, "judge-ratings.json"), { provenance: "fixture", ratings: judgeRatings });
  writeJson(path.join(output, "human-ratings.fixture.json"), { provenance: "fixture", ratings: humanRatings });
  writeJson(path.join(output, "human-ratings.template.json"), createHumanRatingsTemplate(packet));
  writeJson(path.join(output, "report.json"), report);
  console.log(
    JSON.stringify(
      {
        output,
        report: path.join(output, "report.json"),
        runId: runManifest.runId,
        corpusHash: meta.corpusHash,
        qualitySourceFingerprint: runManifest.qualitySource.fingerprint,
        generationSeed: corpus.protocol.generation.seed,
        judgeSeed: corpus.protocol.judge.seed,
        assignmentSeed: corpus.protocol.blind.assignmentSeed,
        artifacts: artifacts.length,
        pairs: packet.pairs.length,
        decision: report.decision,
      },
      null,
      2
    )
  );
}

function modelAuditCollector() {
  let currentTaskId = "";
  let sequence = 0;
  const records = [];
  return {
    setTask(taskId) {
      currentTaskId = taskId || "";
    },
    records,
    onRequest(request) {
      const requestId = `${currentTaskId || "unscoped"}-r${++sequence}`;
      const system = String(request?.messages?.find((message) => message.role === "system")?.content || "");
      const stage = /章节契约|叙事架构师/.test(system)
        ? "contract"
        : /完整章节|整章契约|长篇连载小说作者/.test(system)
          ? "write"
          : /责任编辑|质量|审查整章/.test(system)
            ? "quality-critic"
            : /救稿|修订后的完整章节/.test(system)
              ? "revision"
              : /章后交接|设定管理员/.test(system)
                ? "handoff"
                : /连续性|局部替换/.test(system)
                  ? "continuity"
                  : /细纲|只规划场面/.test(system)
                    ? "planning"
                    : "model";
      records.push({ requestId, taskId: currentTaskId, stage, ...request });
      return requestId;
    },
    onResponse(event) {
      const row = records.find((item) => item.requestId === event.auditId);
      if (row) row.response = { ...event, auditId: undefined };
    },
    onError(event) {
      const row = records.find((item) => item.requestId === event.auditId);
      if (row) row.error = { code: event.code || "MODEL_ERROR", message: event.message || "model request failed" };
    },
  };
}

function chapterForTask(project, task) {
  return (project.chapters || []).find((chapter) => chapter.taskId === task.id || Number(chapter.order) === Number(task.order));
}

function continuityFor(project, chapter, task) {
  const reviews = (project.continuityReviews || []).filter(
    (review) => review.chapterId === chapter?.id || review.taskId === task.id || Number(review.chapterOrder) === Number(task.order)
  );
  const issues = reviews.flatMap((review) => review.issues || []);
  return {
    blockers: issues.filter((issue) => issue.severity === "blocker").length,
    canonConflicts: (project.detailCanon?.conflicts || []).filter(
      (conflict) => !conflict.chapterId || conflict.chapterId === chapter?.id
    ).length,
    reviews,
  };
}

function artifactFromLive({ corpus, seed, task, project, audit, variant, previousBody }) {
  const chapter = chapterForTask(project, task);
  const body = String(chapter?.body || "");
  const contextManifests = (project.contextManifests || []).filter(
    (manifest) => manifest.taskId === task.id || manifest.chapterId === chapter?.id
  );
  const productionManifests = Array.isArray(chapter?.production?.contextManifests)
    ? chapter.production.contextManifests
    : [];
  const prompts = audit.records.filter((record) => record.taskId === task.id);
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    artifactId: artifactId(seed.id, task.order, variant),
    pairId: pairId(seed.id, task.order),
    provenance: "live",
    seedId: seed.id,
    genre: seed.genre,
    chapterOrder: task.order,
    variant,
    task,
    promptRequests: prompts,
    contextManifests: [...contextManifests, ...productionManifests],
    body,
    bodyHash: sha256(body),
    engineCritic: chapter?.production?.qualityReview || chapter?.qualityReview || null,
    continuity: continuityFor(project, chapter, task),
    localMetrics: computeDeterministicMetrics({
      body,
      task: seed.chapters[task.order - 1],
      targetChars: corpus.protocol.generation.chapterTargetChars,
      previousBody,
    }),
    runtime: {
      taskStatus: task.status,
      productionStatus: chapter?.production?.status || null,
      productionStage: chapter?.production?.stage || null,
      handoffStatus: chapter?.handoffStatus || null,
      error: chapter?.production?.errors?.at?.(-1) || null,
    },
  };
}

function cleanBaseUrl(value) {
  let base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("缺少 INKWELL_BASE_URL");
  if (!/\/v1$/i.test(base)) base += "/v1";
  return base;
}

function extractJson(value) {
  let text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

async function judgePair({ corpus, pair, env, index }) {
  const model = env.INKWELL_JUDGE_MODEL || env.INKWELL_MODEL || "gemini-3.6-flash";
  const request = {
    model,
    temperature: corpus.protocol.judge.temperature,
    seed: corpus.protocol.judge.seed + index,
    stream: false,
    max_tokens: 1200,
    messages: [
      {
        role: "system",
        content: `你是独立小说盲评员，不参与任何正文生成。${corpus.rubric.instruction}\n只输出 JSON：{"A":{${corpus.rubric.dimensions
          .map((dimension) => `"${dimension}":0`)
          .join(",")}},"B":{${corpus.rubric.dimensions.map((dimension) => `"${dimension}":0`).join(",")}},"note":"简短证据"}`,
      },
      { role: "user", content: JSON.stringify({ genre: pair.genre, task: pair.task, A: pair.A, B: pair.B }) },
    ],
  };
  const response = await fetch(`${cleanBaseUrl(env.INKWELL_BASE_URL)}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INKWELL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`judge HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const parsed = extractJson(data?.choices?.[0]?.message?.content);
  return {
    prompt: { ...request, responseHash: sha256(data?.choices?.[0]?.message?.content || "") },
    rating: { pairId: pair.pairId, raterId: `model-judge:${model}`, A: parsed.A, B: parsed.B, note: parsed.note || "" },
  };
}

async function liveCommand(args) {
  const env = process.env;
  if (env.INKWELL_EVAL_CONFIRM !== "YES") {
    throw new Error("完整 A/B 会产生大量模型调用；请显式设置 INKWELL_EVAL_CONFIRM=YES");
  }
  if (!env.INKWELL_API_KEY) throw new Error("缺少 INKWELL_API_KEY");
  if (!env.INKWELL_BASE_URL) throw new Error("缺少 INKWELL_BASE_URL");
  const { corpus, corpusPath, meta } = loadCorpus(args);
  const generatedAt = new Date().toISOString();
  const qualitySource = computeQualitySourceManifest(root);
  const model = env.INKWELL_MODEL || "gemini-3.6-flash";
  const judgeModel = env.INKWELL_JUDGE_MODEL || model;
  const output = ensureOutputDirectory(option(args, "--out", path.join(root, ".quality", `live-${Date.now()}`)), flag(args, "--force"));
  const artifacts = [];
  for (const seed of corpus.seeds) {
    for (const variant of ["baseline", "candidate"]) {
      const seedProject = materializeProject(seed, corpus.protocol);
      const inputPath = path.join(output, "inputs", `${seed.id}-${variant}.json`);
      const rawOut = path.join(output, "raw", `${seed.id}-${variant}.json`);
      writeJson(inputPath, seedProject);
      const audit = modelAuditCollector();
      const runEnv = {
        ...env,
        INKWELL_EVAL_OUT: rawOut,
        INKWELL_EVAL_MAX_CHAPTERS: String(corpus.protocol.chaptersPerSeed),
        INKWELL_EVAL_PRODUCTION: variant === "candidate" ? "1" : "0",
        INKWELL_EVAL_PRODUCTION_MODE: variant === "candidate" ? "chapter" : "scene",
        INKWELL_EVAL_TEMPERATURE: String(corpus.protocol.generation.temperature),
        INKWELL_EVAL_SEED: String(corpus.protocol.generation.seed),
        INKWELL_EVAL_CHAPTER_TARGET: String(corpus.protocol.generation.chapterTargetChars),
        INKWELL_EVAL_OUTPUT_TOKENS: String(corpus.protocol.generation.outputTokens),
        INKWELL_EVAL_AUTO_REPAIR: "0",
        INKWELL_EVAL_STRICT: "0",
      };
      const result = await runRealEvaluation(inputPath, runEnv, {
        modelAudit: audit,
        continueOnError: true,
        onTaskStart(task) {
          audit.setTask(task.id);
        },
      });
      let previousBody = "";
      for (const task of result.project.tasks.slice().sort((a, b) => a.order - b.order)) {
        const artifact = artifactFromLive({ corpus, seed, task, project: result.project, audit, variant, previousBody });
        artifacts.push(artifact);
        previousBody = artifact.body;
      }
    }
  }
  const validation = validateArtifacts(corpus, artifacts);
  if (!validation.ok) throw new Error(`live artifacts incomplete:\n${validation.errors.join("\n")}`);
  const { packet, key } = buildBlindPacket(corpus, artifacts);
  const judgeRatings = [];
  for (let index = 0; index < packet.pairs.length; index += 1) {
    const pair = packet.pairs[index];
    console.log(`[judge ${index + 1}/${packet.pairs.length}] ${pair.pairId}`);
    const judged = await judgePair({ corpus, pair, env, index });
    writeJson(path.join(output, "judge-prompts", `${pair.pairId}.json`), judged.prompt);
    judgeRatings.push(judged.rating);
  }
  const runManifest = {
    ...baseManifest(corpus, meta, "live", {
      model,
      judgeModel,
      generatedAt,
      qualitySource,
    }),
  };
  const report = evaluateReleaseGate({
    corpus,
    runManifest,
    currentQualitySource: computeQualitySourceManifest(root),
    artifacts,
    blindKey: key,
    judgeRatings,
    humanRatings: [],
  });
  writeJson(path.join(output, "corpus.json"), corpus);
  writeJson(path.join(output, "run.json"), { ...runManifest, sourceCorpus: path.relative(root, corpusPath).replaceAll("\\", "/") });
  persistArtifacts(output, artifacts);
  writeJson(path.join(output, "blind-packet.json"), packet);
  writeJson(path.join(output, "blind-key.json"), key);
  writeJson(path.join(output, "judge-ratings.json"), { provenance: "live-independent-model", ratings: judgeRatings });
  writeJson(path.join(output, "human-ratings.template.json"), createHumanRatingsTemplate(packet));
  writeJson(path.join(output, "report.json"), report);
  console.log(
    JSON.stringify(
      {
        output,
        report: path.join(output, "report.json"),
        runId: runManifest.runId,
        corpusHash: meta.corpusHash,
        qualitySourceFingerprint: runManifest.qualitySource.fingerprint,
        generationSeed: corpus.protocol.generation.seed,
        judgeSeed: corpus.protocol.judge.seed,
        assignmentSeed: corpus.protocol.blind.assignmentSeed,
        artifacts: artifacts.length,
        pairs: packet.pairs.length,
        decision: report.decision,
      },
      null,
      2
    )
  );
}

function loadRatings(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const data = readJson(filePath);
  return Array.isArray(data) ? data : data.ratings || [];
}

function evaluateRunDirectory(args) {
  const requestedRunDir = option(args, "--run", "");
  if (!requestedRunDir) throw new Error("command requires --run <directory>");
  const runDir = path.resolve(requestedRunDir);
  const corpus = readJson(path.join(runDir, "corpus.json"));
  const runManifest = readJson(path.join(runDir, "run.json"));
  const artifacts = readJson(path.join(runDir, "artifacts.json"));
  const blindKey = readJson(path.join(runDir, "blind-key.json"));
  const judgePath = path.resolve(option(args, "--judge", path.join(runDir, "judge-ratings.json")));
  const defaultHuman = fs.existsSync(path.join(runDir, "human-ratings.json"))
    ? path.join(runDir, "human-ratings.json")
    : path.join(runDir, "human-ratings.fixture.json");
  const humanPath = path.resolve(option(args, "--human", defaultHuman));
  const judgeRatings = loadRatings(judgePath);
  const humanRatings = loadRatings(humanPath);
  const report = evaluateReleaseGate({
    corpus,
    runManifest,
    currentQualitySource: computeQualitySourceManifest(root),
    artifacts,
    blindKey,
    judgeRatings,
    humanRatings,
    allowFixture: flag(args, "--allow-fixture"),
  });
  return { runDir, corpus, runManifest, artifacts, blindKey, judgeRatings, humanRatings, report };
}

async function gateCommand(args) {
  const { runDir, report } = evaluateRunDirectory(args);
  writeJson(path.join(runDir, "report.json"), report);
  console.log(
    JSON.stringify(
      {
        runDir,
        runId: report.runId,
        decision: report.decision,
        releaseEligible: report.releaseEligible,
        qualitySourceFingerprint: report.qualitySourceFingerprint,
        failedChecks: report.checks.filter((row) => !row.ok).map((row) => row.id),
      },
      null,
      2
    )
  );
  if (!report.releaseEligible && report.decision !== "calibration-pass") process.exitCode = 2;
}

async function promoteCommand(args) {
  const evaluated = evaluateRunDirectory(args);
  if (!evaluated.report.releaseEligible || evaluated.report.decision !== "pass") {
    const failed = evaluated.report.checks.filter((row) => !row.ok).map((row) => row.id);
    throw new Error(`promotion refused: quality gate is ${evaluated.report.decision}; failed checks: ${failed.join(", ")}`);
  }
  const evidence = buildPromotionEvidence(evaluated);
  const output = path.resolve(
    option(args, "--out", path.join(root, "evaluation", "approved-quality-release.json"))
  );
  if (fs.existsSync(output) && !flag(args, "--force")) {
    throw new Error(`promotion evidence already exists: ${output} (use --force to replace it)`);
  }
  writeJson(path.join(evaluated.runDir, "report.json"), evaluated.report);
  writeJson(output, evidence);
  console.log(
    JSON.stringify(
      {
        output,
        decision: "pass",
        qualitySourceFingerprint: evidence.run.qualitySource.fingerprint,
        releaseReference: releaseEvidenceReference(evidence),
      },
      null,
      2
    )
  );
}

async function blindCommand(args) {
  const requestedRunDir = option(args, "--run", "");
  if (!requestedRunDir) throw new Error("blind requires --run <directory>");
  const runDir = path.resolve(requestedRunDir);
  const corpus = readJson(path.join(runDir, "corpus.json"));
  const artifacts = readJson(path.join(runDir, "artifacts.json"));
  const { packet, key } = buildBlindPacket(corpus, artifacts);
  writeJson(path.join(runDir, "blind-packet.json"), packet);
  writeJson(path.join(runDir, "blind-key.json"), key);
  writeJson(path.join(runDir, "human-ratings.template.json"), createHumanRatingsTemplate(packet));
  console.log(JSON.stringify({ runDir, pairs: packet.pairs.length }, null, 2));
}

function usage() {
  return `Inkwell quality A/B\n\n` +
    `  node scripts/quality-ab.mjs fixture --out <dir>\n` +
    `  node scripts/quality-ab.mjs live --out <dir>\n` +
    `  node scripts/quality-ab.mjs blind --run <dir>\n` +
    `  node scripts/quality-ab.mjs gate --run <dir> [--human ratings.json]\n` +
    `  node scripts/quality-ab.mjs promote --run <dir> [--out approved.json]\n\n` +
    `live requires INKWELL_EVAL_CONFIRM=YES, INKWELL_BASE_URL and INKWELL_API_KEY.\n` +
    `fixture is deterministic protocol calibration and can never enable a release.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const run =
    command === "fixture"
      ? fixtureCommand(args)
      : command === "live"
        ? liveCommand(args)
        : command === "gate"
          ? gateCommand(args)
          : command === "promote"
            ? promoteCommand(args)
          : command === "blind"
              ? blindCommand(args)
              : Promise.reject(new Error(usage()));
  run.catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
