import type { Archetype, CachedResumeArtifact, ExperienceUnit, RouteDecision } from "../types.js";

const rules: Array<{ archetype: Archetype; keywords: string[]; reason: string }> = [
  {
    archetype: "technical_operations",
    keywords: ["systems", "operations", "technical", "incident", "infrastructure", "automation", "support"],
    reason: "Matched systems operations and technical execution language."
  },
  {
    archetype: "ai_product_strategy",
    keywords: ["ai", "llm", "market intelligence", "corporate development", "strategy", "product strategy"],
    reason: "Matched AI, strategy, market intelligence, or corporate development language."
  },
  {
    archetype: "implementation_strategy",
    keywords: ["implementation", "solutions", "deployment", "field", "customer launch", "integration"],
    reason: "Matched implementation, deployment, or solutions delivery language."
  },
  {
    archetype: "customer_success_systems",
    keywords: ["customer success", "support operations", "retention", "renewal", "account", "enablement"],
    reason: "Matched customer success operations and strategic support language."
  },
  {
    archetype: "product_operations",
    keywords: ["product operations", "workflow", "internal tools", "process", "roadmap", "program"],
    reason: "Matched product operations, internal systems, or workflow language."
  }
];

function scoreJob(jobDescription: string) {
  const normalized = jobDescription.toLowerCase();
  return rules
    .map((rule) => ({
      ...rule,
      score: rule.keywords.filter((keyword) => normalized.includes(keyword)).length
    }))
    .sort((a, b) => b.score - a.score);
}

function unitMatchesArchetype(unit: ExperienceUnit, archetype: Archetype): boolean {
  const haystack = [
    unit.id,
    unit.title,
    unit.employer,
    unit.role,
    ...(unit.tags ?? []),
    ...(unit.tools ?? []),
    ...(unit.bullets ?? []),
    ...(unit.outcomes ?? [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return archetype
    .split("_")
    .some((part) => part.length > 2 && haystack.includes(part));
}

export function routeJob(
  jobDescription: string,
  units: ExperienceUnit[],
  artifacts: CachedResumeArtifact[],
  archetypeHint?: string | null
): RouteDecision {
  const allowed = new Set<Archetype>([
    "technical_operations",
    "ai_product_strategy",
    "implementation_strategy",
    "customer_success_systems",
    "product_operations",
    "general_operator"
  ]);

  const hinted = archetypeHint && allowed.has(archetypeHint as Archetype) ? (archetypeHint as Archetype) : null;
  const selected = hinted ? null : scoreJob(jobDescription)[0];
  const archetype: Archetype = hinted ?? (selected && selected.score > 0 ? selected.archetype : "general_operator");
  const confidence = hinted ? "high" : selected && selected.score >= 2 ? "high" : selected && selected.score === 1 ? "medium" : "low";
  const selectedArtifact = artifacts.find((artifact) => artifact.archetype === archetype);
  const matchedUnits = units.filter((unit) => unitMatchesArchetype(unit, archetype)).map((unit) => unit.id);

  return {
    archetype,
    confidence,
    selected_files: selectedArtifact ? [selectedArtifact.cache_path] : [],
    selected_experience_units: confidence === "low" ? units.map((unit) => unit.id) : matchedUnits,
    reason: hinted
      ? `Used supported archetype_hint "${hinted}".`
      : selected && selected.score > 0
        ? selected.reason
        : "No strong route keywords matched; using low-confidence general_operator fallback."
  };
}
