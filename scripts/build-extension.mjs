import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "extension", "content", "court-content.js")],
  bundle: true,
  format: "iife",
  outfile: resolve(root, "extension", "dist", "court-content.bundle.js"),
  logLevel: "info",
});
