import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { configFromSettings } from "../src/config.js";

test("Pi settings merge global and trusted project namespaces and reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-summary-settings-"));
  const agentDir = join(root, "custom-agent");
  const cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const projectFile = join(cwd, ".pi/settings.json");
  const load = (projectTrusted: boolean) => {
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    assert.deepEqual(manager.drainErrors(), []);
    return configFromSettings(manager);
  };
  try {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        toolSummaries: {
          model: "global/model",
          timeoutMs: 9000,
        },
      }),
    );
    await writeFile(
      projectFile,
      JSON.stringify({
        toolSummaries: {
          model: "project/model",
        },
      }),
    );
    assert.equal(load(false).provider, "global");
    const trusted = load(true);
    assert.equal(trusted.provider, "project");
    assert.equal(trusted.timeoutMs, 9000);
    await writeFile(
      projectFile,
      JSON.stringify({ toolSummaries: { model: "current" } }),
    );
    assert.equal(load(true).model, undefined);
    await writeFile(projectFile, "{invalid");
    assert.equal(
      SettingsManager.create(cwd, agentDir, {
        projectTrusted: true,
      }).drainErrors().length,
      1,
    );
    assert.equal(load(false).provider, "global");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
