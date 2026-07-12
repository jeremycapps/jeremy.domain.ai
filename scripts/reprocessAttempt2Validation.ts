import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CapabilityReduction, CapabilityValidation, Context, ProviderMetrics, StageGenerationRecord } from "../src/types.js";
import { artifactRef, stageRecord, writeGenerationRecords, writeYamlArtifact } from "../src/lib/corusArtifacts.js";
import { getProjectRoot } from "../src/lib/paths.js";
import { metricsFromUsage, parseJsonObject, textFromOpenAIResponse } from "../src/providers/providerUtils.js";
import { validateCapabilityValidationOutput } from "../src/providers/validators.js";

function metricWithLatency(raw: unknown, usage: unknown): ProviderMetrics {
  const metrics = metricsFromUsage(Date.now(), usage);
  if (raw && typeof raw === "object") {
    const record = raw as { created_at?: unknown; completed_at?: unknown };
    if (typeof record.created_at === "number" && typeof record.completed_at === "number") {
      return { ...metrics, latency_ms: Math.max(0, (record.completed_at - record.created_at) * 1000), measurement_source: "derived" };
    }
  }
  return { ...metrics, latency_ms: null, measurement_source: "unavailable" };
}

async function readYaml<T>(filePath: string): Promise<T> {
  return parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function usageFromObject(raw: unknown, key: "usage" | "usageMetadata"): unknown {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
}

async function main() {
  const root = getProjectRoot();
  const runId = process.argv[2] ?? "b9e4e3fd-0ca2-41f1-884e-dd43c57e5051";
  const outputDir = path.join(root, "outputs", runId);

  const subjectArtifact = path.join(outputDir, "01-subject-context.yaml");
  const targetArtifact = path.join(outputDir, "01-target-context.yaml");
  const capabilitiesArtifact = path.join(outputDir, "02-capabilities.yaml");
  const subjectRawArtifact = path.join(outputDir, "raw-01-subject-context-provider.json");
  const targetRawArtifact = path.join(outputDir, "raw-01-target-context-provider.json");
  const reductionRawArtifact = path.join(outputDir, "raw-02-capabilities-provider.json");
  const validationRawArtifact = path.join(outputDir, "raw-03-validation-provider-error.json");

  const subject = (await readYaml<{ context: Context }>(subjectArtifact)).context;
  const target = (await readYaml<{ context: Context }>(targetArtifact)).context;
  const reduction = await readYaml<CapabilityReduction>(capabilitiesArtifact);
  const subjectRaw = await readJson(subjectRawArtifact);
  const targetRaw = await readJson(targetRawArtifact);
  const reductionRaw = await readJson(reductionRawArtifact);
  const validationRaw = await readJson(validationRawArtifact);
  const validation = validateCapabilityValidationOutput(parseJsonObject(textFromOpenAIResponse(validationRaw)), "openai");
  const validationArtifact = await writeYamlArtifact(outputDir, "03-validation.yaml", { validation });

  const records: StageGenerationRecord[] = [
    stageRecord({
      type: "contextualization",
      input_refs: subject.generation.input_refs,
      output_ref: artifactRef(root, subjectArtifact),
      raw_output_ref: artifactRef(root, subjectRawArtifact),
      provider: subject.generation.provider,
      model: subject.generation.model,
      prompt_version: subject.generation.prompt_version,
      schema_version: subject.generation.schema_version,
      validation_status: "created",
      metrics: metricWithLatency(subjectRaw, usageFromObject(subjectRaw, "usageMetadata"))
    }),
    stageRecord({
      type: "contextualization",
      input_refs: target.generation.input_refs,
      output_ref: artifactRef(root, targetArtifact),
      raw_output_ref: artifactRef(root, targetRawArtifact),
      provider: target.generation.provider,
      model: target.generation.model,
      prompt_version: target.generation.prompt_version,
      schema_version: target.generation.schema_version,
      validation_status: "created",
      metrics: metricWithLatency(targetRaw, usageFromObject(targetRaw, "usageMetadata"))
    }),
    stageRecord({
      type: "capability_reduction",
      input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
      output_ref: artifactRef(root, capabilitiesArtifact),
      raw_output_ref: artifactRef(root, reductionRawArtifact),
      provider: "anthropic",
      model: (reductionRaw as { model?: string }).model ?? "unknown",
      prompt_version: reduction.capabilities[0]?.generated_by.prompt_version ?? "reduce.anthropic.v1",
      schema_version: "corus.capabilities.v1",
      validation_status: "unvalidated",
      metrics: metricWithLatency(reductionRaw, usageFromObject(reductionRaw, "usage"))
    }),
    stageRecord({
      type: "capability_validation",
      input_refs: [artifactRef(root, capabilitiesArtifact), artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
      output_ref: artifactRef(root, validationArtifact),
      raw_output_ref: artifactRef(root, validationRawArtifact),
      provider: "openai",
      model: (validationRaw as { model?: string }).model ?? "unknown",
      prompt_version: "validate.openai.v1",
      schema_version: "corus.validation.v1",
      validation_status: validation.status,
      metrics: metricWithLatency(validationRaw, usageFromObject(validationRaw, "usage"))
    })
  ];

  await writeGenerationRecords(outputDir, records);

  let architectArtifact: string | undefined;
  if (validation.status === "architect_required") {
    architectArtifact = await writeYamlArtifact(outputDir, "04-architect-decision.yaml", {
      status: "architect_required",
      validation,
      decision: "Architect review required before semantic recommendation can be implemented.",
      remediation_case: "application_code"
    });
  }

  const summary = {
    run_id: runId,
    status: validation.status,
    provider_called: false,
    validation,
    generation_records: artifactRef(root, path.join(outputDir, "generation-records.json")),
    architect_decision: architectArtifact ? artifactRef(root, architectArtifact) : null
  };
  await fs.writeFile(path.join(outputDir, "05-checkpoint-continuation-summary.yaml"), stringify(summary), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

await main();
