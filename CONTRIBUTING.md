# Contributing to Jev Agent Control

See the [README](README.md) for installation, authentication, configuration, and everyday use. Please follow the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) when participating.

## Development setup

Use Node.js 20+ and npm; Node.js 24 is used for the release workflow. Git is required for the release-tooling unit tests. The plugin targets OpenCode V2 and pins its plugin API dependency to **2.0.24**.

From your checkout:

```sh
npm ci
npm run build
```

`npm install` / `npm ci` installs the Husky commit-message hook. If you installed with `--ignore-scripts`, run `npm run prepare` to enable the hook locally.

To try local changes in OpenCode, use the checkout path in the plugin configuration shown in the [README](README.md#install-locally). Rebuild with `npm run build` after changing TypeScript. Reload the plugin or restart your development OpenCode session to use the rebuilt code.

### Environment-based credentials

For development or headless use, `TYPESAFE_API_KEY` on the **OpenCode server process** is an optional fallback to the normal `/connect` setup. A saved TypeSafe account takes precedence over this environment connection.

`.env.example` provides the variable name; put your key in a local `.env` file, which is ignored by Git. To load it before starting a standalone development server:

```sh
set -a
. ./.env
set +a
opencode --standalone
```

An already-running shared service needs to be restarted to pick up a changed process environment. Saved-account changes through `/connect` take effect without a restart. The plugin does not automatically load project `.env` files; `test:live` and `test:e2e` explicitly load `.env`.

`TYPESAFE_BASE_URL` can override the TypeSafe API root for a test endpoint or proxy. The default endpoint is `https://api.typesafe.ai/v1/systemone`.

## Project layout

| Path                                             | Responsibility                                                  |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `src/index.ts`                                   | Plugin setup, OpenCode adapters, hooks, and commands.           |
| `src/auth.ts`                                    | Native TypeSafe account registration and credential resolution. |
| `src/jev.ts`                                     | Jev questions, API requests, and response validation.           |
| `src/controller.ts`                              | Per-session routing, handoffs, cancellation, and persistence.   |
| `src/context.ts`                                 | Agent discovery and bounded context construction.               |
| `src/config.ts`, `src/types.ts`                  | Configuration validation and shared contracts.                  |
| `test/*.test.ts`                                 | Unit tests, including local release-tooling fixtures.           |
| `test/integration/`, `test/e2e/`, `test/live.ts` | Explicitly invoked integration and live tests.                  |
| `scripts/release-notes.ts`                       | Extracts a release's notes from the changelog.                  |
| `.github/workflows/`                             | CI and the manually dispatched release workflow.                |

## Runtime design

1. The prompt admission hook routes an incoming request when the session is idle. Input arriving during an active run is reassessed at its next successful completion.
2. The plugin sends Jev the latest request, a bounded recent transcript, available agent descriptions, and the most recent compaction summary when present. Textual tool outcomes are included; reasoning, binary attachments, and complete file blobs are omitted.
3. One Jev request asks two independent Choice questions: **next agent** and **work status** (`work_remaining`, `needs_user`, or `complete`). The active TypeSafe credential is resolved for each decision through OpenCode; saved accounts take precedence over the optional `TYPESAFE_API_KEY` environment connection.
4. The controller validates the response, confidence, and probability margin, then switches the agent and its configured model. It rechecks the session and catalog before applying a decision and attempts rollback if a partial switch fails.
5. On successful execution completion, a confident decision that requested work remains can switch to a different agent and submit one idempotently identified synthetic continuation. A same-agent decision ends the handoff cycle rather than repeatedly asking that agent to continue.

New input, manual selection, and interruption invalidate pending decisions. Queued user input takes precedence over autonomous continuation. Each session is serialized independently; child sessions and other project locations are excluded. A repeated transition or the handoff budget stops cycles. Reloading the plugin does not resume old work automatically.

Jev outages, invalid responses, and low confidence retain the current selection. Decision history contains choices, probabilities, confidence, model version, and latency—not the transcript sent for evaluation. The selected agent's normal OpenCode instructions and permissions apply.

## Checks and tests

Run the default verification sequence before submitting a change:

```sh
npm run format:check
npm run check
npm test
npm run build
```

Use `npm run format` to apply formatting. Unit tests cover routing, cancellation, duplicate admission, model rollback, manual control, context bounds, cycle limits, and account/key changes using mocked credential and HTTP APIs. Release tests use temporary local Git repositories. These checks require no API keys and make no AI calls.

The additional suites below are explicitly invoked development tools; CI runs only the unit tests and static/build checks.

### OpenCode integration test

Requires **Bun 1.3+**:

```sh
npm run test:integration
```

This runs a real embedded OpenCode host with an isolated database/configuration and local fake Jev/LLM HTTP endpoints. It verifies Plan → Build → Reviewer, model changes, completion, and native manual overrides.

### Live Jev evaluation

Put `TYPESAFE_API_KEY` in `.env`, then run:

```sh
npm run test:live
```

This explicitly loads `.env` and makes nine billable Jev requests against synthetic examples. It requires a Node version supporting `--env-file` (20.6+).

### Fully live end-to-end test

Requires **Bun 1.3+** and the `opencode` CLI:

```sh
npm run test:e2e
```

This runs a real isolated OpenCode host with **live Jev and live OpenAI coding models**. It explicitly loads `TYPESAFE_API_KEY` from `.env` and uses `OPENAI_API_KEY` or the active OpenAI API-key connection from the local OpenCode service. The `opencode` CLI supplies the provider/model catalog.

The workflow plans, implements, tests, and independently reviews a small `slugify` module. Assertions verify the Plan → Build → Reviewer sequence, two automatic handoffs, configured model selection, passing acceptance cases, and preservation of the acceptance tests. A second request verifies that plan-only work stops without implementing or editing files.

Defaults are `gpt-5.4-nano#low` for Plan/Reviewer and `gpt-5.4-mini#low` for Build. Override model IDs with `JEV_E2E_PLAN_MODEL`, `JEV_E2E_BUILD_MODEL`, and `JEV_E2E_REVIEW_MODEL` (the selected models must support the `low` variant). This test incurs normal provider charges.

It prints the artifact directory containing the generated project and `results.json` with model turns, routing decisions, and transcripts. The temporary OpenCode runtime/database is removed afterward. `JEV_PLUGIN_ENTRY` can point at an installed package's `dist/index.js` to exercise that build instead.

## Continuous integration

[GitHub Actions](https://github.com/Krzysztof-Cieslak/jev-agent-control/actions/workflows/ci.yml) runs on pushes to `main`, pull requests, and manual dispatches. On Node.js **20, 22, and 24**, it checks formatting and types, runs the unit tests in `test/*.test.ts`, and builds the plugin. A separate job validates commit messages and PR titles.

CI installs dependencies with `npm ci --ignore-scripts` because unit/static checks do not need the SDK's native integration-test bindings. It requires no API keys and makes no AI calls.

## Commit messages and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(router): support a new routing policy
fix(jev): handle a timeout
docs: clarify installation
feat!: change the configuration format
```

Supported types are `feat`, `fix`, `perf`, `revert`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, and `style`. Scopes are optional; use `!` or a `BREAKING CHANGE:` footer for breaking changes.

The local Husky hook validates commit messages. CI validates new commits and PR titles with commitlint. Keep pull requests focused, describe the behavior being changed, and include the relevant verification results. Use **squash merge** with the validated PR title so the resulting commit follows the same format.

The release workflow validates all commits after the historical baseline in `.github/commitlint-base`; the two earlier commits are recorded in the [initial changelog](CHANGELOG.md).

Server-side rulesets for this private repository require GitHub Pro. Until enabled, local hooks, failing CI checks, and the release gate provide validation; GitHub does not enforce a branch-rule merge block.

## Packaging

Package for distribution:

```sh
npm pack
```

The `prepack` script builds the plugin. Packages include `dist/`, examples, README, this contributor guide, changelog, license, code of conduct, and package metadata. To verify an installed tarball, set `JEV_PLUGIN_ENTRY` to its installed `dist/index.js` when running `test:integration`.

## GitHub releases

Open **Actions → Release → Run workflow** on `main`, select `patch`, `minor`, or `major`, and run it. The workflow:

1. Validates Conventional Commits and checks for unreleased changes.
2. Bumps `package.json` and both root version entries in `package-lock.json`.
3. Generates `CHANGELOG.md` from commit messages, grouped by type with breaking-change notes.
4. Runs formatting, type checks, unit tests, and the build.
5. Commits the version/changelog as `chore(release): x.y.z`, creates an annotated `vx.y.z` tag, and atomically pushes the commit and tag.
6. Creates a GitHub release containing the new changelog section.

Enable **dry_run** to preview the bump and release notes in the Actions run summary. The preview only modifies the runner's checkout. For example:

```sh
gh workflow run release.yml --ref main -f bump=patch -F dry_run=true
```

Releases use the workflow's `GITHUB_TOKEN` with `contents: write`. They are serialized, and a concurrent change to `main` causes the atomic push to fail rather than overwrite that change. If release creation fails after a successful push, the existing tag can be used to create the GitHub release with the corresponding changelog section.

The release workflow does **not publish to npm** or invoke AI/E2E tests. GitHub releases provide the tagged source archives. Release commits made with `GITHUB_TOKEN` do not trigger another CI run; the release workflow itself runs the checks before pushing.

## Developer references

- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode agent configuration](https://opencode.ai/v2/docs/agents)
- [Jev API](https://docs.typesafe.ai/api)
- [Jev confidence](https://docs.typesafe.ai/confidence)
