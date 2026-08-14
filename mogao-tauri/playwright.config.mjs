import { defineConfig } from "@playwright/test";

const requestedBrowser = process.env.INKWELL_TEST_BROWSER || "msedge";
const browserUse =
  requestedBrowser === "firefox" || requestedBrowser === "webkit"
    ? { browserName: requestedBrowser }
    : {
        browserName: "chromium",
        channel: requestedBrowser === "chrome" ? "chrome" : "msedge",
      };

export default defineConfig({
  testDir: "./scripts/playwright",
  timeout: 90_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  outputDir: process.env.INKWELL_TEST_OUTPUT || "output/playwright/test-results",
  snapshotPathTemplate: "{testDir}/visual-baselines/{arg}{ext}",
  use: {
    ...browserUse,
    baseURL: process.env.INKWELL_TEST_BASE_URL || "http://127.0.0.1:8765/",
    headless: true,
    colorScheme: "light",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
