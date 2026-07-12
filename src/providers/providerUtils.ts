import type { ProviderMetrics } from "../types.js";

export function emptyMetrics(startedAt: number): ProviderMetrics {
  return {
    input_tokens: null,
    output_tokens: null,
    estimated_cost_usd: null,
    latency_ms: Date.now() - startedAt
  };
}

export function metricsFromUsage(startedAt: number, usage: unknown): ProviderMetrics {
  const base = emptyMetrics(startedAt);
  if (!usage || typeof usage !== "object") return base;
  const record = usage as Record<string, unknown>;
  const input =
    typeof record.input_tokens === "number"
      ? record.input_tokens
      : typeof record.prompt_tokens === "number"
        ? record.prompt_tokens
        : typeof record.promptTokenCount === "number"
          ? record.promptTokenCount
          : null;
  const output =
    typeof record.output_tokens === "number"
      ? record.output_tokens
      : typeof record.completion_tokens === "number"
        ? record.completion_tokens
        : typeof record.candidatesTokenCount === "number"
          ? record.candidatesTokenCount
          : null;
  return {
    ...base,
    input_tokens: input,
    output_tokens: output
  };
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }

  throw new Error("Provider response did not contain a JSON object.");
}
