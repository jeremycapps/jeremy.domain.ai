import { runFilteredCapabilityRegeneration } from "../src/lib/prophetAdmittedCapabilityState.js";
import { getProjectRoot } from "../src/lib/paths.js";

const runIdArgIndex = process.argv.indexOf("--run-id");
const runId = runIdArgIndex >= 0 ? process.argv[runIdArgIndex + 1] : "f7e05845-c863-48fa-988a-b022df5275a3";
const root = getProjectRoot();

try {
  const result = await runFilteredCapabilityRegeneration({ root, runId });
  console.log(JSON.stringify({ status: result.status, claude_cluster_calls: result.claude_cluster_calls, openai_reached: result.openai_reached, artifact_refs: result.artifact_refs }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
