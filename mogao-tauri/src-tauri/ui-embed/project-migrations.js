/**
 * book.json 的版本化、幂等迁移注册表。
 *
 * 迁移只处理持久化形状；业务状态投影交给 NOVEL_CHAPTER_STATE 修复。
 * 遇到未知更高版本时保持原对象不变并标记只读，旧客户端不得覆盖新格式。
 */
window.NOVEL_PROJECT_MIGRATIONS = (() => {
  "use strict";

  const CURRENT_SCHEMA_VERSION = 1;
  const CURRENT_PRODUCTION_SCHEMA_VERSION = 1;
  const RUNTIME_COMPATIBILITY = "_schemaCompatibility";

  function isObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function parsedVersion(value, fallback = 0) {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function inspect(project) {
    if (!isObject(project)) {
      return { compatible: false, readOnly: true, reason: "作品状态不是对象", code: "INVALID_PROJECT" };
    }
    const projectVersion = parsedVersion(project.schemaVersion, 0);
    if (projectVersion == null) {
      return {
        compatible: false,
        readOnly: true,
        reason: `无法识别作品 schemaVersion: ${String(project.schemaVersion)}`,
        code: "INVALID_SCHEMA_VERSION",
      };
    }
    if (projectVersion > CURRENT_SCHEMA_VERSION) {
      return {
        compatible: false,
        readOnly: true,
        reason: `作品格式 v${projectVersion} 高于当前客户端支持的 v${CURRENT_SCHEMA_VERSION}`,
        code: "FUTURE_PROJECT_SCHEMA",
        projectVersion,
      };
    }
    for (const chapter of Array.isArray(project.chapters) ? project.chapters : []) {
      if (!isObject(chapter?.production)) continue;
      const productionVersion = parsedVersion(chapter.production.schemaVersion, 0);
      if (productionVersion == null) {
        return {
          compatible: false,
          readOnly: true,
          reason: `章节 ${chapter.id || "（无 id）"} 的 production schemaVersion 无法识别`,
          code: "INVALID_PRODUCTION_SCHEMA_VERSION",
          projectVersion,
        };
      }
      if (productionVersion > CURRENT_PRODUCTION_SCHEMA_VERSION) {
        return {
          compatible: false,
          readOnly: true,
          reason: `章节 ${chapter.id || "（无 id）"} 的生产格式 v${productionVersion} 高于当前支持的 v${CURRENT_PRODUCTION_SCHEMA_VERSION}`,
          code: "FUTURE_PRODUCTION_SCHEMA",
          projectVersion,
          productionVersion,
        };
      }
    }
    return { compatible: true, readOnly: false, reason: "compatible", projectVersion };
  }

  function markRuntime(project, compatibility) {
    if (!isObject(project)) return;
    try {
      Object.defineProperty(project, RUNTIME_COMPATIBILITY, {
        value: Object.freeze({ ...compatibility }),
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch (_) {
      // 冻结/代理对象仍可由 compatibility() 现场计算，不依赖运行时标记。
    }
  }

  function migrationAt(options = {}) {
    return Number.isFinite(Number(options.at)) ? Number(options.at) : Date.now();
  }

  function appendHistory(project, entry) {
    project.schemaMigrationHistory = Array.isArray(project.schemaMigrationHistory)
      ? project.schemaMigrationHistory
      : [];
    if (!project.schemaMigrationHistory.some((item) => item?.id === entry.id)) {
      project.schemaMigrationHistory.push(entry);
    }
  }

  function migrateProject0To1(project, options = {}) {
    project.tasks = Array.isArray(project.tasks) ? project.tasks : [];
    project.chapters = Array.isArray(project.chapters) ? project.chapters : [];
    project.pipelineLog = Array.isArray(project.pipelineLog) ? project.pipelineLog : [];
    project.schemaVersion = 1;
    appendHistory(project, {
      id: "project:0->1",
      from: 0,
      to: 1,
      at: migrationAt(options),
    });
  }

  const PROJECT_MIGRATIONS = Object.freeze({ 0: migrateProject0To1 });

  function migrateProduction0To1(chapter, options = {}) {
    const production = chapter?.production;
    if (!isObject(production)) return false;
    production.schemaVersion = 1;
    production.status = String(production.status || "pending");
    production.stage = String(production.stage || "idle");
    production.scenes = Array.isArray(production.scenes) ? production.scenes : [];
    production.errors = Array.isArray(production.errors) ? production.errors : [];
    production.contextManifests = Array.isArray(production.contextManifests)
      ? production.contextManifests
      : [];
    appendHistory(production, {
      id: "production:0->1",
      from: 0,
      to: 1,
      at: migrationAt(options),
    });
    return true;
  }

  function migrateProject(project, options = {}) {
    const initial = inspect(project);
    if (!initial.compatible) {
      markRuntime(project, initial);
      return { project, ...initial, migrated: false, from: initial.projectVersion ?? null, to: null };
    }
    const from = initial.projectVersion;
    let version = from;
    let migrated = false;
    while (version < CURRENT_SCHEMA_VERSION) {
      const migration = PROJECT_MIGRATIONS[version];
      if (typeof migration !== "function") {
        const failure = {
          compatible: false,
          readOnly: true,
          reason: `缺少作品迁移 v${version} → v${version + 1}`,
          code: "MISSING_PROJECT_MIGRATION",
          projectVersion: version,
        };
        markRuntime(project, failure);
        return { project, ...failure, migrated, from, to: version };
      }
      migration(project, options);
      version += 1;
      migrated = true;
    }
    for (const chapter of Array.isArray(project.chapters) ? project.chapters : []) {
      const production = chapter?.production;
      if (!isObject(production)) continue;
      let productionVersion = parsedVersion(production.schemaVersion, 0);
      if (productionVersion === 0) {
        if (migrateProduction0To1(chapter, options)) migrated = true;
        productionVersion = 1;
      }
      if (productionVersion !== CURRENT_PRODUCTION_SCHEMA_VERSION) {
        const failure = {
          compatible: false,
          readOnly: true,
          reason: `章节 ${chapter.id || "（无 id）"} 缺少生产迁移 v${productionVersion} → v${CURRENT_PRODUCTION_SCHEMA_VERSION}`,
          code: "MISSING_PRODUCTION_MIGRATION",
          projectVersion: version,
          productionVersion,
        };
        markRuntime(project, failure);
        return { project, ...failure, migrated, from, to: version };
      }
    }
    const repaired = window.NOVEL_CHAPTER_STATE?.repairProject?.(project) || {
      repaired: 0,
      errors: [],
    };
    if (repaired.repaired) migrated = true;
    const compatibility = {
      compatible: true,
      readOnly: false,
      reason: "compatible",
      code: "OK",
      projectVersion: version,
    };
    markRuntime(project, compatibility);
    return { project, ...compatibility, migrated, from, to: version, repaired };
  }

  function compatibility(project) {
    const runtime = isObject(project?.[RUNTIME_COMPATIBILITY])
      ? project[RUNTIME_COMPATIBILITY]
      : null;
    const current = inspect(project);
    if (!current.compatible) return current;
    return runtime?.readOnly ? runtime : current;
  }

  function isReadOnly(project) {
    return compatibility(project).readOnly === true;
  }

  function assertWritable(project) {
    const result = migrateProject(project);
    if (result.readOnly) {
      const error = new Error(`${result.reason}；请升级 Inkwell 后再编辑或保存`);
      error.code = "SCHEMA_VERSION_UNSUPPORTED";
      error.schema = result;
      throw error;
    }
    const stateResult = window.NOVEL_CHAPTER_STATE?.repairProject?.(project);
    if (stateResult?.errors?.length) {
      const error = new Error(
        `作品状态不一致：${stateResult.errors
          .slice(0, 3)
          .map((item) => `${item.chapterId || "chapter"}: ${item.error}`)
          .join("；")}`
      );
      error.code = "PROJECT_STATE_INVALID";
      error.stateErrors = stateResult.errors;
      throw error;
    }
    return project;
  }

  function filterMigratableProjects(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const incompatible = list.find((project) => compatibility(project).readOnly);
    if (incompatible) {
      return {
        ok: false,
        projects: [],
        reason: `缓存包含当前客户端无法写入的新格式作品《${incompatible.title || incompatible.id || "未命名"}》，已取消迁入`,
      };
    }
    const hasChapterMeta = list.some((project) => (project.chapters || []).length > 0);
    const anyBody = list.some((project) =>
      (project.chapters || []).some((chapter) => String(chapter.body || "").trim())
    );
    if (hasChapterMeta && !anyBody) {
      return { ok: false, projects: [], reason: "缓存已精简无正文，请从 vault 打开书，不要迁入空壳" };
    }
    const projects = list.filter((project) => {
      const chapters = project.chapters || [];
      const hasBody = chapters.some((chapter) => String(chapter.body || "").trim());
      return !((!project.slug && !hasBody) || (chapters.length > 0 && !hasBody));
    });
    return projects.length
      ? { ok: true, projects }
      : { ok: false, projects: [], reason: "缓存已精简无正文，请从 vault 打开书，不要迁入空壳" };
  }

  return {
    CURRENT_SCHEMA_VERSION,
    CURRENT_PRODUCTION_SCHEMA_VERSION,
    PROJECT_MIGRATIONS,
    inspect,
    compatibility,
    isReadOnly,
    migrateProject,
    assertWritable,
    filterMigratableProjects,
  };
})();
