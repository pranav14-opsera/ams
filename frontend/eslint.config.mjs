import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettierConfig from "eslint-config-prettier";

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = [
  ...nextCoreWebVitals,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // eslint-config-next/core-web-vitals bundles only 6 jsx-a11y
      // "recommended" rules — layering the full "strict" ruleset on top
      // is what the AC's "eslint-plugin-jsx-a11y for accessibility
      // linting" actually calls for.
      ...jsxA11y.configs.strict.rules,
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  prettierConfig,
  {
    ignores: [".next/**", "out/**", "node_modules/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
];

export default config;
