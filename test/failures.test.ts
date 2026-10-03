import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createGenerate } from "../src/provider.js";
import { readConfig } from "../src/config.js";
import { Summaries } from "../src/summaries.js";
import { providerFailure } from "../src/failures.js";

test("provider failures retain safe status and distinguish unusable responses", async () => {
  const secret = "Bearer secret-token; command=private data";
  for (const [response, expected] of [
    [
      { stopReason: "error", errorMessage: `429 ${secret}`, content: [] },
      /Provider\/API failure \(HTTP 429\)/,
    ],
    [{ stopReason: "length", content: [] }, /output token limit/],
    [{ stopReason: "aborted", content: [] }, /cancelled by provider/],
    [{ stopReason: "stop", content: [] }, /empty or contained no usable text/],
    [
      {
        stopReason: "stop",
        content: [{ type: "text", text: "\u001b[31m   " }],
      },
      /empty or contained no usable text/,
    ],
  ] as const) {
    const generate = createGenerate(
      { complete: async () => response } as any,
      {} as any,
      220,
    );
    const service = new Summaries(readConfig(), generate);
    service.start("call", "bash", { command: "echo test" });
    await delay(5);
    assert.match(service.lastIssue!, expected);
    assert.doesNotMatch(service.lastIssue!, /secret|private/);
    service.dispose();
  }
  const cause = Object.assign(new Error(secret), { status: 401 });
  assert.equal(providerFailure(cause).cause, cause);
  const generate = createGenerate(
    {
      complete: async () => {
        throw cause;
      },
    } as any,
    {} as any,
    220,
  );
  await assert.rejects(
    generate("{}", new AbortController().signal),
    /Provider\/API failure \(HTTP 401\)/,
  );
  assert.equal(
    providerFailure(new Error(secret)).message,
    "Provider/API failure",
  );
});

test("deadline, parent cancellation, and unknown generation failures stay distinct", async () => {
  const args = { command: "echo test" };
  const timeout = new Summaries(
    { ...readConfig(), timeoutMs: 10 },
    async () => new Promise(() => {}),
  );
  timeout.start("timeout", "bash", args);
  await delay(30);
  assert.equal(timeout.lastIssue, "Summary timed out after 10 ms");
  const parent = new AbortController();
  const cancelled = new Summaries(
    readConfig(),
    async () => new Promise(() => {}),
  );
  cancelled.start("cancelled", "bash", args, parent.signal);
  parent.abort(new Error("secret cancellation reason"));
  await delay(5);
  assert.equal(cancelled.lastIssue, "Summary cancelled by parent");
  const unknown = new Summaries(readConfig(), async () => {
    throw new Error("secret unknown cause");
  });
  unknown.start("unknown", "bash", args);
  await delay(5);
  assert.equal(unknown.lastIssue, "Summary generation failed (unknown cause)");
  timeout.dispose();
  cancelled.dispose();
  unknown.dispose();
});
