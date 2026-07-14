import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { executeModelOperation, type DirectivePacket, type ProviderAdapter, type PromptPayload } from "../src/providers/modelOperation.js";
import { canonicalModelProfileIds, modelProfiles, type ModelProfile } from "../src/providers/modelProfiles.js";

const profile = (provider: "openai" | "anthropic" | "google" = "openai"): ModelProfile => ({
  id: `${provider}-test-profile`,
  provider,
  model: `${provider}-model`,
  endpoints: { countTokens: "/count", execute: "/execute" },
  apiMode: provider === "anthropic" ? "messages" : provider === "google" ? "generateContent" : "responses",
  enabled: true,
  version: "v1"
});

const payload: PromptPayload = {
  operation: "test_operation",
  instructions: ["Do the thing."],
  input: { value: 1 },
  outputSchema: { type: "object" },
  allowedIds: { capability_ids: ["cap_a"] },
  promptVersion: "prompt.v1",
  schemaVersion: "schema.v1",
  metadata: { purpose: "test" }
};

const directive: DirectivePacket = {
  max_input_tokens: 100,
  max_output_tokens: 20,
  max_requested_tokens: 120,
  rate_limit_tokens_per_minute: 200,
  safety_margin: 0.1,
  if_over_budget: "withhold",
  structured_output_schema: { type: "object" },
  reasoning_config: { type: "disabled" },
  bounded_retry_policy: { max_attempts: 1, retry_on: [] }
};

function adapter(inputTokens = 10): ProviderAdapter & { counts: { count: number; execute: number }; lastRequest?: Record<string, unknown>; operations: string[]; schemas: unknown[] } {
  return {
    provider: "openai",
    counts: { count: 0, execute: 0 },
    operations: [],
    schemas: [],
    serialize(profileArg, payloadArg, directiveArg) {
      this.operations.push(payloadArg.operation);
      this.schemas.push(directiveArg.structured_output_schema ?? null);
      this.lastRequest = { model: profileArg.model, payload: payloadArg, max_output_tokens: directiveArg.max_output_tokens, directive: directiveArg };
      return { url: "/execute", init: { method: "POST" }, body: this.lastRequest };
    },
    async countTokens() {
      this.counts.count += 1;
      return { status: "available", input_tokens: inputTokens, raw: { input_tokens: inputTokens } };
    },
    async execute() {
      this.counts.execute += 1;
      return { ok: true, raw: { output_text: "{}" }, usage: { input_tokens: inputTokens, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } }, completion_state: "completed", error_classification: null };
    }
  };
}

test("all providers can use the same generic executor", async () => {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const fake = adapter();
    fake.provider = provider;
    const result = await executeModelOperation({ profile: profile(provider), payload, directive, mode: "execute", adapterRegistry: { [provider]: fake } as any });
    assert.equal(result.provider, provider);
    assert.equal(result.model, `${provider}-model`);
    assert.equal(fake.counts.execute, 1);
  }
});

test("profile selects provider/model/endpoints while payload stays semantic", async () => {
  const fake = adapter();
  await executeModelOperation({ profile: profile("openai"), payload, directive, mode: "preflight", adapterRegistry: { openai: fake } as any });
  assert.equal(fake.lastRequest?.model, "openai-model");
  assert.equal((fake.lastRequest?.payload as PromptPayload).operation, "test_operation");
  assert.equal(JSON.stringify(fake.lastRequest?.payload).includes("OPENAI_API_KEY"), false);
  assert.deepEqual((fake.lastRequest?.directive as DirectivePacket).structured_output_schema, { type: "object" });
});

test("native token counting happens before execution and preflight never executes", async () => {
  const fake = adapter();
  const result = await executeModelOperation({ profile: profile(), payload, directive, mode: "preflight", adapterRegistry: { openai: fake } as any });
  assert.equal(result.admission_status, "eligible");
  assert.equal(fake.counts.count, 1);
  assert.equal(fake.counts.execute, 0);
});

test("execution is withheld when token counting fails", async () => {
  const fake = adapter();
  fake.countTokens = async () => {
    fake.counts.count += 1;
    return { status: "unavailable", error: "no native count" };
  };
  const result = await executeModelOperation({ profile: profile(), payload, directive, mode: "execute", adapterRegistry: { openai: fake } as any });
  assert.equal(result.admission_status, "withheld");
  assert.equal(result.provider_error_classification, "token_count_unavailable");
  assert.equal(fake.counts.execute, 0);
});

test("directive controls token allocation, exact boundary, and safety margin", async () => {
  const exactBoundary = adapter(100);
  const exact = await executeModelOperation({ profile: profile(), payload, directive, mode: "preflight", adapterRegistry: { openai: exactBoundary } as any, remainingRateBudget: 132 });
  assert.equal(exact.requested_tokens, 120);
  assert.equal(exact.safety_adjusted_requested_tokens, 132);
  assert.equal(exact.admission_status, "eligible");

  const over = await executeModelOperation({ profile: profile(), payload, directive, mode: "execute", adapterRegistry: { openai: adapter(101) } as any });
  assert.equal(over.admission_status, "withheld");
  assert.equal(over.provider_error_classification, "withheld_context_limit");
  assert.equal(over.receipt.execution_status, "withheld_context_limit");
});

test("runtime provenance is returned from profile and adapter usage is normalized", async () => {
  const fake = adapter(10);
  const result = await executeModelOperation({ profile: profile(), payload, directive, mode: "execute", adapterRegistry: { openai: fake } as any });
  assert.equal(result.profile_id, "openai-test-profile");
  assert.equal(result.model, "openai-model");
  assert.equal(result.actual_input_tokens, 10);
  assert.equal(result.actual_output_tokens, 5);
  assert.equal(result.reasoning_tokens, 2);
  assert.deepEqual(result.raw_output, { output_text: "{}" });
});

test("one OpenAI model profile executes validation, cluster validation, failure analysis, and resume operations", async () => {
  const fake = adapter();
  const registry = { openai: fake } as any;
  const profile = modelProfiles()[canonicalModelProfileIds.openai];
  const operations = [
    ["capability_validation", { type: "object", required: ["status"] }, 1000],
    ["cluster_capability_validation", { type: "object", required: ["cluster_id"] }, 800],
    ["failure_analysis", { type: "object", required: ["failure_type"] }, 600],
    ["resume_generation", null, 1200]
  ] as const;

  for (const [operation, schema, maxOutput] of operations) {
    await executeModelOperation({
      profile,
      payload: { operation, instructions: [`Run ${operation}.`], input: { id: operation }, promptVersion: `${operation}.v1`, schemaVersion: "schema.v1" },
      directive: { ...directive, max_output_tokens: maxOutput, max_requested_tokens: 5000, rate_limit_tokens_per_minute: 5000, structured_output_schema: schema },
      mode: "execute",
      adapterRegistry: registry
    });
  }

  assert.equal(new Set(fake.operations).size, 4);
  assert.deepEqual(fake.operations, operations.map(([operation]) => operation));
  assert.equal(fake.counts.execute, 4);
  assert.equal(fake.schemas[0], operations[0][1]);
  assert.equal(fake.schemas[3], null);
});

test("one Gemini model profile executes contextualization, clustering, and repair operations", async () => {
  const fake = adapter();
  fake.provider = "google";
  const registry = { google: fake } as any;
  const profile = modelProfiles()[canonicalModelProfileIds.google];
  const operations = [
    ["contextualize", null],
    ["job_requirement_clustering", { type: "object", required: ["clusters"] }],
    ["job_requirement_cluster_repair", { type: "object", required: ["clusters"] }]
  ] as const;

  for (const [operation, schema] of operations) {
    await executeModelOperation({
      profile,
      payload: { operation, instructions: [`Run ${operation}.`], input: { id: operation }, promptVersion: `${operation}.v1`, schemaVersion: "schema.v1" },
      directive: { ...directive, structured_output_schema: schema },
      mode: "execute",
      adapterRegistry: registry
    });
  }

  assert.deepEqual(fake.operations, operations.map(([operation]) => operation));
  assert.equal(fake.counts.execute, 3);
  assert.equal(fake.schemas[1], operations[1][1]);
});

test("compatibility aliases resolve to canonical profiles and are observable in the receipt", async () => {
  const fake = adapter();
  const result = await executeModelOperation({
    profile: "openai-cluster-validator",
    payload,
    directive,
    mode: "execute",
    adapterRegistry: { openai: fake } as any
  });

  assert.equal(result.profile_id, canonicalModelProfileIds.openai);
  assert.equal(result.receipt.profile_id, canonicalModelProfileIds.openai);
  assert.equal(result.receipt.requested_profile_id, "openai-cluster-validator");
  assert.equal(result.receipt.alias_used, true);
  assert.equal(result.receipt.alias_profile_id, "openai-cluster-validator");
  assert.equal(fake.counts.count, 1);
  assert.equal(fake.counts.execute, 1);
});

test("token admission distinguishes context, operation budget, and rolling rate withholding", async () => {
  const context = await executeModelOperation({
    profile: profile(),
    payload,
    directive: { ...directive, max_context_tokens: 9, max_requested_tokens: 1000, rate_limit_tokens_per_minute: 1000 },
    mode: "execute",
    adapterRegistry: { openai: adapter(10) } as any
  });
  assert.equal(context.receipt.execution_status, "withheld_context_limit");

  const budgetFake = adapter(90);
  const budget = await executeModelOperation({
    profile: profile(),
    payload,
    directive: { ...directive, max_context_tokens: 1000, max_output_tokens: 20, requested_reasoning_tokens: 15, max_requested_tokens: 100, rate_limit_tokens_per_minute: 1000 },
    mode: "execute",
    adapterRegistry: { openai: budgetFake } as any
  });
  assert.equal(budget.receipt.execution_status, "withheld_token_budget");
  assert.equal(budgetFake.counts.execute, 0);

  const rateFake = adapter(50);
  const rate = await executeModelOperation({
    profile: profile(),
    payload,
    directive: { ...directive, max_context_tokens: 1000, max_output_tokens: 20, max_requested_tokens: 1000, safety_margin: 0.25, rate_limit_tokens_per_minute: 80 },
    mode: "execute",
    adapterRegistry: { openai: rateFake } as any
  });
  assert.equal(rate.receipt.execution_status, "withheld_rate_budget");
  assert.equal(rateFake.counts.execute, 0);
});

test("native count failure can withhold or use an explicit fallback estimate", async () => {
  const withheldFake = adapter();
  withheldFake.countTokens = async () => {
    withheldFake.counts.count += 1;
    return { status: "unavailable", error: "native endpoint unavailable" };
  };
  const withheld = await executeModelOperation({ profile: profile(), payload, directive, mode: "execute", adapterRegistry: { openai: withheldFake } as any });
  assert.equal(withheld.receipt.execution_status, "withheld_token_budget");
  assert.equal(withheld.receipt.token_count_source, "unavailable");
  assert.equal(withheld.receipt.estimated_input_tokens, null);
  assert.equal(withheldFake.counts.execute, 0);

  const fallbackFake = adapter();
  fallbackFake.countTokens = async () => {
    fallbackFake.counts.count += 1;
    return { status: "unavailable", error: "native endpoint unavailable" };
  };
  const fallback = await executeModelOperation({
    profile: profile(),
    payload,
    directive: { ...directive, token_count_failure_policy: "use_fallback_estimate", max_context_tokens: 1000, max_requested_tokens: 1000, rate_limit_tokens_per_minute: 1000 },
    mode: "execute",
    adapterRegistry: { openai: fallbackFake } as any
  });
  assert.equal(fallback.receipt.token_count_source, "fallback_estimate");
  assert.equal(typeof fallback.receipt.estimated_input_tokens, "number");
  assert.equal(fallbackFake.counts.execute, 1);
});

test("raw output, usage, and artifact refs survive downstream parser or validation failure", async () => {
  const fake = adapter(12);
  fake.execute = async () => {
    fake.counts.execute += 1;
    return { ok: true, raw: { output_text: "{\"broken\":" }, usage: { input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } }, completion_state: "completed", error_classification: null };
  };
  const result = await executeModelOperation({
    profile: profile(),
    payload,
    directive,
    mode: "execute",
    rawArtifactRef: "outputs/run/raw-provider.json",
    normalizedArtifactRef: "outputs/run/normalized.yaml",
    adapterRegistry: { openai: fake } as any
  });

  assert.deepEqual(result.raw_output, { output_text: "{\"broken\":" });
  assert.equal(result.receipt.raw_artifact_ref, "outputs/run/raw-provider.json");
  assert.equal(result.receipt.normalized_artifact_ref, "outputs/run/normalized.yaml");
  assert.equal(result.receipt.actual_input_tokens, 12);
  assert.equal(result.receipt.output_tokens, 7);
  assert.equal(result.receipt.reasoning_tokens, 3);
});

test("reasoning and visible output tokens remain separate and unavailable values stay null", async () => {
  const fake = adapter(8);
  fake.execute = async () => {
    fake.counts.execute += 1;
    return { ok: true, raw: { output_text: "{}" }, usage: { input_tokens: 8, output_tokens: 4 }, completion_state: "completed", error_classification: null };
  };
  const result = await executeModelOperation({ profile: profile(), payload, directive: { ...directive, requested_reasoning_tokens: 6 }, mode: "execute", adapterRegistry: { openai: fake } as any });

  assert.equal(result.receipt.requested_reasoning_allocation, 6);
  assert.equal(result.receipt.requested_output_allocation, directive.max_output_tokens);
  assert.equal(result.receipt.reasoning_tokens, null);
  assert.equal(result.receipt.output_tokens, 4);
  assert.equal(result.receipt.cost_usd, null);
});

test("canonical model profiles contain only execution configuration", () => {
  const profiles = modelProfiles();
  const canonical = [profiles[canonicalModelProfileIds.google], profiles[canonicalModelProfileIds.anthropic], profiles[canonicalModelProfileIds.openai]];
  const forbidden = /capability|resume|Prophet|applicant|job|cluster|validation/i;
  for (const profile of canonical) {
    assert.equal(forbidden.test(profile.id), false);
    assert.equal(forbidden.test(JSON.stringify(profile.metadata ?? {})), false);
  }

  for (const [id, profile] of Object.entries(profiles).filter(([, candidate]) => candidate.metadata?.compatibility_alias)) {
    assert.equal(typeof profile.metadata?.resolves_to_profile_id, "string", id);
    assert.equal(profile.metadata?.deletion_label, "delete after callers migrate to canonical execution profile IDs");
  }
});

test("executeModelOperation has no Corus-specific vocabulary or branching", async () => {
  const source = await fs.readFile("src/providers/modelOperation.ts", "utf8");
  assert.doesNotMatch(source, /Corus|Prophet|applicant|resume_generation|capability_reduction|capability_validation|cluster_capability_validation|job_requirement|failure_analysis/i);
});
