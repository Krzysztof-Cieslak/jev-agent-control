# Jev Agent Control

[![CI](https://github.com/Krzysztof-Cieslak/jev-agent-control/actions/workflows/ci.yml/badge.svg)](https://github.com/Krzysztof-Cieslak/jev-agent-control/actions/workflows/ci.yml)

An **OpenCode V2 server plugin** that uses [Jev](https://docs.typesafe.ai/introduction) to route requests between Plan, Build, and your own primary agents. It also hands off unfinished work at completed execution boundaries and follows each target agent's configured model.

Tested with **OpenCode 2.0.24**. The plugin API dependency is pinned to that release.

## Install locally

From this checkout:

```sh
npm ci
npm run build
```

Add the plugin to the `opencode.jsonc` of the project where you want routing:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/jev-agent-control",
      "options": {
        "enabled": true,
        "autoHandoff": true,
      },
    },
  ],
}
```

Merge this entry into existing configuration. The plugin is built as an npm package, but has not been published to npm.

### API key

The **OpenCode server process** needs `TYPESAFE_API_KEY`. For a local standalone session, you can load your `.env` before launching OpenCode:

```sh
set -a
. ./.env
set +a
opencode --standalone
```

An already-running shared OpenCode service must be restarted with the key available in its environment. The plugin reads environment variables; it does not automatically read a project's `.env`. The live test command below explicitly loads `.env`.

`TYPESAFE_BASE_URL` can override the TypeSafe API root for testing or a proxy. The default endpoint is `https://api.typesafe.ai/v1/systemone`.

## Use

Send a normal request:

> Design, implement, and review password reset. Proceed through all three steps.

With a suitable reviewer agent, Jev can route this through `plan → build → reviewer`. A request for **planning only** should finish after planning. Handoffs depend on Jev's interpretation and the configured confidence thresholds.

| Command             | Effect                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| `/jev-auto`         | Enable automatic routing for the next user request.                         |
| `/jev-pause`        | Pause routing for this session.                                             |
| `/jev-pin reviewer` | Use this agent on subsequent user requests, including its configured model. |
| `/jev-status`       | Show the mode and five most recent decisions.                               |

Commands add a non-resuming synthetic status notice to the session inbox, so they do not make an extra LLM call. Manual agent **or model** selection pauses automatic routing; use `/jev-auto` to restore it. Modes and bounded decision history persist in OpenCode's plugin storage.

### Custom agents

Define agents normally in `.opencode/agents/` or `agents` in `opencode.jsonc`. Set `mode: primary` or `mode: all` and give each a clear description. Hidden and subagent-only profiles are excluded.

```jsonc
{
  "agents": {
    "reviewer": {
      "mode": "primary",
      "description": "Reviews completed changes for bugs and regressions",
      "system": "Review the current changes and report actionable findings. Do not implement changes.",
      "permissions": [{ "action": "edit", "resource": "*", "effect": "deny" }],
    },
  },
}
```

Set an agent's `model` to an available `provider/model#variant` to switch models with that agent. Without a configured model, the session retains its selected model. An unavailable configured model prevents that switch. See [examples/opencode.jsonc](examples/opencode.jsonc) for a combined example.

## Configuration

Options belong inside the plugin entry's `options` object.

| Option          | Default        | Meaning                                                                           |
| --------------- | -------------- | --------------------------------------------------------------------------------- |
| `enabled`       | `true`         | Initial mode for sessions without saved preferences.                              |
| `autoHandoff`   | `true`         | Reassess at successful execution completion.                                      |
| `model`         | `"jev-latest"` | Jev model or pinned version, such as `jev-1.13.0`.                                |
| `minConfidence` | `0.75`         | Minimum reported Choice confidence.                                               |
| `minMargin`     | `0.15`         | Minimum winning probability minus runner-up probability.                          |
| `timeoutMs`     | `3500`         | Routing deadline, including the Jev request; automatic HTTP retries are disabled. |
| `maxHandoffs`   | `6`            | Maximum autonomous handoffs between user requests.                                |
| `contextChars`  | `12000`        | Serialized state character budget, from 1,000 to 16,000.                          |
| `historyLimit`  | `20`           | Stored decisions per session, from 1 to 100.                                      |
| `includeAgents` | all eligible   | Optional list of permitted agent IDs.                                             |
| `excludeAgents` | `[]`           | Agent IDs excluded from routing.                                                  |
| `descriptions`  | `{}`           | Routing-description overrides keyed by agent ID.                                  |

Jev Choice supports at most 255 options. Automatic routing requires at least two eligible agents; pinning also works with one. The whole Jev request is capped at 24,000 characters, so very large agent catalogs may need shorter descriptions or `includeAgents`.

## How it works

1. The prompt admission hook routes an incoming request when the session is idle. Input arriving during an active run is reassessed at its next successful completion.
2. The plugin sends Jev the latest request, a bounded recent transcript, available agent descriptions, and the most recent compaction summary when present. Textual tool outcomes are included; reasoning, binary attachments, and complete file blobs are omitted.
3. One Jev request asks two independent Choice questions: **next agent** and **work status** (`work_remaining`, `needs_user`, or `complete`).
4. The controller validates the response, confidence, and probability margin, then switches the agent and its configured model. It rechecks the session and catalog before applying a decision and attempts rollback if a partial switch fails.
5. On successful execution completion, a confident decision that requested work remains can switch to a different agent and submit one idempotently identified synthetic continuation. A same-agent decision ends the handoff cycle rather than repeatedly asking that agent to continue.

New input, manual selection, and interruption invalidate pending decisions. Queued user input takes precedence over autonomous continuation. Each session is serialized independently; child sessions and other project locations are excluded. A repeated transition or the handoff budget stops cycles. Reloading the plugin does not resume old work automatically.

Jev outages, invalid responses, and low confidence retain the current selection. Decision history contains choices, probabilities, confidence, model version, and latency—not the transcript sent for evaluation. The selected agent's normal OpenCode instructions and permissions apply.

## Development and verification

### Continuous integration

[GitHub Actions](https://github.com/Krzysztof-Cieslak/jev-agent-control/actions/workflows/ci.yml) runs on pushes to `main`, pull requests, and manual dispatches. On Node.js **20, 22, and 24**, it checks formatting and types, runs the unit tests in `test/*.test.ts`, and builds the plugin. The unit suite uses in-memory mocks and a mock Jev HTTP transport, so CI requires no API keys and makes no AI calls.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(router): support a new routing policy
fix(jev): handle a timeout
docs: clarify installation
feat!: change the configuration format
```

Supported types are `feat`, `fix`, `perf`, `revert`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, and `style`. Scopes are optional; use `!` or a `BREAKING CHANGE:` footer for breaking changes.

`npm install` / `npm ci` installs a Husky commit-message hook. CI validates new commits and PR titles with commitlint. Use **squash merge** with the validated PR title so the resulting commit follows the same format. The release workflow validates all commits after the historical baseline in `.github/commitlint-base`; the two earlier commits are recorded in the initial changelog.

Server-side rulesets for this private repository require GitHub Pro. Until enabled, local hooks, failing CI checks, and the release gate provide validation; GitHub does not enforce a branch-rule merge block.

### GitHub releases

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

### Local checks

```sh
npm run check
npm test
npm run test:integration
npm run format:check
```

- Unit tests cover routing, cancellation, duplicate admission, model rollback, manual control, context bounds, and cycle limits.
- The integration test requires **Bun 1.3+**. It runs a real embedded OpenCode host with an isolated database/configuration and local fake Jev/LLM HTTP endpoints. It verifies Plan → Build → Reviewer, model changes, completion, and the pin command.
- Run a small **live Jev evaluation** against synthetic examples using the API key in `.env`:

  ```sh
  npm run test:live
  ```

  This makes nine billable Jev requests. It requires a Node version supporting `--env-file` (20.6+).

### Fully live end-to-end test

```sh
npm run test:e2e
```

This runs a real isolated OpenCode host with **live Jev and live OpenAI coding models**. It reads `TYPESAFE_API_KEY` from `.env` and uses `OPENAI_API_KEY` or the active OpenAI API-key connection from the local OpenCode service. The `opencode` CLI supplies the provider/model catalog.

The workflow plans, implements, tests, and independently reviews a small `slugify` module. Assertions verify the Plan → Build → Reviewer sequence, two automatic handoffs, configured model selection, passing acceptance cases, and preservation of the acceptance tests. A second request verifies that plan-only work stops without implementing or editing files.

Defaults are `gpt-5.4-nano#low` for Plan/Reviewer and `gpt-5.4-mini#low` for Build. Override model IDs with `JEV_E2E_PLAN_MODEL`, `JEV_E2E_BUILD_MODEL`, and `JEV_E2E_REVIEW_MODEL` (the selected models must support the `low` variant). This test incurs normal provider charges.

It prints the artifact directory containing the generated project and `results.json` with model turns, routing decisions, and transcripts. The temporary OpenCode runtime/database is removed afterward. `JEV_PLUGIN_ENTRY` can point at an installed package's `dist/index.js` to exercise that build instead.

Package for distribution:

```sh
npm pack
```

Only `dist/`, examples, README, and package metadata are included. To verify an installed tarball, set `JEV_PLUGIN_ENTRY` to its installed `dist/index.js` when running `test:integration`.

## References

- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode agent configuration](https://opencode.ai/v2/docs/agents)
- [Jev API](https://docs.typesafe.ai/api)
- [Jev confidence](https://docs.typesafe.ai/confidence)
