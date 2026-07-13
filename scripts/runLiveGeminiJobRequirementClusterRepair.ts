import { promises as fs } from "node:fs";
import path from "node:path";
import { runJobRequirementClusterRepair } from "../src/lib/jobRequirementClustering.js";
import { getProjectRoot } from "../src/lib/paths.js";
import { GeminiJobRequirementClusterRepairProvider } from "../src/providers/liveProviders.js";

async function loadDotEnv(root: string) {
  const envPath = path.join(root, ".env");
  const raw = await fs.readFile(envPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  const root = getProjectRoot();
  await loadDotEnv(root);
  if (!process.env.GEMINI_API_KEY) {
    console.error(JSON.stringify({ status: "blocked", reason: "Missing Gemini credential.", missing_credentials: ["GEMINI_API_KEY"] }, null, 2));
    process.exitCode = 1;
    return;
  }
  const run = await runJobRequirementClusterRepair(
    {
      original_run_id: "0fb881f5-cf18-43e3-a0a8-e251b8115098",
      target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
      mode: "live"
    },
    { root, providers: { repairer: new GeminiJobRequirementClusterRepairProvider() } }
  );
  console.log(JSON.stringify(run, null, 2));
  if (run.pipeline_status !== "awaiting_author") process.exitCode = 1;
}

await main();
