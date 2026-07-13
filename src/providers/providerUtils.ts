import type { ProviderMetrics } from "../types.js";

export function emptyMetrics(startedAt: number): ProviderMetrics {
  return {
    input_tokens: null,
    output_tokens: null,
    estimated_cost_usd: null,
    latency_ms: Date.now() - startedAt,
    measurement_source: "measured"
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
  const total =
    typeof record.total_tokens === "number"
      ? record.total_tokens
      : typeof record.totalTokenCount === "number"
        ? record.totalTokenCount
        : null;
  return {
    ...base,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total
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

export function textFromOpenAIResponse(data: unknown): string {
  if (data && typeof data === "object" && typeof (data as { output_text?: unknown }).output_text === "string") {
    return (data as { output_text: string }).output_text;
  }

  const output = data && typeof data === "object" ? (data as { output?: unknown }).output : undefined;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      const content = item && typeof item === "object" ? (item as { content?: unknown }).content : undefined;
      if (!Array.isArray(content)) continue;
      for (const contentItem of content) {
        if (contentItem && typeof contentItem === "object" && typeof (contentItem as { text?: unknown }).text === "string") {
          texts.push((contentItem as { text: string }).text);
        }
      }
    }
    const joined = texts.join("");
    if (joined.trim()) return joined;
  }

  throw new Error("OpenAI response did not contain assistant text.");
}
