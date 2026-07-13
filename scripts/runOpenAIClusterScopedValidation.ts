import { getProjectRoot } from "../src/lib/paths.js";
import { runClusterScopedOpenAIValidation } from "../src/lib/prophetClusterScopedValidation.js";

const runIdArgIndex = process.argv.indexOf("--run-id");
const runId = runIdArgIndex >= 0 ? process.argv[runIdArgIndex + 1] : "f7e05845-c863-48fa-988a-b022df5275a3";
const root = getProjectRoot();

try {
  const result = await runClusterScopedOpenAIValidation({ root, runId });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
