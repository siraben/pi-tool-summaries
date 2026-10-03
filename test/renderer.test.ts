import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../src/config.js";
import { Summaries } from "../src/summaries.js";
import { withSummary } from "../src/renderer.js";

const dist = dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const { initTheme, theme } = await import(
  pathToFileURL(join(dist, "modes/interactive/theme/theme.js")).href
);
initTheme("dark", false);

test("native call component survives idle, pending, failure, skipped, and reopened states", async () => {
  for (const outcome of [
    "idle",
    "pending",
    "failure",
    "skipped",
    "reopened",
    "success",
  ]) {
    let finish!: (text: string) => void;
    let fail!: (error: Error) => void;
    let invalidations = 0;
    const service = new Summaries(
      { ...readConfig({}), timeoutMs: 1000 },
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const original = createBashToolDefinition(process.cwd());
    const nativeCall = original.renderCall!;
    let native: ReturnType<typeof nativeCall> | undefined;
    let calls = 0;
    const instrumented: typeof original = {
      ...original,
      renderCall(args, theme, context) {
        assert.equal(
          context.lastComponent,
          native,
          "Native renderer must receive only its own prior component",
        );
        native = nativeCall(args, theme, context);
        calls++;
        return native;
      },
    };
    const wrapped = withSummary(instrumented, service);
    const args = { command: "printf 'hello\\n'", timeout: 17 };
    const context = {
      toolCallId: outcome,
      state: {},
      expanded: false,
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      isError: false,
      showImages: false,
      cwd: process.cwd(),
      args,
      invalidate() {
        invalidations++;
      },
      lastComponent: undefined,
    } as Parameters<typeof nativeCall>[2];
    const render = () => {
      const component = wrapped.renderCall!(args, theme, context);
      context.lastComponent = component;
      return component;
    };
    try {
      const initial = render();
      assert.equal(initial, native);
      const expected = initial.render(100);
      const state = { ...context.state };
      if (outcome !== "idle") {
        service.start(
          outcome,
          "bash",
          args,
          outcome === "skipped" ? AbortSignal.abort() : undefined,
        );
        await delay(5);
        assert.equal(render(), native);
        assert.deepEqual(render().render(100), expected);
        if (outcome === "failure") fail(new Error("Provider unavailable"));
        if (outcome === "success" || outcome === "reopened")
          finish("I’ll print a greeting.");
        if (
          outcome === "failure" ||
          outcome === "success" ||
          outcome === "reopened"
        )
          await delay(5);
      }
      if (outcome === "reopened") {
        assert.notEqual(render(), native);
        service.dispose();
      }
      const displayed = render();
      if (outcome === "success") {
        assert.notEqual(displayed, native);
        assert.match(displayed.render(100).join("\n"), /I’ll print a greeting/);
        assert.ok(
          invalidations > 0,
          "Success must invalidate the existing row",
        );
        context.expanded = true;
        assert.equal(render(), native);
        assert.deepEqual(render().render(100), expected);
        context.expanded = false;
        assert.match(render().render(100).join("\n"), /I’ll print a greeting/);
      } else {
        assert.equal(displayed, native);
        assert.deepEqual(displayed.render(100), expected);
      }
      assert.deepEqual(
        context.state,
        state,
        "Native state must survive every view change",
      );
      assert.ok(calls > 1);
    } finally {
      service.dispose();
    }
  }
});

test("the existing Pi row stays native while pending and replaces its call after success", async () => {
  const { ToolExecutionComponent } = await import(
    pathToFileURL(join(dist, "modes/interactive/components/tool-execution.js"))
      .href
  );
  let finish!: (text: string) => void;
  let redraws = 0;
  const service = new Summaries(
    { ...readConfig({}), timeoutMs: 1000 },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const original = createBashToolDefinition(process.cwd());
  const args = { command: "printf 'hello\\n'" };
  const ui = {
    requestRender() {
      redraws++;
    },
  };
  const baseline = new ToolExecutionComponent(
    "bash",
    "row",
    args,
    {},
    original,
    ui,
    process.cwd(),
  );
  const row = new ToolExecutionComponent(
    "bash",
    "row",
    args,
    {},
    withSummary(original, service),
    ui,
    process.cwd(),
  );
  baseline.setArgsComplete();
  row.setArgsComplete();
  const native = baseline.render(100);
  try {
    assert.deepEqual(row.render(100), native);
    service.start("row", "bash", args);
    await delay(5);
    assert.deepEqual(row.render(100), native);
    finish("I’ll print a greeting.");
    await delay(5);
    assert.ok(redraws > 0);
    assert.match(row.render(100).join("\n"), /I’ll print a greeting/);
    assert.doesNotMatch(row.render(100).join("\n"), /printf/);
    row.setExpanded(true);
    baseline.setExpanded(true);
    assert.deepEqual(row.render(100), baseline.render(100));
  } finally {
    service.dispose();
  }
});
