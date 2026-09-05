import { expect, test } from "@playwright/test";

test("a restarted backend on a new origin recovers the disk book without browser cache", async ({ page }) => {
  const token = process.env.INKWELL_TEST_TOKEN || "";
  await page.goto(`/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => window.__mogaoReady === true)).toBe(true);
  await page.locator('.topbar [data-section="write"]').click();
  await expect(page.locator("#manuscript")).toHaveValue(/外部编辑器写入的磁盘新版/);
  await expect(page.locator("#chapterSaveState")).toHaveText("已存盘");
});
