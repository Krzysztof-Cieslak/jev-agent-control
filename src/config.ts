export interface Options {
  enabled: boolean;
  autoHandoff: boolean;
  model: string;
  minConfidence: number;
  minMargin: number;
  timeoutMs: number;
  maxHandoffs: number;
  contextChars: number;
  historyLimit: number;
  includeAgents?: string[];
  excludeAgents: string[];
  descriptions: Record<string, string>;
}

export function parseOptions(raw: Record<string, unknown> = {}): Options {
  const defaults: Options = {
    enabled: true,
    autoHandoff: true,
    model: "jev-latest",
    minConfidence: 0.75,
    minMargin: 0.15,
    timeoutMs: 3500,
    maxHandoffs: 6,
    contextChars: 12000,
    historyLimit: 20,
    excludeAgents: [],
    descriptions: {},
  };
  const keys = new Set([...Object.keys(defaults), "includeAgents"]);
  for (const key of Object.keys(raw)) {
    if (!keys.has(key)) throw new Error(`Unknown Jev option: ${key}`);
  }
  const value = { ...defaults, ...raw } as Options;
  for (const key of ["enabled", "autoHandoff"] as const) {
    if (typeof value[key] !== "boolean")
      throw new Error(`${key} must be a boolean`);
  }
  if (typeof value.model !== "string" || !value.model.trim())
    throw new Error("model must be a nonempty string");
  for (const key of ["minConfidence", "minMargin"] as const) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)
      throw new Error(`${key} must be between 0 and 1`);
  }
  for (const [key, min, max] of [
    ["timeoutMs", 100, 60000],
    ["maxHandoffs", 0, 100],
    ["contextChars", 1000, 16000],
    ["historyLimit", 1, 100],
  ] as const) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  for (const key of ["includeAgents", "excludeAgents"] as const) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        !value[key]!.every((v) => typeof v === "string" && v.length > 0))
    )
      throw new Error(`${key} must be an array of agent IDs`);
  }
  if (
    !value.descriptions ||
    typeof value.descriptions !== "object" ||
    Array.isArray(value.descriptions) ||
    !Object.values(value.descriptions).every((v) => typeof v === "string")
  )
    throw new Error("descriptions must map agent IDs to strings");
  return value;
}
