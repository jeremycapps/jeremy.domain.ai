import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { parse, stringify } from "yaml";
import { getProjectRoot } from "./paths.js";

const execFileAsync = promisify(execFile);

export type EvidenceMatchStatus = "exact_match" | "normalized_exact_match" | "partially_resolved" | "not_found" | "source_unavailable" | "extraction_failed";
export type ContextResolutionStatus = "resolved" | "partially_resolved" | "unresolved" | "source_unavailable" | "extraction_failed";

export interface DirectEvidenceExtract {
  id: string;
  context_ref: string;
  source_ref: string;
  source_locator: string;
  source_hash: string;
  extraction_method: string;
  location: { page: number | null; line_start: number | null; line_end: number | null };
  extracted_text: string;
  claimed_evidence: string;
  match_status: EvidenceMatchStatus;
  constraints: string[];
}

export interface StatementResolution {
  claimed_evidence: string;
  match_status: EvidenceMatchStatus;
  source_refs_checked: string[];
  supporting_extract_refs: string[];
  unresolved_reasons: string[];
}

export interface ContextEvidenceResolution {
  context_ref: string;
  declared_evidence_count: number;
  resolved_evidence_count: number;
  unresolved_evidence_count: number;
  supporting_extract_refs: string[];
  resolution_status: ContextResolutionStatus;
  unresolved_reasons: string[];
  statement_resolution: StatementResolution[];
  missing_source_refs: string[];
  extraction_failed_source_refs: string[];
  constraints: string[];
}

interface SourceEntry {
  declared_source_ref: string;
  filename: string | null;
  stable_locator: string | null;
  availability: "available" | "missing";
  content_hash: string | null;
  applicant_context_refs: string[];
}

interface InventoryRecord {
  context_ref: string;
  evidence_status: string;
  declared_source_refs: string[];
  resolved_source_refs: string[];
  unresolved_source_refs: string[];
  exact_evidence_count: number;
  constraints: string[];
}

interface ExtractedSource {
  ref: string;
  locator: string;
  hash: string;
  method: string;
  text: string;
  lines: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/[^a-z0-9]+/g, " ").trim();
}

function extractSourceRefs(context: unknown): string[] {
  if (!isRecord(context) || !isRecord(context.origin) || !isRecord(context.origin.evidence_source)) return [];
  const refs = context.origin.evidence_source.source_refs;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
}

function extractExactEvidence(context: unknown): string[] {
  if (!isRecord(context) || !isRecord(context.origin) || !isRecord(context.origin.evidence_source)) return [];
  const evidence = context.origin.evidence_source.exact_evidence;
  return Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === "string") : [];
}

function extractEvidenceStatus(context: unknown): string {
  if (!isRecord(context) || !isRecord(context.origin) || !isRecord(context.origin.evidence_source)) return "";
  return typeof context.origin.evidence_source.evidence_status === "string" ? context.origin.evidence_source.evidence_status : "";
}

function xmlDecode(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function extractDocxText(file: string): Promise<{ method: string; text: string }> {
  const { stdout } = await execFileAsync("unzip", ["-p", file, "word/document.xml"], { maxBuffer: 20 * 1024 * 1024 });
  const withBreaks = stdout.replace(/<w:(?:p|br|tab)[^>]*>/g, "\n");
  return { method: "docx_word_document_xml", text: xmlDecode(withBreaks.replace(/<[^>]+>/g, " ")).replace(/\s+\n/g, "\n") };
}

function pdfLiteralToText(value: string): string {
  return value.replace(/\\([nrtbf()\\])/g, (_match, ch: string) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[ch] ?? ch));
}

function textFromPdfStream(streamText: string): string {
  const chunks: string[] = [];
  for (const match of streamText.matchAll(/\((?:\\.|[^\\)])*\)/g)) chunks.push(pdfLiteralToText(match[0].slice(1, -1)));
  for (const match of streamText.matchAll(/<([0-9a-fA-F]{4,})>/g)) {
    const hex = match[1];
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    chunks.push(Buffer.from(bytes).toString("utf16le").replace(/\u0000/g, ""));
  }
  return chunks.join(" ");
}

async function extractPdfText(file: string): Promise<{ method: string; text: string }> {
  const buffer = await fs.readFile(file);
  const raw = buffer.toString("latin1");
  const chunks: string[] = [];
  for (const match of raw.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const dict = match[1];
    let stream = Buffer.from(match[2], "latin1");
    if (/FlateDecode/.test(dict)) {
      try {
        stream = inflateSync(stream);
      } catch {
        continue;
      }
    }
    chunks.push(textFromPdfStream(stream.toString("latin1")));
  }
  const asciiFallback = raw.replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ");
  const text = `${chunks.join("\n")}\n${asciiFallback}`.trim();
  if (!text) throw new Error("No extractable PDF text found.");
  return { method: "pdf_stream_text", text };
}

async function extractPlainText(file: string): Promise<{ method: string; text: string }> {
  return { method: "plain_text", text: await fs.readFile(file, "utf8") };
}

async function extractSourceText(file: string): Promise<{ method: string; text: string }> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".docx") return extractDocxText(file);
  if (ext === ".pdf") return extractPdfText(file);
  if ([".txt", ".md", ".yaml", ".yml", ".toml", ".py", ".json"].includes(ext)) return extractPlainText(file);
  throw new Error(`Unsupported deterministic extraction type: ${ext || "no extension"}`);
}

function lineLocation(lines: string[], matchText: string): { line_start: number | null; line_end: number | null; extracted_text: string } {
  const target = normalizeText(matchText);
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, Math.min(lines.length, index + 6)).join(" ");
    if (normalizeText(window).includes(target)) {
      return { line_start: index + 1, line_end: Math.min(lines.length, index + 6), extracted_text: window.trim() };
    }
  }
  return { line_start: null, line_end: null, extracted_text: matchText };
}

function matchEvidence(source: ExtractedSource, claim: string): { status: EvidenceMatchStatus; extracted_text: string; line_start: number | null; line_end: number | null } | null {
  const exactIndex = source.text.indexOf(claim);
  if (exactIndex >= 0) {
    const location = lineLocation(source.lines, claim);
    return { status: "exact_match", ...location };
  }
  if (normalizeText(source.text).includes(normalizeText(claim))) {
    const location = lineLocation(source.lines, claim);
    return { status: "normalized_exact_match", ...location };
  }
  return null;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function repositoryLocator(root: string, ref: string): string | null {
  if (!ref.startsWith("corus-workbench/")) return null;
  const candidates = [path.join(root, ref), path.join(path.dirname(root), ref)];
  return candidates.find((candidate) => candidate.startsWith(root) || candidate.startsWith(path.dirname(root))) ?? null;
}

async function resolveRepositoryRef(root: string, ref: string): Promise<SourceEntry | null> {
  if (!ref.startsWith("corus-workbench/")) return null;
  const locator = repositoryLocator(root, ref);
  if (!locator) return null;
  try {
    const stat = await fs.stat(locator);
    if (stat.isDirectory()) {
      const files = await listFiles(locator);
      const textFiles = files.filter((file) => /\.(md|txt|py|toml|yaml|yml|json|ts|js)$/.test(file));
      const synthetic = textFiles.length > 0 ? textFiles[0] : null;
      return {
        declared_source_ref: ref,
        filename: path.relative(root, locator),
        stable_locator: synthetic ?? locator,
        availability: synthetic ? "available" : "missing",
        content_hash: synthetic ? await sha256(synthetic) : null,
        applicant_context_refs: []
      };
    }
    return { declared_source_ref: ref, filename: path.relative(root, locator), stable_locator: locator, availability: "available", content_hash: await sha256(locator), applicant_context_refs: [] };
  } catch {
    return { declared_source_ref: ref, filename: null, stable_locator: null, availability: "missing", content_hash: null, applicant_context_refs: [] };
  }
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

async function extractedSourceFromEntry(entry: SourceEntry, cache: Map<string, ExtractedSource>): Promise<ExtractedSource | null> {
  if (entry.availability !== "available" || !entry.stable_locator) return null;
  const cached = cache.get(entry.stable_locator);
  if (cached) return cached;
  const extracted = await extractSourceText(entry.stable_locator);
  const source: ExtractedSource = {
    ref: entry.declared_source_ref,
    locator: entry.stable_locator,
    hash: entry.content_hash ?? (await sha256(entry.stable_locator)),
    method: extracted.method,
    text: extracted.text,
    lines: extracted.text.split(/\r?\n/)
  };
  cache.set(entry.stable_locator, source);
  return source;
}

function sourceByRef(manifestSources: SourceEntry[]): Map<string, SourceEntry> {
  return new Map(manifestSources.map((entry) => [entry.declared_source_ref, entry]));
}

export async function resolveDirectEvidence(input: { root?: string; runDir: string; applicantPath: string; manifestPath: string; inventoryPath: string }): Promise<{ extracts: DirectEvidenceExtract[]; contextResolution: ContextEvidenceResolution[]; proposals: unknown[]; summary: unknown; artifactRefs: string[] }> {
  const root = input.root ?? getProjectRoot();
  const manifestRaw = parse(await fs.readFile(input.manifestPath, "utf8")) as { sources: SourceEntry[] };
  const inventoryRaw = parse(await fs.readFile(input.inventoryPath, "utf8")) as { applicant_context_ref: string; records: InventoryRecord[] };
  const applicantBefore = await fs.readFile(input.applicantPath, "utf8");
  const applicantRaw = parse(applicantBefore) as { contexts: unknown[] };
  const contextsById = new Map(applicantRaw.contexts.map((context) => [isRecord(context) && typeof context.id === "string" ? context.id : "", context]));
  const sources = [...manifestRaw.sources];
  const byRef = sourceByRef(sources);
  for (const record of inventoryRaw.records) {
    for (const ref of record.declared_source_refs) {
      const existing = byRef.get(ref);
      if (existing && existing.availability === "available") continue;
      const repo = await resolveRepositoryRef(root, ref);
      if (repo && repo.availability === "available") {
        byRef.set(ref, repo);
        const index = sources.findIndex((entry) => entry.declared_source_ref === ref);
        if (index >= 0) sources[index] = repo;
        else sources.push(repo);
      }
    }
  }

  const cache = new Map<string, ExtractedSource>();
  const extracts: DirectEvidenceExtract[] = [];
  const contextResolution: ContextEvidenceResolution[] = [];
  const extractionFailures = new Map<string, string>();

  for (const record of inventoryRaw.records) {
    const context = contextsById.get(record.context_ref);
    const claims = extractExactEvidence(context);
    const constraints = isRecord(context) && Array.isArray(context.constraints) ? context.constraints.filter((item): item is string => typeof item === "string") : record.constraints ?? [];
    const availableRefs = record.declared_source_refs.filter((ref) => byRef.get(ref)?.availability === "available");
    const missingRefs = record.declared_source_refs.filter((ref) => byRef.get(ref)?.availability !== "available");
    const statementResolution: StatementResolution[] = [];
    const supportingRefs: string[] = [];

    for (const claim of claims) {
      const unresolvedReasons: string[] = [];
      const matchedExtracts: string[] = [];
      let claimHadExtractionFailure = false;
      for (const sourceRef of availableRefs) {
        const sourceEntry = byRef.get(sourceRef)!;
        let source: ExtractedSource | null = null;
        try {
          source = await extractedSourceFromEntry(sourceEntry, cache);
        } catch (error) {
          extractionFailures.set(sourceRef, error instanceof Error ? error.message : String(error));
          claimHadExtractionFailure = true;
          continue;
        }
        if (!source) continue;
        const match = matchEvidence(source, claim);
        if (!match) continue;
        const id = `extract_${stableId(record.context_ref, sourceRef, claim, match.status)}`;
        extracts.push({
          id,
          context_ref: record.context_ref,
          source_ref: sourceRef,
          source_locator: source.locator,
          source_hash: source.hash,
          extraction_method: source.method,
          location: { page: null, line_start: match.line_start, line_end: match.line_end },
          extracted_text: match.extracted_text,
          claimed_evidence: claim,
          match_status: match.status,
          constraints
        });
        matchedExtracts.push(id);
        supportingRefs.push(id);
        break;
      }
      if (matchedExtracts.length === 0) {
        if (availableRefs.length === 0 && missingRefs.length > 0) unresolvedReasons.push("source_unavailable");
        else if (claimHadExtractionFailure) unresolvedReasons.push("extraction_failed");
        else unresolvedReasons.push("not_found_in_available_sources");
      }
      statementResolution.push({
        claimed_evidence: claim,
        match_status: matchedExtracts.length > 0 ? "exact_match" : availableRefs.length === 0 ? "source_unavailable" : claimHadExtractionFailure ? "extraction_failed" : "not_found",
        source_refs_checked: [...availableRefs],
        supporting_extract_refs: matchedExtracts,
        unresolved_reasons: unresolvedReasons
      });
    }

    const uniqueSupportingRefs = [...new Set(supportingRefs)];
    const resolvedCount = statementResolution.filter((statement) => statement.supporting_extract_refs.length > 0).length;
    const unresolvedCount = Math.max(0, claims.length - resolvedCount);
    let resolutionStatus: ContextResolutionStatus;
    if (claims.length > 0 && resolvedCount === claims.length) resolutionStatus = "resolved";
    else if (resolvedCount > 0) resolutionStatus = "partially_resolved";
    else if (availableRefs.length === 0 && missingRefs.length > 0) resolutionStatus = "source_unavailable";
    else if (availableRefs.some((ref) => extractionFailures.has(ref))) resolutionStatus = "extraction_failed";
    else resolutionStatus = "unresolved";
    const unresolvedReasons = [...new Set([...missingRefs.map((ref) => `source_unavailable:${ref}`), ...statementResolution.flatMap((statement) => statement.unresolved_reasons), ...availableRefs.filter((ref) => extractionFailures.has(ref)).map((ref) => `extraction_failed:${ref}`)])];
    contextResolution.push({
      context_ref: record.context_ref,
      declared_evidence_count: claims.length,
      resolved_evidence_count: resolvedCount,
      unresolved_evidence_count: unresolvedCount,
      supporting_extract_refs: uniqueSupportingRefs,
      resolution_status: resolutionStatus,
      unresolved_reasons: unresolvedReasons,
      statement_resolution: statementResolution,
      missing_source_refs: missingRefs,
      extraction_failed_source_refs: availableRefs.filter((ref) => extractionFailures.has(ref)),
      constraints
    });
  }

  const proposals = contextResolution
    .filter((resolution) => resolution.context_ref === "jeremy_new_inc_big_shot_music_curation" && resolution.resolved_evidence_count > 0)
    .map((resolution) => ({
      context_ref: resolution.context_ref,
      current_evidence_status: extractEvidenceStatus(contextsById.get(resolution.context_ref)),
      proposed_evidence_status: resolution.unresolved_evidence_count === 0 ? "documentary_source_backed" : "partially_documentary_source_backed",
      apply_automatically: false,
      rationale: "Available Big Shot source documents contain deterministic exact or normalized-exact support for at least one declared evidence statement.",
      supporting_extract_refs: resolution.supporting_extract_refs
    }));

  const summary = {
    schema_version: "corus.direct_evidence_resolution_summary.v1",
    applicant_context_ref: inventoryRaw.applicant_context_ref,
    source_inventory_ref: path.relative(root, input.inventoryPath),
    repository_references_resolved: sources.filter((entry) => entry.declared_source_ref.startsWith("corus-workbench/") && entry.availability === "available").map((entry) => entry.declared_source_ref),
    documents_extracted: [...new Set([...cache.values()].map((source) => path.relative(root, source.locator)))].sort(),
    context_counts: {
      resolved: contextResolution.filter((item) => item.resolution_status === "resolved").length,
      partially_resolved: contextResolution.filter((item) => item.resolution_status === "partially_resolved").length,
      unresolved: contextResolution.filter((item) => item.resolution_status === "unresolved").length,
      source_unavailable: contextResolution.filter((item) => item.resolution_status === "source_unavailable").length,
      extraction_failed: contextResolution.filter((item) => item.resolution_status === "extraction_failed").length
    },
    evidence_status_proposals: proposals,
    unavailable_sources: [...new Set(contextResolution.flatMap((item) => item.missing_source_refs))].sort(),
    extraction_failures: Object.fromEntries(extractionFailures.entries()),
    provider_calls_made: [],
    pipeline_status: "ready_for_internal_semantic_retrieval",
    direct_retrieval: {
      status: "completed_valid_output",
      internal_semantic_retrieval: "not_started",
      external_source_discovery: "not_started"
    }
  };

  const applicantAfter = await fs.readFile(input.applicantPath, "utf8");
  if (applicantBefore !== applicantAfter) throw new Error("Original applicant ledger changed during direct evidence resolution.");
  for (const resolution of contextResolution) {
    if ((resolution.resolution_status === "resolved" || resolution.resolution_status === "partially_resolved") && resolution.supporting_extract_refs.length === 0) throw new Error(`Resolved context ${resolution.context_ref} has no supporting extract.`);
  }
  for (const extract of extracts) {
    const currentHash = await sha256(extract.source_locator);
    if (currentHash !== extract.source_hash) throw new Error(`Source hash mismatch for ${extract.id}.`);
    if (!extract.source_locator || extract.location.line_start === undefined) throw new Error(`Extract ${extract.id} lacks a stable location.`);
  }

  const extractArtifact = {
    schema_version: "corus.direct_evidence_resolution.v1",
    applicant_context_ref: inventoryRaw.applicant_context_ref,
    source_inventory_ref: path.relative(root, input.inventoryPath),
    extracts,
    context_resolution: contextResolution
  };

  await fs.mkdir(input.runDir, { recursive: true });
  const extractPath = path.join(input.runDir, "14-direct-evidence-extracts.yaml");
  const resolutionPath = path.join(input.runDir, "15-applicant-context-evidence-resolution.yaml");
  const summaryPath = path.join(input.runDir, "16-direct-evidence-resolution-summary.yaml");
  const proposalPath = path.join(input.runDir, "17-evidence-status-change-proposals.yaml");
  await fs.writeFile(extractPath, stringify(extractArtifact), "utf8");
  await fs.writeFile(resolutionPath, stringify({ schema_version: "corus.applicant_context_evidence_resolution.v1", context_resolution: contextResolution }), "utf8");
  await fs.writeFile(summaryPath, stringify(summary), "utf8");
  await fs.writeFile(proposalPath, stringify({ schema_version: "corus.evidence_status_change_proposals.v1", proposals }), "utf8");
  return { extracts, contextResolution, proposals, summary, artifactRefs: [extractPath, resolutionPath, summaryPath, proposalPath].map((file) => path.relative(root, file)) };
}
