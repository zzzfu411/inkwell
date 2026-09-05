/** 作品状态：内存 + localStorage 缓存 + 本地 vault 权威存储 */
window.NOVEL_STORE = (() => {
  const KEY = "mogao_auto_novel_v2";
  const CFG = "mogao_novel_cfg_v1";
  const META = "mogao_vault_meta_v1";
  const RECOVERY = "mogao_recovery_v1";
  const PENDING_CONFLICTS = "mogao_pending_save_conflicts_v1";
  const RECOVERY_MAX_CHARS = 3_500_000;

  function uid() {
    return crypto.randomUUID?.() || `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function defaultProject() {
    return {
      schemaVersion: window.NOVEL_PROJECT_MIGRATIONS?.CURRENT_SCHEMA_VERSION || 1,
      schemaMigrationHistory: [],
      id: uid(),
      slug: "",
      title: "新自动连载",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stage: "idea",
      ideaInput: "",
      authorNote: "",
      authorCastNote: "",
      authorSpineLock: "",
      authorForbidden: "",
      targetChapters: 20,
      title_candidates: [],
      pitch: "",
      genre: "",
      sub_genre: "",
      hooks: [],
      tone: "",
      audience: "",
      risks: [],
      world: null,
      graph: { nodes: [], edges: [], stats: {} },
      cast_summary: "",
      spine: { logline: "", theme: "", spine: [], volumes: [], foreshadow: [] },
      tasks: [],
      locks: {
        logline: "",
        forbidden: [],
        mustHonor: [],
        lockedFields: [],
      },
      memoryRoll: [],
      /** 独立于 40 章摘要窗口的伏笔/悬念生命周期账本 */
      plotLoops: [],
      continuityIssues: [],
      entityStates: {},
      timelineEvents: [],
      continuityReviews: [],
      contextManifests: [],
      continuityMeta: { loopSchema: 1, issueSchema: 1, entitySchema: 1 },
      /** 作者确认的叙述风格与人物声线约束 */
      styleBible: {
        pov: "",
        tense: "",
        pacing: "",
        dialogue: "",
        punctuation: "",
        rules: [],
        forbiddenPhrases: [],
        examples: [],
      },
      /** 从已接受章节统计出的可解释风格轮廓（软约束；没有样本时为空） */
      styleProfile: null,
      /**
       * 滚动故事状态：每章 digest 后由 context.mergeStoryState 更新。
       * 写下一章时注入【当前故事状态】，避免模型遗忘进度/设定。
       */
      storyState: {
        updatedAt: 0,
        lastChapter: "",
        chapterCount: 0,
        protagonistState: "",
        openLoops: [],
        establishedFacts: [],
        recentHook: "",
        endingNote: "",
        powerOrSystem: "",
        location: "",
        timeline: "",
      },
      /** 细节设定文档：数字/专名等跨章锁定 */
      detailCanon: { updatedAt: 0, facts: [], conflicts: [] },
      /** 故事线轨道：位置、概要、下一推进方向、章日志 */
      storyline: {
        updatedAt: 0,
        currentTaskId: "",
        currentOrder: 0,
        volumeId: "",
        volumeTitle: "",
        positionSummary: "",
        lastSummary: "",
        nextDirection: "",
        nextTaskId: "",
        nextTaskGoal: "",
        chapterLogs: [],
      },
      /** 各章出场人物/地点/道具 */
      appearanceLog: [],
      chapters: [],
      activeChapterId: null,
      activeTaskId: null,
      pipelineLog: [],
      autoWrite: false,
    };
  }

  function loadAll() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.projects?.length) {
          // slim 缓存里的空 body 会被状态模块跳过；未落盘/旧缓存的完整正文
          // 则可在应用启动前立即发现过期质量签名。
          for (const project of s.projects) {
            const migration = window.NOVEL_PROJECT_MIGRATIONS?.migrateProject?.(project, {
              reason: "浏览器缓存恢复",
            });
            if (!migration?.readOnly) {
              window.NOVEL_PRODUCTION_STATE?.reconcileProject?.(project, {
                reason: "浏览器恢复正文与旧质量签名不一致",
              });
            }
          }
          return s;
        }
      }
    } catch (_) {}
    const p = defaultProject();
    return { projects: [p], activeId: p.id };
  }

  /**
   * 写入 localStorage 前精简：chapters 去掉 body（完整正文以 vault 为准），
   * 避免大书稿撑爆 5MB 配额。loadAll 仍可读旧缓存。
   */
  function slimForCache(state) {
    if (!state || typeof state !== "object") return state;
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(state));
    } catch (_) {
      return state;
    }
    const projects = copy.projects;
    if (!Array.isArray(projects)) return copy;
    for (const p of projects) {
      if (!p || typeof p !== "object") continue;
      delete p.ragIndex;
      delete p._lastRag;
      delete p._lastContextManifest;
      delete p._saveWarnings;
      // 未落入 vault 或尚未确认落盘的项目必须保留正文。
      if (!String(p.slug || "").trim() || p._dirty === true) continue;
      if (!Array.isArray(p.chapters)) continue;
      p.chapters = p.chapters.map((ch) => {
        if (!ch || typeof ch !== "object") return ch;
        const { body, ...meta } = ch;
        // 保留 id/title/order/updatedAt 等 meta；body 置空
        return { ...meta, body: "", _bodyLoaded: false };
      });
    }
    return copy;
  }

  function saveAll(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(slimForCache(state)));
    } catch (e) {
      console.warn("localStorage full?", e);
    }
  }

  function recoveryKey(project) {
    return String(project?.slug || project?.id || "").trim();
  }

  function loadRecoveryMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECOVERY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  /** 按章节更新时间在所有作品间统一淘汰，不能让每本书各占一份上限。 */
  function trimRecoveryMap(map) {
    const source = map && typeof map === "object" && !Array.isArray(map) ? map : {};
    const candidates = [];
    for (const [key, row] of Object.entries(source)) {
      for (const chapter of Array.isArray(row?.chapters) ? row.chapters : []) {
        const body = String(chapter?.body || "");
        if (!body) continue;
        candidates.push({
          key,
          row,
          chapter: { ...chapter, body },
          stamp: Number(chapter?.updatedAt) || Number(row?.savedAt) || 0,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        b.stamp - a.stamp ||
        (Number(b.row?.savedAt) || 0) - (Number(a.row?.savedAt) || 0)
    );

    const trimmed = {};
    let used = 0;
    for (const candidate of candidates) {
      let chapter = candidate.chapter;
      if (used === 0 && chapter.body.length > RECOVERY_MAX_CHARS) {
        chapter = { ...chapter, body: chapter.body.slice(-RECOVERY_MAX_CHARS) };
      } else if (used + chapter.body.length > RECOVERY_MAX_CHARS) {
        continue;
      }
      used += chapter.body.length;
      if (!trimmed[candidate.key]) {
        trimmed[candidate.key] = { ...candidate.row, chapters: [] };
      }
      trimmed[candidate.key].chapters.push(chapter);
    }
    for (const row of Object.values(trimmed)) {
      row.chapters.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    }
    return trimmed;
  }

  /** 保存一个有界正文恢复副本；优先保留最近更新的章节。 */
  function saveRecovery(project) {
    const key = recoveryKey(project);
    if (!key || !Array.isArray(project?.chapters)) return false;
    const chapters = project.chapters
      .filter((chapter) => chapter && String(chapter.body || "").length > 0)
      .map((chapter) => ({
        id: chapter.id || "",
        title: chapter.title || "",
        order: chapter.order || 0,
        updatedAt: Number(chapter.updatedAt) || 0,
        body: String(chapter.body || ""),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!chapters.length) return false;
    const map = loadRecoveryMap();
    map[key] = {
      schemaVersion: 1,
      id: project.id || "",
      slug: project.slug || "",
      title: project.title || "",
      savedAt: Date.now(),
      projectUpdatedAt: Number(project.updatedAt) || 0,
      chapters,
    };
    const trimmed = trimRecoveryMap(map);
    try {
      localStorage.setItem(RECOVERY, JSON.stringify(trimmed));
      return Object.prototype.hasOwnProperty.call(trimmed, key);
    } catch (e) {
      console.warn("saveRecovery failed", e);
      return false;
    }
  }

  function clearRecovery(project) {
    const key = recoveryKey(project);
    if (!key) return;
    const map = loadRecoveryMap();
    if (!Object.prototype.hasOwnProperty.call(map, key)) return;
    delete map[key];
    try {
      if (Object.keys(map).length) localStorage.setItem(RECOVERY, JSON.stringify(map));
      else localStorage.removeItem(RECOVERY);
    } catch (e) {
      console.warn("clearRecovery failed", e);
    }
  }

  function pendingConflictSnapshot(entry) {
    if (!entry || typeof entry !== "object") return null;
    try {
      return JSON.parse(
        JSON.stringify({
          schemaVersion: 2,
          projectId: entry.projectId || "",
          slug: entry.slug || "",
          detectedAt: Number(entry.detectedAt) || Date.now(),
          detectedRevision:
            entry.detectedRevision == null ? null : Number(entry.detectedRevision),
          warning: entry.warning || {},
          localChapter: entry.localChapter || null,
          diskChapter: entry.diskChapter || null,
        })
      );
    } catch (_) {
      return null;
    }
  }

  /** 保存尚未裁决的章节冲突；正文双份都保留，重启后不能静默丢任一侧。 */
  function savePendingConflicts(entries) {
    const snapshots = (Array.isArray(entries) ? entries : [])
      .map(pendingConflictSnapshot)
      .filter(Boolean);
    try {
      if (!snapshots.length) {
        localStorage.removeItem(PENDING_CONFLICTS);
        return true;
      }
      localStorage.setItem(
        PENDING_CONFLICTS,
        JSON.stringify({ schemaVersion: 2, savedAt: Date.now(), entries: snapshots })
      );
      return true;
    } catch (e) {
      console.warn("savePendingConflicts failed", e);
      return false;
    }
  }

  function loadPendingConflicts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_CONFLICTS) || "null");
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(entries)) return [];
      return entries.map(pendingConflictSnapshot).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * 一章恢复该不该盖上磁盘章。按章比较 body / updatedAt，不用 book.json 的钟。
   * apply=写入内存；keep=这一章仍留在恢复 map 里（未确认落盘前不能删）。
   */
  function shouldApplyRecoveredChapter(saved, diskChapter) {
    if (!saved) return { apply: false, keep: false };
    if (!diskChapter) return { apply: false, keep: true };
    const savedBody = String(saved.body || "");
    const diskBody = String(diskChapter.body || "");
    if (savedBody === diskBody) return { apply: false, keep: false };
    const savedAt = Number(saved.updatedAt) || 0;
    const diskAt = Number(diskChapter.updatedAt) || 0;
    if (savedAt >= diskAt || (!diskBody.trim() && savedBody)) {
      return { apply: true, keep: true };
    }
    return { apply: false, keep: true };
  }

  /** 将比磁盘章更新的恢复正文合并回内存，并返回恢复章节数。 */
  function applyRecovery(state) {
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    const map = loadRecoveryMap();
    let recovered = 0;
    for (const [key, row] of Object.entries(map)) {
      const project = projects.find(
        (item) => item && ((row.slug && item.slug === row.slug) || (row.id && item.id === row.id))
      );
      if (!project) continue;
      // stub / 空章列表不是磁盘全书，不能拿来判定恢复副本过期。
      if (project._stub || !Array.isArray(project.chapters) || project.chapters.length === 0) {
        continue;
      }
      const remaining = [];
      let projectRecovered = 0;
      for (const saved of row.chapters || []) {
        const chapter = (project.chapters || []).find(
          (item) => item.id === saved.id || (item.order === saved.order && item.title === saved.title)
        );
        const decision = shouldApplyRecoveredChapter(saved, chapter);
        if (decision.apply && chapter) {
          chapter.body = String(saved.body || "");
          chapter.updatedAt = Number(saved.updatedAt) || Number(row.savedAt) || Date.now();
          projectRecovered += 1;
          recovered += 1;
        }
        if (decision.keep) remaining.push(saved);
      }
      if (projectRecovered) project._dirty = true;
      if (!remaining.length) delete map[key];
      else map[key] = { ...row, chapters: remaining };
    }
    try {
      if (Object.keys(map).length) localStorage.setItem(RECOVERY, JSON.stringify(map));
      else localStorage.removeItem(RECOVERY);
    } catch (_) {}
    return recovered;
  }

  function loadCfg() {
    const d = window.NOVEL_DEFAULTS || {};
    try {
      const raw = localStorage.getItem(CFG);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === "object" && Object.prototype.hasOwnProperty.call(saved, "apiKey")) {
          delete saved.apiKey;
          localStorage.setItem(CFG, JSON.stringify(saved));
        }
        return { ...d, ...saved };
      }
    } catch (_) {}
    return { ...d };
  }

  /**
   * 同步写 localStorage；若传入 persistRemote=true 且 vault 在线，
   * 由 app 侧 await Vault.putSettings（此处保持同步 API 兼容）。
   */
  function saveCfg(cfg) {
    try {
      const safe = { ...(cfg || {}) };
      delete safe.apiKey;
      localStorage.setItem(CFG, JSON.stringify(safe));
    } catch (e) {
      console.warn("saveCfg localStorage failed", e);
    }
  }

  /** 用服务端 clientCfg 覆盖本地（磁盘权威） */
  function mergeCfgFromServer(localCfg, serverCfg) {
    const d = window.NOVEL_DEFAULTS || {};
    const base = { ...d, ...(localCfg || {}) };
    if (!serverCfg || typeof serverCfg !== "object") return base;
    // 服务端非空字段优先（重启后恢复 key/theme）
    const out = { ...base };
    for (const [k, v] of Object.entries(serverCfg)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v === "" && k !== "apiKey") continue;
      out[k] = v;
    }
    return out;
  }

  function loadUiState() {
    try {
      const raw = localStorage.getItem("mogao_ui_state_v1");
      if (raw) return JSON.parse(raw) || {};
    } catch (_) {}
    return {};
  }

  function saveUiState(ui) {
    try {
      localStorage.setItem("mogao_ui_state_v1", JSON.stringify(ui || {}));
    } catch (e) {
      console.warn("saveUiState failed", e);
    }
  }

  function loadMeta() {
    try {
      return JSON.parse(localStorage.getItem(META) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveMeta(meta) {
    localStorage.setItem(META, JSON.stringify(meta || {}));
  }

  return {
    KEY,
    CFG,
    META,
    RECOVERY,
    RECOVERY_MAX_CHARS,
    PENDING_CONFLICTS,
    uid,
    defaultProject,
    slimForCache,
    loadAll,
    saveAll,
    saveRecovery,
    clearRecovery,
    applyRecovery,
    shouldApplyRecoveredChapter,
    trimRecoveryMap,
    savePendingConflicts,
    loadPendingConflicts,
    loadCfg,
    saveCfg,
    mergeCfgFromServer,
    loadUiState,
    saveUiState,
    loadMeta,
    saveMeta,
  };
})();
