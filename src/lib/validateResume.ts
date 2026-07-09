import type { EvidenceReport, ExperienceUnit, ValidationReport } from "../types.js";

const forbiddenTerms = ["harvard", "stanford", "mba", "phd", "certified kubernetes"];

export function validateResume(
  resumeMarkdown: string,
  evidenceReport: EvidenceReport,
  selectedUnits: ExperienceUnit[]
): ValidationReport {
  const lowerResume = resumeMarkdown.toLowerCase();
  const sourceText = JSON.stringify(selectedUnits).toLowerCase();
  const forbidden_claims = forbiddenTerms
    .filter((term) => lowerResume.includes(term) && !sourceText.includes(term))
    .map((term) => ({ claim: term, rule: "Forbidden if not present in selected source context." }));

  const unsupported_claims = [
    ...evidenceReport.unsupported_requested_claims.map((claim) => ({
      claim: claim.claim,
      reason: claim.reason
    }))
  ];

  const missingEvidenceIds =
    evidenceReport.supported_claims.length === 0 && resumeMarkdown.trim().length > 0
      ? [{ claim: "resume output", reason: "Evidence report contains no supported claims with unit ids." }]
      : [];

  const allUnsupported = [...unsupported_claims, ...missingEvidenceIds];
  const status = forbidden_claims.length > 0 ? "failed" : allUnsupported.length > 0 ? "needs_review" : "passed";

  return {
    status,
    unsupported_claims: allUnsupported,
    forbidden_claims,
    recommended_edits:
      status === "passed"
        ? []
        : ["Remove or mark unsupported claims as gaps unless source evidence is added to data/experience_units.yaml."]
  };
}
