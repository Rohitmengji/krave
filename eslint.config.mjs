import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/sw.js",
      "next-env.d.ts",
      // Playwright writes bundled trace viewers here; linting them reports hundreds of false errors.
      "test-results/**",
      "playwright-report/**",
      "blob-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Catches the class of bug that shipped twice here: a value awaited or checked but unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "off",
      "no-console": ["error", { allow: ["warn", "error", "info"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Only the two classic rules: the plugin's React Compiler rules assume a compiler this
    // project does not run. Stale effect deps are warnings so existing code still lints.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Server modules read untyped SQLite rows, so explicit assertions are expected there.
    files: ["src/lib/server/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Developer scripts run under Node and are expected to print.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
    rules: {
      "no-console": "off",
    },
  }
);
