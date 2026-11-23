// ESLint flat config: the recommended JavaScript and typescript-eslint rules, and the two React
// hooks rules for the window. Errors fail `pnpm lint`; warnings do not.
//
// DEBT lists the rules the code broke when linting began, many times over. They warn instead of
// failing, so the lint gate can start at zero errors; each is a clean-up of its own (see the
// roadmap's follow-ups). Every other recommended rule is an error, and a rule leaves DEBT once
// the code no longer breaks it.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const DEBT = [
  "@typescript-eslint/no-explicit-any",
];

export default tseslint.config(
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
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...Object.fromEntries(DEBT.map((rule) => [rule, "warn"])),
      // ES5-style code (the X blocks) and async generator bodies reach `this` through `self`
      "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["self"] }],
      // a name kept on purpose starts with _ (a parameter a signature needs, `for (const _ of …)`);
      // `const { a, ...rest }` may drop `a` from rest
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // package.json has no "type": "module", so these scripts are CommonJS: require() is how they import
    files: ["**/*.cjs", "scripts/**/*.js", "tests/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // plain Node scripts: the browser-only globals (window, open, …) do not exist there
    files: ["scripts/*.cjs", "scripts/**/*.js", "tests/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries(Object.keys(globals.browser).filter((name) => !(name in globals.node)).map((name) => [name, "off"])),
    },
  },
  {
    // the X block smoke tests run their blocks in a page (jsdom); `open` is the harness's, not window.open
    files: ["scripts/xblocks-smoke/**"],
    languageOptions: { globals: { open: "off" } },
  },
  {
    // stand-in model streams in tests fail or finish before their first chunk on purpose;
    // mocks and partial stand-ins are typed `any` where spelling out the whole type adds nothing
    files: ["tests/**"],
    rules: { "require-yield": "off", "@typescript-eslint/no-explicit-any": "off" },
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
