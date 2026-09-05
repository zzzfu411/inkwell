import crypto from "node:crypto";
import {
  compareQualitySourceManifests,
  validateQualitySourceManifest,
} from "./quality-source-contract.mjs";

export const QUALITY_SCHEMA_VERSION = 1;
export const VARIANTS = Object.freeze(["baseline", "candidate"]);

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function median(values) {
  const ordered = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

export function mean(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function unique(values) {
  return [...new Set(values)];
}

export function validateCorpus(corpus) {
  const errors = [];
  if (corpus?.schemaVersion !== QUALITY_SCHEMA_VERSION) errors.push("corpus.schemaVersion must be 1");
  if (!corpus?.id) errors.push("corpus.id is required");
  const seeds = Array.isArray(corpus?.seeds) ? corpus.seeds : [];
  if (seeds.length < 6 || seeds.length > 10) errors.push("corpus must contain 6-10 seeds");
  const requiredChapters = Number(corpus?.protocol?.chaptersPerSeed) || 8;
  if (requiredChapters !== 8) errors.push("release protocol requires exactly 8 chapters per seed");
  if (unique(seeds.map((seed) => seed.id)).length !== seeds.length) errors.push("seed ids must be unique");
  for (const seed of seeds) {
    if (!seed?.id || !seed?.genre || !seed?.title || !seed?.pov) errors.push(`seed ${seed?.id || "?"} lacks identity fields`);
    const chapters = Array.isArray(seed?.chapters) ? seed.chapters : [];
    if (chapters.length !== requiredChapters) errors.push(`seed ${seed?.id || "?"} must contain ${requiredChapters} chapters`);
    chapters.forEach((chapter, index) => {
      for (const field of ["title", "goal", "conflict", "hookEnd"]) {
        if (!String(chapter?.[field] || "").trim()) errors.push(`${seed?.id}.chapters[${index}].${field} is required`);
      }
      if (!Array.isArray(chapter?.beats) || chapter.beats.length < 2) errors.push(`${seed?.id}.chapters[${index}].beats needs >=2 items`);
      if (!Array.isArray(chapter?.mustInclude) || chapter.mustInclude.length < 2) {
        errors.push(`${seed?.id}.chapters[${index}].mustInclude needs >=2 items`);
      }
    });
  }
  const dimensions = corpus?.rubric?.dimensions || [];
  const keyDimensions = corpus?.protocol?.release?.keyDimensions || [];
  for (const dimension of keyDimensions) {
    if (!dimensions.includes(dimension)) errors.push(`key dimension is absent from rubric: ${dimension}`);
  }
  if (errors.length) {
    const error = new Error(`quality corpus invalid:\n- ${errors.join("\n- ")}`);
    error.code = "QUALITY_CORPUS_INVALID";
    error.errors = errors;
    throw error;
  }
  return {
    seedCount: seeds.length,
    pairCount: seeds.length * requiredChapters,
    artifactCount: seeds.length * requiredChapters * VARIANTS.length,
    corpusHash: sha256(corpus),
  };
}

function normalized(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function phraseBigrams(value) {
  const chars = [...normalized(value)];
  if (chars.length < 2) return chars;
  return unique(chars.slice(0, -1).map((char, index) => char + chars[index + 1]));
}

function phraseObserved(body, phrase) {
  const source = normalized(body);
  const target = normalized(phrase);
  if (!target) return true;
  if (source.includes(target)) return true;
  const grams = phraseBigrams(target);
  if (!grams.length) return source.includes(target);
  return grams.filter((gram) => source.includes(gram)).length / grams.length >= 0.55;
}

function coverage(body, phrases) {
  const list = Array.isArray(phrases) ? phrases.filter(Boolean) : [];
  if (!list.length) return 1;
  return list.filter((phrase) => phraseObserved(body, phrase)).length / list.length;
}

function repeatedNgramRate(body, size = 12) {
  const source = normalized(body);
  if (source.length < size * 2) return 0;
  const counts = new Map();
  for (let index = 0; index <= source.length - size; index += 1) {
    const gram = source.slice(index, index + size);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const repeated = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return total ? repeated / total : 0;
}

function dialogueRate(body) {
  const value = String(body || "");
  const quoted = [...value.matchAll(/[「“"]([^」”"]+)[」”"]/g)].reduce((sum, match) => sum + match[1].length, 0);
  return value.length ? quoted / value.length : 0;
}

function openingCollision(body, previousBody) {
  if (!previousBody) return 0;
  const left = normalized(body).slice(0, 18);
  const right = normalized(previousBody).slice(0, 18);
  if (!left || !right) return 0;
  const grams = phraseBigrams(left);
  return grams.length ? grams.filter((gram) => right.includes(gram)).length / grams.length : 0;
}

/**
 * Reproducible surface signals only. These are deliberately not named "quality score": causal
 * logic, voice and POV require an independent judge or a human reader.
 */
export function computeDeterministicMetrics({ body, task = {}, targetChars = 1400, previousBody = "" } = {}) {
  const text = String(body || "").trim();
  const lengthRatio = targetChars > 0 ? text.length / targetChars : 0;
  const blockers = [];
  if (!text) blockers.push("empty-body");
  if (lengthRatio < 0.45) blockers.push("severely-short");
  if (/^(?:#{1,6}\s|第[一二三四五六七八九十\d]+章\s|场面\s*[一二三四五六\d]+\s*[:：])/m.test(text)) {
    blockers.push("meta-label-in-body");
  }
  return {
    chars: text.length,
    lengthRatio,
    mustIncludeCoverage: coverage(text, task.mustInclude),
    beatAnchorCoverage: coverage(text, task.beats),
    hookCoverage: phraseObserved(text.slice(-Math.max(240, Math.round(text.length * 0.25))), task.hookEnd) ? 1 : 0,
    dialogueRate: dialogueRate(text),
    repeatedNgramRate: repeatedNgramRate(text),
    openingCollision: openingCollision(text, previousBody),
    blockers,
  };
}

export function pairId(seedId, chapterOrder) {
  return `${seedId}__ch${String(chapterOrder).padStart(2, "0")}`;
}

export function artifactId(seedId, chapterOrder, variant) {
  return `${pairId(seedId, chapterOrder)}__${variant}`;
}

function artifactByPair(artifacts) {
  const pairs = new Map();
  for (const artifact of artifacts || []) {
    const key = artifact.pairId || pairId(artifact.seedId, artifact.chapterOrder);
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[artifact.variant] = artifact;
  }
  return pairs;
}

function containsCredentialField(value) {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => /^(?:api[_-]?key|authorization|access[_-]?token)$/i.test(key) || containsCredentialField(nested)
  );
}

export function validateArtifacts(corpus, artifacts) {
  const meta = validateCorpus(corpus);
  const errors = [];
  const ids = new Set();
  const expected = new Set();
  for (const seed of corpus.seeds) {
    seed.chapters.forEach((_, chapterIndex) => {
      for (const variant of VARIANTS) expected.add(artifactId(seed.id, chapterIndex + 1, variant));
    });
  }
  for (const artifact of artifacts || []) {
    const id = artifact?.artifactId;
    if (!id) errors.push("artifact without artifactId");
    if (ids.has(id)) errors.push(`duplicate artifact: ${id}`);
    ids.add(id);
    if (!expected.has(id)) errors.push(`unexpected artifact: ${id}`);
    if (artifact?.schemaVersion !== QUALITY_SCHEMA_VERSION) errors.push(`${id}: schemaVersion must be 1`);
    if (!VARIANTS.includes(artifact?.variant)) errors.push(`${id}: invalid variant`);
    if (!String(artifact?.body || "").trim()) errors.push(`${id}: body is empty`);
    if (artifact?.bodyHash !== sha256(String(artifact?.body || ""))) errors.push(`${id}: bodyHash mismatch`);
    if (!Array.isArray(artifact?.promptRequests) || artifact.promptRequests.length < 1) errors.push(`${id}: promptRequests missing`);
    if (!Array.isArray(artifact?.contextManifests)) errors.push(`${id}: contextManifests missing`);
    if (!artifact?.localMetrics || typeof artifact.localMetrics !== "object") errors.push(`${id}: localMetrics missing`);
    if (containsCredentialField(artifact?.promptRequests || [])) errors.push(`${id}: prompt audit contains credential fields`);
  }
  for (const id of expected) if (!ids.has(id)) errors.push(`missing artifact: ${id}`);
  if ((artifacts || []).length !== meta.artifactCount) {
    errors.push(`artifact count ${(artifacts || []).length} != ${meta.artifactCount}`);
  }
  return { ok: errors.length === 0, errors, expectedCount: meta.artifactCount };
}

export function buildBlindPacket(corpus, artifacts) {
  const validation = validateArtifacts(corpus, artifacts);
  if (!validation.ok) throw Object.assign(new Error(validation.errors.join("\n")), { code: "QUALITY_ARTIFACT_INVALID" });
  const pairs = artifactByPair(artifacts);
  const key = {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    corpusId: corpus.id,
    corpusHash: sha256(corpus),
    assignments: [],
  };
  const packet = {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    corpusId: corpus.id,
    corpusHash: sha256(corpus),
    rubric: corpus.rubric,
    pairs: [],
  };
  for (const seed of corpus.seeds) {
    seed.chapters.forEach((task, chapterIndex) => {
      const id = pairId(seed.id, chapterIndex + 1);
      const pair = pairs.get(id);
      const swap = Number.parseInt(sha256(`${corpus.protocol.blind.assignmentSeed}:${id}`).slice(0, 2), 16) % 2 === 1;
      const aVariant = swap ? "candidate" : "baseline";
      const bVariant = swap ? "baseline" : "candidate";
      key.assignments.push({ pairId: id, A: aVariant, B: bVariant });
      packet.pairs.push({
        pairId: id,
        genre: seed.genre,
        chapterOrder: chapterIndex + 1,
        task: {
          title: task.title,
          goal: task.goal,
          conflict: task.conflict,
          beats: task.beats,
          mustInclude: task.mustInclude,
          mustAvoid: task.mustAvoid,
          hookEnd: task.hookEnd,
          pov: task.pov || seed.pov,
        },
        A: pair[aVariant].body,
        B: pair[bVariant].body,
      });
    });
  }
  return { packet, key };
}

function numericScoreMap(value, dimensions) {
  const result = {};
  for (const dimension of dimensions) {
    const score = Number(value?.[dimension]);
    result[dimension] = Number.isFinite(score) && score >= 1 && score <= 10 ? score : null;
  }
  return result;
}

export function scoreBlindRatings(corpus, ratings, blindKey) {
  const dimensions = corpus.rubric.dimensions;
  const assignments = new Map((blindKey?.assignments || []).map((row) => [row.pairId, row]));
  const rows = [];
  const errors = [];
  for (const rating of ratings || []) {
    const assignment = assignments.get(rating?.pairId);
    if (!assignment) {
      errors.push(`rating has unknown pairId: ${rating?.pairId || "?"}`);
      continue;
    }
    if (!rating?.raterId) errors.push(`${rating.pairId}: raterId is required`);
    const a = numericScoreMap(rating.A, dimensions);
    const b = numericScoreMap(rating.B, dimensions);
    if ([...Object.values(a), ...Object.values(b)].some((value) => value === null)) {
      errors.push(`${rating.pairId}/${rating.raterId || "?"}: all rubric scores must be numbers from 1 to 10`);
      continue;
    }
    const byVariant = assignment.A === "baseline" ? { baseline: a, candidate: b } : { baseline: b, candidate: a };
    const dimensionDeltas = Object.fromEntries(
      dimensions.map((dimension) => [dimension, byVariant.candidate[dimension] - byVariant.baseline[dimension]])
    );
    rows.push({
      pairId: rating.pairId,
      raterId: rating.raterId,
      baseline: byVariant.baseline,
      candidate: byVariant.candidate,
      dimensionDeltas,
      overallDelta: mean(Object.values(dimensionDeltas)),
    });
  }
  const perDimension = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      {
        baselineMedian: median(rows.map((row) => row.baseline[dimension])),
        candidateMedian: median(rows.map((row) => row.candidate[dimension])),
        medianDelta: median(rows.map((row) => row.dimensionDeltas[dimension])),
      },
    ])
  );
  return {
    ok: errors.length === 0,
    errors,
    rows,
    ratedPairs: unique(rows.map((row) => row.pairId)).length,
    ratingsPerPair: Object.fromEntries(
      [...assignments.keys()].map((id) => [id, rows.filter((row) => row.pairId === id).length])
    ),
    medianOverallDelta: median(rows.map((row) => row.overallDelta)),
    perDimension,
  };
}

function aggregateVariant(artifacts, variant) {
  const rows = artifacts.filter((artifact) => artifact.variant === variant);
  const metric = (name) => median(rows.map((artifact) => artifact.localMetrics?.[name]));
  return {
    chapters: rows.length,
    deterministic: {
      lengthRatioMedian: metric("lengthRatio"),
      mustIncludeCoverageMedian: metric("mustIncludeCoverage"),
      beatAnchorCoverageMedian: metric("beatAnchorCoverage"),
      hookCoverageMedian: metric("hookCoverage"),
      dialogueRateMedian: metric("dialogueRate"),
      repeatedNgramRateMedian: metric("repeatedNgramRate"),
      openingCollisionMedian: metric("openingCollision"),
    },
    blockers: rows.reduce(
      (sum, artifact) => sum + (artifact.continuity?.blockers || 0) + (artifact.localMetrics?.blockers?.length || 0),
      0
    ),
    canonConflicts: rows.reduce((sum, artifact) => sum + (artifact.continuity?.canonConflicts || 0), 0),
  };
}

export function aggregateArtifacts(artifacts) {
  return {
    baseline: aggregateVariant(artifacts, "baseline"),
    candidate: aggregateVariant(artifacts, "candidate"),
  };
}

function check(id, ok, actual, expected, detail = "") {
  return { id, ok: Boolean(ok), actual, expected, detail };
}

export function evaluateReleaseGate({
  corpus,
  runManifest,
  currentQualitySource,
  artifacts,
  blindKey,
  judgeRatings = [],
  humanRatings = [],
  allowFixture = false,
} = {}) {
  const corpusMeta = validateCorpus(corpus);
  const artifactValidation = validateArtifacts(corpus, artifacts);
  const aggregates = aggregateArtifacts(artifacts || []);
  const judge = scoreBlindRatings(corpus, judgeRatings, blindKey);
  const human = scoreBlindRatings(corpus, humanRatings, blindKey);
  const policy = corpus.protocol.release;
  const minRatings = Number(corpus.protocol.blind.minHumanRatingsPerPair) || 1;
  const provenance = runManifest?.provenance;
  const sourceValidation = validateQualitySourceManifest(runManifest?.qualitySource);
  const sourceComparison = compareQualitySourceManifests(runManifest?.qualitySource, currentQualitySource);
  const checks = [];
  checks.push(check("live-provenance", provenance === "live" || allowFixture, provenance, "live"));
  checks.push(check("corpus-hash", runManifest?.corpusHash === corpusMeta.corpusHash, runManifest?.corpusHash, corpusMeta.corpusHash));
  checks.push(
    check(
      "quality-source-manifest",
      sourceValidation.ok,
      sourceValidation.errors,
      "complete ordered source manifest with a valid fingerprint"
    )
  );
  checks.push(
    check(
      "quality-source-current",
      sourceComparison.ok,
      { fingerprint: sourceComparison.recorded, errors: sourceComparison.errors },
      currentQualitySource?.fingerprint || "current quality source fingerprint"
    )
  );
  checks.push(check("artifact-completeness", artifactValidation.ok, artifactValidation.errors, `${corpusMeta.artifactCount} valid artifacts`));
  checks.push(
    check(
      "candidate-blockers",
      aggregates.candidate.blockers <= policy.maxCandidateBlockers,
      aggregates.candidate.blockers,
      `<= ${policy.maxCandidateBlockers}`
    )
  );
  checks.push(
    check(
      "candidate-canon-conflicts",
      aggregates.candidate.canonConflicts <= policy.maxCandidateCanonConflicts,
      aggregates.candidate.canonConflicts,
      `<= ${policy.maxCandidateCanonConflicts}`
    )
  );
  checks.push(
    check(
      "deterministic-task-coverage",
      (aggregates.candidate.deterministic.mustIncludeCoverageMedian ?? 0) >=
        (aggregates.baseline.deterministic.mustIncludeCoverageMedian ?? 0),
      {
        baseline: aggregates.baseline.deterministic.mustIncludeCoverageMedian,
        candidate: aggregates.candidate.deterministic.mustIncludeCoverageMedian,
      },
      "candidate >= baseline"
    )
  );
  checks.push(
    check(
      "deterministic-repetition",
      (aggregates.candidate.deterministic.repeatedNgramRateMedian ?? 1) <=
        (aggregates.baseline.deterministic.repeatedNgramRateMedian ?? 1) + 0.01,
      {
        baseline: aggregates.baseline.deterministic.repeatedNgramRateMedian,
        candidate: aggregates.candidate.deterministic.repeatedNgramRateMedian,
      },
      "candidate <= baseline + 0.01"
    )
  );
  checks.push(check("judge-ratings-valid", judge.ok, judge.errors, "valid independent judge ratings"));
  checks.push(check("judge-pair-coverage", judge.ratedPairs === policy.requiredPairs, judge.ratedPairs, policy.requiredPairs));
  checks.push(
    check(
      "judge-median-improvement",
      (judge.medianOverallDelta ?? -Infinity) >= policy.minJudgeMedianDelta,
      judge.medianOverallDelta,
      `>= ${policy.minJudgeMedianDelta}`
    )
  );
  const keyDeltas = policy.keyDimensions.map((dimension) => ({
    dimension,
    delta: judge.perDimension?.[dimension]?.medianDelta,
  }));
  const improvedDimensions = keyDeltas.filter((row) => (row.delta ?? -Infinity) >= policy.minJudgeMedianDelta).length;
  const regressedDimensions = keyDeltas.filter((row) => (row.delta ?? -Infinity) < -policy.maxKeyDimensionRegression);
  checks.push(
    check(
      "judge-key-dimensions",
      improvedDimensions >= policy.minImprovedKeyDimensions && regressedDimensions.length === 0,
      { improvedDimensions, keyDeltas, regressedDimensions },
      `>=${policy.minImprovedKeyDimensions} improved; no delta < -${policy.maxKeyDimensionRegression}`
    )
  );
  checks.push(check("human-ratings-valid", human.ok, human.errors, "valid human blind ratings"));
  const underRatedPairs = Object.entries(human.ratingsPerPair).filter(([, count]) => count < minRatings).map(([id]) => id);
  checks.push(
    check(
      "human-pair-coverage",
      underRatedPairs.length === 0 && human.ratedPairs === policy.requiredPairs,
      { ratedPairs: human.ratedPairs, underRatedPairs },
      `${policy.requiredPairs} pairs with >=${minRatings} rating(s)`
    )
  );
  checks.push(
    check(
      "human-median-non-regression",
      (human.medianOverallDelta ?? -Infinity) >= policy.minHumanMedianDelta,
      human.medianOverallDelta,
      `>= ${policy.minHumanMedianDelta}`
    )
  );
  const passed = checks.every((row) => row.ok);
  const releaseEligible = passed && provenance === "live";
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    decision: releaseEligible ? "pass" : passed && allowFixture ? "calibration-pass" : "hold",
    releaseEligible,
    runId: runManifest?.runId || "",
    corpusId: corpus.id,
    corpusHash: corpusMeta.corpusHash,
    qualitySourceFingerprint: runManifest?.qualitySource?.fingerprint || "",
    provenance,
    model: runManifest?.model || null,
    judgeModel: runManifest?.judgeModel || null,
    generatedAt: runManifest?.generatedAt || null,
    requiredPairs: policy.requiredPairs,
    checks,
    aggregates,
    ratings: { judge, human },
  };
}

export function createHumanRatingsTemplate(packet) {
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    instructions: "复制 pairs 中的 pairId；每位评审填写唯一 raterId，并为 A/B 的全部维度给 1–10 分。不要读取 blind-key.json。",
    ratings: packet.pairs.map((pair) => ({
      pairId: pair.pairId,
      raterId: "",
      A: Object.fromEntries(packet.rubric.dimensions.map((dimension) => [dimension, null])),
      B: Object.fromEntries(packet.rubric.dimensions.map((dimension) => [dimension, null])),
      note: "",
    })),
  };
}
