# Compatibility and release verification

## Supported integration

- Pi 0.84.4 through 1.x; PowerShell and codemode rendering require Pi 1.0.1 or newer.
- Node >=22.19.0; Node 22 and 24 are covered by CI.
- Interactive terminal sessions only. Print/JSON/RPC/SDK sessions keep native tools without background display-summary requests.
- Visible built-in Bash/PowerShell and active codemode calls only. Replacement shell tools, nested calls without transcript rows and other tools remain native.
- Pi's active theme is used for the tool title; no custom theme or fixed runtime palette is installed. The README image is an illustration, not a theme requirement.

The extension's production imports use Pi's public APIs. Renderer registration is feature-detected for old Pi versions. Tests additionally import pinned native UI internals to verify Ctrl+O expansion, renderer state and results; those internals are not shipped or imported by production code.

## CI matrix

| Environment                                | Coverage                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux, Node 22/24, pinned Pi 1.0.1         | Full tests, types, formatting, installed tarball load                                                                                         |
| macOS, Node 22/24, pinned Pi 1.0.1         | Full tests (including native Bash), types, formatting, installed tarball load                                                                 |
| Windows, Node 22/24, pinned Pi 1.0.1       | Portable settings/provider/service/persistence/control/renderer tests, native PowerShell execution, types, formatting, installed tarball load |
| Linux, Node 22, Pi 0.84.4 / 0.99.2 / 1.3.0 | Full tests, types, installed tarball load                                                                                                     |

Windows CI exercises native PowerShell file writes, output, exit codes and pre-start cancellation. Shell renderer tests cover collapsed summaries and expanded native views without executing commands. Windows CI does **not** claim native Bash execution or WSL. Bash/PowerShell availability and Pi's native shell setup remain the user's responsibility. No unsupported or replacement shell is recreated by this extension; PowerShell is wrapped through Pi's native renderer registration.

Provider tests use local/mock responses, not paid accounts. They exercise API-key/custom-endpoint routing, keyless endpoints, OAuth-style refreshed-auth results, missing authentication, model absence, rate limiting, safe errors, cancellation and usage. They cannot guarantee a particular live subscription accepts every model/option. Readiness is a bounded credential-resolution check, not a model access, billing or network probe. Real OAuth refresh is owned by Pi, not reimplemented here.

## Local verification

```sh
npx --yes npm@12.2.0 ci --ignore-scripts
npm run check
npm test
npm run format:check
npm run test:package
```

On Windows, use `npm run test:portable` instead of the native-Bash suite. `test:package` creates a real npm tarball, installs it in an isolated temporary project with host peers omitted, verifies the allowlisted payload, and loads the installed TypeScript entry point through the current Pi host's extension loader. Temporary artifacts are removed even on failure.

`npm publish` runs the same core gates through `prepublishOnly`; no build step is required because Pi loads TypeScript. Package versions are not reusable. CI and tests do not publish anything. Live tests (`npm run test:live`) are optional, require configured Pi credentials and can incur costs; the standalone scripts use the saved Pi default when `model` is `current` because they have no running session model.

Host-provided packages stay optional peers with the declared supported version range. Do not move Pi/TUI into runtime dependencies or bundle a second host instance. The `pi-package` keyword enables gallery discovery after publication. npm login is a publisher concern, unrelated to Pi provider authentication.

## Design references

These are patterns, not bundled dependencies or compatibility guarantees:

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md): manifests, host dependencies and gallery discovery.
- [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md): stored credentials, environment keys and ambient cloud authentication.
- [Pi custom compaction example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts): registry calls, cancellation and preserving native behavior on failure.
- [pi-context-prune](https://github.com/championswimmer/pi-context-prune): current-model default, explicit summarizer model, usage visibility.
- [pi-session-summary](https://github.com/pasky/pi-session-summary): inexpensive secondary calls and documenting model selection/cost. Unlike its automatic discovery, this package never automatically switches providers.
- [pi-auto-session-name](https://github.com/patlux/pi-auto-session-name): bounded background work, cancellation and Pi-managed authentication.

Prefer a current-model default for portability and an explicitly configured dedicated model for cost/latency control. Model IDs and provider capabilities evolve; verify selections in `/model`. No secret detector can make arbitrary shell code safe to disclose, so exclusions are literal, bounded and advisory; sensitive projects should disable requests.
