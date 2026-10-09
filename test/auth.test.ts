import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticationError } from "@typesafe-ai/sdk";
import {
  registerTypeSafe,
  TypeSafeNotConnectedError,
  TYPESAFE_INTEGRATION,
} from "../src/auth.js";
import { parseOptions } from "../src/config.js";
import { createEvaluator } from "../src/jev.js";
import { deferred, harness } from "./helpers.js";

type Integration = Parameters<typeof registerTypeSafe>[0];
type Editor = Parameters<Parameters<Integration["transform"]>[0]>[0];
type Connection = NonNullable<
  Awaited<ReturnType<Integration["connection"]["active"]>>
>;
type Credential = Awaited<ReturnType<Integration["connection"]["resolve"]>>;
type StatusUpdate = Parameters<Integration["connection"]["status"]>[0];

function integrationFixture(options: { statusFailure?: boolean } = {}) {
  let active: Connection | undefined;
  let lookups = 0;
  const credentials = new Map<string, Credential>();
  const entries = new Map<string, { id: string; name: string }>();
  const methods: Parameters<Editor["method"]["update"]>[0][] = [];
  const statuses: StatusUpdate[] = [];
  const key = (connection: Connection) =>
    connection.type === "credential" ? connection.id : connection.name;
  const integration: Integration = {
    transform: async (callback) => {
      callback({
        list: () => [...entries.values()],
        get: (id) => entries.get(id),
        update: (id, update) => {
          const entry = entries.get(id) ?? { id, name: id };
          update(entry);
          entries.set(id, entry);
        },
        remove: (id) => {
          entries.delete(id);
        },
        method: {
          list: (id) =>
            methods
              .filter((registration) => registration.integrationID === id)
              .map((registration) => registration.method),
          update: (registration) => {
            methods.push(registration);
          },
          remove: () => {},
        },
      });
      return { dispose: async () => {} };
    },
    connection: {
      active: async (id) => {
        assert.equal(id, TYPESAFE_INTEGRATION);
        lookups++;
        return structuredClone(active);
      },
      resolve: async (connection) =>
        structuredClone(credentials.get(key(connection))),
      status: async (update) => {
        if (options.statusFailure) throw new Error("Unavailable");
        statuses.push(update);
        if (active && key(active) === key(update.connection))
          active.status = update.status;
      },
    },
  };
  return {
    integration,
    credentials,
    entries,
    methods,
    statuses,
    lookups: () => lookups,
    select: (connection: Connection | undefined, apiKey?: string) => {
      active = connection;
      if (connection && apiKey !== undefined)
        credentials.set(key(connection), { type: "key", key: apiKey });
    },
  };
}

const savedAccount = (id: string): Connection => ({
  type: "credential",
  id,
  label: id,
  method: "key",
});
const input = {
  state: { latest_request: "Plan a feature" },
  candidates: [
    { id: "plan", description: "Planning" },
    { id: "build", description: "Implementation" },
  ],
};
const success = () =>
  Response.json({
    model: "jev-test",
    answers: {
      next_agent: {
        type: "choice",
        choice: "plan",
        confidence: 1,
        probabilities: { plan: 1, build: 0 },
      },
      work_status: {
        type: "choice",
        choice: "work_remaining",
        confidence: 1,
        probabilities: { work_remaining: 1, needs_user: 0, complete: 0 },
      },
    },
    usage: { input_tokens: 10, output_tokens: 10 },
  });

test("TypeSafe registers native API-key and environment methods without requiring a key at startup", async () => {
  const fixture = integrationFixture();
  const resolve = await registerTypeSafe(fixture.integration);
  assert.equal(fixture.lookups(), 0);
  assert.equal(fixture.entries.get("typesafe")?.name, "TypeSafe (Jev)");
  assert.deepEqual(fixture.methods, [
    { integrationID: "typesafe", method: { type: "key", label: "API key" } },
    {
      integrationID: "typesafe",
      method: { type: "env", names: ["TYPESAFE_API_KEY"] },
    },
  ]);
  assert.equal(await resolve(), undefined);
});

test("each evaluation uses OpenCode's current account, rotated key, or environment connection", async () => {
  const fixture = integrationFixture();
  fixture.select(savedAccount("cred_first"), "first-key");
  const resolve = await registerTypeSafe(fixture.integration);
  const headers: (string | null)[] = [];
  const evaluate = createEvaluator(parseOptions(), resolve, async (_, init) => {
    headers.push(new Headers(init?.headers).get("authorization"));
    return success();
  });
  const run = () => evaluate(input, new AbortController().signal);
  await run();
  fixture.select(savedAccount("cred_second"), "second-key");
  await run();
  fixture.credentials.set("cred_second", { type: "key", key: "rotated-key" });
  await run();
  fixture.select({ type: "env", name: "TYPESAFE_API_KEY" }, "environment-key");
  await run();
  assert.deepEqual(headers, [
    "Bearer first-key",
    "Bearer second-key",
    "Bearer rotated-key",
    "Bearer environment-key",
  ]);
  assert.equal(fixture.lookups(), 4);

  fixture.select(undefined);
  await assert.rejects(run(), TypeSafeNotConnectedError);
  assert.equal(
    headers.length,
    4,
    "Removing credentials must not reuse a previous SDK key",
  );
});

test("a removed or empty selected credential prevents HTTP requests", async () => {
  const fixture = integrationFixture();
  fixture.select(savedAccount("cred_missing"));
  const evaluate = createEvaluator(
    parseOptions(),
    await registerTypeSafe(fixture.integration),
    async () => {
      assert.fail("No HTTP request is allowed without the selected credential");
    },
  );
  await assert.rejects(
    evaluate(input, new AbortController().signal),
    TypeSafeNotConnectedError,
  );
  fixture.credentials.set("cred_missing", { type: "key", key: "   " });
  await assert.rejects(
    evaluate(input, new AbortController().signal),
    TypeSafeNotConnectedError,
  );
});

test("authentication failures mark the selected account, and a successful retry clears its status", async () => {
  const fixture = integrationFixture();
  fixture.select(savedAccount("cred_account"), "account-key");
  let valid = false;
  const evaluate = createEvaluator(
    parseOptions(),
    await registerTypeSafe(fixture.integration),
    async () =>
      valid
        ? success()
        : Response.json({ error: "Unauthorized" }, { status: 401 }),
  );
  await assert.rejects(
    evaluate(input, new AbortController().signal),
    AuthenticationError,
  );
  assert.equal(fixture.statuses[0]?.connection.type, "credential");
  assert.equal(fixture.statuses[0]?.status?.status, "needs_auth");
  assert.match(fixture.statuses[0]!.status!.message, /\/connect/);
  valid = true;
  await evaluate(input, new AbortController().signal);
  assert.equal(fixture.statuses.length, 2);
  assert.equal(fixture.statuses[1]?.status, undefined);
});

test("an old request cannot mark a replaced key as invalid", async () => {
  const fixture = integrationFixture();
  fixture.select(savedAccount("cred_account"), "old-key");
  const started = deferred<void>();
  const reply = deferred<Response>();
  const evaluate = createEvaluator(
    parseOptions(),
    await registerTypeSafe(fixture.integration),
    async () => {
      started.resolve();
      return reply.promise;
    },
  );
  const request = evaluate(input, new AbortController().signal);
  await started.promise;
  fixture.credentials.set("cred_account", { type: "key", key: "new-key" });
  reply.resolve(Response.json({ error: "Unauthorized" }, { status: 401 }));
  await assert.rejects(request, AuthenticationError);
  assert.deepEqual(fixture.statuses, []);
});

test("service failures leave account authentication status alone", async () => {
  const fixture = integrationFixture();
  fixture.select(savedAccount("cred_account"), "account-key");
  const evaluate = createEvaluator(
    parseOptions(),
    await registerTypeSafe(fixture.integration),
    async () => Response.json({ error: "Overloaded" }, { status: 529 }),
  );
  await assert.rejects(evaluate(input, new AbortController().signal));
  assert.deepEqual(fixture.statuses, []);
});

test("failed status reporting does not discard a successful decision", async () => {
  const fixture = integrationFixture({ statusFailure: true });
  fixture.select(
    {
      ...savedAccount("cred_account"),
      status: { status: "needs_auth", message: "Reconnect" },
    },
    "account-key",
  );
  const evaluate = createEvaluator(
    parseOptions(),
    await registerTypeSafe(fixture.integration),
    async () => success(),
  );
  assert.equal(
    (await evaluate(input, new AbortController().signal)).agent.choice,
    "plan",
  );
});

test("cancellation during credential lookup prevents model requests", async () => {
  const lookup = deferred<{ apiKey: string }>();
  const abort = new AbortController();
  const evaluate = createEvaluator(
    parseOptions(),
    () => lookup.promise,
    async () =>
      assert.fail("Cancelled evaluation must not make an HTTP request"),
  );
  const request = evaluate(input, abort.signal);
  abort.abort();
  lookup.resolve({ apiKey: "account-key" });
  await assert.rejects(request, { name: "AbortError" });
});

test("missing credentials keep the current agent and explain how to connect", async () => {
  const h = harness(async () => {
    throw new TypeSafeNotConnectedError();
  });
  const messages: string[] = [];
  h.host.log = (message) => {
    messages.push(message);
  };
  await h.controller.prompt(h.state.id, "msg_request", "Plan a feature");
  assert.equal(h.state.agent, "build");
  assert.deepEqual(h.changes, []);
  assert.match(messages[0]!, /Connect TypeSafe \(Jev\) using \/connect/);
  await h.controller.close();
});
