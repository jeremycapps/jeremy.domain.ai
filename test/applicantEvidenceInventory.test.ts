import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import type { Context } from "../src/types.js";
import {
  buildApplicantEvidenceInventory,
  buildApplicantSourceManifest,
  runApplicantEvidenceInventory,
  validateApplicantEvidenceInventory
} from "../src/lib/applicantEvidenceInventory.js";

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "corus-applicant-inventory-test-"));
  await fs.mkdir(path.join(root, "test", "fixtures", "prophet", "sources", "subject"), { recursive: true });
  await fs.mkdir(path.join(root, "outputs", "run-1"), { recursive: true });
  return root;
}

function contextRecord(id: string, sourceRefs: string[], options: { status?: string; exactEvidence?: string[] } = {}) {
  return {
    id,
    direction: "demonstrated",
    skill: { value: id },
    origin: {
      evidence_source: {
        evidence_status: options.status ?? "source_backed",
        source_refs: sourceRefs,
        exact_evidence: options.exactEvidence ?? []
      }
    }
  };
}

function applicantContext(records: unknown[]): Context {
  return {
    id: "applicant_context",
    kind: "subject",
    label: "Applicant",
    sources: ["applicant.yaml"],
    content: {
      meta: { subject: { id: "jeremy" } },
      contexts: records
    },
    generation: {
      operation: "contextualize",
      provider: "deterministic",
      model: "structured-context-ledger",
      prompt_version: "source-ledger.v1",
      input_refs: ["applicant.yaml"],
      schema_version: "corus.context.v1",
      created_at: "2026-07-13T00:00:00.000Z"
    }
  };
}

async function writeSource(root: string, filename: string, body = "source") {
  const file = path.join(root, "test", "fixtures", "prophet", "sources", "subject", filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
}

async function writeRunInputs(root: string, records: unknown[]) {
  const applicantPath = path.join(root, "applicant.yaml");
  const targetPath = path.join(root, "outputs", "run-1", "08-admitted-job-requirement-clusters.yaml");
  await fs.writeFile(applicantPath, stringify({ meta: { subject: { id: "jeremy" } }, contexts: records }), "utf8");
  await fs.writeFile(
    targetPath,
    stringify({
      downstream_policy: {
        capability_derivation: { include: ["capability_cluster"], exclude: ["employment_conditions", "hiring_qualifying_questions"] },
        candidate_confirmation: ["employment_conditions"],
        recruiter_question_inputs: ["hiring_qualifying_questions"]
      }
    }),
    "utf8"
  );
  return { applicantPath, targetPath };
}

test("fully resolvable source refs become directly_resolved", async () => {
  const root = await tempRoot();
  await writeSource(root, "Source A.pdf");
  const ctx = applicantContext([contextRecord("ctx_direct", ["Source A.pdf"])]);
  const manifest = await buildApplicantSourceManifest({ applicantContext: ctx, sourceDir: path.join(root, "test/fixtures/prophet/sources/subject") });
  const inventory = buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: manifest });
  assert.equal(inventory.records[0].evidence_status, "directly_resolved");
  assert.equal(inventory.records[0].eligible_for_direct_use, true);
});

test("named unavailable source becomes source_missing", async () => {
  const root = await tempRoot();
  const ctx = applicantContext([contextRecord("ctx_missing", ["Unavailable Source.pdf"])]);
  const manifest = await buildApplicantSourceManifest({ applicantContext: ctx, sourceDir: path.join(root, "test/fixtures/prophet/sources/subject") });
  const inventory = buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: manifest });
  assert.equal(inventory.records[0].evidence_status, "source_missing");
  assert.deepEqual(inventory.records[0].unresolved_source_refs, ["Unavailable Source.pdf"]);
});

test("user assertions remain user_asserted_document_needed", async () => {
  const root = await tempRoot();
  await writeSource(root, "User assertion in conversation - roadmap.txt");
  const ctx = applicantContext([contextRecord("ctx_user", ["User assertion in conversation: roadmap"], { status: "user_asserted_needs_document_source" })]);
  const manifest = await buildApplicantSourceManifest({ applicantContext: ctx, sourceDir: path.join(root, "test/fixtures/prophet/sources/subject") });
  const inventory = buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: manifest });
  assert.equal(inventory.records[0].evidence_status, "user_asserted_document_needed");
  assert.equal(inventory.records[0].eligible_for_direct_use, false);
});

test("nonempty source_refs alone do not imply support", async () => {
  const root = await tempRoot();
  const ctx = applicantContext([contextRecord("ctx_declared", ["Named But Missing Source.docx"])]);
  const manifest = await buildApplicantSourceManifest({ applicantContext: ctx, sourceDir: path.join(root, "test/fixtures/prophet/sources/subject") });
  const inventory = buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: manifest });
  assert.equal(inventory.records[0].eligible_for_direct_use, false);
  assert.equal(inventory.records[0].evidence_status, "source_missing");
});

test("exact evidence text alone does not imply availability", async () => {
  const root = await tempRoot();
  const ctx = applicantContext([contextRecord("ctx_exact", ["Missing Exact Evidence Source.docx"], { exactEvidence: ["Exact quoted evidence."] })]);
  const manifest = await buildApplicantSourceManifest({ applicantContext: ctx, sourceDir: path.join(root, "test/fixtures/prophet/sources/subject") });
  const inventory = buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: manifest });
  assert.equal(inventory.records[0].exact_evidence_count, 1);
  assert.equal(inventory.records[0].evidence_status, "source_missing");
});

test("duplicate applicant context IDs fail validation", async () => {
  const ctx = applicantContext([contextRecord("dup", ["A.pdf"]), contextRecord("dup", ["A.pdf"])]);
  assert.throws(
    () =>
      validateApplicantEvidenceInventory({
        applicantContext: ctx,
        inventory: buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: [] }),
        sourceManifest: [],
        originalApplicantBytes: "same",
        currentApplicantBytes: "same",
        originalTargetBytes: "same",
        currentTargetBytes: "same"
      }),
    /Duplicate applicant context IDs/
  );
});

test("every declared source ref must receive a resolution state", async () => {
  const root = await tempRoot();
  const ctx = applicantContext([contextRecord("ctx_refs", ["A.pdf", "B.pdf"])]);
  const manifest = await buildApplicantSourceManifest({ applicantContext: ctx, sourceDir: path.join(root, "test/fixtures/prophet/sources/subject") });
  const inventory = buildApplicantEvidenceInventory({ applicantContext: ctx, applicantContextRef: "applicant.yaml", sourceManifest: manifest });
  inventory.records[0].unresolved_source_refs.pop();
  assert.throws(
    () =>
      validateApplicantEvidenceInventory({
        applicantContext: ctx,
        inventory,
        sourceManifest: manifest,
        originalApplicantBytes: "same",
        currentApplicantBytes: "same",
        originalTargetBytes: "same",
        currentTargetBytes: "same"
      }),
    /Declared source refs are not fully accounted/
  );
});

test("run inventory preserves the original applicant ledger", async () => {
  const root = await tempRoot();
  await writeSource(root, "Source A.pdf");
  const records = [contextRecord("ctx_direct", ["Source A.pdf"])];
  const { applicantPath } = await writeRunInputs(root, records);
  const before = await fs.readFile(applicantPath, "utf8");
  await runApplicantEvidenceInventory({ root, applicantSource: "applicant.yaml", admittedClusterPath: "outputs/run-1/08-admitted-job-requirement-clusters.yaml", runDir: path.join(root, "outputs", "run-1") });
  const after = await fs.readFile(applicantPath, "utf8");
  assert.equal(after, before);
});

test("inventory run does not invoke providers and leaves unavailable metrics null", async () => {
  const root = await tempRoot();
  await writeSource(root, "Source A.pdf");
  await writeRunInputs(root, [contextRecord("ctx_direct", ["Source A.pdf"])]);
  const result = await runApplicantEvidenceInventory({ root, applicantSource: "applicant.yaml", admittedClusterPath: "outputs/run-1/08-admitted-job-requirement-clusters.yaml", runDir: path.join(root, "outputs", "run-1") });
  const summary = result.summary as { provider_calls_made: unknown[]; coverage_metrics: Record<string, unknown> };
  assert.deepEqual(summary.provider_calls_made, []);
  assert.equal(summary.coverage_metrics.input_tokens, null);
  assert.equal(summary.coverage_metrics.output_tokens, null);
  assert.equal(summary.coverage_metrics.total_tokens, null);
  assert.equal(summary.coverage_metrics.estimated_cost_usd, null);
  assert.equal(summary.coverage_metrics.latency_ms, null);
  assert.equal(summary.coverage_metrics.measurement_source, "unavailable");
});
