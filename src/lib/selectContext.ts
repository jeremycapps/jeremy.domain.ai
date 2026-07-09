import type { CachedResumeArtifact, ExperienceUnit, RouteDecision, SelectedContext } from "../types.js";

export function selectContext(
  routeDecision: RouteDecision,
  units: ExperienceUnit[],
  artifacts: CachedResumeArtifact[]
): SelectedContext {
  const selectedIds =
    routeDecision.confidence === "low" || routeDecision.selected_experience_units.length === 0
      ? units.map((unit) => unit.id)
      : routeDecision.selected_experience_units;

  const idSet = new Set(selectedIds);
  const selectedUnits = units.filter((unit) => idSet.has(unit.id));
  const artifact = artifacts.find((item) => item.archetype === routeDecision.archetype);

  return {
    files: artifact ? [artifact.cache_path] : [],
    cache_files: artifact ? [artifact.cache_path] : [],
    source_files: artifact?.source_path ? [artifact.source_path] : [],
    experience_unit_ids: selectedUnits.map((unit) => unit.id),
    used_full_context: selectedUnits.length === units.length,
    selected_context_summary: `${selectedUnits.length} experience unit(s) selected for ${routeDecision.archetype}.`,
    units: selectedUnits,
    artifact
  };
}
