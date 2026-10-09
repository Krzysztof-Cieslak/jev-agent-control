import assert from "node:assert/strict";
import { parseOptions } from "../src/config.js";
import { createEvaluator } from "../src/jev.js";
import type { Candidate, WorkStatus } from "../src/types.js";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("Set TYPESAFE_API_KEY in .env before running test:live");
const options = parseOptions();
const evaluate = createEvaluator(options, async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  return apiKey ? { apiKey } : undefined;
});
const candidates: Candidate[] = [
  {
    id: "plan",
    description:
      "Explore requirements and design a solution. Read-only planning; does not implement changes.",
  },
  {
    id: "build",
    description: "Implement features, fix bugs, update files, and run tests.",
  },
  {
    id: "reviewer",
    description:
      "Review existing changes for correctness, regressions, and missing tests. Report findings without implementing changes.",
  },
];
const cases: {
  name: string;
  trigger: string;
  current: string;
  request: string;
  conversation: string[];
  agent?: string;
  work?: WorkStatus;
}[] = [
  {
    name: "plan-only request",
    trigger: "prompt",
    current: "build",
    request:
      "Plan an implementation of password reset. Discuss the design only; do not modify files.",
    conversation: [],
    agent: "plan",
  },
  {
    name: "implementation request",
    trigger: "prompt",
    current: "plan",
    request:
      "Implement password reset using the agreed plan. Update the code and add focused tests.",
    conversation: [
      "ASSISTANT (plan): Design approved: expiring reset tokens, email delivery, and token revocation after use.",
    ],
    agent: "build",
  },
  {
    name: "custom reviewer",
    trigger: "prompt",
    current: "build",
    request:
      "Review the current diff for correctness and regressions. Report findings without changing files.",
    conversation: [],
    agent: "reviewer",
  },
  {
    name: "completed planning scope",
    trigger: "idle",
    current: "plan",
    request: "Plan password reset. Discuss design only; do not implement it.",
    conversation: [
      "USER: Plan password reset. Discuss design only; do not implement it.",
      "ASSISTANT (plan): Here is the complete design: expiring reset tokens, email delivery, token revocation after use, abuse limits, and focused tests for expiry and reuse.",
    ],
    work: "complete",
  },
  {
    name: "autonomous plan-to-build",
    trigger: "idle",
    current: "plan",
    request:
      "Design, implement, and review password reset. Proceed through all three steps.",
    conversation: [
      "USER: Design, implement, and review password reset. Proceed through all three steps.",
      "ASSISTANT (plan): Design complete: expiring reset tokens and email delivery. No implementation or review has been performed yet.",
    ],
    agent: "build",
    work: "work_remaining",
  },
  {
    name: "native Plan handoff wording",
    trigger: "idle",
    current: "plan",
    request: "Design and implement password reset. Complete both steps.",
    conversation: [
      "USER: Design and implement password reset. Complete both steps.",
      "ASSISTANT (plan): Here is the complete plan: use expiring reset tokens, send an email link, and revoke the token after use. Switch to Build mode when you are ready for me to implement it.",
    ],
    agent: "build",
    work: "work_remaining",
  },
  {
    name: "ordered phases with detailed implementation requirements",
    trigger: "prompt",
    current: "build",
    request:
      "Complete these three phases in order: first plan, then implement and test, then have the independent reviewer review. Implement a named export slugify(text) in src/slugify.js. Input is a string: lowercase it, replace each run of characters outside ASCII a-z and 0-9 with a single hyphen, and remove leading and trailing hyphens. Empty input or only separators returns an empty string. Preserve the existing acceptance tests. Proceed through all three phases automatically.",
    conversation: [],
    agent: "plan",
    work: "work_remaining",
  },
  {
    name: "passing tests with independent review still pending",
    trigger: "idle",
    current: "build",
    request:
      "First plan, then implement and test slugify, then have the independent reviewer review. Complete all three phases automatically.",
    conversation: [
      "ASSISTANT (plan): Plan ready: lowercase the text, replace disallowed character runs with hyphens, trim leading and trailing hyphens, and run the existing tests.",
      "ASSISTANT (build): Implemented slugify in src/slugify.js. It lowercases input, collapses separator runs, trims hyphens, and handles empty input. npm test passed. Independent review: ready for the reviewer to verify; nothing else remains from implementation.",
    ],
    agent: "reviewer",
    work: "work_remaining",
  },
  {
    name: "waiting for a user decision",
    trigger: "idle",
    current: "plan",
    request:
      "Help me choose a database; ask me for requirements before proposing a solution.",
    conversation: [
      "ASSISTANT (plan): What scale, consistency guarantees, and deployment constraints do you need? I need your answers before continuing.",
    ],
    work: "needs_user",
  },
];
for (const item of cases) {
  const result = await evaluate(
    {
      candidates,
      state: {
        trigger: item.trigger,
        current_agent: item.current,
        latest_request: item.request,
        conversation: item.conversation,
      },
    },
    AbortSignal.timeout(options.timeoutMs),
  );
  console.log(
    `${item.name}: agent=${result.agent.choice} (${result.agent.confidence.toFixed(2)}), work=${result.work.choice} (${result.work.confidence.toFixed(2)}), ${result.latencyMs}ms, ${result.model}`,
  );
  if (item.agent) {
    assert.equal(result.agent.choice, item.agent, item.name);
    assert.ok(
      result.agent.confidence >= options.minConfidence,
      `${item.name}: routing confidence below threshold`,
    );
  }
  if (item.work) {
    assert.equal(result.work.choice, item.work, item.name);
    assert.ok(
      result.work.confidence >= options.minConfidence,
      `${item.name}: work-status confidence below threshold`,
    );
  }
}
console.log(
  `Live Jev smoke test passed (${cases.length} synthetic scenarios).`,
);
