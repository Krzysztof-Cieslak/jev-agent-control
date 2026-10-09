import type { Plugin } from "@opencode/plugin";

export const TYPESAFE_INTEGRATION = "typesafe";

export interface TypeSafeCredential {
  apiKey: string;
  reportAuth?: (invalid: boolean) => Promise<void>;
}

export type ResolveTypeSafeCredential = () => Promise<
  TypeSafeCredential | undefined
>;

export class TypeSafeNotConnectedError extends Error {
  constructor() {
    super(
      "Connect TypeSafe (Jev) using /connect, or set TYPESAFE_API_KEY on the OpenCode server.",
    );
    this.name = "TypeSafeNotConnectedError";
  }
}

type Integration = Pick<
  Plugin.Context["integration"],
  "transform" | "connection"
>;

/** OpenCode owns account storage, selection, and the saved-account > environment precedence. */
export async function registerTypeSafe(
  integration: Integration,
): Promise<ResolveTypeSafeCredential> {
  await integration.transform((editor) => {
    editor.update(TYPESAFE_INTEGRATION, (entry) => {
      entry.name = "TypeSafe (Jev)";
    });
    editor.method.update({
      integrationID: TYPESAFE_INTEGRATION,
      method: { type: "key", label: "API key" },
    });
    editor.method.update({
      integrationID: TYPESAFE_INTEGRATION,
      method: { type: "env", names: ["TYPESAFE_API_KEY"] },
    });
  });

  return async () => {
    const connection =
      await integration.connection.active(TYPESAFE_INTEGRATION);
    if (!connection) return undefined;
    const credential = await integration.connection.resolve(connection);
    if (credential?.type !== "key" || !credential.key.trim()) return undefined;
    const apiKey = credential.key;

    return {
      apiKey: apiKey.trim(),
      reportAuth: async (invalid) => {
        if (!invalid && !connection.status) return;
        // A delayed response must not mark a replaced or removed key as invalid.
        const latest = await integration.connection.resolve(connection);
        if (latest?.type !== "key" || latest.key !== apiKey) return;
        await integration.connection.status({
          integrationID: TYPESAFE_INTEGRATION,
          connection,
          status: invalid
            ? {
                status: "needs_auth",
                message:
                  "TypeSafe rejected this API key. Reconnect TypeSafe (Jev) using /connect.",
              }
            : undefined,
        });
      },
    };
  };
}
