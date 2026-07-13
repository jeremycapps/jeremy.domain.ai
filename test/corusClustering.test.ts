import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import type { Context, JobRequirementClusters } from "../src/types.js";
import {
  allRequirementRefs,
  jobRequirementClusterSchema,
  jobRequirementClusteringPolicy,
  requirementEntries,
  runJobRequirementClustering,
  runJobRequirementClusterRepair,
  validateClusterIntegrity,
  validateJobRequirementClusterSchema
} from "../src/lib/jobRequirementClustering.js";
import { normalizeContext, readSourceInput } from "../src/lib/corusContext.js";
import { MockJobRequirementClusteringProvider, MockJobRequirementClusterRepairProvider } from "../src/providers/mockProviders.js";
import { GeminiJobRequirementClusteringProvider, GeminiJobRequirementClusterRepairProvider } from "../src/providers/liveProviders.js";

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "corus-clustering-test-"));
  await fs.mkdir(path.join(root, "test", "fixtures"), { recursive: true });
  await fs.cp(path.join(process.cwd(), "test", "fixtures", "prophet"), path.join(root, "test", "fixtures", "prophet"), { recursive: true });
  return root;
}

async function tempRootWithFirstLiveRun() {
  const root = await tempRoot();
  const runId = "0fb881f5-cf18-43e3-a0a8-e251b8115098";
  await fs.mkdir(path.join(root, "outputs"), { recursive: true });
  await fs.cp(path.join(process.cwd(), "outputs", runId), path.join(root, "outputs", runId), { recursive: true });
  return { root, runId };
}

async function prophetTargetContext(root = process.cwd()): Promise<Context> {
  const source = await readSourceInput("test/fixtures/prophet/prophet_senior_product_manager.yaml", root);
  return normalizeContext(source, "target", "target", "test/fixtures/prophet/prophet_senior_product_manager.yaml");
}

function validProposal(target: Context, overrides: Partial<JobRequirementClusters> = {}): JobRequirementClusters {
  const ids = requirementEntries(target).map((entry) => entry.id);
  const clusters = [
    { id: "cluster.one", label: "One", requirement_refs: ids.slice(0, 6), rationale: "First coherent job-requirement domain." },
    { id: "cluster.two", label: "Two", requirement_refs: ids.slice(6, 12), rationale: "Second coherent job-requirement domain." },
    { id: "cluster.three", label: "Three", requirement_refs: ids.slice(12, 18), rationale: "Third coherent job-requirement domain." },
    { id: "cluster.four", label: "Four", requirement_refs: ids.slice(18, 24), rationale: "Fourth coherent job-requirement domain." },
    { id: "cluster.five", label: "Five", requirement_refs: ids.slice(24, 29), rationale: "Fifth coherent job-requirement domain." },
    { id: "cluster.six", label: "Six", requirement_refs: ids.slice(29), rationale: "Sixth coherent job-requirement domain." }
  ];
  return {
    schema_version: "corus.job_requirement_clusters.v1",
    job_description_ref: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
    clustering_policy_ref: "corus.job_requirement_clustering_policy.v1",
    clusters,
    unassigned_requirement_refs: [],
    overlapping_requirements: [],
    generated_by: {
      role: "implementer",
      provider: "gemini",
      model: "mock-gemini-clusterer",
      prompt_version: "cluster-job-requirements.gemini.v1"
    },
    ...overrides
  };
}

test("mocked Prophet clustering preserves 34 requirements and stops at Author review", async () => {
  const root = await tempRoot();
  const clusterer = new MockJobRequirementClusteringProvider();
  const run = await runJobRequirementClustering(
    {
      subject_source: "test/fixtures/prophet/jeremy_corus.yaml",
      target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
      mode: "mocked"
    },
    { root, providers: { clusterer } }
  );

  assert.equal(run.pipeline_status, "awaiting_author");
  assert.equal(run.stage_status.cluster_admission, "awaiting_author");
  assert.equal(run.stage_status.applicant_evidence_retrieval, "not_reached");
  assert.equal(run.contexts.subject, undefined);
  assert.equal(run.contexts.target.generation.model, "structured-context-ledger");
  assert.equal(requirementEntries(run.contexts.target).length, 34);
  assert.equal(clusterer.calls.length, 1);
  assert.equal(requirementEntries(clusterer.calls[0].job_description).length, 34);
  assert.equal(clusterer.calls[0].policy.id, jobRequirementClusteringPolicy.id);
  assert.deepEqual(clusterer.calls[0].schema, jobRequirementClusterSchema());
  assert.deepEqual(run.clusters?.clusters.map((cluster) => cluster.label), [
    "Mock cluster 1",
    "Mock cluster 2",
    "Mock cluster 3",
    "Mock cluster 4",
    "Mock cluster 5",
    "Mock cluster 6",
    "Mock cluster 7"
  ]);
  assert.equal(run.clusters?.clusters[0].rationale, "Deterministic mock group used to test clustering pipeline mechanics.");
  assert.equal(JSON.stringify(clusterer.calls[0]).includes("jeremy_capps"), false);
  assert.equal(JSON.stringify(clusterer.calls[0]).includes("evidence_refs"), false);
  assert.equal(new Set(allRequirementRefs(run.clusters!)).size, 34);
  assert.equal(run.integrity?.checks.all_original_requirements_accounted_for, true);
  assert.equal(run.generation_records.some((record) => record.provider === "anthropic"), false);
  assert.equal(run.generation_records.some((record) => record.provider === "openai"), false);
  assert.equal(JSON.stringify(run.generation_records).includes("jeremy_corus"), false);

  const runDir = path.join(root, run.artifact_dir);
  await assert.rejects(fs.access(path.join(runDir, "01-job-applicant-context.yaml")));
  await fs.access(path.join(runDir, "01-job-description-context.yaml"));
  await fs.access(path.join(runDir, "02-job-requirement-clusters-proposed.yaml"));
  await fs.access(path.join(runDir, "03-cluster-integrity.yaml"));
  await fs.access(path.join(runDir, "04-job-requirement-cluster-review.md"));
  await fs.access(path.join(runDir, "generation-records.json"));
  await fs.access(path.join(runDir, "run-status.yaml"));
  await assert.rejects(fs.access(path.join(runDir, "04-projection.md")));

  const review = await fs.readFile(path.join(runDir, "04-job-requirement-cluster-review.md"), "utf8");
  assert.match(review, /Decision requested:/);
  assert.match(review, /deterministic mock fixture/);
  assert.match(review, /prophet_ai_evaluation_protocols/);
});

test("live Gemini clustering request contains only job description, policy, and schema", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "mock-live-gemini";
  const target = await prophetTargetContext();
  const proposal = validProposal(target);
  proposal.generated_by.model = "mock-live-gemini";
  let requestBody = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(proposal) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
      })
    } as Response;
  }) as typeof fetch;

  try {
    proposal.generated_by.provider = "Prophet";
    proposal.generated_by.model = "model-authored-wrong";
    const result = await new GeminiJobRequirementClusteringProvider().execute({
      job_description: target,
      job_description_ref: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
      policy: jobRequirementClusteringPolicy,
      schema: jobRequirementClusterSchema()
    });
    assert.equal(result.provider, "google");
    assert.equal(result.output.generated_by.provider, "google");
    assert.equal(result.output.generated_by.model, "mock-live-gemini");
    assert.equal(result.metrics.total_tokens, 30);
    assert.match(requestBody, /prophet_maia_product_execution/);
    assert.match(requestBody, /corus.job_requirement_clustering_policy.v1/);
    assert.match(requestBody, /corus.job_requirement_clusters.v1/);
    assert.doesNotMatch(requestBody, /jeremy_capps/);
    assert.doesNotMatch(requestBody, /evidence_refs/);
    assert.doesNotMatch(requestBody, /validated_capability_ids/);
    assert.match(requestBody, /responseSchema/);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test("cluster schema rejects malformed final payloads", () => {
  assert.throws(() => validateJobRequirementClusterSchema({ status: "completed" }), /schema_version/);
});

test("cluster integrity accepts complete proposals and preserves the original ledger", async () => {
  const target = await prophetTargetContext();
  const proposal = validProposal(target);
  const source = target.content;
  const integrity = validateClusterIntegrity({ original: target, originalLedgerBefore: source, originalLedgerAfter: source, proposal });
  assert.equal(integrity.status, "valid");
  assert.equal(integrity.checks.all_original_requirements_accounted_for, true);
  assert.equal(integrity.checks.original_ledger_unchanged, true);
});

test("unknown job-requirement refs fail deterministic validation", async () => {
  const target = await prophetTargetContext();
  const proposal = validProposal(target);
  proposal.clusters[0].requirement_refs[0] = "missing_requirement";
  const integrity = validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal });
  assert.equal(integrity.status, "structurally_invalid");
  assert.deepEqual(integrity.checks.unknown_requirement_refs, ["missing_requirement"]);
});

test("missing requirements fail unless explicitly listed as unassigned", async () => {
  const target = await prophetTargetContext();
  const missing = validProposal(target);
  const removed = missing.clusters[0].requirement_refs.pop()!;
  assert.equal(validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal: missing }).status, "structurally_invalid");
  const unassigned = validProposal(target);
  const unassignedRef = unassigned.clusters[0].requirement_refs.pop()!;
  unassigned.unassigned_requirement_refs.push(unassignedRef);
  const integrity = validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal: unassigned });
  assert.equal(integrity.status, "author_review_required");
  assert.deepEqual(integrity.review_conditions.unassigned_requirement_refs, [unassignedRef]);
  assert.ok(removed);
});

test("duplicate cluster IDs and duplicate refs inside one cluster fail", async () => {
  const target = await prophetTargetContext();
  const duplicateId = validProposal(target);
  duplicateId.clusters[1].id = duplicateId.clusters[0].id;
  assert.equal(validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal: duplicateId }).status, "structurally_invalid");

  const duplicateRef = validProposal(target);
  duplicateRef.clusters[0].requirement_refs.push(duplicateRef.clusters[0].requirement_refs[0]);
  const integrity = validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal: duplicateRef });
  assert.equal(integrity.status, "structurally_invalid");
  assert.equal(integrity.checks.duplicate_refs_within_clusters[0].cluster_ref, "cluster.one");
});

test("overlaps, singleton clusters, and oversized clusters route to Author review", async () => {
  const target = await prophetTargetContext();
  const proposal = validProposal(target);
  proposal.clusters[0].requirement_refs.push(proposal.clusters[1].requirement_refs[0]);
  const removedFromSingleton = proposal.clusters[5].requirement_refs.slice(1);
  proposal.clusters[5].requirement_refs = [proposal.clusters[5].requirement_refs[0]];
  proposal.unassigned_requirement_refs.push(...removedFromSingleton);
  proposal.overlapping_requirements.push({
    requirement_ref: proposal.clusters[0].requirement_refs[0],
    cluster_refs: ["cluster.one", "cluster.two"],
    rationale: "The job description explicitly combines these domains."
  });
  const integrity = validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal });
  assert.equal(integrity.status, "author_review_required");
  assert.deepEqual(integrity.review_conditions.overlapping_requirement_refs, [proposal.clusters[0].requirement_refs[0]]);
  assert.deepEqual(integrity.review_conditions.singleton_cluster_refs, ["cluster.six"]);
  assert.deepEqual(integrity.review_conditions.unusually_large_cluster_refs, ["cluster.one"]);
});

test("invalid overlap cluster refs fail deterministic validation", async () => {
  const target = await prophetTargetContext();
  const proposal = validProposal(target);
  proposal.overlapping_requirements.push({
    requirement_ref: proposal.clusters[0].requirement_refs[0],
    cluster_refs: ["cluster.one", "cluster.missing"],
    rationale: "Invalid overlap."
  });
  const integrity = validateClusterIntegrity({ original: target, originalLedgerBefore: target.content, originalLedgerAfter: target.content, proposal });
  assert.equal(integrity.status, "structurally_invalid");
  assert.deepEqual(integrity.checks.invalid_overlap_refs, ["cluster.missing"]);
});

test("provider max_tokens without final payload becomes provider_incomplete", async () => {
  const root = await tempRoot();
  const run = await runJobRequirementClustering(
    { subject_source: "test/fixtures/prophet/jeremy_corus.yaml", target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml", mode: "mocked" },
    { root, providers: { clusterer: new MockJobRequirementClusteringProvider("provider_incomplete") } }
  );
  assert.equal(run.pipeline_status, "provider_incomplete");
  assert.equal(run.stage_status.job_requirement_clustering, "provider_incomplete");
});

test("malformed final payload becomes schema_invalid", async () => {
  const root = await tempRoot();
  const run = await runJobRequirementClustering(
    { subject_source: "test/fixtures/prophet/jeremy_corus.yaml", target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml", mode: "mocked" },
    { root, providers: { clusterer: new MockJobRequirementClusteringProvider("schema_invalid", { nope: true }) } }
  );
  assert.equal(run.pipeline_status, "schema_invalid");
});

test("schema-valid proposal with unknown IDs becomes structurally_invalid", async () => {
  const root = await tempRoot();
  const target = await prophetTargetContext(root);
  const proposal = validProposal(target);
  proposal.clusters[0].requirement_refs[0] = "unknown_requirement";
  const run = await runJobRequirementClustering(
    { subject_source: "test/fixtures/prophet/jeremy_corus.yaml", target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml", mode: "mocked" },
    { root, providers: { clusterer: new MockJobRequirementClusteringProvider("valid", proposal) } }
  );
  assert.equal(run.pipeline_status, "structurally_invalid");
  assert.equal(run.stage_status.cluster_integrity_validation, "structurally_invalid");
});


test("mocked cluster repair completes all 34 IDs and routes to Author review", async () => {
  const { root, runId } = await tempRootWithFirstLiveRun();
  const repairer = new MockJobRequirementClusterRepairProvider("valid");
  const run = await runJobRequirementClusterRepair(
    { original_run_id: runId, target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml", mode: "mocked" },
    { root, providers: { repairer } }
  );
  assert.equal(run.pipeline_status, "awaiting_author");
  assert.equal(run.stage_status.original_live_job_requirement_clustering, "structurally_invalid");
  assert.equal(run.stage_status.cluster_completeness_repair, "completed_valid_output");
  assert.equal(run.stage_status.repaired_cluster_integrity_validation, "completed_valid_output");
  assert.equal(run.stage_status.cluster_admission, "awaiting_author");
  assert.equal(repairer.calls.length, 1);
  assert.deepEqual(repairer.calls[0].missing_requirement_refs, [
    "prophet_hands_on_engineering_partnership",
    "prophet_client_application_implementation",
    "prophet_operational_product_discipline"
  ]);
  assert.equal(JSON.stringify(repairer.calls[0]).includes("jeremy_capps"), false);
  assert.equal(JSON.stringify(repairer.calls[0]).includes("evidence_refs"), false);
  assert.equal(run.integrity?.checks.accounted_requirement_count, 34);
  assert.equal(run.generation_records.some((record) => record.provider === "anthropic"), false);
  assert.equal(run.generation_records.some((record) => record.provider === "openai"), false);
  const runDir = path.join(root, run.artifact_dir);
  await fs.access(path.join(runDir, "05-repaired-job-requirement-cluster-review.md"));
});

test("mocked cluster repair still missing an ID stops structurally invalid without retry", async () => {
  const { root, runId } = await tempRootWithFirstLiveRun();
  const repairer = new MockJobRequirementClusterRepairProvider("missing_one");
  const run = await runJobRequirementClusterRepair(
    { original_run_id: runId, target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml", mode: "mocked" },
    { root, providers: { repairer } }
  );
  assert.equal(run.pipeline_status, "structurally_invalid");
  assert.equal(run.stage_status.repaired_cluster_integrity_validation, "structurally_invalid");
  assert.equal(repairer.calls.length, 1);
  assert.equal(run.integrity?.checks.missing_requirement_refs.includes("prophet_operational_product_discipline"), true);
});

test("live Gemini repair request contains only job-description repair materials and overrides provenance", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "mock-live-gemini-repair";
  const target = await prophetTargetContext();
  const proposal = validProposal(target);
  proposal.generated_by.provider = "Prophet";
  proposal.generated_by.model = "model-authored-wrong";
  proposal.generated_by.prompt_version = "cluster-job-requirements.gemini.v1";
  let requestBody = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return {
      ok: true,
      json: async () => ({
        modelVersion: "models/mock-live-gemini-repair-returned",
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(proposal) }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 }
      })
    } as Response;
  }) as typeof fetch;

  try {
    const result = await new GeminiJobRequirementClusterRepairProvider().execute({
      job_description: target,
      job_description_ref: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
      policy: jobRequirementClusteringPolicy,
      schema: jobRequirementClusterSchema(),
      previous_proposal: proposal,
      previous_proposal_ref: "outputs/0fb881f5-cf18-43e3-a0a8-e251b8115098/02-job-requirement-clusters-proposed.yaml",
      integrity_result: {
        schema_version: "corus.job_requirement_cluster_integrity.v1",
        status: "structurally_invalid",
        checks: { original_requirement_count: 34, accounted_requirement_count: 31, all_original_requirements_accounted_for: false, unknown_requirement_refs: [], missing_requirement_refs: ["prophet_hands_on_engineering_partnership"], duplicate_cluster_ids: [], duplicate_refs_within_clusters: [], invalid_unassigned_refs: [], unreported_overlaps: [], invalid_overlap_refs: [], original_ids_unchanged: true, original_text_unchanged: true, original_ledger_unchanged: true, applicant_context_absent: true },
        review_conditions: { unassigned_requirement_refs: [], overlapping_requirement_refs: [], singleton_cluster_refs: [], unusually_large_cluster_refs: [], ambiguous_cluster_refs: [] }
      },
      integrity_result_ref: "outputs/0fb881f5-cf18-43e3-a0a8-e251b8115098/03-cluster-integrity.yaml",
      missing_requirement_refs: ["prophet_hands_on_engineering_partnership"]
    });
    assert.equal(result.output.generated_by.provider, "google");
    assert.equal(result.output.generated_by.model, "mock-live-gemini-repair-returned");
    assert.equal(result.output.generated_by.prompt_version, "cluster-job-requirements.gemini.repair.v1");
    assert.equal(result.metrics.total_tokens, 33);
    assert.match(requestBody, /previous_proposal/);
    assert.match(requestBody, /integrity_result/);
    assert.match(requestBody, /missing_requirement_refs/);
    assert.doesNotMatch(requestBody, /jeremy_capps/);
    assert.doesNotMatch(requestBody, /validated_capability_ids/);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});
