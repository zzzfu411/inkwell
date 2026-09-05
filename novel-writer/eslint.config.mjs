import { createRequire } from "node:module";

// The desktop repository owns the pinned Node toolchain; this source repository consumes it while
// both repositories remain adjacent. Keeping the config here gives ESLint v10 a correct base path.
const requireFromToolchain = createRequire(new URL("../mogao-tauri/package.json", import.meta.url));
const js = requireFromToolchain("@eslint/js");
const globals = requireFromToolchain("globals");

const correctnessRules = {
  ...js.configs.recommended.rules,
  "no-unused-vars": "off",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-irregular-whitespace": ["error", { skipRegExps: true }],
};

export default [
  {
    ignores: [".quality/**", "vault/**", "__pycache__/**"],
  },
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, module: "readonly" },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: correctnessRules,
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: correctnessRules,
  },
];
