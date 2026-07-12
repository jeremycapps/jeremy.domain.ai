import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CapabilityAnalysisResponse, CapabilityReduction, CapabilityValidation, Context, StageGenerationRecord } from "../src/types.js";
import { artifactRef, stageRecord, writeGenerationRecords, writeMarkdownArtifact, writeYamlArtifact } from "../src/lib/corusArtifacts.js";
import { evaluateCapabilityRun } from "../src/lib/corusEvaluation.js";
import { projectValidatedCapabilities } from "../src/lib/corusProjection.js";
import { getProjectRoot } from "../src/lib/paths.js";

const ARCHITECT_RESOLUTION = {
  cap_maia_platform_technical_ownership: {
    disposition: "adjacent",
    rationale:
      "Corus demonstrates hands-on multi-agent platform prototyping, provider orchestration, schema-constrained handoffs, validation, failure routing, checkpoint recovery, and live API integration. It does not yet demonstrate deployed production platform ownership."
  },
  cap_platform_rollout_and_delivery_improvement: {
    disposition: "adjacent",
    accept_validator_result: true
  },
  cap_architecture_tradeoff_to_roadmap_judgment: {
    disposition: "adjacent",
    accept_validator_result: true
  },
  cap_operational_source_of_truth_for_platform_decisions: {
    disposition: "unsupported_for_target",
    accept_validator_result: true
  }
} as const;

async function readYaml<T>(filePath: string): Promise<T> {
  return parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function normalizeRecord(record: StageGenerationRecord): StageGenerationRecord {
  const source = record.metrics.measurement_source;
  if (source) return record;
  if (record.metrics.latency_ms === null) {
    return { ...record, metrics: { ...record.metrics, measurement_source: "unavailable" } };
  }
  if (record.type === "projection" || record.provider === "codex") {
    return { ...record, metrics: { ...record.metrics, measurement_source: "measured" } };
  }
  if (record.provider === "openai" && typeof record.metrics.latency_ms === "number" && record.metrics.latency_ms > 0) {
    return { ...record, metrics: { ...record.metrics, measurement_source: "derived" } };
  }
  return { ...record, metrics: { ...record.metrics, latency_ms: null, measurement_source: "unavailable" } };
}

function resolvedValidation(): CapabilityValidation {
  return {
    status: "passed",
    findings: [
      {
        capability_id: "cap_maia_platform_technical_ownership",
        severity: "info",
        type: "product_ambiguity",
        message: ARCHITECT_RESOLUTION.cap_maia_platform_technical_ownership.rationale
      }
    ],
    validated_capability_ids: [
      "cap_maia_platform_technical_ownership",
      "cap_platform_rollout_and_delivery_improvement",
      "cap_architecture_tradeoff_to_roadmap_judgment"
    ],
    rejected_capability_ids: ["cap_operational_source_of_truth_for_platform_decisions"]
  };
}

async function main() {
  const root = getProjectRoot();
  const runId = process.argv[2] ?? "b9e4e3fd-0ca2-41f1-884e-dd43c57e5051";
  const outputDir = path.join(root, "outputs", runId);
  const subjectArtifact = path.join(outputDir, "01-subject-context.yaml");
  const targetArtifact = path.join(outputDir, "01-target-context.yaml");
  const capabilitiesArtifact = path.join(outputDir, "02-capabilities.yaml");
  const generationRecordsArtifact = path.join(outputDir, "generation-records.json");

  const subject = (await readYaml<{ context: Context }>(subjectArtifact)).context;
  const target = (await readYaml<{ context: Context }>(targetArtifact)).context;
  const reduction = await readYaml<CapabilityReduction>(capabilitiesArtifact);
  const existingRecords = (await readJson<StageGenerationRecord[]>(generationRecordsArtifact)).map(normalizeRecord);
  const validation = resolvedValidation();

  const resolutionArtifact = await writeYamlArtifact(outputDir, "06-architect-resolution.yaml", {
    status: "resolved",
    provider_called: false,
    architect_resolution: ARCHITECT_RESOLUTION,
    validation
  });

  const projection = projectValidatedCapabilities(reduction.capabilities, validation, "capability_assessment");
  const projectionArtifact = await writeMarkdownArtifact(outputDir, "07-projection.md", projection.content);
  const records = [
    ...existingRecords,
    stageRecord({
      type: "projection",
      input_refs: [artifactRef(root, resolutionArtifact), artifactRef(root, capabilitiesArtifact)],
      output_ref: artifactRef(root, projectionArtifact),
      provider: "codex",
      model: "deterministic-projection",
      prompt_version: "projection.v1",
      schema_version: "corus.projection.v1",
      validation_status: validation.status,
      metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0, measurement_source: "measured" }
    })
  ];
  await writeGenerationRecords(outputDir, records);

  const run: CapabilityAnalysisResponse = {
    run_id: runId,
    status: "passed",
    mode: "live",
    contexts: { subject, target },
    capabilities: reduction.capabilities,
    validation,
    projection,
    generation_records: records,
    artifact_dir: artifactRef(root, outputDir)
  };

  const baselineRef = "test/fixtures/prophet/jeremy_prophet_senior_product_manager_capabilities.yaml";
  const baseline = parse(await fs.readFile(path.join(root, baselineRef), "utf8"));
  const report = evaluateCapabilityRun({ run, baseline, fixture: "prophet", baselineRef });
  const evaluationArtifact = await writeYamlArtifact(outputDir, "08-evaluation.yaml", report);
  const summary = {
    run_id: runId,
    status: "passed",
    provider_calls_made: 0,
    projected_capability_ids: projection.capability_ids,
    generation_records: artifactRef(root, generationRecordsArtifact),
    architect_resolution: artifactRef(root, resolutionArtifact),
    projection: artifactRef(root, projectionArtifact),
    evaluation: artifactRef(root, evaluationArtifact),
    evaluation_scores: report.evaluation.quality,
    verdict: report.evaluation.verdict
  };
  await fs.writeFile(path.join(outputDir, "09-architect-resolution-summary.yaml"), stringify(summary), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

await main();
