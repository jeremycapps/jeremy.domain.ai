import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CapabilityCandidate, CapabilityReduction, Context, ProviderMetrics, StageGenerationRecord } from "../types.js";
import { ProviderConfigurationError, ProviderExecutionError } from "../providers/errors.js";
import { defaultDirectivePacket, executeModelOperation, modelOperationRecord, providerMetricsFromModelOperation, type PromptPayload } from "../providers/modelOperation.js";
import { canonicalModelProfileIds, modelProfile } from "../providers/modelProfiles.js";
import { parseJsonObject, textFromOpenAIResponse } from "../providers/providerUtils.js";
import { artifactRef, stageRecord, writeGenerationRecords, writeJsonArtifact } from "./corusArtifacts.js";
import { getProjectRoot } from "./paths.js";

const validationClusterOrder = [
  "product_delivery_and_execution",
  "technical_product_fluency",
  "ai_platform_and_lifecycle_management",
  "ai_evaluation_and_quality_assurance",
  "strategic_product_design",
  "governance_and_enterprise_integration",
  "adoption_communication_and_stakeholder_management",
  "product_sense_and_user_experience",
  "client_delivery_and_productionization"
] as const;

export const clusterScopedValidationClusters = [...validationClusterOrder];

type ClusterValidationStatus = "passed" | "revise" | "architect_required" | "failed";

interface EvidenceBoundaryAdmission {
  permitted_evidence_context_ids: string[];
  unresolved_context_ids: string[];
  support_ceilings: Array<{ context_ref: string; support_ceiling_when_used_alone: "adjacent"; rule: string; evidence_status: string; permitted_scope?: string; excluded_scope?: string[] }>;
}

interface AdmittedClusters {
  clusters: Array<{ id: string; label: string; requirement_refs: string[] }>;
  downstream_policy: { capability_derivation: { include: string[]; exclude: string[] } };
}

export interface ClusterValidationPacket {
  schema_version: "corus.openai_cluster_validation_packet.v1";
  run_id: string;
  cluster_id: string;
  cluster_label: string;
  requirements: unknown[];
  capabilities: CapabilityCandidate[];
  evidence_contexts: unknown[];
  evidence_policy: {
    permitted_evidence_context_ids: string[];
    unresolved_context_ids: string[];
    support_ceilings: EvidenceBoundaryAdmission["support_ceilings"];
    allowed_capability_ids: string[];
    allowed_requirement_ids: string[];
    allowed_evidence_ids: string[];
  };
  generation_provenance: Array<{ capability_id: string; provider: string; model: string; prompt_version: string }>;
}

export interface ClusterValidationOutput {
  cluster_id: string;
  status: ClusterValidationStatus;
  validated_capability_ids: string[];
  rejected_capability_ids: string[];
  author_review_capability_ids: string[];
  findings: Array<{ capability_id?: string; requirement_ref?: string; evidence_ref?: string; severity?: string; type?: string; message: string }>;
  proposed_support_corrections: Array<{ capability_id: string; from: string; to: string; rationale: string }>;
  evidence_reference_findings: Array<{ capability_id: string; evidence_ref?: string; message: string }>;
  unsupported_claim_findings: Array<{ capability_id: string; message: string }>;
}

export interface ClusterValidationDeterministicResult {
  status: "completed_valid_output" | "structurally_invalid";
  cluster_id: string;
  errors: string[];
  accounted_capability_ids: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readYaml<T>(file: string): Promise<T> {
  return parse(await fs.readFile(file, "utf8")) as T;
}

function contextEntries(context: Context): unknown[] {
  return Array.isArray(context.content.contexts) ? context.content.contexts : [];
}

function entryId(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.id === "string" ? entry.id : null;
}

function filterEntriesById(entries: unknown[], ids: Set<string>): unknown[] {
  return entries.filter((entry) => {
    const id = entryId(entry);
    return id ? ids.has(id) : false;
  });
}

export function estimateValidationPacketTokens(packet: unknown, requestedOutputTokens = 2000): { estimated_input_tokens: number; requested_output_tokens: number; estimated_total_requested_tokens: number } {
  const estimated_input_tokens = Math.ceil(JSON.stringify(packet).length / 4);
  return { estimated_input_tokens, requested_output_tokens: requestedOutputTokens, estimated_total_requested_tokens: estimated_input_tokens + requestedOutputTokens };
}

export function validationPacketTokenEligibility(packet: unknown, rollingTokensBefore: number, rollingTpmBudget = 45000, requestedOutputTokens = 2000) {
  const estimate = estimateValidationPacketTokens(packet, requestedOutputTokens);
  return {
    ...estimate,
    rolling_tpm_budget: rollingTpmBudget,
    rolling_estimated_tokens_before: rollingTokensBefore,
    rolling_estimated_tokens_after: rollingTokensBefore + estimate.estimated_total_requested_tokens,
    individually_eligible: estimate.estimated_total_requested_tokens <= rollingTpmBudget,
    rolling_eligible: rollingTokensBefore + estimate.estimated_total_requested_tokens <= rollingTpmBudget
  };
}

function filteredReductionCandidates(runDir: string, clusterId: string): string[] {
  return [
    path.join(runDir, `33-filtered_attempt_1-provenance-corrected-normalized-output-${clusterId}.yaml`),
    path.join(runDir, `33-filtered_attempt_1-normalized-output-${clusterId}-attempt-2.yaml`),
    path.join(runDir, `33-filtered_attempt_1-normalized-output-${clusterId}.yaml`)
  ];
}

async function readClusterReduction(runDir: string, clusterId: string): Promise<{ reduction: CapabilityReduction; source_path: string }> {
  for (const file of filteredReductionCandidates(runDir, clusterId)) {
    try {
      return { reduction: await readYaml<CapabilityReduction>(file), source_path: file };
    } catch {}
  }
  throw new Error(`Missing filtered Claude output for ${clusterId}.`);
}

async function readClusterGenerationRecord(runDir: string, clusterId: string): Promise<StageGenerationRecord> {
  const candidates = [
    path.join(runDir, `33-filtered_attempt_1-generation-record-${clusterId}-attempt-2.json`),
    path.join(runDir, `33-filtered_attempt_1-generation-record-${clusterId}.json`)
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as StageGenerationRecord;
    } catch {}
  }
  throw new Error(`Missing generation record for ${clusterId}.`);
}

export function buildClusterValidationPacket(input: {
  runId: string;
  cluster: { id: string; label: string; requirement_refs: string[] };
  targetContext: Context;
  subjectContext: Context;
  reduction: CapabilityReduction;
  generationRecord: Pick<StageGenerationRecord, "provider" | "model" | "prompt_version">;
  admission: EvidenceBoundaryAdmission;
}): ClusterValidationPacket {
  const capabilityIds = input.reduction.capabilities.map((capability) => capability.id);
  const requirementIds = new Set(input.cluster.requirement_refs);
  const evidenceIds = new Set(input.reduction.capabilities.flatMap((capability) => capability.evidence_refs));
  const requirements = filterEntriesById(contextEntries(input.targetContext), requirementIds);
  const evidence_contexts = filterEntriesById(contextEntries(input.subjectContext), evidenceIds);
  return {
    schema_version: "corus.openai_cluster_validation_packet.v1",
    run_id: input.runId,
    cluster_id: input.cluster.id,
    cluster_label: input.cluster.label,
    requirements,
    capabilities: input.reduction.capabilities,
    evidence_contexts,
    evidence_policy: {
      permitted_evidence_context_ids: input.admission.permitted_evidence_context_ids,
      unresolved_context_ids: input.admission.unresolved_context_ids,
      support_ceilings: input.admission.support_ceilings,
      allowed_capability_ids: capabilityIds,
      allowed_requirement_ids: input.cluster.requirement_refs,
      allowed_evidence_ids: [...evidenceIds].sort()
    },
    generation_provenance: input.reduction.capabilities.map((capability) => ({
      capability_id: capability.id,
      provider: input.generationRecord.provider,
      model: input.generationRecord.model,
      prompt_version: input.generationRecord.prompt_version
    }))
  };
}

export function validateClusterValidationPacket(packet: ClusterValidationPacket, cluster: { id: string; requirement_refs: string[] }, admission: EvidenceBoundaryAdmission): ClusterValidationDeterministicResult {
  const errors: string[] = [];
  const requirementIds = new Set(cluster.requirement_refs);
  const packetRequirementIds = new Set(packet.requirements.map(entryId).filter((id): id is string => Boolean(id)));
  const evidenceIds = new Set(packet.evidence_contexts.map(entryId).filter((id): id is string => Boolean(id)));
  const permitted = new Set(admission.permitted_evidence_context_ids);
  const unresolved = new Set(admission.unresolved_context_ids);
  if (packet.cluster_id !== cluster.id) errors.push("cluster_id does not match admitted cluster.");
  for (const id of requirementIds) if (!packetRequirementIds.has(id)) errors.push(`missing requirement ${id}.`);
  for (const capability of packet.capabilities) {
    if (!requirementIds.has(capability.requirement_ref)) errors.push(`capability ${capability.id} is not scoped to cluster requirement ${capability.requirement_ref}.`);
    for (const ref of capability.evidence_refs) {
      if (!permitted.has(ref)) errors.push(`capability ${capability.id} uses unpermitted evidence ${ref}.`);
      if (unresolved.has(ref)) errors.push(`capability ${capability.id} uses unresolved evidence ${ref}.`);
      if (!evidenceIds.has(ref)) errors.push(`capability ${capability.id} evidence ${ref} missing from packet.`);
    }
    const provenance = packet.generation_provenance.find((item) => item.capability_id === capability.id);
    if (!provenance) errors.push(`capability ${capability.id} missing generation provenance.`);
    if (provenance && (capability.generated_by.provider !== provenance.provider || capability.generated_by.model !== provenance.model || capability.generated_by.prompt_version !== provenance.prompt_version)) {
      errors.push(`capability ${capability.id} runtime provenance does not match generation record.`);
    }
  }
  if (packet.evidence_policy.support_ceilings.length === 0) errors.push("support ceiling policy missing.");
  return { status: errors.length ? "structurally_invalid" : "completed_valid_output", cluster_id: packet.cluster_id, errors, accounted_capability_ids: packet.capabilities.map((capability) => capability.id) };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeClusterValidationOutput(value: unknown): ClusterValidationOutput {
  if (!isRecord(value)) throw new Error("Cluster validation output must be an object.");
  return {
    cluster_id: typeof value.cluster_id === "string" ? value.cluster_id : "",
    status: ["passed", "revise", "architect_required", "failed"].includes(String(value.status)) ? value.status as ClusterValidationStatus : "failed",
    validated_capability_ids: stringArray(value.validated_capability_ids),
    rejected_capability_ids: stringArray(value.rejected_capability_ids),
    author_review_capability_ids: stringArray(value.author_review_capability_ids),
    findings: Array.isArray(value.findings) ? value.findings.filter(isRecord).map((finding) => ({ capability_id: typeof finding.capability_id === "string" ? finding.capability_id : undefined, requirement_ref: typeof finding.requirement_ref === "string" ? finding.requirement_ref : undefined, evidence_ref: typeof finding.evidence_ref === "string" ? finding.evidence_ref : undefined, severity: typeof finding.severity === "string" ? finding.severity : undefined, type: typeof finding.type === "string" ? finding.type : undefined, message: String(finding.message ?? "") })) : [],
    proposed_support_corrections: Array.isArray(value.proposed_support_corrections) ? value.proposed_support_corrections.filter(isRecord).map((item) => ({ capability_id: String(item.capability_id ?? ""), from: String(item.from ?? ""), to: String(item.to ?? ""), rationale: String(item.rationale ?? "") })) : [],
    evidence_reference_findings: Array.isArray(value.evidence_reference_findings) ? value.evidence_reference_findings.filter(isRecord).map((item) => ({ capability_id: String(item.capability_id ?? ""), evidence_ref: typeof item.evidence_ref === "string" ? item.evidence_ref : undefined, message: String(item.message ?? "") })) : [],
    unsupported_claim_findings: Array.isArray(value.unsupported_claim_findings) ? value.unsupported_claim_findings.filter(isRecord).map((item) => ({ capability_id: String(item.capability_id ?? ""), message: String(item.message ?? "") })) : []
  };
}

export function validateClusterValidationOutput(output: ClusterValidationOutput, packet: ClusterValidationPacket): ClusterValidationDeterministicResult {
  const errors: string[] = [];
  const capabilityIds = new Set(packet.capabilities.map((capability) => capability.id));
  const requirementIds = new Set(packet.evidence_policy.allowed_requirement_ids);
  const evidenceIds = new Set(packet.evidence_policy.allowed_evidence_ids);
  const sets = [output.validated_capability_ids, output.rejected_capability_ids, output.author_review_capability_ids];
  const seen = new Map<string, number>();
  if (output.cluster_id !== packet.cluster_id) errors.push("returned cluster_id does not match packet.");
  for (const set of sets) {
    for (const id of set) {
      if (!capabilityIds.has(id)) errors.push(`unknown capability id ${id}.`);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of seen) if (count > 1) errors.push(`capability ${id} appears in overlapping decision sets.`);
  for (const id of capabilityIds) if (!seen.has(id)) errors.push(`capability ${id} is not accounted for.`);
  for (const finding of [...output.findings, ...output.evidence_reference_findings, ...output.unsupported_claim_findings]) {
    if (finding.capability_id && !capabilityIds.has(finding.capability_id)) errors.push(`finding references unknown capability ${finding.capability_id}.`);
    if ("requirement_ref" in finding && finding.requirement_ref && !requirementIds.has(finding.requirement_ref)) errors.push(`finding references unknown requirement ${finding.requirement_ref}.`);
    if ("evidence_ref" in finding && finding.evidence_ref && !evidenceIds.has(finding.evidence_ref)) errors.push(`finding references unknown evidence ${finding.evidence_ref}.`);
  }
  const ceilingIds = new Set(packet.evidence_policy.support_ceilings.map((ceiling) => ceiling.context_ref));
  for (const correction of output.proposed_support_corrections) {
    if (!capabilityIds.has(correction.capability_id)) errors.push(`support correction references unknown capability ${correction.capability_id}.`);
    const capability = packet.capabilities.find((item) => item.id === correction.capability_id);
    if (capability && correction.to === "supported" && capability.evidence_refs.length > 0 && capability.evidence_refs.every((ref) => ceilingIds.has(ref))) {
      errors.push(`support correction raises ${correction.capability_id} above applicable support ceiling.`);
    }
  }
  return { status: errors.length ? "structurally_invalid" : "completed_valid_output", cluster_id: packet.cluster_id, errors, accounted_capability_ids: [...seen.keys()] };
}

export function aggregateClusterValidations(input: { packets: ClusterValidationPacket[]; validations: ClusterValidationOutput[] }) {
  const errors: string[] = [];
  const expectedClusters = new Set(validationClusterOrder);
  const actualClusters = new Set(input.validations.map((validation) => validation.cluster_id));
  for (const cluster of expectedClusters) if (!actualClusters.has(cluster)) errors.push(`missing cluster validation ${cluster}.`);
  const capabilityToCluster = new Map<string, string>();
  for (const packet of input.packets) {
    for (const capability of packet.capabilities) {
      if (capabilityToCluster.has(capability.id)) errors.push(`duplicate capability id ${capability.id}.`);
      capabilityToCluster.set(capability.id, packet.cluster_id);
    }
  }
  const decisions = new Map<string, string>();
  for (const validation of input.validations) {
    for (const id of validation.validated_capability_ids) decisions.set(id, "validated");
    for (const id of validation.rejected_capability_ids) decisions.set(id, decisions.has(id) ? "overlap" : "rejected");
    for (const id of validation.author_review_capability_ids) decisions.set(id, decisions.has(id) ? "overlap" : "author_review");
  }
  for (const id of capabilityToCluster.keys()) if (!decisions.has(id)) errors.push(`unaccounted capability ${id}.`);
  for (const [id, state] of decisions) {
    if (state === "overlap") errors.push(`capability ${id} appears in multiple decision states.`);
    if (!capabilityToCluster.has(id)) errors.push(`unknown capability decision ${id}.`);
  }
  return {
    schema_version: "corus.cluster_scoped_validation_aggregate.v1",
    status: errors.length ? "structurally_invalid" : "completed_valid_output",
    cluster_count: input.validations.length,
    capability_count: capabilityToCluster.size,
    expected_capability_count: 49,
    all_49_capabilities_accounted_for: capabilityToCluster.size === 49 && [...capabilityToCluster.keys()].every((id) => decisions.has(id)),
    decision_counts: [...decisions.values()].reduce<Record<string, number>>((acc, state) => {
      acc[state] = (acc[state] ?? 0) + 1;
      return acc;
    }, {}),
    errors
  };
}

export function completedOpenAIClusterValidationIdsFromRecords(records: StageGenerationRecord[]): string[] {
  return records
    .filter((record) => record.type === "capability_validation" && record.validation_status === "completed_valid_output")
    .map((record) => record.output_ref.match(/37-openai-cluster-validation-normalized-(.+)\.yaml$/)?.[1])
    .filter((id): id is string => Boolean(id));
}

async function executeOpenAIClusterValidation(packet: ClusterValidationPacket, requestedOutputTokens: number, rawOutputPath?: string) {
  const payload: PromptPayload = {
    operation: "cluster_capability_validation",
    instructions: [
      "Validate this single Corus capability cluster. Return one JSON object only.",
      "Required shape: {cluster_id,status,validated_capability_ids,rejected_capability_ids,author_review_capability_ids,findings,proposed_support_corrections,evidence_reference_findings,unsupported_claim_findings}.",
      "Do not introduce capability, requirement, or evidence IDs. Do not raise any capability above an applicable support ceiling.",
      "Unsupported claims must be rejected or sent to author_review."
    ],
    input: packet,
    promptVersion: "validate.openai.cluster.v1",
    schemaVersion: "corus.openai_cluster_validation.v1"
  };
  const directive = { ...defaultDirectivePacket, max_output_tokens: requestedOutputTokens, max_requested_tokens: 14000, rate_limit_tokens_per_minute: 50000, safety_margin: 0.1 };
  const result = await executeModelOperation({ profile: modelProfile(canonicalModelProfileIds.openai), prompt: payload, payload: payload.input, directive, mode: "execute" });
  const raw = result.raw_output;
  if (rawOutputPath) await fs.writeFile(rawOutputPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const metrics = providerMetricsFromModelOperation(result);
  const metadata = { model: result.model, prompt_version: "validate.openai.cluster.v1", schema_version: "corus.openai_cluster_validation.v1", metrics, provider_completion_state: result.completion_state, model_operation: modelOperationRecord(result) };
  if (result.admission_status === "withheld" || result.provider_error_classification) throw new ProviderExecutionError("openai", `OpenAI cluster validation failed: ${result.provider_error_classification ?? result.completion_state}.`, raw, metadata);
  let output: ClusterValidationOutput;
  try {
    output = normalizeClusterValidationOutput(parseJsonObject(textFromOpenAIResponse(raw)));
  } catch (error) {
    throw new ProviderExecutionError("openai", error instanceof Error ? error.message : "OpenAI returned invalid cluster validation output.", raw, {
      ...metadata,
      provider_completion_state: "provider_output_invalid"
    });
  }
  return { output, raw_output: raw, provider: "openai", model: result.model, prompt_version: "validate.openai.cluster.v1", metrics, model_operation: modelOperationRecord(result) };
}

function validationArtifactNames(clusterId: string) {
  return {
    packet: `37-openai-cluster-validation-packet-${clusterId}.yaml`,
    preflight: `37-openai-cluster-validation-token-preflight-${clusterId}.yaml`,
    raw: `raw-37-openai-cluster-validation-${clusterId}.json`,
    rawError: `raw-37-openai-cluster-validation-error-${clusterId}.json`,
    normalized: `37-openai-cluster-validation-normalized-${clusterId}.yaml`,
    deterministic: `37-openai-cluster-validation-deterministic-${clusterId}.yaml`,
    record: `37-openai-cluster-validation-generation-record-${clusterId}.json`,
    failure: `37-openai-cluster-validation-failure-${clusterId}.yaml`
  };
}

function classifyOpenAIClusterFailure(error: unknown): string {
  if (!(error instanceof ProviderExecutionError)) return "local_failure";
  const raw = error.raw_output;
  const rawText = JSON.stringify(raw ?? {});
  if (raw && typeof raw === "object" && (raw as { status?: unknown }).status === "incomplete") return "provider_incomplete_output_tokens";
  if (rawText.includes("rate_limit")) return "tpm_429";
  return error.metadata?.provider_completion_state ?? "provider_error";
}

function capabilityReviewMarkdown(items: Array<Record<string, unknown>>): string {
  const lines = ["# Capability Admission Review", "", "Checkpoint: awaiting_author_capability_admission", ""];
  for (const item of items) {
    lines.push(`## ${item.capability_id}`, "", `- Cluster: ${item.cluster_id}`, `- Requirement: ${item.requirement_ref}`, `- Claude support: ${item.support}`, `- Claude confidence: ${item.confidence}`, `- Proposed decision: ${item.proposed_decision}`, `- Evidence: ${Array.isArray(item.evidence_refs) ? item.evidence_refs.join(", ") : ""}`, "", String(item.rationale ?? ""), "");
  }
  return lines.join("\n");
}

export async function runClusterScopedOpenAIValidation(input: { root?: string; runId: string; rollingTpmBudget?: number; requestedOutputTokens?: number }) {
  const root = input.root ?? getProjectRoot();
  const runDir = path.join(root, "outputs", input.runId);
  const rollingTpmBudget = input.rollingTpmBudget ?? 45000;
  const requestedOutputTokens = input.requestedOutputTokens ?? 2000;
  const admitted = await readYaml<AdmittedClusters>(path.join(runDir, "08-admitted-job-requirement-clusters.yaml"));
  const admission = await readYaml<EvidenceBoundaryAdmission>(path.join(runDir, "31-author-evidence-boundary-admission.yaml"));
  const target = (await readYaml<{ context: Context }>(path.join(runDir, "01-job-description-context.yaml"))).context;
  const subject = (await readYaml<{ context: Context }>(path.join(runDir, "33-filtered_attempt_1-subject-context.yaml"))).context;
  const aggregateFailure = await readYaml<Record<string, unknown>>(path.join(runDir, "35-filtered_attempt_1-openai-validation-attempt-2-retry-classification.yaml")).catch(() => null);
  const progressPath = path.join(runDir, "37-openai-cluster-validation-progress.yaml");
  let records: StageGenerationRecord[] = [];
  try { records = JSON.parse(await fs.readFile(path.join(runDir, "generation-records.json"), "utf8")) as StageGenerationRecord[]; } catch {}
  let rollingEstimatedTokens = 0;
  const packets: ClusterValidationPacket[] = [];
  const validations: ClusterValidationOutput[] = [];
  const completedClusters: string[] = [];
  const providerCalls: Array<{ cluster_id: string; metrics: ProviderMetrics }> = [];
  const included = new Map(admitted.clusters.filter((cluster) => admitted.downstream_policy.capability_derivation.include.includes(cluster.id)).map((cluster) => [cluster.id, cluster]));

  for (const clusterId of validationClusterOrder) {
    const cluster = included.get(clusterId);
    if (!cluster) throw new Error(`Admitted cluster missing: ${clusterId}`);
    const names = validationArtifactNames(clusterId);
    const { reduction } = await readClusterReduction(runDir, clusterId);
    const generationRecord = await readClusterGenerationRecord(runDir, clusterId);
    const packet = buildClusterValidationPacket({ runId: input.runId, cluster, targetContext: target, subjectContext: subject, reduction, generationRecord, admission });
    const packetValidation = validateClusterValidationPacket(packet, cluster, admission);
    if (packetValidation.status !== "completed_valid_output") throw new Error(`Validation packet ${clusterId} failed deterministic preflight: ${packetValidation.errors.join("; ")}`);
    await fs.writeFile(path.join(runDir, names.packet), stringify(packet), "utf8");
    packets.push(packet);
    const tokenPreflight = validationPacketTokenEligibility(packet, rollingEstimatedTokens, rollingTpmBudget, requestedOutputTokens);
    await fs.writeFile(path.join(runDir, names.preflight), stringify({ schema_version: "corus.openai_cluster_validation_token_preflight.v1", cluster_id: clusterId, ...tokenPreflight }), "utf8");
    if (!tokenPreflight.individually_eligible || !tokenPreflight.rolling_eligible) {
      await fs.writeFile(progressPath, stringify({ schema_version: "corus.openai_cluster_validation_progress.v1", pipeline_status: "waiting_for_rate_window", next_cluster_id: clusterId, completed_clusters: completedClusters, rolling_estimated_tokens: rollingEstimatedTokens, blocked_packet_tokens: tokenPreflight }));
      return { status: "waiting_for_rate_window", openai_calls_made: providerCalls.length, completed_clusters: completedClusters, artifact_refs: [artifactRef(root, progressPath)] };
    }

    try {
      const existing = await readYaml<ClusterValidationOutput>(path.join(runDir, names.normalized));
      const deterministic = await readYaml<ClusterValidationDeterministicResult>(path.join(runDir, names.deterministic));
      if (deterministic.status === "completed_valid_output") {
        validations.push(existing);
        completedClusters.push(clusterId);
        continue;
      }
    } catch {}

    if (clusterId !== "product_delivery_and_execution" && completedClusters.length === 0) throw new Error("Smoke validation must complete before later clusters.");
    let result;
    try {
      result = await executeOpenAIClusterValidation(packet, requestedOutputTokens, path.join(runDir, names.raw));
    } catch (error) {
      const classification = classifyOpenAIClusterFailure(error);
      const failure = { schema_version: "corus.openai_cluster_validation_failure.v1", cluster_id: clusterId, provider: error instanceof ProviderExecutionError ? error.provider : undefined, message: error instanceof Error ? error.message : String(error), classification };
      if (error instanceof ProviderExecutionError && error.raw_output !== undefined) await writeJsonArtifact(runDir, names.rawError, error.raw_output);
      if (error instanceof ProviderExecutionError && error.raw_output !== undefined) {
        const failureRecord = stageRecord({
          type: "capability_validation",
          started_at: error.metadata?.started_at,
          completed_at: error.metadata?.completed_at,
          input_refs: [artifactRef(root, path.join(runDir, names.packet))],
          output_ref: artifactRef(root, path.join(runDir, names.failure)),
          raw_output_ref: artifactRef(root, path.join(runDir, names.rawError)),
          provider: error.provider,
          model: error.metadata?.model ?? modelProfile(canonicalModelProfileIds.openai).model,
          prompt_version: "validate.openai.cluster.v1",
          schema_version: "corus.openai_cluster_validation.v1",
          validation_status: classification,
          provider_completion_state: error.metadata?.provider_completion_state ?? null,
          metrics: error.metadata?.metrics ?? { input_tokens: null, output_tokens: null, total_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" },
          stop_reason: null,
          model_operation: error.metadata?.model_operation
        });
        await writeJsonArtifact(runDir, names.record, failureRecord);
        records.push(failureRecord);
        await writeGenerationRecords(runDir, records);
      }
      await fs.writeFile(path.join(runDir, names.failure), stringify(failure), "utf8");
      await fs.writeFile(progressPath, stringify({ schema_version: "corus.openai_cluster_validation_progress.v1", pipeline_status: failure.classification === "tpm_429" ? "provider_unavailable" : "cluster_validation_provider_incomplete", failed_cluster_id: clusterId, completed_clusters: completedClusters, failure }));
      throw error;
    }
    const deterministic = validateClusterValidationOutput(result.output, packet);
    await fs.writeFile(path.join(runDir, names.normalized), stringify(result.output), "utf8");
    await fs.writeFile(path.join(runDir, names.deterministic), stringify(deterministic), "utf8");
    const record = stageRecord({ type: "capability_validation", input_refs: [artifactRef(root, path.join(runDir, names.packet))], output_ref: artifactRef(root, path.join(runDir, names.normalized)), raw_output_ref: artifactRef(root, path.join(runDir, names.raw)), provider: result.provider, model: result.model, prompt_version: result.prompt_version, schema_version: "corus.openai_cluster_validation.v1", validation_status: deterministic.status, provider_completion_state: "completed", metrics: result.metrics, model_operation: result.model_operation });
    await writeJsonArtifact(runDir, names.record, record);
    records.push(record);
    await writeGenerationRecords(runDir, records);
    providerCalls.push({ cluster_id: clusterId, metrics: result.metrics });
    if (deterministic.status !== "completed_valid_output") {
      await fs.writeFile(progressPath, stringify({ schema_version: "corus.openai_cluster_validation_progress.v1", pipeline_status: "cluster_validation_structurally_invalid", failed_cluster_id: clusterId, completed_clusters: completedClusters, deterministic }));
      return { status: "cluster_validation_structurally_invalid", openai_calls_made: providerCalls.length, completed_clusters: completedClusters, artifact_refs: [artifactRef(root, progressPath)] };
    }
    validations.push(result.output);
    completedClusters.push(clusterId);
    rollingEstimatedTokens += tokenPreflight.estimated_total_requested_tokens;
    await fs.writeFile(progressPath, stringify({ schema_version: "corus.openai_cluster_validation_progress.v1", pipeline_status: "in_progress", completed_clusters: completedClusters, rolling_estimated_tokens: rollingEstimatedTokens }));
  }

  const aggregate = aggregateClusterValidations({ packets, validations });
  await fs.writeFile(path.join(runDir, "38-openai-cluster-validation-aggregate.yaml"), stringify(aggregate), "utf8");
  const capabilityById = new Map(packets.flatMap((packet) => packet.capabilities.map((capability) => [capability.id, { packet, capability }] as const)));
  const findingsByCapability = new Map(validations.flatMap((validation) => validation.findings.map((finding) => [finding.capability_id, finding] as const)).filter(([id]) => Boolean(id)) as Array<[string, ClusterValidationOutput["findings"][number]]>);
  const reviewItems = [...capabilityById.entries()].map(([capabilityId, item]) => {
    const validation = validations.find((candidate) => candidate.cluster_id === item.packet.cluster_id)!;
    const proposed_decision = item.capability.support === "unsupported" || validation.rejected_capability_ids.includes(capabilityId) ? "reject" : validation.validated_capability_ids.includes(capabilityId) ? "admit" : "author_review";
    return { capability_id: capabilityId, cluster_id: item.packet.cluster_id, requirement_ref: item.capability.requirement_ref, support: item.capability.support, confidence: item.capability.confidence, openai_status: validation.status, openai_finding: findingsByCapability.get(capabilityId)?.message ?? null, evidence_refs: item.capability.evidence_refs, support_ceiling_constraints: item.packet.evidence_policy.support_ceilings.filter((ceiling) => item.capability.evidence_refs.includes(ceiling.context_ref)), proposed_decision, rationale: proposed_decision === "admit" ? "OpenAI validated the capability and deterministic checks found no blocking support state." : proposed_decision === "reject" ? "Capability is unsupported or rejected by validation." : "Capability requires Author review due to validation routing or ambiguity." };
  });
  await fs.writeFile(path.join(runDir, "39-capability-admission-review.yaml"), stringify({ schema_version: "corus.capability_admission_review.v2", pipeline_status: "awaiting_author_capability_admission", items: reviewItems }), "utf8");
  await fs.writeFile(path.join(runDir, "39-capability-admission-review.md"), capabilityReviewMarkdown(reviewItems), "utf8");
  await fs.writeFile(path.join(runDir, "40-validation-architecture-comparison.yaml"), stringify({ schema_version: "corus.validation_architecture_comparison.v1", aggregate_attempt: { preserved: true, requested_tokens: 68176, tpm_limit: 50000, classification: "aggregate_validation_request_exceeds_tpm_limit", retry_classification: aggregateFailure }, cluster_scoped_validation: { decision: "validate_clusters_independently", cluster_count: validations.length, rolling_tpm_budget: rollingTpmBudget, status: aggregate.status } }), "utf8");
  await fs.writeFile(progressPath, stringify({ schema_version: "corus.openai_cluster_validation_progress.v1", pipeline_status: "awaiting_author_capability_admission", completed_clusters: completedClusters, rolling_estimated_tokens: rollingEstimatedTokens, aggregate_status: aggregate.status }), "utf8");
  return { status: "awaiting_author_capability_admission", openai_calls_made: providerCalls.length, completed_clusters: completedClusters, aggregate, artifact_refs: ["37-openai-cluster-validation-progress.yaml", "38-openai-cluster-validation-aggregate.yaml", "39-capability-admission-review.yaml", "39-capability-admission-review.md", "40-validation-architecture-comparison.yaml"].map((name) => artifactRef(root, path.join(runDir, name))) };
}
