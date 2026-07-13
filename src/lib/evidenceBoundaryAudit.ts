import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { getProjectRoot } from "./paths.js";

export const auditedContextIds = [
  "jeremy_corus_python_workbench",
  "jeremy_corus_architecture_review_and_tradeoff_analysis",
  "jeremy_corus_permission_aware_agent_execution",
  "jeremy_aroko_contributor_leadership",
  "jeremy_aroko_web_migration_direction",
  "jeremy_new_inc_cultural_systems_research",
  "jeremy_new_inc_big_shot_music_curation"
] as const;

export type EvidenceDecision = "resolved" | "partially_resolved" | "unresolved" | "unsupported";

interface RunInput {
  root?: string;
  runId: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(root: string, relativePath: string): Promise<string> {
  return sha256(await fs.readFile(path.join(root, relativePath)));
}

async function readYaml<T>(file: string): Promise<T> {
  return parse(await fs.readFile(file, "utf8")) as T;
}

function contextById(applicant: { contexts?: Array<Record<string, unknown>> }): Map<string, Record<string, unknown>> {
  return new Map((applicant.contexts ?? []).filter((item) => typeof item.id === "string").map((item) => [String(item.id), item]));
}

function sourceRefs(context: Record<string, unknown>): string[] {
  const origin = context.origin as { evidence_source?: { source_refs?: unknown } } | undefined;
  const refs = origin?.evidence_source?.source_refs;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
}

function exactEvidence(context: Record<string, unknown>): string[] {
  const origin = context.origin as { evidence_source?: { exact_evidence?: unknown } } | undefined;
  const evidence = origin?.evidence_source?.exact_evidence;
  return Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === "string") : [];
}

function constraints(context: Record<string, unknown>): string[] {
  return Array.isArray(context.constraints) ? context.constraints.filter((item): item is string => typeof item === "string") : [];
}

function directResolutionByContext(resolution: { context_resolution?: Array<Record<string, unknown>> }) {
  return new Map((resolution.context_resolution ?? []).map((item) => [String(item.context_ref), item]));
}

function retrievalByContext(retrieval: { retrieval_results?: Array<Record<string, unknown>> }) {
  return new Map((retrieval.retrieval_results ?? []).map((item) => [String(item.context_ref), item]));
}

export function proposedPermittedIds(current: string[], proposals: Array<{ context_ref: string; proposed_status: EvidenceDecision }>): string[] {
  const proposed = new Set(current);
  for (const proposal of proposals) if (proposal.proposed_status === "resolved" || proposal.proposed_status === "partially_resolved") proposed.add(proposal.context_ref);
  return [...proposed].sort();
}

export function clustersAffectedByProposedEvidence(classification: { cluster_classifications?: Array<{ cluster_id: string; invalid_unresolved_evidence_refs?: Array<{ evidence_ref: string }> }> }, additions: string[]): string[] {
  const additionSet = new Set(additions);
  return [...new Set((classification.cluster_classifications ?? []).filter((cluster) => (cluster.invalid_unresolved_evidence_refs ?? []).some((ref) => additionSet.has(ref.evidence_ref))).map((cluster) => cluster.cluster_id))].sort();
}

export async function runEvidenceBoundaryAudit(input: RunInput) {
  const root = input.root ?? getProjectRoot();
  const runDir = path.join(root, "outputs", input.runId);
  const applicant = await readYaml<{ contexts?: Array<Record<string, unknown>> }>(path.join(root, "test/fixtures/prophet/jeremy_corus.yaml"));
  const direct = await readYaml<{ context_resolution?: Array<Record<string, unknown>> }>(path.join(runDir, "15-applicant-context-evidence-resolution.yaml"));
  const retrieval = await readYaml<{ retrieval_results?: Array<Record<string, unknown>>; repository_resolution?: Record<string, unknown> }>(path.join(runDir, "19-internal-lexical-retrieval-results.yaml"));
  const classification = await readYaml<{ permitted_evidence_context_ids?: string[]; cluster_classifications?: Array<{ cluster_id: string; invalid_unresolved_evidence_refs?: Array<{ evidence_ref: string }> }> }>(path.join(runDir, "30-pre-filter-baseline-capability-output-classification.yaml"));
  const byContext = contextById(applicant);
  const directByContext = directResolutionByContext(direct);
  const retrievalMap = retrievalByContext(retrieval);
  const currentPermitted = [...(classification.permitted_evidence_context_ids ?? [])].sort();

  const repoEvidence = [
    {
      id: "repo_ev_checkpoint_recovery",
      repository: "jeremy.domain.ai",
      commit_sha: "323446c",
      path: "scripts/reprocessAttempt2Validation.ts",
      content_hash: await fileHash(root, "scripts/reprocessAttempt2Validation.ts"),
      relevant_symbols_or_tests: ["reprocessAttempt2Validation", "OpenAI Responses extraction checkpoint recovery"],
      proves: "Persisted provider responses can be reprocessed locally and routed to architect checkpoints without rerunning providers.",
      supports_contexts: ["jeremy_corus_architecture_review_and_tradeoff_analysis"]
    },
    {
      id: "repo_ev_failure_routing",
      repository: "jeremy.domain.ai",
      commit_sha: "63a284e",
      path: "src/lib/corusCheckpointResume.ts",
      content_hash: await fileHash(root, "src/lib/corusCheckpointResume.ts"),
      relevant_symbols_or_tests: ["resumeFailureReroutingFromCheckpoint", "classifyProviderFailure", "retryAfterMilliseconds"],
      proves: "Failure classification, bounded retry, checkpoint preservation, and provider-unavailable outcomes are implemented as product architecture boundaries.",
      supports_contexts: ["jeremy_corus_architecture_review_and_tradeoff_analysis"]
    },
    {
      id: "repo_ev_direct_evidence_boundary",
      repository: "jeremy.domain.ai",
      commit_sha: "f1bfa1c31dfd3d15a8ee0c0d10c22171b5b23825",
      path: "src/lib/directEvidenceResolution.ts",
      content_hash: await fileHash(root, "src/lib/directEvidenceResolution.ts"),
      relevant_symbols_or_tests: ["resolveDirectEvidence", "matchEvidence", "source hashes and stable locations"],
      proves: "Direct evidence extraction, exact/normalized matching, unresolved-source preservation, and source-hash validation are implemented deterministically.",
      supports_contexts: ["jeremy_corus_architecture_review_and_tradeoff_analysis"]
    },
    {
      id: "repo_ev_pre_filter_boundary",
      repository: "jeremy.domain.ai",
      commit_sha: "uncommitted_worktree_checkpoint",
      path: "src/lib/prophetAdmittedCapabilityState.ts",
      content_hash: await fileHash(root, "src/lib/prophetAdmittedCapabilityState.ts"),
      relevant_symbols_or_tests: ["routeApplicantRecord", "compactApplicantContext", "clusterCapabilityProvenance"],
      proves: "The current worktree separates direct, lexical, and external-sourcing routes and preserves pre-filter Claude outputs as non-admissible baselines.",
      supports_contexts: ["jeremy_corus_architecture_review_and_tradeoff_analysis"],
      note: "Uncommitted implementation evidence; useful for Author review but not canonical applicant truth until committed."
    }
  ];

  const decisions = auditedContextIds.map((id) => {
    const context = byContext.get(id)!;
    const directItem = directByContext.get(id) ?? {};
    const retrievalItem = retrievalMap.get(id) ?? {};
    const base = {
      context_ref: id,
      claimed_statements: exactEvidence(context),
      declared_sources: sourceRefs(context),
      available_sources: Array.isArray((directItem as { statement_resolution?: Array<{ source_refs_checked?: string[] }> }).statement_resolution)
        ? [...new Set((directItem as { statement_resolution: Array<{ source_refs_checked?: string[] }> }).statement_resolution.flatMap((statement) => statement.source_refs_checked ?? []))]
        : [],
      unavailable_sources: Array.isArray(directItem.missing_source_refs) ? directItem.missing_source_refs : [],
      direct_resolution_status: directItem.resolution_status ?? null,
      selected_lexical_evidence_refs: Array.isArray(retrievalItem.selected_evidence_refs) ? retrievalItem.selected_evidence_refs : [],
      constraints: constraints(context)
    };
    if (id === "jeremy_corus_architecture_review_and_tradeoff_analysis") {
      return {
        ...base,
        exact_source_passages_or_code_locations: repoEvidence.map((item) => ({ id: item.id, repository: item.repository, commit_sha: item.commit_sha, path: item.path, content_hash: item.content_hash, relevant_symbols_or_tests: item.relevant_symbols_or_tests, proves: item.proves })),
        proof_scope: "part_of_claim",
        proposed_status: "partially_resolved" as EvidenceDecision,
        overclaim_risks: ["Does not prove the original corus-workbench review artifact unless that repository file is admitted.", "Does not prove deployed production ownership."]
      };
    }
    if (id === "jeremy_corus_python_workbench") {
      return { ...base, exact_source_passages_or_code_locations: [], proof_scope: "none", proposed_status: "unresolved" as EvidenceDecision, overclaim_risks: ["TypeScript orchestration in jeremy.domain.ai does not prove the claimed Python workbench.", "Declared corus-workbench Python files remain unavailable in this checkpoint."] };
    }
    if (id === "jeremy_corus_permission_aware_agent_execution") {
      return { ...base, exact_source_passages_or_code_locations: [], proof_scope: "none", proposed_status: "unresolved" as EvidenceDecision, overclaim_risks: ["No admitted implementation evidence of permission-aware agent execution, authorization, or disclosure enforcement is available.", "Do not use roadmap or sandbox policy text as implementation evidence."] };
    }
    if (id === "jeremy_new_inc_cultural_systems_research") {
      return { ...base, exact_source_passages_or_code_locations: [], proof_scope: "none", proposed_status: "unresolved" as EvidenceDecision, reconciliation_note: "The inventory source identity was directly resolved, but direct evidence extraction found no exact or normalized-exact support; absence from the permitted set is legitimate evidence insufficiency, not a permitted-set bug.", overclaim_risks: ["Available PDFs/docs do not currently prove the declared exact evidence statements."] };
    }
    if (id === "jeremy_new_inc_big_shot_music_curation") {
      return { ...base, exact_source_passages_or_code_locations: [], proof_scope: "none", proposed_status: "unresolved" as EvidenceDecision, overclaim_risks: ["Available Big Shot PDFs/docs do not currently prove the declared exact evidence statements.", "Do not infer professional responsibility beyond source text."] };
    }
    return { ...base, exact_source_passages_or_code_locations: [], proof_scope: "none", proposed_status: "unresolved" as EvidenceDecision, overclaim_risks: ["User assertion alone is not documentary evidence; classify as candidate confirmation only if Author policy permits."] };
  });

  const proposals = decisions.filter((decision) => decision.proposed_status === "partially_resolved" || decision.proposed_status === "resolved").map((decision) => ({
    context_ref: decision.context_ref,
    proposed_status: decision.proposed_status,
    apply_automatically: false,
    author_admission_required: true,
    rationale: "First-party repository evidence supports part of the existing bounded context, but applicant truth must not be mutated without Author admission."
  }));
  const proposedAdditions = proposals.map((proposal) => proposal.context_ref);
  const affectedClusters = clustersAffectedByProposedEvidence(classification, proposedAdditions);
  const preview = {
    schema_version: "corus.corrected_permitted_evidence_preview.v1",
    current_permitted_context_ids: currentPermitted,
    current_permitted_count: currentPermitted.length,
    proposed_additions: proposedAdditions,
    proposed_permitted_context_ids: proposedPermittedIds(currentPermitted, proposals),
    proposed_permitted_count: proposedPermittedIds(currentPermitted, proposals).length,
    records_remaining_unresolved: decisions.filter((decision) => decision.proposed_status === "unresolved" || decision.proposed_status === "unsupported").map((decision) => decision.context_ref),
    reasons: Object.fromEntries(decisions.map((decision) => [decision.context_ref, decision.proof_scope === "part_of_claim" ? "First-party repository evidence supports part of the context; Author admission required." : "No exact documentary support sufficient for positive capability derivation in current sources."])),
    capability_clusters_gaining_evidence_coverage: affectedClusters
  };
  const authorReview = {
    schema_version: "corus.author_evidence_admission_review.v1",
    status: "awaiting_author_evidence_admission",
    decisions_requested: proposals.map((proposal) => ({ context_ref: proposal.context_ref, proposed_status: proposal.proposed_status, options: ["admit", "admit_with_exceptions", "request_more_evidence", "reject"] })),
    non_admissible_baseline_policy: {
      pre_filter_claude_outputs_immutable: true,
      pre_filter_claude_outputs_may_enter_openai_validation: false,
      capability_regeneration_required_after_author_admission: true
    },
    resume_command_without_providers: `npm run audit:prophet:evidence-boundary -- --run-id ${input.runId}`,
    future_author_decision_command_without_providers: `npm run admit:prophet:evidence-boundary -- --run-id ${input.runId} --decision-file outputs/${input.runId}/author-evidence-admission-decision.yaml`
  };
  const markdown = [
    "# Author Evidence Admission Review",
    "",
    `Run: ${input.runId}`,
    "",
    "No provider output is admitted here. The nine pre-filter Claude cluster outputs remain immutable baseline artifacts and are blocked from OpenAI validation/capability admission.",
    "",
    "## Proposed Addition",
    "",
    proposals.length ? proposals.map((proposal) => `- ${proposal.context_ref}: ${proposal.proposed_status} (Author admission required)`).join("\n") : "- None",
    "",
    "## Remaining Unresolved",
    "",
    decisions.filter((decision) => decision.proposed_status === "unresolved" || decision.proposed_status === "unsupported").map((decision) => `- ${decision.context_ref}: ${decision.proposed_status}`).join("\n"),
    "",
    "## Clusters Affected",
    "",
    affectedClusters.length ? affectedClusters.map((cluster) => `- ${cluster}`).join("\n") : "- None"
  ].join("\n");

  const artifacts = [
    ["unresolved-context-source-audit.yaml", { schema_version: "corus.unresolved_context_source_audit.v1", status: "awaiting_author_evidence_admission", contexts: decisions }],
    ["repository-evidence-extracts.yaml", { schema_version: "corus.repository_evidence_extracts.v1", extracts: repoEvidence, corus_workbench_repository_refs: retrieval.repository_resolution ?? { resolved_refs: [], unavailable_refs: [] } }],
    ["evidence-status-change-proposals.yaml", { schema_version: "corus.evidence_status_change_proposals.v2", proposals }],
    ["corrected-permitted-evidence-preview.yaml", preview],
    ["author-evidence-admission-review.yaml", authorReview],
    ["author-evidence-admission-review.md", markdown]
  ] as const;
  for (const [filename, value] of artifacts) {
    await fs.writeFile(path.join(runDir, filename), typeof value === "string" ? value : stringify(value), "utf8");
  }
  return { decisions, proposals, preview, authorReview, artifact_refs: artifacts.map(([filename]) => `outputs/${input.runId}/${filename}`), status: "awaiting_author_evidence_admission" };
}
