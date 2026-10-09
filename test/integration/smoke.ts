import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "../../src/types.js";

// Run in its own process so the SDK never sees the developer's global config/database.
const root = await mkdtemp(
  join(process.env.TMPDIR ?? tmpdir(), "jev-integration-"),
);
for (const name of ["config", "data", "cache", "state", "workspace"])
  await mkdir(join(root, name));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.TYPESAFE_API_KEY = "local-test-key";

const modelCalls: string[] = [];
const jevCalls: { trigger: string; agent: string }[] = [];
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/v1/systemone") {
      const state = body.state;
      const planOnly = String(state.latest_request).includes("Plan only");
      const agent =
        state.trigger === "prompt"
          ? "plan"
          : planOnly
            ? "plan"
            : state.current_agent === "plan"
              ? "build"
              : "reviewer";
      const status =
        state.trigger === "idle" &&
        (planOnly || state.current_agent === "reviewer")
          ? "complete"
          : "work_remaining";
      jevCalls.push({ trigger: state.trigger, agent });
      const answer = (choice: string, criteria: Record<string, unknown>) => ({
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((id) => [id, id === choice ? 1 : 0]),
        ),
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model: "jev-mock",
          answers: {
            next_agent: answer(agent, body.questions.next_agent.criteria),
            work_status: answer(status, body.questions.work_status.criteria),
          },
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
      return;
    }
    modelCalls.push(body.model);
    const text =
      body.model === "plan"
        ? "Plan ready. Implementation and review remain."
        : body.model === "build"
          ? "Implementation ready. Review remains."
          : "Review complete. All requested work is done.";
    res.setHeader("Content-Type", "text/event-stream");
    const base = {
      id: "completion-test",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
process.env.TYPESAFE_BASE_URL = url;

const { OpenCode } = await import("@opencode/sdk");
const { Plugin, Model, Provider } = await import("@opencode/plugin");
// Exercise the emitted package entrypoint, including real plugin loading and SDK calls.
const {
  default: plugin,
}: { default: import("@opencode/plugin").Plugin.Plugin } = await import(
  process.env.JEV_PLUGIN_ENTRY ?? "../../dist/index.js"
);
const fixture = Plugin.define({
  id: "jev-test-fixture",
  async setup(ctx) {
    await ctx.session.hook("title", (event) => {
      event.result = "Integration session";
    });
    const providerID = Provider.ID.make("jev-test");
    await ctx.provider.transform((editor) =>
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Jev test",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${url}/v1`, apiKey: "local-test-key" },
        },
        models: ["plan", "build", "reviewer"].map((id) => ({
          ...Model.Info.default(providerID, Model.ID.make(id)),
          name: id,
        })),
      }),
    );
    await ctx.model.transform((editor) =>
      editor.default.set("jev-test", "build"),
    );
  },
});

let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
try {
  host = await OpenCode.create({
    database: { path: join(root, "test.sqlite") },
    config: {
      directory: join(root, "config"),
      project: false,
      content: JSON.stringify({
        model: "jev-test/build",
        agents: Object.fromEntries(
          ["plan", "build", "reviewer"].map((id) => [
            id,
            {
              mode: "primary",
              model: `jev-test/${id}`,
              description: id,
              system:
                "Respond with a short completion status. Do not invoke tools.",
            },
          ]),
        ),
      }),
    },
    models: { fetch: false, snapshot: false },
    fs: { filewatcher: false, fff: false },
    plugins: [fixture, plugin],
    log: { level: "error" },
  });
  const session = await host.sessions.create({
    location: { directory: join(root, "workspace") },
  });
  await host.sessions.prompt({
    sessionID: session.id,
    text: "Design, implement, and review a feature",
  });
  const deadline = Date.now() + 20000;
  while (
    (modelCalls.length < 3 || jevCalls.length < 4) &&
    Date.now() < deadline
  )
    await delay(50);
  await host.sessions.wait({ sessionID: session.id });
  const current = await host.sessions.get({ sessionID: session.id });
  const messages: Message[] = await host.sessions.context({
    sessionID: session.id,
  });
  assert.deepEqual(
    modelCalls,
    ["plan", "build", "reviewer"],
    JSON.stringify({ modelCalls, jevCalls, current, messages }),
  );
  assert.equal(current.agent, "reviewer");
  assert.equal(current.model?.id, "reviewer");
  assert.equal(
    messages.filter(
      (m) => m.type === "synthetic" && m.metadata?.kind === "handoff",
    ).length,
    2,
  );
  const next = await host.sessions.create({
    location: { directory: join(root, "workspace") },
  });
  await host.sessions.prompt({
    sessionID: next.id,
    text: "Plan only; do not implement",
  });
  await host.sessions.wait({ sessionID: next.id });
  const end = Date.now() + 5000;
  while (jevCalls.length < 6 && Date.now() < end) await delay(50);
  assert.deepEqual(modelCalls, ["plan", "build", "reviewer", "plan"]);
  const decisionsBeforeOverride = jevCalls.length;
  await host.sessions.switchAgent({
    sessionID: next.id,
    agent: "reviewer",
  });
  await host.sessions.switchModel({
    sessionID: next.id,
    model: { providerID: "jev-test", id: "reviewer" },
  });
  await host.sessions.prompt({ sessionID: next.id, text: "Review this" });
  await host.sessions.wait({ sessionID: next.id });
  assert.equal(
    (await host.sessions.get({ sessionID: next.id })).agent,
    "reviewer",
  );
  assert.equal(modelCalls.at(-1), "reviewer");
  assert.equal(jevCalls.length, decisionsBeforeOverride);
  console.log(
    "Integration passed: real OpenCode host, prompt routing, two autonomous handoffs, model switching, plan-only completion, and native manual overrides.",
  );
} finally {
  await host?.close();
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
}
