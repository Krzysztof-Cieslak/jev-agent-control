import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions } from "../src/config.js";
import { buildState, candidates } from "../src/context.js";
import { createEvaluator, validateChoice } from "../src/jev.js";
import { agents, assistant, session, user } from "./helpers.js";

test("Jev uses dynamic criteria, checks the HTTP response, and preserves confidence", async () => {
  let body: Record<string, any> = {};
  const evaluate = createEvaluator(
    parseOptions(),
    async () => ({ apiKey: "test-only" }),
    async (_, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          next_agent: {
            type: "choice",
            choice: "plan",
            confidence: 0.9,
            probabilities: { plan: 0.95, build: 0.05 },
          },
          work_status: {
            type: "choice",
            choice: "work_remaining",
            confidence: 1,
            probabilities: { work_remaining: 1, needs_user: 0, complete: 0 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    },
  );
  const result = await evaluate(
    {
      state: { latest_request: "Plan a feature" },
      candidates: [
        { id: "plan", description: "Planning" },
        { id: "build", description: "Coding" },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions.next_agent.criteria), [
    "plan",
    "build",
  ]);
  assert.equal(result.agent.confidence, 0.9);
  assert.equal(result.model, "jev-1.13.0");
});

test("malformed probabilities and unknown choices are rejected", () => {
  for (const answer of [
    {
      type: "choice",
      choice: "unknown",
      confidence: 1,
      probabilities: { a: 1, b: 0 },
    },
    {
      type: "choice",
      choice: "a",
      confidence: 1,
      probabilities: { a: 0.1, b: 0.9 },
    },
    {
      type: "choice",
      choice: "a",
      confidence: NaN,
      probabilities: { a: 1, b: 0 },
    },
    { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 } },
  ])
    assert.throws(() => validateChoice(answer, ["a", "b"]));
});

test("context is bounded, contains user intent and tool results, and omits reasoning", () => {
  const options = parseOptions({ contextChars: 4000 });
  const answer = assistant("A plan is ready");
  assert.equal(answer.type, "assistant");
  if (answer.type === "assistant")
    answer.content.push({
      type: "reasoning",
      text: "private reasoning",
      time: { created: 1 },
    });
  const state = buildState(
    session(),
    [
      ...Array.from({ length: 40 }, () => user("old ".repeat(1000))),
      user("Plan only; do not implement"),
      answer,
    ],
    options,
    "idle",
  );
  const json = JSON.stringify(state);
  assert.ok(json.length <= options.contextChars);
  assert.ok(json.includes("Plan only; do not implement"));
  assert.ok(json.includes("A plan is ready"));
  assert.ok(!json.includes("private reasoning"));
});

test("candidate discovery honors primary capability and user filters", () => {
  const all = [
    ...agents,
    { ...agents[0]!, id: "hidden", hidden: true },
    { ...agents[0]!, id: "explore", mode: "subagent" as const },
  ];
  assert.deepEqual(
    candidates(
      all,
      parseOptions({
        excludeAgents: ["build"],
        descriptions: { reviewer: "Review migrations" },
      }),
    ).map((a) => a.id),
    ["plan", "reviewer"],
  );
  assert.equal(
    candidates(
      all,
      parseOptions({
        includeAgents: ["reviewer"],
        descriptions: { reviewer: "Review migrations" },
      }),
    )[0]?.description,
    "Review migrations",
  );
});

test("invalid configuration is rejected instead of silently misconfiguring routing", () => {
  for (const options of [
    { minConfidence: 2 },
    { timeoutMs: -1 },
    { maxHandoffs: 1.5 },
    { unknown: true },
    { descriptions: [] },
    { includeAgents: "plan" },
  ])
    assert.throws(() => parseOptions(options));
});

test("compaction preserves the task summary even after many subsequent observations", () => {
  const messages = [
    {
      id: "msg_compaction",
      type: "compaction" as const,
      status: "completed" as const,
      reason: "auto" as const,
      summary: "User requested implementation and review of password reset",
      recent: "Planning complete",
      time: { created: 1 },
    },
    ...Array.from({ length: 30 }, () => assistant("More observations")),
  ];
  const state = buildState(session(), messages, parseOptions(), "idle");
  assert.match(String(state.conversation_summary), /implementation and review/);
});
