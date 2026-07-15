import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { executeModelOperation, providerAdapters, type CanonicalInput, type DataEgressDecision, type DirectivePacket, type GenerationConfig, type ProviderAdapter, type PromptPayload } from "../src/providers/modelOperation.js";
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

function contentOperation(input: CanonicalInput): string {
  const content = input.content as { operation?: unknown };
  return typeof content.operation === "string" ? content.operation : "unknown";
}

function adapter(inputTokens = 10): ProviderAdapter & { counts: { count: number; execute: number }; lastRequest?: Record<string, unknown>; lastCountInput?: CanonicalInput; lastGeneration?: GenerationConfig; operations: string[]; schemas: unknown[] } {
  return {
    provider: "openai",
    counts: { count: 0, execute: 0 },
    operations: [],
    schemas: [],
    async count({ input }) {
      this.counts.count += 1;
      this.lastCountInput = input;
      this.operations.push(contentOperation(input));
      this.schemas.push(input.output_contract?.schema ?? null);
      return { status: "available", input_tokens: inputTokens, raw: { input_tokens: inputTokens }, native_request: { input } };
    },
    async generate({ profile: profileArg, input, generation }) {
      this.counts.execute += 1;
      this.lastGeneration = generation;
      this.lastRequest = { model: profileArg.model, input, generation };
      return { ok: true, raw: { output_text: "{}", usage: { input_tokens: inputTokens, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } }, status: "completed" }, native_request: this.lastRequest };
    },
    normalize({ raw }) {
      const data = raw.raw as { usage?: unknown; status?: string };
      return { ok: raw.ok, usage: data.usage, completion_state: data.status ?? "completed", error_classification: raw.ok ? null : "provider_error" };
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
  assert.equal(contentOperation(fake.lastCountInput as CanonicalInput), "test_operation");
  assert.equal(JSON.stringify(fake.lastCountInput).includes("OPENAI_API_KEY"), false);
  assert.deepEqual(fake.lastCountInput?.output_contract?.schema, { type: "object" });
});

test("OpenAI count receives schema-bearing input without generation controls", async () => {
  const requests: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    process.env.OPENAI_API_KEY = "test-key";
    await executeModelOperation({ profile: profile("openai"), payload, directive, mode: "preflight" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }

  const format = (requests[0]?.text as { format?: unknown } | undefined)?.format as Record<string, unknown> | undefined;
  assert.equal(format?.type, "json_schema");
  assert.equal(format?.name, "structured_output");
  assert.deepEqual(format?.schema, directive.structured_output_schema);
  assert.equal("max_output_tokens" in requests[0], false);
  assert.equal("max_tokens" in requests[0], false);
  assert.equal("generationConfig" in requests[0], false);
});

test("OpenAI generation receives configured generated-token ceiling", async () => {
  const requests: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if ("max_output_tokens" in body) {
      return new Response(JSON.stringify({ status: "completed", output_text: "{}", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    process.env.OPENAI_API_KEY = "test-key";
    await executeModelOperation({ profile: profile("openai"), payload, directive, mode: "execute" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }

  assert.equal(requests.length, 2);
  assert.equal("max_output_tokens" in requests[0], false);
  assert.equal(requests[1]?.max_output_tokens, directive.max_output_tokens);
});

test("all real providers satisfy the same count generate normalize interface", () => {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    assert.equal(typeof providerAdapters[provider].count, "function");
    assert.equal(typeof providerAdapters[provider].generate, "function");
    assert.equal(typeof providerAdapters[provider].normalize, "function");
  }
});

test("Anthropic count omits generation controls while generation receives max_tokens", async () => {
  const requests: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if ("max_tokens" in body) {
      return new Response(JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    process.env.ANTHROPIC_API_KEY = "test-key";
    await executeModelOperation({ profile: profile("anthropic"), payload, directive, mode: "execute" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }

  assert.equal(requests.length, 2);
  assert.equal("max_tokens" in requests[0], false);
  assert.equal("thinking" in requests[0], false);
  assert.equal(requests[1]?.max_tokens, directive.max_output_tokens);
  assert.match(JSON.stringify(requests[0]), /Do the thing/);
  assert.match(JSON.stringify(requests[0]), /output_contract/);
});

test("Gemini count omits generation controls while generation receives maxOutputTokens", async () => {
  const requests: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if ("generationConfig" in body) {
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ totalTokens: 10 }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    process.env.GEMINI_API_KEY = "test-key";
    await executeModelOperation({ profile: profile("google"), payload, directive, mode: "execute" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }

  assert.equal(requests.length, 2);
  assert.equal("generationConfig" in requests[0], false);
  assert.equal((requests[1]?.generationConfig as Record<string, unknown>).maxOutputTokens, directive.max_output_tokens);
  assert.match(JSON.stringify(requests[0]), /Do the thing/);
  assert.match(JSON.stringify(requests[0]), /output_contract/);
});

test("generation config cannot leak into count through object spreading", async () => {
  const fake = adapter();
  await executeModelOperation({
    profile: profile(),
    payload,
    directive: { ...directive, reasoning_config: { effort: "low" }, execution_overrides: { temperature: 0.2, stream: false } },
    mode: "execute",
    adapterRegistry: { openai: fake } as any
  });

  assert.equal(JSON.stringify(fake.lastCountInput).includes("max_generated_tokens"), false);
  assert.equal(JSON.stringify(fake.lastCountInput).includes("reasoning_effort"), false);
  assert.equal(fake.lastGeneration?.max_generated_tokens, directive.max_output_tokens);
  assert.equal(fake.lastGeneration?.reasoning_effort, "low");
});

test("native token counting happens before execution and preflight never executes", async () => {
  const fake = adapter();
  const result = await executeModelOperation({ profile: profile(), payload, directive, mode: "preflight", adapterRegistry: { openai: fake } as any });
  assert.equal(result.admission_status, "eligible");
  assert.equal(fake.counts.count, 1);
  assert.equal(fake.counts.execute, 0);
});

test("private and restricted payloads are withheld before token counting", async () => {
  for (const classification of ["private", "restricted"] as const) {
    const fake = adapter();
    const dataEgress: DataEgressDecision = {
      status: "withheld",
      classification,
      purpose: "model_execution_boundary_smoke",
      reason: `${classification} payloads are not permitted for this operation.`
    };

    const result = await executeModelOperation({ profile: profile(), payload, directive, mode: "execute", dataEgress, adapterRegistry: { openai: fake } as any });

    assert.equal(result.receipt.execution_status, "withheld_data_egress");
    assert.equal(result.provider_error_classification, "data_egress_withheld");
    assert.equal(result.receipt.data_egress?.classification, classification);
    assert.equal(fake.counts.count, 0);
    assert.equal(fake.counts.execute, 0);
    assert.equal(fake.lastCountInput, undefined);
    assert.equal(fake.lastRequest, undefined);
  }
});

test("an admitted synthetic payload proceeds to token admission", async () => {
  const fake = adapter();
  const dataEgress: DataEgressDecision = {
    status: "permitted",
    classification: "synthetic",
    purpose: "model_execution_boundary_smoke",
    reason: "Synthetic fixture manifest permits this boundary smoke."
  };

  const result = await executeModelOperation({ profile: profile(), payload, directive, mode: "preflight", dataEgress, adapterRegistry: { openai: fake } as any });

  assert.equal(result.admission_status, "eligible");
  assert.equal(result.receipt.data_egress?.status, "permitted");
  assert.equal(result.receipt.data_egress?.classification, "synthetic");
  assert.equal(fake.counts.count, 1);
  assert.equal(fake.counts.execute, 0);
});

test("data-egress withholding and token withholding stay distinct in the receipt", async () => {
  const egressFake = adapter();
  const dataEgress: DataEgressDecision = {
    status: "withheld",
    classification: "private",
    purpose: "model_execution_boundary_smoke",
    reason: "Private payload withheld before provider preflight."
  };
  const egress = await executeModelOperation({ profile: profile(), payload, directive, dataEgress, mode: "execute", adapterRegistry: { openai: egressFake } as any });
  assert.equal(egress.receipt.execution_status, "withheld_data_egress");
  assert.equal(egress.receipt.token_count_source, "unavailable");
  assert.equal(egressFake.counts.count, 0);
  assert.equal(egressFake.counts.execute, 0);

  const tokenFake = adapter(101);
  const token = await executeModelOperation({
    profile: profile(),
    payload,
    directive,
    dataEgress: { status: "permitted", classification: "synthetic", purpose: "model_execution_boundary_smoke", reason: "Synthetic fixture permitted." },
    mode: "execute",
    adapterRegistry: { openai: tokenFake } as any
  });
  assert.equal(token.receipt.execution_status, "withheld_context_limit");
  assert.equal(token.receipt.data_egress?.status, "permitted");
  assert.equal(tokenFake.counts.count, 1);
  assert.equal(tokenFake.counts.execute, 0);
});

test("execution is withheld when token counting fails", async () => {
  const fake = adapter();
  fake.count = async () => {
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
  assert.equal((result.raw_output as { output_text?: unknown }).output_text, "{}");
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
  withheldFake.count = async () => {
    withheldFake.counts.count += 1;
    return { status: "unavailable", error: "native endpoint unavailable" };
  };
  const withheld = await executeModelOperation({ profile: profile(), payload, directive, mode: "execute", adapterRegistry: { openai: withheldFake } as any });
  assert.equal(withheld.receipt.execution_status, "withheld_token_budget");
  assert.equal(withheld.receipt.token_count_source, "unavailable");
  assert.equal(withheld.receipt.estimated_input_tokens, null);
  assert.equal(withheldFake.counts.execute, 0);

  const fallbackFake = adapter();
  fallbackFake.count = async () => {
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
  fake.generate = async () => {
    fake.counts.execute += 1;
    return { ok: true, raw: { output_text: "{\"broken\":", usage: { input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } }, status: "completed" } };
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

  assert.equal((result.raw_output as { output_text?: unknown }).output_text, "{\"broken\":");
  assert.equal(result.receipt.raw_artifact_ref, "outputs/run/raw-provider.json");
  assert.equal(result.receipt.normalized_artifact_ref, "outputs/run/normalized.yaml");
  assert.equal(result.receipt.actual_input_tokens, 12);
  assert.equal(result.receipt.output_tokens, 7);
  assert.equal(result.receipt.reasoning_tokens, 3);
});

test("reasoning and visible output tokens remain separate and unavailable values stay null", async () => {
  const fake = adapter(8);
  fake.generate = async () => {
    fake.counts.execute += 1;
    return { ok: true, raw: { output_text: "{}", usage: { input_tokens: 8, output_tokens: 4 }, status: "completed" } };
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
