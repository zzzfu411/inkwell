import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const scripts = [...html.matchAll(/<script src="([^"]+\.js)"/g)].map((match) => match[1]);
const sandbox = { window: {} };
vm.runInNewContext(read("composition-contract.js"), sandbox, { filename: "composition-contract.js" });
const Contract = sandbox.window.NOVEL_COMPOSITION_CONTRACT;
assert.equal(Contract.schemaVersion, 1);

const descriptors = Array.from(Contract.modules);
assert.deepEqual(
  descriptors.map((entry) => entry.file),
  scripts,
  "composition contract and index.html must describe the same ordered scripts"
);

for (const entry of descriptors) {
  const source = read(entry.file);
  const provides = [
    ...new Set([...source.matchAll(/window\.(NOVEL_[A-Z0-9_]+)\s*=/g)].map((match) => match[1])),
  ].sort();
  const references = [
    ...new Set([...source.matchAll(/window\.(NOVEL_[A-Z0-9_]+)/g)].map((match) => match[1])),
  ];
  const uses = references.filter((name) => !provides.includes(name)).sort();
  const declared = [...entry.requires, ...entry.deferred, ...entry.optional, ...entry.external].sort();
  assert.deepEqual(provides, Array.from(entry.provides).sort(), `${entry.file} provider contract drifted`);
  assert.deepEqual(uses, declared, `${entry.file} must classify every NOVEL_* dependency`);
}

const structural = Contract.validateModules(Contract.modules);
assert.equal(structural.ok, true, Array.from(structural.errors).join("\n"));

const duplicateProvider = descriptors.concat({
  file: "duplicate.js",
  provides: ["NOVEL_API"],
  requires: [],
  deferred: [],
  optional: [],
  external: [],
});
assert.equal(Contract.validateModules(duplicateProvider).ok, false);

const reversedDependency = [
  { file: "consumer.js", provides: [], requires: ["NOVEL_LATE"], deferred: [], optional: [], external: [] },
  { file: "provider.js", provides: ["NOVEL_LATE"], requires: [], deferred: [], optional: [], external: [] },
];
assert.equal(Contract.validateModules(reversedDependency).ok, false);

const allGlobals = {};
for (const entry of descriptors) {
  for (const name of entry.provides) allGlobals[name] = {};
}
assert.equal(Contract.assertBeforeEntrypoint("app.js", allGlobals), true);
assert.equal(Contract.assertComplete(allGlobals), true);

const missing = { ...allGlobals };
delete missing.NOVEL_API;
assert.throws(
  () => Contract.assertBeforeEntrypoint("app.js", missing),
  (error) => error?.code === "COMPOSITION_CONTRACT_INVALID" && error.details.some((item) => item.includes("NOVEL_API"))
);

console.log("test_composition_contract: OK");
