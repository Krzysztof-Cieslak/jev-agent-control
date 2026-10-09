# Jev Agent Control

[![CI](https://github.com/Krzysztof-Cieslak/jev-agent-control/actions/workflows/ci.yml/badge.svg)](https://github.com/Krzysztof-Cieslak/jev-agent-control/actions/workflows/ci.yml)

An **OpenCode V2 server plugin** that uses [Jev](https://docs.typesafe.ai/introduction) to route requests between Plan, Build, and your own primary agents. It also hands off unfinished work at completed execution boundaries and follows each target agent's configured model.

Requires OpenCode V2; tested with **OpenCode 2.0.24**.

## Install from npm

For npm releases, add the package to your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-jev-agent-control",
      "options": {
        "enabled": true,
        "autoHandoff": true,
      },
    },
  ],
}
```

OpenCode installs the package automatically. Then [connect your TypeSafe account](#api-key).

## Install locally

To use a local checkout or unreleased changes, clone this repository and build it with Node.js 20+ and npm:

```sh
git clone https://github.com/Krzysztof-Cieslak/jev-agent-control.git
cd jev-agent-control
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

Replace the example path with your checkout's absolute path and merge the entry into your existing configuration.

### API key

Connect TypeSafe through OpenCode's existing account management:

1. Open `/connect` in a project with this plugin enabled.
2. Select **TypeSafe (Jev)**, choose **API key**, and paste your TypeSafe API key.
3. Start a request; Jev routing uses your active TypeSafe account automatically.

You can also connect from a terminal in the project:

```sh
opencode auth login typesafe --method key
```

Use `/connect` to add, switch, or delete saved accounts. OpenCode stores them in its server-side credential database and makes them available across projects using the same server. The plugin resolves the active account for each decision, so account switches, key changes, and removals take effect on the next evaluation without restarting OpenCode. Rejected keys are marked as needing authentication in OpenCode's account UI.

## Use

Routing is automatic by default. Send a normal request:

> Design, implement, and review password reset. Proceed through all three steps.

With a suitable reviewer agent, Jev can route this through `plan → build → reviewer`. A request for **planning only** should finish after planning. Handoffs depend on Jev's interpretation and the configured confidence thresholds.

Jev selects an agent for new requests when the session is idle and reassesses after an agent finishes its work. Messages sent during an active run are reassessed when that run completes. Automatic handoffs stop when the requested work is complete or needs your input.

### Optional controls

| Command       | Effect                                              |
| ------------- | --------------------------------------------------- |
| `/jev-auto`   | Enable automatic routing for the next user request. |
| `/jev-pause`  | Pause routing for this session.                     |
| `/jev-status` | Show the mode and five most recent decisions.       |

Use OpenCode's native agent and model selectors for manual overrides. Selecting either pauses automatic routing; `/jev-auto` restores it. Your mode and recent routing decisions are remembered across restarts. Commands add a status notice to the session inbox without making an extra LLM call.

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

Jev Choice supports at most 255 options. Automatic routing requires at least two eligible agents. The whole Jev request is capped at 24,000 characters, so very large agent catalogs may need shorter descriptions or `includeAgents`.

### Routing behavior and context

Jev receives your latest request, a bounded recent transcript, agent descriptions, and the latest conversation summary when available. Textual tool outcomes are included; reasoning, binary attachments, and complete file blobs are omitted.

Jev outages, invalid responses, and low confidence retain your current selection. Queued user input takes precedence over automatic continuation. Repeated transitions and the handoff limit prevent cycles. The selected agent's normal OpenCode instructions and permissions apply.

Recent decision history records choices, probabilities, confidence, model version, and latency—not the transcript sent for evaluation. Inspect it with `/jev-status`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, tests, Conventional Commits, and release instructions.

Version history is available in the [changelog](CHANGELOG.md).

## Code of conduct

This project follows the [Contributor Covenant 3.0 Code of Conduct](CODE_OF_CONDUCT.md). Please read it before participating; it includes private reporting instructions.

## License

Licensed under the [MIT License](LICENSE).

## References

- [OpenCode agent configuration](https://opencode.ai/v2/docs/agents)
- [Jev confidence](https://docs.typesafe.ai/confidence)
