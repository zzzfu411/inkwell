import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureUrl = new URL("../../../novel-writer/tests/fixtures/http-contract/v2.json", import.meta.url);
const contract = JSON.parse(await readFile(fileURLToPath(fixtureUrl), "utf8"));

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

const baseUrl = argument("base-url", process.env.INKWELL_CONTRACT_BASE_URL || "").replace(/\/$/, "");
const backend = argument("backend", process.env.INKWELL_CONTRACT_BACKEND || "unknown");
const token = argument("token", process.env.INKWELL_CONTRACT_TOKEN || "");
if (!baseUrl) throw new Error("--base-url is required");

function valueAt(value, path) {
  return String(path)
    .split(".")
    .reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function requireFields(body, fields, label) {
  for (const path of fields || []) {
    assert.notEqual(valueAt(body, path), undefined, `${label}: missing ${path}`);
  }
}

function route(name, values = {}) {
  const spec = contract.endpoints[name];
  assert.ok(spec, `unknown endpoint fixture ${name}`);
  let path = spec.path;
  for (const [key, value] of Object.entries(values)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  }
  return { ...spec, path };
}

async function request(spec, body, { authenticate = true } = {}) {
  const headers = { Accept: "application/json", Origin: baseUrl };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticate && token) headers["X-Mogao-Token"] = token;
  const response = await fetch(`${baseUrl}${spec.path}`, {
    method: spec.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${backend}/${spec.method} ${spec.path}: non-JSON response ${response.status}: ${text}`);
  }
  return { response, data };
}

async function expectEndpoint(name, values, body) {
  const spec = route(name, values);
  const result = await request(spec, body);
  assert.equal(result.response.status, spec.status, `${backend}/${name}: status`);
  requireFields(result.data, spec.required, `${backend}/${name}`);
  return result.data;
}

async function expectError(spec, expected, body, options) {
  const { response, data } = await request(spec, body, options);
  assert.equal(response.status, expected.status, `${backend}/${spec.method} ${spec.path}: error status`);
  requireFields(data, contract.errors.required, `${backend}/${spec.method} ${spec.path}`);
  assert.equal(data.ok, false, `${backend}/${spec.method} ${spec.path}: ok must be false`);
  assert.equal(data.error.code, expected.code, `${backend}/${spec.method} ${spec.path}: error code`);
  assert.equal(data.error.status, expected.status, `${backend}/${spec.method} ${spec.path}: embedded status`);
  return data;
}

const health = await expectEndpoint("health");
assert.equal(health.ok, true);
assert.equal(health.app, "mogao");
assert.equal(health.version, contract.productVersion);
assert.equal(typeof health.epoch, "number");
assert.equal(health.engine, backend === "rust" ? "tauri-rust" : "python-debug");

if (backend === "rust") {
  await expectError(route("library"), contract.errors.unauthorized, undefined, { authenticate: false });
}

let library = await expectEndpoint("library");
assert.ok(Array.isArray(library.books));

const uniqueTitle = `${contract.scenario.title}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const created = await expectEndpoint("createBook", {}, { title: uniqueTitle, idea: contract.scenario.idea });
const slug = created.slug;
assert.ok(slug, `${backend}/createBook: empty slug`);

const chapter = {
  ...contract.scenario.chapter,
  updatedAt: Date.now(),
};
const initialProject = {
  ...created,
  schemaVersion: 1,
  title: uniqueTitle,
  chapters: [chapter],
  activeChapterId: chapter.id,
  tasks: [],
  clearChapters: true,
  updatedAt: Date.now(),
};
const firstSave = await expectEndpoint("saveBook", { slug }, initialProject);
assert.deepEqual(firstSave.saveWarnings, [], `${backend}/first save warnings`);
assert.equal(firstSave.chapterBaselines.length, 1, `${backend}/first save baseline count`);
requireFields(firstSave.chapterBaselines[0], contract.concurrency.baselineFields, `${backend}/chapter baseline`);

const loaded = await expectEndpoint("loadBook", { slug });
const loadedChapter = loaded.chapters.find((item) => item.id === chapter.id);
assert.ok(loadedChapter?._file, `${backend}/loadBook: chapter file baseline missing`);
assert.equal(typeof loadedChapter._fileMtime, "number", `${backend}/loadBook: chapter mtime baseline missing`);
assert.equal(loadedChapter.body.trim(), chapter.body);

const secondSave = await expectEndpoint("saveBook", { slug }, loaded);
assert.deepEqual(secondSave.saveWarnings, [], `${backend}/repeat save must not fake a conflict`);

const watchBefore = await expectEndpoint("watch", { slug });
assert.equal(typeof watchBefore.files, "object");
await new Promise((resolve) => setTimeout(resolve, 30));

const externalUpdatedAt = Date.now();
const externalMarkdown = `---\nid: "${chapter.id}"\ntaskId: ""\ntitle: "${chapter.title}"\norder: 1\nupdatedAt: ${externalUpdatedAt}\n---\n\n${contract.scenario.externalBody}\n`;
const beforeExternal = await expectEndpoint("readFile", { slug, file: loadedChapter._file });
await expectEndpoint("writeFile", { slug }, { path: loadedChapter._file, content: externalMarkdown, expectedRevision: beforeExternal.revision });
const watchAfter = await expectEndpoint("watch", { slug });
assert.ok(watchAfter.epoch >= watchBefore.epoch, `${backend}/watch: epoch regressed`);
assert.equal(typeof watchAfter.files[loadedChapter._file], "number", `${backend}/watch: chapter missing`);

const staleLocal = structuredClone(loaded);
const staleChapter = staleLocal.chapters.find((item) => item.id === chapter.id);
staleChapter.body = contract.scenario.localBody;
staleChapter.updatedAt = Date.now();
staleLocal.updatedAt = Date.now();
const conflictSave = await expectEndpoint("saveBook", { slug }, staleLocal);
assert.ok(
  conflictSave.saveWarnings.some((warning) => warning?.kind === contract.concurrency.warningKind),
  `${backend}/saveBook: stale baseline did not return ${contract.concurrency.warningKind}`
);

const reloaded = await expectEndpoint("reloadBook", { slug }, {});
const reloadedChapter = reloaded.chapters.find((item) => item.id === chapter.id);
assert.equal(reloadedChapter.body.trim(), contract.scenario.externalBody, `${backend}/reloadBook: disk body was overwritten`);
const file = await expectEndpoint("readFile", { slug, file: loadedChapter._file });
assert.ok(file.content.includes(contract.scenario.externalBody), `${backend}/readFile: external body missing`);

await expectError(route("writeFile", { slug }), { status: 409, code: "FILE_CONFLICT" }, {
  path: loadedChapter._file, content: "stale file", expectedRevision: beforeExternal.revision,
});
await expectError(route("writeFile", { slug }), { status: 428, code: "REVISION_REQUIRED" }, {
  path: loadedChapter._file, content: "missing baseline",
});
const metadataA = await expectEndpoint("loadBook", { slug });
const metadataB = structuredClone(metadataA);
metadataB.locks.logline = "concurrent metadata winner";
await expectEndpoint("saveBook", { slug }, metadataB);
metadataA.chapters[0].body = "stale book writer";
await expectError(route("saveBook", { slug }), { status: 409, code: "BOOK_CONFLICT" }, metadataA);
const clear = await expectEndpoint("loadBook", { slug });
assert.equal(clear.locks.logline, "concurrent metadata winner");
assert.equal(clear.chapters[0].body.trim(), contract.scenario.externalBody);
clear.chapters[0].body = "";
await expectEndpoint("saveBook", { slug }, clear);
assert.equal((await expectEndpoint("loadBook", { slug })).chapters[0].body, "");

await expectError(route("saveBook", { slug }), contract.errors.invalidRequest, ["not", "an", "object"]);
await expectError(
  route("loadBook", { slug: `missing-${Date.now()}` }),
  contract.errors.notFound
);

library = await expectEndpoint("library");
assert.ok(library.books.some((book) => book.slug === slug), `${backend}/library: created book missing`);
await expectEndpoint("deleteBook", { slug });
await expectError(route("loadBook", { slug }), contract.errors.notFound);

console.log(`backend_contract: ${backend} OK (contract v${contract.contractVersion})`);
