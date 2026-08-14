import { expect, test } from "@playwright/test";

const cases = [
  { name: "write-1024", width: 1024, height: 768, scenario: "write" },
  { name: "write-1440", width: 1440, height: 900, scenario: "write" },
  { name: "settings-1024", width: 1024, height: 768, scenario: "settings" },
  { name: "settings-1440", width: 1440, height: 900, scenario: "settings" },
  { name: "story-1440", width: 1440, height: 900, scenario: "story" },
  { name: "conflict-1024", width: 1024, height: 768, scenario: "conflict" },
  { name: "workspace-640", width: 640, height: 800, scenario: "workspace" },
  { name: "write-risk-1024", width: 1024, height: 768, scenario: "write-risk" },
  { name: "write-generating-1024", width: 1024, height: 768, scenario: "write-generating" },
  { name: "write-blocked-1024", width: 1024, height: 768, scenario: "write-blocked" },
];
const themes = ["soft-paper", "ink-night", "qing-jian"];
const FIXTURE_VAULT_PATH = "C:\\inkwell\\visual-fixture-vault";

async function pinVisualVaultPath(page) {
  await page.evaluate((path) => {
    const cfg = document.getElementById("cfgVaultPath");
    if (cfg) cfg.value = path;
    const full = document.getElementById("vaultPathFull");
    if (full) {
      full.textContent = path;
      full.title = path;
    }
    const label = document.getElementById("vaultPathLabel");
    if (label) label.title = path;
    const meta = document.getElementById("cfgEngineMeta");
    if (meta) {
      const books = `${path}\\books`;
      meta.innerHTML = `<div>引擎：mogao</div><div>版本：v0.19.0</div><div>books：${books}</div><div>状态：已连接</div>`;
    }
  }, FIXTURE_VAULT_PATH);
}

async function activate(page, scenario) {
  await page.keyboard.press("Escape");
  if (scenario === "settings") {
    await page.locator("#btnSettings").click();
    await expect(page.locator("#settingsModal")).toBeVisible();
    await expect(page.locator("#cfgEngineMeta")).not.toContainText("加载中");
    return;
  }
  if (scenario === "workspace") {
    await page.locator('.topbar [data-section="workspace"]').click();
    await expect(page.locator("#view-workspace")).toHaveClass(/active/);
    return;
  }
  if (scenario === "story") {
    await page.locator('.topbar [data-section="story"]').click();
    await expect(page.locator("#view-control")).toHaveClass(/active/);
    return;
  }
  if (scenario === "conflict") {
    await page.locator('.topbar [data-section="write"]').click();
    await page.evaluate(() => {
      document.getElementById("saveConflictChapter").textContent = "第十二章 雨夜证词";
      document.getElementById("saveConflictPath").textContent = "章节/012-雨夜证词.md";
      document.getElementById("saveConflictQueue").textContent = "1 个冲突";
      document.getElementById("saveConflictLocal").textContent = "本地稿：她在钟声响起前抵达旧站。";
      document.getElementById("saveConflictDisk").textContent = "磁盘稿：她在钟声结束后才抵达旧站。";
      document.getElementById("saveConflictMerge").value = "她踩着最后一记钟声抵达旧站。";
      const modal = document.getElementById("saveConflictModal");
      modal.hidden = false;
      window.NOVEL_MODAL_A11Y?.sync?.(modal);
    });
    await expect(page.locator("#saveConflictModal")).toBeVisible();
    return;
  }
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
  await page.evaluate(() => {
    document.body.classList.remove("focus-mode");
    const issue = document.getElementById("ribbonIssues");
    issue.textContent = "安全";
    issue.closest("button")?.removeAttribute("data-tone");
    document.getElementById("continuityCount").textContent = "0";
    document.getElementById("continuityInspector").innerHTML = '<div class="empty-state compact success-state"><span class="empty-kicker">连续性稳定</span><strong>当前没有待处理风险。</strong></div>';
    const status = document.getElementById("statusChip");
    status.textContent = "就绪";
    status.className = "chip muted";
    const progress = document.getElementById("generationProgress");
    progress.hidden = true;
    progress.querySelectorAll("[data-gen-stage]").forEach((node) => node.classList.remove("active", "done", "failed"));
    const stop = document.getElementById("btnStop");
    stop.hidden = true;
    stop.disabled = true;
    const health = document.getElementById("contextHealth");
    health.removeAttribute("data-state");
    document.getElementById("contextHealthLabel").textContent = "待评估";
    document.getElementById("contextHealthBar").style.width = "0%";
  });
  if (scenario === "write-risk") {
    await page.evaluate(() => {
      document.getElementById("ribbonIssues").textContent = "2 高风险";
      document.getElementById("ribbonIssues").closest("button").dataset.tone = "danger";
      document.getElementById("continuityCount").textContent = "2";
      document.getElementById("continuityInspector").innerHTML = `
        <article class="continuity-card severity-blocker">
          <header><span class="severity-label">blocker</span><span>chronology</span></header>
          <h4>抵达旧站的时间与午夜钟声顺序冲突</h4>
          <dl><div><dt>正文证据</dt><dd>她在最后一记钟声结束后才推开站门。</dd></div><div><dt>Canon 证据</dt><dd>第三章已锁定：钟声响起前二人进入旧站。</dd></div></dl>
          <p class="issue-suggestion"><strong>建议</strong>统一为踩着最后一记钟声抵达。</p>
          <footer><button type="button" class="btn ghost xs">已处理</button><button type="button" class="btn ghost xs">忽略</button><button type="button" class="btn xs">局部修复</button></footer>
        </article>
        <article class="continuity-card severity-major">
          <header><span class="severity-label">major</span><span>knowledge</span></header>
          <h4>苏禾提前知道了尚未公开的站台编号</h4>
          <dl><div><dt>正文证据</dt><dd>“去四号站台。”她没有查看车票。</dd></div><div><dt>Canon 证据</dt><dd>人物状态：苏禾尚未读到密信。</dd></div></dl>
        </article>`;
    });
    await page.locator("#btnOpenInspector").click();
    await page.locator("#tab-inspector-continuity").click();
    return;
  }
  if (scenario === "write-generating") {
    await page.evaluate(() => {
      const status = document.getElementById("statusChip");
      status.textContent = "请求模型并生成正文…";
      status.className = "chip busy";
      const progress = document.getElementById("generationProgress");
      progress.hidden = false;
      progress.querySelectorAll("[data-gen-stage]").forEach((node) => {
        node.classList.remove("active", "done", "failed");
        if (node.dataset.genStage === "context") node.classList.add("done");
        if (node.dataset.genStage === "model") node.classList.add("active");
      });
      const stop = document.getElementById("btnStop");
      stop.hidden = false;
      stop.disabled = false;
      status.style.animation = "none";
      progress.style.animation = "none";
      progress.querySelectorAll("[data-gen-stage]").forEach((node) => {
        node.style.animation = "none";
        node.style.opacity = "1";
      });
      document.getElementById("manuscript").value = "钟声在雨里推开一圈涟漪。林玄写到这里，模型仍在续接下一段正文……";
    });
    return;
  }
  if (scenario === "write-blocked") {
    await page.evaluate(() => {
      const status = document.getElementById("statusChip");
      status.textContent = "故事记忆未就绪 · 已停止生成";
      status.className = "chip err";
      const progress = document.getElementById("generationProgress");
      progress.hidden = false;
      progress.querySelectorAll("[data-gen-stage]").forEach((node) => {
        node.classList.remove("active", "done", "failed");
        if (node.dataset.genStage === "context") node.classList.add("failed");
      });
      const health = document.getElementById("contextHealth");
      health.dataset.state = "blocked";
      document.getElementById("contextHealthLabel").textContent = "严格策略已阻断";
      document.getElementById("contextHealthBar").style.width = "36%";
      document.getElementById("contextHealthGrid").innerHTML = `
        <div><span>预算</span><strong>36%</strong></div>
        <div><span>Canon</span><strong>18 条</strong></div>
        <div><span>RAG</span><strong>严格策略阻断</strong></div>
        <div><span>裁剪</span><strong>无</strong></div>
        <div><span>交接</span><strong>待交接</strong></div>`;
      document.getElementById("memoryInspector").innerHTML = `<div class="empty-state compact"><span class="empty-kicker">需要作者处理</span><strong>故事索引不可用。请重建索引或切换为告警策略后重试。</strong><div class="empty-actions"><button type="button" class="btn">重建故事索引</button><button type="button" class="btn ghost">打开检索设置</button></div></div>`;
    });
    await page.locator("#btnOpenInspector").click();
    await page.locator("#tab-inspector-memory").click();
    return;
  }
}

test("approved editorial surfaces remain visually stable", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await page.addStyleTag({
    content: [
      "*,*::before,*::after{animation:none!important;animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}",
      ".grain{display:none!important;opacity:0!important;background:none!important}",
      ".chip.busy,.step.running,[data-gen-stage].active,.global-status.busy{animation:none!important;opacity:1!important}",
    ].join(""),
  });
  for (const item of cases) {
    await page.setViewportSize({ width: item.width, height: item.height });
    for (const theme of themes) {
      await activate(page, item.scenario);
      await pinVisualVaultPath(page);
      if (item.scenario === "settings") {
        await page.locator(`.theme-swatch[data-theme="${theme}"]`).click();
        await pinVisualVaultPath(page);
      } else {
        await page.evaluate((themeId) => document.documentElement.setAttribute("data-theme", themeId), theme);
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page).toHaveScreenshot(`${item.name}-${theme}.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true,
        maxDiffPixelRatio: 0.004,
        mask: [
          page.locator("#cfgVaultPath"),
          page.locator("#cfgEngineMeta"),
          page.locator("#vaultPathFull"),
          page.locator("#vaultPathLabel"),
        ],
        maskColor: "#C8C8C8",
      });
      if (item.scenario === "settings") {
        await page.locator("#btnCloseSettings").click();
        await expect(page.locator("#settingsModal")).toBeHidden();
      }
      if (item.scenario === "conflict") {
        await page.evaluate(() => {
          document.getElementById("saveConflictModal").hidden = true;
          window.NOVEL_MODAL_A11Y?.sync?.();
        });
      }
    }
  }
});
