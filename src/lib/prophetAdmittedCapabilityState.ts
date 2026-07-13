import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CapabilityCandidate, CapabilityReduction, CapabilityValidation, Context, StageGenerationRecord } from "../types.js";
import { AnthropicCapabilityReductionProvider, OpenAIValidationProvider, configuredModelIds, normalizeCapabilityReductionProvenance } from "../providers/liveProviders.js";
import { ProviderExecutionError } from "../providers/errors.js";
import { validateReductionOutput, validateReductionReferences } from "../providers/validators.js";
import { artifactRef, stageRecord, writeGenerationRecords, writeJsonArtifact } from "./corusArtifacts.js";
import { getProjectRoot } from "./paths.js";

export type RecordRoute = "direct_retrieval" | "internal_lexical_retrieval" | "external_sourcing_candidate" | "malformed";

interface InventoryRecord {
  context_ref: string;
  evidence_status: string;
  declared_source_refs: string[];
  resolved_source_refs: string[];
  unresolved_source_refs: string[];
  exact_evidence_count: number;
  constraints: string[];
}

interface DirectExtract {
  id: string;
  context_ref: string;
  source_ref: string;
  source_locator: string;
  source_hash: string;
  extraction_method: string;
  extracted_text: string;
  claimed_evidence: string;
  match_status: string;
  location: { page: number | null; line_start: number | null; line_end: number | null };
  constraints: string[];
}

interface ContextResolution {
  context_ref: string;
  resolution_status: string;
  supporting_extract_refs: string[];
  unresolved_reasons: string[];
  missing_source_refs: string[];
  constraints: string[];
}

interface AdmittedClusters {
  clusters: Array<{ id: string; label: string; requirement_refs: string[] }>;
  downstream_policy: { capability_derivation: { include: string[]; exclude: string[] }; candidate_confirmation: string[]; recruiter_question_inputs: string[] };
}

interface RetrievalChunk {
  id: string;
  source_ref: string;
  source_locator: string;
  source_hash: string;
  document_ref: string;
  chunk_index: number;
  content_hash: string;
  text: string;
  context_refs: string[];
  origin: "direct_extract" | "repository_file";
}

interface RetrievalResult {
  context_ref: string;
  route: RecordRoute;
  query: string;
  ranked_results: Array<{ chunk_ref: string; score: number; source_ref: string; source_locator: string; content_hash: string }>;
  selected_evidence_refs: string[];
  external_sourcing_candidate: boolean;
  unresolved_reasons: string[];
}

interface EvidenceBoundaryAdmission {
  schema_version: "corus.author_evidence_boundary_admission.v1";
  status: "completed_valid_output";
  permitted_evidence_context_ids: string[];
  unresolved_context_ids: string[];
  support_ceilings: Array<{ context_ref: string; support_ceiling_when_used_alone: "adjacent"; rule: string; evidence_status: string; permitted_scope: string; excluded_scope: string[] }>;
}

export interface DeterministicCapabilityValidationResult {
  status: "completed_valid_output" | "invalid_reference" | "support_ceiling_violation";
  cluster_id: string;
  capability_count: number;
  invalid_requirement_refs: Array<{ capability_id: string; requirement_ref: string }>;
  invalid_evidence_refs: Array<{ capability_id: string; evidence_ref: string }>;
  unresolved_evidence_refs: Array<{ capability_id: string; evidence_ref: string }>;
  support_ceiling_violations: Array<{ capability_id: string; evidence_refs: string[]; support: string; rule: string }>;
  provenance_violations?: Array<{ capability_id: string; field: string; expected: string; actual: string }>;
  provenance_normalized_by_adapter?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function terms(value: string): string[] {
  const stop = new Set(["and", "the", "with", "for", "from", "that", "this", "into", "through", "across", "able", "can", "not", "must", "should", "source", "evidence"]);
  return normalize(value).split(/\s+/).filter((term) => term.length > 2 && !stop.has(term));
}

function score(query: string, text: string): number {
  const q = terms(query);
  if (q.length === 0) return 0;
  const haystack = new Set(terms(text));
  const matched = q.filter((term) => haystack.has(term)).length;
  return Number((matched / q.length).toFixed(4));
}

function contextId(context: unknown): string | null {
  return isRecord(context) && typeof context.id === "string" ? context.id : null;
}

function contextText(context: unknown): string {
  if (!isRecord(context)) return "";
  return JSON.stringify({ skill: context.skill, outcome: context.outcome, relationship: context.relationship, exact_evidence: isRecord(context.origin) ? context.origin.evidence_source : undefined });
}

export function routeApplicantRecord(record: Pick<InventoryRecord, "evidence_status" | "resolved_source_refs" | "unresolved_source_refs">): RecordRoute {
  if (record.evidence_status === "malformed") return "malformed";
  if (record.evidence_status === "directly_resolved") return "direct_retrieval";
  if (record.evidence_status === "source_declared_search_required" && record.resolved_source_refs.length > 0) return "internal_lexical_retrieval";
  return "external_sourcing_candidate";
}

export function geminiSourcingCandidates(records: InventoryRecord[]): string[] {
  return records.filter((record) => routeApplicantRecord(record) === "external_sourcing_candidate").map((record) => record.context_ref);
}

async function readYaml<T>(file: string): Promise<T> {
  return parse(await fs.readFile(file, "utf8")) as T;
}

function filterContext(input: Context, ids: Set<string>, id: string, label: string): Context {
  const contexts = Array.isArray(input.content.contexts) ? input.content.contexts.filter((entry) => {
    const cid = contextId(entry);
    return cid ? ids.has(cid) : false;
  }) : [];
  return {
    ...input,
    id,
    label,
    content: {
      meta: isRecord(input.content.meta) ? { subject: input.content.meta.subject, context_count: contexts.length } : undefined,
      contexts
    },
    generation: {
      ...input.generation,
      provider: "fixture",
      model: "structured-context-ledger",
      prompt_version: "contextualize.preserve-admitted-ledger.v1"
    }
  };
}

function chunksFromExtracts(extracts: DirectExtract[]): RetrievalChunk[] {
  return extracts.map((extract, index) => ({
    id: `chunk_direct_${extract.id}`,
    source_ref: extract.source_ref,
    source_locator: extract.source_locator,
    source_hash: extract.source_hash,
    document_ref: extract.source_ref,
    chunk_index: index,
    content_hash: sha(extract.extracted_text),
    text: extract.extracted_text,
    context_refs: [extract.context_ref],
    origin: "direct_extract"
  }));
}

function repoRawUrl(repoUrl: string, ref: string, branch: string): string | null {
  const prefix = "corus-workbench/";
  if (!ref.startsWith(prefix)) return null;
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;
  const filePath = ref.slice(prefix.length);
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/${filePath}`;
}

async function fetchRepositoryFile(repoUrl: string, ref: string): Promise<{ locator: string; text: string } | null> {
  for (const branch of ["main", "master"]) {
    const url = repoRawUrl(repoUrl, ref, branch);
    if (!url) return null;
    const response = await fetch(url);
    if (response.ok) return { locator: url, text: await response.text() };
  }
  return null;
}

async function repositoryChunks(records: InventoryRecord[]): Promise<{ chunks: RetrievalChunk[]; resolved_refs: string[]; unavailable_refs: string[] }> {
  const repoUrl = records.flatMap((record) => record.declared_source_refs).find((ref) => ref === "https://github.com/jeremycapps/corus-workbench") ?? "https://github.com/jeremycapps/corus-workbench";
  const refs = [...new Set(records.flatMap((record) => record.declared_source_refs).filter((ref) => ref.startsWith("corus-workbench/") && !ref.endsWith("/")))];
  const chunks: RetrievalChunk[] = [];
  const resolved_refs: string[] = [];
  const unavailable_refs: string[] = [];
  for (const ref of refs) {
    try {
      const fetched = await fetchRepositoryFile(repoUrl, ref);
      if (!fetched) {
        unavailable_refs.push(ref);
        continue;
      }
      resolved_refs.push(ref);
      const sourceHash = sha(fetched.text);
      chunks.push({
        id: `chunk_repo_${sha(ref).slice(0, 12)}`,
        source_ref: ref,
        source_locator: fetched.locator,
        source_hash: sourceHash,
        document_ref: ref,
        chunk_index: 0,
        content_hash: sourceHash,
        text: fetched.text.slice(0, 6000),
        context_refs: records.filter((record) => record.declared_source_refs.includes(ref)).map((record) => record.context_ref),
        origin: "repository_file"
      });
    } catch {
      unavailable_refs.push(ref);
    }
  }
  return { chunks, resolved_refs, unavailable_refs };
}

function buildRetrievalResults(records: InventoryRecord[], resolutions: ContextResolution[], applicant: Context, chunks: RetrievalChunk[]): RetrievalResult[] {
  const byContext = new Map((Array.isArray(applicant.content.contexts) ? applicant.content.contexts : []).map((entry) => [contextId(entry), entry]));
  const directByContext = new Map(resolutions.map((resolution) => [resolution.context_ref, resolution]));
  return records.map((record) => {
    const route = routeApplicantRecord(record);
    const context = byContext.get(record.context_ref);
    const query = contextText(context);
    const ranked = chunks
      .map((chunk) => ({ chunk, score: chunk.context_refs.includes(record.context_ref) ? Math.max(0.85, score(query, chunk.text)) : score(query, chunk.text) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const direct = directByContext.get(record.context_ref)?.supporting_extract_refs ?? [];
    const selected = route === "direct_retrieval" ? direct.map((id) => `chunk_direct_${id}`) : ranked.filter((item) => item.score >= 0.25).slice(0, 4).map((item) => item.chunk.id);
    return {
      context_ref: record.context_ref,
      route,
      query,
      ranked_results: ranked.map((item) => ({ chunk_ref: item.chunk.id, score: item.score, source_ref: item.chunk.source_ref, source_locator: item.chunk.source_locator, content_hash: item.chunk.content_hash })),
      selected_evidence_refs: selected,
      external_sourcing_candidate: route === "external_sourcing_candidate",
      unresolved_reasons: directByContext.get(record.context_ref)?.unresolved_reasons ?? []
    };
  });
}

function coverage(records: InventoryRecord[], retrieval: RetrievalResult[], resolutions: ContextResolution[]) {
  const directBefore = records.filter((record) => record.evidence_status === "directly_resolved").length;
  const withSelected = retrieval.filter((result) => result.selected_evidence_refs.length > 0).length;
  return {
    before_lexical_retrieval: {
      directly_resolved_contexts: directBefore,
      partially_or_internally_retrievable_contexts: records.filter((record) => record.evidence_status === "source_declared_search_required").length,
      external_sourcing_candidates: records.filter((record) => routeApplicantRecord(record) === "external_sourcing_candidate").length
    },
    after_lexical_retrieval: {
      contexts_with_selected_evidence: withSelected,
      contexts_without_selected_evidence: records.length - withSelected,
      external_sourcing_candidates: retrieval.filter((result) => result.external_sourcing_candidate).map((result) => result.context_ref)
    },
    direct_resolution_status_counts: resolutions.reduce<Record<string, number>>((acc, item) => {
      acc[item.resolution_status] = (acc[item.resolution_status] ?? 0) + 1;
      return acc;
    }, {})
  };
}


function compactContextEntry(entry: unknown, selectedEvidence: string[]): unknown {
  if (!isRecord(entry)) return entry;
  return {
    id: entry.id,
    direction: entry.direction,
    origin: isRecord(entry.origin) ? {
      time: entry.origin.time,
      place: entry.origin.place,
      evidence_source: isRecord(entry.origin.evidence_source) ? {
        source_refs: entry.origin.evidence_source.source_refs,
        evidence_status: entry.origin.evidence_source.evidence_status,
        exact_evidence: entry.origin.evidence_source.exact_evidence,
        selected_evidence_refs: selectedEvidence
      } : undefined
    } : undefined,
    skill: entry.skill,
    outcome: entry.outcome,
    relationship: entry.relationship,
    recipient: entry.recipient,
    constraints: entry.constraints
  };
}

function compactPermittedContextEntry(entry: unknown, selectedEvidence: string[], policy: { evidenceStatus: string; supportCeiling?: string; selectedEvidenceDetails?: unknown[] }): unknown {
  const compact = compactContextEntry(entry, selectedEvidence);
  if (!isRecord(compact)) return compact;
  return {
    ...compact,
    evidence_policy: {
      evidence_status: policy.evidenceStatus,
      support_ceiling_when_used_alone: policy.supportCeiling ?? null,
      selected_evidence_details: policy.selectedEvidenceDetails ?? []
    }
  };
}

function compactApplicantContext(input: Context, retrieval: RetrievalResult[]): { context: Context; excluded_contexts: Array<{ context_ref: string; reason: string; route: RecordRoute }> } {
  const selectedByContext = new Map(retrieval.map((result) => [result.context_ref, result.selected_evidence_refs]));
  const routeByContext = new Map(retrieval.map((result) => [result.context_ref, result.route]));
  const included: unknown[] = [];
  const excluded_contexts: Array<{ context_ref: string; reason: string; route: RecordRoute }> = [];
  for (const entry of Array.isArray(input.content.contexts) ? input.content.contexts : []) {
    const id = contextId(entry) ?? "(missing_context_id)";
    const selected = selectedByContext.get(id) ?? [];
    const route = routeByContext.get(id) ?? "malformed";
    if (selected.length > 0 && route !== "external_sourcing_candidate" && route !== "malformed") {
      included.push(compactContextEntry(entry, selected));
    } else {
      excluded_contexts.push({ context_ref: id, route, reason: selected.length === 0 ? "no_selected_resolved_evidence" : "not_eligible_for_positive_capability_derivation" });
    }
  }
  return {
    context: {
      ...input,
      content: {
        meta: isRecord(input.content.meta) ? { subject: input.content.meta.subject, context_count: included.length } : undefined,
        contexts: included
      }
    },
    excluded_contexts
  };
}

function compactApplicantContextForAdmission(input: Context, retrieval: RetrievalResult[], admission: EvidenceBoundaryAdmission, repositoryEvidence: Array<Record<string, unknown>> = []): { context: Context; excluded_contexts: Array<{ context_ref: string; reason: string; route: RecordRoute }> } {
  const selectedByContext = new Map(retrieval.map((result) => [result.context_ref, result.selected_evidence_refs]));
  const routeByContext = new Map(retrieval.map((result) => [result.context_ref, result.route]));
  const permitted = new Set(admission.permitted_evidence_context_ids);
  const partial = new Map(admission.support_ceilings.map((ceiling) => [ceiling.context_ref, ceiling]));
  const repositoryEvidenceByContext = new Map<string, Record<string, unknown>[]>();
  for (const evidence of repositoryEvidence) {
    const supports = Array.isArray(evidence.supports_contexts) ? evidence.supports_contexts.filter((item): item is string => typeof item === "string") : [];
    for (const contextRef of supports) {
      const existing = repositoryEvidenceByContext.get(contextRef) ?? [];
      existing.push(evidence);
      repositoryEvidenceByContext.set(contextRef, existing);
    }
  }
  const included: unknown[] = [];
  const excluded_contexts: Array<{ context_ref: string; reason: string; route: RecordRoute }> = [];
  for (const entry of Array.isArray(input.content.contexts) ? input.content.contexts : []) {
    const id = contextId(entry) ?? "(missing_context_id)";
    const repositoryEvidenceDetails = repositoryEvidenceByContext.get(id) ?? [];
    const selected = (selectedByContext.get(id) ?? []).length > 0 ? selectedByContext.get(id)! : repositoryEvidenceDetails.map((item) => String(item.id)).filter(Boolean);
    const route = routeByContext.get(id) ?? "malformed";
    if (!permitted.has(id)) {
      excluded_contexts.push({ context_ref: id, route, reason: "not_author_admitted_for_positive_capability_derivation" });
      continue;
    }
    if (selected.length > 0 && route !== "external_sourcing_candidate" && route !== "malformed") {
      const ceiling = partial.get(id);
      included.push(compactPermittedContextEntry(entry, selected, { evidenceStatus: ceiling?.evidence_status ?? "resolved", supportCeiling: ceiling?.support_ceiling_when_used_alone, selectedEvidenceDetails: repositoryEvidenceDetails }));
    } else {
      excluded_contexts.push({ context_ref: id, route, reason: selected.length === 0 ? "no_selected_resolved_evidence" : "not_eligible_for_positive_capability_derivation" });
    }
  }
  return {
    context: {
      ...input,
      content: {
        meta: isRecord(input.content.meta) ? { subject: input.content.meta.subject, context_count: included.length } : undefined,
        contexts: included
      }
    },
    excluded_contexts
  };
}

function contextIdsFromContext(context: Context): string[] {
  return Array.isArray(context.content.contexts) ? context.content.contexts.map((entry) => contextId(entry)).filter((id): id is string => Boolean(id)) : [];
}

export function validateCapabilityEvidencePolicy(input: {
  clusterId: string;
  reduction: CapabilityReduction;
  allowedRequirementIds: string[];
  permittedEvidenceIds: string[];
  unresolvedEvidenceIds: string[];
  partialEvidenceIds: string[];
  generationRecord?: Pick<StageGenerationRecord, "provider" | "model" | "prompt_version">;
  provenanceNormalizedByAdapter?: boolean;
}): DeterministicCapabilityValidationResult {
  const allowedRequirements = new Set(input.allowedRequirementIds);
  const permittedEvidence = new Set(input.permittedEvidenceIds);
  const unresolvedEvidence = new Set(input.unresolvedEvidenceIds);
  const partialEvidence = new Set(input.partialEvidenceIds);
  const invalid_requirement_refs: DeterministicCapabilityValidationResult["invalid_requirement_refs"] = [];
  const invalid_evidence_refs: DeterministicCapabilityValidationResult["invalid_evidence_refs"] = [];
  const unresolved_evidence_refs: DeterministicCapabilityValidationResult["unresolved_evidence_refs"] = [];
  const support_ceiling_violations: DeterministicCapabilityValidationResult["support_ceiling_violations"] = [];
  const provenance_violations: NonNullable<DeterministicCapabilityValidationResult["provenance_violations"]> = [];

  for (const capability of input.reduction.capabilities) {
    if (!allowedRequirements.has(capability.requirement_ref)) invalid_requirement_refs.push({ capability_id: capability.id, requirement_ref: capability.requirement_ref });
    for (const ref of capability.evidence_refs) {
      if (unresolvedEvidence.has(ref)) unresolved_evidence_refs.push({ capability_id: capability.id, evidence_ref: ref });
      if (!permittedEvidence.has(ref)) invalid_evidence_refs.push({ capability_id: capability.id, evidence_ref: ref });
    }
    if (capability.support === "supported") {
      const nonPartialEvidence = capability.evidence_refs.filter((ref) => permittedEvidence.has(ref) && !partialEvidence.has(ref));
      if (capability.evidence_refs.length > 0 && nonPartialEvidence.length === 0 && capability.evidence_refs.some((ref) => partialEvidence.has(ref))) {
        support_ceiling_violations.push({ capability_id: capability.id, evidence_refs: capability.evidence_refs, support: capability.support, rule: "partially_resolved evidence used alone cannot support above adjacent." });
      }
    }
    if (input.generationRecord) {
      const expected = input.generationRecord;
      if (capability.generated_by.provider !== expected.provider) provenance_violations.push({ capability_id: capability.id, field: "provider", expected: expected.provider, actual: capability.generated_by.provider });
      if (capability.generated_by.model !== expected.model) provenance_violations.push({ capability_id: capability.id, field: "model", expected: expected.model, actual: capability.generated_by.model });
      if (capability.generated_by.prompt_version !== expected.prompt_version) provenance_violations.push({ capability_id: capability.id, field: "prompt_version", expected: expected.prompt_version, actual: capability.generated_by.prompt_version });
    }
  }
  const status = invalid_requirement_refs.length > 0 || invalid_evidence_refs.length > 0 || unresolved_evidence_refs.length > 0 || provenance_violations.length > 0
    ? "invalid_reference"
    : support_ceiling_violations.length > 0
      ? "support_ceiling_violation"
      : "completed_valid_output";
  return { status, cluster_id: input.clusterId, capability_count: input.reduction.capabilities.length, invalid_requirement_refs, invalid_evidence_refs, unresolved_evidence_refs, support_ceiling_violations, provenance_violations, provenance_normalized_by_adapter: input.provenanceNormalizedByAdapter ?? false };
}

function admittedRequirementIds(clusters: AdmittedClusters): Set<string> {
  const include = new Set(clusters.downstream_policy.capability_derivation.include);
  return new Set(clusters.clusters.filter((cluster) => include.has(cluster.id)).flatMap((cluster) => cluster.requirement_refs));
}

function admissionReview(reduction: CapabilityReduction, validation: CapabilityValidation) {
  const rejected = new Set(validation.rejected_capability_ids);
  const validated = new Set(validation.validated_capability_ids);
  return reduction.capabilities.map((capability) => ({
    capability_id: capability.id,
    requirement_ref: capability.requirement_ref,
    support: capability.support,
    confidence: capability.confidence,
    proposed_decision: rejected.has(capability.id) || capability.support === "unsupported" || capability.support === "unknown" ? "reject" : validated.has(capability.id) ? "admit" : "author_review",
    rationale: "Deterministic proposal from support state and OpenAI validation membership; Author admission is not applied automatically."
  }));
}

function statusCounts(capabilities: CapabilityCandidate[]) {
  return capabilities.reduce<Record<string, number>>((acc, capability) => {
    acc[capability.support] = (acc[capability.support] ?? 0) + 1;
    return acc;
  }, {});
}

export async function runProphetAdmittedCapabilityState(input: { root?: string; runId: string }): Promise<{ status: string; author_action_required: boolean; summary: unknown; generation_records: StageGenerationRecord[]; artifact_refs: string[] }> {
  const root = input.root ?? getProjectRoot();
  const runDir = path.join(root, "outputs", input.runId);
  const applicantPath = path.join(root, "test/fixtures/prophet/jeremy_corus.yaml");
  const applicantBefore = await fs.readFile(applicantPath, "utf8");
  const admitted = await readYaml<AdmittedClusters>(path.join(runDir, "08-admitted-job-requirement-clusters.yaml"));
  const inventory = await readYaml<{ records: InventoryRecord[]; applicant_context_ref: string }>(path.join(runDir, "12-applicant-evidence-inventory.yaml"));
  const direct = await readYaml<{ extracts: DirectExtract[]; context_resolution: ContextResolution[] }>(path.join(runDir, "14-direct-evidence-extracts.yaml"));
  const directResolution = await readYaml<{ context_resolution: ContextResolution[] }>(path.join(runDir, "15-applicant-context-evidence-resolution.yaml"));
  const applicantRaw = parse(applicantBefore);
  const targetRaw = await readYaml<{ context: Context }>(path.join(runDir, "01-job-description-context.yaml"));
  const applicantContext: Context = {
    id: "prophet_admitted_applicant_evidence_context",
    kind: "subject",
    label: "Jeremy Capps admitted applicant evidence context",
    sources: ["test/fixtures/prophet/jeremy_corus.yaml", artifactRef(root, path.join(runDir, "14-direct-evidence-extracts.yaml")), artifactRef(root, path.join(runDir, "19-internal-lexical-retrieval-results.yaml"))],
    content: applicantRaw,
    generation: { operation: "contextualize", provider: "fixture", model: "structured-context-ledger", prompt_version: "contextualize.preserve-ledger.v1", input_refs: ["test/fixtures/prophet/jeremy_corus.yaml"], schema_version: "corus.context.v1", created_at: new Date().toISOString() }
  };
  const requirementIds = admittedRequirementIds(admitted);
  const targetContext = filterContext(targetRaw.context, requirementIds, "prophet_admitted_capability_derivation_requirements", "Prophet admitted capability derivation requirements");
  const routeAudit = inventory.records.map((record) => ({ context_ref: record.context_ref, route: routeApplicantRecord(record), evidence_status: record.evidence_status, gemini_candidate: routeApplicantRecord(record) === "external_sourcing_candidate" }));
  const repo = await repositoryChunks(inventory.records);
  const chunks = [...chunksFromExtracts(direct.extracts), ...repo.chunks];
  const retrieval = buildRetrievalResults(inventory.records, directResolution.context_resolution, applicantContext, chunks);
  const coverageReport = coverage(inventory.records, retrieval, directResolution.context_resolution);
  const indexArtifact = { schema_version: "corus.internal_lexical_index.v1", retrieval_method: "deterministic_term_overlap", chunks };
  const retrievalArtifact = { schema_version: "corus.internal_lexical_retrieval.v1", retrieval_method: "deterministic_term_overlap", route_audit: routeAudit, retrieval_results: retrieval, repository_resolution: repo, provider_calls_made: [] };
  await fs.writeFile(path.join(runDir, "18-internal-lexical-index.yaml"), stringify(indexArtifact), "utf8");
  await fs.writeFile(path.join(runDir, "19-internal-lexical-retrieval-results.yaml"), stringify(retrievalArtifact), "utf8");
  await fs.writeFile(path.join(runDir, "20-evidence-coverage.yaml"), stringify({ schema_version: "corus.evidence_coverage.v1", ...coverageReport }), "utf8");
  await fs.writeFile(path.join(runDir, "21-unresolved-source-report.yaml"), stringify({ schema_version: "corus.unresolved_source_report.v1", external_sourcing_candidates: geminiSourcingCandidates(inventory.records), unavailable_sources: [...new Set(retrieval.flatMap((result) => result.unresolved_reasons))], gemini_called: false }), "utf8");
  await fs.writeFile(path.join(runDir, "22-admitted-subject-context.yaml"), stringify({ context: applicantContext }), "utf8");
  await fs.writeFile(path.join(runDir, "23-admitted-target-context.yaml"), stringify({ context: targetContext, cluster_refs: admitted.downstream_policy.capability_derivation.include, requirement_count: requirementIds.size }), "utf8");

  const generationRecordsPath = path.join(runDir, "generation-records.json");
  let records: StageGenerationRecord[] = [];
  try {
    records = JSON.parse(await fs.readFile(generationRecordsPath, "utf8")) as StageGenerationRecord[];
  } catch {
    records = [];
  }
  const reducer = new AnthropicCapabilityReductionProvider();
  const providerSubject = compactApplicantContext(applicantContext, retrieval);
  const providerApplicantContext = providerSubject.context;
  await fs.writeFile(path.join(runDir, "22-admitted-subject-context.yaml"), stringify({ context: providerApplicantContext }), "utf8");
  await fs.writeFile(path.join(runDir, "22-admitted-subject-context-exclusions.yaml"), stringify({ schema_version: "corus.admitted_subject_context_exclusions.v1", excluded_contexts: providerSubject.excluded_contexts }), "utf8");
  const subjectIds = Array.isArray(providerApplicantContext.content.contexts) ? providerApplicantContext.content.contexts.map((entry) => contextId(entry)).filter((id): id is string => Boolean(id)) : [];
  const aggregateCapabilities: CapabilityCandidate[] = [];
  const includedClusters = admitted.clusters.filter((cluster) => admitted.downstream_policy.capability_derivation.include.includes(cluster.id));
  for (const cluster of includedClusters) {
    const clusterTarget = filterContext(targetRaw.context, new Set(cluster.requirement_refs), `prophet_${cluster.id}_requirements`, `Prophet ${cluster.label} requirements`);
    const clusterTargetPath = path.join(runDir, `23-target-context-${cluster.id}.yaml`);
    await fs.writeFile(clusterTargetPath, stringify({ context: clusterTarget, cluster_ref: cluster.id, requirement_refs: cluster.requirement_refs }), "utf8");
    const rawName = `raw-24-capability-candidates-provider-${cluster.id}.json`;
    const capabilityName = `24-capability-candidates-${cluster.id}.yaml`;
    const capabilityPath = path.join(runDir, capabilityName);
    try {
      const existing = await readYaml<CapabilityReduction>(capabilityPath);
      validateReductionReferences(existing, { subject: providerApplicantContext, target: clusterTarget }, "anthropic");
      aggregateCapabilities.push(...existing.capabilities);
      continue;
    } catch {
      // Missing or invalid cluster artifacts are regenerated for this cluster only.
    }
    const reductionInput = { contexts: { subject: providerApplicantContext, target: clusterTarget }, valid_subject_evidence_ids: subjectIds, valid_target_requirement_ids: cluster.requirement_refs };
    const reductionResult = await reducer.execute(reductionInput);
    await writeJsonArtifact(runDir, rawName, reductionResult.raw_output ?? {});
    const clusterReduction = validateReductionReferences(reductionResult.output, { subject: providerApplicantContext, target: clusterTarget }, "anthropic");
    await fs.writeFile(capabilityPath, stringify(clusterReduction), "utf8");
    aggregateCapabilities.push(...clusterReduction.capabilities);
    records.push(stageRecord({ type: "capability_reduction", input_refs: [artifactRef(root, path.join(runDir, "22-admitted-subject-context.yaml")), artifactRef(root, clusterTargetPath)], output_ref: artifactRef(root, capabilityPath), raw_output_ref: artifactRef(root, path.join(runDir, rawName)), provider: reductionResult.provider, model: reductionResult.model, prompt_version: reductionResult.prompt_version, schema_version: "corus.capability_reduction.v1", validation_status: "completed_valid_output", metrics: reductionResult.metrics, model_operation: reductionResult.model_operation }));
    await writeGenerationRecords(runDir, records);
  }
  const reduction: CapabilityReduction = { reducer: "capabilities", inputs: { subject: providerApplicantContext.id, target: targetContext.id }, capabilities: aggregateCapabilities };
  await fs.writeFile(path.join(runDir, "24-capability-candidates.yaml"), stringify(reduction), "utf8");
  const validator = new OpenAIValidationProvider();
  const validationResult = await validator.execute({ contexts: { subject: providerApplicantContext, target: targetContext }, capabilities: reduction.capabilities });
  await writeJsonArtifact(runDir, "raw-25-capability-validation-provider.json", validationResult.raw_output ?? {});
  const validation = validationResult.output;
  await fs.writeFile(path.join(runDir, "25-capability-validation.yaml"), stringify(validation), "utf8");
  records.push(stageRecord({ type: "capability_validation", input_refs: [artifactRef(root, path.join(runDir, "24-capability-candidates.yaml"))], output_ref: artifactRef(root, path.join(runDir, "25-capability-validation.yaml")), raw_output_ref: artifactRef(root, path.join(runDir, "raw-25-capability-validation-provider.json")), provider: validationResult.provider, model: validationResult.model, prompt_version: validationResult.prompt_version, schema_version: "corus.validation.v1", validation_status: validation.status, metrics: validationResult.metrics, model_operation: validationResult.model_operation }));
  await writeGenerationRecords(runDir, records);

  const review = admissionReview(reduction, validation);
  const authorActionRequired = validation.status !== "passed" || review.some((item) => item.proposed_decision === "author_review");
  await fs.writeFile(path.join(runDir, "26-capability-admission-review.yaml"), stringify({ schema_version: "corus.capability_admission_review.v1", author_action_required: authorActionRequired, proposed_deterministic_admission_decisions: review, resume_command: `npm run continue:prophet:capability-state -- --run-id ${input.runId} --from-author-review` }), "utf8");
  const summary = { schema_version: "corus.admitted_candidate_capability_state_summary.v1", pipeline_status: authorActionRequired ? "awaiting_author_capability_admission" : "ready_for_capability_admission", capability_derivation_clusters_accounted_for: admitted.downstream_policy.capability_derivation.include, excluded_clusters: admitted.downstream_policy.capability_derivation.exclude, retrieval_coverage: coverageReport, repository_evidence_successfully_resolved: repo.resolved_refs, remaining_external_sourcing_candidates: geminiSourcingCandidates(inventory.records), capability_counts_by_support_status: statusCounts(reduction.capabilities), validation_status: validation.status, validation_findings: validation.findings, author_action_required: authorActionRequired, provider_calls_made: records.map((record) => ({ provider: record.provider, model: record.model, prompt_version: record.prompt_version, metrics: record.metrics })), artifact_refs: ["18-internal-lexical-index.yaml", "19-internal-lexical-retrieval-results.yaml", "20-evidence-coverage.yaml", "21-unresolved-source-report.yaml", "22-admitted-subject-context.yaml", "22-admitted-subject-context-exclusions.yaml", "23-admitted-target-context.yaml", "24-capability-candidates.yaml", "25-capability-validation.yaml", "26-capability-admission-review.yaml"].map((name) => artifactRef(root, path.join(runDir, name))) };
  await fs.writeFile(path.join(runDir, "27-admitted-capability-state-summary.yaml"), stringify(summary), "utf8");
  const applicantAfter = await fs.readFile(applicantPath, "utf8");
  if (applicantBefore !== applicantAfter) throw new Error("Applicant ledger mutated during admitted capability-state run.");
  return { status: authorActionRequired ? "awaiting_author_capability_admission" : "ready_for_capability_admission", author_action_required: authorActionRequired, summary, generation_records: records, artifact_refs: (summary as { artifact_refs: string[] }).artifact_refs };
}

export async function preflightAdmittedCapabilityState(input: { root?: string; runId: string }) {
  const root = input.root ?? getProjectRoot();
  const runDir = path.join(root, "outputs", input.runId);
  const required = ["08-admitted-job-requirement-clusters.yaml", "11-applicant-source-manifest.yaml", "12-applicant-evidence-inventory.yaml", "14-direct-evidence-extracts.yaml", "15-applicant-context-evidence-resolution.yaml", "16-direct-evidence-resolution-summary.yaml", "17-evidence-status-change-proposals.yaml"];
  const missing: string[] = [];
  for (const name of required) {
    try { await fs.access(path.join(runDir, name)); } catch { missing.push(name); }
  }
  return { run_id: input.runId, missing_artifacts: missing, configured_models: configuredModelIds() };
}

export async function runProphetAdmittedCapabilityStateSafely(input: { root?: string; runId: string }) {
  try {
    return await runProphetAdmittedCapabilityState(input);
  } catch (error) {
    const root = input.root ?? getProjectRoot();
    const runDir = path.join(root, "outputs", input.runId);
    const failure = { schema_version: "corus.admitted_capability_state_failure.v1", status: "blocked", message: error instanceof Error ? error.message : String(error), provider: error instanceof ProviderExecutionError ? error.provider : undefined, raw_output_ref: error instanceof ProviderExecutionError ? artifactRef(root, path.join(runDir, "raw-provider-error.json")) : undefined };
    if (error instanceof ProviderExecutionError && error.raw_output !== undefined) await writeJsonArtifact(runDir, "raw-provider-error.json", error.raw_output);
    await fs.writeFile(path.join(runDir, "27-admitted-capability-state-summary.yaml"), stringify(failure), "utf8");
    throw error;
  }
}

export function admittedDerivationClustersForReview(admitted: Pick<AdmittedClusters, "clusters" | "downstream_policy">) {
  const include = new Set(admitted.downstream_policy.capability_derivation.include);
  return admitted.clusters.filter((cluster) => include.has(cluster.id)).map((cluster) => ({ id: cluster.id, requirement_refs: cluster.requirement_refs }));
}

export function excludedClustersForReview(admitted: Pick<AdmittedClusters, "downstream_policy">): string[] {
  return [...admitted.downstream_policy.capability_derivation.exclude];
}

export function clusterCapabilityProvenance(input: Array<{ cluster_id: string; requirement_refs: string[]; reduction: CapabilityReduction }>) {
  return input.flatMap((item) => item.reduction.capabilities.map((capability) => ({ capability_id: capability.id, cluster_id: item.cluster_id, requirement_ref: capability.requirement_ref, requirement_ref_admitted_for_cluster: item.requirement_refs.includes(capability.requirement_ref), evidence_refs: capability.evidence_refs })));
}

export function completedClusterIdsFromRecords(records: StageGenerationRecord[]): string[] {
  return records
    .filter((record) => record.type === "capability_reduction" && record.validation_status === "completed_valid_output")
    .map((record) => record.output_ref.match(/24-capability-candidates-(.+)\.yaml$/)?.[1])
    .filter((id): id is string => Boolean(id));
}

export async function applyAuthorEvidenceBoundaryDecision(input: { root?: string; runId: string; decisionFile: string }) {
  const root = input.root ?? getProjectRoot();
  const runDir = path.join(root, "outputs", input.runId);
  const decisionPath = path.isAbsolute(input.decisionFile) ? input.decisionFile : path.join(root, input.decisionFile);
  const decision = await readYaml<Record<string, unknown>>(decisionPath);
  const classification = await readYaml<{ permitted_evidence_context_ids?: string[] }>(path.join(runDir, "30-pre-filter-baseline-capability-output-classification.yaml"));
  const admittedContext = "jeremy_corus_architecture_review_and_tradeoff_analysis";
  const unresolved = [
    "jeremy_corus_python_workbench",
    "jeremy_corus_permission_aware_agent_execution",
    "jeremy_aroko_contributor_leadership",
    "jeremy_aroko_web_migration_direction",
    "jeremy_new_inc_cultural_systems_research",
    "jeremy_new_inc_big_shot_music_curation"
  ];
  const admittedDecision = decision[admittedContext] as Record<string, unknown> | undefined;
  if (!admittedDecision || admittedDecision.decision !== "admit_with_constraints" || admittedDecision.evidence_status !== "partially_resolved") {
    throw new Error(`Author decision for ${admittedContext} must be admit_with_constraints with partially_resolved evidence_status.`);
  }
  const permitted = [...new Set([...(classification.permitted_evidence_context_ids ?? []), admittedContext])].sort();
  if (permitted.length !== 10) throw new Error(`Permitted evidence context count must be 10 after admission; got ${permitted.length}.`);
  const leaked = unresolved.filter((id) => permitted.includes(id));
  if (leaked.length > 0) throw new Error(`Unresolved contexts cannot be admitted: ${leaked.join(", ")}`);
  const admission: EvidenceBoundaryAdmission = {
    schema_version: "corus.author_evidence_boundary_admission.v1",
    status: "completed_valid_output",
    permitted_evidence_context_ids: permitted,
    unresolved_context_ids: unresolved,
    support_ceilings: [
      {
        context_ref: admittedContext,
        evidence_status: "partially_resolved",
        support_ceiling_when_used_alone: "adjacent",
        permitted_scope: String(admittedDecision.permitted_scope ?? ""),
        excluded_scope: Array.isArray(admittedDecision.excluded_scope) ? admittedDecision.excluded_scope.filter((item): item is string => typeof item === "string") : [],
        rule: String(admittedDecision.rule ?? "A capability supported solely by this context cannot be classified above adjacent.")
      }
    ]
  };
  const artifactPath = path.join(runDir, "31-author-evidence-boundary-admission.yaml");
  await fs.writeFile(artifactPath, stringify(admission), "utf8");
  const summary = {
    schema_version: "corus.evidence_boundary_admission_summary.v1",
    pipeline_status: "ready_for_filtered_capability_regeneration",
    permitted_evidence_context_count: permitted.length,
    permitted_evidence_context_ids: permitted,
    unresolved_context_ids: unresolved,
    pre_filter_baseline_outputs_immutable: true,
    pre_filter_baseline_outputs_admissible: false,
    support_ceilings: admission.support_ceilings
  };
  await fs.writeFile(path.join(runDir, "32-evidence-boundary-admission-summary.yaml"), stringify(summary), "utf8");
  return { status: "ready_for_filtered_capability_regeneration", admission, artifact_refs: [artifactRef(root, artifactPath), artifactRef(root, path.join(runDir, "32-evidence-boundary-admission-summary.yaml"))] };
}

function isTransientProviderError(error: unknown): boolean {
  if (!(error instanceof ProviderExecutionError)) return false;
  const raw = JSON.stringify(error.raw_output ?? {}).toLowerCase();
  const message = error.message.toLowerCase();
  return message.includes("429") || message.includes("rate") || message.includes("timeout") || raw.includes("rate_limit") || raw.includes("overloaded") || raw.includes("timeout");
}

export function filteredArtifactNames(clusterId: string) {
  return {
    target: `33-filtered_attempt_1-target-context-${clusterId}.yaml`,
    raw: `33-filtered_attempt_1-raw-output-${clusterId}.json`,
    normalized: `33-filtered_attempt_1-normalized-output-${clusterId}.yaml`,
    provenanceCorrected: `33-filtered_attempt_1-provenance-corrected-normalized-output-${clusterId}.yaml`,
    provenanceCorrectedValidation: `33-filtered_attempt_1-provenance-corrected-deterministic-validation-${clusterId}.yaml`,
    validation: `33-filtered_attempt_1-deterministic-validation-${clusterId}.yaml`,
    generationRecord: `33-filtered_attempt_1-generation-record-${clusterId}.json`,
    failure: `33-filtered_attempt_1-failure-${clusterId}.yaml`
  };
}

function filteredAttemptArtifactNames(clusterId: string, providerAttempt: number) {
  const base = filteredArtifactNames(clusterId);
  if (providerAttempt === 1) return base;
  return {
    ...base,
    raw: `33-filtered_attempt_1-raw-output-${clusterId}-attempt-${providerAttempt}.json`,
    normalized: `33-filtered_attempt_1-normalized-output-${clusterId}-attempt-${providerAttempt}.yaml`,
    validation: `33-filtered_attempt_1-deterministic-validation-${clusterId}-attempt-${providerAttempt}.yaml`,
    generationRecord: `33-filtered_attempt_1-generation-record-${clusterId}-attempt-${providerAttempt}.json`,
    failure: `33-filtered_attempt_1-failure-${clusterId}-attempt-${providerAttempt}.yaml`
  };
}

export function completedFilteredAttemptClusterIdsFromRecords(records: StageGenerationRecord[]): string[] {
  return records
    .filter((record) => record.type === "capability_reduction" && record.validation_status === "completed_valid_output")
    .map((record) => record.output_ref.match(/33-filtered_attempt_1-normalized-output-(.+)\.yaml$/)?.[1])
    .filter((id): id is string => Boolean(id));
}

async function readExistingValidFilteredCluster(runDir: string, clusterId: string, clusterTarget: Context, policy: EvidenceBoundaryAdmission): Promise<CapabilityReduction | null> {
  const names = filteredArtifactNames(clusterId);
  const attempt2 = filteredAttemptArtifactNames(clusterId, 2);
  const candidates = [
    { normalized: names.provenanceCorrected, validation: names.provenanceCorrectedValidation },
    { normalized: attempt2.normalized, validation: attempt2.validation },
    { normalized: names.normalized, validation: names.validation }
  ];
  try {
    for (const candidate of candidates) {
      try {
        const reduction = await readYaml<CapabilityReduction>(path.join(runDir, candidate.normalized));
        const deterministic = await readYaml<DeterministicCapabilityValidationResult>(path.join(runDir, candidate.validation));
        validateReductionReferences(validateReductionOutput(reduction, "anthropic"), { subject: { id: "subject", kind: "subject", label: "subject", sources: [], content: { contexts: policy.permitted_evidence_context_ids.map((id) => ({ id })) }, generation: { operation: "contextualize", provider: "fixture", model: "fixture", prompt_version: "fixture", input_refs: [], schema_version: "corus.context.v1", created_at: new Date().toISOString() } }, target: clusterTarget }, "anthropic");
        if (deterministic.status === "completed_valid_output") return reduction;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

async function correctExistingSmokeProvenance(input: {
  root: string;
  runDir: string;
  clusterId: string;
  clusterTarget: Context;
  admission: EvidenceBoundaryAdmission;
}): Promise<{ reduction: CapabilityReduction; validation: DeterministicCapabilityValidationResult; artifact_refs: string[] } | null> {
  const names = filteredArtifactNames(input.clusterId);
  const normalizedPath = path.join(input.runDir, names.normalized);
  const recordPath = path.join(input.runDir, names.generationRecord);
  try {
    const existing = await readYaml<CapabilityReduction>(normalizedPath);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as StageGenerationRecord;
    const corrected = normalizeCapabilityReductionProvenance(existing, record.provider, record.model, record.prompt_version);
    validateReductionReferences(corrected, { subject: { id: "subject", kind: "subject", label: "subject", sources: [], content: { contexts: input.admission.permitted_evidence_context_ids.map((id) => ({ id })) }, generation: { operation: "contextualize", provider: "fixture", model: "fixture", prompt_version: "fixture", input_refs: [], schema_version: "corus.context.v1", created_at: new Date().toISOString() } }, target: input.clusterTarget }, "anthropic");
    const validation = validateCapabilityEvidencePolicy({
      clusterId: input.clusterId,
      reduction: corrected,
      allowedRequirementIds: contextIdsFromContext(input.clusterTarget),
      permittedEvidenceIds: input.admission.permitted_evidence_context_ids,
      unresolvedEvidenceIds: input.admission.unresolved_context_ids,
      partialEvidenceIds: input.admission.support_ceilings.map((ceiling) => ceiling.context_ref),
      generationRecord: record,
      provenanceNormalizedByAdapter: true
    });
    if (validation.status !== "completed_valid_output") throw new Error(`Smoke provenance correction failed deterministic validation: ${validation.status}`);
    await fs.writeFile(path.join(input.runDir, names.provenanceCorrected), stringify(corrected), "utf8");
    await fs.writeFile(path.join(input.runDir, names.provenanceCorrectedValidation), stringify(validation), "utf8");
    return {
      reduction: corrected,
      validation,
      artifact_refs: [artifactRef(input.root, path.join(input.runDir, names.provenanceCorrected)), artifactRef(input.root, path.join(input.runDir, names.provenanceCorrectedValidation))]
    };
  } catch {
    return null;
  }
}

export async function runFilteredCapabilityRegeneration(input: { root?: string; runId: string }) {
  const root = input.root ?? getProjectRoot();
  const runDir = path.join(root, "outputs", input.runId);
  const admitted = await readYaml<AdmittedClusters>(path.join(runDir, "08-admitted-job-requirement-clusters.yaml"));
  const admission = await readYaml<EvidenceBoundaryAdmission>(path.join(runDir, "31-author-evidence-boundary-admission.yaml"));
  const repositoryEvidence = await readYaml<{ extracts?: Array<Record<string, unknown>> }>(path.join(runDir, "repository-evidence-extracts.yaml")).catch(() => ({ extracts: [] }));
  const inventory = await readYaml<{ records: InventoryRecord[] }>(path.join(runDir, "12-applicant-evidence-inventory.yaml"));
  const direct = await readYaml<{ extracts: DirectExtract[]; context_resolution: ContextResolution[] }>(path.join(runDir, "14-direct-evidence-extracts.yaml"));
  const directResolution = await readYaml<{ context_resolution: ContextResolution[] }>(path.join(runDir, "15-applicant-context-evidence-resolution.yaml"));
  const applicantPath = path.join(root, "test/fixtures/prophet/jeremy_corus.yaml");
  const applicantBefore = await fs.readFile(applicantPath, "utf8");
  const applicantRaw = parse(applicantBefore);
  const targetRaw = await readYaml<{ context: Context }>(path.join(runDir, "01-job-description-context.yaml"));
  const applicantContext: Context = {
    id: "prophet_filtered_attempt_1_applicant_evidence_context",
    kind: "subject",
    label: "Jeremy Capps filtered attempt 1 applicant evidence context",
    sources: ["test/fixtures/prophet/jeremy_corus.yaml", artifactRef(root, path.join(runDir, "31-author-evidence-boundary-admission.yaml"))],
    content: applicantRaw,
    generation: { operation: "contextualize", provider: "fixture", model: "structured-context-ledger", prompt_version: "contextualize.preserve-author-admitted-evidence.v1", input_refs: ["test/fixtures/prophet/jeremy_corus.yaml"], schema_version: "corus.context.v1", created_at: new Date().toISOString() }
  };
  const existingRetrieval = await readYaml<{ retrieval_results: RetrievalResult[]; repository_resolution?: unknown }>(path.join(runDir, "19-internal-lexical-retrieval-results.yaml")).catch(async () => {
    const repo = await repositoryChunks(inventory.records);
    return { retrieval_results: buildRetrievalResults(inventory.records, directResolution.context_resolution, applicantContext, [...chunksFromExtracts(direct.extracts), ...repo.chunks]), repository_resolution: repo };
  });
  const providerSubject = compactApplicantContextForAdmission(applicantContext, existingRetrieval.retrieval_results, admission, repositoryEvidence.extracts ?? []);
  const providerApplicantContext = providerSubject.context;
  const subjectIds = contextIdsFromContext(providerApplicantContext);
  if (subjectIds.length !== 10) throw new Error(`Filtered provider input must contain exactly 10 permitted applicant contexts; got ${subjectIds.length}.`);
  const unresolvedLeak = admission.unresolved_context_ids.filter((id) => subjectIds.includes(id));
  if (unresolvedLeak.length > 0) throw new Error(`Unresolved contexts leaked into provider input: ${unresolvedLeak.join(", ")}`);
  await fs.writeFile(path.join(runDir, "33-filtered_attempt_1-subject-context.yaml"), stringify({ context: providerApplicantContext, permitted_evidence_context_ids: admission.permitted_evidence_context_ids, support_ceilings: admission.support_ceilings }), "utf8");
  await fs.writeFile(path.join(runDir, "33-filtered_attempt_1-subject-context-exclusions.yaml"), stringify({ schema_version: "corus.filtered_subject_context_exclusions.v1", excluded_contexts: providerSubject.excluded_contexts }), "utf8");

  const includedClusters = admitted.clusters.filter((cluster) => admitted.downstream_policy.capability_derivation.include.includes(cluster.id));
  const smokeCluster = includedClusters.find((cluster) => cluster.id === "product_delivery_and_execution");
  if (!smokeCluster) throw new Error("Smoke cluster product_delivery_and_execution is not in admitted derivation clusters.");
  const orderedClusters = [smokeCluster, ...includedClusters.filter((cluster) => cluster.id !== smokeCluster.id)];
  const generationRecordsPath = path.join(runDir, "generation-records.json");
  let records: StageGenerationRecord[] = [];
  try { records = JSON.parse(await fs.readFile(generationRecordsPath, "utf8")) as StageGenerationRecord[]; } catch {}
  const reducer = new AnthropicCapabilityReductionProvider();
  const aggregate: Array<{ cluster_id: string; requirement_refs: string[]; reduction: CapabilityReduction; validation: DeterministicCapabilityValidationResult }> = [];
  let claudeCalls = 0;

  for (const cluster of orderedClusters) {
    const clusterTarget = filterContext(targetRaw.context, new Set(cluster.requirement_refs), `prophet_filtered_attempt_1_${cluster.id}_requirements`, `Prophet filtered attempt 1 ${cluster.label} requirements`);
    let names = filteredArtifactNames(cluster.id);
    await fs.writeFile(path.join(runDir, names.target), stringify({ context: clusterTarget, cluster_ref: cluster.id, requirement_refs: cluster.requirement_refs }), "utf8");
    if (cluster.id === smokeCluster.id) {
      const correctedSmoke = await correctExistingSmokeProvenance({ root, runDir, clusterId: cluster.id, clusterTarget, admission });
      if (correctedSmoke) {
        aggregate.push({ cluster_id: cluster.id, requirement_refs: cluster.requirement_refs, reduction: correctedSmoke.reduction, validation: correctedSmoke.validation });
        continue;
      }
    }
    const existing = await readExistingValidFilteredCluster(runDir, cluster.id, clusterTarget, admission);
    if (existing) {
      const validation = await readYaml<DeterministicCapabilityValidationResult>(path.join(runDir, names.validation));
      aggregate.push({ cluster_id: cluster.id, requirement_refs: cluster.requirement_refs, reduction: existing, validation });
      continue;
    }
    const priorFailureRawPath = path.join(runDir, names.raw.replace(".json", "-error-attempt-1.json"));
    let providerAttemptStart = 1;
    try {
      const priorRaw = JSON.parse(await fs.readFile(priorFailureRawPath, "utf8")) as { stop_reason?: string };
      if (priorRaw.stop_reason === "max_tokens") providerAttemptStart = 2;
    } catch {}
    names = filteredAttemptArtifactNames(cluster.id, providerAttemptStart);
    let reductionResult;
    let attempt = providerAttemptStart - 1;
    while (true) {
      attempt += 1;
      names = filteredAttemptArtifactNames(cluster.id, attempt);
      await fs.writeFile(path.join(runDir, `33-filtered_attempt_1-request-config-${cluster.id}-attempt-${attempt}.yaml`), stringify({
        schema_version: "corus.filtered_capability_reduction_request_config.v1",
        attempt: "filtered_attempt_1",
        cluster_id: cluster.id,
        provider_attempt: attempt,
        provider: "anthropic",
        model: configuredModelIds().anthropic,
        prompt_version: "reduce.anthropic.v1",
        max_tokens: 4000,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema_ref: "corus.capability_reduction.v1" } },
        evidence_boundary_ref: artifactRef(root, path.join(runDir, "31-author-evidence-boundary-admission.yaml"))
      }), "utf8");
      try {
        claudeCalls += 1;
        reductionResult = await reducer.execute({
          contexts: { subject: providerApplicantContext, target: clusterTarget },
          valid_subject_evidence_ids: subjectIds,
          valid_target_requirement_ids: cluster.requirement_refs,
          evidence_policy: {
            attempt: "filtered_attempt_1",
            cluster_id: cluster.id,
            permitted_evidence_context_ids: admission.permitted_evidence_context_ids,
            unresolved_context_ids: admission.unresolved_context_ids,
            support_ceilings: admission.support_ceilings
          }
        });
        break;
      } catch (error) {
        const incompleteMaxTokens = error instanceof ProviderExecutionError && error.metadata?.provider_completion_state === "provider_incomplete_max_tokens";
        const failure = { schema_version: "corus.filtered_cluster_failure.v1", attempt: "filtered_attempt_1", cluster_id: cluster.id, provider_attempt: attempt, provider: error instanceof ProviderExecutionError ? error.provider : undefined, message: error instanceof Error ? error.message : String(error), classification: incompleteMaxTokens ? "provider_incomplete_max_tokens" : error instanceof ProviderExecutionError ? error.metadata?.provider_completion_state ?? "provider_output_invalid" : "local_failure", retryable: attempt === 1 && (isTransientProviderError(error) || incompleteMaxTokens), retry_attempt: attempt };
        const rawFailurePath = path.join(runDir, names.raw.replace(".json", `-error-attempt-${attempt}.json`));
        if (error instanceof ProviderExecutionError && error.raw_output !== undefined) await writeJsonArtifact(runDir, path.basename(rawFailurePath), error.raw_output);
        await fs.writeFile(path.join(runDir, names.failure), stringify(failure), "utf8");
        if (error instanceof ProviderExecutionError && error.raw_output !== undefined) {
          const failureRecord = stageRecord({
            type: "capability_reduction",
            started_at: error.metadata?.started_at,
            completed_at: error.metadata?.completed_at,
            input_refs: [artifactRef(root, path.join(runDir, "33-filtered_attempt_1-subject-context.yaml")), artifactRef(root, path.join(runDir, names.target))],
            output_ref: artifactRef(root, path.join(runDir, names.failure)),
            raw_output_ref: artifactRef(root, rawFailurePath),
            provider: error.provider,
            model: error.metadata?.model ?? "unknown",
            prompt_version: error.metadata?.prompt_version ?? "reduce.anthropic.v1",
            schema_version: "corus.capability_reduction.v1",
            validation_status: "provider_output_invalid",
            provider_completion_state: error.metadata?.provider_completion_state ?? null,
            metrics: error.metadata?.metrics ?? { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" },
            stop_reason: error.metadata?.stop_reason ?? null,
            model_operation: error.metadata?.model_operation
          });
          await writeJsonArtifact(runDir, names.generationRecord, failureRecord);
          records.push(failureRecord);
          await writeGenerationRecords(runDir, records);
        }
        if (attempt === 1 && (isTransientProviderError(error) || incompleteMaxTokens)) continue;
        await fs.writeFile(path.join(runDir, "34-filtered_attempt_1-summary.yaml"), stringify({ schema_version: "corus.filtered_capability_regeneration_summary.v1", pipeline_status: "filtered_capability_regeneration_failed", failed_cluster_id: cluster.id, smoke_cluster_passed: cluster.id !== smokeCluster.id, claude_cluster_calls: claudeCalls, failure }), "utf8");
        throw error;
      }
    }
    await writeJsonArtifact(runDir, names.raw, reductionResult.raw_output ?? {});
    const reduction = validateReductionReferences(reductionResult.output, { subject: providerApplicantContext, target: clusterTarget }, "anthropic");
    const record = stageRecord({ type: "capability_reduction", input_refs: [artifactRef(root, path.join(runDir, "33-filtered_attempt_1-subject-context.yaml")), artifactRef(root, path.join(runDir, names.target))], output_ref: artifactRef(root, path.join(runDir, names.normalized)), raw_output_ref: artifactRef(root, path.join(runDir, names.raw)), provider: reductionResult.provider, model: reductionResult.model, prompt_version: reductionResult.prompt_version, schema_version: "corus.capability_reduction.v1", validation_status: "pending_deterministic_validation", metrics: reductionResult.metrics, model_operation: reductionResult.model_operation });
    const validation = validateCapabilityEvidencePolicy({ clusterId: cluster.id, reduction, allowedRequirementIds: cluster.requirement_refs, permittedEvidenceIds: admission.permitted_evidence_context_ids, unresolvedEvidenceIds: admission.unresolved_context_ids, partialEvidenceIds: admission.support_ceilings.map((ceiling) => ceiling.context_ref), generationRecord: record, provenanceNormalizedByAdapter: true });
    record.validation_status = validation.status;
    await fs.writeFile(path.join(runDir, names.normalized), stringify(reduction), "utf8");
    await fs.writeFile(path.join(runDir, names.validation), stringify(validation), "utf8");
    await writeJsonArtifact(runDir, names.generationRecord, record);
    records.push(record);
    await writeGenerationRecords(runDir, records);
    aggregate.push({ cluster_id: cluster.id, requirement_refs: cluster.requirement_refs, reduction, validation });
    if (cluster.id === smokeCluster.id && validation.status !== "completed_valid_output") {
      await fs.writeFile(path.join(runDir, "34-filtered_attempt_1-summary.yaml"), stringify({ schema_version: "corus.filtered_capability_regeneration_summary.v1", pipeline_status: "smoke_cluster_failed", failed_cluster_id: cluster.id, smoke_result: validation, claude_cluster_calls: claudeCalls }), "utf8");
      return { status: "smoke_cluster_failed", claude_cluster_calls: claudeCalls, openai_reached: false, artifact_refs: [artifactRef(root, path.join(runDir, "34-filtered_attempt_1-summary.yaml"))] };
    }
    if (validation.status !== "completed_valid_output") {
      await fs.writeFile(path.join(runDir, "34-filtered_attempt_1-summary.yaml"), stringify({ schema_version: "corus.filtered_capability_regeneration_summary.v1", pipeline_status: "filtered_cluster_failed", failed_cluster_id: cluster.id, deterministic_validation: validation, claude_cluster_calls: claudeCalls }), "utf8");
      return { status: "filtered_cluster_failed", claude_cluster_calls: claudeCalls, openai_reached: false, artifact_refs: [artifactRef(root, path.join(runDir, "34-filtered_attempt_1-summary.yaml"))] };
    }
  }

  const aggregateReduction: CapabilityReduction = { reducer: "capabilities", inputs: { subject: providerApplicantContext.id, target: "prophet_filtered_attempt_1_admitted_requirements" }, capabilities: aggregate.flatMap((item) => item.reduction.capabilities) };
  await fs.writeFile(path.join(runDir, "34-filtered_attempt_1-capability-candidates.yaml"), stringify({ ...aggregateReduction, cluster_provenance: clusterCapabilityProvenance(aggregate) }), "utf8");
  const validator = new OpenAIValidationProvider();
  let validationResult;
  try {
    validationResult = await validator.execute({
      contexts: { subject: providerApplicantContext, target: filterContext(targetRaw.context, admittedRequirementIds(admitted), "prophet_filtered_attempt_1_admitted_requirements", "Prophet filtered attempt 1 admitted requirements") },
      capabilities: aggregateReduction.capabilities,
      evidence_policy: {
        permitted_evidence_context_ids: admission.permitted_evidence_context_ids,
        support_ceilings: admission.support_ceilings,
        required_checks: ["claim_to_requirement_fit", "evidence_support", "support_classification", "partial_evidence_ceilings", "unsupported_claims", "duplication_or_conflict", "complete_cluster_accounting"]
      }
    });
  } catch (error) {
    const openAiRawPath = path.join(runDir, "raw-35-filtered_attempt_1-openai-validation-error.json");
    const openAiFailurePath = path.join(runDir, "35-filtered_attempt_1-openai-validation-failure.yaml");
    if (error instanceof ProviderExecutionError && error.raw_output !== undefined) await writeJsonArtifact(runDir, "raw-35-filtered_attempt_1-openai-validation-error.json", error.raw_output);
    const failure = { schema_version: "corus.filtered_openai_validation_failure.v1", pipeline_status: "openai_validation_failed", message: error instanceof Error ? error.message : String(error), provider: error instanceof ProviderExecutionError ? error.provider : undefined, classification: error instanceof ProviderExecutionError && JSON.stringify(error.raw_output ?? {}).includes("rate_limit") ? "model_rate_limit" : "unknown_provider_failure" };
    if (error instanceof ProviderExecutionError && error.raw_output !== undefined) {
      const failureRecord = stageRecord({
        type: "capability_validation",
        input_refs: [artifactRef(root, path.join(runDir, "34-filtered_attempt_1-capability-candidates.yaml"))],
        output_ref: artifactRef(root, openAiFailurePath),
        raw_output_ref: artifactRef(root, openAiRawPath),
        provider: "openai",
        model: configuredModelIds().openai,
        prompt_version: "validate.openai.v1",
        schema_version: "corus.validation.v1",
        validation_status: failure.classification,
        provider_completion_state: "provider_error",
        metrics: { input_tokens: null, output_tokens: null, total_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" },
        stop_reason: null,
        model_operation: error instanceof ProviderExecutionError ? error.metadata?.model_operation : undefined
      });
      await writeJsonArtifact(runDir, "35-filtered_attempt_1-openai-validation-generation-record.json", failureRecord);
      records.push(failureRecord);
      await writeGenerationRecords(runDir, records);
    }
    await fs.writeFile(openAiFailurePath, stringify(failure), "utf8");
    await fs.writeFile(path.join(runDir, "34-filtered_attempt_1-summary.yaml"), stringify({ schema_version: "corus.filtered_capability_regeneration_summary.v1", pipeline_status: "openai_validation_failed", claude_cluster_calls: claudeCalls, openai_reached: true, failure }), "utf8");
    throw error;
  }
  await writeJsonArtifact(runDir, "raw-35-filtered_attempt_1-openai-validation.json", validationResult.raw_output ?? {});
  await fs.writeFile(path.join(runDir, "35-filtered_attempt_1-openai-validation.yaml"), stringify(validationResult.output), "utf8");
  records.push(stageRecord({ type: "capability_validation", input_refs: [artifactRef(root, path.join(runDir, "34-filtered_attempt_1-capability-candidates.yaml"))], output_ref: artifactRef(root, path.join(runDir, "35-filtered_attempt_1-openai-validation.yaml")), raw_output_ref: artifactRef(root, path.join(runDir, "raw-35-filtered_attempt_1-openai-validation.json")), provider: validationResult.provider, model: validationResult.model, prompt_version: validationResult.prompt_version, schema_version: "corus.validation.v1", validation_status: validationResult.output.status, metrics: validationResult.metrics, model_operation: validationResult.model_operation }));
  await writeGenerationRecords(runDir, records);
  const review = admissionReview(aggregateReduction, validationResult.output);
  await fs.writeFile(path.join(runDir, "36-filtered_attempt_1-capability-admission-review.yaml"), stringify({ schema_version: "corus.capability_admission_review.v1", attempt: "filtered_attempt_1", author_action_required: true, proposed_deterministic_admission_decisions: review }), "utf8");
  const summary = { schema_version: "corus.filtered_capability_regeneration_summary.v1", pipeline_status: "awaiting_author_capability_admission", claude_cluster_calls: claudeCalls, openai_reached: true, cluster_count: aggregate.length, capability_counts_by_cluster: Object.fromEntries(aggregate.map((item) => [item.cluster_id, statusCounts(item.reduction.capabilities)])), validation_status: validationResult.output.status, validation_findings: validationResult.output.findings, artifact_refs: ["33-filtered_attempt_1-subject-context.yaml", "33-filtered_attempt_1-subject-context-exclusions.yaml", "34-filtered_attempt_1-capability-candidates.yaml", "35-filtered_attempt_1-openai-validation.yaml", "36-filtered_attempt_1-capability-admission-review.yaml"].map((name) => artifactRef(root, path.join(runDir, name))) };
  await fs.writeFile(path.join(runDir, "34-filtered_attempt_1-summary.yaml"), stringify(summary), "utf8");
  const applicantAfter = await fs.readFile(applicantPath, "utf8");
  if (applicantBefore !== applicantAfter) throw new Error("Applicant ledger mutated during filtered capability regeneration.");
  return { status: "awaiting_author_capability_admission", claude_cluster_calls: claudeCalls, openai_reached: true, summary, artifact_refs: summary.artifact_refs };
}
