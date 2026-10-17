import { spawnSync } from "node:child_process";

// Keep publication gates usable on Windows without assuming a Bash installation.
// Windows still executes native PowerShell tests as part of the portable suite.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run release checks through npm run prepublishOnly");
for (const script of [
  "check",
  process.platform === "win32" ? "test:portable" : "test",
  "format:check",
  "test:package",
]) {
  const result = spawnSync(process.execPath, [npm, "run", script], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
