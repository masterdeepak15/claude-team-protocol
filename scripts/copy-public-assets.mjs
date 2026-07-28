// Plain Node script (not compiled by tsc) — copies the static UI assets
// (HTML/CSS/plain JS, nothing tsc touches) from teamhub/public/ into
// dist/teamhub/public/ after the TypeScript build, so buildHttpApp()'s
// express.static(PUBLIC_DIR) — resolved relative to the *compiled*
// dist/teamhub/server.js — finds them at runtime.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "teamhub", "public");
const dest = join(root, "dist", "teamhub", "public");

cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} -> ${dest}`);
