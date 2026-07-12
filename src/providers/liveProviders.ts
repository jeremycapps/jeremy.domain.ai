import type {
  AgentProvider,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  ProviderReadiness,
  ProviderModelAvailability,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../types.js";
import { normalizeContext } from "../lib/corusContext.js";
import { ProviderConfigurationError, ProviderExecutionError } from "./errors.js";
import { metricsFromUsage, parseJsonObject } from "./providerUtils.js";
import { validateCapabilityValidationOutput, validateContextOutput, validateReductionOutput } from "./validators.js";

function requireKey(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ProviderConfigurationError(provider, `${name} is required for live mode.`);
  }
  return value;
}

function textFromOpenAIResponse(data: unknown): string {
  if (data && typeof data === "object" && typeof (data as { output_text?: unknown }).output_text === "string") {
    return (data as { output_text: string }).output_text;
  }
  return JSON.stringify(data);
}

function usageFromOpenAIResponse(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { usage?: unknown }).usage : null;
}

function usageFromGeminiResponse(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { usageMetadata?: unknown }).usageMetadata : null;
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
    if (!response.ok) throw new ProviderExecutionError("google", `Gemini contextualization failed with HTTP ${response.status}.`);
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

export class AnthropicCapabilityReductionProvider implements AgentProvider<ReduceCapabilitiesInput, CapabilityReduction> {
  private readonly model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
  private readonly promptVersion = "reduce.anthropic.v1";

  async execute(input: ReduceCapabilitiesInput): Promise<ProviderResult<CapabilityReduction>> {
    const startedAt = Date.now();
    const apiKey = requireKey("ANTHROPIC_API_KEY", "anthropic");
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
        messages: [
          {
            role: "user",
            content: [
              "Return JSON only: { reducer:'capabilities', inputs:{subject,target}, capabilities:[...] }.",
              "Each capability must map one target requirement to subject evidence refs.",
              "Do not validate your own claims.",
              JSON.stringify(input)
            ].join("\n")
          }
        ]
      })
    });

    const raw = await response.json();
    if (!response.ok) throw new ProviderExecutionError("anthropic", `Anthropic reduction failed with HTTP ${response.status}.`);
    let output;
    try {
      output = validateReductionOutput(parseJsonObject(textFromAnthropicResponse(raw)), "anthropic");
    } catch (error) {
      throw new ProviderExecutionError("anthropic", error instanceof Error ? error.message : "Anthropic returned invalid structured output.", raw);
    }
    return { output, raw_output: raw, provider: "anthropic", model: this.model, prompt_version: this.promptVersion, metrics: metricsFromUsage(startedAt, usageFromAnthropicResponse(raw)) };
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
    if (!response.ok) throw new ProviderExecutionError("openai", `OpenAI validation failed with HTTP ${response.status}.`);
    let output;
    try {
      output = validateCapabilityValidationOutput(parseJsonObject(textFromOpenAIResponse(raw)), "openai");
    } catch (error) {
      throw new ProviderExecutionError("openai", error instanceof Error ? error.message : "OpenAI returned invalid structured output.", raw);
    }
    return { output, raw_output: raw, provider: "openai", model: this.model, prompt_version: this.promptVersion, metrics: metricsFromUsage(startedAt, usageFromOpenAIResponse(raw)) };
  }
}
