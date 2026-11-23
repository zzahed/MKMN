// ESLint flat config: the recommended JavaScript and typescript-eslint rules, and the two React
// hooks rules for the window. Errors fail `pnpm lint`; warnings do not.
//
// DEBT lists the rules the code broke when linting began, many times over. They warn instead of
// failing, so the lint gate can start at zero errors; each is a clean-up of its own (see the
// roadmap's follow-ups). Every other recommended rule is an error.
const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");

const DEBT = [
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-unused-vars",
  "@typescript-eslint/no-require-imports",
  "@typescript-eslint/no-unused-expressions",
  "@typescript-eslint/no-this-alias",
  "no-useless-escape",
  "no-useless-assignment",
  "no-control-regex",
  "no-empty",
  "no-irregular-whitespace",
  "no-regex-spaces",
  "preserve-caught-error",
  "prefer-const",
  "require-yield",
];

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/", "dist/", "build/", "target/", "src-tauri/target/", "src-tauri/gen/",
      "crates/", "docs/", "coverage/", ".superpowers/",
      "**/*.generated.ts", "**/*.min.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: Object.fromEntries(DEBT.map((rule) => [rule, "warn"])),
  },
  {
    // X blocks run in the page after src/core/xblocks/core.js, which defines X.
    files: ["src/core/xblocks/**/*.js"],
    languageOptions: { globals: { X: "readonly" } },
  },
  {
    files: ["src/renderer/public/capture-worklet.js"],
    languageOptions: { globals: globals.audioWorklet },
  },
  {
    // TypeScript already reports undefined names, with the real types in view.
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}", "**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
