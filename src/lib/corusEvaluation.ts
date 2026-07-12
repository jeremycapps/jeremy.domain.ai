import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type {
  CapabilityAnalysisResponse,
  CapabilityCandidate,
  CapabilityValidation,
  EvaluationReport,
  StageGenerationRecord
} from "../types.js";
import { contextRefs } from "./corusContext.js";
import { runCapabilityAnalysis } from "./corusOrchestrator.js";
import { getProjectRoot } from "./paths.js";

type BaselineCapability = {
  id: string;
  label?: string;
  definition?: string;
  context_refs?: string[];
  memberships?: {
    demonstrated?: string[];
    requested?: string[];
  };
  alignment?: {
    confidence?: string;
    strength?: string;
  };
};

function normalizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

function overlap(a: string, b: string): number {
  const left = normalizeWords(a);
  const right = normalizeWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function semanticMatch(generated: CapabilityCandidate, baseline: BaselineCapability): boolean {
  if (generated.id === baseline.id) return true;
  const baselineText = [baseline.id, baseline.label, baseline.definition].filter(Boolean).join(" ");
  return overlap(generated.statement, baselineText) >= 0.35;
}

function loadBaselineCapabilities(raw: unknown): BaselineCapability[] {
  if (!raw || typeof raw !== "object") return [];
  const capabilities = (raw as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities)
    ? capabilities
        .filter((capability) => capability && typeof capability === "object" && typeof (capability as { id?: unknown }).id === "string")
        .map((capability) => capability as BaselineCapability)
    : [];
}

function sumMetric(records: StageGenerationRecord[], key: "input_tokens" | "output_tokens" | "estimated_cost_usd"): number | null {
  const values = records.map((record) => record.metrics[key]).filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function classifyHallucinations(input: {
  generated: CapabilityCandidate[];
  validation: CapabilityValidation;
  subjectEvidenceRefs: Set<string>;
  targetRequirementRefs: Set<string>;
  projectionCapabilityIds: string[];
}): EvaluationReport["evaluation"]["hallucinations"] {
  const hallucinations: EvaluationReport["evaluation"]["hallucinations"] = [];
  const validated = new Set(input.validation.validated_capability_ids);

  for (const capability of input.generated) {
    if (capability.support === "unsupported") {
      hallucinations.push({
        type: "unsupported_capability",
        capability_id: capability.id,
        message: "Capability is classified unsupported."
      });
    }
    for (const ref of capability.evidence_refs) {
      if (!input.subjectEvidenceRefs.has(ref)) {
        hallucinations.push({
          type: "fabricated_evidence_reference",
          capability_id: capability.id,
          message: `Evidence reference ${ref} does not exist in the subject context.`
        });
      }
      if (input.targetRequirementRefs.has(ref)) {
        hallucinations.push({
          type: "cross_context_leakage",
          capability_id: capability.id,
          message: `Target requirement ${ref} was used as subject evidence.`
        });
      }
    }
    if (!input.targetRequirementRefs.has(capability.requirement_ref)) {
      hallucinations.push({
        type: "fabricated_requirement",
        capability_id: capability.id,
        message: `Requirement reference ${capability.requirement_ref} does not exist in the target context.`
      });
    }
  }

  for (const id of input.projectionCapabilityIds) {
    if (!validated.has(id)) {
      hallucinations.push({
        type: "projection_invention",
        capability_id: id,
        message: "Projection included a capability not validated by OpenAI."
      });
    }
  }

  for (const finding of input.validation.findings) {
    if (finding.type === "evidence_misattribution" || finding.type === "claim_exaggeration") {
      hallucinations.push({
        type: finding.type,
        capability_id: finding.capability_id,
        message: finding.message
      });
    }
  }

  return hallucinations;
}

export function evaluateCapabilityRun(input: {
  run: CapabilityAnalysisResponse;
  baseline: unknown;
  fixture: string;
  baselineRef: string;
}): EvaluationReport {
  const baselineCapabilities = loadBaselineCapabilities(input.baseline);
  const generated = input.run.capabilities;
  const subjectRefs = contextRefs(input.run.contexts.subject);
  const targetRefs = contextRefs(input.run.contexts.target);
  const generatedMatches = new Map<string, string>();
  const differences: EvaluationReport["evaluation"]["differences"] = [];

  for (const capability of generated) {
    const match = baselineCapabilities.find((baseline) => semanticMatch(capability, baseline));
    if (match) {
      generatedMatches.set(capability.id, match.id);
      differences.push({
        type: capability.id === match.id ? "semantic_match" : "wording_only",
        generated_id: capability.id,
        baseline_id: match.id,
        message: "Generated capability aligns with baseline capability."
      });
    } else if (capability.support === "supported") {
      differences.push({
        type: "supported_new_discovery",
        generated_id: capability.id,
        message: "Generated supported capability is absent from baseline and should be reviewed as a possible improvement."
      });
    } else {
      differences.push({
        type: "unsupported_addition",
        generated_id: capability.id,
        message: "Generated capability is absent from baseline and unsupported."
      });
    }
  }

  for (const baseline of baselineCapabilities) {
    if (![...generatedMatches.values()].includes(baseline.id)) {
      differences.push({
        type: "missed_baseline_capability",
        baseline_id: baseline.id,
        message: "Baseline capability was not reproduced by the generated output."
      });
    }
  }

  const hallucinations = classifyHallucinations({
    generated,
    validation: input.run.validation,
    subjectEvidenceRefs: subjectRefs,
    targetRequirementRefs: targetRefs,
    projectionCapabilityIds: input.run.projection?.capability_ids ?? []
  });
  const matchedBaseline = new Set(generatedMatches.values());
  const supportedGenerated = generated.filter((capability) => capability.support === "supported");
  const validEvidence = generated.filter(
    (capability) => capability.evidence_refs.length > 0 && capability.evidence_refs.every((ref) => subjectRefs.has(ref))
  );
  const classificationMatches = generated.filter((capability) => {
    const baselineId = generatedMatches.get(capability.id);
    const baseline = baselineCapabilities.find((item) => item.id === baselineId);
    return baseline ? capability.confidence === baseline.alignment?.confidence || Boolean(baseline.alignment?.strength) : false;
  });
  const latency = input.run.generation_records.reduce((sum, record) => sum + record.metrics.latency_ms, 0);
  const revisionCycles = input.run.generation_records.filter(
    (record) => record.type === "capability_reduction" && record.validation_status === "revised"
  ).length;
  const quality = {
    requirement_coverage: targetRefs.size === 0 ? 0 : new Set(generated.map((capability) => capability.requirement_ref)).size / targetRefs.size,
    capability_recall: baselineCapabilities.length === 0 ? 0 : matchedBaseline.size / baselineCapabilities.length,
    capability_precision: generated.length === 0 ? 0 : generatedMatches.size / generated.length,
    evidence_accuracy: generated.length === 0 ? 0 : validEvidence.length / generated.length,
    classification_agreement: generatedMatches.size === 0 ? 0 : classificationMatches.length / generatedMatches.size,
    unsupported_claims: generated.filter((capability) => capability.support === "unsupported").length,
    schema_valid: input.run.contexts.subject.kind.length > 0 && input.run.contexts.target.kind.length > 0,
    projection_fidelity:
      input.run.projection === null || supportedGenerated.length === 0
        ? 0
        : input.run.projection.capability_ids.filter((id) => supportedGenerated.some((capability) => capability.id === id)).length /
          supportedGenerated.length
  };

  const verdict =
    hallucinations.length > 0 || quality.capability_recall < 0.5
      ? "worse"
      : quality.capability_precision >= 0.8 && quality.capability_recall >= 0.8
        ? "equivalent"
        : differences.some((difference) => difference.type === "supported_new_discovery")
          ? "better_with_review"
          : "worse";

  return {
    evaluation: {
      fixture: input.fixture,
      baseline_ref: input.baselineRef,
      quality,
      efficiency: {
        model_calls: input.run.generation_records.filter((record) => record.provider !== "codex").length,
        revision_cycles: revisionCycles,
        input_tokens: sumMetric(input.run.generation_records, "input_tokens"),
        output_tokens: sumMetric(input.run.generation_records, "output_tokens"),
        estimated_cost_usd: sumMetric(input.run.generation_records, "estimated_cost_usd"),
        latency_ms: latency,
        human_interventions: input.run.status === "architect_required" ? 1 : 0
      },
      differences,
      hallucinations,
      verdict,
      measurement_notes:
        sumMetric(input.run.generation_records, "input_tokens") === null
          ? ["Token and cost metrics are null when providers do not return usage metadata."]
          : []
    }
  };
}

export async function runProphetFixtureEvaluation(root = getProjectRoot(), mode: "mocked" | "fixture" | "live" = "fixture"): Promise<EvaluationReport> {
  const fixtureRoot = path.join(root, "test", "fixtures", "prophet");
  const baselineRef = "test/fixtures/prophet/jeremy_prophet_senior_product_manager_capabilities.yaml";
  const run = await runCapabilityAnalysis(
    {
      subject_source: "test/fixtures/prophet/jeremy_corus.yaml",
      target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
      projection: "capability_assessment",
      mode
    },
    { root }
  );
  const baseline = parse(await fs.readFile(path.join(fixtureRoot, "jeremy_prophet_senior_product_manager_capabilities.yaml"), "utf8"));
  const report = evaluateCapabilityRun({ run, baseline, fixture: "prophet", baselineRef });
  await fs.writeFile(path.join(root, run.artifact_dir, run.handoff_failure ? "07-evaluation.yaml" : "05-evaluation.yaml"), stringify(report), "utf8");
  return report;
}
