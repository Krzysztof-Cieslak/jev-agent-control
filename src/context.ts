import type { JsonValue } from "@typesafe-ai/sdk";
import type { Options } from "./config.js";
import type {
  Agent,
  Candidate,
  Message,
  Model,
  ModelRef,
  Session,
} from "./types.js";

const builtins: Record<string, string> = {
  plan: "Explore requirements and code, reason about architecture, and plan work. Does not implement changes.",
  build:
    "Implement requested changes, fix bugs, run checks, and complete coding tasks.",
};

export function sameModel(
  a: ModelRef | undefined,
  b: ModelRef | undefined,
): boolean {
  return (
    a?.providerID === b?.providerID &&
    a?.id === b?.id &&
    (a?.variant ?? "default") === (b?.variant ?? "default")
  );
}

export function availableModel(ref: ModelRef, models: Model[]): boolean {
  return models.some(
    (model) =>
      model.enabled &&
      model.id === ref.id &&
      model.providerID === ref.providerID &&
      (!ref.variant ||
        ref.variant === "default" ||
        model.variants.some((variant) => variant.id === ref.variant)),
  );
}

export function candidates(agents: Agent[], options: Options): Candidate[] {
  return agents
    .filter(
      (agent) =>
        !agent.hidden &&
        agent.mode !== "subagent" &&
        !options.excludeAgents.includes(agent.id) &&
        (!options.includeAgents || options.includeAgents.includes(agent.id)),
    )
    .map((agent) => ({
      id: agent.id,
      description: clip(
        options.descriptions[agent.id] ??
          agent.description ??
          builtins[agent.id] ??
          agent.system ??
          agent.name,
        600,
      ),
      ...(agent.model ? { model: agent.model } : {}),
    }));
}

export function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 14))}\n[truncated]`;
}

function summarize(message: Message): string | undefined {
  switch (message.type) {
    case "user":
      return `USER: ${message.text}${message.files?.length ? `\nAttachments: ${message.files.map((file) => file.name ?? file.mime).join(", ")}` : ""}`;
    case "assistant":
      return `ASSISTANT (${message.agent}):\n${message.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type !== "tool") return "";
          const state = part.state;
          if (state.status === "error")
            return `TOOL ${part.name}: error ${clip(state.error.message, 400)}`;
          if (state.status !== "completed")
            return `TOOL ${part.name}: ${state.status}`;
          return `TOOL ${part.name}: ${state.content.map((item) => (item.type === "text" ? clip(item.text, 600) : "[file output]")).join("\n")}`;
        })
        .filter(Boolean)
        .join("\n")}`;
    case "compaction":
      return message.status === "completed"
        ? `CONVERSATION SUMMARY: ${message.summary}`
        : undefined;
    case "system":
      return `INSTRUCTIONS: ${message.text}`;
    default:
      return undefined;
  }
}

export function buildState(
  session: Session,
  messages: Message[],
  options: Options,
  trigger: "prompt" | "idle",
  prompt?: string,
): Record<string, JsonValue> {
  // Prioritize the latest input and recent observations; never send reasoning or file blobs.
  const state: Record<string, JsonValue> = {
    trigger,
    current_agent: session.agent ?? "build",
    latest_request: clip(
      prompt ?? messages.filter((m) => m.type === "user").at(-1)?.text ?? "",
      Math.floor(options.contextChars / 3),
    ),
    conversation: [],
  };
  const checkpoint = messages
    .filter(
      (message) =>
        message.type === "compaction" && message.status === "completed",
    )
    .at(-1);
  if (checkpoint?.type === "compaction" && checkpoint.status === "completed")
    state.conversation_summary = clip(
      checkpoint.summary,
      Math.floor(options.contextChars / 4),
    );
  const history: string[] = [];
  for (const message of [...messages].reverse()) {
    const text = summarize(message);
    if (!text) continue;
    history.unshift(clip(text, 2400));
    state.conversation = history;
    if (JSON.stringify(state).length > options.contextChars) {
      history.shift();
      break;
    }
    if (history.length >= 16) break;
  }
  return state;
}
