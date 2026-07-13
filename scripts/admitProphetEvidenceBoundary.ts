import { promises as fs } from "node:fs";
import { stringify } from "yaml";
import { applyAuthorEvidenceBoundaryDecision } from "../src/lib/prophetAdmittedCapabilityState.js";
import { getProjectRoot } from "../src/lib/paths.js";

const runIdArgIndex = process.argv.indexOf("--run-id");
const decisionArgIndex = process.argv.indexOf("--decision-file");
const runId = runIdArgIndex >= 0 ? process.argv[runIdArgIndex + 1] : "f7e05845-c863-48fa-988a-b022df5275a3";
const decisionFile = decisionArgIndex >= 0 ? process.argv[decisionArgIndex + 1] : `outputs/${runId}/author-evidence-admission-decision.yaml`;
const root = getProjectRoot();

try {
  await fs.access(decisionFile.startsWith("/") ? decisionFile : `${root}/${decisionFile}`);
} catch {
  console.error(JSON.stringify({ status: "blocked", message: `Decision file not found: ${decisionFile}` }, null, 2));
  process.exit(1);
}

const result = await applyAuthorEvidenceBoundaryDecision({ root, runId, decisionFile });
await fs.writeFile(`${root}/outputs/${runId}/run-status.yaml`, stringify({ pipeline_status: result.status, updated_at: new Date().toISOString() }), "utf8");
console.log(JSON.stringify({ status: result.status, permitted_evidence_context_count: result.admission.permitted_evidence_context_ids.length, artifact_refs: result.artifact_refs }, null, 2));
