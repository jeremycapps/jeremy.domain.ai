import assert from "node:assert/strict";
import test from "node:test";
import { clustersAffectedByProposedEvidence, proposedPermittedIds } from "../src/lib/evidenceBoundaryAudit.js";

test("proposed permitted ids add only resolved or partially resolved contexts", () => {
  assert.deepEqual(
    proposedPermittedIds(["a", "b"], [
      { context_ref: "c", proposed_status: "partially_resolved" },
      { context_ref: "d", proposed_status: "unresolved" }
    ]),
    ["a", "b", "c"]
  );
});

test("affected clusters are derived from invalid pre-filter evidence refs", () => {
  const affected = clustersAffectedByProposedEvidence(
    {
      cluster_classifications: [
        { cluster_id: "one", invalid_unresolved_evidence_refs: [{ evidence_ref: "ctx_a" }] },
        { cluster_id: "two", invalid_unresolved_evidence_refs: [{ evidence_ref: "ctx_b" }] },
        { cluster_id: "three", invalid_unresolved_evidence_refs: [] }
      ]
    },
    ["ctx_b"]
  );
  assert.deepEqual(affected, ["two"]);
});
