import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createFixture } from "../../../novel-writer/scripts/performance-budget.mjs";

const headers = { "X-Mogao-Token": process.env.INKWELL_TEST_TOKEN || "" };
for (const count of [20, 100, 400]) {
  test(`real Rust storage and editor latency with ${count} chapters`, async ({ page, request }, info) => {
    test.setTimeout(120000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const createdResponse = await request.post("/api/books", { headers, data: { title: `规模验证-${count}` } });
    expect(createdResponse.ok()).toBe(true);
    const created = await createdResponse.json();
    const fixture = { ...created, ...createFixture(count), schemaVersion: created.schemaVersion, id: created.id, slug: created.slug, _bookRevision: created._bookRevision };
    const endpoint = `/api/books/${encodeURIComponent(created.slug)}`;
    const metrics = { chapters: count, bytes: Buffer.byteLength(JSON.stringify(fixture)), writes: [], reads: [] };
    let book = fixture;
    for (let iteration = 0; iteration < 3; iteration++) {
      book.authorNote = `save iteration ${iteration}`;
      let start = performance.now();
      const saved = await request.put(endpoint, { headers, data: book });
      metrics.writes.push(performance.now() - start);
      expect(saved.ok(), await saved.text()).toBe(true);
      expect((await saved.json()).saveWarnings).toEqual([]);
      start = performance.now();
      const loaded = await request.get(endpoint, { headers });
      expect(loaded.ok()).toBe(true);
      book = await loaded.json();
      metrics.reads.push(performance.now() - start);
      expect(book.chapters).toHaveLength(count);
    }
    const ceiling = count === 400 ? 15000 : 8000;
    expect(Math.max(...metrics.writes)).toBeLessThan(ceiling);
    expect(Math.max(...metrics.reads)).toBeLessThan(ceiling);
    await page.addInitScript(() => {
      window.__scaleInputLatency = [];
      document.addEventListener("input", (event) => {
        if (event.target.id !== "manuscript") return;
        const started = performance.now();
        requestAnimationFrame(() => window.__scaleInputLatency.push(performance.now() - started));
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?token=${encodeURIComponent(headers["X-Mogao-Token"])}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
    await page.locator('.topbar [data-section="write"]').click();
    await expect(page.locator("#projectSelect")).toHaveValue(created.id);
    await expect(page.locator("#manuscript")).toBeEditable();
    await page.locator("#manuscript").pressSequentially("Actual keyboard input.");
    await expect.poll(() => page.evaluate(() => window.__scaleInputLatency.length)).toBeGreaterThan(0);
    metrics.inputToFrameMs = await page.evaluate(() => window.__scaleInputLatency);
    expect(Math.max(...metrics.inputToFrameMs)).toBeLessThan(500);
    await page.locator("#btnSaveChapter").click();
    expect(pageErrors).toEqual([]);
    await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
    const disk = await (await request.get(endpoint, { headers })).json();
    expect(disk.chapters.some((chapter) => chapter.body.includes("Actual keyboard input."))).toBe(true);
    await writeFile(info.outputPath(`storage-${count}.json`), JSON.stringify(metrics, null, 2));
  });
}
