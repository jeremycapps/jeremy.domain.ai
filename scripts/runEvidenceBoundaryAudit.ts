import { getProjectRoot } from "../src/lib/paths.js";
import { runEvidenceBoundaryAudit } from "../src/lib/evidenceBoundaryAudit.js";

const runIdArgIndex = process.argv.indexOf("--run-id");
const runId = runIdArgIndex >= 0 ? process.argv[runIdArgIndex + 1] : "f7e05845-c863-48fa-988a-b022df5275a3";
const result = await runEvidenceBoundaryAudit({ root: getProjectRoot(), runId });
console.log(JSON.stringify({
  status: result.status,
  proposals: result.proposals,
  current_permitted_count: result.preview.current_permitted_count,
  proposed_permitted_count: result.preview.proposed_permitted_count,
  artifact_refs: result.artifact_refs
}, null, 2));
