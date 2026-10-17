import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Test the packed and installed payload, not a local directory symlink.
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "pi-summary-package-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this smoke test via npm run test:package");
function npm(...args: string[]): string {
  return execFileSync(process.execPath, [npmCli!, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
try {
  const [packed] = JSON.parse(
    npm("pack", "--ignore-scripts", "--json", "--pack-destination", temp),
  );
  const paths: string[] = packed.files.map(
    (file: { path: string }) => file.path,
  );
  for (const required of [
    "src/index.ts",
    "src/config.ts",
    "src/requests.ts",
    "README.md",
    "docs/before-after.svg",
    "docs/compatibility.md",
    "LICENSE",
  ])
    assert.ok(paths.includes(required), `Missing ${required}`);
  assert.ok(
    paths.every(
      (path) =>
        path.startsWith("src/") ||
        [
          "package.json",
          "README.md",
          "LICENSE",
          "docs/before-after.svg",
          "docs/compatibility.md",
        ].includes(path),
    ),
    "Unexpected files in published payload",
  );
  const host = join(temp, "host");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(host);
  await writeFile(
    join(host, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    "install",
    "--prefix",
    host,
    join(temp, packed.filename),
    "--ignore-scripts",
    "--omit=peer",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
  );
  const installed = join(host, "node_modules/pi-tool-summaries");
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.ok(
    !manifest.dependencies,
    "Host modules must not be bundled runtime dependencies",
  );
  for (const peer of Object.keys(manifest.peerDependencies)) {
    assert.equal(manifest.peerDependenciesMeta[peer].optional, true);
    await assert.rejects(
      access(join(host, "node_modules", peer)),
      "The installed package must use Pi's host modules",
    );
  }
  const dist = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const { loadExtensions } = await import(
    pathToFileURL(join(dist, "core/extensions/loader.js")).href
  );
  const entries = manifest.pi.extensions.map((entry: string) =>
    join(installed, entry),
  );
  const loaded = await loadExtensions(entries, host);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has("tool-summaries"));
  console.log(
    `Packed ${packed.name}@${packed.version}, installed without bundled host peers, and loaded through Pi`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
