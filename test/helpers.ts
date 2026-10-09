import { Controller } from "../src/controller.js";
import { parseOptions } from "../src/config.js";
import type {
  Agent,
  Decision,
  Evaluator,
  Event,
  Host,
  Message,
  Model,
  SavedState,
  Session,
} from "../src/types.js";

export const agents: Agent[] = ["plan", "build", "reviewer"].map((id) => ({
  id,
  name: id,
  mode: "primary",
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
  model: { providerID: "test", id },
}));
export const models: Model[] = agents.map((agent) => ({
  ...agent.model!,
  enabled: true,
  variants: [],
}));
export function decision(
  agent = "plan",
  status: "work_remaining" | "needs_user" | "complete" = "work_remaining",
  confidence = 0.95,
): Decision {
  return {
    agent: {
      choice: agent,
      confidence,
      probabilities: Object.fromEntries(
        agents.map(({ id }) => [id, id === agent ? 0.96 : 0.02]),
      ),
    },
    work: {
      choice: status,
      confidence,
      probabilities: Object.fromEntries(
        ["work_remaining", "needs_user", "complete"].map((id) => [
          id,
          id === status ? 0.96 : 0.02,
        ]),
      ),
    },
    model: "jev-test",
    latencyMs: 1,
  };
}
export function session(id = "ses_test"): Session {
  return {
    id,
    projectID: "project",
    agent: "build",
    model: { providerID: "test", id: "build" },
    location: { directory: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
}
export function user(text: string): Message {
  return { id: "msg_user", type: "user", text, time: { created: 1 } };
}
export function assistant(text: string, agent = "plan"): Message {
  return {
    id: "msg_assistant",
    type: "assistant",
    agent,
    model: { providerID: "test", id: agent },
    time: { created: 2, completed: 3 },
    content: [{ type: "text", text }],
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function harness(
  evaluate: Evaluator,
  options: Record<string, unknown> = {},
) {
  const state = session();
  const messages: Message[] = [user("Design, implement, and review a feature")];
  const saved = new Map<string, SavedState>();
  const changes: string[] = [];
  const continuations: string[] = [];
  let sequence = 0;
  let controller: Controller;
  const emit = (
    type: string,
    data: Record<string, unknown> = {},
    id = `evt_${++sequence}`,
    directory = "/project",
  ) => {
    controller.event({
      id,
      type,
      created: sequence,
      data: { sessionID: state.id, ...data },
      location: { directory },
      durable: { aggregateID: state.id, seq: sequence, version: 1 },
    } as Event);
  };
  const host: Host = {
    directory: "/project",
    session: async () => structuredClone(state),
    messages: async () => structuredClone(messages),
    agents: async () => structuredClone(agents),
    models: async () => structuredClone(models),
    switchAgent: async (_, agent) => {
      state.agent = agent;
      changes.push(`agent:${agent}`);
      emit("session.agent.selected", { agent });
    },
    switchModel: async (_, model) => {
      state.model = model;
      changes.push(`model:${model.id}`);
      emit("session.model.selected", { model });
    },
    wait: async () => {},
    continue: async (_, key) => {
      continuations.push(key);
    },
    load: async (id) => saved.get(id),
    save: async (id, value) => {
      saved.set(id, structuredClone(value));
    },
    remove: async (id) => {
      saved.delete(id);
    },
    notice: async () => {},
    log: () => {},
  };
  controller = new Controller(host, parseOptions(options), evaluate);
  const admit = (id = "msg_request") => {
    emit("session.inbox.enqueued", {
      inboxID: id,
      item: { type: "user", payload: { text: "request" }, delivery: "steer" },
    });
    emit("session.inbox.delivered", { inboxID: id });
  };
  const finish = async (id?: string) => {
    state.outcome = "succeeded";
    emit("session.execution.succeeded", {}, id);
    return controller.control(state.id);
  };
  return {
    controller,
    host,
    state,
    messages,
    saved,
    changes,
    continuations,
    emit,
    admit,
    finish,
  };
}
