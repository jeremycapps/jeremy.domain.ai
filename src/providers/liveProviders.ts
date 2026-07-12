import type {
  AgentProvider,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  ProviderReadiness,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../types.js";
import { normalizeContext } from "../lib/corusContext.js";
import { ProviderConfigurationError, ProviderExecutionError } from "./errors.js";
import { emptyMetrics, parseJsonObject } from "./providerUtils.js";

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

    if (!response.ok) throw new ProviderExecutionError("google", `Gemini contextualization failed with HTTP ${response.status}.`);
    const parsed = parseJsonObject(textFromGeminiResponse(await response.json()));
    const output = normalizeContext(parsed, input.kind, input.position, input.input_ref);
    output.generation.provider = "google";
    output.generation.model = this.model;
    output.generation.prompt_version = this.promptVersion;
    return { output, provider: "google", model: this.model, prompt_version: this.promptVersion, metrics: emptyMetrics(startedAt) };
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

    if (!response.ok) throw new ProviderExecutionError("anthropic", `Anthropic reduction failed with HTTP ${response.status}.`);
    const output = parseJsonObject(textFromAnthropicResponse(await response.json())) as CapabilityReduction;
    return { output, provider: "anthropic", model: this.model, prompt_version: this.promptVersion, metrics: emptyMetrics(startedAt) };
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

    if (!response.ok) throw new ProviderExecutionError("openai", `OpenAI validation failed with HTTP ${response.status}.`);
    const output = parseJsonObject(textFromOpenAIResponse(await response.json())) as CapabilityValidation;
    return { output, provider: "openai", model: this.model, prompt_version: this.promptVersion, metrics: emptyMetrics(startedAt) };
  }
}
