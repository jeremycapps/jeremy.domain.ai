import path from "node:path";
import { getProjectRoot } from "../src/lib/paths.js";
import { resolveDirectEvidence } from "../src/lib/directEvidenceResolution.js";

const root = getProjectRoot();
const runId = "f7e05845-c863-48fa-988a-b022df5275a3";
const runDir = path.join(root, "outputs", runId);
const result = await resolveDirectEvidence({
  root,
  runDir,
  applicantPath: path.join(root, "test/fixtures/prophet/jeremy_corus.yaml"),
  manifestPath: path.join(runDir, "11-applicant-source-manifest.yaml"),
  inventoryPath: path.join(runDir, "12-applicant-evidence-inventory.yaml")
});
console.log(JSON.stringify({
  extracts: result.extracts.length,
  context_counts: (result.summary as { context_counts: unknown }).context_counts,
  evidence_status_proposals: result.proposals,
  artifact_refs: result.artifactRefs,
  provider_calls_made: [],
  pipeline_status: "ready_for_internal_semantic_retrieval"
}, null, 2));
