import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticationIssue, Requests } from "../src/requests.js";
import { providerFailure } from "../src/failures.js";
import { createGenerate } from "../src/provider.js";
import { readConfig } from "../src/config.js";

const signal = () => new AbortController().signal;

test("credential readiness can be cancelled without waiting for an uncooperative resolver", async () => {
  const controller = new AbortController();
  const ready = authenticationIssue(
    { getApiKeyAndHeaders: async () => new Promise(() => {}) } as any,
    {} as any,
    controller.signal,
  );
  controller.abort();
  assert.equal(await ready, "Credential check timed out or cancelled");
});

test("readiness uses request-time Pi auth, accepts keyless endpoints and withholds secrets", async () => {
  for (const auth of [
    { ok: true, apiKey: "oauth-refreshed-token" },
    {
      ok: true,
      headers: { "x-custom-key": "private" },
      baseUrl: "https://proxy.invalid",
    },
    { ok: true, headers: {} },
  ]) {
    const registry = {
      hasConfiguredAuth() {
        assert.fail("Credential discovery is not an auth gate");
      },
      getApiKeyAndHeaders: async () => auth,
    };
    assert.equal(
      await authenticationIssue(registry as any, {} as any),
      undefined,
    );
  }
  assert.equal(
    await authenticationIssue(
      {
        getApiKeyAndHeaders: async () => ({
          ok: false,
          error: "Bearer private-token",
        }),
      } as any,
      {} as any,
    ),
    "Provider authentication unavailable",
  );
  assert.equal(
    await authenticationIssue(
      {
        getApiKeyAndHeaders: async () => {
          throw new Error("private auth command");
        },
      } as any,
      {} as any,
    ),
    "Provider authentication unavailable",
  );
});

test("auth and rate-limit cooldowns are per model, warn once, and recover on retry or expiry", async () => {
  let now = 0,
    authChecks = 0,
    calls = 0;
  let authMissing = true;
  const warnings: string[] = [];
  const requests = new Requests(() => now, 1000);
  const generate = requests.wrap(
    "p/a",
    async () => {
      calls++;
      return "Reading files.";
    },
    async () => {
      authChecks++;
      return authMissing ? "Provider authentication unavailable" : undefined;
    },
    (text) => warnings.push(text),
  );
  await assert.rejects(generate("{}", signal()), /authentication unavailable/);
  authMissing = false;
  await assert.rejects(generate("{}", signal()), /cooldown/);
  assert.equal(authChecks, 1);
  assert.equal(calls, 0);
  assert.equal(warnings.length, 1);
  requests.reset();
  assert.equal(await generate("{}", signal()), "Reading files.");
  assert.equal(calls, 1);
  const limited = requests.wrap(
    "p/a",
    async () => {
      throw providerFailure({ status: 429, message: "Bearer private" });
    },
    async () => undefined,
    (text) => warnings.push(text),
  );
  await assert.rejects(limited("{}", signal()), /rate limited/);
  assert.match(requests.status("p/a")!, /cooldown/);
  assert.equal(requests.status("p/b"), undefined);
  now = 1001;
  assert.equal(await generate("{}", signal()), "Reading files.");
  assert.equal(requests.status("p/a"), undefined);
  assert.ok(warnings.every((text) => !text.includes("private")));
});

test("repeated provider failures cool down; cancellations do not poison model health", async () => {
  const requests = new Requests(() => 0, 1000);
  const warnings: string[] = [];
  let calls = 0;
  const generate = requests.wrap(
    "p/a",
    async () => {
      calls++;
      throw providerFailure({ status: 503 });
    },
    async () => undefined,
    (text) => warnings.push(text),
  );
  for (let i = 0; i < 3; i++)
    await assert.rejects(generate("{}", signal()), /503/);
  await assert.rejects(generate("{}", signal()), /cooldown/);
  assert.equal(calls, 3);
  assert.equal(warnings.length, 1);
  const controller = new AbortController();
  controller.abort();
  const cancelled = requests.wrap(
    "p/b",
    async () => {
      assert.fail("No cancelled request");
    },
    async () => undefined,
    (text) => warnings.push(text),
  );
  await assert.rejects(cancelled("{}", controller.signal));
  assert.equal(requests.status("p/b"), undefined);
});

test("parallel auth cannot overrun the runtime-session cap and retry does not reset it", async () => {
  const requests = new Requests();
  requests.maxRequests = 1;
  let calls = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generate = requests.wrap(
    "p/a",
    async () => {
      calls++;
      return "Reading files.";
    },
    async () => {
      await ready;
      return undefined;
    },
    () => {},
  );
  const first = generate("{}", signal());
  const second = generate("{}", signal());
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(calls, 1);
  assert.equal(requests.stats.requests, 1);
  requests.reset();
  await assert.rejects(generate("{}", signal()), /cap reached/);
  assert.equal(calls, 1);
  assert.equal(readConfig().maxRequests, 0);
  for (const maxRequests of [-1, 0.5, 1000001, "2"])
    assert.throws(
      () => readConfig({ toolSummaries: { maxRequests } }),
      /maxRequests/,
    );
});

test("usage is counted for unusable final responses, with missing/invalid metrics left unknown", async () => {
  const requests = new Requests();
  for (const stopReason of ["stop", "error", "length", "aborted"]) {
    const generate = createGenerate(
      {
        complete: async () => ({
          stopReason,
          content: [],
          usage: {
            input: 10,
            output: 4,
            cacheRead: 1,
            cacheWrite: 2,
            cost: { total: 0.001 },
          },
        }),
      } as any,
      {} as any,
      1024,
      undefined,
      (usage) => requests.recordUsage(usage),
    );
    try {
      await generate("{}", signal());
    } catch {
      /* Response errors still have usage. */
    }
  }
  requests.recordUsage(undefined);
  requests.recordUsage({ input: NaN, output: -1, cost: { total: Infinity } });
  assert.deepEqual(requests.stats, {
    requests: 0,
    responsesWithUsage: 4,
    input: 40,
    output: 16,
    cacheRead: 4,
    cacheWrite: 8,
    estimatedCost: 0.004,
    responsesWithCost: 4,
  });
  requests.recordUsage({ input: 3 });
  assert.equal(requests.stats.input, 43);
  assert.equal(requests.stats.responsesWithUsage, 5);
  assert.equal(requests.stats.responsesWithCost, 4);
});
