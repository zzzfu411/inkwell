/** DOM-free application service for pitch/world/cast/spine planning. */
window.NOVEL_PLANNING_SERVICE = (() => {
  function create({ getPrompts, getApi, log } = {}) {
    if (typeof getPrompts !== "function") throw new TypeError("planning service requires getPrompts");
    if (typeof getApi !== "function") throw new TypeError("planning service requires getApi");
    if (typeof log !== "function") throw new TypeError("planning service requires log");
    const P = getPrompts;
    const API = getApi;

    const DEFAULT_TARGET_CHAPTERS = 20;
    const MIN_TARGET_CHAPTERS = 8;
    const MAX_TARGET_CHAPTERS = 400;
    const PROGRESSED_TASK_STATUSES = new Set([
      "done",
      "written",
      "digested",
      "writing",
      "complete",
      "completed",
      "finished",
    ]);

    const SINGLE_SURNAMES = new Set(
      "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公".split("")
    );
    const COMPOUND_SURNAMES = [
      "万俟",
      "司马",
      "上官",
      "欧阳",
      "夏侯",
      "诸葛",
      "东方",
      "赫连",
      "皇甫",
      "尉迟",
      "公孙",
      "慕容",
      "令狐",
      "宇文",
      "长孙",
      "司徒",
      "独孤",
      "南宫",
      "轩辕",
      "百里",
      "东郭",
      "呼延",
      "拓跋",
      "完颜",
      "钟离",
      "鲜于",
      "濮阳",
      "单于",
      "公冶",
      "司空",
      "端木",
    ];
    const NAME_STOPWORDS = new Set([
      "不是",
      "不能",
      "不要",
      "以及",
      "或者",
      "平等",
      "合作",
      "特勤",
      "系统",
      "主角",
      "男主",
      "女主",
      "男主角",
      "女主角",
      "野医",
      "粉丝",
      "工具人",
      "普通人",
      "高冷",
      "冷峻",
      "温柔",
      "强大",
      "无敌",
      "漂亮",
      "美丽",
      "聪明",
      "勇敢",
      "善良",
      "腹黑",
      "病娇",
      "清冷",
      "沉默",
      "坚定",
      "开朗",
      "神秘",
      "强势",
      "天才",
      "废柴",
      "反派",
      "装弱",
      "打脸",
      "升级",
      "复仇",
      "穿越",
      "重生",
      "能听见",
      "能看见",
      "擅长医术",
    ]);
    const NAME_NON_NAME_PREFIXES = new Set("能会可要需想擅喜爱怕让被在从与和并但却而有无很最不没已正个一位名种只某这那其女男".split(""));
    const NAME_TRAILING_STOP_CHARS = new Set("能会可要需想让被在从与和并但却而且的了着过将把给用靠带拿说看听知登出入现来去到进回成做作当装打禁是为拥具含有无负担参演".split(""));
    const NAME_TRAILING_STOP_WORDS = [
      "装弱",
      "打脸",
      "能听见",
      "能看见",
      "擅长",
      "喜欢",
      "负责",
      "担任",
      "登场",
      "出场",
      "出现",
      "行动",
      "一起",
      "开始",
      "随后",
      "之后",
      "然后",
      "入场",
      "回到",
      "来到",
      "前往",
      "成为",
      "变成",
      "拥有",
      "想要",
      "可以",
      "能够",
      "正在",
      "已经",
      "不会",
      "不再",
      "必须",
      "需要",
    ];
    const NAME_BOUNDARY_CHARS = /[\s，。；、:：,.;!?！？（）()【】\u005b\u005d「」『』“”‘’"'—…/-]/;
    const NAME_BOUNDARY_LEADING = new Set("能会可要需想擅喜爱怕让被在从与和并但却而且其这那一同共行登出入现来去到进回成做作当给用靠带拿说看听知装打禁是为的了着过拥具含有无负担参演".split(""));
  
    function normalizeTargetChapters(value, fallback = DEFAULT_TARGET_CHAPTERS) {
      const n = Number(value);
      const safeFallback = Number.isFinite(Number(fallback))
        ? Math.round(Number(fallback))
        : DEFAULT_TARGET_CHAPTERS;
      if (!Number.isFinite(n)) {
        return Math.min(MAX_TARGET_CHAPTERS, Math.max(MIN_TARGET_CHAPTERS, safeFallback));
      }
      return Math.min(MAX_TARGET_CHAPTERS, Math.max(MIN_TARGET_CHAPTERS, Math.round(n)));
    }
  
    function isProgressedStatus(status) {
      return PROGRESSED_TASK_STATUSES.has(String(status || "").trim().toLowerCase());
    }
  
    function ensurePlanningState(project) {
      if (!project || typeof project !== "object" || Array.isArray(project)) {
        throw new TypeError("无效的作品状态");
      }
      if (!project.locks || typeof project.locks !== "object" || Array.isArray(project.locks)) project.locks = {};
      if (!Array.isArray(project.locks.lockedFields)) {
        project.locks.lockedFields = project.locks.lockedFields ? [String(project.locks.lockedFields)] : [];
      }
      if (!Array.isArray(project.locks.forbidden)) {
        project.locks.forbidden = project.locks.forbidden ? [String(project.locks.forbidden)] : [];
      }
      if (!Array.isArray(project.locks.mustHonor)) {
        project.locks.mustHonor = project.locks.mustHonor ? [String(project.locks.mustHonor)] : [];
      }
      if (typeof project.locks.logline !== "string") project.locks.logline = String(project.locks.logline || "");
      if (!project.graph || typeof project.graph !== "object" || Array.isArray(project.graph)) project.graph = {};
      if (!Array.isArray(project.graph.nodes)) project.graph.nodes = [];
      if (!Array.isArray(project.graph.edges)) project.graph.edges = [];
      if (!project.graph.stats || typeof project.graph.stats !== "object" || Array.isArray(project.graph.stats)) {
        project.graph.stats = {};
      }
      if (!Array.isArray(project.tasks)) project.tasks = [];
      if (!Array.isArray(project.chapters)) project.chapters = [];
      if (!Array.isArray(project.pipelineLog)) project.pipelineLog = [];
      project.targetChapters = normalizeTargetChapters(project.targetChapters);
      return project;
    }
  
    function looksLikePersonName(name, explicit = false) {
      const n = String(name || "").trim();
      if (!/^[\u3400-\u9fff]{2,4}$/.test(n)) return false;
      // 带“叫/姓名/名字”等强标记时，作者可能确实把角色命名为“系统”等特殊名；
      // 没有强标记的自然语言描述仍按停用词过滤，避免把“男主高冷”当成人名。
      if (NAME_STOPWORDS.has(n) && !explicit) return false;
      if ([...NAME_NON_NAME_PREFIXES].some((prefix) => n.startsWith(prefix))) return false;
      const hasSurname = COMPOUND_SURNAMES.some((s) => n.startsWith(s)) || SINGLE_SURNAMES.has(n[0]);
      return Boolean(explicit || hasSurname);
    }
  
    function isNameBoundary(ch, rest = "") {
      if (!ch) return true;
      if (NAME_BOUNDARY_CHARS.test(ch) || NAME_BOUNDARY_LEADING.has(ch)) return true;
      return ["特勤", "并且", "同时", "之后", "然后"].some((word) => rest.startsWith(word));
    }
  
    function trimNamePrefix(value) {
      return String(value || "").replace(/^[\s:：=,，、;；/\\·\-—]+/, "");
    }
  
    function extractNameAfterRole(value) {
      let rest = trimNamePrefix(value);
      let strongExplicit = false;
      // 允许“女主姓名为 / 女主的名字叫 / 女主叫作”等自然写法，最多剥三层前缀。
      for (let i = 0; i < 3; i++) {
        const marker = rest.match(
          /^(?:(?:的)?(?:角色|身份)?(?:名字|姓名|名称|名)(?:叫作|叫做|叫|是|为)?|(?:身份|设定)(?:叫作|叫做|叫|是|为)|叫作|叫做|名叫|名为|称作|称为|就是|设定为|叫|是|为)\s*/
        );
        if (!marker) break;
        if (/(?:叫|名|姓名|名字|称|就是)/.test(marker[0])) strongExplicit = true;
        rest = trimNamePrefix(rest.slice(marker[0].length));
      }
      const wrapped = rest.match(/^[「『“"‘']([\u3400-\u9fff]{2,4})[」』”"’']/);
      if (wrapped && looksLikePersonName(wrapped[1], true)) return wrapped[1];
      const bracketed = rest.match(/^[（(【\u005b]\s*([\u3400-\u9fff]{2,4})\s*[）)】\u005d]/);
      if (bracketed && looksLikePersonName(bracketed[1], true)) return bracketed[1];
  
      const chars = rest.match(/^[\u3400-\u9fff]+/)?.[0] || "";
      if (!chars) return "";
      for (let len = Math.min(4, chars.length); len >= 2; len--) {
        const candidate = chars.slice(0, len);
        if (len === 4 && !COMPOUND_SURNAMES.some((s) => candidate.startsWith(s))) continue;
        if (NAME_TRAILING_STOP_WORDS.some((word) => candidate.endsWith(word))) continue;
        const next = rest.charAt(len);
        if (NAME_TRAILING_STOP_CHARS.has(candidate[candidate.length - 1])) continue;
        if (!isNameBoundary(next, rest.slice(len))) continue;
        if (looksLikePersonName(candidate, strongExplicit)) return candidate;
      }
      return "";
    }
  
    function collectAuthorNameLocks(project) {
      const text = [project?.ideaInput, project?.authorNote, project?.authorCastNote, project?.authorSpineLock]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join("\n");
      const found = [];
      const seen = new Set();
      const seenRoles = new Set();
      const add = (role, name) => {
        const clean = String(name || "").trim();
        if (!clean || seen.has(clean) || seenRoles.has(role)) return;
        seen.add(clean);
        seenRoles.add(role);
        found.push({ role, name: clean });
      };
      const roleRe = /(女主(?:角色|人公|角)?|男主(?:角色|人公|角)?|女一(?:号)?|男一(?:号)?|主角)/g;
      let match;
      while ((match = roleRe.exec(text))) {
        const token = match[1];
        // “女主角/男主角”已由上面的长分支整体消费；这里仅防止极端断词再次把“主角”当男主。
        if (token === "主角" && /[男女]$/.test(text.slice(Math.max(0, match.index - 1), match.index))) continue;
        const role = token.startsWith("女") ? "heroine" : "protagonist";
        add(role, extractNameAfterRole(text.slice(match.index + token.length)));
      }
      return found;
    }
  
    function authorNameConstraintLine(project) {
      const locks = collectAuthorNameLocks(project);
      return locks.length
        ? `【禁改人名】${locks.map((x) => `${x.role === "heroine" ? "女主" : "男主"}必须叫${x.name}`).join("；")}。禁止改名、谐音或另起一套人物。`
        : "";
    }
  
    function joinConstraintBlocks(...blocks) {
      const seen = new Set();
      return blocks
        .flatMap((block) => (Array.isArray(block) ? block : [block]))
        .map((block) => String(block || "").trim())
        .filter((block) => block && !seen.has(block) && seen.add(block))
        .join("\n");
    }
  
    function authorConstraintBlock(project) {
      const rawParts = [project?.ideaInput, project?.authorNote]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const raw = [...new Set(rawParts)].join("\n");
      return joinConstraintBlocks(
        authorNameConstraintLine(project),
        raw ? `【作者原文，其中的人名/系统名必须原样保留】\n${raw}` : ""
      );
    }
  
    function replaceName(text, from, to) {
      if (!from || !to || from === to || !text) return text;
      return String(text).split(from).join(to);
    }
  
    function normalizeAliases(node) {
      if (!node || typeof node !== "object") return [];
      const raw = Array.isArray(node.aliases) ? node.aliases : node.aliases ? [node.aliases] : [];
      node.aliases = [...new Set(raw.map((alias) => String(alias || "").trim()).filter(Boolean))];
      return node.aliases;
    }
  
    function nodeHasRole(node, wantedRole) {
      const role = String(node?.role || "").trim().toLowerCase();
      if (role === wantedRole) return true;
      if (wantedRole === "heroine") return ["女主", "女主角", "女一", "female"].includes(role);
      return ["男主", "男主角", "主角", "男一", "male"].includes(role);
    }
  
    function replaceNamesInGeneratedTree(value, from, to, key = "") {
      if (!value || !from || from === to) return;
      if (typeof value === "string") return replaceName(value, from, to);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const next = replaceNamesInGeneratedTree(value[i], from, to, key);
          if (typeof next === "string") value[i] = next;
        }
        return;
      }
      if (typeof value !== "object") return;
      const skip = new Set(["id", "taskId", "source", "target", "aliases", "ideaInput", "authorNote", "authorCastNote", "authorSpineLock", "authorForbidden"]);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (skip.has(childKey)) continue;
        const next = replaceNamesInGeneratedTree(childValue, from, to, childKey);
        if (typeof next === "string") value[childKey] = next;
      }
    }
  
    function applyAuthorNamesToGraph(project) {
      ensurePlanningState(project);
      const locks = collectAuthorNameLocks(project);
      if (!locks.length) return locks;
      const nodes = project.graph.nodes;
      for (const lock of locks) {
        const wantedRole = lock.role === "heroine" ? "heroine" : "protagonist";
        const exactRole = nodes.find((n) => String(n?.label || "").trim() === lock.name && nodeHasRole(n, wantedRole));
        const exactAny = nodes.find((n) => String(n?.label || "").trim() === lock.name);
        const aliasRole = nodes.find((n) => nodeHasRole(n, wantedRole) && normalizeAliases(n).includes(lock.name));
        const aliasAny = nodes.find((n) => normalizeAliases(n).includes(lock.name));
        const roleNode = nodes.find((n) => nodeHasRole(n, wantedRole));
        let node = exactRole || exactAny || aliasRole || aliasAny || roleNode;
        if (!node) {
          let id = `n_author_${wantedRole}`;
          let suffix = 2;
          while (nodes.some((candidate) => String(candidate?.id || "") === id)) id = `n_author_${wantedRole}_${suffix++}`;
          node = {
            id,
            label: lock.name,
            aliases: [],
            type: "character",
            role: wantedRole,
            arc: "",
            voice: "",
            want: "",
            need: "",
            note: "作者指定角色",
          };
          nodes.push(node);
        }
        normalizeAliases(node);
        if (!node.role || node.role === "support") node.role = wantedRole;
        const old = String(node.label || "").trim();
        if (!old || old === lock.name) continue;
        node.aliases = [...new Set([...(node.aliases || []), old])];
        node.label = lock.name;
        replaceNamesInGeneratedTree(project.graph, old, lock.name);
        project.cast_summary = replaceName(project.cast_summary, old, lock.name);
      }
      project.graph.stats = {
        ...(project.graph.stats || {}),
        characters: nodes.length,
        relationships: project.graph.edges.length,
      };
      return locks;
    }
  
    function applyAuthorNamesToTextFields(project) {
      ensurePlanningState(project);
      const locks = collectAuthorNameLocks(project);
      if (!locks.length) return;
      const nodes = project.graph.nodes;
      const replacePlanningValue = (value, from, to) => {
        if (typeof value === "string") return replaceName(value, from, to);
        replaceNamesInGeneratedTree(value, from, to);
        return value;
      };
      for (const lock of locks) {
        const wantedRole = lock.role === "heroine" ? "heroine" : "protagonist";
        const node = nodes.find((n) => nodeHasRole(n, wantedRole));
        const aliases = normalizeAliases(node);
        for (const old of aliases) {
          // 只改策划/锁定产物；正文、摘要和证据是作者资产，不在姓名归一化的写入范围内。
          project.title = replacePlanningValue(project.title, old, lock.name);
          project.title_candidates = replacePlanningValue(project.title_candidates, old, lock.name);
          project.pitch = replacePlanningValue(project.pitch, old, lock.name);
          project.cast_summary = replacePlanningValue(project.cast_summary, old, lock.name);
          project.world = replacePlanningValue(project.world, old, lock.name);
          project.spine = replacePlanningValue(project.spine, old, lock.name);
          project.tasks = replacePlanningValue(project.tasks, old, lock.name);
          if (project.locks) {
            project.locks.logline = replaceName(project.locks.logline, old, lock.name);
            project.locks.forbidden = replacePlanningValue(project.locks.forbidden, old, lock.name);
            project.locks.mustHonor = replacePlanningValue(project.locks.mustHonor, old, lock.name);
          }
        }
      }
    }
  
    function planningHasProgress(project) {
      const tasks = Array.isArray(project?.tasks) ? project.tasks : [];
      const chapters = Array.isArray(project?.chapters) ? project.chapters : [];
      if (tasks.some((t) => isProgressedStatus(t?.status))) return true;
      return chapters.some((c) => String(c.body || "").trim());
    }
  
    function textSignature(text) {
      const s = String(text || "");
      let hash = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return `${s.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
    }
  
    async function runPitch(project, cfg, signal) {
      ensurePlanningState(project);
      const pr = P().stagePitch;
      const json = (await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal,
        diagnosticStage: "plan-pitch",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          {
            role: "user",
            content: joinConstraintBlocks(
              pr.user(project.ideaInput || "热门玄幻升级流"),
              authorNameConstraintLine(project),
              project.authorNote
            ),
          },
        ],
      })) || {};
      Object.assign(project, {
        title_candidates: json.title_candidates || [],
        pitch: json.pitch || "",
        genre: json.genre || "",
        sub_genre: json.sub_genre || "",
        hooks: json.hooks || [],
        tone: json.tone || "",
        styleBible:
          json.style_bible && typeof json.style_bible === "object"
            ? json.style_bible
            : {
                ...(project.styleBible || {}),
                pacing: project.styleBible?.pacing || json.tone || "",
              },
        audience: json.audience || "",
        risks: json.risks || [],
        title: (json.title_candidates && json.title_candidates[0]) || project.title,
        stage: "pitch",
      });
      log(project, "完成立项/卖点");
      return json;
    }
  
    async function runWorld(project, cfg, signal) {
      ensurePlanningState(project);
      const pr = P().stageWorld;
      const json = (await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal,
        diagnosticStage: "plan-world",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          {
            role: "user",
            content: pr.user({
              pitch: project.pitch,
              genre: project.genre,
              hooks: project.hooks,
              tone: project.tone,
              authorNote: authorConstraintBlock(project),
            }),
          },
        ],
      })) || {};
      project.world = json;
      project.stage = "world";
      log(project, "完成世界观");
      return json;
    }
  
    async function runCast(project, cfg, signal) {
      ensurePlanningState(project);
      const pr = P().stageCast;
      const json = (await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal,
        diagnosticStage: "plan-cast",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          {
            role: "user",
            content: pr.user({
              pitch: project.pitch,
              genre: project.genre,
              sub_genre: project.sub_genre,
              world: project.world,
              authorCastNote: joinConstraintBlocks(project.authorCastNote, authorConstraintBlock(project)),
            }),
          },
        ],
      })) || {};
      const nodes = Array.isArray(json.nodes) ? json.nodes.filter((node) => node && typeof node === "object") : [];
      const edges = Array.isArray(json.edges) ? json.edges.filter((edge) => edge && typeof edge === "object") : [];
      project.graph = {
        nodes,
        edges,
        stats: {
          characters: nodes.length,
          relationships: edges.length,
        },
      };
      project.cast_summary = json.cast_summary || "";
      project.stage = "cast";
      const nameLocks = applyAuthorNamesToGraph(project);
      if (nameLocks.length) {
        log(project, `已锁定作者人名：${nameLocks.map((x) => x.name).join("、")}`);
      }
      log(project, "完成人物与关系");
      return json;
    }
  
    async function runSpine(project, cfg, signal) {
      ensurePlanningState(project);
      const pr = P().stageSpine;
      const n = normalizeTargetChapters(project.targetChapters);
      project.targetChapters = n;
      const existingLogline = String(project.locks.logline || "").trim();
      const loglineLocked = project.locks.lockedFields.includes("logline");
      const json = (await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal,
        diagnosticStage: "plan-spine",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          {
            role: "user",
            content: pr.user(
              {
                pitch: project.pitch,
                title_candidates: project.title_candidates,
                cast_summary: project.cast_summary,
                graph: project.graph,
                world: project.world,
                authorSpineLock: joinConstraintBlocks(
                  project.authorSpineLock,
                  authorConstraintBlock(project),
                  loglineLocked || planningHasProgress(project) ? existingLogline : ""
                ),
                authorForbidden: project.authorForbidden || (project.locks?.forbidden || []).join("；"),
              },
              n
            ),
          },
        ],
      })) || {};
      project.spine = {
        logline: json.logline || project.pitch,
        theme: json.theme || "",
        spine: json.spine || [],
        volumes: json.volumes || [],
        foreshadow: json.foreshadow || [],
      };
      applyAuthorNamesToGraph(project);
      applyAuthorNamesToTextFields(project);
      if (!existingLogline || (!planningHasProgress(project) && !loglineLocked)) {
        project.locks.logline = project.spine.logline;
      }
      const incoming = (Array.isArray(json.tasks) ? json.tasks : [])
        .filter((task) => task && typeof task === "object")
        .map((t, i) => {
          const id = t.id || `t${String(i + 1).padStart(3, "0")}`;
          const order = t.order || i + 1;
          // 忽略模型胡写的 status/done，进度以本地为准
          const { status: _ignoreStatus, ...rest } = t;
          return { ...rest, id, order, status: "pending" };
        });
      project.tasks = mergeTasksPreservingProgress(project.tasks || [], incoming, project.chapters || []);
      project.stage = "spine";
      log(project, `完成主线与 ${project.tasks.length} 个章任务（已保留本地进度）`);
      return json;
    }
  
    /**
     * 合并任务板：已 done/written/digested 的本地任务优先保留，避免重跑策划炸进度。
     * 无进度的 pending 可被同 id/order 的新规划覆盖文案。
     */
    function mergeTasksPreservingProgress(existing, incoming, chapters) {
      const existingList = Array.isArray(existing) ? existing.filter((task) => task && typeof task === "object") : [];
      const incomingList = Array.isArray(incoming) ? incoming.filter((task) => task && typeof task === "object") : [];
      const chapterList = Array.isArray(chapters) ? chapters.filter((chapter) => chapter && typeof chapter === "object") : [];
      const chByTask = new Map();
      for (const c of chapterList) {
        if (c.taskId) chByTask.set(c.taskId, c);
      }
      const oldById = new Map(existingList.map((t) => [t.id, t]));
      const oldByOrder = new Map(existingList.map((t) => [Number(t.order) || 0, t]));
      const usedOld = new Set();
      const result = [];
  
      function isProgressed(t) {
        if (!t) return false;
        if (isProgressedStatus(t.status)) return true;
        const ch = chByTask.get(t.id);
        return !!(ch && String(ch.body || "").trim());
      }
  
      const anyProgress =
        existingList.some(isProgressed) || chapterList.some((c) => String(c.body || "").trim());
      if (!anyProgress) return incomingList;
  
      for (const neu of incomingList) {
        const old = oldById.get(neu.id) || oldByOrder.get(Number(neu.order) || 0);
        if (old && isProgressed(old)) {
          usedOld.add(old.id);
          result.push({
            ...neu,
            ...old,
            // 保留进度字段
            id: old.id,
            status: old.status,
            order: old.order || neu.order,
            lastError: old.lastError,
            lastErrorStage: old.lastErrorStage,
            // 无正文进度时才允许用新标题/目标（已有进度则只补空字段）
            chapter_title: old.chapter_title || neu.chapter_title,
            goal: old.goal || neu.goal,
            conflict: old.conflict || neu.conflict,
            beats: old.beats?.length ? old.beats : neu.beats,
            must_include: old.must_include?.length ? old.must_include : neu.must_include,
            must_not: old.must_not?.length ? old.must_not : neu.must_not,
            hook_end: old.hook_end || neu.hook_end,
          });
        } else {
          if (old) usedOld.add(old.id);
          result.push({ ...neu, status: "pending" });
        }
      }
      // 本地有进度但不在新规划里的任务：追加保留，避免丢章
      for (const old of existingList) {
        if (usedOld.has(old.id)) continue;
        if (isProgressed(old)) result.push(old);
      }
      result.sort((a, b) => (a.order || 0) - (b.order || 0));
      return result;
    }
  
    /** 一键策划到 spine（中途可被 abort） */
    async function runFullPlan(project, cfg, { signal, onStep } = {}) {
      ensurePlanningState(project);
      const steps = [
        ["pitch", runPitch],
        ["world", runWorld],
        ["cast", runCast],
        ["spine", runSpine],
      ];
      for (const [name, fn] of steps) {
        onStep?.(name, "start");
        // skip if locked and already has data
        if (name === "world" && project.locks.lockedFields?.includes("world") && project.world) {
          onStep?.(name, "skip-locked");
          continue;
        }
        if (name === "cast" && project.locks.lockedFields?.includes("cast")) {
          const hasCastData = Boolean(
            project.graph?.nodes?.length || project.graph?.edges?.length || String(project.cast_summary || "").trim()
          );
          if (hasCastData) {
            const nameLocks = applyAuthorNamesToGraph(project);
            if (nameLocks.length) log(project, `已锁定作者人名：${nameLocks.map((x) => x.name).join("、")}`);
            onStep?.(name, "skip-locked");
            continue;
          }
        }
        if (name === "spine" && project.locks.lockedFields?.includes("spine")) {
          const hasSpineData = Boolean(
            project.spine?.logline ||
              project.tasks?.length ||
              project.spine?.spine?.length ||
              project.spine?.volumes?.length
          );
          if (hasSpineData) {
            onStep?.(name, "skip-locked");
            continue;
          }
        }
        await fn(project, cfg, signal);
        onStep?.(name, "done");
      }
      // 被锁定而跳过的阶段也要接受作者人名归一化，避免旧图谱/旧任务继续带着模型改名。
      applyAuthorNamesToGraph(project);
      applyAuthorNamesToTextFields(project);
      project.stage = "ready";
      log(project, "策划流水线完成，等待作者确认主线后可自动写章");
    }

    return {
      runPitch,
      runWorld,
      runCast,
      runSpine,
      runFullPlan,
      mergeTasksPreservingProgress,
      collectAuthorNameLocks,
      looksLikePersonName,
      applyAuthorNamesToGraph,
      applyAuthorNamesToTextFields,
      authorNameConstraintLine,
      authorConstraintBlock,
      joinConstraintBlocks,
      planningHasProgress,
      normalizeTargetChapters,
      ensurePlanningState,
      textSignature,
    };
  }

  return { create };
})();
