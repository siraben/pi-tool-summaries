import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as host from "@earendil-works/pi-coding-agent";
import { readConfig } from "../src/config.js";
import { Summaries } from "../src/summaries.js";
import { withSummary } from "../src/renderer.js";

for (const name of ["bash", "powershell"]) {
  const windows = process.platform === "win32";
  test(
    `${name}: native execution writes files and returns output`,
    { skip: name === "powershell" ? !windows : windows },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-summary-shell-"));
      const service = new Summaries(readConfig(), async () => "unused");
      const create =
        name === "bash"
          ? host.createBashToolDefinition
          : (host as any).createPowerShellToolDefinition;
      const original = create(cwd, { exposeSessionEnvironment: false });
      const wrapped = withSummary(original, service);
      assert.equal(wrapped.execute, original.execute);
      const command = windows
        ? "Set-Content -LiteralPath marker -Value kept; Get-Content -Raw -LiteralPath marker"
        : "printf kept > marker; cat marker";
      try {
        const result = await wrapped.execute(
          "exec",
          { command },
          undefined,
          undefined,
          {} as any,
        );
        assert.equal(
          (await readFile(join(cwd, "marker"), "utf8")).trim(),
          "kept",
        );
        assert.equal(
          result.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
            .trim(),
          "kept",
        );
      } finally {
        service.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
}
