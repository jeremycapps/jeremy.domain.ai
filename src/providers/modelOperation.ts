import type { ProviderMetrics } from "../types.js";
import { ProviderConfigurationError } from "./errors.js";
import type { ModelProfile, ModelProvider } from "./modelProfiles.js";

export interface PromptPayload {
  operation: string;
  instructions: string[];
  input: unknown;
  outputSchema?: unknown;
  allowedIds?: Record<string, string[]>;
  promptVersion: string;
  schemaVersion: string;
  metadata?: Record<string, unknown>;
}

export interface DirectivePacket {
  max_input_tokens: number;
  max_output_tokens: number;
  max_requested_tokens: number;
  rate_limit_tokens_per_minute: number;
  safety_margin: number;
  if_over_budget: "withhold";
}

export interface SerializedProviderRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

export interface ProviderAdapter {
  provider: ModelProvider;
  serialize(profile: ModelProfile, payload: PromptPayload, directive: DirectivePacket): SerializedProviderRequest;
  countTokens(profile: ModelProfile, request: SerializedProviderRequest): Promise<{ status: "available"; input_tokens: number; raw?: unknown } | { status: "unavailable"; error: string; raw?: unknown }>;
  execute(profile: ModelProfile, request: SerializedProviderRequest): Promise<{ ok: boolean; raw: unknown; usage?: unknown; completion_state?: string | null; error_classification?: string | null }>;
}

export interface ModelOperationResult {
  operation_id: string;
  profile_id: string;
  profile_version: string;
  provider: ModelProvider;
  model: string;
  prompt_version: string;
  schema_version: string;
  admission_status: "eligible" | "withheld";
  exact_input_tokens: number | null;
  allocated_output_tokens: number;
  requested_tokens: number | null;
  safety_adjusted_requested_tokens: number | null;
  remaining_rate_budget: number;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  reasoning_tokens: number | null;
  completion_state: string | null;
  normalized_output: unknown;
  raw_output: unknown;
  latency_ms: number | null;
  cost_usd: number | null;
  provider_error_classification: string | null;
  generation_record_ref?: string;
  token_count: { status: "available"; raw?: unknown } | { status: "unavailable"; error: string; raw?: unknown };
  native_request: Record<string, unknown>;
  directive_packet: DirectivePacket;
  prompt_operation: string;
}

function requireKey(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) throw new ProviderConfigurationError(provider, `${name} is required for live mode.`);
  return value;
}

function promptText(payload: PromptPayload): string {
  return [...payload.instructions, JSON.stringify({ input: payload.input, allowed_ids: payload.allowedIds ?? {}, output_schema: payload.outputSchema ?? null, metadata: payload.metadata ?? {} })].join("\n");
}

function providerUsage(provider: ModelProvider, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return null;
  if (provider === "google") return (raw as { usageMetadata?: unknown }).usageMetadata;
  return (raw as { usage?: unknown }).usage;
}

function tokenFromUsage(usage: unknown, names: string[]): number | null {
  if (!usage || typeof usage !== "object") return null;
  for (const name of names) {
    const value = (usage as Record<string, unknown>)[name];
    if (typeof value === "number") return value;
  }
  return null;
}

function reasoningTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const details = (usage as { output_tokens_details?: unknown }).output_tokens_details;
  if (details && typeof details === "object" && typeof (details as { reasoning_tokens?: unknown }).reasoning_tokens === "number") return (details as { reasoning_tokens: number }).reasoning_tokens;
  return null;
}

function metricsFromResult(result: ModelOperationResult): ProviderMetrics {
  return {
    input_tokens: result.actual_input_tokens,
    output_tokens: result.actual_output_tokens,
    total_tokens: result.actual_input_tokens !== null && result.actual_output_tokens !== null ? result.actual_input_tokens + result.actual_output_tokens : null,
    estimated_cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    measurement_source: result.latency_ms === null ? "unavailable" : "measured"
  };
}

export function providerMetricsFromModelOperation(result: ModelOperationResult): ProviderMetrics {
  return metricsFromResult(result);
}

export function modelOperationRecord(result: ModelOperationResult) {
  return {
    operation_id: result.operation_id,
    profile_id: result.profile_id,
    profile_version: result.profile_version,
    provider: result.provider,
    model: result.model,
    prompt_operation: result.prompt_operation,
    prompt_version: result.prompt_version,
    schema_version: result.schema_version,
    directive_packet: result.directive_packet,
    token_count: result.token_count,
    admission_status: result.admission_status,
    exact_input_tokens: result.exact_input_tokens,
    allocated_output_tokens: result.allocated_output_tokens,
    requested_tokens: result.requested_tokens,
    safety_adjusted_requested_tokens: result.safety_adjusted_requested_tokens,
    remaining_rate_budget: result.remaining_rate_budget,
    actual_input_tokens: result.actual_input_tokens,
    actual_output_tokens: result.actual_output_tokens,
    reasoning_tokens: result.reasoning_tokens,
    completion_state: result.completion_state,
    latency_ms: result.latency_ms,
    cost_usd: result.cost_usd,
    provider_error_classification: result.provider_error_classification
  };
}

class OpenAIAdapter implements ProviderAdapter {
  provider: ModelProvider = "openai";
  serialize(profile: ModelProfile, payload: PromptPayload, directive: DirectivePacket): SerializedProviderRequest {
    const body: Record<string, unknown> = { model: profile.model, input: promptText(payload) };
    if (payload.metadata?.max_output_tokens !== undefined) body.max_output_tokens = payload.metadata.max_output_tokens;
    else body.max_output_tokens = directive.max_output_tokens;
    return { url: `https://api.openai.com${profile.endpoints.execute}`, init: { method: "POST", headers: { Authorization: `Bearer ${requireKey("OPENAI_API_KEY", "openai")}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, body };
  }
  async countTokens(profile: ModelProfile, request: SerializedProviderRequest) {
    const response = await fetch(`https://api.openai.com${profile.endpoints.countTokens}`, { method: "POST", headers: { Authorization: `Bearer ${requireKey("OPENAI_API_KEY", "openai")}`, "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
    const raw = await response.json().catch(() => ({}));
    const tokens = typeof raw.input_tokens === "number" ? raw.input_tokens : typeof raw.tokens === "number" ? raw.tokens : null;
    return response.ok && tokens !== null ? { status: "available" as const, input_tokens: tokens, raw } : { status: "unavailable" as const, error: `token count failed with HTTP ${response.status}`, raw };
  }
  async execute(_profile: ModelProfile, request: SerializedProviderRequest) {
    const response = await fetch(request.url, request.init);
    const raw = await response.json().catch(() => ({}));
    return { ok: response.ok, raw, usage: providerUsage("openai", raw), completion_state: typeof raw.status === "string" ? raw.status : response.ok ? "completed" : "provider_error", error_classification: response.ok ? null : JSON.stringify(raw).includes("rate_limit") ? "rate_limit" : "provider_error" };
  }
}

class AnthropicAdapter implements ProviderAdapter {
  provider: ModelProvider = "anthropic";
  serialize(profile: ModelProfile, payload: PromptPayload, directive: DirectivePacket): SerializedProviderRequest {
    const body: Record<string, unknown> = { model: profile.model, max_tokens: directive.max_output_tokens, messages: [{ role: "user", content: promptText(payload) }] };
    if (payload.outputSchema) body.output_config = { format: { type: "json_schema", schema: payload.outputSchema } };
    if (payload.metadata?.thinking) body.thinking = payload.metadata.thinking;
    return { url: `https://api.anthropic.com${profile.endpoints.execute}`, init: { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": requireKey("ANTHROPIC_API_KEY", "anthropic"), "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) }, body };
  }
  async countTokens(profile: ModelProfile, request: SerializedProviderRequest) {
    const response = await fetch(`https://api.anthropic.com${profile.endpoints.countTokens}`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": requireKey("ANTHROPIC_API_KEY", "anthropic"), "anthropic-version": "2023-06-01" }, body: JSON.stringify(request.body) });
    const raw = await response.json().catch(() => ({}));
    const tokens = typeof raw.input_tokens === "number" ? raw.input_tokens : null;
    return response.ok && tokens !== null ? { status: "available" as const, input_tokens: tokens, raw } : { status: "unavailable" as const, error: `token count failed with HTTP ${response.status}`, raw };
  }
  async execute(_profile: ModelProfile, request: SerializedProviderRequest) {
    const response = await fetch(request.url, request.init);
    const raw = await response.json().catch(() => ({}));
    return { ok: response.ok, raw, usage: providerUsage("anthropic", raw), completion_state: typeof raw.stop_reason === "string" ? raw.stop_reason : response.ok ? "completed" : "provider_error", error_classification: response.ok ? null : JSON.stringify(raw).includes("rate_limit") ? "rate_limit" : "provider_error" };
  }
}

class GoogleAdapter implements ProviderAdapter {
  provider: ModelProvider = "google";
  serialize(profile: ModelProfile, payload: PromptPayload, _directive: DirectivePacket): SerializedProviderRequest {
    const generationConfig: Record<string, unknown> = { responseMimeType: "application/json" };
    if (payload.outputSchema) generationConfig.responseSchema = payload.outputSchema;
    const body: Record<string, unknown> = { contents: [{ parts: [{ text: promptText(payload) }] }], generationConfig };
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${profile.model}${profile.endpoints.execute}?key=${requireKey("GEMINI_API_KEY", "google")}`, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, body };
  }
  async countTokens(profile: ModelProfile, request: SerializedProviderRequest) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${profile.model}${profile.endpoints.countTokens}?key=${requireKey("GEMINI_API_KEY", "google")}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: request.body.contents }) });
    const raw = await response.json().catch(() => ({}));
    const tokens = typeof raw.totalTokens === "number" ? raw.totalTokens : null;
    return response.ok && tokens !== null ? { status: "available" as const, input_tokens: tokens, raw } : { status: "unavailable" as const, error: `token count failed with HTTP ${response.status}`, raw };
  }
  async execute(_profile: ModelProfile, request: SerializedProviderRequest) {
    const response = await fetch(request.url, request.init);
    const raw = await response.json().catch(() => ({}));
    const candidates = raw && typeof raw === "object" ? (raw as { candidates?: unknown }).candidates : null;
    const finish = Array.isArray(candidates) ? (candidates[0] as { finishReason?: unknown }).finishReason : null;
    return { ok: response.ok, raw, usage: providerUsage("google", raw), completion_state: typeof finish === "string" ? finish : response.ok ? "completed" : "provider_error", error_classification: response.ok ? null : "provider_error" };
  }
}

export const providerAdapters: Record<ModelProvider, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  google: new GoogleAdapter()
};

export async function executeModelOperation(input: { profile: ModelProfile; payload: PromptPayload; directive: DirectivePacket; mode: "preflight" | "execute"; remainingRateBudget?: number; adapterRegistry?: Record<ModelProvider, ProviderAdapter> }): Promise<ModelOperationResult> {
  const adapter = (input.adapterRegistry ?? providerAdapters)[input.profile.provider];
  const operation_id = `${input.payload.operation}.${Date.now()}`;
  const remainingRateBudget = input.remainingRateBudget ?? input.directive.rate_limit_tokens_per_minute;
  if (!adapter) {
    return { operation_id, profile_id: input.profile.id, profile_version: input.profile.version, provider: input.profile.provider, model: input.profile.model, prompt_version: input.payload.promptVersion, schema_version: input.payload.schemaVersion, admission_status: "withheld", exact_input_tokens: null, allocated_output_tokens: input.directive.max_output_tokens, requested_tokens: null, safety_adjusted_requested_tokens: null, remaining_rate_budget: remainingRateBudget, actual_input_tokens: null, actual_output_tokens: null, reasoning_tokens: null, completion_state: "adapter_unavailable", normalized_output: null, raw_output: null, latency_ms: null, cost_usd: null, provider_error_classification: "provider_adapter_unavailable", token_count: { status: "unavailable", error: "provider adapter unavailable" }, native_request: {}, directive_packet: input.directive, prompt_operation: input.payload.operation };
  }
  const request = adapter.serialize(input.profile, input.payload, input.directive);
  const tokenCount = input.profile.enabled ? await adapter.countTokens(input.profile, request) : { status: "unavailable" as const, error: "profile disabled" };
  const exact = tokenCount.status === "available" ? tokenCount.input_tokens : null;
  const requested = exact === null ? null : exact + input.directive.max_output_tokens;
  const safetyAdjusted = requested === null ? null : Math.ceil(requested * (1 + input.directive.safety_margin));
  const eligible = input.profile.enabled && exact !== null && exact <= input.directive.max_input_tokens && requested !== null && requested <= input.directive.max_requested_tokens && safetyAdjusted !== null && safetyAdjusted <= remainingRateBudget;
  const base = { operation_id, profile_id: input.profile.id, profile_version: input.profile.version, provider: input.profile.provider, model: input.profile.model, prompt_version: input.payload.promptVersion, schema_version: input.payload.schemaVersion, exact_input_tokens: exact, allocated_output_tokens: input.directive.max_output_tokens, requested_tokens: requested, safety_adjusted_requested_tokens: safetyAdjusted, remaining_rate_budget: remainingRateBudget, actual_input_tokens: null, actual_output_tokens: null, reasoning_tokens: null, normalized_output: null, raw_output: null, latency_ms: null, cost_usd: null, token_count: tokenCount.status === "available" ? { status: "available" as const, raw: tokenCount.raw } : tokenCount, native_request: request.body, directive_packet: input.directive, prompt_operation: input.payload.operation };
  if (!eligible || input.mode === "preflight") {
    const reason = !input.profile.enabled ? "profile_disabled" : tokenCount.status === "unavailable" ? "token_count_unavailable" : exact !== null && exact > input.directive.max_input_tokens ? "input_token_limit_exceeded" : requested !== null && requested > input.directive.max_requested_tokens ? "requested_token_limit_exceeded" : safetyAdjusted !== null && safetyAdjusted > remainingRateBudget ? "rate_budget_exceeded" : null;
    return { ...base, admission_status: eligible ? "eligible" : "withheld", completion_state: input.mode === "preflight" ? "preflight_only" : "withheld", provider_error_classification: reason };
  }
  const started = Date.now();
  const executed = await adapter.execute(input.profile, request);
  const latency_ms = Date.now() - started;
  const usage = executed.usage;
  const actualInput = tokenFromUsage(usage, ["input_tokens", "prompt_tokens", "promptTokenCount"]) ?? exact;
  const actualOutput = tokenFromUsage(usage, ["output_tokens", "completion_tokens", "candidatesTokenCount"]);
  return { ...base, admission_status: "eligible", actual_input_tokens: actualInput, actual_output_tokens: actualOutput, reasoning_tokens: reasoningTokens(usage), completion_state: executed.completion_state ?? (executed.ok ? "completed" : "provider_error"), normalized_output: null, raw_output: executed.raw, latency_ms, cost_usd: null, provider_error_classification: executed.error_classification ?? null };
}

export const defaultDirectivePacket: DirectivePacket = {
  max_input_tokens: 100000,
  max_output_tokens: 4000,
  max_requested_tokens: 104000,
  rate_limit_tokens_per_minute: 100000,
  safety_margin: 0,
  if_over_budget: "withhold"
};
