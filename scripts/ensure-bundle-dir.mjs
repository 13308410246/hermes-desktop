// Create a placeholder resources/hermes-bundle/ directory so electron-builder
// doesn't fail when the bundle hasn't been built yet (dev / CI without bundle step).
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const p = join(process.cwd(), "resources", "hermes-bundle");
if (!existsSync(p)) mkdirSync(p, { recursive: true });
const f = join(p, "version.json");
if (!existsSync(f)) {
  writeFileSync(f, JSON.stringify({
    bundleVersion: "dev-placeholder",
    note: "Run scripts/bundle-hermes-backend.mjs to populate this directory"
  }, null, 2));
}
console.log(`[ensure-bundle-dir] resources/hermes-bundle/ ready`);
