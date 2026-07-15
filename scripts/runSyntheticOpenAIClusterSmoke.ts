import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { defaultDirectivePacket, executeModelOperation, modelOperationRecord, type DataEgressDecision, type PromptPayload } from "../src/providers/modelOperation.js";
import { canonicalModelProfileIds, modelProfile } from "../src/providers/modelProfiles.js";
import { parseJsonObject, textFromOpenAIResponse } from "../src/providers/providerUtils.js";
import { normalizeClusterValidationOutput, validateClusterValidationOutput, validateClusterValidationPacket, type ClusterValidationPacket } from "../src/lib/prophetClusterScopedValidation.js";
import { getProjectRoot } from "../src/lib/paths.js";

type SmokeFixture = {
  schema_version: string;
  manifest_ref: string;
  cluster: { id: string; label: string; requirement_refs: string[] };
  requirements: unknown[];
  evidence_contexts: unknown[];
  capabilities: ClusterValidationPacket["capabilities"];
  evidence_policy: ClusterValidationPacket["evidence_policy"];
  generation_provenance: ClusterValidationPacket["generation_provenance"];
  prompt: { operation: string; prompt_version: string; schema_version: string; instructions: string[] };
  output_schema: unknown;
};

function assertSyntheticManifest(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Synthetic smoke manifest is missing.");
  const manifest = value as Record<string, unknown>;
  const required = {
    source: "synthetic",
    contains_personal_data: false,
    contains_private_employer_data: false,
    derived_from_prophet_artifacts: false,
    safe_for_external_provider_test: true,
    approved_purpose: "model_execution_boundary_smoke",
    classification: "synthetic"
  };
  for (const [key, expected] of Object.entries(required)) {
    if (manifest[key] !== expected) throw new Error(`Synthetic smoke manifest failed ${key}.`);
  }
}

async function writeYaml(file: string, value: unknown) {
  await fs.writeFile(file, stringify(value), "utf8");
}

async function main() {
  const root = getProjectRoot();
  const fixturePath = path.join(root, "test/fixtures/synthetic/openai_cluster_validation_smoke.yaml");
  const fixture = parse(await fs.readFile(fixturePath, "utf8")) as SmokeFixture;
  const manifestPath = path.join(root, fixture.manifest_ref);
  const manifest = parse(await fs.readFile(manifestPath, "utf8"));
  assertSyntheticManifest(manifest);

  const runId = `synthetic-openai-cluster-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = path.join(root, "outputs", "synthetic-openai-cluster-smoke", runId);
  await fs.mkdir(outputDir, { recursive: true });

  const packet: ClusterValidationPacket = {
    schema_version: "corus.openai_cluster_validation_packet.v1",
    run_id: runId,
    cluster_id: fixture.cluster.id,
    cluster_label: fixture.cluster.label,
    requirements: fixture.requirements,
    capabilities: fixture.capabilities,
    evidence_contexts: fixture.evidence_contexts,
    evidence_policy: fixture.evidence_policy,
    generation_provenance: fixture.generation_provenance
  };
  const packetValidation = validateClusterValidationPacket(packet, fixture.cluster, {
    permitted_evidence_context_ids: fixture.evidence_policy.permitted_evidence_context_ids,
    unresolved_context_ids: fixture.evidence_policy.unresolved_context_ids,
    support_ceilings: fixture.evidence_policy.support_ceilings
  });
  if (packetValidation.status !== "completed_valid_output") throw new Error(`Synthetic packet failed deterministic preflight: ${packetValidation.errors.join("; ")}`);

  const prompt: PromptPayload = {
    operation: fixture.prompt.operation,
    instructions: fixture.prompt.instructions,
    input: packet,
    outputSchema: fixture.output_schema,
    allowedIds: {
      capability_ids: fixture.evidence_policy.allowed_capability_ids,
      requirement_ids: fixture.evidence_policy.allowed_requirement_ids,
      evidence_ids: fixture.evidence_policy.allowed_evidence_ids
    },
    promptVersion: fixture.prompt.prompt_version,
    schemaVersion: fixture.prompt.schema_version,
    metadata: { fixture_source: "synthetic", run_id: runId }
  };
  const directive = {
    ...defaultDirectivePacket,
    max_output_tokens: 4000,
    max_requested_tokens: 45000,
    rate_limit_tokens_per_minute: 45000,
    safety_margin: 0,
    token_count_failure_policy: "withhold" as const,
    reasoning_config: { effort: "low" },
    execution_overrides: { reasoning: { effort: "low" } },
    structured_output_schema: fixture.output_schema,
    bounded_retry_policy: { max_attempts: 0, retry_on: [] },
    directive_version: "synthetic.openai.cluster-smoke.v1"
  };
  const dataEgress: DataEgressDecision = {
    status: "permitted",
    classification: "synthetic",
    purpose: "model_execution_boundary_smoke",
    reason: "Synthetic manifest permits this external provider boundary smoke."
  };

  await writeYaml(path.join(outputDir, "00-fixture-manifest.yaml"), manifest);
  await writeYaml(path.join(outputDir, "01-validation-packet.yaml"), packet);

  const profile = modelProfile(canonicalModelProfileIds.openai);
  const result = await executeModelOperation({
    profile,
    prompt,
    payload: prompt.input,
    directive,
    mode: "execute",
    remainingRateBudget: 45000,
    dataEgress,
    rawArtifactRef: path.join(outputDir, "raw-04-openai-response.json"),
    normalizedArtifactRef: path.join(outputDir, "05-normalized-openai-result.yaml")
  });

  await writeYaml(path.join(outputDir, "02-token-count-record.yaml"), {
    token_count: result.token_count,
    native_input_tokens: result.exact_input_tokens,
    max_generated_tokens: directive.max_output_tokens,
    estimated_total: result.requested_tokens,
    requested_reasoning_effort: "low",
    requested_reasoning_allocation: null,
    rate_limit: directive.rate_limit_tokens_per_minute,
    safety_ceiling: 45000
  });
  await writeYaml(path.join(outputDir, "03-token-admission-decision.yaml"), {
    data_egress: result.receipt.data_egress,
    admission_status: result.admission_status,
    execution_status: result.receipt.execution_status,
    error_classification: result.provider_error_classification,
    stop_reason: result.completion_state
  });
  await writeYaml(path.join(outputDir, "07-execution-receipt.yaml"), modelOperationRecord(result));

  let normalized = null;
  let deterministic = null;
  let structuredOutputValid = false;
  let deterministicValidationReached = false;
  if (result.raw_output !== null) {
    await fs.writeFile(path.join(outputDir, "raw-04-openai-response.json"), `${JSON.stringify(result.raw_output, null, 2)}\n`, "utf8");
    try {
      normalized = normalizeClusterValidationOutput(parseJsonObject(textFromOpenAIResponse(result.raw_output)));
      structuredOutputValid = true;
      await writeYaml(path.join(outputDir, "05-normalized-openai-result.yaml"), normalized);
      deterministic = validateClusterValidationOutput(normalized, packet);
      deterministicValidationReached = true;
      await writeYaml(path.join(outputDir, "06-deterministic-validation.yaml"), deterministic);
    } catch (error) {
      await writeYaml(path.join(outputDir, "06-deterministic-validation.yaml"), {
        status: "not_reached_or_failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const checkpoint = {
    schema_version: "synthetic.openai_cluster_smoke_checkpoint.v1",
    status: result.admission_status === "withheld" ? "withheld" : deterministic && deterministic.status === "completed_valid_output" ? "completed_valid_output" : "completed_with_validation_issue",
    run_id: runId,
    cluster: fixture.cluster.id,
    profile: profile.id,
    compatibility_alias_used: result.alias_used,
    data_egress: result.receipt.data_egress,
    token_preflight: {
      native_input_tokens: result.exact_input_tokens,
      max_generated_tokens: directive.max_output_tokens,
      estimated_total: result.requested_tokens,
      admission_status: result.admission_status
    },
    provider_calls: {
      openai_token_count: result.receipt.execution_status === "withheld_data_egress" ? 0 : 1,
      openai_generation: result.raw_output === null ? 0 : 1,
      gemini: 0,
      anthropic: 0
    },
    execution: {
      status: result.receipt.execution_status,
      stop_reason: result.completion_state,
      raw_response_preserved: result.raw_output !== null,
      assistant_output_present: structuredOutputValid,
      structured_output_valid: structuredOutputValid,
      deterministic_validation_reached: deterministicValidationReached
    },
    usage: {
      input_tokens: result.actual_input_tokens,
      reasoning_tokens: result.reasoning_tokens,
      visible_output_tokens: result.output_tokens !== null && result.reasoning_tokens !== null ? Math.max(result.output_tokens - result.reasoning_tokens, 0) : null,
      total_output_tokens: result.output_tokens,
      total_tokens: result.total_tokens,
      latency_ms: result.latency_ms
    },
    artifacts: {
      output_dir: path.relative(root, outputDir),
      manifest: path.relative(root, path.join(outputDir, "00-fixture-manifest.yaml")),
      packet: path.relative(root, path.join(outputDir, "01-validation-packet.yaml")),
      token_count: path.relative(root, path.join(outputDir, "02-token-count-record.yaml")),
      admission: path.relative(root, path.join(outputDir, "03-token-admission-decision.yaml")),
      raw_response: result.raw_output === null ? null : path.relative(root, path.join(outputDir, "raw-04-openai-response.json")),
      normalized: normalized === null ? null : path.relative(root, path.join(outputDir, "05-normalized-openai-result.yaml")),
      deterministic: path.relative(root, path.join(outputDir, "06-deterministic-validation.yaml")),
      receipt: path.relative(root, path.join(outputDir, "07-execution-receipt.yaml")),
      checkpoint: path.relative(root, path.join(outputDir, "08-final-checkpoint.yaml"))
    }
  };
  await writeYaml(path.join(outputDir, "08-final-checkpoint.yaml"), checkpoint);
  console.log(JSON.stringify(checkpoint, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
