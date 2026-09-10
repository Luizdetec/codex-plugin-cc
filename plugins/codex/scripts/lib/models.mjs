export const DEFAULT_TASK_MODEL = "gpt-6-astra";
const ALIASES = new Map([["astra", DEFAULT_TASK_MODEL], ["spark", "gpt-5.3-codex-spark"]]);

export function normalizeRequestedModel(value) {
  const model = String(value ?? "").trim();
  return model ? ALIASES.get(model.toLowerCase()) ?? model : DEFAULT_TASK_MODEL;
}

export async function listAvailableModels(client) {
  const models = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const page = await client.request("model/list", { limit: 100, cursor, includeHidden: true });
    if (!Array.isArray(page.data)) throw new Error("Codex returned an invalid model catalog. Update Codex and retry.");
    models.push(...page.data);
    cursor = page.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("Codex repeated a model catalog cursor.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}

export async function resolveTaskModel(client, model, effort) {
  const models = await listAvailableModels(client);
  const selected = models.find((entry) => entry.model === model || entry.id === model);
  if (!selected) {
    throw new Error(`Model "${model}" is not in this Codex account/provider catalog. Run /codex:models, check your login/provider, or explicitly choose --model. No fallback was used.`);
  }
  const supported = selected.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort) ?? [];
  const resolvedEffort = effort ?? selected.defaultReasoningEffort;
  if (!resolvedEffort || !supported.includes(resolvedEffort)) {
    throw new Error(`Unsupported reasoning effort "${resolvedEffort ?? "default"}" for ${model}. Supported: ${supported.join(", ") || "not reported by Codex"}.`);
  }
  return { model: selected.model ?? model, effort: resolvedEffort };
}
