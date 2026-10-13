// Native Node loading preserves filesystem-relative migrations and skill files
// for the server-only workspace packages. Node 26 can require these ESM modules.
import { createRequire } from "node:module";
import { resolve } from "node:path";
const nativeRequire = createRequire(resolve(process.cwd(), "package.json"));
export const persistence: typeof import("@dota/persistence") = nativeRequire("@dota/persistence");
export const jobs: typeof import("@dota/jobs") = nativeRequire("@dota/jobs");
