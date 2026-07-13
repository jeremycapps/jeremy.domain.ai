import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CapabilityCandidate, CapabilityReduction, CapabilityValidation, Context, StageGenerationRecord } from "../types.js";
import { AnthropicCapabilityReductionProvider, OpenAIValidationProvider, configuredModelIds } from "../providers/liveProviders.js";
import { ProviderExecutionError } from "../providers/errors.js";
import { validateReductionReferences } from "../providers/validators.js";
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
    records.push(stageRecord({ type: "capability_reduction", input_refs: [artifactRef(root, path.join(runDir, "22-admitted-subject-context.yaml")), artifactRef(root, clusterTargetPath)], output_ref: artifactRef(root, capabilityPath), raw_output_ref: artifactRef(root, path.join(runDir, rawName)), provider: reductionResult.provider, model: reductionResult.model, prompt_version: reductionResult.prompt_version, schema_version: "corus.capability_reduction.v1", validation_status: "completed_valid_output", metrics: reductionResult.metrics }));
    await writeGenerationRecords(runDir, records);
  }
  const reduction: CapabilityReduction = { reducer: "capabilities", inputs: { subject: providerApplicantContext.id, target: targetContext.id }, capabilities: aggregateCapabilities };
  await fs.writeFile(path.join(runDir, "24-capability-candidates.yaml"), stringify(reduction), "utf8");
  const validator = new OpenAIValidationProvider();
  const validationResult = await validator.execute({ contexts: { subject: providerApplicantContext, target: targetContext }, capabilities: reduction.capabilities });
  await writeJsonArtifact(runDir, "raw-25-capability-validation-provider.json", validationResult.raw_output ?? {});
  const validation = validationResult.output;
  await fs.writeFile(path.join(runDir, "25-capability-validation.yaml"), stringify(validation), "utf8");
  records.push(stageRecord({ type: "capability_validation", input_refs: [artifactRef(root, path.join(runDir, "24-capability-candidates.yaml"))], output_ref: artifactRef(root, path.join(runDir, "25-capability-validation.yaml")), raw_output_ref: artifactRef(root, path.join(runDir, "raw-25-capability-validation-provider.json")), provider: validationResult.provider, model: validationResult.model, prompt_version: validationResult.prompt_version, schema_version: "corus.validation.v1", validation_status: validation.status, metrics: validationResult.metrics }));
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
