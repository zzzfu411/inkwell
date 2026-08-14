import { expect, test } from "@playwright/test";

const sizes = [
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];
const themes = ["soft-paper", "ink-night", "qing-jian"];
const scenarios = ["write", "pipeline", "control", "graph", "workspace", "analyze", "settings"];

async function closeSettings(page) {
  const modal = page.locator("#settingsModal:not([hidden])");
  if (await modal.count()) {
    await page.locator("#btnCloseSettings").click();
    await expect(page.locator("#settingsModal")).toBeHidden();
  }
}

async function waitForBookReady(page) {
  const created = await page.evaluate(async () => {
    const library = await window.NOVEL_VAULT.library();
    if ((library?.books || []).length) return false;
    await window.NOVEL_VAULT.createBook("浏览器回归测试", "");
    return true;
  });
  if (created) await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.locator("#projectSelect option").count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator("#projectSelect").inputValue()).not.toBe("");
  await expect(page.locator("#projectSelect option:checked")).not.toContainText("仅缓存");
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
}

async function installProjectFixture(page, fixture) {
  await waitForBookReady(page);
  await page.evaluate(async (payload) => {
    const state = window.NOVEL_STORE.loadAll();
    const selectedId = document.getElementById("projectSelect")?.value || state.activeId;
    const project = state.projects.find((item) => item.id === selectedId) || state.projects[0];
    if (!project?.slug) throw new Error("active browser fixture has no vault slug");
    Object.assign(project, payload, { updatedAt: Date.now() });
    state.activeId = project.id;
    if (Array.isArray(payload.chapters)) project.clearChapters = true;
    await window.NOVEL_VAULT.saveBook(project.slug, project);
    delete project.clearChapters;
    window.NOVEL_STORE.saveAll(state);
  }, fixture);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBookReady(page);
  if ((await page.locator("#libraryRail").getAttribute("aria-hidden")) === "false") {
    await page.keyboard.press("Escape");
    await expect(page.locator("#libraryRail")).toHaveAttribute("aria-hidden", "true");
  }
}

async function activate(page, scenario) {
  await closeSettings(page);
  if (["pipeline", "control", "graph"].includes(scenario)) {
    await page.locator('.topbar [data-section="story"]').click();
    // 故事顶栏会先切到主线；switchMode 现在会先冲刷写章台，必须等视图切完
    // 再点子模式，否则 `.view.active [data-go-mode]` 会命中写章台里的同名按钮。
    await expect(page.locator("#view-control")).toHaveClass(/active/);
    if (scenario !== "control") {
      await page.locator(`#view-control [data-go-mode="${scenario}"]`).first().click();
    }
    await expect(page.locator(`#view-${scenario}`)).toHaveClass(/active/);
    return;
  }
  if (scenario === "settings") {
    await page.locator("#btnSettings").click();
    await expect(page.locator("#settingsModal")).toBeVisible();
    return;
  }
  await page.locator(`.topbar [data-section="${scenario}"]`).click();
  await expect(page.locator(`#view-${scenario}`)).toHaveClass(/active/);
}

test("layout, ARIA and console smoke across 84 desktop cases", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await expect(page.locator(".view.active")).toBeVisible();

  const aria = await page.evaluate(() => {
    const linkedTabs = (tabSelector, panelPrefix) =>
      [...document.querySelectorAll(tabSelector)].every((tab) => {
        const target = tab.getAttribute("aria-controls");
        const panel = target && document.getElementById(target);
        return Boolean(panel && panel.id.startsWith(panelPrefix) && panel.getAttribute("aria-labelledby") === tab.id);
      });
    const themeOptions = [...document.querySelectorAll(".theme-swatch")];
    return {
      settings: linkedTabs("[data-settings-target]", "settings-panel-"),
      inspector: linkedTabs(".inspector-tab", "inspector-"),
      themes:
        themeOptions.length === 3 &&
        themeOptions.every((option) => option.getAttribute("role") === "option" && option.hasAttribute("aria-selected")),
      drawers:
        document.getElementById("btnOpenChapters")?.getAttribute("aria-controls") === "writeChaptersDrawer" &&
        document.getElementById("btnOpenInspector")?.getAttribute("aria-controls") === "writeTaskDrawer" &&
        document.getElementById("btnWsToggleFiles")?.getAttribute("aria-controls") === "wsFilesDrawer",
      conflict:
        document.querySelector("#saveConflictModal [role=dialog]")?.getAttribute("aria-labelledby") === "saveConflictTitle",
    };
  });
  expect(aria).toEqual({ settings: true, inspector: true, themes: true, drawers: true, conflict: true });

  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const theme of themes) {
      await page.evaluate((themeId) => {
        document.documentElement.setAttribute("data-theme", themeId);
        document.querySelectorAll(".theme-swatch").forEach((option) => {
          const active = option.getAttribute("data-theme") === themeId;
          option.setAttribute("aria-selected", active ? "true" : "false");
          option.tabIndex = active ? 0 : -1;
        });
      }, theme);
      for (const scenario of scenarios) {
        await test.step(`${size.name}/${theme}/${scenario}`, async () => {
          await activate(page, scenario);
          const metrics = await page.evaluate((scenarioId) => {
            const visible = (element) =>
              Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
            const activeView = document.querySelector(".view.active");
            const shellMain = document.querySelector(".shell-main");
            const topbar = document.querySelector(".topbar");
            const settingsModal = document.getElementById("settingsModal");
            const settingsOpen = scenarioId === "settings";
            return {
              topbarHeight: topbar?.getBoundingClientRect().height || 0,
              documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
              shellOverflow: shellMain ? Math.max(0, shellMain.scrollWidth - shellMain.clientWidth) : 0,
              writingSurfaceWidth:
                scenarioId === "write"
                  ? (document.getElementById("manuscript")?.getClientRects().length
                      ? document.getElementById("manuscript").getBoundingClientRect().width
                      : document.getElementById("writingWelcome")?.getBoundingClientRect().width || 0)
                  : null,
              activePrimaryCount: activeView
                ? [...activeView.querySelectorAll(".btn.primary")].filter(visible).length
                : 0,
              modalPrimaryCount: settingsOpen
                ? [...settingsModal.querySelectorAll(".btn.primary")].filter(visible).length
                : 0,
              modalBackgroundIsolated: !settingsOpen
                ? true
                : [...document.querySelector(".app").children].every(
                    (child) => child.inert && child.getAttribute("aria-hidden") === "true"
                  ),
              selectedSplitTabs: [...document.querySelectorAll("[data-split]")].filter(
                (tab) => tab.getAttribute("aria-selected") === "true" && tab.tabIndex === 0
              ).length,
            };
          }, scenario);

          expect(metrics.topbarHeight).toBeCloseTo(52, 0);
          expect(metrics.documentOverflow).toBeLessThanOrEqual(1);
          expect(metrics.shellOverflow).toBeLessThanOrEqual(1);
          expect(metrics.activePrimaryCount).toBeLessThanOrEqual(1);
          expect(metrics.modalPrimaryCount).toBeLessThanOrEqual(1);
          expect(metrics.modalBackgroundIsolated).toBe(true);
          expect(metrics.selectedSplitTabs).toBe(1);
          if (scenario === "write" && size.width === 1024) expect(metrics.writingSurfaceWidth).toBeGreaterThanOrEqual(680);
          if (scenario === "write" && size.width === 1280) expect(metrics.writingSurfaceWidth).toBeGreaterThanOrEqual(700);
        });
      }
    }
  }

  await closeSettings(page);
  expect(browserErrors).toEqual([]);
});

test("narrow workspace uses an accessible file drawer", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator('.topbar [data-section="workspace"]').click();
  const drawer = page.locator("#wsFilesDrawer");
  const toggle = page.locator("#btnWsToggleFiles");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(drawer).toHaveJSProperty("inert", true);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#wsFilesScrim")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("modal keyboard focus is contained and restored", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const trigger = page.locator("#btnSettings");
  await trigger.focus();
  await trigger.click();
  const modal = page.locator("#settingsModal");
  const dialog = modal.locator('[role="dialog"]');
  await expect(modal).toBeVisible();
  await expect(dialog).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.getElementById("settingsModal")?.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("save conflict actions remain visible at compact desktop height", async ({ page }) => {
  const localBody = "本地稿：她在钟声响起前抵达旧站。这段要足够长，逼出 768 高度下的冲突框滚动。".repeat(8);
  const diskBody = "磁盘稿：她在钟声结束后才抵达旧站。外部编辑器写下的新版同样很长，用来撑开比较区。".repeat(8);
  await openWriteDeskWithChapter(page, {
    chapterId: "ch-compact-conflict",
    title: "雨夜证词",
    body: "共同起点。",
    viewport: { width: 1024, height: 768 },
  });
  await triggerRealSaveConflict(page, { chapterId: "ch-compact-conflict", localBody, diskBody });

  const actions = page.locator("#saveConflictModal .conflict-actions");
  await expect(actions).toBeVisible();
  await expect(page.locator("#btnConflictUseDisk")).toBeVisible();
  await expect(page.locator("#btnConflictSaveMerge")).toBeVisible();
  await expect(page.locator("#btnConflictKeepLocal")).toBeVisible();

  const metrics = await page.locator("#saveConflictModal [role=dialog]").evaluate((dialog) => {
    const body = dialog.querySelector(".conflict-body");
    const actionBar = dialog.querySelector(".conflict-actions");
    const dialogRect = dialog.getBoundingClientRect();
    const actionRect = actionBar.getBoundingClientRect();
    return {
      dialogBottom: dialogRect.bottom,
      actionBottom: actionRect.bottom,
      viewportHeight: innerHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyCanScroll: body.scrollHeight > body.clientHeight,
    };
  });
  expect(metrics.dialogBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.actionBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.bodyOverflowY).toBe("auto");
  expect(metrics.bodyCanScroll).toBe(true);
});

test("200 percent reflow equivalent and reduced motion remain accessible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // 640 CSS px exercises the same reflow breakpoint as a 1280 px window at 200% browser zoom.
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const focusTarget = page.locator("#btnToggleLibrary");
  await page.keyboard.press("Tab");
  await expect(focusTarget).toBeFocused();

  const focusMetrics = await focusTarget.evaluate((element) => {
    const focusStyle = getComputedStyle(element);
    return {
      outlineStyle: focusStyle.outlineStyle,
      outlineWidth: Number.parseFloat(focusStyle.outlineWidth || "0"),
    };
  });
  expect(focusMetrics.outlineStyle).not.toBe("none");
  expect(focusMetrics.outlineWidth).toBeGreaterThanOrEqual(2);

  await page.locator('.topbar [data-section="write"]').click();
  const initial = await page.evaluate(() => {
    const motionStyle = getComputedStyle(document.getElementById("libraryRail"));
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      transitionSeconds: motionStyle.transitionDuration
        .split(",")
        .map((value) => Number.parseFloat(value) * (value.includes("ms") ? 0.001 : 1)),
    };
  });
  expect(initial.overflow).toBeLessThanOrEqual(1);
  expect(Math.max(...initial.transitionSeconds)).toBeLessThanOrEqual(0.0011);

  await page.locator("#btnSettings").click();
  await expect(page.locator("#settingsModal")).toBeVisible();
  const modalMetrics = await page.locator("#settingsModal [role=dialog]").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
  });
  expect(modalMetrics.left).toBeGreaterThanOrEqual(0);
  expect(modalMetrics.right).toBeLessThanOrEqual(modalMetrics.viewport);
  await page.keyboard.press("Escape");

  await page.locator('.topbar [data-section="story"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("primary shortcuts, story shortcuts, library drawer and focus mode form one keyboard-safe shell", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBookReady(page);

  await page.keyboard.press("Alt+2");
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  await page.keyboard.press("Control+1");
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await expect(page.locator('.topbar [data-section="write"]')).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Control+2");
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  await page.keyboard.press("Alt+1");
  await expect(page.locator("#view-pipeline")).toHaveClass(/active/);
  await page.keyboard.press("Alt+2");
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  await page.keyboard.press("Alt+3");
  await expect(page.locator("#view-graph")).toHaveClass(/active/);
  await page.keyboard.press("Control+3");
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await page.keyboard.press("Control+4");
  await expect(page.locator("#view-analyze")).toHaveClass(/active/);

  const libraryToggle = page.locator("#btnToggleLibrary");
  const library = page.locator("#libraryRail");
  await libraryToggle.click();
  await expect(library).toHaveAttribute("aria-hidden", "false");
  await expect(library).toHaveJSProperty("inert", false);
  const scrim = page.locator("#libraryScrim");
  await expect(scrim).toBeVisible();
  const scrimBox = await scrim.boundingBox();
  expect(scrimBox).not.toBeNull();
  await page.mouse.click(scrimBox.x + scrimBox.width - 8, scrimBox.y + scrimBox.height / 2);
  await expect(library).toHaveAttribute("aria-hidden", "true");

  await libraryToggle.click();
  await expect(page.locator("#libFilter")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(library).toHaveAttribute("aria-hidden", "true");
  await expect(libraryToggle).toBeFocused();

  await libraryToggle.click();
  await page.locator("#libraryList .lib-main").first().click();
  await expect(library).toHaveAttribute("aria-hidden", "true");

  await page.keyboard.press("Control+1");
  await page.locator("#btnFocusMode").click();
  await expect(page.locator("body")).toHaveClass(/focus-mode/);
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.locator("#view-write .rail-left")).toBeHidden();
  await expect(page.locator("#view-write .rail-right")).toBeHidden();
  await expect(page.locator("#btnFocusMode")).toHaveText("退出专注");
  await page.keyboard.press("Control+3");
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
  await expect(page.locator(".topbar")).toBeVisible();
});

test("offline empty library exposes three next steps and the cache boundary", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "offline regression fixture" }),
    });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#btnToggleLibrary").click();
  await expect(page.locator("#libraryEmptyState")).toBeVisible();
  await expect(page.locator('#libraryEmptyState [data-library-action="new"]')).toBeVisible();
  await expect(page.locator('#libraryEmptyState [data-library-action="open"]')).toBeVisible();
  await expect(page.locator('#libraryEmptyState [data-library-action="sample"]')).toBeVisible();
  await expect(page.locator('#libraryEmptyState [data-library-action="clear"]')).toBeHidden();
  await expect(page.locator("#libraryEmptyHint")).toContainText("浏览器缓存只能临时保留本机草稿");
  await expect(page.locator("#libraryEmptyHint")).toContainText("跨书搜索暂不可用");
});

test("global search renders backend hits in semantic groups", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBookReady(page);
  await page.route("**/api/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hits: [
          { slug: "fixture", title: "钟声", path: "章节/001-钟声.md", snippet: "正文命中", group: "chapter" },
          { slug: "fixture", title: "林玄", path: "关系/graph.json", snippet: "人物命中", group: "character" },
          { slug: "fixture", title: "等级", path: "记忆/canon.json", snippet: "设定命中", group: "canon" },
          { slug: "fixture", title: "旧站", path: "记忆/plot-loops.json", snippet: "伏笔命中", group: "loop" },
          { slug: "fixture", title: "采访", path: "资料/采访.md", snippet: "资料命中", group: "other" },
        ],
      }),
    });
  });
  await page.locator("#vaultSearch").fill("钟声");
  await expect(page.locator("#searchHits")).toBeVisible();
  await expect(page.locator("#searchHits .search-group")).toHaveCount(5);
  await expect(page.locator('[data-search-group="chapter"] .search-group-title')).toHaveText("正文 · 1");
  await expect(page.locator('[data-search-group="character"] .search-group-title')).toHaveText("人物 · 1");
  await expect(page.locator('[data-search-group="canon"] .search-group-title')).toHaveText("Canon · 1");
  await expect(page.locator('[data-search-group="loop"] .search-group-title')).toHaveText("伏笔 · 1");
  await expect(page.locator('[data-search-group="other"] .search-group-title')).toHaveText("其他文件 · 1");
});

test("story records and both relationship workbenches share scoped evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    detailCanon: {
      facts: [
        { id: "f-level", key: "林玄.等级", value: "五级", entity: "林玄", category: "system", locked: true, status: "active", firstChapter: "第一章", lastChapter: "第三章", evidence: "石碑显示五级" },
        { id: "f-station", key: "旧站.位置", value: "城西", entity: "旧站", category: "location", locked: false, dynamic: true, status: "active", firstChapter: "第二章", lastChapter: "第二章", evidence: "地图标注城西" },
      ],
      conflicts: [{ key: "林玄.等级", kept: "五级", attempted: "七级", reason: "numeric_mismatch", chapter: "第三章" }],
    },
    plotLoops: [
      { id: "loop-bell", type: "mystery", summary: "午夜钟声来源", status: "open", openedChapter: "第一章", lastChapter: "第三章", evidence: "钟楼无人却响钟", target: "第五章" },
      { id: "loop-letter", type: "promise", summary: "寄出旧信", status: "resolved", openedChapter: "第二章", lastChapter: "第四章", resolvedChapter: "第四章", evidence: "信封火漆", resolutionEvidence: "收件人当面拆信" },
    ],
    continuityIssues: [
      { id: "issue-time", type: "chronology", severity: "blocker", status: "open", summary: "钟声先后矛盾", evidence: "正文写钟声结束后抵达", expected: "Canon：钟声前已抵达", suggestion: "统一抵达时点", firstChapter: "第三章", lastChapter: "第三章" },
      { id: "issue-place", type: "geography", severity: "major", status: "handled", summary: "旧站方向已修正", evidence: "正文改为城西", expected: "旧站.位置=城西", resolution: "作者已修正", firstChapter: "第二章", lastChapter: "第四章", resolvedChapter: "第四章" },
    ],
    continuityMeta: { loopSchema: 1, issueSchema: 1, entitySchema: 1 },
    graph: {
      nodes: [
        { id: "lin", label: "林玄", type: "character", chapter: "第一章" },
        { id: "su", label: "苏禾", type: "character", chapter: "第一章" },
        { id: "yan", label: "严策", type: "character", chapter: "第二章" },
      ],
      edges: [
        { source: "lin", target: "su", relationship: "敌对转合作", chapter: "第一章", evidence: "共同脱险", occurrence: 2 },
        { source: "su", target: "yan", relationship: "盟友", chapter: "第二章", evidence: "交换情报", occurrence: 1 },
      ],
    },
  });

  await page.locator('.topbar [data-section="story"]').click();
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  await page.locator('#view-control [data-go-mode="control"]').click();
  await page.locator("#view-control summary", { hasText: "细节设定" }).click();
  await page.locator("#canonTypeFilter").selectOption("system");
  await expect(page.locator("#canonFilterStats")).toHaveText("1 / 3 条");
  await expect(page.locator("#canonView .story-record")).toHaveCount(1);
  await expect(page.locator("#canonView")).toContainText("第三章");

  await page.locator("#view-control summary", { hasText: "钩子生命周期" }).click();
  await page.locator("#loopStatusFilter").selectOption("open");
  await expect(page.locator("#loopFilterStats")).toHaveText("1 / 2 条");
  await expect(page.locator("#loopView")).toContainText("午夜钟声来源");

  await page.locator("#view-control summary", { hasText: "连续性风险" }).click();
  await page.locator("#continuityStatusFilter").selectOption("open");
  await page.locator("#continuitySeverityFilter").selectOption("blocker");
  await expect(page.locator("#continuityFilterStats")).toHaveText("1 / 2 条");
  await expect(page.locator("#continuityView")).toContainText("正文证据");
  await expect(page.locator("#continuityView")).toContainText("Canon 证据");

  await page.keyboard.press("Alt+3");
  await expect(page.locator("#edgeTable tbody tr")).toHaveCount(2);
  await page.locator("#nodeList button", { hasText: "林玄" }).click();
  await expect(page.locator("#edgeTable tbody tr")).toHaveCount(1);
  await expect(page.locator("#graphProfile")).toContainText("林玄");
  await expect(page.locator("#graphTimeline")).toContainText("敌对转合作");
  await expect(page.locator("#graphTimeline")).not.toContainText("盟友");
  await page.locator("#btnGraphClearSelection").click();
  await expect(page.locator("#edgeTable tbody tr")).toHaveCount(2);

  await page.locator('.topbar [data-section="analyze"]').click();
  await expect(page.locator("#anNodeList button")).toHaveCount(3);
  await expect(page.locator("#anEdgeTable tbody tr")).toHaveCount(2);
  await page.locator("#anNodeList button", { hasText: "林玄" }).click();
  await expect(page.locator("#anEdgeTable tbody tr")).toHaveCount(1);
  await expect(page.locator("#anProfile")).toContainText("林玄");
  await expect(page.locator("#anTimeline")).toContainText("敌对转合作");
  await expect(page.locator("#anTimeline")).not.toContainText("盟友");
  await page.locator("#btnAnClearSelection").click();
  await expect(page.locator("#anEdgeTable tbody tr")).toHaveCount(2);
});

test("chapter-cycle stages drive the four-step composer and stop controls", async ({ page }) => {
  const streamed = "林玄在钟声前抵达旧站。门后有人。";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    locks: { logline: "林玄必须在钟声前抵达旧站", forbidden: [], mustHonor: [], lockedFields: ["logline"] },
    tasks: [{ id: "t-stage", order: 1, chapter_title: "钟声之前", goal: "抵达旧站", conflict: "守门人阻拦", beats: ["入城", "追钟"], must_include: [], must_not: [], hook_end: "门后有人", status: "pending" }],
    activeTaskId: "t-stage",
    chapters: [{ id: "ch-stage", order: 1, title: "钟声之前", taskId: "t-stage", body: "", updatedAt: Date.now() }],
    activeChapterId: "ch-stage",
  });
  await page.keyboard.press("Control+1");
  await page.locator("#btnSettings").click();
  await page.locator('[data-settings-target="continuity"]').click();
  await page.locator("#cfgChapterBeat").uncheck();
  await page.locator("#btnCloseSettings").click();
  for (const id of ["btnStopPipe", "btnStopAuto", "btnStop"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  // 只桩 chat/chatJson（及 retrieve 的 hold）。autoChapterCycle / harness 保持真流水线，
  // 才能拦住叠章、半截完章落盘、停止后把 textarea 清掉。
  await page.evaluate((body) => {
    const waitForAdvance = (signal) =>
      new Promise((resolve, reject) => {
        const fail = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) return fail();
        const onAbort = () => fail();
        signal?.addEventListener("abort", onAbort, { once: true });
        window.__advanceChapterStage = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    const retrieveHybrid = window.NOVEL_RAG.retrieveHybrid.bind(window.NOVEL_RAG);
    window.NOVEL_RAG.retrieveHybrid = async (project, task, cfg, opts = {}) => {
      await waitForAdvance(opts.signal);
      return retrieveHybrid(project, task, cfg, opts);
    };
    window.NOVEL_API.chat = async (options) => {
      options.onDelta?.(body, body);
      await waitForAdvance(options.signal);
      return { content: body };
    };
    window.NOVEL_API.chatJson = async (options) => {
      await waitForAdvance(options.signal);
      return {
        issues: [],
        verdict: "pass",
        summary: "林玄抵达旧站",
        task_coverage: { completed: ["抵达旧站"], missing: [] },
        happened: ["林玄抵达旧站"],
        chapter: "钟声之前",
        relation_changes: [],
        new_info: [],
        must_carry: [],
        open_loops: [],
        appeared: [],
        canon_facts: [],
        next_direction: "进门",
        storyline_position: "旧站门口",
        nodes: [],
        edges: [],
      };
    };
  }, streamed);

  await page.locator("#btnGenerate").click();
  await expect(page.locator("#btnStop")).toBeVisible();
  for (const stage of ["context", "model", "review", "handoff"]) {
    await expect(page.locator(`[data-gen-stage="${stage}"]`)).toHaveClass(/active/);
    if (stage === "model") {
      await expectManuscriptText(page.locator("#manuscript"), streamed);
    }
    if (stage !== "handoff") {
      await page.evaluate(() => window.__advanceChapterStage?.());
    }
  }
  const beforeStop = await readChapterOnDisk(page, "ch-stage");
  expect(beforeStop.body.trim(), "cycle must not flushProject a half-written chapter before stop").toBe("");
  expect(beforeStop.chapterCount).toBe(1);
  await page.locator("#btnStop").click();
  await expect(page.locator("#statusChip")).toHaveText("已停止");
  await expectManuscriptText(page.locator("#manuscript"), streamed);
  for (const id of ["btnStopPipe", "btnStopAuto", "btnStop"]) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect
    .poll(async () => {
      const disk = await readChapterOnDisk(page, "ch-stage");
      const body = disk.body.trim();
      if (body && body !== streamed) return `partial:${body}`;
      if (disk.handoffStatus === "done") return "handoff-done";
      if (disk.taskStatus === "done" || disk.taskStatus === "digested") return `task-${disk.taskStatus}`;
      if (disk.chapterCount !== 1) return `chapters:${disk.chapterCount}`;
      if (body === streamed && disk.raw && !/^---[\s\S]*\n---/.test(disk.raw)) return "torn-md";
      if (body === streamed && disk.raw.includes(`${streamed}${streamed}`)) return "stacked";
      return "ok";
    })
    .toBe("ok");
  await expectManuscriptText(page.locator("#manuscript"), streamed);
});

test("strict retrieval failure remains a visible blocked author state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [{ id: "ch-history", order: 1, title: "旧站来信", taskId: null, body: "林玄已经读完旧信，并记住午夜钟声。", handoffStatus: "done", updatedAt: Date.now() }],
    activeChapterId: "ch-history",
  });
  await page.keyboard.press("Control+1");
  await page.locator("#btnSettings").click();
  await page.locator('[data-settings-target="retrieval"]').click();
  await page.locator("#cfgRag").check();
  await page.locator("#cfgRagStrict").check();
  await page.locator("#btnCloseSettings").click();
  await page.evaluate(() => {
    window.__strictAlert = "";
    window.alert = (message) => {
      window.__strictAlert = String(message || "");
    };
    window.NOVEL_HARNESS.prepareAndRetrieve = async () => {
      const error = new Error("严格连续性模式：故事索引不可用");
      error.code = "RAG_REQUIRED";
      throw error;
    };
    window.NOVEL_HARNESS.hasPriorWrittenStory = () => true;
  });
  await page.locator("#composeMode").selectOption("continue");
  await page.locator("#btnGenerate").click();
  await expect(page.locator("#statusChip")).toHaveText("故事记忆未就绪 · 已停止生成");
  await expect(page.locator("#btnStop")).toBeHidden();
  await page.locator("#tab-inspector-memory").click();
  await expect(page.locator("#contextHealth")).toHaveAttribute("data-state", "blocked");
  await expect(page.locator("#contextHealthLabel")).toHaveText("严格策略已阻断");
  await expect(page.locator("#contextHealthGrid")).toContainText("严格策略阻断");
  expect(await page.evaluate(() => window.__strictAlert)).toContain("故事索引不可用");

  await page.locator("#btnSettings").click();
  await page.locator('[data-settings-target="retrieval"]').click();
  await page.locator("#cfgRagStrict").uncheck();
  await page.locator("#btnCloseSettings").click();
});

test("chapter header exposes save, handoff, context health and story-memory jump", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [{ id: "t-header", order: 1, chapter_title: "旧站钟声", goal: "确认钟声来源", pov: "林玄", status: "done" }],
    activeTaskId: "t-header",
    chapters: [{ id: "ch-header", order: 1, title: "旧站钟声", taskId: "t-header", body: "林玄在午夜前抵达旧站。", handoffStatus: "done", updatedAt: Date.now() }],
    activeChapterId: "ch-header",
    memoryRoll: [{ chapter: "旧站钟声", summary: "林玄抵达旧站" }],
  });
  await page.keyboard.press("Control+1");
  const manuscript = page.locator("#manuscript");
  await expect(manuscript).toHaveValue(/林玄在午夜前抵达旧站/);
  await expect(page.locator("#chapterHandoffState")).toHaveText("已交接");
  await manuscript.fill("林玄在午夜前抵达旧站。又确认存盘。");
  await expect(page.locator("#chapterSaveState")).toHaveText("未存盘");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expect(page.locator("#chapterHandoffState")).toHaveText("待交接");
  await expect(page.locator("#ribbonHealth")).toContainText("健康");
  await expect(page.locator("#narrativeRibbon")).not.toContainText("交接");

  const moreSummary = page.locator("#chapterMore > summary");
  await expect(moreSummary).toHaveAttribute("aria-expanded", "false");
  await moreSummary.click();
  await expect(moreSummary).toHaveAttribute("aria-expanded", "true");
  await moreSummary.click();

  await page.locator("#tab-inspector-memory").click();
  await page.locator("#btnMemoryStoryCenter").click();
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  await expect(page.locator("#memoryView")).toBeVisible();
  await expect(page.locator("#memoryView").locator("xpath=ancestor::details[1]")).toHaveAttribute("open", "");
});

test("annotation revision commits only a complete result and preserves the draft on failure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const original = "林玄推开旧站的门，钟声仍在远处。";
  const revised = "林玄没有立刻推门。他听完第三记钟声，才让旧站的门在掌下缓缓退开。";
  await installProjectFixture(page, {
    tasks: [{ id: "t-revise", order: 1, chapter_title: "旧站门前", goal: "进入旧站", status: "done" }],
    activeTaskId: "t-revise",
    chapters: [{ id: "ch-revise", order: 1, title: "旧站门前", taskId: "t-revise", body: original, handoffStatus: "done", updatedAt: Date.now() }],
    activeChapterId: "ch-revise",
  });
  await page.keyboard.press("Control+1");
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await expect(page.locator("#composeMode")).toBeVisible();
  const loadedOriginal = await page.locator("#manuscript").inputValue();
  expect(loadedOriginal.trim()).toBe(original);
  await page.evaluate((completeRevision) => {
    window.__revisionAttempt = 0;
    window.__revisionAlert = "";
    window.alert = (message) => {
      window.__revisionAlert = String(message || "");
    };
    window.NOVEL_API.chat = async (options) => {
      window.__revisionAttempt += 1;
      options.onDelta?.("半", "只返回了一半的修订稿");
      if (window.__revisionAttempt === 1) throw new Error("模拟上游中断");
      options.onDelta?.("完", completeRevision);
      return { content: completeRevision };
    };
  }, revised);

  await page.locator("#composeMode").selectOption("annotate");
  await expect(page.locator("#btnGenerate")).toHaveText("根据批注修订");
  await page.locator("#instruction").fill("让人物先听完第三记钟声，再推门。");
  await page.locator("#btnGenerate").click();
  await expect(page.locator("#statusChip")).toHaveText("修订失败 · 原稿已保留");
  await expect(page.locator("#manuscript")).toHaveValue(loadedOriginal);
  expect(await page.evaluate(() => window.__revisionAlert)).toContain("原稿已保留");

  await page.locator("#btnGenerate").click();
  await expect.poll(async () => (await page.locator("#manuscript").inputValue()).trim()).toBe(revised);
  // 这个 fixture 只桩了 chat，没桩 chatJson：修订后的自动交接会真失败。
  // 交接发起过并失败时，状态条和章头必须用同一套词，不能一边说失败一边说「待交接」。
  await expect(page.locator("#statusChip")).toHaveText("修订完成 · 交接失败，待重试");
  await expect(page.locator("#chapterHandoffState")).toHaveText("交接失败");
  await expect(page.locator("#chapterHandoffStatus")).toHaveAttribute("data-state", "failed");
  // 两次修订都会落盘。保存后不换基线的话，第二次会被判成「外部修改」，
  // 冲突弹窗会挡在作者和撤销按钮之间。
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expect(page.locator("#composerReview")).toBeVisible();
  await expect(page.locator("#composerReviewKicker")).toHaveText("批注修订");
  await expect(page.locator("#composerReviewMeta")).toContainText("字");
  await expect(page.locator("#btnUndoComposerResult")).toBeEnabled();
  await page.locator("#btnUndoComposerResult").click();
  await expect(page.locator("#composerReview")).toBeHidden();
  await expect(page.locator("#manuscript")).toHaveValue(loadedOriginal);
  await expect(page.locator("#chapterHandoffState")).toHaveText("已交接");
  await expect(page.locator("#btnStop")).toBeHidden();
});

test("saving one chapter twice in a session never fakes a disk conflict", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [{ id: "ch-twice", order: 1, title: "连存两次", taskId: null, body: "第一版正文。", handoffStatus: "done", updatedAt: Date.now() }],
    activeChapterId: "ch-twice",
  });
  await page.keyboard.press("Control+1");
  const manuscript = page.locator("#manuscript");
  await expect(manuscript).toHaveValue(/第一版正文/);

  // 每次保存都会重写章节文件、把磁盘 mtime 推新。客户端必须换掉乐观并发的基线，
  // 否则第二次保存会撞上自己刚写的文件，作者看到一个不存在的磁盘冲突。
  for (const draft of ["第二版正文，改过一次。", "第三版正文，又改一次。"]) {
    await manuscript.fill(draft);
    await page.locator("#btnSaveChapter").click();
    await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
    await expect(page.locator("#saveConflictModal")).toBeHidden();
  }

  const onDisk = await page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((p) => p.slug)?.slug;
    const book = await window.NOVEL_VAULT.loadBook(slug);
    return (book?.chapters || []).find((ch) => ch.id === "ch-twice")?.body || "";
  });
  expect(onDisk.trim()).toBe("第三版正文，又改一次。");
});

test("analysis progress uses author-facing recognition language", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBookReady(page);
  await page.locator('.topbar [data-section="analyze"]').click();
  await expect(page.locator("#anProgressLabel")).not.toContainText("idle");
  await page.locator("#anSourceText").fill("第一章 归站\n\n林玄在午夜回到旧站。\n\n第二章 门后\n\n门后传来熟悉的钟声。");
  await page.locator("#btnAnDetect").click();
  await expect(page.locator("#anProgressLabel")).toContainText("识别完成");
  await expect(page.locator("#anSummaryStatus")).toHaveText("章节已识别");
});

test("workspace keeps edits made during an in-flight save dirty", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBookReady(page);
  await page.locator('.topbar [data-section="workspace"]').click();
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.NOVEL_WORKSPACE.getSlug())).not.toBe("");
  await expect(page.locator("#wsFilePath")).not.toHaveText("未打开文件");
  await page.evaluate(async () => {
    const slug = window.NOVEL_WORKSPACE.getSlug();
    const path = `资料/保存竞态-${Date.now()}.md`;
    await window.NOVEL_VAULT.writeFile(slug, path, "# 保存竞态回归\n\n初始内容");
    await window.NOVEL_WORKSPACE.refreshTree(true);
    await window.NOVEL_WORKSPACE.openFile(path);
  });
  await expect(page.locator("#wsEditor")).not.toHaveAttribute("readonly", "");

  let delayed = false;
  await page.route("**/api/books/*/file*", async (route) => {
    if (route.request().method() === "PUT" && !delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    await route.continue();
  });

  const editor = page.locator("#wsEditor");
  await editor.fill("# 保存竞态回归\n\n第一版");
  await page.locator("#btnWsSave").click();
  await expect(page.locator("#wsStatus")).toContainText("保存中");
  await editor.fill("# 保存竞态回归\n\n第二版，必须保持未保存状态");
  await expect(page.locator("#wsStatus")).toContainText("仍有未保存修改");
  expect(await page.evaluate(() => window.NOVEL_WORKSPACE.isDirty())).toBe(true);

  await page.unroute("**/api/books/*/file*");
  await page.locator("#btnWsSave").click();
  await expect(page.locator("#wsStatus")).toContainText("已保存");
  expect(await page.evaluate(() => window.NOVEL_WORKSPACE.isDirty())).toBe(false);
});

test("switching books commits an unsaved non-chapter workspace file", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBookReady(page);
  await page.locator('.topbar [data-section="workspace"]').click();
  await expect.poll(() => page.evaluate(() => window.NOVEL_WORKSPACE.getSlug())).not.toBe("");
  await expect(page.locator("#wsFilePath")).not.toHaveText("未打开文件");
  await expect(page.locator("#wsEditor")).toHaveAttribute("readonly", "");
  await expect(page.locator("#wsFileMeta")).toContainText("系统镜像 · 只读");
  await expect(page.locator("#wsEditor")).toHaveAttribute("title", /系统生成镜像/);

  const before = await page.evaluate(async () => {
    const slug = window.NOVEL_WORKSPACE.getSlug();
    const path = `资料/切书回归-${Date.now()}.md`;
    await window.NOVEL_VAULT.writeFile(slug, path, "# 用户资料\n\n等待编辑");
    await window.NOVEL_WORKSPACE.refreshTree(true);
    await window.NOVEL_WORKSPACE.openFile(path);
    return { slug, path };
  });
  expect(before.slug).toBeTruthy();
  expect(before.path.startsWith("资料/")).toBe(true);
  await expect(page.locator("#wsEditor")).not.toHaveAttribute("readonly", "");

  const content = `# 切书存盘回归\n\n${Date.now()}`;
  await page.locator("#wsEditor").fill(content);
  expect(await page.evaluate(() => window.NOVEL_WORKSPACE.isDirty())).toBe(true);

  const created = await page.evaluate(async () => {
    const response = await fetch("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `切书回归-${Date.now()}`, idea: "" }),
    });
    if (!response.ok) throw new Error(`create book failed: ${response.status}`);
    return response.json();
  });

  await page.locator("#btnToggleLibrary").click();
  await page.locator("#btnLibRefresh").click();
  const target = page.locator(`.lib-main[data-slug="${created.slug}"]`);
  await expect(target).toBeVisible();
  await target.click();
  await expect.poll(() => page.evaluate(() => window.NOVEL_WORKSPACE.getSlug())).toBe(created.slug);

  const disk = await page.evaluate(
    ({ slug, path }) => window.NOVEL_VAULT.readFile(slug, path),
    before
  );
  expect(disk.content).toBe(content);
});

test("synchronous close flush preserves dirty state on HTTP failure", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBookReady(page);
  await page.locator('.topbar [data-section="workspace"]').click();
  await page.evaluate(async () => {
    const slug = window.NOVEL_WORKSPACE.getSlug();
    const path = `资料/关窗失败-${Date.now()}.md`;
    await window.NOVEL_VAULT.writeFile(slug, path, "# 关窗保存失败回归\n\n初始内容");
    await window.NOVEL_WORKSPACE.refreshTree(true);
    await window.NOVEL_WORKSPACE.openFile(path);
  });
  await page.locator("#wsEditor").fill("# 关窗保存失败回归\n\n这段内容不能静默丢失");

  const failed = await page.evaluate(() => {
    const NativeXhr = window.XMLHttpRequest;
    class FailedXhr {
      status = 409;
      open() {}
      setRequestHeader() {}
      send() {}
    }
    window.XMLHttpRequest = FailedXhr;
    try {
      return {
        flushed: window.__mogaoFlushSync(),
        dirty: window.NOVEL_WORKSPACE.isDirty(),
      };
    } finally {
      window.XMLHttpRequest = NativeXhr;
    }
  });
  expect(failed).toEqual({ flushed: false, dirty: true });

  const succeeded = await page.evaluate(() => ({
    flushed: window.__mogaoFlushSync(),
    dirty: window.NOVEL_WORKSPACE.isDirty(),
  }));
  expect(succeeded).toEqual({ flushed: true, dirty: false });
  const wsDisk = await page.evaluate(async () => {
    const slug = window.NOVEL_WORKSPACE.getSlug();
    const path = window.NOVEL_WORKSPACE.getOpenPath();
    const file = await window.NOVEL_VAULT.readFile(slug, path);
    return file?.content || "";
  });
  expect(wsDisk).toContain("这段内容不能静默丢失");

  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-flush-fail",
        order: 1,
        title: "关窗整本",
        taskId: null,
        body: "原稿。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-flush-fail",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  const chapterDraft = `关窗整本失败-${Date.now()}`;
  await page.locator("#manuscript").fill(chapterDraft);
  const failedBook = await page.evaluate(() => {
    const NativeXhr = window.XMLHttpRequest;
    class FailedBookXhr {
      status = 500;
      responseText = "";
      open() {}
      setRequestHeader() {}
      send() {}
    }
    window.XMLHttpRequest = FailedBookXhr;
    try {
      return {
        flushed: window.__mogaoFlushSync(),
        manuscript: document.getElementById("manuscript")?.value || "",
      };
    } finally {
      window.XMLHttpRequest = NativeXhr;
    }
  });
  expect(failedBook.flushed).toBe(false);
  expect(failedBook.manuscript).toContain(chapterDraft);

  const savedBook = await page.evaluate(() => window.__mogaoFlushSync());
  expect(savedBook).toBe(true);
  await expectManuscriptText(page.locator("#manuscript"), chapterDraft);
  const bookDisk = await readChapterOnDisk(page, "ch-flush-fail");
  expect(bookDisk.body.trim()).toBe(chapterDraft);
});

test("imported library metadata is rendered as text", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const payload = '<img id="stored-xss" src=x onerror="window.__storedXss=true">';
  const rendered = await page.evaluate((malicious) => {
    window.__storedXss = false;
    window.NOVEL_LIBRARY.renderSidebar(
      [{ slug: "safe-book", title: "Safe", chapters: malicious, stage: malicious }],
      ""
    );
    return {
      html: document.getElementById("libraryList").innerHTML,
      text: document.querySelector("#libraryList .lib-meta")?.textContent || "",
      injected: Boolean(document.getElementById("stored-xss")),
      executed: window.__storedXss,
    };
  }, payload);
  expect(rendered.injected).toBe(false);
  expect(rendered.executed).toBe(false);
  expect(rendered.text).toContain("<img");
  expect(rendered.html).toContain("&lt;img");
});

test("narrow write workspace uses accessible chapter and inspector drawers", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator('.topbar [data-section="write"]').click();

  async function assertWriteDrawer({ trigger, drawer, scrim, awayX }) {
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
    await expect(drawer).toHaveJSProperty("inert", true);
    await expect(scrim).toBeHidden();

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).not.toHaveAttribute("aria-hidden");
    await expect(drawer).toHaveJSProperty("inert", false);
    await expect(scrim).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
    await expect(drawer).toHaveJSProperty("inert", true);
    await expect(trigger).toBeFocused();
    await expect(scrim).toBeHidden();

    await trigger.click();
    await expect(scrim).toBeVisible();
    const box = await scrim.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(awayX(box), box.y + box.height / 2);
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
    await expect(trigger).toBeFocused();
    await expect(scrim).toBeHidden();
  }

  await assertWriteDrawer({
    trigger: page.locator("#btnOpenChapters"),
    drawer: page.locator("#writeChaptersDrawer"),
    scrim: page.locator("#writeChaptersScrim"),
    awayX: (box) => box.x + box.width - 8,
  });
  await assertWriteDrawer({
    trigger: page.locator("#btnOpenInspector"),
    drawer: page.locator("#writeTaskDrawer"),
    scrim: page.locator("#writeTaskScrim"),
    awayX: (box) => box.x + 8,
  });

  await page.locator("#btnOpenChapters").click();
  const drawer = page.locator("#writeChaptersDrawer");
  await expect(drawer).toHaveJSProperty("inert", false);
  const height = await drawer.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(900 - 120);
});

async function overwriteChapterOnDisk(page, chapterId, body) {
  return page.evaluate(
    async ({ chapterId, body }) => {
      const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
      const book = await window.NOVEL_VAULT.loadBook(slug);
      const ch = (book.chapters || []).find((item) => item.id === chapterId);
      if (!ch?._file) throw new Error("chapter has no _file after fixture save");
      const title = String(ch.title || "章").replace(/"/g, "");
      const md = `---\nid: "${ch.id}"\ntaskId: "${ch.taskId || ""}"\ntitle: "${title}"\norder: ${Number(ch.order) || 1}\nupdatedAt: ${Date.now()}\n---\n\n${body}\n`;
      await window.NOVEL_VAULT.writeFile(slug, ch._file, md);
      return { slug, file: ch._file };
    },
    { chapterId, body }
  );
}

async function readChapterOnDisk(page, chapterId) {
  return page.evaluate(async (id) => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    const book = await window.NOVEL_VAULT.loadBook(slug);
    const ch = (book?.chapters || []).find((item) => item.id === id);
    const task = (book?.tasks || []).find((item) => item.id === ch?.taskId);
    let raw = "";
    if (ch?._file) {
      const file = await window.NOVEL_VAULT.readFile(slug, ch._file);
      raw = file?.content || "";
    }
    return {
      body: String(ch?.body || ""),
      handoffStatus: String(ch?.handoffStatus || ""),
      taskStatus: String(task?.status || ""),
      chapterCount: (book?.chapters || []).length,
      file: String(ch?._file || ""),
      raw,
    };
  }, chapterId);
}

async function listChapterMarkdownPaths(page) {
  return page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    const tree = await window.NOVEL_VAULT.fileTree(slug);
    const folder = (tree.tree || []).find((node) => node.type === "dir" && (node.path === "章节" || node.name === "章节"));
    return (folder?.children || [])
      .filter((node) => node.type === "file" && String(node.name || "").endsWith(".md"))
      .map((node) => node.path)
      .sort();
  });
}

async function openWriteDeskWithChapter(page, { chapterId, title, body, viewport }) {
  await page.setViewportSize(viewport || { width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: chapterId,
        order: 1,
        title,
        taskId: null,
        body,
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: chapterId,
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
}

async function triggerRealSaveConflict(page, { chapterId, localBody, diskBody }) {
  await overwriteChapterOnDisk(page, chapterId, diskBody);
  await page.locator("#manuscript").fill(localBody);
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#saveConflictModal")).toBeVisible();
  await expect(page.locator("#saveConflictLocal")).toContainText(localBody);
  await expect(page.locator("#saveConflictDisk")).toContainText(diskBody);
}

function isWholeBookPut(request) {
  const pathName = new URL(request.url()).pathname.replace(/\/$/, "");
  return request.method() === "PUT" && /^\/api\/books\/[^/]+$/.test(pathName);
}

/** Hold the first whole-book PUT until released; freeze later book PUTs until allowed. */
async function holdWholeBookPuts(page) {
  let unlockFirst = () => {};
  let unlockRest = () => {};
  let firstSeen = false;
  let freezeRest = true;
  let notifyArrived = () => {};
  const arrived = new Promise((resolve) => {
    notifyArrived = resolve;
  });
  const firstGate = new Promise((resolve) => {
    unlockFirst = resolve;
  });
  const restGate = new Promise((resolve) => {
    unlockRest = resolve;
  });

  await page.route("**/api/books/**", async (route) => {
    const request = route.request();
    if (!isWholeBookPut(request)) {
      await route.continue();
      return;
    }
    if (!firstSeen) {
      firstSeen = true;
      notifyArrived(request);
      await firstGate;
      await new Promise((resolve) => setTimeout(resolve, 450));
    } else if (freezeRest) {
      await restGate;
    }
    await route.continue();
  });

  return {
    arrived,
    unlockFirst,
    allowLaterPuts() {
      freezeRest = false;
      unlockRest();
    },
  };
}

async function expectManuscriptText(locator, text) {
  await expect.poll(async () => (await locator.inputValue()).trim()).toBe(String(text).trim());
}

async function openStreamingFixture(page, extra = {}) {
  const chapterId = extra.chapterId || "ch-stream";
  const taskId = extra.taskId || "t-stream";
  const body = extra.body || "";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [{ id: taskId, order: 1, chapter_title: extra.title || "流式章", goal: "写完", status: "pending" }],
    activeTaskId: taskId,
    chapters: [
      { id: chapterId, order: 1, title: extra.title || "流式章", taskId, body, updatedAt: Date.now() },
      ...(extra.extraChapters || []),
    ],
    activeChapterId: chapterId,
  });
  await page.keyboard.press("Control+1");
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  return { chapterId, taskId };
}

async function installRafGate(page, mode) {
  await page.evaluate((gateMode) => {
    window.__rafQueue = [];
    let nextId = 1;
    window.requestAnimationFrame = (cb) => {
      const id = nextId++;
      if (gateMode === "swallow") return id;
      window.__rafQueue.push({ id, cb });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      window.__rafQueue = window.__rafQueue.filter((item) => item.id !== id);
    };
    window.__flushRaf = () => {
      const queued = window.__rafQueue.splice(0);
      for (const item of queued) item.cb(performance.now());
    };
  }, mode);
}

async function installHeldStream(page, { count, chunk = "字", chapterId = "ch-stream", replaceBody = true } = {}) {
  await page.evaluate(
    ({ count: tokenCount, chunk: token, chapterId: targetId, replaceBody: reset }) => {
      window.__inkwellStreamPaintCount = 0;
      window.__streamHold = null;
      window.__streamSend = null;
      window.__liveProject = null;
      window.__streamChapter = null;
      window.NOVEL_PIPELINE.autoChapterCycle = async (project, _cfg, task, hooks) => {
        window.__liveProject = project;
        const ch =
          project.chapters.find((item) => item.id === targetId) ||
          project.chapters.find((item) => item.taskId === task.id) ||
          project.chapters[0];
        window.__streamChapter = ch;
        if (reset) ch.body = "";
        const send = (piece) => {
          ch.body = `${ch.body || ""}${piece}`;
          hooks.onDelta?.(piece, ch.body, ch.id);
        };
        window.__streamSend = send;
        for (let i = 0; i < tokenCount; i++) send(token);
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          hooks.signal?.addEventListener("abort", onAbort, { once: true });
          window.__streamHold = () => {
            hooks.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        });
      };
    },
    { count, chunk, chapterId, replaceBody }
  );
}

async function waitUntilStreamHeld(page) {
  await expect.poll(() => page.evaluate(() => typeof window.__streamHold === "function")).toBe(true);
}

async function openUtilityMenu(page) {
  const menu = page.locator("#utilityMenu");
  const opened = await menu.evaluate((el) => el.open);
  if (!opened) await menu.locator("summary").click();
  await expect(page.locator("#btnReloadDisk")).toBeVisible();
}

async function reloadIgnoringUnload(page) {
  const handler = (dialog) => dialog.accept();
  page.on("dialog", handler);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
  } finally {
    page.off("dialog", handler);
  }
}

test("unsaved write-desk sentence survives a failed leave and a workspace roundtrip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-keep-local",
        order: 1,
        title: "切模式不丢稿",
        taskId: null,
        body: "磁盘上的旧稿。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-keep-local",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const manuscript = page.locator("#manuscript");
  await expect(manuscript).toHaveValue(/磁盘上的旧稿/);
  const localOnly = `内存独有句-${Date.now()}`;
  await manuscript.fill(localOnly);

  await page.route("**/api/books/**", async (route) => {
    const request = route.request();
    const pathName = new URL(request.url()).pathname.replace(/\/$/, "");
    if (request.method() === "PUT" && /^\/api\/books\/[^/]+$/.test(pathName)) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('.topbar [data-section="workspace"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await expect(manuscript).toHaveValue(localOnly);
  await page.unroute("**/api/books/**");

  await page.locator('.topbar [data-section="workspace"]').click();
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await expectManuscriptText(manuscript, localOnly);
  const onDisk = await page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    const book = await window.NOVEL_VAULT.loadBook(slug);
    return (book.chapters || []).find((item) => item.id === "ch-keep-local")?.body || "";
  });
  expect(onDisk.trim()).toBe(localOnly);
});

test("renaming a book keeps unsaved chapter text in the editor and after reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    title: "未存盘书名测试",
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-rename",
        order: 1,
        title: "改名章",
        taskId: null,
        body: "改名前的磁盘正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-rename",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const localOnly = `改名时未存盘-${Date.now()}`;
  await page.locator("#manuscript").fill(localOnly);

  const onRenameDialog = async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept("只改显示名");
    else await dialog.dismiss();
  };
  page.on("dialog", onRenameDialog);
  try {
    await page.locator("#btnToggleLibrary").click();
    await expect(page.locator("#libraryRail")).toHaveAttribute("aria-hidden", "false");
    await page.locator(".lib-item.active [data-act='rename']").click();
    await expectManuscriptText(page.locator("#manuscript"), localOnly);
  } finally {
    page.off("dialog", onRenameDialog);
  }
  const afterRename = await page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    const book = await window.NOVEL_VAULT.loadBook(slug);
    return (book.chapters || []).find((item) => item.id === "ch-rename")?.body || "";
  });
  expect(afterRename.trim()).toBe(localOnly);

  await reloadIgnoringUnload(page);
  await waitForBookReady(page);
  await page.locator('.topbar [data-section="write"]').click();
  await expect.poll(async () => {
    const value = await page.locator("#manuscript").inputValue();
    return value.includes(localOnly);
  }).toBe(true);
});

test("conflict dialog keeps the local draft after a disk mutation while pending", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-conflict",
        order: 1,
        title: "冲突章",
        taskId: null,
        body: "第一版已落盘。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-conflict",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const diskOnly = `磁盘独有句-${Date.now()}`;
  const localOnly = `写章台独有句-${Date.now()}`;
  await overwriteChapterOnDisk(page, "ch-conflict", diskOnly);
  await page.locator("#manuscript").fill(localOnly);
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#saveConflictModal")).toBeVisible();
  await expect(page.locator("#saveConflictLocal")).toContainText(localOnly);
  await expect(page.locator("#saveConflictDisk")).toContainText(diskOnly);

  await overwriteChapterOnDisk(page, "ch-conflict", `${diskOnly}\n外部又改了一次。`);
  await page.evaluate(async () => {
    await window.NOVEL_WORKSPACE.pollWatch?.();
  });
  await expect(page.locator("#saveConflictLocal")).toContainText(localOnly);
  await expect(page.locator("#saveConflictLocal")).not.toContainText("外部又改了一次");
});

test("save conflict keep-local then save again never fakes another conflict", async ({ page }) => {
  const localBody = "我的版本：钟声前抵达。";
  const diskBody = "外部新稿：钟声后才到。";
  await openWriteDeskWithChapter(page, {
    chapterId: "ch-keep-local-action",
    title: "覆盖磁盘",
    body: "共同起点。",
  });
  await triggerRealSaveConflict(page, { chapterId: "ch-keep-local-action", localBody, diskBody });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#btnConflictKeepLocal").click();
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expect.poll(async () => (await readChapterOnDisk(page, "ch-keep-local-action")).body.trim()).toBe(localBody);
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expectManuscriptText(page.locator("#manuscript"), localBody);

  await page.locator("#manuscript").fill("我的版本：钟声前抵达。再改一字。");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expect.poll(async () => (await readChapterOnDisk(page, "ch-keep-local-action")).body.trim()).toBe(
    "我的版本：钟声前抵达。再改一字。"
  );
});

test("save conflict use-disk replaces the editor and does not overwrite disk", async ({ page }) => {
  const localBody = "本地旧稿不该写回磁盘。";
  const diskBody = "磁盘新版应当出现在编辑器。";
  await openWriteDeskWithChapter(page, {
    chapterId: "ch-use-disk-action",
    title: "采用磁盘",
    body: "共同起点。",
  });
  await triggerRealSaveConflict(page, { chapterId: "ch-use-disk-action", localBody, diskBody });
  const putBodies = [];
  page.on("request", (request) => {
    if (isWholeBookPut(request)) putBodies.push(request.postData() || "");
  });
  await page.locator("#btnConflictUseDisk").click();
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expectManuscriptText(page.locator("#manuscript"), diskBody);
  await expect.poll(async () => (await readChapterOnDisk(page, "ch-use-disk-action")).body.trim()).toBe(diskBody);
  await expect(page.locator("#vaultStatus")).toContainText("已采用磁盘新版");
  expect(
    putBodies.some((body) => body.includes(localBody)),
    "use-disk must not PUT the rejected local draft back onto disk"
  ).toBe(false);
});

test("save conflict merge writes the textarea and keeps handoff stale", async ({ page }) => {
  const localBody = "内存稿左半。";
  const diskBody = "磁盘稿右半。";
  const merged = "合并稿：左右都保留。";
  await openWriteDeskWithChapter(page, {
    chapterId: "ch-merge-action",
    title: "手工合并",
    body: "共同起点。",
  });
  await triggerRealSaveConflict(page, { chapterId: "ch-merge-action", localBody, diskBody });
  await page.locator("#saveConflictMerge").fill(merged);
  await page.locator("#btnConflictSaveMerge").click();
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expectManuscriptText(page.locator("#manuscript"), merged);
  await expect.poll(async () => (await readChapterOnDisk(page, "ch-merge-action")).body.trim()).toBe(merged);
  await expect(page.locator("#chapterHandoffState")).toHaveText(/待交接|交接失败/);
  await page.locator("#manuscript").fill("合并稿：左右都保留。再存一次。");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
});

test("explicit disk reload drops unsaved text and does not resurrect it after reboot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-discard",
        order: 1,
        title: "丢弃章",
        taskId: null,
        body: "磁盘保留稿。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-discard",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const doomed = `将被丢弃的句子-${Date.now()}`;
  await page.route("**/api/books/**", async (route) => {
    const request = route.request();
    const pathName = new URL(request.url()).pathname.replace(/\/$/, "");
    if (request.method() === "PUT" && /^\/api\/books\/[^/]+$/.test(pathName)) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.locator("#manuscript").fill(doomed);
  await openUtilityMenu(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#btnReloadDisk").click();
  await expect(page.locator("#manuscript")).toHaveValue(/磁盘保留稿/);
  await expect(page.locator("#manuscript")).not.toHaveValue(new RegExp(doomed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await page.unroute("**/api/books/**");

  await reloadIgnoringUnload(page);
  await waitForBookReady(page);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#manuscript")).toHaveValue(/磁盘保留稿/);
  await expect(page.locator("#manuscript")).not.toHaveValue(new RegExp(doomed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("editing a beat plan marks the book dirty so reload warns before discarding it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-beat",
        order: 1,
        title: "细纲章",
        taskId: null,
        body: "有正文。",
        beatPlan: { scenes: [{ place: "旧地点", action: "旧动作", turn: "", sensory: "" }] },
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-beat",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  const inspectorTrigger = page.locator("#btnOpenInspector");
  if (await inspectorTrigger.isVisible()) await inspectorTrigger.click();
  else {
    const collapsed = page.locator("#writeTaskDrawer.is-collapsed .panel-collapse-btn");
    if (await collapsed.count()) await collapsed.click();
  }
  await page.locator("#tab-inspector-task").click();
  const place = page.locator('#beatSceneList [data-beat-field="place"]');
  await expect(place).toBeVisible();
  await place.fill("内存独有地点");
  let reloadMessage = "";
  page.once("dialog", async (dialog) => {
    reloadMessage = dialog.message();
    await dialog.dismiss();
  });
  await openUtilityMenu(page);
  await page.locator("#btnReloadDisk").click();
  await expect.poll(() => reloadMessage).toMatch(/未同步|丢弃/);
  await expect(place).toHaveValue("内存独有地点");
});

test("close-window flush adopts baselines so the next save is not a fake conflict", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-sync-flush",
        order: 1,
        title: "关窗基线",
        taskId: null,
        body: "关窗前。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-sync-flush",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await page.locator("#manuscript").fill("关窗同步正文。");
  const flushed = await page.evaluate(() => window.__mogaoFlushSync());
  expect(flushed).toBe(true);
  await page.locator("#manuscript").fill("关窗后再改一次。");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  const onDisk = await page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    const book = await window.NOVEL_VAULT.loadBook(slug);
    return (book.chapters || []).find((item) => item.id === "ch-sync-flush")?.body || "";
  });
  expect(onDisk.trim()).toBe("关窗后再改一次。");
});

test("overlapping book saves stay serial on the wire", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-serial",
        order: 1,
        title: "串行保存",
        taskId: null,
        body: "第一版。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-serial",
  });
  await page.locator('.topbar [data-section="write"]').click();
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route("**/api/books/**", async (route) => {
    const request = route.request();
    const pathName = new URL(request.url()).pathname.replace(/\/$/, "");
    if (request.method() === "PUT" && /^\/api\/books\/[^/]+$/.test(pathName)) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 350));
      inFlight -= 1;
    }
    await route.continue();
  });
  const manuscript = page.locator("#manuscript");
  await manuscript.fill("串行保存甲。");
  const first = page.locator("#btnSaveChapter").click();
  await manuscript.fill("串行保存乙。");
  const second = page.locator("#btnSaveChapter").click();
  await Promise.all([first, second]);
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  expect(maxInFlight).toBe(1);
  const onDisk = await page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    const book = await window.NOVEL_VAULT.loadBook(slug);
    return (book.chapters || []).find((item) => item.id === "ch-serial")?.body || "";
  });
  expect(onDisk.trim()).toBe("串行保存乙。");
});

test("manuscript stays dirty when typed during an in-flight chapter save", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-inflight-dirty",
        order: 1,
        title: "保存中改稿",
        taskId: null,
        body: "落盘前的原文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-inflight-dirty",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const manuscript = page.locator("#manuscript");
  const firstDraft = "保存中改出的第一版。";
  const secondDraft = "保存尚未返回时改出的第二版。";
  await expect(manuscript).toHaveValue(/落盘前的原文/);

  // Hold the whole-book PUT (not /file). Typing after the request is on the wire
  // is the real in-flight window; a /file delay would miss this path.
  const hold = await holdWholeBookPuts(page);
  await manuscript.fill(firstDraft);
  await page.locator("#btnSaveChapter").click();
  const firstPut = await hold.arrived;
  await expect(page.locator("#vaultStatus")).toContainText(/写入|手动存盘/);
  await expect(page.locator("#chapterSaveState")).toHaveText("未存盘");
  await manuscript.fill(secondDraft);
  expect(firstPut.postData() || "").toContain(firstDraft);
  expect(firstPut.postData() || "").not.toContain(secondDraft);

  // Clicking Save blurs the editor and queues a second flushToDisk. Freeze that
  // PUT so the first landing can be observed: disk still v1, editor v2, dirty.
  hold.unlockFirst();
  await expect.poll(async () => (await readChapterOnDisk(page, "ch-inflight-dirty")).body.trim()).toBe(firstDraft);
  await expectManuscriptText(manuscript, secondDraft);
  await expect(page.locator("#chapterSaveState")).toHaveText("未存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();

  hold.allowLaterPuts();
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  expect((await readChapterOnDisk(page, "ch-inflight-dirty")).body.trim()).toBe(secondDraft);
});

test("switching chapters writes the previous draft to the previous file", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const chapterABody = "甲章磁盘原文。";
  const chapterBBody = "乙章磁盘原文，切过来必须还在。";
  const draftA = "甲稿-只属于上一章。";
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-switch-a",
        order: 1,
        title: "甲章",
        taskId: null,
        body: chapterABody,
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
      {
        id: "ch-switch-b",
        order: 2,
        title: "乙章",
        taskId: null,
        body: chapterBBody,
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-switch-a",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const manuscript = page.locator("#manuscript");
  await expectManuscriptText(manuscript, chapterABody);
  await manuscript.fill(draftA);

  await page.locator("#chapterList button").filter({ hasText: "乙章" }).click();
  await expectManuscriptText(manuscript, chapterBBody);
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");

  const book = await page.evaluate(async () => {
    const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
    return window.NOVEL_VAULT.loadBook(slug);
  });
  const onDiskA = (book.chapters || []).find((item) => item.id === "ch-switch-a");
  const onDiskB = (book.chapters || []).find((item) => item.id === "ch-switch-b");
  expect(String(onDiskA?.body || "").trim()).toBe(draftA);
  expect(String(onDiskB?.body || "").trim()).toBe(chapterBBody);
  await expect(page.locator("#saveConflictModal")).toBeHidden();
});

test("autosave twice in a session never fakes a disk conflict", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-autosave-twice",
        order: 1,
        title: "自动存两次",
        taskId: null,
        body: "自动存第一版之前。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-autosave-twice",
  });
  await page.locator('.topbar [data-section="write"]').click();
  const manuscript = page.locator("#manuscript");
  const firstDraft = "自动存第一次正文。";
  const secondDraft = "自动存第二次正文，必须是最后一版。";
  await expect(manuscript).toHaveValue(/自动存第一版之前/);

  // Real autosaveDelayMs (default 1200). Completion signal is #chapterSaveState,
  // not a naked waitForTimeout. Do not click #btnSaveChapter.
  await manuscript.fill(firstDraft);
  await expect(page.locator("#chapterSaveState")).toHaveText("未存盘");
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘", { timeout: 20_000 });
  await expect(page.locator("#saveConflictModal")).toBeHidden();

  await manuscript.fill(secondDraft);
  await expect(page.locator("#chapterSaveState")).toHaveText("未存盘");
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘", { timeout: 20_000 });
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  expect((await readChapterOnDisk(page, "ch-autosave-twice")).body.trim()).toBe(secondDraft);
});

test("renaming a chapter then saving twice uses the new filename baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-rename-file",
        order: 1,
        title: "旧章名",
        taskId: null,
        body: "改名前的正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-rename-file",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#chapterTitle")).toHaveValue("旧章名");
  expect(await listChapterMarkdownPaths(page)).toEqual(["章节/001-旧章名.md"]);

  await page.locator("#chapterTitle").fill("新章名");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  expect(await listChapterMarkdownPaths(page)).toEqual(["章节/001-新章名.md"]);
  expect((await readChapterOnDisk(page, "ch-rename-file")).file).toBe("章节/001-新章名.md");

  const renamedBody = "改名后再改的正文，应写进新文件。";
  await page.locator("#manuscript").fill(renamedBody);
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  expect(await listChapterMarkdownPaths(page)).toEqual(["章节/001-新章名.md"]);
  const onDisk = await readChapterOnDisk(page, "ch-rename-file");
  expect(onDisk.file).toBe("章节/001-新章名.md");
  expect(onDisk.body.trim()).toBe(renamedBody);
  expect(onDisk.raw).toContain(renamedBody);
});

test("cold start to a persisted story section skips the default write flush", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-boot-conflict",
        order: 1,
        title: "启动冲突章",
        taskId: null,
        body: "磁盘上的启动稿。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-boot-conflict",
  });
  await page.evaluate(async () => {
    const project = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug);
    const chapter = (project.chapters || []).find((item) => item.id === "ch-boot-conflict");
    const ui = {
      schemaVersion: 4,
      hasChosenSection: true,
      activeSection: "story",
      storyMode: "control",
    };
    window.NOVEL_STORE.saveUiState(ui);
    await window.NOVEL_VAULT.putSettings({ uiState: ui });
    window.NOVEL_STORE.savePendingConflicts([
      {
        projectId: project.id,
        slug: project.slug,
        warning: { kind: "externalConflict", path: chapter._file || "章节/001-启动冲突章.md" },
        localChapter: { id: chapter.id, title: chapter.title, order: chapter.order, body: "启动前的本地稿" },
        diskChapter: { id: chapter.id, title: chapter.title, order: chapter.order, body: "启动前的磁盘稿" },
      },
    ]);
  });
  // persistUiState 防抖可能在本页把旧分区写回 settings；等它落地后再盖一次。
  await page.waitForTimeout(400);
  const persisted = await page.evaluate(async () => {
    const ui = {
      schemaVersion: 4,
      hasChosenSection: true,
      activeSection: "story",
      storyMode: "control",
    };
    window.NOVEL_STORE.saveUiState(ui);
    await window.NOVEL_VAULT.putSettings({ uiState: ui });
    const settings = await window.NOVEL_VAULT.settings();
    return settings.uiState || {};
  });
  expect(persisted.hasChosenSection).toBe(true);
  expect(persisted.activeSection).toBe("story");
  expect(persisted.storyMode).toBe("control");

  const bookPuts = [];
  const alerts = [];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "beforeunload") {
      await dialog.accept();
      return;
    }
    alerts.push(dialog.message());
    await dialog.dismiss();
  });
  page.on("request", (request) => {
    if (isWholeBookPut(request)) bookPuts.push(new URL(request.url()).pathname);
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  expect(alerts, "boot must not alert when restored conflicts block a write-desk flush").toEqual([]);
  expect(bookPuts, "boot must not PUT the book just because view-write is the HTML default").toEqual([]);
});

test("leaving a clean write desk does not PUT the book", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-clean-switch",
        order: 1,
        title: "干净切页",
        taskId: null,
        body: "一字未改。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-clean-switch",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");

  const bookPuts = [];
  page.on("request", (request) => {
    if (isWholeBookPut(request)) bookPuts.push(new URL(request.url()).pathname);
  });
  await page.locator('.topbar [data-section="story"]').click();
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  expect(bookPuts, "a clean story switch must not rewrite every chapter file").toEqual([]);
});

test("target chapter count and lock checkboxes survive a write-desk workspace roundtrip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    targetChapters: 20,
    pitch: "",
    spine: { logline: "" },
    locks: { logline: "", forbidden: [], mustHonor: [], lockedFields: [] },
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-form-dirty",
        order: 1,
        title: "表单脏标记",
        taskId: null,
        body: "有正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-form-dirty",
  });

  await activate(page, "pipeline");
  await page.locator("#targetChapters").fill("42");
  await page.locator("#targetChapters").blur();
  await activate(page, "control");
  await page.locator("#lockWorld").check();
  await page.locator("#lockCast").check();
  await page.locator("#lockSpine").check();
  await page.locator("#lockSpine").blur();

  await activate(page, "write");
  await page.locator('.topbar [data-section="workspace"]').click();
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);

  // 先读磁盘：再切策划会把隐藏 input 里未落盘的值 sync 回内存，造成假绿。
  const readFormDisk = () =>
    page.evaluate(async () => {
      const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
      const book = await window.NOVEL_VAULT.loadBook(slug);
      return {
        targetChapters: Number(book.targetChapters),
        lockedFields: [...(book.locks?.lockedFields || [])].sort(),
      };
    });
  await expect.poll(async () => (await readFormDisk()).targetChapters).toBe(42);
  await expect.poll(async () => {
    const fields = (await readFormDisk()).lockedFields;
    return ["world", "cast", "spine"].every((id) => fields.includes(id));
  }).toBe(true);

  await activate(page, "pipeline");
  await expect(page.locator("#targetChapters")).toHaveValue("42");
  await activate(page, "control");
  await expect(page.locator("#lockWorld")).toBeChecked();
  await expect(page.locator("#lockCast")).toBeChecked();
  await expect(page.locator("#lockSpine")).toBeChecked();
});

test("graph json survives a write-desk workspace roundtrip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    graph: { nodes: [], edges: [] },
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-graph-dirty",
        order: 1,
        title: "图谱脏标记",
        taskId: null,
        body: "有正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-graph-dirty",
  });

  await activate(page, "graph");
  await page.locator("#graphJson").fill(JSON.stringify({ nodes: [{ id: "n-keep", name: "留图" }], edges: [] }, null, 2));
  await page.locator("#graphJson").blur();

  await activate(page, "write");
  await page.locator('.topbar [data-section="workspace"]').click();
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const slug = window.NOVEL_STORE.loadAll().projects.find((item) => item.slug)?.slug;
        const book = await window.NOVEL_VAULT.loadBook(slug);
        return (book.graph?.nodes || []).map((node) => node.id).join(",");
      })
    )
    .toBe("n-keep");

  await activate(page, "graph");
  await expect(page.locator("#graphJson")).toHaveValue(/n-keep/);
});

test("style dialogue stays split and a clean write desk still skips PUT", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    styleBible: { pov: "", tense: "", pacing: "缓", dialogue: "对话多", rules: [], forbiddenPhrases: [], examples: [] },
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-style-clean",
        order: 1,
        title: "风格干净切页",
        taskId: null,
        body: "一字未改。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-style-clean",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");

  const bookPuts = [];
  page.on("request", (request) => {
    if (isWholeBookPut(request)) bookPuts.push(new URL(request.url()).pathname);
  });
  await page.locator('.topbar [data-section="story"]').click();
  await expect(page.locator("#view-control")).toHaveClass(/active/);
  expect(bookPuts, "a book with dialogue must not PUT just because the style form opened").toEqual([]);

  await activate(page, "pipeline");
  await expect(page.locator("#stylePacing")).toHaveValue("缓");
  await expect(page.locator("#styleDialogue")).toHaveValue("对话多");
  await activate(page, "write");
  await activate(page, "pipeline");
  await expect(page.locator("#stylePacing")).toHaveValue("缓");
  await expect(page.locator("#styleDialogue")).toHaveValue("对话多");
});

test("concatenated style pacing is recovered without growing on reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    styleBible: {
      pov: "",
      tense: "",
      pacing: "缓；对话多；对话多",
      dialogue: "对话多",
      rules: [],
      forbiddenPhrases: [],
      examples: [],
    },
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-style-heal",
        order: 1,
        title: "风格修复",
        taskId: null,
        body: "有正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-style-heal",
  });
  await activate(page, "pipeline");
  await expect(page.locator("#stylePacing")).toHaveValue("缓");
  await expect(page.locator("#styleDialogue")).toHaveValue("对话多");
  await activate(page, "write");
  await activate(page, "pipeline");
  await expect(page.locator("#stylePacing")).toHaveValue("缓");
  await expect(page.locator("#styleDialogue")).toHaveValue("对话多");
});

async function hangThenProbeWorkspace(page, start, stayOn = "#view-write") {
  await start();
  await expect.poll(() => page.evaluate(() => !!window.__mogaoGen?.locked)).toBe(true);
  let alertMsg = "";
  page.once("dialog", async (dialog) => {
    alertMsg = dialog.message();
    await dialog.accept();
  });
  await page.evaluate(() => document.querySelector('.topbar [data-section="workspace"]')?.click());
  await expect(page.locator(stayOn)).toHaveClass(/active/);
  expect(alertMsg).toMatch(/生成中/);
}

async function startDigestThenRepairHang(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    continuityIssues: [
      {
        id: "issue-preempt-repair",
        type: "chronology",
        severity: "major",
        status: "open",
        summary: "时序待修",
        evidence: "旧抵达句",
        expected: "应在钟声前抵达",
      },
    ],
    chapters: [
      {
        id: "ch-preempt-lock",
        order: 1,
        title: "交接被顶替",
        taskId: null,
        body: "旧抵达句。",
        handoffStatus: "stale",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-preempt-lock",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  const inspectorTrigger = page.locator("#btnOpenInspector");
  if (await inspectorTrigger.isVisible()) await inspectorTrigger.click();
  await page.locator("#tab-inspector-continuity").click();
  await page.evaluate(() => {
    window.__releaseDigest = null;
    window.__releaseRepair = null;
    window.__repairHung = false;
    window.__repairAborted = false;
    window.NOVEL_PIPELINE.handoffChapter = async (_project, _cfg, _chapter, _task, hooks) => {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        hooks?.signal?.addEventListener("abort", onAbort, { once: true });
        window.__releaseDigest = () => {
          hooks?.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    };
    window.NOVEL_PIPELINE.repairChapterContinuity = async (_project, _cfg, chapter, _task, _issues, hooks) => {
      chapter.body = "内存独有修复稿";
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          window.__repairAborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        hooks?.signal?.addEventListener("abort", onAbort, { once: true });
        window.__repairHung = true;
        window.__releaseRepair = () => {
          hooks?.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
      return { applied: true };
    };
  });
  await page.locator("#chapterMore").click();
  await page.locator("#btnDigest").click();
  await expect.poll(() => page.evaluate(() => !!window.__mogaoGen?.locked)).toBe(true);
  await page.locator('[data-issue-action="repair"]').click();
  await expect.poll(() => page.evaluate(() => window.__repairHung === true)).toBe(true);
}

async function assertLockHeldAfterPredecessorAbort(page) {
  // 回退自证：若 withAbort finally 无条件 setGenLock(false)，先行者 AbortError 会在后继者仍 await 时把锁解开。
  const lockedSamples = [];
  for (let i = 0; i < 5; i += 1) {
    lockedSamples.push(await page.evaluate(() => !!window.__mogaoGen?.locked));
    await page.waitForTimeout(40);
  }
  expect(lockedSamples.every(Boolean)).toBe(true);
  // 回退自证：若 catch 不校验令牌，先行者会把状态栏写成「已停止」。
  await expect(page.locator("#statusChip")).not.toHaveText("已停止");
  await expect.poll(() => page.locator("#statusChip").textContent()).toMatch(/局部修复/);
}

test("digest lock keeps in-flight handoff when workspace is attempted", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-digest-lock",
        order: 1,
        title: "交接锁",
        taskId: null,
        body: "待交接的正文。",
        handoffStatus: "stale",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-digest-lock",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await page.evaluate(() => {
    window.__releaseHang = null;
    window.NOVEL_PIPELINE.handoffChapter = async (project, _cfg, chapter, _task, hooks) => {
      project._keepDigest = "内存独有交接";
      chapter.digest = "内存独有交接";
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        hooks?.signal?.addEventListener("abort", onAbort, { once: true });
        window.__releaseHang = () => {
          hooks?.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    };
  });
  await page.locator("#chapterMore").click();
  await hangThenProbeWorkspace(page, () => page.locator("#btnDigest").click());
  await page.evaluate(() => window.__releaseHang?.());
});

test("steer lock keeps in-flight correction when workspace is attempted", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    locks: { logline: "旧主线", forbidden: [], mustHonor: [], lockedFields: ["logline"] },
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-steer-lock",
        order: 1,
        title: "纠偏锁",
        taskId: null,
        body: "有正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-steer-lock",
  });
  await activate(page, "control");
  await page.evaluate(() => {
    window.__releaseHang = null;
    window.NOVEL_PIPELINE.authorSteer = async (project, _cfg, _note, opts) => {
      project.locks = { ...(project.locks || {}), logline: "内存独有纠偏" };
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        window.__releaseHang = () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
      return { editor_note: "ok" };
    };
  });
  await page.locator("#steerNote").fill("男主不能无脑");
  await hangThenProbeWorkspace(page, () => page.locator("#btnSteer").click(), "#view-control");
  await page.evaluate(() => window.__releaseHang?.());
});

test("continuity repair lock keeps in-flight body when workspace is attempted", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    tasks: [],
    activeTaskId: null,
    continuityIssues: [
      {
        id: "issue-repair-lock",
        type: "chronology",
        severity: "major",
        status: "open",
        summary: "时序待修",
        evidence: "旧抵达句",
        expected: "应在钟声前抵达",
      },
    ],
    chapters: [
      {
        id: "ch-repair-lock",
        order: 1,
        title: "修复锁",
        taskId: null,
        body: "旧抵达句。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-repair-lock",
  });
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  const inspectorTrigger = page.locator("#btnOpenInspector");
  if (await inspectorTrigger.isVisible()) await inspectorTrigger.click();
  await page.locator("#tab-inspector-continuity").click();
  await page.evaluate(() => {
    window.__releaseHang = null;
    window.NOVEL_PIPELINE.repairChapterContinuity = async (project, _cfg, chapter) => {
      chapter.body = "内存独有修复稿";
      await new Promise((resolve, reject) => {
        window.__releaseHang = resolve;
      });
      return { applied: true };
    };
  });
  await hangThenProbeWorkspace(page, () => page.locator('[data-issue-action="repair"]').click());
  await page.evaluate(() => window.__releaseHang?.());
});

test("preempted digest keeps repair lock and in-flight body across workspace", async ({ page }) => {
  await startDigestThenRepairHang(page);
  await assertLockHeldAfterPredecessorAbort(page);
  let alertMsg = "";
  page.once("dialog", async (dialog) => {
    alertMsg = dialog.message();
    await dialog.accept();
  });
  await page.evaluate(() => document.querySelector('.topbar [data-section="workspace"]')?.click());
  if (await page.locator("#view-workspace").evaluate((el) => el.classList.contains("active"))) {
    await page.locator('.topbar [data-section="write"]').click();
  }
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  expect(alertMsg).toMatch(/生成中/);
  expect(await page.evaluate(() => !!window.__mogaoGen?.locked)).toBe(true);
  await page.evaluate(() => window.__releaseRepair?.());
  // 回退自证：若先行者解开锁，上面切资料区会静默采纳磁盘，此处会回到「旧抵达句。」。
  await expect(page.locator("#manuscript")).toHaveValue("内存独有修复稿");
});

test("stop still aborts successor after digest was preempted", async ({ page }) => {
  await startDigestThenRepairHang(page);
  await assertLockHeldAfterPredecessorAbort(page);
  await expect(page.locator("#btnStop")).toBeVisible();
  await expect(page.locator("#btnStop")).toBeEnabled();
  await page.locator("#btnStop").click();
  // 回退自证：若先行者 finally 把 abortCtrl 置空，停止按钮对后继者失效，__repairAborted 不会为真。
  await expect.poll(() => page.evaluate(() => window.__repairAborted === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => !!window.__mogaoGen?.locked)).toBe(false);
  await expect(page.locator("#btnStop")).toBeHidden();
  await expect(page.locator("#statusChip")).toHaveText("已停止");
});

test("analysis marks the book dirty before persisting the new graph", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installProjectFixture(page, {
    graph: { nodes: [], edges: [] },
    tasks: [],
    activeTaskId: null,
    chapters: [
      {
        id: "ch-an-dirty",
        order: 1,
        title: "分析锁",
        taskId: null,
        body: "供分析的正文。",
        handoffStatus: "done",
        updatedAt: Date.now(),
      },
    ],
    activeChapterId: "ch-an-dirty",
  });
  await activate(page, "analyze");
  await page.evaluate(() => {
    window.__releaseHang = null;
    window.NOVEL_ANALYSIS.runAnalysis = async () => ({
      graph: { nodes: [{ id: "n-an-keep", label: "分析独有" }], edges: [] },
      extractions: [],
      meta: { status: "done" },
    });
    const vault = window.NOVEL_VAULT;
    const writeFile = vault.writeFile.bind(vault);
    vault.writeFile = async (slug, pathName, body) => {
      if (String(pathName).replace(/\\/g, "/").includes("graph.json")) {
        await new Promise((resolve) => {
          window.__releaseHang = resolve;
        });
      }
      return writeFile(slug, pathName, body);
    };
  });
  await page.locator("#btnAnLoadChapters").click();
  await page.locator("#btnAnStart").click();
  await expect.poll(() => page.locator("#anStatus").textContent()).toMatch(/聚合|保存分析/);
  await activate(page, "graph");
  await expect(page.locator("#graphJson")).toHaveValue(/n-an-keep/);
  await page.locator('.topbar [data-section="workspace"]').click();
  await expect(page.locator("#view-workspace")).toHaveClass(/active/);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await activate(page, "graph");
  await expect(page.locator("#graphJson")).toHaveValue(/n-an-keep/);
  await page.evaluate(() => window.__releaseHang?.());
});

test("streaming coalesces paints and flushes the full body when generation ends", async ({ page }) => {
  const tokens = 48;
  await openStreamingFixture(page, { chapterId: "ch-coalesce", taskId: "t-coalesce", title: "合并重画" });
  await installHeldStream(page, { count: tokens, chapterId: "ch-coalesce" });
  await page.locator("#btnGenerate").click();
  await waitUntilStreamHeld(page);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paints = await page.evaluate(() => window.__inkwellStreamPaintCount);
  expect(paints).toBeGreaterThan(0);
  expect(paints).toBeLessThan(8);
  expect(paints).toBeLessThan(tokens);
  await page.evaluate(() => window.__streamHold?.());
  await expect.poll(() => page.locator("#statusChip").textContent()).toMatch(/完成|交接/);
  await expectManuscriptText(page.locator("#manuscript"), "字".repeat(tokens));
});

test("streaming does not paint into another chapter and restores after switching back", async ({ page }) => {
  const otherBody = "另一章的原文，切过来不该被流式盖掉。";
  await openStreamingFixture(page, {
    chapterId: "ch-bleed",
    taskId: "t-bleed",
    title: "防串显",
    extraChapters: [{ id: "ch-other-bleed", order: 2, title: "另一章", taskId: null, body: otherBody, updatedAt: Date.now() }],
  });
  await installRafGate(page, "queue");
  await installHeldStream(page, { count: 20, chapterId: "ch-bleed" });
  await page.locator("#btnGenerate").click();
  await waitUntilStreamHeld(page);
  await page.evaluate((body) => {
    const other = window.__liveProject.chapters.find((item) => item.id === "ch-other-bleed");
    window.__liveProject.activeChapterId = "ch-other-bleed";
    document.getElementById("chapterTitle").value = other.title;
    document.getElementById("manuscript").value = body;
  }, otherBody);
  await page.evaluate(() => window.__flushRaf());
  await expectManuscriptText(page.locator("#manuscript"), otherBody);
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.__streamSend("乙");
  });
  await page.evaluate(() => window.__flushRaf());
  await expectManuscriptText(page.locator("#manuscript"), otherBody);
  expect(
    (await page.evaluate(() => window.__liveProject.chapters.find((item) => item.id === "ch-other-bleed").body)).trim()
  ).toBe(otherBody);
  await page.evaluate(() => {
    window.__liveProject.activeChapterId = "ch-bleed";
    window.__streamSend("回");
  });
  await page.evaluate(() => window.__flushRaf());
  const streamed = await page.evaluate(() => window.__streamChapter.body);
  expect(streamed).toContain("字");
  expect(streamed).toContain("乙");
  expect(streamed.trim().endsWith("回")).toBe(true);
  await expectManuscriptText(page.locator("#manuscript"), streamed);
  await page.evaluate(() => window.__streamHold?.());
  await expectManuscriptText(page.locator("#manuscript"), streamed);
});

test("abort flushes partial stream into the editor even when rAF never runs", async ({ page }) => {
  const tokens = 24;
  const original = "原文锚点，中止前不该被流式重画。";
  const marker = "半";
  await openStreamingFixture(page, {
    chapterId: "ch-abort-stream",
    taskId: "t-abort-stream",
    title: "中止冲刷",
    body: original,
  });
  await expectManuscriptText(page.locator("#manuscript"), original);
  await installRafGate(page, "swallow");
  await installHeldStream(page, { count: tokens, chunk: marker, chapterId: "ch-abort-stream" });
  await page.locator("#btnGenerate").click();
  await waitUntilStreamHeld(page);
  expect(await page.evaluate(() => window.__inkwellStreamPaintCount)).toBe(0);
  await expectManuscriptText(page.locator("#manuscript"), original);
  expect(await page.locator("#manuscript").inputValue()).not.toContain(marker);
  await page.locator("#btnStop").click();
  await expect(page.locator("#statusChip")).toHaveText("已停止");
  await expectManuscriptText(page.locator("#manuscript"), marker.repeat(tokens));
});


