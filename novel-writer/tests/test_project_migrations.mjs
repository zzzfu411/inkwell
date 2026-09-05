import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "tests", "fixtures", "projects");
const sandbox = { window: {}, console };
for (const file of ["chapter-state.js", "project-migrations.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: path.join(root, file) });
}
const Migrations = sandbox.window.NOVEL_PROJECT_MIGRATIONS;
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));

assert.equal(Migrations.CURRENT_SCHEMA_VERSION, 1);
assert.equal(Migrations.CURRENT_PRODUCTION_SCHEMA_VERSION, 1);

const legacy = fixture("schema-0-legacy.json");
const first = Migrations.migrateProject(legacy, { at: 123 });
assert.equal(first.readOnly, false);
assert.equal(first.migrated, true);
assert.equal(first.from, 0);
assert.equal(first.to, 1);
assert.equal(legacy.schemaVersion, 1);
assert.equal(legacy.schemaMigrationHistory[0].id, "project:0->1");
assert.equal(legacy.schemaMigrationHistory[0].at, 123);
assert.equal(legacy.chapters[0].production.schemaVersion, 1);
assert.deepEqual(Array.from(legacy.chapters[0].production.scenes), []);
assert.deepEqual(Array.from(legacy.chapters[0].production.errors), []);
assert.equal(legacy.chapters[0].production.schemaMigrationHistory[0].id, "production:0->1");
assert.equal(legacy.tasks[0].status, "done");
assert.equal(legacy.chapters[0].handoffStatus, "done");

const afterFirst = JSON.stringify(legacy);
const second = Migrations.migrateProject(legacy, { at: 999 });
assert.equal(second.migrated, false, "running current migrations twice must be a no-op");
assert.equal(JSON.stringify(legacy), afterFirst, "migration must be byte-stable after the first pass");
assert.equal(Migrations.assertWritable(legacy), legacy);

const current = fixture("schema-1-current.json");
const currentBefore = JSON.stringify(current);
const currentResult = Migrations.migrateProject(current, { at: 123 });
assert.equal(currentResult.migrated, false);
assert.equal(JSON.stringify(current), currentBefore);

const empty = fixture("schema-0-empty.json");
assert.equal(Migrations.migrateProject(empty, { at: 124 }).readOnly, false);
assert.equal(empty.schemaVersion, 1);
assert.deepEqual(Array.from(empty.tasks), []);
assert.deepEqual(Array.from(empty.chapters), []);

const interrupted = fixture("schema-1-interrupted-scene.json");
const interruptedBefore = JSON.stringify(interrupted);
assert.equal(Migrations.migrateProject(interrupted).readOnly, false);
assert.equal(JSON.stringify(interrupted), interruptedBefore, "an interrupted current run must resume byte-for-byte");

const recovery = fixture("schema-0-recovery.json");
const recoveryResult = Migrations.migrateProject(recovery, { at: 125 });
assert.equal(recoveryResult.readOnly, false);
assert.equal(recovery.tasks[0].status, "needs_revision");
assert.equal(recovery.chapters[0].handoffStatus, "stale");
assert.equal(recovery.chapters[0].production.schemaVersion, 1);

const future = fixture("schema-2-future.json");
const futureBefore = JSON.stringify(future);
const futureResult = Migrations.migrateProject(future, { at: 123 });
assert.equal(futureResult.readOnly, true);
assert.equal(futureResult.code, "FUTURE_PROJECT_SCHEMA");
assert.equal(JSON.stringify(future), futureBefore, "future projects must remain untouched");
assert.equal(Migrations.isReadOnly(future), true);
assert.throws(
  () => Migrations.assertWritable(future),
  (error) => error.code === "SCHEMA_VERSION_UNSUPPORTED"
);

const futureProduction = {
  schemaVersion: 1,
  id: "future-production-book",
  tasks: [],
  chapters: [
    {
      id: "future-production-chapter",
      production: { schemaVersion: 2, status: "quantum-accepted", futureField: true },
    },
  ],
};
const futureProductionBefore = JSON.stringify(futureProduction);
const productionResult = Migrations.migrateProject(futureProduction);
assert.equal(productionResult.readOnly, true);
assert.equal(productionResult.code, "FUTURE_PRODUCTION_SCHEMA");
assert.equal(JSON.stringify(futureProduction), futureProductionBefore);

const invalid = { schemaVersion: "banana", chapters: [], tasks: [] };
assert.equal(Migrations.migrateProject(invalid).code, "INVALID_SCHEMA_VERSION");
assert.equal(Migrations.isReadOnly(invalid), true);

const historicalSeed = JSON.parse(
  fs.readFileSync(path.join(root, "samples", "xuanhuan-romance-seed.json"), "utf8")
);
const seedResult = Migrations.migrateProject(historicalSeed, { at: 456 });
assert.equal(seedResult.readOnly, false, "the shipped legacy seed must remain readable");
assert.equal(historicalSeed.schemaVersion, 1);
assert.equal(Migrations.assertWritable(historicalSeed), historicalSeed);

const migratable = Migrations.filterMigratableProjects([
  { schemaVersion: 1, id: "body", slug: "body", chapters: [{ body: "正文" }] },
  { schemaVersion: 1, id: "shell", slug: "shell", chapters: [{ body: "" }] },
]);
assert.equal(migratable.ok, true);
assert.equal(migratable.projects.length, 1);
assert.equal(migratable.projects[0].id, "body");
assert.equal(
  Migrations.filterMigratableProjects([
    { schemaVersion: 1, id: "shell-only", slug: "shell-only", chapters: [{ body: "" }] },
  ]).ok,
  false
);
assert.match(Migrations.filterMigratableProjects([future]).reason, /新格式作品/);

console.log("test_project_migrations: OK");
