# Model Operation Migration Inventory

Directive: provider-neutral model-operation refactor before resuming OpenAI cluster validation.

## Provider-Specific Classes

- `GeminiContextualizationProvider`
- `GeminiJobRequirementClusteringProvider`
- `GeminiJobRequirementClusterRepairProvider`
- `AnthropicCapabilityReductionProvider`
- `OpenAIValidationProvider`
- `OpenAIFailureAnalysisProvider`
- `OpenAIAdapter`
- `AnthropicAdapter`
- `GoogleAdapter`

## Hardcoded Model ID Sources

- Active live model defaults now live in `src/providers/modelProfiles.ts` through `configuredModelIds()`.
- Product code references profile IDs for live execution:
  - `google-contextualizer`
  - `google-job-requirement-clusterer`
  - `google-job-requirement-cluster-repairer`
  - `anthropic-capability-reducer`
  - `openai-capability-validator`
  - `openai-failure-analyzer`
  - `openai-resume-generator`
  - `openai-cluster-validator`
- Remaining model string references are mock, fixture, deterministic, readiness, or test assertions.

## Execution Endpoints

- OpenAI Responses execution: `ModelProfile.endpoints.execute = /v1/responses`
- Anthropic Messages execution: `ModelProfile.endpoints.execute = /v1/messages`
- Google Gemini execution: `ModelProfile.endpoints.execute = :generateContent`
- Remaining direct provider endpoint calls are readiness/model-availability checks, not model-operation execution.

## Token Counting And Estimates

- Native token count operations now live behind provider adapters:
  - OpenAI: `ModelProfile.endpoints.countTokens = /v1/responses/input_tokens`
  - Anthropic: `ModelProfile.endpoints.countTokens = /v1/messages/count_tokens`
  - Google: `ModelProfile.endpoints.countTokens = :countTokens`
- `executeModelOperation` withholds execution when token counting is unavailable.
- No BPE or character-count fallback was added to the model-operation boundary.
- Existing cluster packet sizing remains deterministic packet preflight outside provider execution.

## Token Allocation

- Shared token admission is controlled by `DirectivePacket`.
- Capability reduction scopes `max_output_tokens` through its operation-specific directive.
- OpenAI cluster validation scopes its prior cluster token envelope through its operation-specific directive.
- Other migrated operations use `defaultDirectivePacket`.

## Rate-Limit Checks

- Shared admission uses `rate_limit_tokens_per_minute`, `safety_margin`, and optional `remainingRateBudget`.
- Existing cluster-scoped validation keeps its rolling eligibility gate before invoking the model operation.

## Direct Provider Calls

Migrated through `executeModelOperation`:

- Gemini contextualization
- Gemini job-requirement clustering
- Gemini job-requirement cluster repair
- Anthropic capability reduction
- OpenAI capability validation
- OpenAI failure analysis
- OpenAI resume generation
- OpenAI cluster-scoped validation

Remaining direct provider calls:

- `checkConfiguredModels()` model-list readiness checks for Gemini, Anthropic, and OpenAI.
- GitHub repository evidence resolution uses repository access, not a model provider.

## Duplicated Handling Removed Or Centralized

- Provider request serialization moved to provider adapters.
- Provider token counting moved to provider adapters.
- Usage and latency normalization moved to `providerMetricsFromModelOperation`.
- Model profile IDs, versions, model IDs, API modes, and endpoints moved to the profile registry.
- Token admission, withholding, and preflight execution moved to `executeModelOperation`.

## Persistence Boundary

Generation records can now include compact `model_operation` metadata:

- profile ID and version
- prompt operation and prompt/schema versions
- directive packet
- token-count result
- admission decision
- normalized token usage, latency, completion state, and provider error classification

The compact record intentionally excludes credentials, secret headers, native request bodies, and raw provider output content.
