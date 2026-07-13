import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { Context } from "../types.js";
import { readSourceInput, sourceRefFromInput, normalizeContext } from "./corusContext.js";
import { getProjectRoot } from "./paths.js";

export type EvidenceStatus = "directly_resolved" | "source_declared_search_required" | "user_asserted_document_needed" | "source_missing" | "malformed";

export interface ApplicantSourceManifestEntry {
  id: string;
  declared_source_ref: string;
  filename: string | null;
  stable_locator: string | null;
  source_type: string;
  availability: "available" | "missing";
  content_hash: string | null;
  applicant_context_refs: string[];
  resolution_method: "exact_filename" | "context_source_filename" | "manifest_file" | "normalized_filename" | "unresolved";
}

export interface ApplicantEvidenceInventoryRecord {
  context_ref: string;
  evidence_status: EvidenceStatus;
  declared_source_refs: string[];
  resolved_source_refs: string[];
  unresolved_source_refs: string[];
  exact_evidence_count: number;
  retrieval_state: EvidenceStatus;
  retrieval_reason: string;
  constraints: string[];
  eligible_for_direct_use: boolean;
  eligible_for_internal_retrieval: boolean;
  eligible_for_external_discovery: boolean;
}

export interface ApplicantEvidenceInventory {
  schema_version: "corus.applicant_evidence_inventory.v1";
  applicant_context_ref: string;
  applicant_context_count: number;
  source_corpus_refs: string[];
  records: ApplicantEvidenceInventoryRecord[];
  summary: Record<EvidenceStatus, number>;
  downstream_target_policy: {
    capability_derivation_cluster_refs: string[];
    excluded_target_cluster_refs: string[];
  };
  provider_calls_made: [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^context_source__/, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sourceId(value: string): string {
  const normalized = normalizeKey(value).replace(/\s+/g, "_");
  return normalized || createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sourceTypeForFile(filename: string | null, ref: string): string {
  if (/user assertion/i.test(ref)) return "conversation_assertion";
  if (/github\.com|corus-workbench\//i.test(ref)) return "external_or_repository_reference";
  if (!filename) return "declared_source";
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (ext === "docx" || ext === "pdf") return "document";
  if (ext === "yaml" || ext === "yml") return "structured_source";
  if (ext === "txt" || ext === "md") return "text_source";
  if (ext === "png" || ext === "jpg" || ext === "jpeg") return "image_source";
  if (ext === "xlsx") return "spreadsheet_source";
  return ext || "file_source";
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

interface FileIndexEntry {
  file: string;
  filename: string;
  normalized: string;
  contextSourceNormalized: string | null;
}

async function buildFileIndex(sourceDir: string): Promise<FileIndexEntry[]> {
  return (await listFiles(sourceDir)).map((file) => {
    const filename = path.basename(file);
    const normalized = normalizeKey(filename);
    const withoutExt = filename.replace(/\.[^.]+$/, "");
    const contextSourceNormalized = withoutExt.startsWith("context_source__") ? normalizeKey(withoutExt.replace(/^context_source__/, "")) : null;
    return { file, filename, normalized, contextSourceNormalized };
  });
}

function pickFile(ref: string, files: FileIndexEntry[]): { entry: FileIndexEntry; method: ApplicantSourceManifestEntry["resolution_method"] } | null {
  const refNorm = normalizeKey(ref);
  const exact = files.find((entry) => entry.normalized === refNorm);
  if (exact) return { entry: exact, method: "exact_filename" };
  const contextSource = files.find((entry) => entry.contextSourceNormalized === refNorm);
  if (contextSource) return { entry: contextSource, method: "context_source_filename" };
  const manifestFile = files.find((entry) => entry.filename === ref || entry.filename.replace(/\.[^.]+$/, "") === ref);
  if (manifestFile) return { entry: manifestFile, method: "manifest_file" };
  const normalized = files.find((entry) => entry.normalized.includes(refNorm) || refNorm.includes(entry.normalized));
  if (normalized && refNorm.length > 8) return { entry: normalized, method: "normalized_filename" };
  return null;
}

function evidenceSource(context: unknown): Record<string, unknown> | null {
  if (!isRecord(context)) return null;
  const origin = context.origin;
  if (!isRecord(origin)) return null;
  const source = origin.evidence_source;
  return isRecord(source) ? source : null;
}

function userAsserted(status: string, refs: string[]): boolean {
  return /user_asserted|user testimony|testimony/i.test(status) || refs.some((ref) => /user assertion in conversation/i.test(ref));
}

export async function buildApplicantSourceManifest(input: { applicantContext: Context; sourceDir: string }): Promise<ApplicantSourceManifestEntry[]> {
  const files = await buildFileIndex(input.sourceDir);
  const declarations = new Map<string, Set<string>>();
  const contexts = Array.isArray(input.applicantContext.content.contexts) ? input.applicantContext.content.contexts : [];
  for (const context of contexts) {
    if (!isRecord(context) || typeof context.id !== "string") continue;
    const source = evidenceSource(context);
    const refs = Array.isArray(source?.source_refs) ? source.source_refs.filter((ref): ref is string => typeof ref === "string") : [];
    for (const ref of refs) {
      if (!declarations.has(ref)) declarations.set(ref, new Set());
      declarations.get(ref)!.add(context.id);
    }
  }
  const manifest: ApplicantSourceManifestEntry[] = [];
  for (const [ref, contextRefs] of [...declarations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const picked = pickFile(ref, files);
    manifest.push({
      id: sourceId(ref),
      declared_source_ref: ref,
      filename: picked ? path.relative(input.sourceDir, picked.entry.file) : null,
      stable_locator: picked ? picked.entry.file : ref.startsWith("http") ? ref : null,
      source_type: sourceTypeForFile(picked?.entry.filename ?? null, ref),
      availability: picked ? "available" : "missing",
      content_hash: picked ? await sha256(picked.entry.file) : null,
      applicant_context_refs: [...contextRefs].sort(),
      resolution_method: picked ? picked.method : "unresolved"
    });
  }
  return manifest;
}

export function buildApplicantEvidenceInventory(input: {
  applicantContext: Context;
  applicantContextRef: string;
  sourceManifest: ApplicantSourceManifestEntry[];
  admittedTargetPolicy?: { capability_derivation?: { include?: string[]; exclude?: string[] }; candidate_confirmation?: string[]; recruiter_question_inputs?: string[] };
}): ApplicantEvidenceInventory {
  const contexts = Array.isArray(input.applicantContext.content.contexts) ? input.applicantContext.content.contexts : [];
  const seen = new Set<string>();
  const manifestByRef = new Map(input.sourceManifest.map((entry) => [entry.declared_source_ref, entry]));
  const records: ApplicantEvidenceInventoryRecord[] = [];

  for (const context of contexts) {
    if (!isRecord(context) || typeof context.id !== "string" || seen.has(context.id)) {
      const contextRef = isRecord(context) && typeof context.id === "string" ? context.id : "(missing_context_id)";
      records.push({ context_ref: contextRef, evidence_status: "malformed", declared_source_refs: [], resolved_source_refs: [], unresolved_source_refs: [], exact_evidence_count: 0, retrieval_state: "malformed", retrieval_reason: seen.has(contextRef) ? "Duplicate applicant context ID." : "Required provenance fields are missing or invalid.", constraints: [], eligible_for_direct_use: false, eligible_for_internal_retrieval: false, eligible_for_external_discovery: false });
      continue;
    }
    seen.add(context.id);
    const source = evidenceSource(context);
    const refs = Array.isArray(source?.source_refs) ? source.source_refs.filter((ref): ref is string => typeof ref === "string") : [];
    const exactEvidence = Array.isArray(source?.exact_evidence) ? source.exact_evidence : [];
    const status = typeof source?.evidence_status === "string" ? source.evidence_status : "";
    const constraints = Array.isArray(context.constraints) ? context.constraints.filter((item): item is string => typeof item === "string") : [];
    if (!source || refs.length === 0 || !Array.isArray(source.source_refs) || !Array.isArray(source.exact_evidence)) {
      records.push({ context_ref: context.id, evidence_status: "malformed", declared_source_refs: refs, resolved_source_refs: [], unresolved_source_refs: refs, exact_evidence_count: exactEvidence.length, retrieval_state: "malformed", retrieval_reason: "Required provenance fields are missing or invalid.", constraints, eligible_for_direct_use: false, eligible_for_internal_retrieval: false, eligible_for_external_discovery: false });
      continue;
    }
    const resolved = refs.filter((ref) => manifestByRef.get(ref)?.availability === "available");
    const unresolved = refs.filter((ref) => manifestByRef.get(ref)?.availability !== "available");
    let evidenceStatus: EvidenceStatus;
    let reason: string;
    if (userAsserted(status, refs)) {
      evidenceStatus = "user_asserted_document_needed";
      reason = "Record relies on user assertion/testimony and still needs document-level support; source_refs alone are not documentary evidence.";
    } else if (resolved.length === refs.length) {
      evidenceStatus = "directly_resolved";
      reason = "All declared source references resolve to available local artifacts by deterministic source identity or filename normalization.";
    } else if (resolved.length > 0) {
      evidenceStatus = "source_declared_search_required";
      reason = "Some declared source references resolve, but at least one named source or exact location remains unresolved in the available corpus.";
    } else {
      evidenceStatus = "source_missing";
      reason = "Concrete source references are named, but none resolve to available local source artifacts.";
    }
    records.push({
      context_ref: context.id,
      evidence_status: evidenceStatus,
      declared_source_refs: refs,
      resolved_source_refs: resolved,
      unresolved_source_refs: unresolved,
      exact_evidence_count: exactEvidence.length,
      retrieval_state: evidenceStatus,
      retrieval_reason: reason,
      constraints,
      eligible_for_direct_use: evidenceStatus === "directly_resolved",
      eligible_for_internal_retrieval: evidenceStatus === "source_declared_search_required",
      eligible_for_external_discovery: evidenceStatus === "source_missing" || evidenceStatus === "user_asserted_document_needed"
    });
  }

  const summary: Record<EvidenceStatus, number> = { directly_resolved: 0, source_declared_search_required: 0, user_asserted_document_needed: 0, source_missing: 0, malformed: 0 };
  for (const record of records) summary[record.evidence_status] += 1;
  const policy = input.admittedTargetPolicy ?? {};
  return {
    schema_version: "corus.applicant_evidence_inventory.v1",
    applicant_context_ref: input.applicantContextRef,
    applicant_context_count: contexts.length,
    source_corpus_refs: [...new Set(input.sourceManifest.filter((entry) => entry.availability === "available").map((entry) => entry.filename).filter((name): name is string => Boolean(name)))].sort(),
    records,
    summary,
    downstream_target_policy: {
      capability_derivation_cluster_refs: policy.capability_derivation?.include ?? [],
      excluded_target_cluster_refs: [...(policy.capability_derivation?.exclude ?? []), ...(policy.candidate_confirmation ?? []), ...(policy.recruiter_question_inputs ?? [])].filter((value, index, array) => array.indexOf(value) === index)
    },
    provider_calls_made: []
  };
}

export function validateApplicantEvidenceInventory(input: { applicantContext: Context; inventory: ApplicantEvidenceInventory; sourceManifest: ApplicantSourceManifestEntry[]; originalApplicantBytes: string; currentApplicantBytes: string; originalTargetBytes: string; currentTargetBytes: string }): void {
  const contexts = Array.isArray(input.applicantContext.content.contexts) ? input.applicantContext.content.contexts : [];
  const ids = contexts.map((context) => (isRecord(context) && typeof context.id === "string" ? context.id : ""));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate applicant context IDs are not allowed.");
  if (input.inventory.records.length !== contexts.length) throw new Error("Inventory count must equal applicant context count.");
  const recordIds = input.inventory.records.map((record) => record.context_ref);
  for (const id of ids) if (!recordIds.includes(id)) throw new Error(`Applicant context ${id} is missing from inventory.`);
  for (const record of input.inventory.records) {
    const accounted = [...record.resolved_source_refs, ...record.unresolved_source_refs].sort();
    const declared = [...record.declared_source_refs].sort();
    if (JSON.stringify(accounted) !== JSON.stringify(declared)) throw new Error(`Declared source refs are not fully accounted for in ${record.context_ref}.`);
    if (record.evidence_status === "user_asserted_document_needed" && record.eligible_for_direct_use) throw new Error("User asserted records cannot be promoted to documentary evidence.");
  }
  if (input.originalApplicantBytes !== input.currentApplicantBytes) throw new Error("Original applicant ledger changed during inventory.");
  if (input.originalTargetBytes !== input.currentTargetBytes) throw new Error("Original target artifacts changed during inventory.");
  if (input.inventory.downstream_target_policy.capability_derivation_cluster_refs.includes("employment_conditions")) throw new Error("employment_conditions must not enter capability evidence retrieval.");
  if (input.inventory.downstream_target_policy.capability_derivation_cluster_refs.includes("hiring_qualifying_questions")) throw new Error("hiring_qualifying_questions must not enter capability evidence retrieval.");
}

export async function runApplicantEvidenceInventory(input: { root?: string; applicantSource: unknown; sourceDir?: string; admittedClusterPath: string; runDir: string }): Promise<{ sourceManifest: ApplicantSourceManifestEntry[]; inventory: ApplicantEvidenceInventory; summary: unknown; artifactRefs: string[] }> {
  const root = input.root ?? getProjectRoot();
  const applicantRef = sourceRefFromInput(input.applicantSource, "applicant_context");
  const applicantPath = typeof input.applicantSource === "string" ? path.join(root, input.applicantSource) : null;
  const originalApplicantBytes = applicantPath ? await fs.readFile(applicantPath, "utf8") : JSON.stringify(input.applicantSource);
  const rawApplicant = await readSourceInput(input.applicantSource, root);
  const applicantContext = normalizeContext(rawApplicant, "subject", "subject", applicantRef);
  const sourceDir = input.sourceDir ?? path.join(root, "test/fixtures/prophet/sources/subject");
  const sourceManifest = await buildApplicantSourceManifest({ applicantContext, sourceDir });
  const admittedRaw = parse(await fs.readFile(path.join(root, input.admittedClusterPath), "utf8"));
  const targetBytesBefore = await fs.readFile(path.join(root, input.admittedClusterPath), "utf8");
  const inventory = buildApplicantEvidenceInventory({ applicantContext, applicantContextRef: applicantRef, sourceManifest, admittedTargetPolicy: admittedRaw.downstream_policy });
  const targetBytesAfter = await fs.readFile(path.join(root, input.admittedClusterPath), "utf8");
  const applicantBytesAfter = applicantPath ? await fs.readFile(applicantPath, "utf8") : JSON.stringify(input.applicantSource);
  validateApplicantEvidenceInventory({ applicantContext, inventory, sourceManifest, originalApplicantBytes, currentApplicantBytes: applicantBytesAfter, originalTargetBytes: targetBytesBefore, currentTargetBytes: targetBytesAfter });
  const summary = {
    schema_version: "corus.applicant_evidence_coverage_summary.v1",
    applicant_context_ref: applicantRef,
    applicant_context_count: inventory.applicant_context_count,
    source_manifest_count: sourceManifest.length,
    counts_by_retrieval_state: inventory.summary,
    directly_resolved_context_ids: inventory.records.filter((record) => record.evidence_status === "directly_resolved").map((record) => record.context_ref),
    contexts_requiring_internal_retrieval: inventory.records.filter((record) => record.evidence_status === "source_declared_search_required").map((record) => record.context_ref),
    contexts_requiring_new_documentary_sources: inventory.records.filter((record) => record.evidence_status === "user_asserted_document_needed" || record.evidence_status === "source_missing").map((record) => record.context_ref),
    missing_source_names: [...new Set(inventory.records.flatMap((record) => record.unresolved_source_refs))].sort(),
    malformed_records: inventory.records.filter((record) => record.evidence_status === "malformed").map((record) => record.context_ref),
    provider_calls_made: [],
    coverage_metrics: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      estimated_cost_usd: null,
      latency_ms: null,
      measurement_source: "unavailable"
    },
    pipeline_status: "ready_for_direct_evidence_resolution",
    applicant_evidence_retrieval: {
      status: "inventory_complete",
      direct_retrieval: "not_started",
      internal_semantic_retrieval: "not_started",
      external_source_discovery: "not_started"
    }
  };
  await fs.mkdir(input.runDir, { recursive: true });
  const manifestPath = path.join(input.runDir, "11-applicant-source-manifest.yaml");
  const inventoryPath = path.join(input.runDir, "12-applicant-evidence-inventory.yaml");
  const summaryPath = path.join(input.runDir, "13-applicant-evidence-coverage-summary.yaml");
  await fs.writeFile(manifestPath, stringify({ schema_version: "corus.applicant_source_manifest.v1", source_corpus_root: path.relative(root, sourceDir), sources: sourceManifest }), "utf8");
  await fs.writeFile(inventoryPath, stringify(inventory), "utf8");
  await fs.writeFile(summaryPath, stringify(summary), "utf8");
  return { sourceManifest, inventory, summary, artifactRefs: [manifestPath, inventoryPath, summaryPath].map((file) => path.relative(root, file)) };
}
