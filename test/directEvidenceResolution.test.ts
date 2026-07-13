import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { resolveDirectEvidence } from "../src/lib/directEvidenceResolution.js";

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "corus-direct-evidence-test-"));
  await fs.mkdir(path.join(root, "outputs", "run-1"), { recursive: true });
  await fs.mkdir(path.join(root, "test", "fixtures", "prophet", "sources", "subject"), { recursive: true });
  return root;
}

function context(id: string, refs: string[], exact: string[], status = "source_backed", constraints: string[] = []) {
  return {
    id,
    direction: "demonstrated",
    origin: {
      evidence_source: {
        source_refs: refs,
        evidence_status: status,
        exact_evidence: exact
      }
    },
    constraints
  };
}

async function writeInputs(root: string, records: ReturnType<typeof context>[], sources: Array<{ ref: string; file?: string | null; availability?: "available" | "missing"; hash?: string | null }> = []) {
  const applicantPath = path.join(root, "applicant.yaml");
  await fs.writeFile(applicantPath, stringify({ contexts: records }), "utf8");
  const sourceEntries = sources.map((source) => ({
    declared_source_ref: source.ref,
    filename: source.file ? path.basename(source.file) : null,
    stable_locator: source.file ?? null,
    availability: source.availability ?? (source.file ? "available" : "missing"),
    content_hash: source.hash ?? null,
    applicant_context_refs: records.filter((record) => record.origin.evidence_source.source_refs.includes(source.ref)).map((record) => record.id)
  }));
  const inventory = {
    applicant_context_ref: "applicant.yaml",
    records: records.map((record) => ({
      context_ref: record.id,
      evidence_status: record.origin.evidence_source.evidence_status,
      declared_source_refs: record.origin.evidence_source.source_refs,
      resolved_source_refs: record.origin.evidence_source.source_refs.filter((ref) => sourceEntries.some((entry) => entry.declared_source_ref === ref && entry.availability === "available")),
      unresolved_source_refs: record.origin.evidence_source.source_refs.filter((ref) => !sourceEntries.some((entry) => entry.declared_source_ref === ref && entry.availability === "available")),
      exact_evidence_count: record.origin.evidence_source.exact_evidence.length,
      constraints: record.constraints
    }))
  };
  const manifestPath = path.join(root, "outputs", "run-1", "11-applicant-source-manifest.yaml");
  const inventoryPath = path.join(root, "outputs", "run-1", "12-applicant-evidence-inventory.yaml");
  await fs.writeFile(manifestPath, stringify({ sources: sourceEntries }), "utf8");
  await fs.writeFile(inventoryPath, stringify(inventory), "utf8");
  return { applicantPath, manifestPath, inventoryPath, runDir: path.join(root, "outputs", "run-1") };
}

async function writeTextSource(root: string, filename: string, body: string) {
  const file = path.join(root, "test", "fixtures", "prophet", "sources", "subject", filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  const hash = (await import("node:crypto")).createHash("sha256").update(await fs.readFile(file)).digest("hex");
  return { file, hash };
}

test("extracts exact local document evidence", async () => {
  const root = await tempRoot();
  const { file, hash } = await writeTextSource(root, "source.txt", "Line one\nExact claim appears here.\nLine three");
  const inputs = await writeInputs(root, [context("ctx_doc", ["Source"], ["Exact claim appears here."])], [{ ref: "Source", file, hash }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.extracts.length, 1);
  assert.equal(result.extracts[0].match_status, "exact_match");
  assert.equal(result.contextResolution[0].resolution_status, "resolved");
});

test("resolves explicit repository path when the declared checkout path exists", async () => {
  const root = await tempRoot();
  const repoFile = path.join(root, "corus-workbench", "pyproject.toml");
  await fs.mkdir(path.dirname(repoFile), { recursive: true });
  await fs.writeFile(repoFile, "[project]\nname = \"corus-workbench\"\n", "utf8");
  const inputs = await writeInputs(root, [context("ctx_repo", ["corus-workbench/pyproject.toml"], ["name = \"corus-workbench\""])], [{ ref: "corus-workbench/pyproject.toml", availability: "missing" }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.contextResolution[0].resolution_status, "resolved");
  assert.equal(result.extracts[0].source_ref, "corus-workbench/pyproject.toml");
});

test("supports normalized exact matching without fuzzy or semantic matching", async () => {
  const root = await tempRoot();
  const { file, hash } = await writeTextSource(root, "source.md", "Built a source-of-truth workflow for operations.");
  const inputs = await writeInputs(root, [context("ctx_norm", ["Source"], ["Built a source of truth workflow for operations."])], [{ ref: "Source", file, hash }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.extracts[0].match_status, "normalized_exact_match");
});

test("records partial resolution when only some declared evidence is found", async () => {
  const root = await tempRoot();
  const { file, hash } = await writeTextSource(root, "source.txt", "Found claim.");
  const inputs = await writeInputs(root, [context("ctx_partial", ["Source"], ["Found claim.", "Missing claim."])], [{ ref: "Source", file, hash }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.contextResolution[0].resolution_status, "partially_resolved");
  assert.equal(result.contextResolution[0].resolved_evidence_count, 1);
  assert.equal(result.contextResolution[0].unresolved_evidence_count, 1);
});

test("unavailable repository path remains unsupported", async () => {
  const root = await tempRoot();
  const inputs = await writeInputs(root, [context("ctx_unavailable", ["corus-workbench/missing.py"], ["missing evidence"])], [{ ref: "corus-workbench/missing.py", availability: "missing" }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.contextResolution[0].resolution_status, "source_unavailable");
  assert.deepEqual(result.extracts, []);
});

test("extraction failure is deterministic and does not support the statement", async () => {
  const root = await tempRoot();
  const unsupported = path.join(root, "test", "fixtures", "prophet", "sources", "subject", "image.png");
  await fs.writeFile(unsupported, "not a supported text artifact", "utf8");
  const inputs = await writeInputs(root, [context("ctx_fail", ["Image"], ["not a supported text artifact"])], [{ ref: "Image", file: unsupported }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.contextResolution[0].resolution_status, "extraction_failed");
  assert.deepEqual(result.extracts, []);
});

test("Big Shot evidence status upgrade is proposed but not applied", async () => {
  const root = await tempRoot();
  const { file, hash } = await writeTextSource(root, "big-shot.txt", "Created playlist curation source.");
  const records = [context("jeremy_new_inc_big_shot_music_curation", ["Big Shot"], ["Created playlist curation source."], "user_asserted_document_needed")];
  const inputs = await writeInputs(root, records, [{ ref: "Big Shot", file, hash }]);
  const before = await fs.readFile(inputs.applicantPath, "utf8");
  const result = await resolveDirectEvidence({ root, ...inputs });
  const after = await fs.readFile(inputs.applicantPath, "utf8");
  assert.equal(after, before);
  assert.equal((result.proposals[0] as { apply_automatically: boolean }).apply_automatically, false);
});

test("repository evidence does not prove deployment by itself", async () => {
  const root = await tempRoot();
  const repoFile = path.join(root, "corus-workbench", "corus", "playground.py");
  await fs.mkdir(path.dirname(repoFile), { recursive: true });
  await fs.writeFile(repoFile, "def run_agent():\n    return 'implemented local playground'\n", "utf8");
  const inputs = await writeInputs(root, [context("ctx_repo_constraints", ["corus-workbench/corus/playground.py"], ["implemented local playground"], "github_source_backed", ["Do not claim deployed LLM agent lifecycle ownership from this context alone."])], [{ ref: "corus-workbench/corus/playground.py", availability: "missing" }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.contextResolution[0].resolution_status, "resolved");
  assert.deepEqual(result.extracts[0].constraints, ["Do not claim deployed LLM agent lifecycle ownership from this context alone."]);
  assert.doesNotMatch(result.extracts[0].extracted_text, /production deployment/i);
});

test("extracts include source hashes and stable line locations", async () => {
  const root = await tempRoot();
  const { file, hash } = await writeTextSource(root, "source.txt", "First\nSecond claim\nThird");
  const inputs = await writeInputs(root, [context("ctx_hash", ["Source"], ["Second claim"])], [{ ref: "Source", file, hash }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.equal(result.extracts[0].source_hash, hash);
  assert.equal(result.extracts[0].source_locator, file);
  assert.equal(result.extracts[0].location.line_start, 1);
});

test("direct evidence resolution records zero provider calls", async () => {
  const root = await tempRoot();
  const { file, hash } = await writeTextSource(root, "source.txt", "Exact claim.");
  const inputs = await writeInputs(root, [context("ctx_zero", ["Source"], ["Exact claim."])], [{ ref: "Source", file, hash }]);
  const result = await resolveDirectEvidence({ root, ...inputs });
  assert.deepEqual((result.summary as { provider_calls_made: unknown[] }).provider_calls_made, []);
});
