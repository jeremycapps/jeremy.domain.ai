import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  AgentProvider,
  ClusterIntegrityResult,
  Context,
  JobRequirementClusteringInput,
  JobRequirementClusterRepairInput,
  JobRequirementClusteringPolicy,
  JobRequirementClusteringRunResponse,
  JobRequirementClusters,
  JobRequirementCluster,
  ProviderResult,
  StageGenerationRecord
} from "../types.js";
import { artifactRef, createRunDirectory, stageRecord, writeGenerationRecords, writeJsonArtifact, writeMarkdownArtifact, writeYamlArtifact } from "./corusArtifacts.js";
import { contextRefs, normalizeContext, readSourceInput, sourceRefFromInput } from "./corusContext.js";
import { getProjectRoot } from "./paths.js";
import { emptyMetrics } from "../providers/providerUtils.js";
import { ProviderExecutionError } from "../providers/errors.js";
import { MockJobRequirementClusteringProvider } from "../providers/mockProviders.js";

export const jobRequirementClusteringPolicy: JobRequirementClusteringPolicy = {
  id: "corus.job_requirement_clustering_policy.v1",
  purpose:
    "Group atomic requirements from one job description into the smallest coherent capability domains that may later be compared with applicant evidence.",
  rules: [
    "Preserve every atomic job-requirement ID.",
    "Group by shared underlying capability, not merely shared vocabulary.",
    "Prefer the smallest coherent clusters.",
    "Keep execution, coordination, strategy, and communication distinct unless the job description explicitly combines them.",
    "Prefer clusters containing two to six requirements.",
    "Permit singleton clusters.",
    "Expose overlapping membership explicitly.",
    "Leave a requirement unassigned rather than forcing a weak grouping.",
    "Do not inspect or infer applicant evidence.",
    "Do not generate applicant-specific capability claims.",
    "Do not decide whether the applicant satisfies any requirement."
  ]
};

export function jobRequirementClusterSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "job_description_ref", "clustering_policy_ref", "clusters", "unassigned_requirement_refs", "overlapping_requirements", "generated_by"],
    properties: {
      schema_version: { const: "corus.job_requirement_clusters.v1" },
      job_description_ref: { type: "string" },
      clustering_policy_ref: { const: "corus.job_requirement_clustering_policy.v1" },
      clusters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "requirement_refs", "rationale"],
          properties: {
            id: { type: "string" },
            label: { type: "string", minLength: 1 },
            requirement_refs: { type: "array", items: { type: "string" } },
            rationale: { type: "string", minLength: 1 },
            ambiguity: { type: "string" }
          }
        }
      },
      unassigned_requirement_refs: { type: "array", items: { type: "string" } },
      overlapping_requirements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["requirement_ref", "cluster_refs", "rationale"],
          properties: {
            requirement_ref: { type: "string" },
            cluster_refs: { type: "array", items: { type: "string" } },
            rationale: { type: "string", minLength: 1 }
          }
        }
      },
      generated_by: {
        type: "object",
        additionalProperties: false,
        required: ["role", "provider", "model", "prompt_version"],
        properties: {
          role: { const: "implementer" },
          provider: { type: "string" },
          model: { type: "string" },
          prompt_version: { const: "cluster-job-requirements.gemini.v1" }
        }
      }
    }
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateJobRequirementClusterSchema(value: unknown, provider = "gemini", expectedPromptVersion = "cluster-job-requirements.gemini.v1"): JobRequirementClusters {
  if (!isObject(value)) throw new ProviderExecutionError(provider, "Job-requirement cluster output must be an object.");
  if (value.schema_version !== "corus.job_requirement_clusters.v1") throw new ProviderExecutionError(provider, "Cluster output has invalid schema_version.");
  if (typeof value.job_description_ref !== "string") throw new ProviderExecutionError(provider, "Cluster output must include job_description_ref.");
  if (value.clustering_policy_ref !== "corus.job_requirement_clustering_policy.v1") throw new ProviderExecutionError(provider, "Cluster output has invalid clustering_policy_ref.");
  if (!Array.isArray(value.clusters)) throw new ProviderExecutionError(provider, "Cluster output must include clusters array.");
  if (!stringArray(value.unassigned_requirement_refs)) throw new ProviderExecutionError(provider, "Cluster output must include unassigned_requirement_refs string array.");
  if (!Array.isArray(value.overlapping_requirements)) throw new ProviderExecutionError(provider, "Cluster output must include overlapping_requirements array.");
  if (!isObject(value.generated_by)) throw new ProviderExecutionError(provider, "Cluster output must include generated_by metadata.");
  if (value.generated_by.role !== "implementer" || typeof value.generated_by.provider !== "string" || typeof value.generated_by.model !== "string") {
    throw new ProviderExecutionError(provider, "Cluster generated_by metadata is invalid.");
  }
  if (value.generated_by.prompt_version !== expectedPromptVersion) throw new ProviderExecutionError(provider, "Cluster prompt_version is invalid.");

  for (const cluster of value.clusters) {
    if (!isObject(cluster)) throw new ProviderExecutionError(provider, "Each job-requirement cluster must be an object.");
    if (typeof cluster.id !== "string" || cluster.id.trim() === "") throw new ProviderExecutionError(provider, "Each cluster must include string id.");
    if (typeof cluster.label !== "string" || cluster.label.trim() === "") throw new ProviderExecutionError(provider, "Each cluster must include non-empty label.");
    if (!stringArray(cluster.requirement_refs)) throw new ProviderExecutionError(provider, "Each cluster must include requirement_refs string array.");
    if (typeof cluster.rationale !== "string" || cluster.rationale.trim() === "") throw new ProviderExecutionError(provider, "Each cluster must include non-empty rationale.");
    if (cluster.ambiguity !== undefined && typeof cluster.ambiguity !== "string") throw new ProviderExecutionError(provider, "Cluster ambiguity must be a string.");
  }

  for (const overlap of value.overlapping_requirements) {
    if (!isObject(overlap)) throw new ProviderExecutionError(provider, "Each overlap entry must be an object.");
    if (typeof overlap.requirement_ref !== "string") throw new ProviderExecutionError(provider, "Each overlap must include requirement_ref.");
    if (!stringArray(overlap.cluster_refs)) throw new ProviderExecutionError(provider, "Each overlap must include cluster_refs string array.");
    if (typeof overlap.rationale !== "string" || overlap.rationale.trim() === "") throw new ProviderExecutionError(provider, "Each overlap must include non-empty rationale.");
  }

  return value as unknown as JobRequirementClusters;
}

export function requirementEntries(context: Context): Array<{ id: string; text: string }> {
  const contexts = context.content.contexts;
  if (!Array.isArray(contexts)) return [];
  return contexts
    .filter((entry): entry is Record<string, unknown> => isObject(entry) && typeof entry.id === "string")
    .map((entry) => ({ id: String(entry.id), text: JSON.stringify(entry) }));
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

export function validateClusterIntegrity(input: {
  original: Context;
  applicant?: Context;
  originalLedgerBefore: unknown;
  originalLedgerAfter: unknown;
  proposal: JobRequirementClusters;
}): ClusterIntegrityResult {
  const requirementIds = new Set(requirementEntries(input.original).map((entry) => entry.id));
  const clusterIds = input.proposal.clusters.map((cluster) => cluster.id);
  const clusterIdSet = new Set(clusterIds);
  const clusterRefs = input.proposal.clusters.flatMap((cluster) => cluster.requirement_refs);
  const allRefs = [...clusterRefs, ...input.proposal.unassigned_requirement_refs, ...input.proposal.overlapping_requirements.map((entry) => entry.requirement_ref)];
  const unknownRequirementRefs = [...new Set(allRefs.filter((ref) => !requirementIds.has(ref)))];
  const accounted = new Set([...clusterRefs, ...input.proposal.unassigned_requirement_refs]);
  const missingRequirementRefs = [...requirementIds].filter((id) => !accounted.has(id));
  const duplicateRefsWithinClusters = input.proposal.clusters.flatMap((cluster) =>
    duplicates(cluster.requirement_refs).map((requirementRef) => ({ cluster_ref: cluster.id, requirement_ref: requirementRef }))
  );
  const invalidOverlapRefs = input.proposal.overlapping_requirements.flatMap((overlap) => [
    ...(!requirementIds.has(overlap.requirement_ref) ? [overlap.requirement_ref] : []),
    ...overlap.cluster_refs.filter((clusterRef) => !clusterIdSet.has(clusterRef))
  ]);
  const originalLedgerUnchanged = JSON.stringify(input.originalLedgerBefore) === JSON.stringify(input.originalLedgerAfter);
  const proposalText = JSON.stringify(input.proposal);
  const applicantMarkers = ["evidence_refs", "jeremy_capps", ...(input.applicant ? [input.applicant.id] : [])];
  const applicantContextAbsent = applicantMarkers.every((marker) => !proposalText.includes(marker));
  const originalIdsUnchanged = originalLedgerUnchanged;
  const originalTextUnchanged = originalLedgerUnchanged;
  const invalidUnassignedRefs = [...new Set(input.proposal.unassigned_requirement_refs.filter((ref) => !requirementIds.has(ref)))];

  const checks = {
    original_requirement_count: requirementIds.size,
    accounted_requirement_count: [...accounted].filter((id) => requirementIds.has(id)).length,
    all_original_requirements_accounted_for: missingRequirementRefs.length === 0,
    unknown_requirement_refs: unknownRequirementRefs,
    missing_requirement_refs: missingRequirementRefs,
    duplicate_cluster_ids: duplicates(clusterIds),
    duplicate_refs_within_clusters: duplicateRefsWithinClusters,
    invalid_unassigned_refs: invalidUnassignedRefs,
    unreported_overlaps: [],
    invalid_overlap_refs: [...new Set(invalidOverlapRefs)],
    original_ids_unchanged: originalIdsUnchanged,
    original_text_unchanged: originalTextUnchanged,
    original_ledger_unchanged: originalLedgerUnchanged,
    applicant_context_absent: applicantContextAbsent
  };
  const reviewConditions = {
    unassigned_requirement_refs: input.proposal.unassigned_requirement_refs,
    overlapping_requirement_refs: input.proposal.overlapping_requirements.map((entry) => entry.requirement_ref),
    singleton_cluster_refs: input.proposal.clusters.filter((cluster) => cluster.requirement_refs.length === 1).map((cluster) => cluster.id),
    unusually_large_cluster_refs: input.proposal.clusters.filter((cluster) => cluster.requirement_refs.length > 6).map((cluster) => cluster.id),
    ambiguous_cluster_refs: input.proposal.clusters.filter((cluster) => cluster.ambiguity).map((cluster) => cluster.id)
  };
  const structurallyInvalid =
    unknownRequirementRefs.length > 0 ||
    missingRequirementRefs.length > 0 ||
    checks.duplicate_cluster_ids.length > 0 ||
    duplicateRefsWithinClusters.length > 0 ||
    checks.invalid_unassigned_refs.length > 0 ||
    checks.invalid_overlap_refs.length > 0 ||
    !originalIdsUnchanged ||
    !originalTextUnchanged ||
    !originalLedgerUnchanged ||
    !applicantContextAbsent;
  const authorReviewRequired =
    reviewConditions.unassigned_requirement_refs.length > 0 ||
    reviewConditions.overlapping_requirement_refs.length > 0 ||
    reviewConditions.singleton_cluster_refs.length > 0 ||
    reviewConditions.unusually_large_cluster_refs.length > 0 ||
    reviewConditions.ambiguous_cluster_refs.length > 0;

  return {
    schema_version: "corus.job_requirement_cluster_integrity.v1",
    status: structurallyInvalid ? "structurally_invalid" : authorReviewRequired ? "author_review_required" : "valid",
    checks,
    review_conditions: reviewConditions
  };
}

function providerIncomplete(error: unknown): boolean {
  return error instanceof ProviderExecutionError && Boolean(error.metadata?.stop_reason);
}

export class ProviderIncompleteError extends ProviderExecutionError {}

function contextProviderResult(source: unknown, kind: string, position: "subject" | "target", inputRef: string): ProviderResult<Context> {
  const startedAt = Date.now();
  const output = normalizeContext(source, kind, position, inputRef);
  output.generation.provider = "fixture";
  output.generation.model = "structured-context-ledger";
  output.generation.prompt_version = "contextualize.preserve-ledger.v1";
  return {
    output,
    provider: "fixture",
    model: "structured-context-ledger",
    prompt_version: "contextualize.preserve-ledger.v1",
    metrics: emptyMetrics(startedAt)
  };
}

async function checkpoint(outputDir: string, records: StageGenerationRecord[], record: StageGenerationRecord) {
  records.push(record);
  await writeGenerationRecords(outputDir, records);
}

function reviewMarkdown(input: {
  target: Context;
  proposal: JobRequirementClusters;
  integrity: ClusterIntegrityResult;
  generationRecordsRef: string;
  clusterArtifactRef: string;
  rawClusterArtifactRef?: string;
  integrityArtifactRef: string;
}): string {
  const requirementText = new Map(requirementEntries(input.target).map((entry) => [entry.id, entry.text]));
  const liveNotice = input.proposal.generated_by.model.startsWith("mock-")
    ? "This cluster proposal was generated by the deterministic mock fixture. It is not a semantic Gemini result and has not yet been admitted by the Author."
    : "This cluster proposal was generated by a live Gemini model. It is not the deterministic mock fixture and has not yet been admitted by the Author.";
  const lines = [
    "# Job Requirement Cluster Review",
    "",
    liveNotice,
    "",
    "Decision requested: Do these clusters accurately describe the capability domains required by this job description?",
    "",
    `Job description: ${input.proposal.job_description_ref}`,
    `Generated by: ${input.proposal.generated_by.provider} / ${input.proposal.generated_by.model}`,
    `Prompt version: ${input.proposal.generated_by.prompt_version}`,
    `Clustering policy: ${input.proposal.clustering_policy_ref}`,
    `Atomic requirements: ${requirementText.size}`,
    `Accounted requirements: ${input.integrity.checks.accounted_requirement_count}/${input.integrity.checks.original_requirement_count}`,
    `Generation records: ${input.generationRecordsRef}`,
    `Normalized proposal: ${input.clusterArtifactRef}`,
    `Raw provider response: ${input.rawClusterArtifactRef ?? "none"}`,
    `Integrity artifact: ${input.integrityArtifactRef}`,
    "",
    "## Proposed Clusters"
  ];
  for (const cluster of input.proposal.clusters) {
    lines.push("", `### ${cluster.id}: ${cluster.label}`, "", cluster.rationale, "", `Requirement count: ${cluster.requirement_refs.length}`, "", "Requirement IDs:");
    for (const ref of cluster.requirement_refs) {
      lines.push(`- ${ref}: ${requirementText.get(ref) ?? "(missing requirement text)"}`);
    }
  }
  lines.push("", "## Unassigned Requirements");
  for (const ref of input.proposal.unassigned_requirement_refs) lines.push(`- ${ref}: ${requirementText.get(ref) ?? "(missing requirement text)"}`);
  if (input.proposal.unassigned_requirement_refs.length === 0) lines.push("- None");
  lines.push("", "## Overlaps");
  for (const overlap of input.proposal.overlapping_requirements) {
    lines.push(`- ${overlap.requirement_ref} -> ${overlap.cluster_refs.join(", ")}: ${overlap.rationale}`);
  }
  if (input.proposal.overlapping_requirements.length === 0) lines.push("- None");
  lines.push("", "## Review Conditions", `- Singleton clusters: ${input.integrity.review_conditions.singleton_cluster_refs.join(", ") || "none"}`, `- Oversized clusters: ${input.integrity.review_conditions.unusually_large_cluster_refs.join(", ") || "none"}`, `- Unassigned requirements: ${input.integrity.review_conditions.unassigned_requirement_refs.join(", ") || "none"}`, `- Overlapping requirements: ${input.integrity.review_conditions.overlapping_requirement_refs.join(", ") || "none"}`);
  lines.push("", "## Validation Findings", "", `Status: ${input.integrity.status}`, "", "Checks:", `- Original requirement count: ${input.integrity.checks.original_requirement_count}`, `- Accounted requirement count: ${input.integrity.checks.accounted_requirement_count}`, `- Unknown requirement refs: ${input.integrity.checks.unknown_requirement_refs.join(", ") || "none"}`, `- Missing requirement refs: ${input.integrity.checks.missing_requirement_refs.join(", ") || "none"}`, `- Duplicate cluster IDs: ${input.integrity.checks.duplicate_cluster_ids.join(", ") || "none"}`, `- Invalid unassigned refs: ${input.integrity.checks.invalid_unassigned_refs.join(", ") || "none"}`, `- Invalid overlap refs: ${input.integrity.checks.invalid_overlap_refs.join(", ") || "none"}`, `- Original IDs unchanged: ${input.integrity.checks.original_ids_unchanged ? "yes" : "no"}`, `- Original text unchanged: ${input.integrity.checks.original_text_unchanged ? "yes" : "no"}`, `- Original ledger unchanged: ${input.integrity.checks.original_ledger_unchanged ? "yes" : "no"}`, `- Applicant context absent: ${input.integrity.checks.applicant_context_absent ? "yes" : "no"}`);
  return `${lines.join("\n")}\n`;
}

export interface JobRequirementClusteringProviders {
  clusterer: AgentProvider<JobRequirementClusteringInput, JobRequirementClusters>;
}

export interface JobRequirementClusterRepairProviders {
  repairer: AgentProvider<JobRequirementClusterRepairInput, JobRequirementClusters>;
}

type FailedClusterStageStatus = "provider_incomplete" | "schema_invalid" | "provider_error";

function classifyClusterProviderError(error: unknown): FailedClusterStageStatus {
  return providerIncomplete(error)
    ? "provider_incomplete"
    : error instanceof ProviderExecutionError && error.metadata?.provider_status === "provider_error"
      ? "provider_error"
      : error instanceof ProviderExecutionError
        ? "schema_invalid"
        : "provider_error";
}

function placementSummary(proposal: JobRequirementClusters, refs: string[]): Array<{ requirement_ref: string; placement: string }> {
  return refs.map((ref) => {
    const clusterRefs = proposal.clusters.filter((cluster) => cluster.requirement_refs.includes(ref)).map((cluster) => cluster.id);
    const unassigned = proposal.unassigned_requirement_refs.includes(ref);
    return {
      requirement_ref: ref,
      placement: clusterRefs.length > 0 ? clusterRefs.join(", ") : unassigned ? "unassigned_requirement_refs" : "missing"
    };
  });
}

function repairedReviewMarkdown(input: {
  originalRunId: string;
  repairRunId: string;
  target: Context;
  proposal: JobRequirementClusters;
  integrity: ClusterIntegrityResult;
  missingRequirementRefs: string[];
  rawRepairArtifactRef?: string;
  repairedArtifactRef: string;
  repairedIntegrityArtifactRef: string;
  originalProposalRef: string;
  originalIntegrityRef: string;
  generationRecordsRef: string;
}): string {
  const requirementText = new Map(requirementEntries(input.target).map((entry) => [entry.id, entry.text]));
  const placements = placementSummary(input.proposal, input.missingRequirementRefs);
  const lines = [
    "# Repaired Job Requirement Cluster Review",
    "",
    "This is the repaired live Gemini proposal following a deterministic completeness exception. All 34 original Prophet job requirements have been accounted for. The cluster map has not yet been admitted by the Author.",
    "",
    "Decision requested: Do these repaired clusters accurately describe the capability domains required by the Prophet job description?",
    "",
    `Original run ID: ${input.originalRunId}`,
    `Repair run ID: ${input.repairRunId}`,
    `Provider/model: ${input.proposal.generated_by.provider} / ${input.proposal.generated_by.model}`,
    `Clustering policy: ${input.proposal.clustering_policy_ref}`,
    `Repair prompt version: ${input.proposal.generated_by.prompt_version}`,
    `Original requirement count: ${input.integrity.checks.original_requirement_count}`,
    `Repaired accounted requirements: ${input.integrity.checks.accounted_requirement_count}/${input.integrity.checks.original_requirement_count}`,
    `Cluster count: ${input.proposal.clusters.length}`,
    `Unassigned count: ${input.proposal.unassigned_requirement_refs.length}`,
    `Overlap count: ${input.proposal.overlapping_requirements.length}`,
    `Singleton count: ${input.integrity.review_conditions.singleton_cluster_refs.length}`,
    `Oversized-cluster count: ${input.integrity.review_conditions.unusually_large_cluster_refs.length}`,
    `Integrity status: ${input.integrity.status}`,
    `Original proposal: ${input.originalProposalRef}`,
    `Original integrity: ${input.originalIntegrityRef}`,
    `Raw repair response: ${input.rawRepairArtifactRef ?? "none"}`,
    `Repaired proposal: ${input.repairedArtifactRef}`,
    `Repaired integrity: ${input.repairedIntegrityArtifactRef}`,
    `Generation records: ${input.generationRecordsRef}`,
    "",
    "## Previously Missing Requirements"
  ];
  for (const placement of placements) lines.push(`- ${placement.requirement_ref}: ${placement.placement}`);
  lines.push("", "## Proposed Clusters");
  for (const cluster of input.proposal.clusters) {
    lines.push("", `### ${cluster.id}: ${cluster.label}`, "", cluster.rationale, "", `Requirement count: ${cluster.requirement_refs.length}`, "", "Requirement IDs:");
    for (const ref of cluster.requirement_refs) lines.push(`- ${ref}: ${requirementText.get(ref) ?? "(missing requirement text)"}`);
  }
  lines.push("", "## Unassigned Requirements");
  for (const ref of input.proposal.unassigned_requirement_refs) lines.push(`- ${ref}: ${requirementText.get(ref) ?? "(missing requirement text)"}`);
  if (input.proposal.unassigned_requirement_refs.length === 0) lines.push("- None");
  lines.push("", "## Overlaps");
  for (const overlap of input.proposal.overlapping_requirements) lines.push(`- ${overlap.requirement_ref} -> ${overlap.cluster_refs.join(", ")}: ${overlap.rationale}`);
  if (input.proposal.overlapping_requirements.length === 0) lines.push("- None");
  lines.push("", "## Deterministic Integrity Findings", `- Missing requirement refs: ${input.integrity.checks.missing_requirement_refs.join(", ") || "none"}`, `- Unknown requirement refs: ${input.integrity.checks.unknown_requirement_refs.join(", ") || "none"}`, `- Duplicate cluster IDs: ${input.integrity.checks.duplicate_cluster_ids.join(", ") || "none"}`, `- Invalid unassigned refs: ${input.integrity.checks.invalid_unassigned_refs.join(", ") || "none"}`, `- Invalid overlap refs: ${input.integrity.checks.invalid_overlap_refs.join(", ") || "none"}`, `- Applicant context absent: ${input.integrity.checks.applicant_context_absent ? "yes" : "no"}`);
  return `${lines.join("\n")}
`;
}

export async function runJobRequirementClustering(
  request: {
    subject_source?: unknown;
    target_source: unknown;
    mode?: "mocked" | "fixture" | "live";
  },
  options: { root?: string; providers?: JobRequirementClusteringProviders } = {}
): Promise<JobRequirementClusteringRunResponse> {
  const root = options.root ?? getProjectRoot();
  const runId = randomUUID();
  const outputDir = await createRunDirectory(runId, root);
  const records: StageGenerationRecord[] = [];
  const providers = options.providers ?? { clusterer: new MockJobRequirementClusteringProvider() };
  const targetRef = sourceRefFromInput(request.target_source, "target_source");
  const targetSource = await readSourceInput(request.target_source, root);
  const targetBefore = JSON.parse(JSON.stringify(targetSource));

  const targetResult = contextProviderResult(targetSource, "target", "target", targetRef);
  const targetArtifact = await writeYamlArtifact(outputDir, "01-job-description-context.yaml", { context: targetResult.output });
  await checkpoint(outputDir, records, stageRecord({ type: "contextualization", input_refs: [targetRef], output_ref: artifactRef(root, targetArtifact), provider: targetResult.provider, model: targetResult.model, prompt_version: targetResult.prompt_version, schema_version: "corus.context.v1", validation_status: "completed_valid_output", metrics: targetResult.metrics }));

  let clusterResult: ProviderResult<JobRequirementClusters>;
  try {
    clusterResult = await providers.clusterer.execute({
      job_description: targetResult.output,
      job_description_ref: targetRef,
      policy: jobRequirementClusteringPolicy,
      schema: jobRequirementClusterSchema()
    });
    clusterResult.output = validateJobRequirementClusterSchema(clusterResult.output, clusterResult.provider);
  } catch (error) {
    const status = classifyClusterProviderError(error);
    const rawErrorArtifact =
      error instanceof ProviderExecutionError && error.raw_output !== undefined
        ? await writeJsonArtifact(outputDir, "raw-02-job-requirement-clusters-provider-error.json", error.raw_output)
        : undefined;
    const errorArtifact = await writeYamlArtifact(outputDir, "02-job-requirement-clusters-error.yaml", { status, message: error instanceof Error ? error.message : "Unknown clustering error." });
    await checkpoint(outputDir, records, stageRecord({ type: "job_requirement_clustering", started_at: error instanceof ProviderExecutionError ? error.metadata?.started_at : undefined, completed_at: error instanceof ProviderExecutionError ? error.metadata?.completed_at : undefined, input_refs: [artifactRef(root, targetArtifact), jobRequirementClusteringPolicy.id], output_ref: artifactRef(root, errorArtifact), raw_output_ref: rawErrorArtifact ? artifactRef(root, rawErrorArtifact) : undefined, provider: error instanceof ProviderExecutionError ? error.provider : "gemini", model: error instanceof ProviderExecutionError ? error.metadata?.model ?? "unknown" : "unknown", prompt_version: error instanceof ProviderExecutionError ? error.metadata?.prompt_version ?? "cluster-job-requirements.gemini.v1" : "cluster-job-requirements.gemini.v1", schema_version: "corus.job_requirement_clusters.v1", validation_status: status, provider_completion_state: error instanceof ProviderExecutionError ? error.metadata?.provider_completion_state ?? null : null, metrics: error instanceof ProviderExecutionError && error.metadata?.metrics ? error.metadata.metrics : { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }, stop_reason: error instanceof ProviderExecutionError ? error.metadata?.stop_reason ?? null : null, model_operation: error instanceof ProviderExecutionError ? error.metadata?.model_operation : undefined }));
    return { run_id: runId, run_status: "failed", pipeline_status: status, objective_status: "not_evaluated", stage_status: { structured_context_preservation: "completed_valid_output", structured_job_description_preservation: "completed_valid_output", job_requirement_clustering: status, live_job_requirement_clustering: status, applicant_evidence_retrieval: "not_reached", shared_capability_claim_generation: "not_reached", shared_capability_validation: "not_reached", capability_admission: "not_reached", projection: "not_reached" }, contexts: { target: targetResult.output }, clusters: null, integrity: null, generation_records: records, artifact_dir: artifactRef(root, outputDir), error: { message: error instanceof Error ? error.message : "Unknown clustering error.", provider: error instanceof ProviderExecutionError ? error.provider : undefined, stage: "job_requirement_clustering" } };
  }

  const clusterArtifact = await writeYamlArtifact(outputDir, "02-job-requirement-clusters-proposed.yaml", clusterResult.output);
  const rawClusterArtifact = clusterResult.raw_output ? await writeJsonArtifact(outputDir, "raw-02-job-requirement-clusters-provider.json", clusterResult.raw_output) : undefined;
  await checkpoint(outputDir, records, stageRecord({ type: "job_requirement_clustering", started_at: clusterResult.started_at, completed_at: clusterResult.completed_at, input_refs: [artifactRef(root, targetArtifact), jobRequirementClusteringPolicy.id], output_ref: artifactRef(root, clusterArtifact), raw_output_ref: rawClusterArtifact ? artifactRef(root, rawClusterArtifact) : undefined, provider: clusterResult.provider, model: clusterResult.model, prompt_version: clusterResult.prompt_version, schema_version: "corus.job_requirement_clusters.v1", validation_status: "completed_valid_output", provider_completion_state: "completed", metrics: clusterResult.metrics, stop_reason: null, model_operation: clusterResult.model_operation }));

  const integrity = validateClusterIntegrity({
    original: targetResult.output,
    originalLedgerBefore: targetBefore,
    originalLedgerAfter: targetSource,
    proposal: clusterResult.output
  });
  const integrityArtifact = await writeYamlArtifact(outputDir, "03-cluster-integrity.yaml", { integrity });
  await checkpoint(outputDir, records, stageRecord({ type: "cluster_integrity_validation", input_refs: [artifactRef(root, clusterArtifact), artifactRef(root, targetArtifact)], output_ref: artifactRef(root, integrityArtifact), provider: "codex", model: "deterministic-cluster-integrity", prompt_version: "cluster-integrity.v1", schema_version: "corus.job_requirement_cluster_integrity.v1", validation_status: integrity.status === "structurally_invalid" ? "structurally_invalid" : "completed_valid_output", metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0, measurement_source: "measured" } }));

  if (integrity.status === "structurally_invalid") {
    return { run_id: runId, run_status: "failed", pipeline_status: "structurally_invalid", objective_status: "not_evaluated", stage_status: { structured_context_preservation: "completed_valid_output", structured_job_description_preservation: "completed_valid_output", job_requirement_clustering: "completed_valid_output", live_job_requirement_clustering: "completed_valid_output", cluster_integrity_validation: "structurally_invalid", applicant_evidence_retrieval: "not_reached", shared_capability_claim_generation: "not_reached", shared_capability_validation: "not_reached", capability_admission: "not_reached", projection: "not_reached" }, contexts: { target: targetResult.output }, clusters: clusterResult.output, integrity, generation_records: records, artifact_dir: artifactRef(root, outputDir) };
  }

  const clusterArtifactRef = artifactRef(root, clusterArtifact);
  const integrityArtifactRef = artifactRef(root, integrityArtifact);
  const reviewArtifact = await writeMarkdownArtifact(
    outputDir,
    "04-job-requirement-cluster-review.md",
    reviewMarkdown({
      target: targetResult.output,
      proposal: clusterResult.output,
      integrity,
      generationRecordsRef: artifactRef(root, await writeGenerationRecords(outputDir, records)),
      clusterArtifactRef,
      rawClusterArtifactRef: rawClusterArtifact ? artifactRef(root, rawClusterArtifact) : undefined,
      integrityArtifactRef
    })
  );
  await checkpoint(outputDir, records, stageRecord({ type: "cluster_admission", input_refs: [artifactRef(root, clusterArtifact), artifactRef(root, integrityArtifact)], output_ref: artifactRef(root, reviewArtifact), provider: "author", model: "jeremy-review", prompt_version: "cluster-admission.v1", schema_version: "corus.author_checkpoint.v1", validation_status: "awaiting_author", metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0, measurement_source: "measured" } }));
  const terminalStageStatus = { structured_context_preservation: "completed_valid_output" as const, structured_job_description_preservation: "completed_valid_output" as const, job_requirement_clustering: "completed_valid_output" as const, live_job_requirement_clustering: "completed_valid_output" as const, cluster_integrity_validation: "completed_valid_output" as const, cluster_admission: "awaiting_author" as const, applicant_evidence_retrieval: "not_reached" as const, shared_capability_claim_generation: "not_reached" as const, shared_capability_validation: "not_reached" as const, capability_admission: "not_reached" as const, projection: "not_reached" as const };
  await writeYamlArtifact(outputDir, "run-status.yaml", { run_status: "completed", pipeline_status: "awaiting_author", objective_status: "not_evaluated", stage_status: terminalStageStatus });

  return { run_id: runId, run_status: "completed", pipeline_status: "awaiting_author", objective_status: "not_evaluated", stage_status: terminalStageStatus, contexts: { target: targetResult.output }, clusters: clusterResult.output, integrity, generation_records: records, artifact_dir: artifactRef(root, outputDir), review_artifact_ref: artifactRef(root, reviewArtifact) };
}


export async function runJobRequirementClusterRepair(
  request: {
    original_run_id: string;
    target_source: unknown;
    previous_proposal_ref?: string;
    previous_integrity_ref?: string;
    mode?: "mocked" | "fixture" | "live";
  },
  options: { root?: string; providers: JobRequirementClusterRepairProviders }
): Promise<JobRequirementClusteringRunResponse> {
  const root = options.root ?? getProjectRoot();
  const repairRunId = randomUUID();
  const outputDir = await createRunDirectory(repairRunId, root);
  const records: StageGenerationRecord[] = [];
  const targetRef = sourceRefFromInput(request.target_source, "target_source");
  const targetSource = await readSourceInput(request.target_source, root);
  const targetBefore = JSON.parse(JSON.stringify(targetSource));
  const targetResult = contextProviderResult(targetSource, "target", "target", targetRef);
  const targetArtifact = await writeYamlArtifact(outputDir, "01-job-description-context.yaml", { context: targetResult.output });
  await checkpoint(outputDir, records, stageRecord({ type: "contextualization", input_refs: [targetRef], output_ref: artifactRef(root, targetArtifact), provider: targetResult.provider, model: targetResult.model, prompt_version: targetResult.prompt_version, schema_version: "corus.context.v1", validation_status: "completed_valid_output", metrics: targetResult.metrics }));

  const previousProposalRef = request.previous_proposal_ref ?? `outputs/${request.original_run_id}/02-job-requirement-clusters-proposed.yaml`;
  const previousIntegrityRef = request.previous_integrity_ref ?? `outputs/${request.original_run_id}/03-cluster-integrity.yaml`;
  const previousProposal = parse(await fs.readFile(path.join(root, previousProposalRef), "utf8")) as JobRequirementClusters;
  const previousIntegrityRaw = parse(await fs.readFile(path.join(root, previousIntegrityRef), "utf8")) as { integrity?: ClusterIntegrityResult } | ClusterIntegrityResult;
  const previousIntegrity = ("integrity" in previousIntegrityRaw && previousIntegrityRaw.integrity ? previousIntegrityRaw.integrity : previousIntegrityRaw) as ClusterIntegrityResult;
  const missingRequirementRefs = previousIntegrity.checks.missing_requirement_refs;
  const repairRequestRef = await writeYamlArtifact(outputDir, "02-job-requirement-cluster-repair-request.yaml", {
    original_run_id: request.original_run_id,
    previous_proposal_ref: previousProposalRef,
    previous_integrity_ref: previousIntegrityRef,
    missing_requirement_refs: missingRequirementRefs
  });

  let repairResult: ProviderResult<JobRequirementClusters>;
  try {
    repairResult = await options.providers.repairer.execute({
      job_description: targetResult.output,
      job_description_ref: targetRef,
      policy: jobRequirementClusteringPolicy,
      schema: jobRequirementClusterSchema(),
      previous_proposal: previousProposal,
      previous_proposal_ref: previousProposalRef,
      integrity_result: previousIntegrity,
      integrity_result_ref: previousIntegrityRef,
      missing_requirement_refs: missingRequirementRefs
    });
    repairResult.output = validateJobRequirementClusterSchema(repairResult.output, repairResult.provider, repairResult.prompt_version);
  } catch (error) {
    const status = classifyClusterProviderError(error);
    const rawErrorArtifact = error instanceof ProviderExecutionError && error.raw_output !== undefined ? await writeJsonArtifact(outputDir, "raw-03-job-requirement-cluster-repair-provider-error.json", error.raw_output) : undefined;
    const errorArtifact = await writeYamlArtifact(outputDir, "03-job-requirement-cluster-repair-error.yaml", { status, message: error instanceof Error ? error.message : "Unknown repair error." });
    await checkpoint(outputDir, records, stageRecord({ type: "job_requirement_cluster_repair", started_at: error instanceof ProviderExecutionError ? error.metadata?.started_at : undefined, completed_at: error instanceof ProviderExecutionError ? error.metadata?.completed_at : undefined, input_refs: [artifactRef(root, targetArtifact), previousProposalRef, previousIntegrityRef, artifactRef(root, repairRequestRef), jobRequirementClusteringPolicy.id], output_ref: artifactRef(root, errorArtifact), raw_output_ref: rawErrorArtifact ? artifactRef(root, rawErrorArtifact) : undefined, provider: error instanceof ProviderExecutionError ? error.provider : "gemini", model: error instanceof ProviderExecutionError ? error.metadata?.model ?? "unknown" : "unknown", prompt_version: error instanceof ProviderExecutionError ? error.metadata?.prompt_version ?? "cluster-job-requirements.gemini.repair.v1" : "cluster-job-requirements.gemini.repair.v1", schema_version: "corus.job_requirement_clusters.v1", validation_status: status, provider_completion_state: error instanceof ProviderExecutionError ? error.metadata?.provider_completion_state ?? null : null, metrics: error instanceof ProviderExecutionError && error.metadata?.metrics ? error.metadata.metrics : { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }, stop_reason: error instanceof ProviderExecutionError ? error.metadata?.stop_reason ?? null : null, model_operation: error instanceof ProviderExecutionError ? error.metadata?.model_operation : undefined }));
    const stageStatus = { structured_job_description_preservation: "completed_valid_output" as const, original_live_job_requirement_clustering: "structurally_invalid" as const, cluster_completeness_repair: status, applicant_evidence_retrieval: "not_reached" as const, shared_capability_claim_generation: "not_reached" as const, shared_capability_validation: "not_reached" as const, projection: "not_reached" as const };
    await writeYamlArtifact(outputDir, "run-status.yaml", { run_status: "failed", pipeline_status: status, objective_status: "not_evaluated", stage_status: stageStatus });
    return { run_id: repairRunId, run_status: "failed", pipeline_status: status, objective_status: "not_evaluated", stage_status: stageStatus, contexts: { target: targetResult.output }, clusters: null, integrity: null, generation_records: records, artifact_dir: artifactRef(root, outputDir), error: { message: error instanceof Error ? error.message : "Unknown repair error.", provider: error instanceof ProviderExecutionError ? error.provider : undefined, stage: "job_requirement_cluster_repair" } };
  }

  const repairedArtifact = await writeYamlArtifact(outputDir, "03-job-requirement-clusters-repaired.yaml", repairResult.output);
  const rawRepairArtifact = repairResult.raw_output ? await writeJsonArtifact(outputDir, "raw-03-job-requirement-cluster-repair-provider.json", repairResult.raw_output) : undefined;
  await checkpoint(outputDir, records, stageRecord({ type: "job_requirement_cluster_repair", started_at: repairResult.started_at, completed_at: repairResult.completed_at, input_refs: [artifactRef(root, targetArtifact), previousProposalRef, previousIntegrityRef, artifactRef(root, repairRequestRef), jobRequirementClusteringPolicy.id], output_ref: artifactRef(root, repairedArtifact), raw_output_ref: rawRepairArtifact ? artifactRef(root, rawRepairArtifact) : undefined, provider: repairResult.provider, model: repairResult.model, prompt_version: repairResult.prompt_version, schema_version: "corus.job_requirement_clusters.v1", validation_status: "completed_valid_output", provider_completion_state: "completed", metrics: repairResult.metrics, stop_reason: null, model_operation: repairResult.model_operation }));

  const integrity = validateClusterIntegrity({ original: targetResult.output, originalLedgerBefore: targetBefore, originalLedgerAfter: targetSource, proposal: repairResult.output });
  const integrityArtifact = await writeYamlArtifact(outputDir, "04-repaired-cluster-integrity.yaml", { integrity, previous_missing_requirement_refs: missingRequirementRefs, placements: placementSummary(repairResult.output, missingRequirementRefs) });
  await checkpoint(outputDir, records, stageRecord({ type: "repaired_cluster_integrity_validation", input_refs: [artifactRef(root, repairedArtifact), artifactRef(root, targetArtifact)], output_ref: artifactRef(root, integrityArtifact), provider: "codex", model: "deterministic-cluster-integrity", prompt_version: "cluster-integrity.repair.v1", schema_version: "corus.job_requirement_cluster_integrity.v1", validation_status: integrity.status === "structurally_invalid" ? "structurally_invalid" : "completed_valid_output", metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0, measurement_source: "measured" } }));

  if (integrity.status === "structurally_invalid") {
    const stageStatus = { structured_job_description_preservation: "completed_valid_output" as const, original_live_job_requirement_clustering: "structurally_invalid" as const, cluster_completeness_repair: "completed_valid_output" as const, repaired_cluster_integrity_validation: "structurally_invalid" as const, applicant_evidence_retrieval: "not_reached" as const, shared_capability_claim_generation: "not_reached" as const, shared_capability_validation: "not_reached" as const, projection: "not_reached" as const };
    await writeYamlArtifact(outputDir, "run-status.yaml", { run_status: "failed", pipeline_status: "structurally_invalid", objective_status: "not_evaluated", stage_status: stageStatus });
    return { run_id: repairRunId, run_status: "failed", pipeline_status: "structurally_invalid", objective_status: "not_evaluated", stage_status: stageStatus, contexts: { target: targetResult.output }, clusters: repairResult.output, integrity, generation_records: records, artifact_dir: artifactRef(root, outputDir) };
  }

  const generationRecordsRef = artifactRef(root, await writeGenerationRecords(outputDir, records));
  const reviewArtifact = await writeMarkdownArtifact(outputDir, "05-repaired-job-requirement-cluster-review.md", repairedReviewMarkdown({ originalRunId: request.original_run_id, repairRunId, target: targetResult.output, proposal: repairResult.output, integrity, missingRequirementRefs, rawRepairArtifactRef: rawRepairArtifact ? artifactRef(root, rawRepairArtifact) : undefined, repairedArtifactRef: artifactRef(root, repairedArtifact), repairedIntegrityArtifactRef: artifactRef(root, integrityArtifact), originalProposalRef: previousProposalRef, originalIntegrityRef: previousIntegrityRef, generationRecordsRef }));
  await checkpoint(outputDir, records, stageRecord({ type: "cluster_admission", input_refs: [artifactRef(root, repairedArtifact), artifactRef(root, integrityArtifact)], output_ref: artifactRef(root, reviewArtifact), provider: "author", model: "jeremy-review", prompt_version: "cluster-admission.repair.v1", schema_version: "corus.author_checkpoint.v1", validation_status: "awaiting_author", metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0, measurement_source: "measured" } }));
  const stageStatus = { structured_job_description_preservation: "completed_valid_output" as const, original_live_job_requirement_clustering: "structurally_invalid" as const, cluster_completeness_repair: "completed_valid_output" as const, repaired_cluster_integrity_validation: "completed_valid_output" as const, cluster_admission: "awaiting_author" as const, applicant_evidence_retrieval: "not_reached" as const, shared_capability_claim_generation: "not_reached" as const, shared_capability_validation: "not_reached" as const, projection: "not_reached" as const };
  await writeYamlArtifact(outputDir, "run-status.yaml", { run_status: "completed", pipeline_status: "awaiting_author", objective_status: "not_evaluated", stage_status: stageStatus });
  return { run_id: repairRunId, run_status: "completed", pipeline_status: "awaiting_author", objective_status: "not_evaluated", stage_status: stageStatus, contexts: { target: targetResult.output }, clusters: repairResult.output, integrity, generation_records: records, artifact_dir: artifactRef(root, outputDir), review_artifact_ref: artifactRef(root, reviewArtifact) };
}

export function allRequirementRefs(clusters: JobRequirementClusters): string[] {
  return [...clusters.clusters.flatMap((cluster: JobRequirementCluster) => cluster.requirement_refs), ...clusters.unassigned_requirement_refs];
}
