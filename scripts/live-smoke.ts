import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configFromSettings } from "../src/config.js";
import { createGenerate } from "../src/provider.js";
import { cleanSummary } from "../src/summaries.js";

try {
  const config = configFromSettings(
    SettingsManager.create(process.cwd(), undefined, { projectTrusted: false }),
  );
  if (!config.provider || !config.model) throw new Error("configuration");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.find(config.provider, config.model);
  if (!model || !registry.hasConfiguredAuth(model)) {
    console.error(
      "Live test needs a known model and a credential configured in Pi or the provider environment. No request sent.",
    );
    process.exitCode = 1;
  } else {
    const input = JSON.stringify({
      tool: "bash",
      arguments: {
        command:
          "find src -name '*.ts' -not -path '*/generated/*' -print0 | xargs -0 grep -n 'oldApi'",
      },
    });
    if (input.length > config.maxInputChars) throw new Error("input limit");
    const start = Date.now();
    const signal = AbortSignal.timeout(config.timeoutMs);
    const summary = await Promise.race([
      createGenerate(registry, model, config.maxTokens)(input, signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        }),
      ),
    ]);
    const safe = cleanSummary(summary);
    if (!safe || safe.length > 2000)
      throw new Error("empty or oversized response");
    console.log(`Model: ${config.provider}/${config.model}`);
    console.log(`Time: ${Date.now() - start} ms`);
    console.log(`Summary: ${safe}`);
  }
} catch {
  console.error(
    "Live summary unavailable. Check model configuration, Pi authentication, and request limits. Provider error details are withheld to avoid exposing credentials.",
  );
  process.exitCode = 1;
}
