import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CapabilityCandidate } from "../types.js";
import { getProjectRoot } from "./paths.js";

type AlignmentFixture = {
  meta: Record<string, unknown>;
  target_scope: {
    generated_target_requirement_refs: string[];
    denominator_policy: string;
    baseline_ids_directly_requesting_generated_target_requirement: string[];
    reviewed_in_scope_baseline_ids: string[];
    out_of_scope_baseline_ids: string[];
  };
  scope_compatibility: {
    comparable: boolean;
    reason: string;
  };
  architect_accepted_projected_ids: string[];
  architect_rejected_ids: string[];
  mappings: Array<{
    generated_id: string;
    projected: boolean;
    architect_disposition: string;
    reviewed_baseline_mappings: Array<{ baseline_id: string; match_type: string }>;
  }>;
};

type StrictEvaluation = {
  evaluation: {
    quality: Record<string, unknown>;
    differences: Array<{ type: string; generated_id?: string; baseline_id?: string; message: string }>;
    hallucinations: Array<{ type: string; capability_id?: string; message: string }>;
    verdict: string;
  };
};

type Projection = {
  capability_ids?: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function correctedDifferenceLabel(input: {
  generated_id: string;
  support: string;
  rejected: boolean;
  matched: boolean;
}): string | null {
  if (input.matched) return null;
  if (input.support === "supported") return "supported_unmatched";
  if (input.support === "adjacent") return "adjacent_unmatched";
  if (input.support === "unsupported" && input.rejected) return "rejected_unsupported";
  return "unsupported_unmatched";
}

export async function runAttempt2AlignmentReplay(input: {
  root?: string;
  runId?: string;
  fixturePath?: string;
  outputPath?: string;
}) {
  const root = input.root ?? getProjectRoot();
  const runId = input.runId ?? "b9e4e3fd-0ca2-41f1-884e-dd43c57e5051";
  const runDir = path.join(root, "outputs", runId);
  const fixturePath = input.fixturePath ?? path.join(root, "test", "fixtures", "prophet", "attempt2_alignment_fixture.yaml");
  const outputPath = input.outputPath ?? path.join(runDir, "11-evaluator-alignment-replay.yaml");

  const fixture = parse(await fs.readFile(fixturePath, "utf8")) as AlignmentFixture;
  const strictEvaluation = parse(await fs.readFile(path.join(runDir, "08-evaluation.yaml"), "utf8")) as StrictEvaluation;
  const capabilities = (parse(await fs.readFile(path.join(runDir, "02-capabilities.yaml"), "utf8")) as { capabilities: CapabilityCandidate[] }).capabilities;
  const projectionText = await fs.readFile(path.join(runDir, "07-projection.md"), "utf8");
  const projectedIds = capabilities.filter((capability) => projectionText.includes(`## ${capability.id}`)).map((capability) => capability.id);

  const projectedSet = new Set(projectedIds);
  const acceptedSet = new Set(fixture.architect_accepted_projected_ids);
  const rejectedSet = new Set(fixture.architect_rejected_ids);
  const mappingByGenerated = new Map(fixture.mappings.map((mapping) => [mapping.generated_id, mapping]));
  const mappedProjectedGeneratedIds = fixture.mappings
    .filter((mapping) => projectedSet.has(mapping.generated_id) && mapping.reviewed_baseline_mappings.length > 0)
    .map((mapping) => mapping.generated_id);
  const mappedInScopeBaselineIds = unique(
    fixture.mappings
      .filter((mapping) => projectedSet.has(mapping.generated_id) && acceptedSet.has(mapping.generated_id))
      .flatMap((mapping) => mapping.reviewed_baseline_mappings.map((reviewed) => reviewed.baseline_id))
      .filter((baselineId) => fixture.target_scope.reviewed_in_scope_baseline_ids.includes(baselineId))
  );
  const inScopeBaselineIds = fixture.target_scope.reviewed_in_scope_baseline_ids;
  const acceptedProjectedPresent = fixture.architect_accepted_projected_ids.filter((id) => projectedSet.has(id));
  const rejectedAbsent = fixture.architect_rejected_ids.filter((id) => !projectedSet.has(id));
  const remainingMissed = inScopeBaselineIds.filter((baselineId) => !mappedInScopeBaselineIds.includes(baselineId));

  const generatedMappingTable = fixture.mappings.map((mapping) => {
    const capability = capabilities.find((item) => item.id === mapping.generated_id);
    const matched = mapping.projected && mapping.reviewed_baseline_mappings.length > 0;
    return {
      generated_id: mapping.generated_id,
      support: capability?.support ?? null,
      projected: projectedSet.has(mapping.generated_id),
      architect_disposition: mapping.architect_disposition,
      reviewed_baseline_mappings: mapping.reviewed_baseline_mappings,
      corrected_difference_label: correctedDifferenceLabel({
        generated_id: mapping.generated_id,
        support: capability?.support ?? "unknown",
        rejected: rejectedSet.has(mapping.generated_id),
        matched
      })
    };
  });

  const correctedDifferences = capabilities
    .map((capability) => {
      const mapping = mappingByGenerated.get(capability.id);
      const matched = Boolean(mapping?.projected && mapping.reviewed_baseline_mappings.length > 0);
      const label = correctedDifferenceLabel({
        generated_id: capability.id,
        support: capability.support,
        rejected: rejectedSet.has(capability.id),
        matched
      });
      return label
        ? {
            type: label,
            generated_id: capability.id,
            message: label === "rejected_unsupported" ? "Rejected unsupported capability was excluded from projection." : "Generated capability has no reviewed semantic mapping."
          }
        : null;
    })
    .filter(Boolean);
  const correctedHallucinations = strictEvaluation.evaluation.hallucinations.filter(
    (hallucination) => !(hallucination.capability_id && rejectedSet.has(hallucination.capability_id) && !projectedSet.has(hallucination.capability_id))
  );

  const result = {
    run_id: runId,
    artifact_type: "local_evaluator_alignment_replay",
    provider_calls_made: 0,
    strict_metrics_preserved: strictEvaluation.evaluation.quality,
    strict_verdict: strictEvaluation.evaluation.verdict,
    scope_compatibility: {
      ...fixture.scope_compatibility,
      overall_quality_verdict_produced: fixture.scope_compatibility.comparable
    },
    in_scope_baseline_denominator: {
      policy: fixture.target_scope.denominator_policy,
      generated_target_requirement_refs: fixture.target_scope.generated_target_requirement_refs,
      direct_baseline_ids: fixture.target_scope.baseline_ids_directly_requesting_generated_target_requirement,
      reviewed_in_scope_baseline_ids: inScopeBaselineIds,
      denominator: inScopeBaselineIds.length
    },
    diagnostic_metrics: {
      mapped_recall: {
        numerator: mappedInScopeBaselineIds.length,
        denominator: inScopeBaselineIds.length,
        score: ratio(mappedInScopeBaselineIds.length, inScopeBaselineIds.length)
      },
      mapped_precision: {
        numerator: mappedProjectedGeneratedIds.length,
        denominator: projectedIds.length,
        score: ratio(mappedProjectedGeneratedIds.length, projectedIds.length)
      },
      adjacent_accepted_projection_fidelity: {
        numerator: acceptedProjectedPresent.length,
        denominator: fixture.architect_accepted_projected_ids.length,
        score: ratio(acceptedProjectedPresent.length, fixture.architect_accepted_projected_ids.length)
      },
      rejected_output_exclusion: {
        numerator: rejectedAbsent.length,
        denominator: fixture.architect_rejected_ids.length,
        score: ratio(rejectedAbsent.length, fixture.architect_rejected_ids.length)
      },
      target_scope_compatibility: fixture.scope_compatibility.comparable
    },
    generated_to_baseline_mapping_table: generatedMappingTable,
    remaining_genuinely_missed_capabilities: remainingMissed,
    corrected_difference_taxonomy: {
      differences: correctedDifferences,
      hallucinations: correctedHallucinations
    },
    prior_worse_verdict_status: fixture.scope_compatibility.comparable ? "valid_under_strict_metrics_only" : "indeterminate",
    notes: [
      "Mappings are diagnostic annotations, not canonical truth.",
      "Strict metrics are preserved unchanged.",
      "No embedding or LLM-based matching was used."
    ]
  };

  await fs.writeFile(outputPath, stringify(result), "utf8");
  return result;
}
