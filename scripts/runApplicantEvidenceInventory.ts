import path from "node:path";
import { getProjectRoot } from "../src/lib/paths.js";
import { runApplicantEvidenceInventory } from "../src/lib/applicantEvidenceInventory.js";

const root = getProjectRoot();
const runId = "f7e05845-c863-48fa-988a-b022df5275a3";
const runDir = path.join(root, "outputs", runId);
const result = await runApplicantEvidenceInventory({
  root,
  applicantSource: "test/fixtures/prophet/jeremy_corus.yaml",
  admittedClusterPath: `outputs/${runId}/08-admitted-job-requirement-clusters.yaml`,
  runDir
});
console.log(JSON.stringify({
  applicant_context_count: result.inventory.applicant_context_count,
  source_manifest_count: result.sourceManifest.length,
  counts_by_retrieval_state: result.inventory.summary,
  artifact_refs: result.artifactRefs,
  provider_calls_made: [],
  pipeline_status: "ready_for_direct_evidence_resolution"
}, null, 2));
