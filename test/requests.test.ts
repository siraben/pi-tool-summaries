import assert from "node:assert/strict";
import { test } from "node:test";
import { Requests } from "../src/requests.js";
import { providerFailure } from "../src/failures.js";
import { usage } from "./helpers.js";

const signal = () => new AbortController().signal;

test("requests count calls and use Pi's reported usage", async () => {
  const requests = new Requests();
  const generate = requests.wrap(
    "p/model",
    async () => "Reading files.",
    () => {},
  );
  assert.equal(await generate("{}", signal()), "Reading files.");
  requests.recordUsage(usage);
  requests.recordUsage();
  assert.equal(requests.stats.requests, 1);
  assert.equal(requests.stats.reported, 1);
  assert.equal(requests.stats.input, usage.input);
  assert.equal(requests.stats.cost, usage.cost.total);
});

test("rate-limit failures suppress repeated calls and warn once without exposing errors", async () => {
  const requests = new Requests();
  const warnings: string[] = [];
  let calls = 0;
  const generate = requests.wrap(
    "p/model",
    async () => {
      calls++;
      throw providerFailure({ status: 429, message: "Bearer private-key" });
    },
    (text) => warnings.push(text),
  );
  await assert.rejects(generate("{}", signal()), /rate limited/);
  await assert.rejects(generate("{}", signal()), /cooling down/);
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private-key/);
  assert.equal(requests.coolingDown("p/other"), false);
  assert.equal(new Requests().coolingDown("p/model"), false);
});

test("cancelled calls are not submitted or treated as provider failures", async () => {
  const requests = new Requests();
  const generate = requests.wrap(
    "p/model",
    async () => "unused",
    () => {},
  );
  await assert.rejects(generate("{}", AbortSignal.abort()));
  assert.equal(requests.stats.requests, 0);
  assert.equal(requests.coolingDown("p/model"), false);
});
