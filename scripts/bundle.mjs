// Bundles the daemon CLI + the four internal @planalot/* libraries into a single
// self-contained dist/cli.js, then drops the built web UI next to it as dist/web.
// This is what makes the package installable outside the pnpm workspace: esbuild
// inlines the workspace libraries so no @planalot/* bare imports survive. chokidar
// is the only real runtime dependency, so it stays external and is resolved from
// node_modules at install time.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist");
const outFile = resolve(outDir, "cli.js");
const entry = resolve(root, "packages/daemon/src/cli.ts");
const webSource = resolve(root, "apps/web/dist");
const webTarget = resolve(outDir, "web");

if (!existsSync(webSource)) {
  throw new Error(`Web build missing at ${webSource}. Run \`pnpm build\` before \`pnpm bundle\`.`);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // chokidar is the sole external; everything else (node builtins + @planalot/*) is inlined.
  external: ["chokidar"],
  logLevel: "info",
});

// Guarantee exactly one shebang regardless of esbuild's hashbang handling, then
// mark executable (no-op on Windows; npm sets the bit on install anyway).
let code = await readFile(outFile, "utf8");
if (!code.startsWith("#!")) {
  await writeFile(outFile, `#!/usr/bin/env node\n${code}`);
}
await chmod(outFile, 0o755).catch(() => undefined);

// Serve the web UI from dist/web — server.ts resolves it relative to import.meta.url.
await mkdir(webTarget, { recursive: true });
await cp(webSource, webTarget, { recursive: true });

console.log(`Bundled ${entry} -> ${outFile}`);
console.log(`Copied web UI ${webSource} -> ${webTarget}`);
