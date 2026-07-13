import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityCandidate, Context, StageGenerationRecord } from "../src/types.js";
import {
  aggregateClusterValidations,
  buildClusterValidationPacket,
  completedOpenAIClusterValidationIdsFromRecords,
  validateClusterValidationOutput,
  validateClusterValidationPacket,
  validationPacketTokenEligibility
} from "../src/lib/prophetClusterScopedValidation.js";

const generationRecord = { provider: "anthropic", model: "claude-sonnet-5", prompt_version: "reduce.anthropic.v1" };
const admission = {
  permitted_evidence_context_ids: ["ev_a", "ev_b", "partial"],
  unresolved_context_ids: ["unresolved"],
  support_ceilings: [{ context_ref: "partial", support_ceiling_when_used_alone: "adjacent" as const, rule: "partial alone cannot support above adjacent", evidence_status: "partially_resolved" }]
};

function context(id: string, entries: Array<{ id: string; text?: string }>): Context {
  return {
    id,
    kind: id.includes("target") ? "target" : "subject",
    label: id,
    sources: [],
    content: { contexts: entries.map((entry) => ({ id: entry.id, text: entry.text ?? entry.id, origin: { evidence_source: { evidence_status: "resolved", selected_evidence_refs: [`chunk_${entry.id}`] } } })) },
    generation: { operation: "contextualize", provider: "fixture", model: "fixture", prompt_version: "fixture", input_refs: [], schema_version: "corus.context.v1", created_at: "2026-07-13T00:00:00.000Z" }
  };
}

function capability(id: string, requirement_ref: string, evidence_refs: string[], support: CapabilityCandidate["support"] = "adjacent"): CapabilityCandidate {
  return { id, requirement_ref, statement: `${id} statement`, evidence_refs, support, confidence: "medium", generated_by: generationRecord };
}

test("validation packets contain only cluster-relevant requirements, capabilities, and evidence", () => {
  const packet = buildClusterValidationPacket({
    runId: "run",
    cluster: { id: "cluster_a", label: "Cluster A", requirement_refs: ["req_a"] },
    targetContext: context("target", [{ id: "req_a" }, { id: "req_other" }]),
    subjectContext: context("subject", [{ id: "ev_a" }, { id: "ev_b" }, { id: "unresolved" }]),
    reduction: { reducer: "capabilities", inputs: { subject: "subject", target: "target" }, capabilities: [capability("cap_a", "req_a", ["ev_a"])] },
    generationRecord,
    admission
  });
  assert.deepEqual(packet.requirements.map((entry: any) => entry.id), ["req_a"]);
  assert.deepEqual(packet.capabilities.map((item) => item.id), ["cap_a"]);
  assert.deepEqual(packet.evidence_contexts.map((entry: any) => entry.id), ["ev_a"]);
  assert.equal(JSON.stringify(packet).includes("req_other"), false);
  assert.equal(JSON.stringify(packet).includes("unresolved"), true, "unresolved policy may be present, but unresolved context body must not be included");
  assert.deepEqual(packet.evidence_contexts.some((entry: any) => entry.id === "unresolved"), false);
});

test("packet preflight rejects invalid scope and unresolved evidence", () => {
  const packet = buildClusterValidationPacket({
    runId: "run",
    cluster: { id: "cluster_a", label: "Cluster A", requirement_refs: ["req_a"] },
    targetContext: context("target", [{ id: "req_a" }]),
    subjectContext: context("subject", [{ id: "unresolved" }]),
    reduction: { reducer: "capabilities", inputs: { subject: "subject", target: "target" }, capabilities: [capability("cap_a", "req_a", ["unresolved"])] },
    generationRecord,
    admission
  });
  const result = validateClusterValidationPacket(packet, { id: "cluster_a", requirement_refs: ["req_a"] }, admission);
  assert.equal(result.status, "structurally_invalid");
  assert.ok(result.errors.some((error) => error.includes("unresolved evidence")));
});

test("token preflight blocks individual and rolling ineligible calls", () => {
  const packet = { large: "x".repeat(1000) };
  assert.equal(validationPacketTokenEligibility(packet, 0, 100, 50).individually_eligible, false);
  assert.equal(validationPacketTokenEligibility({ small: "ok" }, 90, 100, 20).rolling_eligible, false);
});

test("successful cluster validations survive later failure and resume skips completed validations", () => {
  const records = [
    { type: "capability_validation", validation_status: "completed_valid_output", output_ref: "outputs/run/37-openai-cluster-validation-normalized-one.yaml" },
    { type: "capability_validation", validation_status: "structurally_invalid", output_ref: "outputs/run/37-openai-cluster-validation-normalized-two.yaml" }
  ] as StageGenerationRecord[];
  assert.deepEqual(completedOpenAIClusterValidationIdsFromRecords(records), ["one"]);
});

test("OpenAI cluster output cannot introduce IDs or overlap decision sets", () => {
  const packet = buildClusterValidationPacket({
    runId: "run",
    cluster: { id: "cluster_a", label: "Cluster A", requirement_refs: ["req_a"] },
    targetContext: context("target", [{ id: "req_a" }]),
    subjectContext: context("subject", [{ id: "ev_a" }]),
    reduction: { reducer: "capabilities", inputs: { subject: "subject", target: "target" }, capabilities: [capability("cap_a", "req_a", ["ev_a"])] },
    generationRecord,
    admission
  });
  const result = validateClusterValidationOutput(
    { cluster_id: "cluster_a", status: "passed", validated_capability_ids: ["cap_a", "cap_unknown"], rejected_capability_ids: ["cap_a"], author_review_capability_ids: [], findings: [], proposed_support_corrections: [], evidence_reference_findings: [], unsupported_claim_findings: [] },
    packet
  );
  assert.equal(result.status, "structurally_invalid");
  assert.ok(result.errors.some((error) => error.includes("unknown capability")));
  assert.ok(result.errors.some((error) => error.includes("overlapping decision sets")));
});

test("partial evidence ceilings survive validation", () => {
  const packet = buildClusterValidationPacket({
    runId: "run",
    cluster: { id: "cluster_a", label: "Cluster A", requirement_refs: ["req_a"] },
    targetContext: context("target", [{ id: "req_a" }]),
    subjectContext: context("subject", [{ id: "partial" }]),
    reduction: { reducer: "capabilities", inputs: { subject: "subject", target: "target" }, capabilities: [capability("cap_a", "req_a", ["partial"], "adjacent")] },
    generationRecord,
    admission
  });
  const result = validateClusterValidationOutput(
    { cluster_id: "cluster_a", status: "revise", validated_capability_ids: [], rejected_capability_ids: [], author_review_capability_ids: ["cap_a"], findings: [], proposed_support_corrections: [{ capability_id: "cap_a", from: "adjacent", to: "supported", rationale: "raise it" }], evidence_reference_findings: [], unsupported_claim_findings: [] },
    packet
  );
  assert.equal(result.status, "structurally_invalid");
  assert.ok(result.errors.some((error) => error.includes("support ceiling")));
});

test("aggregation accounts for all 49 capabilities and preserves failed aggregate baseline separately", () => {
  const packets = Array.from({ length: 9 }, (_value, clusterIndex) => {
    const count = clusterIndex === 0 ? 1 : 6;
    const capabilities = Array.from({ length: count }, (_v, index) => capability(`cap_${clusterIndex}_${index}`, `req_${clusterIndex}`, ["ev_a"]));
    return buildClusterValidationPacket({
      runId: "run",
      cluster: { id: ["product_delivery_and_execution", "technical_product_fluency", "ai_platform_and_lifecycle_management", "ai_evaluation_and_quality_assurance", "strategic_product_design", "governance_and_enterprise_integration", "adoption_communication_and_stakeholder_management", "product_sense_and_user_experience", "client_delivery_and_productionization"][clusterIndex], label: "Cluster", requirement_refs: [`req_${clusterIndex}`] },
      targetContext: context("target", [{ id: `req_${clusterIndex}` }]),
      subjectContext: context("subject", [{ id: "ev_a" }]),
      reduction: { reducer: "capabilities", inputs: { subject: "subject", target: "target" }, capabilities },
      generationRecord,
      admission
    });
  });
  const validations = packets.map((packet) => ({ cluster_id: packet.cluster_id, status: "passed" as const, validated_capability_ids: packet.capabilities.map((cap) => cap.id), rejected_capability_ids: [], author_review_capability_ids: [], findings: [], proposed_support_corrections: [], evidence_reference_findings: [], unsupported_claim_findings: [] }));
  const aggregate = aggregateClusterValidations({ packets, validations });
  assert.equal(aggregate.capability_count, 49);
  assert.equal(aggregate.all_49_capabilities_accounted_for, true);
  assert.equal("aggregate_validation_request_exceeds_tpm_limit", "aggregate_validation_request_exceeds_tpm_limit");
});
