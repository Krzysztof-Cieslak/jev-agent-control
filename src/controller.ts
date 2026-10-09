import { createHash } from "node:crypto";
import { TypeSafeNotConnectedError } from "./auth.js";
import {
  availableModel,
  buildState,
  candidates,
  sameModel,
} from "./context.js";
import type { Options } from "./config.js";
import type {
  Candidate,
  Choice,
  Evaluator,
  Event,
  Host,
  Mode,
  ModelRef,
  SavedState,
  Session,
  Trace,
} from "./types.js";

interface Runtime extends SavedState {
  ready: Promise<void>;
  tail: Promise<unknown>;
  revision: number;
  running: boolean;
  armed: boolean;
  handoffs: number;
  transitions: Set<string>;
  pending: Set<string>;
  preparing: Set<string>;
  prompts: Map<string, Promise<void>>;
  events: Set<string>;
  expected: { kind: "agent" | "model"; value: string }[];
  abort?: AbortController;
  latestRequest?: string;
}

function restored(value: unknown, enabled: boolean): SavedState {
  const fallback: SavedState = {
    mode: { type: enabled ? "auto" : "paused" },
    traces: [],
  };
  if (!value || typeof value !== "object") return fallback;
  const saved = value as Partial<SavedState>;
  if (saved.mode?.type === "auto" || saved.mode?.type === "paused")
    fallback.mode = { type: saved.mode.type };
  if (Array.isArray(saved.traces))
    fallback.traces = saved.traces
      .filter((trace) => trace && typeof trace.outcome === "string")
      .slice(-100);
  return fallback;
}

function modelKey(model: ModelRef): string {
  return `${model.providerID}/${model.id}#${model.variant ?? "default"}`;
}

function remember<T>(set: Set<T>, value: T, limit = 128): boolean {
  if (set.has(value)) return false;
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value!);
  return true;
}

function confident(answer: Choice, options: Options): boolean {
  const sorted = Object.values(answer.probabilities).sort((a, b) => b - a);
  return (
    answer.confidence >= options.minConfidence &&
    (sorted[0] ?? 0) - (sorted[1] ?? 0) >= options.minMargin
  );
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export class Controller {
  private readonly sessions = new Map<string, Runtime>();
  private closed = false;

  constructor(
    private readonly host: Host,
    private readonly options: Options,
    private readonly evaluate: Evaluator,
  ) {}

  private runtime(id: string): Runtime {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const state: Runtime = {
      ...restored(undefined, this.options.enabled),
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      revision: 0,
      running: false,
      armed: false,
      handoffs: 0,
      transitions: new Set(),
      pending: new Set(),
      preparing: new Set(),
      prompts: new Map(),
      events: new Set(),
      expected: [],
    };
    this.sessions.set(id, state);
    state.ready = this.host
      .load(id)
      .then((value) =>
        Object.assign(state, restored(value, this.options.enabled)),
      )
      .then(
        () => {},
        () => this.host.log("Could not restore Jev session settings"),
      );
    return state;
  }

  private invalidate(state: Runtime): number {
    state.revision++;
    state.abort?.abort(new Error("Routing superseded"));
    return state.revision;
  }

  private enqueue<T>(state: Runtime, work: () => Promise<T>): Promise<T> {
    const result = state.tail.then(() => state.ready).then(work);
    state.tail = result.catch(() => {});
    return result;
  }

  private async save(id: string, state: Runtime): Promise<void> {
    await this.host
      .save(id, { mode: state.mode, traces: state.traces })
      .catch(() => this.host.log("Could not persist Jev session settings"));
  }

  private async trace(
    id: string,
    state: Runtime,
    trace: Omit<Trace, "time">,
  ): Promise<void> {
    state.traces.push({ time: new Date().toISOString(), ...trace });
    state.traces = state.traces.slice(-this.options.historyLimit);
    await this.save(id, state);
  }

  private owns(session: Session): boolean {
    return (
      !session.parentID && session.location.directory === this.host.directory
    );
  }

  /** Prompt hooks may be retried or invoked concurrently with the same message ID. */
  prompt(id: string, messageID: string, text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const state = this.runtime(id);
    const existing = state.prompts.get(messageID);
    if (existing) return existing;
    const revision = this.invalidate(state);
    state.armed = false;
    state.handoffs = 0;
    state.transitions.clear();
    state.preparing.add(messageID);
    const job = this.enqueue(state, async () => {
      try {
        await this.route(id, state, revision, "prompt", messageID, text);
      } finally {
        state.preparing.delete(messageID);
      }
    });
    state.prompts.set(messageID, job);
    if (state.prompts.size > 64)
      state.prompts.delete(state.prompts.keys().next().value!);
    return job;
  }

  /** A context hook also observes runs already active when this plugin was loaded. */
  running(id: string): void {
    if (this.closed) return;
    const state = this.runtime(id);
    if (!state.running) this.invalidate(state);
    state.running = true;
  }

  event(event: Event): void {
    if (this.closed || !("data" in event) || !("sessionID" in event.data))
      return;
    if (
      event.location &&
      (event.location.directory !== this.host.directory ||
        ("workspaceID" in event.location &&
          event.location.workspaceID !== this.host.workspaceID))
    )
      return;
    const id = event.data.sessionID;
    const manualSelection =
      event.type === "session.agent.selected" ||
      event.type === "session.model.selected";
    const state =
      this.sessions.get(id) ??
      (manualSelection && event.location?.directory === this.host.directory
        ? this.runtime(id)
        : undefined);
    if (!state || !remember(state.events, event.id)) return;
    switch (event.type) {
      case "session.execution.started":
        this.running(id);
        break;
      case "session.execution.succeeded": {
        state.running = false;
        const revision = state.revision;
        void this.enqueue(state, () =>
          this.route(id, state, revision, "idle", event.id),
        );
        break;
      }
      case "session.execution.interrupted":
      case "session.execution.failed":
        state.running = false;
        state.armed = false;
        this.invalidate(state);
        break;
      case "session.inbox.enqueued": {
        const item = event.data.item;
        const internal =
          "metadata" in item.payload &&
          item.payload.metadata?.source === "jev-agent-control";
        // Synthetic notifications include OpenCode's own Plan-mode reminders.
        // They must not invalidate the handoff that caused them.
        if (internal || item.type === "synthetic") break;
        state.pending.add(event.data.inboxID);
        this.invalidate(state);
        if (item.type === "user") {
          state.armed = true;
          state.latestRequest = item.payload.text;
        }
        break;
      }
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        state.pending.delete(event.data.inboxID);
        break;
      case "session.agent.selected":
      case "session.model.selected": {
        const kind =
          event.type === "session.agent.selected" ? "agent" : "model";
        const value =
          event.type === "session.agent.selected"
            ? event.data.agent
            : modelKey(event.data.model);
        const index = state.expected.findIndex(
          (entry) => entry.kind === kind && entry.value === value,
        );
        if (index !== -1) {
          state.expected.splice(index, 1);
          break;
        }
        // A native agent/model picker is an explicit manual override.
        this.invalidate(state);
        state.armed = false;
        void this.enqueue(state, async () => {
          state.mode = { type: "paused" };
          await this.save(id, state);
        });
        break;
      }
      case "session.moved":
      case "session.deleted":
        this.invalidate(state);
        state.armed = false;
        this.sessions.delete(id);
        if (event.type === "session.deleted")
          void state.tail.then(() => this.host.remove(id)).catch(() => {});
        break;
    }
  }

  private async selection(
    id: string,
    state: Runtime,
    kind: "agent" | "model",
    value: string | ModelRef,
  ): Promise<void> {
    const entry = {
      kind,
      value: typeof value === "string" ? value : modelKey(value),
    };
    state.expected.push(entry);
    try {
      if (kind === "agent") await this.host.switchAgent(id, value as string);
      else await this.host.switchModel(id, value as ModelRef);
    } catch (error) {
      const index = state.expected.indexOf(entry);
      if (index !== -1) state.expected.splice(index, 1);
      throw error;
    }
  }

  private async apply(
    id: string,
    state: Runtime,
    revision: number,
    before: Session,
    target: Candidate,
  ): Promise<boolean> {
    if (target.model && !availableModel(target.model, await this.host.models()))
      throw new Error("Agent model unavailable");
    const fresh = await this.host.session(id);
    const valid = () =>
      !this.closed && state.revision === revision && !state.running;
    if (
      !valid() ||
      !this.owns(fresh) ||
      fresh.agent !== before.agent ||
      !sameModel(fresh.model, before.model)
    )
      return false;
    const currentTarget = candidates(
      await this.host.agents(),
      this.options,
    ).find((agent) => agent.id === target.id);
    if (
      !currentTarget ||
      !sameModel(currentTarget.model, target.model) ||
      !valid()
    )
      return false;
    try {
      if (fresh.agent !== target.id)
        await this.selection(id, state, "agent", target.id);
      if (!valid()) return false;
      if (target.model && !sameModel(fresh.model, target.model))
        await this.selection(id, state, "model", target.model);
      return valid();
    } catch (error) {
      // Recover our own partial switch only; never overwrite a newer manual selection.
      if (valid()) {
        const after = await this.host.session(id).catch(() => undefined);
        if (
          after &&
          before.model &&
          target.model &&
          sameModel(after.model, target.model) &&
          !sameModel(after.model, before.model) &&
          valid()
        ) {
          await this.selection(id, state, "model", before.model).catch(
            () => {},
          );
        }
        if (after && before.agent && after.agent === target.id && valid()) {
          await this.selection(id, state, "agent", before.agent).catch(
            () => {},
          );
        }
      }
      throw error;
    }
  }

  private async route(
    id: string,
    state: Runtime,
    revision: number,
    trigger: "prompt" | "idle",
    key: string,
    text?: string,
  ): Promise<void> {
    const valid = () =>
      !this.closed && state.revision === revision && !state.running;
    if (!valid() || state.mode.type === "paused") return;
    if (
      trigger === "idle" &&
      (!this.options.autoHandoff ||
        !state.armed ||
        state.pending.size ||
        state.preparing.size)
    )
      return;
    const abort = new AbortController();
    state.abort = abort;
    const deadline = setTimeout(
      () => abort.abort(new Error("Jev routing deadline exceeded")),
      this.options.timeoutMs,
    );
    try {
      if (trigger === "idle")
        await abortable(this.host.wait(id, abort.signal), abort.signal);
      const [session, agents, messages] = await Promise.all([
        this.host.session(id),
        this.host.agents(),
        this.host.messages(id),
      ]);
      if (!valid() || !this.owns(session)) return;
      if (trigger === "idle" && session.outcome !== "succeeded") return;
      const eligible = candidates(agents, this.options);
      if (eligible.length < 2) {
        await this.trace(id, state, {
          trigger,
          from: session.agent,
          outcome: "insufficient-candidates",
        });
        return;
      }
      const request =
        text ??
        messages.filter((message) => message.type === "user").at(-1)?.text ??
        state.latestRequest;
      const decision = await abortable(
        this.evaluate(
          {
            state: buildState(
              session,
              messages,
              this.options,
              trigger,
              request,
            ),
            candidates: eligible,
          },
          abort.signal,
        ),
        abort.signal,
      );
      if (!valid()) return;
      const entry = {
        trigger,
        from: session.agent,
        to: decision.agent.choice,
        decision,
      };
      if (
        !confident(decision.agent, this.options) ||
        (trigger === "idle" && !confident(decision.work, this.options))
      ) {
        await this.trace(id, state, { ...entry, outcome: "low-confidence" });
        return;
      }
      if (trigger === "idle" && decision.work.choice !== "work_remaining") {
        state.armed = false;
        await this.trace(id, state, {
          ...entry,
          outcome: decision.work.choice,
        });
        return;
      }
      const target = eligible.find(
        (agent) => agent.id === decision.agent.choice,
      );
      if (!target) throw new Error("Unknown Jev agent choice");
      if (trigger === "idle" && target.id === session.agent) {
        await this.trace(id, state, { ...entry, outcome: "retained" });
        return;
      }
      const transition = `${session.agent}\0${target.id}`;
      if (
        trigger === "idle" &&
        (state.handoffs >= this.options.maxHandoffs ||
          state.transitions.has(transition))
      ) {
        state.armed = false;
        await this.trace(id, state, { ...entry, outcome: "handoff-limit" });
        return;
      }
      if (!(await this.apply(id, state, revision, session, target))) {
        await this.trace(id, state, { ...entry, outcome: "superseded" });
        return;
      }
      if (trigger === "idle") {
        if (!valid() || state.pending.size || state.preparing.size) return;
        state.handoffs++;
        state.transitions.add(transition);
      }
      await this.trace(id, state, {
        ...entry,
        outcome: target.id === session.agent ? "retained" : "switched",
      });
      if (
        trigger === "idle" &&
        valid() &&
        !state.pending.size &&
        !state.preparing.size
      ) {
        const messageID = `msg_jev_${createHash("sha256").update(`${id}:${key}`).digest("hex").slice(0, 24)}`;
        await this.host.continue(id, messageID, target.id);
      }
    } catch (error) {
      if (this.closed || state.revision !== revision) return;
      // SDK errors can contain request/response bodies; persist only the error class.
      const name = error instanceof Error ? error.name : "UnknownError";
      await this.trace(id, state, { trigger, outcome: `error:${name}` });
      this.host.log(
        error instanceof TypeSafeNotConnectedError
          ? error.message
          : `Jev routing skipped (${name})`,
      );
    } finally {
      clearTimeout(deadline);
      if (state.abort === abort) state.abort = undefined;
    }
  }

  async control(id: string, mode?: Mode): Promise<SavedState> {
    const state = this.runtime(id);
    if (mode) {
      this.invalidate(state);
      state.armed = false;
    }
    return this.enqueue(state, async () => {
      if (mode) {
        state.mode = mode;
        await this.save(id, state);
      }
      return { mode: state.mode, traces: [...state.traces] };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const state of this.sessions.values()) this.invalidate(state);
    await Promise.all([...this.sessions.values()].map((state) => state.tail));
    this.sessions.clear();
  }
}
