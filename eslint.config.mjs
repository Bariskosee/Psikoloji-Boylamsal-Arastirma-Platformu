// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Single root ESLint configuration for the whole monorepo.
 *
 * The most important rules here are the ARCHITECTURAL BOUNDARY rules in the
 * per-directory blocks below. They enforce the one-way dependency direction
 * documented in STRUCTURE.md §3:
 *
 *   apps/participant ─┐
 *   apps/researcher  ─┼──▶ contracts ──▶ (nothing)
 *                     └──▶ i18n, ui
 *
 *   apps/api    ─┬──▶ domain ──▶ contracts
 *   apps/worker ─┘└──▶ db     ──▶ contracts
 *
 * A violation must fail CI. See ADR-001.
 */

const DOMAIN_PURITY_MESSAGE =
  "packages/domain must stay pure: it may import @lpr/contracts and nothing else. " +
  "No database, no framework, no I/O. See STRUCTURE.md §3 and ADR-001.";

const FRONTEND_MESSAGE =
  "Frontends must not import server-only packages. Talk to the API over HTTP. " +
  "See STRUCTURE.md §3.";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/next-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // BOUNDARY: packages/domain is pure. Contracts only. No clock access.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@lpr/db", "@lpr/db/*"], message: DOMAIN_PURITY_MESSAGE },
            { group: ["@lpr/ui", "@lpr/ui/*"], message: DOMAIN_PURITY_MESSAGE },
            { group: ["@lpr/i18n", "@lpr/i18n/*"], message: DOMAIN_PURITY_MESSAGE },
            { group: ["@nestjs/*"], message: DOMAIN_PURITY_MESSAGE },
            { group: ["drizzle-orm", "drizzle-orm/*"], message: DOMAIN_PURITY_MESSAGE },
            { group: ["pg", "pg-boss", "pg/*"], message: DOMAIN_PURITY_MESSAGE },
            { group: ["next", "next/*", "react", "react/*"], message: DOMAIN_PURITY_MESSAGE },
            {
              group: ["node:*", "fs", "path", "http", "https", "crypto"],
              message: DOMAIN_PURITY_MESSAGE,
            },
          ],
        },
      ],
      // A Clock is always injected, so multi-day and DST behaviour stays testable.
      // AGENT.md §17 red flag.
      //
      // Only the ZERO-ARGUMENT forms are banned, because those are the ones that
      // read the wall clock. `new Date(millis)` and `new Date("2026-01-01Z")`
      // derive an instant from a value the caller already had, which is exactly
      // what a Clock implementation and a test fixture need to do.
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Do not read the wall clock inside packages/domain. Accept an injected Clock instead. See AGENT.md §17.",
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            "Do not read the wall clock inside packages/domain. Accept an injected Clock instead. See AGENT.md §17.",
        },
        {
          selector: "MemberExpression[object.name='performance'][property.name='now']",
          message:
            "Do not read the wall clock inside packages/domain. Accept an injected Clock instead. See AGENT.md §17.",
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // BOUNDARY: packages/contracts is the leaf. It imports no workspace package.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lpr/*"],
              message:
                "packages/contracts is the dependency leaf and must not import any workspace package. See STRUCTURE.md §3.",
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // BOUNDARY: frontends never reach the database or the server domain layer.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["apps/participant/**/*.{ts,tsx}", "apps/researcher/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@lpr/db", "@lpr/db/*"], message: FRONTEND_MESSAGE },
            { group: ["@lpr/domain", "@lpr/domain/*"], message: FRONTEND_MESSAGE },
            { group: ["drizzle-orm", "drizzle-orm/*"], message: FRONTEND_MESSAGE },
            { group: ["pg", "pg-boss"], message: FRONTEND_MESSAGE },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // BOUNDARY: api and worker never import each other. They share via domain/db.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["apps/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lpr/worker", "@lpr/worker/*"],
              message:
                "apps/api must not import apps/worker. Share through packages/domain or packages/db. See STRUCTURE.md §3.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@lpr/api", "@lpr/api/*"],
              message:
                "apps/worker must not import apps/api. Share through packages/domain or packages/db. See STRUCTURE.md §3.",
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // NestJS: constructor injection is resolved through emitDecoratorMetadata,
  // which needs the injected class present at RUNTIME. `consistent-type-imports`
  // would rewrite those to `import type`, erasing the class and breaking DI at
  // startup with a confusing "Nest can't resolve dependencies" error. The rule
  // is off here rather than being fought file by file.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["apps/api/**/*.ts", "apps/worker/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },

  // Config files run in Node and may use CommonJS-ish globals.
  {
    files: ["**/*.config.{js,mjs,ts}", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // The service worker runs in a ServiceWorkerGlobalScope, not in a window and
  // not in Node. `self`, `caches` and `clients` are its globals; without them
  // declared here every line of the worker reads as an undefined reference.
  //
  // It is plain JavaScript on purpose: it is served verbatim from `public/`,
  // because a service worker's scope cannot exceed the path it was served from
  // and this one has to cover the whole origin (STRUCTURE.md §14).
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["apps/participant/public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        clients: "readonly",
        console: "readonly",
        fetch: "readonly",
      },
    },
  },

  // Build-time Node scripts: not shipped, not imported, run by hand.
  {
    files: ["**/scripts/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
