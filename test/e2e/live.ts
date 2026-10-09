import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Plugin as PluginTypes } from "@opencode/plugin";
import type {
  Message,
  ModelRef,
  SavedState,
  Session,
} from "../../src/types.js";

// Read the existing service through its authenticated CLI before isolating XDG paths.
// Credentials stay in this process's environment, never in fixtures or test reports.
function localApi(path: string): any {
  const result = JSON.parse(
    execFileSync("opencode", ["api", "get", path], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  return result.data ?? result;
}

assert.ok(
  process.env.TYPESAFE_API_KEY,
  "Set TYPESAFE_API_KEY or run with --env-file=.env",
);
if (!process.env.OPENAI_API_KEY) {
  const credential = localApi("/api/credential").find(
    (item: any) =>
      item.integrationID === "openai" &&
      item.active &&
      item.value.type === "key",
  );
  assert.ok(
    credential,
    "This live test needs OPENAI_API_KEY or an active OpenAI API-key connection in OpenCode",
  );
  process.env.OPENAI_API_KEY = credential.value.key;
}
const provider = localApi("/api/provider/openai");
const sourceModels = localApi("/api/model").filter(
  (model: any) => model.providerID === "openai" && model.enabled,
);
const configured: Record<string, ModelRef> = {
  plan: {
    providerID: "openai",
    id: process.env.JEV_E2E_PLAN_MODEL ?? "gpt-5.4-nano",
    variant: "low",
  },
  build: {
    providerID: "openai",
    id: process.env.JEV_E2E_BUILD_MODEL ?? "gpt-5.4-mini",
    variant: "low",
  },
  reviewer: {
    providerID: "openai",
    id: process.env.JEV_E2E_REVIEW_MODEL ?? "gpt-5.4-nano",
    variant: "low",
  },
};
for (const model of Object.values(configured))
  assert.ok(
    sourceModels.some((item: any) => item.id === model.id),
    `Model unavailable: ${model.id}`,
  );

const temporary =
  process.env.TMPDIR ??
  (await access("/tmp/opencode").then(
    () => "/tmp/opencode",
    () => tmpdir(),
  ));
const root = await mkdtemp(join(temporary, "jev-live-e2e-"));
const runtime = join(root, "runtime");
const workspace = join(root, "workspace");
for (const name of ["config", "data", "cache", "state"]) {
  await mkdir(join(runtime, name), { recursive: true });
  process.env[`XDG_${name.toUpperCase()}_HOME`] = join(runtime, name);
}
await mkdir(join(workspace, "src"), { recursive: true });
await mkdir(join(workspace, "test"));
await writeFile(
  join(workspace, "package.json"),
  JSON.stringify(
    {
      name: "jev-live-e2e-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    },
    null,
    2,
  ),
);
const acceptanceSource = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.js';
test('slugify handles ASCII text and separator edge cases', () => {
  for (const [input, expected] of [
    ['  Hello, World!  ', 'hello-world'],
    ['one___two---THREE', 'one-two-three'],
    ['Version 2.0', 'version-2-0'],
    ['', ''], ['!!!', ''], ['already-good', 'already-good']
  ]) assert.equal(slugify(input), expected);
});
`;
await writeFile(join(workspace, "test/slugify.test.js"), acceptanceSource);

const { OpenCode } = await import("@opencode/sdk");
const { Plugin, Model, Provider } = await import("@opencode/plugin");
const { Schema } = await import("effect");
const { default: production }: { default: PluginTypes.Plugin } = await import(
  process.env.JEV_PLUGIN_ENTRY ?? "../../dist/index.js"
);
let pluginContext: PluginTypes.Context | undefined;
const requests: { sessionID: string; agent: string; model: ModelRef }[] = [];
const setup = Plugin.define({
  id: "jev-live-e2e-observer",
  async setup(ctx) {
    // Use the actual configured provider and model definitions, with live transport.
    await ctx.provider.transform((editor) =>
      editor.add({
        info: {
          ...Schema.decodeUnknownSync(Provider.Info)(provider),
          activation: "enabled",
          headers: {
            ...provider.headers,
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        },
        models: sourceModels
          .filter((model: any) =>
            Object.values(configured).some((ref) => ref.id === model.id),
          )
          .map((model: unknown) => Schema.decodeUnknownSync(Model.Info)(model)),
      }),
    );
    await ctx.session.hook("context", (event) => {
      requests.push({
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
      });
      console.log(
        `Live model turn: ${event.agent} → ${event.model.providerID}/${event.model.id}#${event.model.variant ?? "default"}`,
      );
      assert.ok(
        requests.length <= 30,
        "Live test exceeded its model-turn budget",
      );
    });
    await ctx.session.hook("title", (event) => {
      event.result = "Jev live E2E";
    });
  },
});
const plugin = Plugin.define({
  ...production,
  setup(ctx) {
    pluginContext = ctx;
    return production.setup(ctx);
  },
});

const modelConfig = (name: string) =>
  `${configured[name]!.providerID}/${configured[name]!.id}#${configured[name]!.variant}`;
const evidence: Record<string, unknown> = {
  artifactDirectory: root,
  models: configured,
  started: new Date().toISOString(),
  passed: false,
  cases: [],
};
let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
const sessionIDs: string[] = [];

async function awaitCompletion(sessionID: string): Promise<SavedState> {
  const deadline = Date.now() + 180000;
  let printed = 0;
  while (Date.now() < deadline) {
    const state = (await pluginContext!.storage.get(
      `sessions/${sessionID}`,
    )) as unknown as SavedState | undefined;
    if (state) {
      for (const trace of state.traces.slice(printed))
        console.log(
          `Jev ${trace.trigger}: ${trace.from ?? "default"} → ${trace.to ?? "unchanged"}, ${trace.outcome}, confidence=${trace.decision?.agent.confidence ?? "n/a"}`,
        );
      printed = state.traces.length;
      const last = state.traces.at(-1);
      if (last?.trigger === "idle" && last.outcome === "complete") return state;
      if (
        last?.trigger === "idle" &&
        !["switched", "superseded"].includes(last.outcome)
      )
        throw new Error(
          `Live routing stopped before completion: ${last.outcome}`,
        );
    }
    const session: Session = await host!.sessions.get({ sessionID });
    if (session.outcome === "failed" || session.outcome === "interrupted")
      throw new Error(`Live OpenCode execution ${session.outcome}`);
    await delay(250);
  }
  throw new Error("Live E2E timed out after 180 seconds");
}

async function capture(sessionID: string) {
  const session: Session = await host!.sessions.get({ sessionID });
  const messages: Message[] = await host!.sessions.context({ sessionID });
  const routing = await pluginContext!.storage.get(`sessions/${sessionID}`);
  return {
    sessionID,
    agent: session.agent,
    model: session.model,
    cost: session.cost,
    tokens: session.tokens,
    requests: requests.filter((request) => request.sessionID === sessionID),
    routing,
    messages,
  };
}

try {
  host = await OpenCode.create({
    database: { path: join(runtime, "test.sqlite") },
    config: {
      directory: join(runtime, "config"),
      project: false,
      content: JSON.stringify({
        model: modelConfig("build"),
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...["read", "glob", "grep", "edit", "shell"].map((action) => ({
            action,
            resource: "*",
            effect: "allow",
          })),
        ],
        agents: {
          plan: {
            mode: "primary",
            model: modelConfig("plan"),
            steps: 5,
            description: "Read-only design and planning before implementation",
            system:
              "You are the planning phase. Read the user's requirements and relevant files, and provide a concise implementation plan. Do not implement or perform the independent review. Finish your response once the plan is ready for the implementation agent.",
          },
          build: {
            mode: "primary",
            model: modelConfig("build"),
            steps: 12,
            description: "Implement planned code changes and run tests",
            system:
              "You are the implementation phase. Implement the user's requested changes and run tests. A separate reviewer agent handles the independent review afterward. Finish your response once implementation and tests are complete; report what was done and what remains for independent review.",
          },
          reviewer: {
            mode: "primary",
            model: modelConfig("reviewer"),
            steps: 7,
            description:
              "Independently review completed code and tests for correctness; report findings without modifying files",
            system:
              "You are the independent code reviewer. Read the implemented code and tests, check the requested behavior, and run tests if useful. Do not modify files. End with your review findings or an explicit statement that no issues were found and the requested work is complete.",
            permissions: [{ action: "edit", resource: "*", effect: "deny" }],
          },
        },
      }),
    },
    models: { fetch: false, snapshot: false },
    fs: { filewatcher: false, fff: false },
    plugins: [setup, plugin],
    log: { level: "error" },
  });
  console.log(`Live E2E artifacts: ${root}`);
  const first: Session = await host.sessions.create({
    location: { directory: workspace },
  });
  sessionIDs.push(first.id);
  await host.sessions.prompt({
    sessionID: first.id,
    text: "Complete these three phases in order: first plan, then implement and test, then have the independent reviewer review. Implement a named export slugify(text) in src/slugify.js. Input is a string: lowercase it, replace each run of characters outside ASCII a-z and 0-9 with a single hyphen, and remove leading and trailing hyphens. Empty input or only separators returns an empty string. Existing test/slugify.test.js provides acceptance cases; preserve those tests. Work only in this project. Proceed through all three phases automatically; no requirements clarification is needed.",
  });
  await awaitCompletion(first.id);
  await host.sessions.wait({ sessionID: first.id });
  const workflow = await capture(first.id);
  (evidence.cases as unknown[]).push({
    name: "plan-build-review",
    ...workflow,
  });
  const stages = workflow.requests
    .map((request) => request.agent)
    .filter((agent, index, all) => index === 0 || agent !== all[index - 1]);
  assert.deepEqual(stages, ["plan", "build", "reviewer"]);
  for (const request of workflow.requests)
    assert.deepEqual(request.model, configured[request.agent]);
  assert.equal(
    workflow.messages.filter(
      (message) =>
        message.type === "synthetic" && message.metadata?.kind === "handoff",
    ).length,
    2,
  );
  assert.equal(workflow.agent, "reviewer");
  const tests = execFileSync("node", ["--test"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.equal(
    await readFile(join(workspace, "test/slugify.test.js"), "utf8"),
    acceptanceSource,
    "The implementation must preserve the acceptance tests",
  );
  evidence.acceptanceTests = tests;
  evidence.implementation = await readFile(
    join(workspace, "src/slugify.js"),
    "utf8",
  );
  console.log("Generated-code acceptance tests passed.");

  const second: Session = await host.sessions.create({
    location: { directory: workspace },
  });
  sessionIDs.push(second.id);
  await host.sessions.prompt({
    sessionID: second.id,
    text: "Plan only how to add a named export capitalize(text) in src/capitalize.js that uppercases the first character of a string. Do not implement it, do not edit files, and do not proceed to build or review. A short plan is the entire requested deliverable.",
  });
  await awaitCompletion(second.id);
  await host.sessions.wait({ sessionID: second.id });
  const planOnly = await capture(second.id);
  (evidence.cases as unknown[]).push({ name: "plan-only", ...planOnly });
  assert.ok(
    planOnly.requests.length > 0 &&
      planOnly.requests.every((request) => request.agent === "plan"),
  );
  assert.equal(
    planOnly.messages.filter(
      (message) =>
        message.type === "synthetic" && message.metadata?.kind === "handoff",
    ).length,
    0,
  );
  await assert.rejects(access(join(workspace, "src/capitalize.js")));
  assert.equal(
    await readFile(join(workspace, "src/slugify.js"), "utf8"),
    evidence.implementation,
    "Plan-only work must not edit the implementation",
  );
  assert.equal(
    await readFile(join(workspace, "test/slugify.test.js"), "utf8"),
    acceptanceSource,
    "Plan-only work must not edit the acceptance tests",
  );
  evidence.passed = true;
  console.log(
    "LIVE E2E PASSED: real Jev, real OpenAI model turns, tool-driven implementation, two automatic handoffs, model changes, independent review, and plan-only scope.",
  );
} catch (error) {
  evidence.error = error instanceof Error ? error.message : "Unknown failure";
  evidence.failureSnapshots = await Promise.all(
    sessionIDs.map((id) =>
      capture(id).catch(() => ({ sessionID: id, unavailable: true })),
    ),
  );
  console.error(
    `LIVE E2E FAILED: ${error instanceof Error ? error.message : "Unknown failure"}`,
  );
  process.exitCode = 1;
} finally {
  evidence.finished = new Date().toISOString();
  await writeFile(
    join(root, "results.json"),
    JSON.stringify(evidence, null, 2),
  );
  await host?.close();
  await rm(runtime, { recursive: true, force: true });
  console.log(`Evidence saved: ${join(root, "results.json")}`);
}
