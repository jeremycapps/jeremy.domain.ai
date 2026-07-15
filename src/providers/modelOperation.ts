import type { ProviderMetrics } from "../types.js";
import { ProviderConfigurationError } from "./errors.js";
import { resolveModelProfile, type ModelProfile, type ModelProvider } from "./modelProfiles.js";

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
  directive_version?: string;
  max_context_tokens?: number;
  requested_reasoning_tokens?: number;
  token_count_failure_policy?: "withhold" | "use_fallback_estimate";
  reasoning_config?: unknown;
  structured_output_schema?: unknown;
  execution_overrides?: Record<string, unknown>;
  bounded_retry_policy?: { max_attempts: number; retry_on: string[] };
}

export interface DataEgressDecision {
  status: "permitted" | "withheld";
  classification: "synthetic" | "public" | "private" | "restricted";
  purpose: string;
  reason: string;
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

export type ModelExecutionStatus =
  | "admitted"
  | "withheld_data_egress"
  | "withheld_context_limit"
  | "withheld_token_budget"
  | "withheld_rate_budget"
  | "completed"
  | "provider_incomplete"
  | "provider_error"
  | "normalization_failed"
  | "validation_failed";

export interface ModelExecutionReceipt {
  operation_id: string;
  profile_id: string;
  requested_profile_id: string;
  alias_used: boolean;
  alias_profile_id: string | null;
  profile_version: string;
  provider: ModelProvider;
  model: string;
  prompt_version: string;
  directive_version: string;
  schema_version: string;
  estimated_input_tokens: number | null;
  actual_input_tokens: number | null;
  reasoning_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  token_count_source: "native" | "fallback_estimate" | "unavailable";
  requested_reasoning_allocation: number | null;
  requested_output_allocation: number;
  token_budget_limit: number;
  context_token_limit: number;
  rate_budget_limit: number;
  latency_ms: number | null;
  stop_reason: string | null;
  execution_status: ModelExecutionStatus;
  raw_artifact_ref: string | null;
  normalized_artifact_ref: string | null;
  error_classification: string | null;
  cost_usd: number | null;
  data_egress: DataEgressDecision | null;
}

export interface ModelOperationResult<TValue = unknown> extends ModelExecutionReceipt {
  value: TValue | null;
  receipt: ModelExecutionReceipt;
  admission_status: "eligible" | "withheld";
  exact_input_tokens: number | null;
  allocated_output_tokens: number;
  requested_tokens: number | null;
  safety_adjusted_requested_tokens: number | null;
  remaining_rate_budget: number;
  actual_output_tokens: number | null;
  completion_state: string | null;
  normalized_output: unknown;
  raw_output: unknown;
  provider_error_classification: string | null;
  generation_record_ref?: string;
  token_count: { status: "available"; raw?: unknown } | { status: "unavailable"; error: string; raw?: unknown };
  native_request: Record<string, unknown>;
  directive_packet: DirectivePacket;
  prompt_operation: string;
}

export interface ModelOperationInput<TPayload = unknown> {
  profile: ModelProfile | string;
  prompt: PromptPayload;
  payload?: TPayload;
  directive: DirectivePacket;
  mode?: "preflight" | "execute";
  remainingRateBudget?: number;
  adapterRegistry?: Partial<Record<ModelProvider, ProviderAdapter>>;
  rawArtifactRef?: string | null;
  normalizedArtifactRef?: string | null;
  dataEgress?: DataEgressDecision;
}

function requireKey(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) throw new ProviderConfigurationError(provider, `${name} is required for live mode.`);
  return value;
}

function promptText(payload: PromptPayload, directive: DirectivePacket): string {
  return [...payload.instructions, JSON.stringify({ input: payload.input, allowed_ids: payload.allowedIds ?? {}, output_schema: directive.structured_output_schema ?? payload.outputSchema ?? null, metadata: payload.metadata ?? {} })].join("\n");
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
    output_tokens: result.output_tokens,
    total_tokens: result.total_tokens,
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
    requested_profile_id: result.requested_profile_id,
    alias_used: result.alias_used,
    alias_profile_id: result.alias_profile_id,
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
    output_tokens: result.output_tokens,
    total_tokens: result.total_tokens,
    reasoning_tokens: result.reasoning_tokens,
    stop_reason: result.stop_reason,
    execution_status: result.execution_status,
    latency_ms: result.latency_ms,
    cost_usd: result.cost_usd,
    error_classification: result.error_classification,
    data_egress: result.data_egress
  };
}

class OpenAIAdapter implements ProviderAdapter {
  provider: ModelProvider = "openai";
  serialize(profile: ModelProfile, payload: PromptPayload, directive: DirectivePacket): SerializedProviderRequest {
    const body: Record<string, unknown> = { model: profile.model, input: promptText(payload, directive), max_output_tokens: directive.max_output_tokens };
    if (directive.structured_output_schema) body.text = { format: { type: "json_schema", name: "structured_output", schema: directive.structured_output_schema, strict: false } };
    Object.assign(body, directive.execution_overrides ?? {});
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
    const body: Record<string, unknown> = { model: profile.model, max_tokens: directive.max_output_tokens, messages: [{ role: "user", content: promptText(payload, directive) }] };
    if (directive.structured_output_schema) body.output_config = { format: { type: "json_schema", schema: directive.structured_output_schema } };
    if (directive.reasoning_config) body.thinking = directive.reasoning_config;
    Object.assign(body, directive.execution_overrides ?? {});
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
  serialize(profile: ModelProfile, payload: PromptPayload, directive: DirectivePacket): SerializedProviderRequest {
    const generationConfig: Record<string, unknown> = { responseMimeType: "application/json" };
    if (directive.structured_output_schema) generationConfig.responseSchema = directive.structured_output_schema;
    const body: Record<string, unknown> = { contents: [{ parts: [{ text: promptText(payload, directive) }] }], generationConfig };
    Object.assign(generationConfig, directive.execution_overrides ?? {});
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

function fallbackInputTokenEstimate(prompt: PromptPayload, directive: DirectivePacket): number {
  return Math.ceil(promptText(prompt, directive).length / 4);
}

function totalTokensFromUsage(usage: unknown): number | null {
  return tokenFromUsage(usage, ["total_tokens", "totalTokenCount"]);
}

function executionStatusFromProvider(executed: { ok: boolean; completion_state?: string | null; error_classification?: string | null }): ModelExecutionStatus {
  if (!executed.ok) return "provider_error";
  const state = executed.completion_state ?? "completed";
  if (["max_tokens", "MAX_TOKENS", "length", "SAFETY", "RECITATION"].includes(state)) return "provider_incomplete";
  return "completed";
}

export async function executeModelOperation<TValue = unknown>(
  input: (ModelOperationInput & { payload?: unknown }) | { profile: ModelProfile | string; payload: PromptPayload; directive: DirectivePacket; mode?: "preflight" | "execute"; remainingRateBudget?: number; adapterRegistry?: Partial<Record<ModelProvider, ProviderAdapter>>; rawArtifactRef?: string | null; normalizedArtifactRef?: string | null; dataEgress?: DataEgressDecision }
): Promise<ModelOperationResult<TValue>> {
  const prompt = "prompt" in input ? input.prompt : input.payload;
  if (!prompt || typeof prompt !== "object" || !("operation" in prompt)) throw new Error("executeModelOperation requires a PromptPayload.");
  const directive = input.directive;
  const mode = input.mode ?? "execute";
  const resolved = resolveModelProfile(input.profile);
  const profile = resolved.profile;
  const adapter = (input.adapterRegistry ?? providerAdapters)[profile.provider];
  const operation_id = `${(prompt as PromptPayload).operation}.${Date.now()}`;
  const remainingRateBudget = input.remainingRateBudget ?? directive.rate_limit_tokens_per_minute;
  const requestedReasoning = directive.requested_reasoning_tokens ?? null;
  const requestedReasoningForBudget = requestedReasoning ?? 0;
  const requestedOutput = directive.max_output_tokens;
  const contextLimit = directive.max_context_tokens ?? directive.max_input_tokens;
  const tokenBudgetLimit = directive.max_requested_tokens;
  const directiveVersion = directive.directive_version ?? "v1";

  const baseReceipt = (overrides: Partial<ModelExecutionReceipt>): ModelExecutionReceipt => ({
    operation_id,
    profile_id: profile.id,
    requested_profile_id: resolved.requested_profile_id,
    alias_used: resolved.alias_used,
    alias_profile_id: resolved.alias_profile_id,
    provider: profile.provider,
    model: profile.model,
    profile_version: profile.version,
    prompt_version: (prompt as PromptPayload).promptVersion,
    directive_version: directiveVersion,
    schema_version: (prompt as PromptPayload).schemaVersion,
    estimated_input_tokens: null,
    actual_input_tokens: null,
    reasoning_tokens: null,
    output_tokens: null,
    total_tokens: null,
    token_count_source: "unavailable",
    requested_reasoning_allocation: requestedReasoning,
    requested_output_allocation: requestedOutput,
    token_budget_limit: tokenBudgetLimit,
    context_token_limit: contextLimit,
    rate_budget_limit: remainingRateBudget,
    latency_ms: null,
    stop_reason: null,
    execution_status: "provider_error",
    raw_artifact_ref: input.rawArtifactRef ?? null,
    normalized_artifact_ref: input.normalizedArtifactRef ?? null,
    error_classification: null,
    cost_usd: null,
    data_egress: input.dataEgress ?? null,
    ...overrides
  });

  const resultFromReceipt = (
    receipt: ModelExecutionReceipt,
    extras: Partial<ModelOperationResult<TValue>> = {}
  ): ModelOperationResult<TValue> => ({
    ...receipt,
    value: null,
    receipt,
    admission_status: receipt.execution_status === "admitted" || receipt.execution_status === "completed" ? "eligible" : "withheld",
    exact_input_tokens: receipt.token_count_source === "native" ? receipt.estimated_input_tokens : null,
    allocated_output_tokens: requestedOutput,
    requested_tokens: receipt.estimated_input_tokens === null ? null : receipt.estimated_input_tokens + requestedReasoningForBudget + requestedOutput,
    safety_adjusted_requested_tokens: receipt.estimated_input_tokens === null ? null : Math.ceil((receipt.estimated_input_tokens + requestedReasoningForBudget + requestedOutput) * (1 + directive.safety_margin)),
    remaining_rate_budget: remainingRateBudget,
    actual_output_tokens: receipt.output_tokens,
    completion_state: receipt.stop_reason,
    normalized_output: null,
    raw_output: null,
    provider_error_classification: receipt.error_classification,
    token_count: { status: "unavailable", error: receipt.error_classification ?? "unavailable" },
    native_request: {},
    directive_packet: directive,
    prompt_operation: (prompt as PromptPayload).operation,
    ...extras
  });

  if (!adapter) {
    const receipt = baseReceipt({ execution_status: "provider_error", error_classification: "provider_adapter_unavailable", stop_reason: "adapter_unavailable" });
    return resultFromReceipt(receipt);
  }

  if (input.dataEgress?.status === "withheld") {
    const receipt = baseReceipt({ execution_status: "withheld_data_egress", error_classification: "data_egress_withheld", stop_reason: input.dataEgress.reason });
    return resultFromReceipt(receipt, {
      admission_status: "withheld",
      provider_error_classification: "data_egress_withheld",
      completion_state: "withheld_data_egress",
      token_count: { status: "unavailable", error: "data_egress_withheld" },
      native_request: {}
    });
  }

  const request = adapter.serialize(profile, prompt as PromptPayload, directive);
  const unavailableTokenCount = { status: "unavailable" as const, error: profile.enabled ? "token count unavailable" : "profile disabled" };
  const tokenCount = profile.enabled ? await adapter.countTokens(profile, request) : unavailableTokenCount;
  const tokenCountSource = tokenCount.status === "available" ? "native" : directive.token_count_failure_policy === "use_fallback_estimate" ? "fallback_estimate" : "unavailable";
  const estimatedInput = tokenCount.status === "available" ? tokenCount.input_tokens : tokenCountSource === "fallback_estimate" ? fallbackInputTokenEstimate(prompt as PromptPayload, directive) : null;
  const requestedTokens = estimatedInput === null ? null : estimatedInput + requestedReasoningForBudget + requestedOutput;
  const safetyAdjusted = requestedTokens === null ? null : Math.ceil(requestedTokens * (1 + directive.safety_margin));
  const tokenError = tokenCount.status === "available" ? null : tokenCount.error;

  const ineligibleStatus =
    !profile.enabled || estimatedInput === null
      ? "withheld_token_budget"
      : estimatedInput > contextLimit
        ? "withheld_context_limit"
        : requestedTokens !== null && requestedTokens > tokenBudgetLimit
          ? "withheld_token_budget"
          : safetyAdjusted !== null && safetyAdjusted > remainingRateBudget
            ? "withheld_rate_budget"
            : null;

  const preExecutionReceipt = baseReceipt({
    estimated_input_tokens: estimatedInput,
    token_count_source: tokenCountSource,
    execution_status: ineligibleStatus ?? "admitted",
    error_classification: ineligibleStatus ? estimatedInput === null ? "token_count_unavailable" : ineligibleStatus : null
  });
  const preExecutionExtras = {
    exact_input_tokens: tokenCount.status === "available" ? estimatedInput : null,
    requested_tokens: requestedTokens,
    safety_adjusted_requested_tokens: safetyAdjusted,
    admission_status: ineligibleStatus ? "withheld" as const : "eligible" as const,
    completion_state: mode === "preflight" && !ineligibleStatus ? "preflight_only" : ineligibleStatus ? "withheld" : "admitted",
    provider_error_classification: ineligibleStatus ? estimatedInput === null ? "token_count_unavailable" : ineligibleStatus : null,
    token_count: tokenCount.status === "available" ? { status: "available" as const, raw: tokenCount.raw } : tokenCount,
    native_request: request.body
  };

  if (ineligibleStatus || mode === "preflight") {
    return resultFromReceipt(preExecutionReceipt, preExecutionExtras);
  }

  const started = Date.now();
  const executed = await adapter.execute(profile, request);
  const latency_ms = Date.now() - started;
  const usage = executed.usage;
  const actualInput = tokenFromUsage(usage, ["input_tokens", "prompt_tokens", "promptTokenCount"]) ?? estimatedInput;
  const outputTokens = tokenFromUsage(usage, ["output_tokens", "completion_tokens", "candidatesTokenCount"]);
  const observedReasoning = reasoningTokens(usage);
  const observedTotal = totalTokensFromUsage(usage) ?? (actualInput !== null && outputTokens !== null ? actualInput + outputTokens : null);
  const executionStatus = executionStatusFromProvider(executed);
  const receipt = baseReceipt({
    estimated_input_tokens: estimatedInput,
    actual_input_tokens: actualInput,
    reasoning_tokens: observedReasoning,
    output_tokens: outputTokens,
    total_tokens: observedTotal,
    token_count_source: tokenCountSource,
    latency_ms,
    stop_reason: executed.completion_state ?? (executed.ok ? "completed" : "provider_error"),
    execution_status: executionStatus,
    error_classification: executed.error_classification ?? null
  });
  return resultFromReceipt(receipt, {
    admission_status: "eligible",
    exact_input_tokens: tokenCount.status === "available" ? estimatedInput : null,
    actual_input_tokens: actualInput,
    actual_output_tokens: outputTokens,
    reasoning_tokens: observedReasoning,
    completion_state: receipt.stop_reason,
    normalized_output: null,
    raw_output: executed.raw,
    latency_ms,
    cost_usd: null,
    provider_error_classification: executed.error_classification ?? null,
    token_count: tokenCount.status === "available" ? { status: "available" as const, raw: tokenCount.raw } : tokenCount,
    native_request: request.body
  });
}

export const defaultDirectivePacket: DirectivePacket = {
  max_input_tokens: 100000,
  max_output_tokens: 4000,
  max_requested_tokens: 104000,
  rate_limit_tokens_per_minute: 100000,
  safety_margin: 0,
  if_over_budget: "withhold"
};
