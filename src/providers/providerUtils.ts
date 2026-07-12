import type { ProviderMetrics } from "../types.js";

export function emptyMetrics(startedAt: number): ProviderMetrics {
  return {
    input_tokens: null,
    output_tokens: null,
    estimated_cost_usd: null,
    latency_ms: Date.now() - startedAt
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
