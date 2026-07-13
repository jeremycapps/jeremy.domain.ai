import { getProjectRoot } from "../src/lib/paths.js";
import { preflightAdmittedCapabilityState, runProphetAdmittedCapabilityStateSafely } from "../src/lib/prophetAdmittedCapabilityState.js";

const runIdArgIndex = process.argv.indexOf("--run-id");
const runId = runIdArgIndex >= 0 ? process.argv[runIdArgIndex + 1] : "f7e05845-c863-48fa-988a-b022df5275a3";
const root = getProjectRoot();
const preflight = await preflightAdmittedCapabilityState({ root, runId });
if (preflight.missing_artifacts.length > 0) {
  console.error(JSON.stringify({ status: "blocked", preflight }, null, 2));
  process.exit(1);
}
try {
  const result = await runProphetAdmittedCapabilityStateSafely({ root, runId });
  console.log(JSON.stringify({ status: result.status, author_action_required: result.author_action_required, artifact_refs: result.artifact_refs }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
