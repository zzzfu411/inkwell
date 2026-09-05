import { expect, test } from "@playwright/test";

const token = process.env.INKWELL_TEST_TOKEN || "";

async function enterFormalBackend(page) {
  const entry = token ? `/?token=${encodeURIComponent(token)}` : "/";
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
}

async function waitForBookReady(page) {
  const created = await page.evaluate(async () => {
    const library = await window.NOVEL_VAULT.library();
    if ((library?.books || []).length) return false;
    await window.NOVEL_VAULT.createBook("Rust 正式后端 E2E", "");
    return true;
  });
  if (created) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  }
  await expect.poll(() => page.locator("#projectSelect option").count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator("#projectSelect").inputValue()).not.toBe("");
}

async function installChapter(page, chapterId, body) {
  await waitForBookReady(page);
  await page.evaluate(
    async ({ chapterId, body }) => {
      const state = window.NOVEL_STORE.loadAll();
      const selectedId = document.getElementById("projectSelect")?.value || state.activeId;
      const project = state.projects.find((item) => item.id === selectedId) || state.projects[0];
      Object.assign(project, {
        schemaVersion: 1,
        tasks: [],
        activeTaskId: null,
        chapters: [
          {
            id: chapterId,
            order: 1,
            title: `正式后端冲突章 ${chapterId}`,
            taskId: null,
            body,
            handoffStatus: "done",
            updatedAt: Date.now(),
          },
        ],
        activeChapterId: chapterId,
        clearChapters: true,
        updatedAt: Date.now(),
      });
      const saved = await window.NOVEL_VAULT.saveBook(project.slug, project);
      if (saved.saveWarnings?.length) throw new Error(JSON.stringify(saved.saveWarnings));
      delete project.clearChapters;
      window.NOVEL_STORE.saveAll(state);
    },
    { chapterId, body }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#view-write")).toHaveClass(/active/);
}

async function overwriteChapterFile(page, chapterId, body) {
  await page.evaluate(
    async ({ chapterId, body }) => {
      const state = window.NOVEL_STORE.loadAll();
      const selectedId = document.getElementById("projectSelect")?.value || state.activeId;
      const project = state.projects.find((item) => item.id === selectedId);
      const disk = await window.NOVEL_VAULT.loadBook(project.slug);
      const chapter = disk.chapters.find((item) => item.id === chapterId);
      if (!chapter?._file) throw new Error("formal E2E chapter has no file baseline");
      const markdown = `---\nid: "${chapter.id}"\ntaskId: ""\ntitle: "${chapter.title}"\norder: 1\nupdatedAt: ${Date.now()}\n---\n\n${body}\n`;
      const file = await window.NOVEL_VAULT.readFile(project.slug, chapter._file);
      await window.NOVEL_VAULT.writeFile(project.slug, chapter._file, markdown, file.revision);
    },
    { chapterId, body }
  );
}

test("first launch creates a disk book before any fixture and clearing text survives reload", async ({ page }) => {
  await enterFormalBackend(page);
  const library = await page.evaluate(() => window.NOVEL_VAULT.library());
  expect(library.books).toHaveLength(1);
  expect(library.books[0].slug).toBeTruthy();
  await page.locator('.topbar [data-section="write"]').click();
  await page.getByRole("button", { name: "新建第一章", exact: true }).click();
  await page.locator("#manuscript").fill("首次启动的作者正文。");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await expect(page.locator("#manuscript")).toHaveValue(/首次启动的作者正文/);
  await page.locator("#manuscript").fill("");
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await expect(page.locator("#manuscript")).toHaveValue("");
});

test("metadata conflict supports cancel and choosing disk settings without dropping the local chapter", async ({ page }) => {
  await enterFormalBackend(page);
  await installChapter(page, "metadata-chapter", "metadata baseline");
  await page.evaluate(async () => {
    const { books } = await window.NOVEL_VAULT.library();
    const disk = await window.NOVEL_VAULT.loadBook(books[0].slug);
    disk.locks.logline = "另一窗口保存的设定";
    await window.NOVEL_VAULT.saveBook(disk.slug, disk);
  });
  await page.locator("#manuscript").fill("必须保留的本地正文。");
  await page.locator("#btnSaveChapter").click();
  const conflict = page.getByRole("dialog", { name: "书籍设定存在保存冲突" });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "暂不处理" }).click();
  await expect(page.locator("#chapterSaveState")).toHaveText("未存盘");
  await page.locator("#btnSaveChapter").click();
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "采用磁盘版本" }).click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
  const saved = await page.evaluate(async () => {
    const { books } = await window.NOVEL_VAULT.library();
    return window.NOVEL_VAULT.loadBook(books[0].slug);
  });
  expect(saved.locks.logline).toBe("另一窗口保存的设定");
  expect(saved.chapters[0].body).toContain("必须保留的本地正文。");
});

test("formal Rust HTTP covers load, edit, save, external conflict and disk recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterFormalBackend(page);
  const chapterId = "rust-http-e2e-chapter";
  const baseline = "正式后端共同起点。";
  const firstEdit = "作者第一次编辑并保存。";
  const localConflict = "作者尚未保存的本地冲突稿。";
  const external = "外部编辑器写入的磁盘新版。";
  await installChapter(page, chapterId, baseline);

  await page.locator("#manuscript").fill(firstEdit);
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");

  await overwriteChapterFile(page, chapterId, external);
  await page.locator("#manuscript").fill(localConflict);
  await page.locator("#btnSaveChapter").click();
  await expect(page.locator("#saveConflictModal")).toBeVisible();
  await expect(page.locator("#saveConflictLocal")).toContainText(localConflict);
  await expect(page.locator("#saveConflictDisk")).toContainText(external);

  await page.locator("#btnConflictUseDisk").click();
  await expect(page.locator("#saveConflictModal")).toBeHidden();
  await expect.poll(async () => (await page.locator("#manuscript").inputValue()).trim()).toBe(external);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await page.locator('.topbar [data-section="write"]').click();
  await expect.poll(async () => (await page.locator("#manuscript").inputValue()).trim()).toBe(external);
  await expect(page.locator("#manuscript")).not.toContainText(localConflict);
});
