import js from "@eslint/js";
import globals from "globals";

const correctnessRules = {
  ...js.configs.recommended.rules,
  // Phase 5 establishes correctness first. Existing unused declarations are architecture debt,
  // but treating them as release blockers would mix a cleanup campaign into this migration.
  "no-unused-vars": "off",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-irregular-whitespace": ["error", { skipRegExps: true }],
};

export default [
  {
    ignores: [
      "node_modules/**",
      "release/**",
      "src-tauri/ui-embed/**",
      "output/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    files: [
      "scripts/**/*.mjs",
      "playwright.config.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: correctnessRules,
  },
  {
    // Playwright callbacks are serialized into the page and legitimately use browser globals.
    files: ["scripts/playwright/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.nodeBuiltin, ...globals.browser },
    },
    rules: correctnessRules,
  },
];
