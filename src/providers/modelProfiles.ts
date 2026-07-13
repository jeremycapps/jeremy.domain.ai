export type ModelProvider = "openai" | "anthropic" | "google";
export type ApiMode = "responses" | "messages" | "generateContent";

export interface ModelProfile {
  id: string;
  provider: ModelProvider;
  model: string;
  endpoints: {
    countTokens: string;
    execute: string;
  };
  apiMode: ApiMode;
  enabled: boolean;
  version: string;
  metadata?: Record<string, unknown>;
}

export function configuredModelIds() {
  return {
    google: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
    anthropic: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
    openai: process.env.OPENAI_MODEL ?? "gpt-4.1-mini"
  };
}

export function modelProfiles(): Record<string, ModelProfile> {
  const models = configuredModelIds();
  return {
    "google-contextualizer": {
      id: "google-contextualizer",
      provider: "google",
      model: models.google,
      endpoints: { countTokens: ":countTokens", execute: ":generateContent" },
      apiMode: "generateContent",
      enabled: true,
      version: "v1"
    },
    "google-job-requirement-clusterer": {
      id: "google-job-requirement-clusterer",
      provider: "google",
      model: models.google,
      endpoints: { countTokens: ":countTokens", execute: ":generateContent" },
      apiMode: "generateContent",
      enabled: true,
      version: "v1"
    },
    "google-job-requirement-cluster-repairer": {
      id: "google-job-requirement-cluster-repairer",
      provider: "google",
      model: models.google,
      endpoints: { countTokens: ":countTokens", execute: ":generateContent" },
      apiMode: "generateContent",
      enabled: true,
      version: "v1"
    },
    "anthropic-capability-reducer": {
      id: "anthropic-capability-reducer",
      provider: "anthropic",
      model: models.anthropic,
      endpoints: { countTokens: "/v1/messages/count_tokens", execute: "/v1/messages" },
      apiMode: "messages",
      enabled: true,
      version: "v1"
    },
    "openai-capability-validator": {
      id: "openai-capability-validator",
      provider: "openai",
      model: models.openai,
      endpoints: { countTokens: "/v1/responses/input_tokens", execute: "/v1/responses" },
      apiMode: "responses",
      enabled: true,
      version: "v1"
    },
    "openai-failure-analyzer": {
      id: "openai-failure-analyzer",
      provider: "openai",
      model: models.openai,
      endpoints: { countTokens: "/v1/responses/input_tokens", execute: "/v1/responses" },
      apiMode: "responses",
      enabled: true,
      version: "v1"
    },
    "openai-resume-generator": {
      id: "openai-resume-generator",
      provider: "openai",
      model: models.openai,
      endpoints: { countTokens: "/v1/responses/input_tokens", execute: "/v1/responses" },
      apiMode: "responses",
      enabled: true,
      version: "v1"
    },
    "openai-cluster-validator": {
      id: "openai-cluster-validator",
      provider: "openai",
      model: models.openai,
      endpoints: { countTokens: "/v1/responses/input_tokens", execute: "/v1/responses" },
      apiMode: "responses",
      enabled: true,
      version: "v1"
    }
  };
}

export function modelProfile(id: string): ModelProfile {
  const profile = modelProfiles()[process.env.MODEL_PROFILE_ID ?? id] ?? modelProfiles()[id];
  if (!profile) throw new Error(`Unknown model profile: ${id}`);
  return profile;
}
