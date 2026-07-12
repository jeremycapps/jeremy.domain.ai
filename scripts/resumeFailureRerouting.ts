import { promises as fs } from "node:fs";
import path from "node:path";
import { resumeFailureReroutingFromCheckpoint } from "../src/lib/corusCheckpointResume.js";
import { getProjectRoot } from "../src/lib/paths.js";

async function loadDotEnv(root: string) {
  const envPath = path.join(root, ".env");
  try {
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main() {
  const root = getProjectRoot();
  await loadDotEnv(root);
  const runId = process.argv[2] ?? "91d4c1a6-706f-48a1-bbf0-4c80c400d745";
  const result = await resumeFailureReroutingFromCheckpoint(runId, { root });
  const generationRecordsPath = path.join(root, result.artifact_dir, "generation-records.json");
  const generationRecords = JSON.parse(await fs.readFile(generationRecordsPath, "utf8")) as unknown[];
  console.log(
    JSON.stringify(
      {
        run_id: result.run_id,
        status: result.status,
        provider_failure_classification: result.provider_failure_classification,
        artifact_dir: result.artifact_dir,
        generation_records: generationRecords.length
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown checkpoint resume error.");
  process.exitCode = 1;
});
