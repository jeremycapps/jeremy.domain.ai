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

async function writeLivePrepArtifact(root: string, name: string, value: unknown) {
  const dir = path.join(root, "outputs", "live-prophet-preflight");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), stringify(value), "utf8");
}

async function main() {
  const root = getProjectRoot();
  await loadDotEnv(root);

  const readiness = providerReadiness("live");
  const modelIds = configuredModelIds();
  const preflight: Record<string, unknown> = {
    created_at: new Date().toISOString(),
    readiness,
    configured_models: modelIds
  };

  console.log(JSON.stringify(preflight, null, 2));
  await writeLivePrepArtifact(root, "01-readiness.yaml", preflight);

  if (!readiness.ready) {
    const error = {
      created_at: new Date().toISOString(),
      status: "blocked",
      reason: "Missing live provider credentials.",
      missing_credentials: readiness.missing_credentials
    };
    await writeLivePrepArtifact(root, "error.yaml", error);
    process.exitCode = 1;
    return;
  }

  const model_availability = await checkConfiguredModels();
  await writeLivePrepArtifact(root, "02-model-availability.yaml", { created_at: new Date().toISOString(), model_availability });
  console.log(JSON.stringify({ model_availability }, null, 2));

  const unavailable = model_availability.filter((item) => !item.available);
  if (unavailable.length > 0) {
    await writeLivePrepArtifact(root, "error.yaml", {
      created_at: new Date().toISOString(),
      status: "blocked",
      reason: "One or more configured model IDs are not available.",
      model_availability
    });
    process.exitCode = 1;
    return;
  }

  try {
    const report = await runProphetFixtureEvaluation(root, "live");
    console.log(JSON.stringify({ status: "complete", evaluation: report.evaluation }, null, 2));
  } catch (error) {
    const failure = {
      created_at: new Date().toISOString(),
      status: "error",
      message: error instanceof Error ? error.message : "Unknown live Prophet run error.",
      name: error instanceof Error ? error.name : undefined
    };
    await writeLivePrepArtifact(root, "error.yaml", failure);
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
}

await main();
