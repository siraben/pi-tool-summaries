import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const temp = await mkdtemp(join(tmpdir(), "pi-summary-package-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run via npm run test:package");
const npm = (...args: string[]) =>
  execFileSync(process.execPath, [npmCli, ...args], { encoding: "utf8" });
try {
  const result = JSON.parse(
    npm("pack", "--ignore-scripts", "--json", "--pack-destination", temp),
  );
  const packed = Array.isArray(result)
    ? result[0]
    : result["pi-tool-summaries"];
  assert.ok(packed?.filename, "npm pack did not report a tarball");
  npm(
    "install",
    "--prefix",
    temp,
    join(temp, packed.filename),
    "--ignore-scripts",
    "--omit=peer",
    "--no-audit",
    "--no-fund",
  );
  const dist = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const { loadExtensions } = await import(
    pathToFileURL(join(dist, "core/extensions/loader.js")).href
  );
  const loaded = await loadExtensions(
    [join(temp, "node_modules/pi-tool-summaries/src/index.ts")],
    temp,
  );
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
  assert.ok(loaded.extensions[0].commands.has("tool-summaries"));
  console.log(
    `Installed and loaded ${packed.name}@${packed.version} through Pi`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
