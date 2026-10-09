import { Plugin } from "@opencode/plugin";
import { parseOptions } from "./config.js";
import { Controller } from "./controller.js";
import { createEvaluator } from "./jev.js";
import type { Host, Mode } from "./types.js";

export default Plugin.define({
  id: "jev-agent-control",
  async setup(ctx) {
    const options = parseOptions(ctx.options);
    const host: Host = {
      directory: ctx.location.directory,
      workspaceID: ctx.location.workspaceID,
      session: (sessionID) => ctx.session.get({ sessionID }),
      messages: (sessionID) => ctx.session.context({ sessionID }),
      agents: async () => (await ctx.agent.list()).data,
      models: async () => (await ctx.model.list()).data,
      switchAgent: (sessionID, agent) =>
        ctx.session.switchAgent({ sessionID, agent }),
      switchModel: (sessionID, model) =>
        ctx.session.switchModel({ sessionID, model }),
      wait: (sessionID, signal) => ctx.session.wait({ sessionID }, { signal }),
      continue: async (sessionID, id, agent) => {
        await ctx.session.synthetic({
          sessionID,
          id,
          text: `Jev handed the session to agent "${agent}". Continue the unfinished work explicitly requested by the user using the existing conversation. Respect the user's scope, constraints, and requests to wait. If nothing remains, finish without inventing extra work.`,
          description: `Jev handoff → ${agent}`,
          metadata: { source: "jev-agent-control", kind: "handoff" },
          delivery: "steer",
        });
      },
      load: (id) => ctx.storage.get(`sessions/${id}`),
      save: (id, value) =>
        ctx.storage.set(`sessions/${id}`, JSON.parse(JSON.stringify(value))),
      remove: (id) => ctx.storage.remove(`sessions/${id}`),
      notice: async (sessionID, text) => {
        await ctx.session.synthetic({
          sessionID,
          text,
          description: "Jev routing status",
          metadata: { source: "jev-agent-control", kind: "status" },
          resume: false,
        });
      },
      log: (message) => console.warn(`[jev-agent-control] ${message}`),
    };
    const controller = new Controller(host, options, createEvaluator(options));
    const events = new AbortController();
    await ctx.session.hook("prompt", (event) =>
      controller.prompt(event.sessionID, event.messageID, event.prompt.text),
    );
    await ctx.session.hook("context", (event) =>
      controller.running(event.sessionID),
    );
    await ctx.command.transform((editor) => {
      for (const action of ["auto", "pause", "status"] as const) {
        editor.add({
          name: `jev-${action}`,
          description: {
            auto: "Enable Jev routing for the next user request",
            pause: "Pause Jev routing",
            status: "Show Jev routing mode and recent decisions",
          }[action],
          execute: async ({ sessionID }) => {
            const mode: Mode | undefined =
              action === "auto"
                ? { type: "auto" }
                : action === "pause"
                  ? { type: "paused" }
                  : undefined;
            const state = await controller.control(sessionID, mode);
            await host.notice(
              sessionID,
              `Jev routing: ${state.mode.type}\n${state.traces
                .slice(-5)
                .map(
                  (trace) =>
                    `${trace.time} ${trace.trigger}: ${trace.from ?? "default"} → ${trace.to ?? "unchanged"} [${trace.outcome}]${trace.decision ? ` confidence=${trace.decision.agent.confidence.toFixed(2)} model=${trace.decision.model} latency=${trace.decision.latencyMs}ms` : ""}`,
                )
                .join("\n")}`,
            );
          },
        });
      }
    });
    const stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: events.signal,
        }))
          controller.event(event);
      } catch {
        if (!events.signal.aborted)
          host.log(
            "Event stream ended; reload the plugin to restore autonomous handoffs",
          );
      }
    })();
    return async () => {
      events.abort();
      await controller.close();
      await stream;
    };
  },
});
