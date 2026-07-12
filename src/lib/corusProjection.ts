import type { CapabilityCandidate, CapabilityProjection, CapabilityValidation, ProjectionKind } from "../types.js";

export function projectValidatedCapabilities(
  capabilities: CapabilityCandidate[],
  validation: CapabilityValidation,
  kind: ProjectionKind
): CapabilityProjection {
  const allowed = new Set(validation.validated_capability_ids);
  const validated = capabilities.filter((capability) => allowed.has(capability.id));
  const lines =
    kind === "resume"
      ? [
          "# Validated Capability Resume",
          "",
          ...validated.flatMap((capability) => [
            `- ${capability.statement}`,
            `  - Evidence: ${capability.evidence_refs.join(", ")}`,
            `  - Requirement: ${capability.requirement_ref}`
          ])
        ]
      : [
          "# Capability Assessment",
          "",
          ...validated.flatMap((capability) => [
            `## ${capability.id}`,
            "",
            capability.statement,
            "",
            `Support: ${capability.support}`,
            `Confidence: ${capability.confidence}`,
            `Requirement: ${capability.requirement_ref}`,
            `Evidence: ${capability.evidence_refs.join(", ")}`
          ])
        ];

  return {
    kind,
    format: "markdown",
    content: `${lines.join("\n")}\n`,
    capability_ids: validated.map((capability) => capability.id)
  };
}

export function validateProjectionNoInvention(projection: CapabilityProjection, validation: CapabilityValidation): string[] {
  const allowed = new Set(validation.validated_capability_ids);
  return projection.capability_ids.filter((id) => !allowed.has(id));
}
