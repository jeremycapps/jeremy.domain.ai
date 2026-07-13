import { runJobRequirementClustering } from "../src/lib/jobRequirementClustering.js";
import { getProjectRoot } from "../src/lib/paths.js";

async function main() {
  const root = getProjectRoot();
  const run = await runJobRequirementClustering(
    {
      subject_source: "test/fixtures/prophet/jeremy_corus.yaml",
      target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
      mode: "mocked"
    },
    { root }
  );
  console.log(JSON.stringify(run, null, 2));
  if (run.pipeline_status !== "awaiting_author") process.exitCode = 1;
}

await main();
