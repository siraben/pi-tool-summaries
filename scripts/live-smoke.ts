import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configFromSettings } from "../src/config.js";
import { createGenerate } from "../src/provider.js";
import { cleanSummary } from "../src/summaries.js";
import { authenticationIssue } from "../src/requests.js";

try {
  const settings = SettingsManager.create(process.cwd(), undefined, {
    projectTrusted: false,
  });
  const config = configFromSettings(settings);
  if (!config.enabled) throw new Error("Summary requests disabled");
  const provider = config.provider ?? settings.getDefaultProvider();
  const modelId = config.model ?? settings.getDefaultModel();
  if (!provider || !modelId) throw new Error("configuration");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.find(provider, modelId);
  if (
    !model ||
    (await authenticationIssue(
      registry,
      model,
      AbortSignal.timeout(config.timeoutMs),
    ))
  ) {
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
    if (
      input.length > config.maxInputChars ||
      config.exclude.some((part) => input.includes(part))
    )
      throw new Error("input limit or privacy exclusion");
    const start = Date.now();
    const signal = AbortSignal.timeout(config.timeoutMs);
    const summary = await Promise.race([
      createGenerate(
        registry,
        model,
        config.maxTokens,
        config.reasoning,
      )(input, signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        }),
      ),
    ]);
    const safe = cleanSummary(summary);
    if (!safe || safe.length > 2000)
      throw new Error("empty or oversized response");
    console.log(`Model: ${model.provider}/${model.id}`);
    console.log(`Time: ${Date.now() - start} ms`);
    console.log(`Summary: ${safe}`);
  }
} catch {
  console.error(
    "Live summary unavailable. Check model configuration, Pi authentication, and request limits. Provider error details are withheld to avoid exposing credentials.",
  );
  process.exitCode = 1;
}
