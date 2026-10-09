import assert from "node:assert/strict";
import { test } from "node:test";
import { assistant, decision, deferred, harness } from "./helpers.js";

test("routes an incoming request and follows the configured agent model", async () => {
  const h = harness(async () => decision());
  await h.controller.prompt(h.state.id, "msg_request", "Plan a feature");
  assert.deepEqual(h.changes, ["agent:plan", "model:plan"]);
  assert.equal((await h.controller.control(h.state.id)).mode.type, "auto");
  await h.controller.close();
});

test("plan → build → reviewer resumes each handoff once, then stops", async () => {
  const choices = [
    decision("plan"),
    decision("build"),
    decision("reviewer"),
    decision("reviewer", "complete"),
  ];
  const h = harness(async () => choices.shift()!);
  await h.controller.prompt(
    h.state.id,
    "msg_request",
    "Design, implement, review",
  );
  h.admit();
  h.messages.push(assistant("Plan ready"));
  await h.finish("evt_plan_done");
  await h.finish("evt_plan_done");
  assert.equal(h.continuations.length, 1);
  await h.finish();
  await h.finish();
  assert.equal(h.state.agent, "reviewer");
  assert.equal(h.state.model?.id, "reviewer");
  assert.equal(h.continuations.length, 2);
  assert.equal(
    (await h.controller.control(h.state.id)).traces.at(-1)?.outcome,
    "complete",
  );
  await h.controller.close();
});

test("a stale Jev answer cannot overwrite a newer request", async () => {
  const started = deferred<void>();
  const old = deferred<ReturnType<typeof decision>>();
  let calls = 0;
  const h = harness(async () => {
    if (++calls === 1) {
      started.resolve();
      return old.promise;
    }
    return decision("reviewer");
  });
  const first = h.controller.prompt(h.state.id, "msg_1", "Plan");
  await started.promise;
  const second = h.controller.prompt(h.state.id, "msg_2", "Review instead");
  await Promise.all([first, second]);
  old.resolve(decision("plan"));
  assert.deepEqual(h.changes, ["agent:reviewer", "model:reviewer"]);
  await h.controller.close();
});

test("duplicate prompt admission shares one evaluation", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return decision();
  });
  await Promise.all([
    h.controller.prompt(h.state.id, "msg_same", "Plan"),
    h.controller.prompt(h.state.id, "msg_same", "Plan"),
  ]);
  assert.equal(calls, 1);
  await h.controller.close();
});

test("uncertainty and service errors retain the current agent", async () => {
  for (const evaluate of [
    async () => decision("plan", "work_remaining", 0.2),
    async () => {
      throw new Error("service failure");
    },
  ]) {
    const h = harness(evaluate);
    await h.controller.prompt(h.state.id, "msg_1", "Maybe do something");
    assert.deepEqual(h.changes, []);
    await h.controller.close();
  }
});

test("deadline releases the prompt even if the evaluator ignores cancellation", async () => {
  const h = harness(() => new Promise(() => {}), { timeoutMs: 100 });
  const start = performance.now();
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  assert.ok(performance.now() - start < 1000);
  assert.equal(h.state.agent, "build");
  await h.controller.close();
});

test("manual selection during evaluation pauses routing", async () => {
  const started = deferred<void>();
  const h = harness(async () => {
    started.resolve();
    return new Promise(() => {});
  });
  const prompt = h.controller.prompt(h.state.id, "msg_1", "Plan");
  await started.promise;
  h.emit("session.agent.selected", { agent: "reviewer" });
  await prompt;
  assert.equal((await h.controller.control(h.state.id)).mode.type, "paused");
  assert.deepEqual(h.changes, []);
  await h.controller.close();
});

test("paused and pinned modes persist and pinning does not invoke Jev", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return decision();
  });
  await h.controller.control(h.state.id, { type: "paused" });
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  await h.controller.control(h.state.id, { type: "pinned", agent: "reviewer" });
  await h.controller.prompt(h.state.id, "msg_2", "Continue");
  assert.equal(calls, 0);
  assert.equal(h.state.agent, "reviewer");
  assert.equal(h.saved.get(h.state.id)?.mode.type, "pinned");
  await assert.rejects(
    h.controller.control(h.state.id, { type: "pinned", agent: "missing" }),
  );
  await h.controller.close();
});

test("interrupted or waiting-for-user work is not resumed", async () => {
  for (const event of [
    "session.execution.interrupted",
    "session.execution.failed",
  ]) {
    const h = harness(async () => decision());
    await h.controller.prompt(h.state.id, "msg_1", "Plan");
    h.admit();
    h.emit(event, { reason: "user" });
    await h.finish();
    assert.equal(h.continuations.length, 0);
    await h.controller.close();
  }
  const h = harness(async (input) =>
    input.state.trigger === "prompt"
      ? decision("plan")
      : decision("build", "needs_user"),
  );
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  h.admit();
  await h.finish();
  assert.equal(h.continuations.length, 0);
  await h.controller.close();
});

test("queued user input prevents an autonomous continuation", async () => {
  const h = harness(async () => decision());
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  h.admit();
  h.emit("session.inbox.enqueued", {
    inboxID: "msg_queue",
    item: {
      type: "user",
      payload: { text: "Different task" },
      delivery: "queue",
    },
  });
  await h.finish();
  assert.equal(h.continuations.length, 0);
  await h.controller.close();
});

test("running sessions defer routing, and foreign/child sessions are excluded", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return decision();
  });
  h.controller.running(h.state.id);
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  assert.equal(calls, 0);
  h.emit("session.execution.succeeded", {}, "evt_foreign", "/other");
  assert.equal(h.continuations.length, 0);
  h.state.parentID = "ses_parent";
  h.emit("session.execution.succeeded");
  await h.controller.prompt(h.state.id, "msg_2", "Plan");
  assert.equal(calls, 0);
  await h.controller.close();
});

test("unavailable models block a switch and a failed model update rolls back the agent", async () => {
  const h = harness(async () => decision());
  h.host.models = async () => [];
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  assert.deepEqual(h.changes, []);
  await h.controller.close();
  const other = harness(async () => decision());
  other.host.switchModel = async () => {
    throw new Error("model update failed");
  };
  await other.controller.prompt(other.state.id, "msg_1", "Plan");
  assert.equal(other.state.agent, "build");
  assert.equal(other.state.model?.id, "build");
  await other.controller.close();
});

test("the handoff budget terminates a routing cycle", async () => {
  const choices = ["plan", "build", "plan", "build"];
  const h = harness(async () => decision(choices.shift()), { maxHandoffs: 2 });
  await h.controller.prompt(h.state.id, "msg_1", "Do work");
  h.admit();
  await h.finish();
  await h.finish();
  await h.finish();
  assert.equal(h.continuations.length, 2);
  assert.equal(
    (await h.controller.control(h.state.id)).traces.at(-1)?.outcome,
    "handoff-limit",
  );
  await h.controller.close();
});

test("Plan-mode notifications do not cancel a handoff", async () => {
  const h = harness(async () => decision("plan"));
  const switchAgent = h.host.switchAgent;
  h.host.switchAgent = async (id, agent) => {
    await switchAgent(id, agent);
    h.emit("session.inbox.enqueued", {
      inboxID: "msg_reminder",
      item: {
        type: "synthetic",
        payload: { text: "You are in Plan mode" },
        delivery: "steer",
      },
    });
  };
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  assert.equal(h.state.agent, "plan");
  assert.equal(h.state.model?.id, "plan");
  await h.controller.close();
});

test("a model update that commits before reporting an error is rolled back", async () => {
  const h = harness(async () => decision("plan"));
  const switchModel = h.host.switchModel;
  h.host.switchModel = async (id, model) => {
    await switchModel(id, model);
    if (model.id === "plan") throw new Error("response lost after commit");
  };
  await h.controller.prompt(h.state.id, "msg_1", "Plan");
  assert.equal(h.state.agent, "build");
  assert.equal(h.state.model?.id, "build");
  await h.controller.close();
});

test("new input while an idle decision is pending prevents a stale continuation", async () => {
  const started = deferred<void>();
  const h = harness(async (input) => {
    if (input.state.trigger === "idle") {
      started.resolve();
      return new Promise(() => {});
    }
    return decision("plan");
  });
  await h.controller.prompt(h.state.id, "msg_1", "Plan and build");
  h.admit();
  const completion = h.finish();
  await started.promise;
  await h.controller.prompt(h.state.id, "msg_2", "Actually, plan only");
  await completion;
  assert.equal(h.continuations.length, 0);
  await h.controller.close();
});
