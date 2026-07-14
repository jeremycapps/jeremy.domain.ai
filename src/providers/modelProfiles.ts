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

export const canonicalModelProfileIds = {
  google: "gemini-3.1-flash-lite",
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.5-pro"
} as const;

export function configuredModelIds() {
  return {
    google: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
    anthropic: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
    openai: process.env.OPENAI_MODEL ?? "gpt-4.1-mini"
  };
}

function baseModelProfiles(): Record<string, ModelProfile> {
  const models = configuredModelIds();
  return {
    [canonicalModelProfileIds.google]: {
      id: canonicalModelProfileIds.google,
      provider: "google",
      model: models.google,
      endpoints: { countTokens: ":countTokens", execute: ":generateContent" },
      apiMode: "generateContent",
      enabled: true,
      version: "v1",
      metadata: { supported_execution_capabilities: ["json_response", "structured_response_schema", "native_token_count"] }
    },
    [canonicalModelProfileIds.anthropic]: {
      id: canonicalModelProfileIds.anthropic,
      provider: "anthropic",
      model: models.anthropic,
      endpoints: { countTokens: "/v1/messages/count_tokens", execute: "/v1/messages" },
      apiMode: "messages",
      enabled: true,
      version: "v1",
      metadata: { supported_execution_capabilities: ["messages", "json_schema_output_config", "native_token_count"] }
    },
    [canonicalModelProfileIds.openai]: {
      id: canonicalModelProfileIds.openai,
      provider: "openai",
      model: models.openai,
      endpoints: { countTokens: "/v1/responses/input_tokens", execute: "/v1/responses" },
      apiMode: "responses",
      enabled: true,
      version: "v1",
      metadata: { supported_execution_capabilities: ["responses", "text_response", "native_token_count"] }
    }
  };
}

function compatibilityAlias(id: string, target: ModelProfile): ModelProfile {
  return {
    ...target,
    id,
    metadata: {
      ...target.metadata,
      compatibility_alias: true,
      resolves_to_profile_id: target.id,
      deletion_label: "delete after callers migrate to canonical execution profile IDs"
    }
  };
}

export function modelProfiles(): Record<string, ModelProfile> {
  const profiles = baseModelProfiles();
  return {
    ...profiles,
    "google-contextualizer": compatibilityAlias("google-contextualizer", profiles[canonicalModelProfileIds.google]),
    "google-job-requirement-clusterer": compatibilityAlias("google-job-requirement-clusterer", profiles[canonicalModelProfileIds.google]),
    "google-job-requirement-cluster-repairer": compatibilityAlias("google-job-requirement-cluster-repairer", profiles[canonicalModelProfileIds.google]),
    "anthropic-capability-reducer": compatibilityAlias("anthropic-capability-reducer", profiles[canonicalModelProfileIds.anthropic]),
    "openai-capability-validator": compatibilityAlias("openai-capability-validator", profiles[canonicalModelProfileIds.openai]),
    "openai-failure-analyzer": compatibilityAlias("openai-failure-analyzer", profiles[canonicalModelProfileIds.openai]),
    "openai-resume-generator": compatibilityAlias("openai-resume-generator", profiles[canonicalModelProfileIds.openai]),
    "openai-cluster-validator": compatibilityAlias("openai-cluster-validator", profiles[canonicalModelProfileIds.openai])
  };
}

export interface ResolvedModelProfile {
  profile: ModelProfile;
  requested_profile_id: string;
  alias_used: boolean;
  alias_profile_id: string | null;
}

export function resolveModelProfile(profileOrId: ModelProfile | string): ResolvedModelProfile {
  const requested = typeof profileOrId === "string" ? profileOrId : profileOrId.id;
  const profiles = modelProfiles();
  const selected = typeof profileOrId === "string" ? profiles[process.env.MODEL_PROFILE_ID ?? profileOrId] ?? profiles[profileOrId] : profileOrId;
  if (!selected) throw new Error(`Unknown model profile: ${requested}`);
  const targetId = typeof selected.metadata?.resolves_to_profile_id === "string" ? selected.metadata.resolves_to_profile_id : selected.id;
  const target = profiles[targetId] ?? selected;
  if (!target) throw new Error(`Unknown resolved model profile: ${targetId}`);
  return {
    profile: target,
    requested_profile_id: requested,
    alias_used: selected.id !== target.id || selected.metadata?.compatibility_alias === true,
    alias_profile_id: selected.id !== target.id || selected.metadata?.compatibility_alias === true ? selected.id : null
  };
}

export function modelProfile(id: string): ModelProfile {
  return resolveModelProfile(id).profile;
}
