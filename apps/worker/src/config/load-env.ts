import { config as loadDotenv } from "dotenv";

/**
 * Side-effect module: loads the repo-root .env into process.env.
 *
 * This lives in its own file and is imported FIRST by the entry point, because
 * `import` declarations are hoisted — a bare `loadDotenv()` call sitting between
 * imports would run after every module in the graph had already been evaluated,
 * which silently breaks the moment any module reads process.env at import time.
 *
 * Real environment variables take precedence over the file, so this is inert in
 * production where the host injects configuration. Both paths are tried because
 * the working directory differs between running from the repo root and running
 * through turbo from the package directory.
 */
loadDotenv({ path: [".env", "../../.env"], quiet: true });
