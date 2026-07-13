import assert from "node:assert/strict";
import test from "node:test";
import { admittedDerivationClustersForReview, clusterCapabilityProvenance, completedClusterIdsFromRecords, excludedClustersForReview, geminiSourcingCandidates, routeApplicantRecord } from "../src/lib/prophetAdmittedCapabilityState.js";

test("record-level routing keeps directly sourced records on direct retrieval", () => {
  assert.equal(routeApplicantRecord({ evidence_status: "directly_resolved", resolved_source_refs: ["Resume"], unresolved_source_refs: [] }), "direct_retrieval");
});

test("record-level routing sends partially sourced records to internal retrieval", () => {
  assert.equal(routeApplicantRecord({ evidence_status: "source_declared_search_required", resolved_source_refs: ["Resume"], unresolved_source_refs: ["Missing"] }), "internal_lexical_retrieval");
});

test("record-level routing sends only still-unsourced records to Gemini sourcing candidates", () => {
  const records = [
    { context_ref: "direct", evidence_status: "directly_resolved", resolved_source_refs: ["Resume"], unresolved_source_refs: [], declared_source_refs: [], exact_evidence_count: 1, constraints: [] },
    { context_ref: "internal", evidence_status: "source_declared_search_required", resolved_source_refs: ["Resume"], unresolved_source_refs: ["Missing"], declared_source_refs: [], exact_evidence_count: 1, constraints: [] },
    { context_ref: "missing", evidence_status: "user_asserted_document_needed", resolved_source_refs: [], unresolved_source_refs: ["User assertion"], declared_source_refs: [], exact_evidence_count: 1, constraints: [] }
  ];
  assert.deepEqual(geminiSourcingCandidates(records), ["missing"]);
});

test("malformed records are not promoted to Gemini sourcing candidates", () => {
  assert.equal(routeApplicantRecord({ evidence_status: "malformed", resolved_source_refs: [], unresolved_source_refs: [] }), "malformed");
});


test("all nine admitted derivation clusters are accounted for and excluded clusters stay out", () => {
  const admitted = {
    clusters: [
      ...Array.from({ length: 9 }, (_value, index) => ({ id: `cluster_${index}`, label: `Cluster ${index}`, requirement_refs: [`req_${index}`] })),
      { id: "employment_conditions", label: "Employment Conditions", requirement_refs: ["hybrid"] },
      { id: "hiring_qualifying_questions", label: "Hiring Qualifying Questions", requirement_refs: ["question"] }
    ],
    downstream_policy: { capability_derivation: { include: Array.from({ length: 9 }, (_value, index) => `cluster_${index}`), exclude: ["employment_conditions", "hiring_qualifying_questions"] }, candidate_confirmation: ["employment_conditions"], recruiter_question_inputs: ["hiring_qualifying_questions"] }
  };
  assert.equal(admittedDerivationClustersForReview(admitted).length, 9);
  assert.deepEqual(excludedClustersForReview(admitted), ["employment_conditions", "hiring_qualifying_questions"]);
});

test("unresolved applicant contexts are not used as positive evidence candidates", () => {
  const records = [
    { context_ref: "resolved", evidence_status: "directly_resolved", resolved_source_refs: ["doc"], unresolved_source_refs: [], declared_source_refs: [], exact_evidence_count: 1, constraints: [] },
    { context_ref: "unresolved", evidence_status: "user_asserted_document_needed", resolved_source_refs: [], unresolved_source_refs: ["assertion"], declared_source_refs: [], exact_evidence_count: 1, constraints: [] }
  ];
  assert.equal(routeApplicantRecord(records[0]), "direct_retrieval");
  assert.deepEqual(geminiSourcingCandidates(records), ["unresolved"]);
});

test("successful clusters survive later cluster failure and resume skips completed clusters", () => {
  const records = [
    { type: "capability_reduction", validation_status: "completed_valid_output", output_ref: "outputs/run/24-capability-candidates-one.yaml" },
    { type: "capability_reduction", validation_status: "error", output_ref: "outputs/run/24-capability-candidates-two-failure.yaml" }
  ] as any;
  assert.deepEqual(completedClusterIdsFromRecords(records), ["one"]);
});

test("aggregation preserves cluster and requirement provenance", () => {
  const provenance = clusterCapabilityProvenance([
    {
      cluster_id: "product_delivery",
      requirement_refs: ["req_a"],
      reduction: { reducer: "capabilities", inputs: { subject: "subject", target: "target" }, capabilities: [{ id: "cap_a", requirement_ref: "req_a", statement: "A", evidence_refs: ["ctx_a"], support: "supported", confidence: "high", generated_by: { provider: "anthropic", model: "mock", prompt_version: "test" } }] }
    }
  ]);
  assert.deepEqual(provenance, [{ capability_id: "cap_a", cluster_id: "product_delivery", requirement_ref: "req_a", requirement_ref_admitted_for_cluster: true, evidence_refs: ["ctx_a"] }]);
});

test("provider attempts use distinct cluster artifact names", () => {
  const records = [
    { type: "capability_reduction", validation_status: "completed_valid_output", raw_output_ref: "outputs/run/raw-24-capability-candidates-provider-one.json" },
    { type: "capability_reduction", validation_status: "completed_valid_output", raw_output_ref: "outputs/run/raw-24-capability-candidates-provider-two.json" }
  ] as any;
  assert.equal(new Set(records.map((record: any) => record.raw_output_ref)).size, 2);
});
