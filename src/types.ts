import type { Plugin } from "@opencode/plugin";
import type { JsonValue } from "@typesafe-ai/sdk";

export type Agent = Awaited<
  ReturnType<Plugin.Context["agent"]["list"]>
>["data"][number];
export type Model = Pick<
  Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number],
  "id" | "providerID" | "enabled" | "variants"
>;
export type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
export type Message = Awaited<
  ReturnType<Plugin.Context["session"]["context"]>
>[number];
export type ModelRef = NonNullable<Session["model"]>;
export type Event =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<
    infer E
  >
    ? E
    : never;

export interface Candidate {
  id: string;
  description: string;
  model?: ModelRef;
}

export type WorkStatus = "work_remaining" | "needs_user" | "complete";
export interface Choice<T extends string = string> {
  choice: T;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface Decision {
  agent: Choice;
  work: Choice<WorkStatus>;
  model: string;
  latencyMs: number;
}
export interface Evaluation {
  state: Record<string, JsonValue>;
  candidates: Candidate[];
}
export type Evaluator = (
  input: Evaluation,
  signal: AbortSignal,
) => Promise<Decision>;

export type Mode =
  { type: "auto" } | { type: "paused" } | { type: "pinned"; agent: string };
export interface Trace {
  time: string;
  trigger: "prompt" | "idle";
  from?: string;
  to?: string;
  outcome: string;
  decision?: Decision;
}
export interface SavedState {
  mode: Mode;
  traces: Trace[];
}

/** Small adapter keeps routing independent of OpenCode's transport and branded hook IDs. */
export interface Host {
  directory: string;
  workspaceID?: string;
  session(id: string): Promise<Session>;
  messages(id: string): Promise<Message[]>;
  agents(): Promise<Agent[]>;
  models(): Promise<Model[]>;
  switchAgent(id: string, agent: string): Promise<void>;
  switchModel(id: string, model: ModelRef): Promise<void>;
  wait(id: string, signal: AbortSignal): Promise<void>;
  continue(id: string, key: string, agent: string): Promise<void>;
  load(id: string): Promise<unknown>;
  save(id: string, value: SavedState): Promise<void>;
  remove(id: string): Promise<void>;
  notice(id: string, text: string): Promise<void>;
  log(message: string): void;
}
