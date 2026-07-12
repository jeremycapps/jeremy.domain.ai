import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { checkConfiguredModels, configuredModelIds, providerReadiness } from "../src/providers/liveProviders.js";
import { runProphetFixtureEvaluation } from "../src/lib/corusEvaluation.js";
import { getProjectRoot } from "../src/lib/paths.js";

async function loadDotEnv(root: string) {
  const envPath = path.join(root, ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeAttemptArtifact(root: string, name: string, value: unknown) {
  const dir = path.join(root, "outputs", "live-prophet-attempt-2-preflight");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), stringify(value), "utf8");
}

async function outputDirectories(root: string): Promise<Set<string>> {
  const outputRoot = path.join(root, "outputs");
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function readGenerationRecords(root: string, runDir: string) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "outputs", runDir, "generation-records.json"), "utf8")) as unknown[];
  } catch {
    return [];
  }
}

async function main() {
  const root = getProjectRoot();
  await loadDotEnv(root);
  const before = await outputDirectories(root);

  const readiness = providerReadiness("live");
  const modelIds = configuredModelIds();
  const preflight = {
    attempt: 2,
    created_at: new Date().toISOString(),
    preserved_baseline_attempt: "attempt_1",
    readiness,
    configured_models: modelIds
  };
  await writeAttemptArtifact(root, "01-readiness.yaml", preflight);
  console.log(JSON.stringify(preflight, null, 2));

  if (!readiness.ready) {
    const error = {
      created_at: new Date().toISOString(),
      status: "blocked",
      reason: "Missing live provider credentials.",
      missing_credentials: readiness.missing_credentials
    };
    await writeAttemptArtifact(root, "error.yaml", error);
    process.exitCode = 1;
    return;
  }

  const model_availability = await checkConfiguredModels();
  await writeAttemptArtifact(root, "02-model-availability.yaml", { created_at: new Date().toISOString(), model_availability });
  console.log(JSON.stringify({ model_availability }, null, 2));

  const unavailable = model_availability.filter((item) => !item.available);
  if (unavailable.length > 0) {
    await writeAttemptArtifact(root, "error.yaml", {
      created_at: new Date().toISOString(),
      status: "blocked",
      reason: "One or more configured model IDs are not available.",
      model_availability
    });
    process.exitCode = 1;
    return;
  }

  let status = "error";
  let evaluation: unknown;
  let error: unknown;
  try {
    const report = await runProphetFixtureEvaluation(root, "live");
    status = "complete";
    evaluation = report.evaluation;
  } catch (caught) {
    error = {
      created_at: new Date().toISOString(),
      status: "error",
      message: caught instanceof Error ? caught.message : "Unknown live Prophet run error.",
      name: caught instanceof Error ? caught.name : undefined
    };
    await writeAttemptArtifact(root, "error.yaml", error);
  }

  const after = await outputDirectories(root);
  const run_dirs = [...after].filter((entry) => !before.has(entry) && entry !== "live-prophet-attempt-2-preflight").sort();
  const generation_records = run_dirs.length === 1 ? await readGenerationRecords(root, run_dirs[0]) : [];
  const summary = {
    attempt: 2,
    created_at: new Date().toISOString(),
    status,
    run_dirs: run_dirs.map((dir) => `outputs/${dir}`),
    generation_records,
    evaluation,
    error
  };
  await writeAttemptArtifact(root, "03-attempt-summary.yaml", summary);
  console.log(JSON.stringify(summary, null, 2));
  if (status !== "complete") process.exitCode = 1;
}

await main();
