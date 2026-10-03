import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../src/config.js";
import { Summaries } from "../src/summaries.js";
import { withSummary } from "../src/renderer.js";

// Internal imports are test-only: exercise the exact native component used by the installed Pi release.
const dist = dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const { initTheme } = await import(
  pathToFileURL(join(dist, "modes/interactive/theme/theme.js")).href
);
const { ToolExecutionComponent } = await import(
  pathToFileURL(join(dist, "modes/interactive/components/tool-execution.js"))
    .href
);
initTheme("dark", false);

test("native expansion preserves every line of a long command before and after async summary", async () => {
  const command =
    "cat <<'END'\n" +
    Array.from(
      { length: 120 },
      (_, i) => `original line ${i} with $literal and quotes ' \"`,
    ).join("\n") +
    "\nEND";
  const args = { command, timeout: 17 };
  let finish!: (s: string) => void;
  let redraws = 0;
  const service = new Summaries(
    { ...readConfig({}), timeoutMs: 1000 },
    async () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const original = createBashToolDefinition(process.cwd());
  const wrapped = withSummary(original, service);
  assert.equal(wrapped.execute, original.execute);
  assert.equal(wrapped.renderResult, original.renderResult);
  assert.equal(wrapped.parameters, original.parameters);
  assert.equal(wrapped.promptSnippet, original.promptSnippet);
  if ("outputSchema" in original)
    assert.equal(
      (wrapped as typeof original).outputSchema,
      original.outputSchema,
    );
  const row = new ToolExecutionComponent(
    "bash",
    "native",
    args,
    {},
    wrapped,
    {
      requestRender() {
        redraws++;
      },
    },
    process.cwd(),
  );
  row.setArgsComplete();
  row.markExecutionStarted();
  const text = () => stripVTControlCharacters(row.render(200).join("\n"));
  const assertFull = () => {
    for (const line of command.split("\n"))
      assert.ok(text().includes(line), line);
  };
  row.setExpanded(true);
  assertFull();
  service.start("native", "bash", args);
  await delay(5);
  finish(
    "Print the literal text from a heredoc, preserving dollar signs and quotation marks.",
  );
  await delay(5);
  assert.ok(redraws > 0);
  row.updateResult({
    content: [{ type: "text", text: "native output" }],
    details: {},
    isError: false,
  });
  row.setExpanded(false);
  assert.match(text(), /AI summary/);
  assert.match(text(), /Print the literal text/);
  assert.doesNotMatch(text(), /original line 119/);
  assert.match(text(), /native output/);
  row.setExpanded(true);
  assertFull();
  row.setExpanded(false);
  assert.match(text(), /Print the literal text/);
  service.dispose();
});

test("native keymap uses Ctrl+O for tool expansion", async () => {
  const source = await readFile(join(dist, "core/keybindings.js"), "utf8");
  assert.match(source, /"app.tools.expand":\s*\{ defaultKeys: "ctrl\+o"/);
});

test("wrapped native execution keeps cwd, prefix, output, failures and abort semantics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-test-"));
  const service = new Summaries(readConfig({}), async () => "unused");
  const original = createBashToolDefinition(cwd, {
    commandPrefix: "export SUMMARY_TEST_PREFIX=kept",
    exposeSessionEnvironment: false,
  });
  const wrapped = withSummary(original, service);
  try {
    const result = await wrapped.execute(
      "exec",
      { command: 'printf "%s" "$SUMMARY_TEST_PREFIX" > marker; cat marker' },
      undefined,
      undefined,
      {} as Parameters<typeof wrapped.execute>[4],
    );
    assert.equal(await readFile(join(cwd, "marker"), "utf8"), "kept");
    assert.deepEqual(result.content, [{ type: "text", text: "kept" }]);
    const failureCall = () =>
      wrapped.execute(
        "fail",
        { command: "exit 7" },
        undefined,
        undefined,
        {} as Parameters<typeof wrapped.execute>[4],
      );
    if ("structuredContent" in result) {
      const failure = await failureCall();
      assert.equal((failure as { isError?: boolean }).isError, true);
      assert.equal(
        (failure as unknown as { structuredContent: { exit_code: number } })
          .structuredContent.exit_code,
        7,
      );
      assert.equal(
        (result.structuredContent as { exit_code: number }).exit_code,
        0,
      );
      assert.equal(
        (result.structuredContent as { output: string }).output,
        "kept",
      );
    } else {
      // Pre-1.0 native Bash reports a nonzero exit by rejecting.
      await assert.rejects(failureCall(), /code 7/);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      wrapped.execute(
        "abort",
        { command: "sleep 10" },
        controller.signal,
        undefined,
        {} as Parameters<typeof wrapped.execute>[4],
      ),
      /abort/i,
    );
  } finally {
    service.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
