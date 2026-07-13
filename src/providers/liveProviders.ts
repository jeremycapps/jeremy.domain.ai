import type {
  AgentProvider,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  FailureAnalysis,
  FailureAnalysisInput,
  JobRequirementClusteringInput,
  JobRequirementClusterRepairInput,
  JobRequirementClusters,
  ProviderReadiness,
  ProviderModelAvailability,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../types.js";
import { validateJobRequirementClusterSchema } from "../lib/jobRequirementClustering.js";
import { normalizeContext } from "../lib/corusContext.js";
import { ProviderConfigurationError, ProviderExecutionError } from "./errors.js";
import { metricsFromUsage, parseJsonObject, textFromOpenAIResponse } from "./providerUtils.js";
import {
  validateCapabilityValidationOutput,
  validateContextOutput,
  validateFailureAnalysisOutput,
  validateReductionOutput,
  validateReductionReferences
} from "./validators.js";

function requireKey(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ProviderConfigurationError(provider, `${name} is required for live mode.`);
  }
  return value;
}

function usageFromOpenAIResponse(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { usage?: unknown }).usage : null;
}

function usageFromGeminiResponse(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { usageMetadata?: unknown }).usageMetadata : null;
}

function finishReasonFromGeminiResponse(data: unknown): string | null {
  const candidates = data && typeof data === "object" ? (data as { candidates?: unknown }).candidates : null;
  if (!Array.isArray(candidates)) return null;
  const reason = (candidates[0] as { finishReason?: unknown })?.finishReason;
  return typeof reason === "string" ? reason : null;
}

function modelFromGeminiResponse(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const modelVersion = (data as { modelVersion?: unknown }).modelVersion;
    if (typeof modelVersion === "string" && modelVersion.trim()) return modelVersion.replace(/^models\//, "");
  }
  return fallback;
}

function withRuntimeClusterProvenance(value: JobRequirementClusters, provider: string, model: string, promptVersion: string): JobRequirementClusters {
  return {
    ...value,
    generated_by: {
      role: "implementer",
      provider,
      model,
      prompt_version: promptVersion
    }
  };
}

function geminiResponseSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const record = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "const") {
      converted.enum = [value];
    } else if (key === "additionalProperties" || key === "minLength") {
      continue;
    } else if (Array.isArray(value)) {
      converted[key] = value.map(geminiResponseSchema);
    } else {
      converted[key] = geminiResponseSchema(value);
    }
  }
  return converted;
}

function usageFromAnthropicResponse(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { usage?: unknown }).usage : null;
}

function textFromGeminiResponse(data: unknown): string {
  const candidates = data && typeof data === "object" ? (data as { candidates?: unknown }).candidates : null;
  if (Array.isArray(candidates)) {
    const parts = (candidates[0] as { content?: { parts?: Array<{ text?: string }> } })?.content?.parts;
    const text = parts?.map((part) => part.text ?? "").join("");
    if (text) return text;
  }
  return JSON.stringify(data);
}

function textFromAnthropicResponse(data: unknown): string {
  const content = data && typeof data === "object" ? (data as { content?: unknown }).content : null;
  if (Array.isArray(content)) {
    const text = content.map((item) => (item as { text?: string }).text ?? "").join("");
    if (text) return text;
  }
  return JSON.stringify(data);
}

export function providerReadiness(mode: "mocked" | "fixture" | "live"): ProviderReadiness {
  const required = mode === "live" ? ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] : [];
  const missing = required.filter((name) => !process.env[name]);
  return {
    mode,
    ready: missing.length === 0,
    missing_credentials: missing,
    required_credentials: required
  };
}

function modelNameFromGemini(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

export function configuredModelIds() {
  return {
    google: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
    anthropic: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
    openai: process.env.OPENAI_MODEL ?? "gpt-4.1-mini"
  };
}

export async function checkConfiguredModels(): Promise<ProviderModelAvailability[]> {
  const models = configuredModelIds();
  const checks: ProviderModelAvailability[] = [];

  try {
    const apiKey = requireKey("GEMINI_API_KEY", "google");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const available = (data.models ?? []).some(
      (model) => model.name && modelNameFromGemini(model.name) === models.google && model.supportedGenerationMethods?.includes("generateContent")
    );
    checks.push({ provider: "google", model: models.google, available, checked: true });
  } catch (error) {
    checks.push({ provider: "google", model: models.google, available: false, checked: false, error: error instanceof Error ? error.message : "unknown" });
  }

  try {
    const apiKey = requireKey("ANTHROPIC_API_KEY", "anthropic");
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const available = (data.data ?? []).some((model) => model.id === models.anthropic);
    checks.push({ provider: "anthropic", model: models.anthropic, available, checked: true });
  } catch (error) {
    checks.push({
      provider: "anthropic",
      model: models.anthropic,
      available: false,
      checked: false,
      error: error instanceof Error ? error.message : "unknown"
    });
  }

  try {
    const apiKey = requireKey("OPENAI_API_KEY", "openai");
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const available = (data.data ?? []).some((model) => model.id === models.openai);
    checks.push({ provider: "openai", model: models.openai, available, checked: true });
  } catch (error) {
    checks.push({ provider: "openai", model: models.openai, available: false, checked: false, error: error instanceof Error ? error.message : "unknown" });
  }

  return checks;
}

export class GeminiContextualizationProvider implements AgentProvider<ContextualizeInput, Context> {
  private readonly model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  private readonly promptVersion = "contextualize.gemini.v1";

  async execute(input: ContextualizeInput): Promise<ProviderResult<Context>> {
    const startedAt = Date.now();
    const apiKey = requireKey("GEMINI_API_KEY", "google");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    "Return one JSON object matching the generic Corus Context schema.",
                    "Do not derive capabilities. Preserve source references.",
                    `kind: ${input.kind}`,
                    `position: ${input.position}`,
                    `input_ref: ${input.input_ref}`,
                    JSON.stringify(input.source)
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: { responseMimeType: "application/json" }
        })
      }
    );

    const raw = await response.json();
    if (!response.ok) throw new ProviderExecutionError("google", `Gemini contextualization failed with HTTP ${response.status}.`, raw);
    let output;
    try {
      const parsed = parseJsonObject(textFromGeminiResponse(raw));
      output = validateContextOutput(normalizeContext(parsed, input.kind, input.position, input.input_ref), "google");
    } catch (error) {
      throw new ProviderExecutionError("google", error instanceof Error ? error.message : "Gemini returned invalid structured output.", raw);
    }
    output.generation.provider = "google";
    output.generation.model = this.model;
    output.generation.prompt_version = this.promptVersion;
    return { output, raw_output: raw, provider: "google", model: this.model, prompt_version: this.promptVersion, metrics: metricsFromUsage(startedAt, usageFromGeminiResponse(raw)) };
  }
}

export class GeminiJobRequirementClusteringProvider implements AgentProvider<JobRequirementClusteringInput, JobRequirementClusters> {
  private readonly model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  private readonly promptVersion = "cluster-job-requirements.gemini.v1";

  async execute(input: JobRequirementClusteringInput): Promise<ProviderResult<JobRequirementClusters>> {
    const started = new Date();
    const startedAt = started.getTime();
    const apiKey = requireKey("GEMINI_API_KEY", "google");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    "Group the atomic requirements from this job description into the smallest coherent capability domains that could later be assessed against applicant evidence.",
                    "Preserve every requirement ID. Do not infer anything about an applicant, generate applicant claims, or decide whether a candidate satisfies the role.",
                    "Return only one JSON object matching corus.job_requirement_clusters.v1.",
                    JSON.stringify({
                      job_description_ref: input.job_description_ref,
                      job_description: input.job_description,
                      clustering_policy: input.policy,
                      output_schema: input.schema
                    })
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: geminiResponseSchema(input.schema)
          }
        })
      }
    );

    const raw = await response.json();
    const completed = new Date();
    const metrics = metricsFromUsage(startedAt, usageFromGeminiResponse(raw));
    const stopReason = finishReasonFromGeminiResponse(raw);
    const actualModel = modelFromGeminiResponse(raw, this.model);
    const metadata = {
      model: actualModel,
      prompt_version: this.promptVersion,
      schema_version: "corus.job_requirement_clusters.v1",
      metrics,
      stop_reason: stopReason,
      provider_completion_state: stopReason ?? (response.ok ? "completed" : "provider_error"),
      started_at: started.toISOString(),
      completed_at: completed.toISOString()
    };
    if (!response.ok) throw new ProviderExecutionError("google", `Gemini job-requirement clustering failed with HTTP ${response.status}.`, raw, { ...metadata, provider_status: "provider_error" });
    if (stopReason && stopReason !== "STOP") {
      throw new ProviderExecutionError("google", `Gemini job-requirement clustering did not complete: ${stopReason}.`, raw, metadata);
    }

    let output;
    try {
      output = validateJobRequirementClusterSchema(withRuntimeClusterProvenance(parseJsonObject(textFromGeminiResponse(raw)) as JobRequirementClusters, "google", actualModel, this.promptVersion), "google", this.promptVersion);
    } catch (error) {
      throw new ProviderExecutionError("google", error instanceof Error ? error.message : "Gemini returned invalid job-requirement clusters.", raw, metadata);
    }
    return { output, raw_output: raw, provider: "google", model: actualModel, prompt_version: this.promptVersion, metrics, started_at: started.toISOString(), completed_at: completed.toISOString() };
  }
}

export class GeminiJobRequirementClusterRepairProvider implements AgentProvider<JobRequirementClusterRepairInput, JobRequirementClusters> {
  private readonly model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
  private readonly promptVersion = "cluster-job-requirements.gemini.repair.v1";

  async execute(input: JobRequirementClusterRepairInput): Promise<ProviderResult<JobRequirementClusters>> {
    const started = new Date();
    const startedAt = started.getTime();
    const apiKey = requireKey("GEMINI_API_KEY", "google");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    "Repair the proposed job-requirement cluster map. The deterministic validator found three original requirements that are neither assigned to a cluster nor explicitly listed as unassigned.",
                    "Preserve the existing clusters, labels, rationales, and memberships where they remain semantically coherent.",
                    "Assign each missing requirement to the most coherent existing or new cluster, or explicitly list it as unassigned when no coherent grouping exists.",
                    "Return a complete replacement cluster artifact containing every original requirement ID. Do not inspect applicant evidence, generate applicant capability claims, or decide whether an applicant satisfies the role.",
                    "All 34 original requirement IDs must appear. A requirement may appear in more than one cluster only when the overlap is explicitly reported. Unassigned requirements must appear in unassigned_requirement_refs. Unknown requirement IDs are prohibited. Original requirement text and IDs must not be altered. Return the complete artifact, not only the three repairs.",
                    JSON.stringify({
                      original_job_description: {
                        requirement_count: input.integrity_result.checks.original_requirement_count,
                        complete_preserved_ledger: true,
                        ref: input.job_description_ref,
                        context: input.job_description
                      },
                      clustering_policy: input.policy,
                      previous_proposal: {
                        ref: input.previous_proposal_ref,
                        proposal: input.previous_proposal
                      },
                      integrity_result: {
                        ref: input.integrity_result_ref,
                        result: input.integrity_result
                      },
                      missing_requirement_refs: input.missing_requirement_refs,
                      output_schema: input.schema
                    })
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: geminiResponseSchema(input.schema)
          }
        })
      }
    );

    const raw = await response.json();
    const completed = new Date();
    const metrics = metricsFromUsage(startedAt, usageFromGeminiResponse(raw));
    const stopReason = finishReasonFromGeminiResponse(raw);
    const actualModel = modelFromGeminiResponse(raw, this.model);
    const metadata = {
      model: actualModel,
      prompt_version: this.promptVersion,
      schema_version: "corus.job_requirement_clusters.v1",
      metrics,
      stop_reason: stopReason,
      provider_completion_state: stopReason ?? (response.ok ? "completed" : "provider_error"),
      started_at: started.toISOString(),
      completed_at: completed.toISOString()
    };
    if (!response.ok) throw new ProviderExecutionError("google", `Gemini job-requirement repair failed with HTTP ${response.status}.`, raw, { ...metadata, provider_status: "provider_error" });
    if (stopReason && stopReason !== "STOP") {
      throw new ProviderExecutionError("google", `Gemini job-requirement repair did not complete: ${stopReason}.`, raw, metadata);
    }

    let output;
    try {
      output = validateJobRequirementClusterSchema(withRuntimeClusterProvenance(parseJsonObject(textFromGeminiResponse(raw)) as JobRequirementClusters, "google", actualModel, this.promptVersion), "google", this.promptVersion);
    } catch (error) {
      throw new ProviderExecutionError("google", error instanceof Error ? error.message : "Gemini returned invalid repaired job-requirement clusters.", raw, metadata);
    }
    return { output, raw_output: raw, provider: "google", model: actualModel, prompt_version: this.promptVersion, metrics, started_at: started.toISOString(), completed_at: completed.toISOString() };
  }
}

export class AnthropicCapabilityReductionProvider implements AgentProvider<ReduceCapabilitiesInput, CapabilityReduction> {
  private readonly model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";

  async execute(input: ReduceCapabilitiesInput): Promise<ProviderResult<CapabilityReduction>> {
    const startedAt = Date.now();
    const apiKey = requireKey("ANTHROPIC_API_KEY", "anthropic");
    const isRecovery = Boolean(input.failure_analysis);
    const promptVersion = isRecovery ? "reduce.anthropic.recovery.v1" : "reduce.anthropic.v1";
    const content = isRecovery
      ? [
          "Revise the prior output only enough to satisfy the existing contract.",
          "Do not add new requirements, evidence, capabilities, or architecture.",
          "Every requirement_ref must use a supplied target requirement ID.",
          "Every evidence_ref must use a supplied subject evidence ID.",
          "Return the complete corrected CapabilityReduction object.",
          JSON.stringify({
            original_reduction_input: { contexts: input.contexts },
            prior_raw_output: input.prior_raw_output,
            deterministic_validation_error: input.structural_error,
            openai_corrections: input.failure_analysis?.corrections,
            existing_capability_schema: expectedCapabilityReductionSchema(),
            valid_subject_evidence_ids: input.valid_subject_evidence_ids ?? [],
            valid_target_requirement_ids: input.valid_target_requirement_ids ?? []
          })
        ].join("\n")
      : [
          "Produce a CapabilityReduction object using the configured structured output schema.",
          "Each capability must map one target requirement to subject evidence refs.",
          "Do not validate your own claims.",
          JSON.stringify(input)
        ].join("\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4000,
        output_config: {
          format: {
            type: "json_schema",
            schema: capabilityReductionJsonSchema()
          }
        },
        messages: [
          {
            role: "user",
            content
          }
        ]
      })
    });

    const raw = await response.json();
    if (!response.ok) throw new ProviderExecutionError("anthropic", `Anthropic reduction failed with HTTP ${response.status}.`, raw);
    let output;
    try {
      output = validateReductionReferences(validateReductionOutput(parseJsonObject(textFromAnthropicResponse(raw)), "anthropic"), input.contexts, "anthropic");
    } catch (error) {
      throw new ProviderExecutionError("anthropic", error instanceof Error ? error.message : "Anthropic returned invalid structured output.", raw);
    }
    return { output, raw_output: raw, provider: "anthropic", model: this.model, prompt_version: promptVersion, metrics: metricsFromUsage(startedAt, usageFromAnthropicResponse(raw)) };
  }
}

export class OpenAIValidationProvider implements AgentProvider<ValidateCapabilitiesInput, CapabilityValidation> {
  private readonly model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  private readonly promptVersion = "validate.openai.v1";

  async execute(input: ValidateCapabilitiesInput): Promise<ProviderResult<CapabilityValidation>> {
    const startedAt = Date.now();
    const apiKey = requireKey("OPENAI_API_KEY", "openai");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          "Validate Corus capability candidates against subject and target contexts.",
          "Return JSON only: {status, findings, validated_capability_ids, rejected_capability_ids}.",
          "Unsupported claims cannot pass. Schema/product ambiguity must be architect_required.",
          JSON.stringify(input)
        ].join("\n")
      })
    });

    const raw = await response.json();
    if (!response.ok) throw new ProviderExecutionError("openai", `OpenAI validation failed with HTTP ${response.status}.`, raw);
    let output;
    try {
      output = validateCapabilityValidationOutput(parseJsonObject(textFromOpenAIResponse(raw)), "openai");
    } catch (error) {
      throw new ProviderExecutionError("openai", error instanceof Error ? error.message : "OpenAI returned invalid structured output.", raw, {
        model: this.model,
        prompt_version: this.promptVersion,
        schema_version: "corus.validation.v1",
        metrics: metricsFromUsage(startedAt, usageFromOpenAIResponse(raw))
      });
    }
    return { output, raw_output: raw, provider: "openai", model: this.model, prompt_version: this.promptVersion, metrics: metricsFromUsage(startedAt, usageFromOpenAIResponse(raw)) };
  }
}

export class OpenAIFailureAnalysisProvider implements AgentProvider<FailureAnalysisInput, FailureAnalysis> {
  private readonly model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  private readonly promptVersion = "failure-analysis.openai.v1";

  async execute(input: FailureAnalysisInput): Promise<ProviderResult<FailureAnalysis>> {
    const startedAt = Date.now();
    const apiKey = requireKey("OPENAI_API_KEY", "openai");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          "Analyze a malformed Corus inter-agent handoff.",
          "Do not redesign schemas. Do not browse. Do not change product meaning.",
          "Classify as correctable only when the correction preserves the existing schema and reducer semantics.",
          "Return JSON only matching {status, failed_stage, failure_type, diagnosis, corrections, retry_stage, architecture_change_required, confidence}.",
          JSON.stringify(input)
        ].join("\n")
      })
    });

    const raw = await response.json();
    if (!response.ok) throw new ProviderExecutionError("openai", `OpenAI failure analysis failed with HTTP ${response.status}.`, raw);
    let output;
    try {
      output = validateFailureAnalysisOutput(parseJsonObject(textFromOpenAIResponse(raw)), "openai");
    } catch (error) {
      throw new ProviderExecutionError("openai", error instanceof Error ? error.message : "OpenAI returned invalid failure-analysis output.", raw, {
        model: this.model,
        prompt_version: this.promptVersion,
        schema_version: "corus.failure_analysis.v1",
        metrics: metricsFromUsage(startedAt, usageFromOpenAIResponse(raw))
      });
    }
    return { output, raw_output: raw, provider: "openai", model: this.model, prompt_version: this.promptVersion, metrics: metricsFromUsage(startedAt, usageFromOpenAIResponse(raw)) };
  }
}

export function capabilityReductionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reducer", "inputs", "capabilities"],
    properties: {
      reducer: { const: "capabilities" },
      inputs: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "target"],
        properties: {
          subject: { type: "string" },
          target: { type: "string" }
        }
      },
      capabilities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "requirement_ref", "statement", "evidence_refs", "support", "confidence", "generated_by"],
          properties: {
            id: { type: "string" },
            requirement_ref: { type: "string" },
            statement: { type: "string" },
            evidence_refs: {
              type: "array",
              items: { type: "string" }
            },
            support: { enum: ["supported", "adjacent", "unsupported", "unknown"] },
            confidence: { enum: ["high", "medium", "low"] },
            generated_by: {
              type: "object",
              additionalProperties: false,
              required: ["provider", "model", "prompt_version"],
              properties: {
                provider: { type: "string" },
                model: { type: "string" },
                prompt_version: { type: "string" }
              }
            }
          }
        }
      }
    }
  };
}

export const expectedCapabilityReductionSchema = capabilityReductionJsonSchema;
