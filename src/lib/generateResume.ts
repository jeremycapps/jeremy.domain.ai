import type { EvidenceReport, GenerateResumeRequest, SelectedContext } from "../types.js";
import { defaultDirectivePacket, executeModelOperation, type PromptPayload } from "../providers/modelOperation.js";
import { canonicalModelProfileIds, modelProfile } from "../providers/modelProfiles.js";
import { textFromOpenAIResponse } from "../providers/providerUtils.js";

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

function summarizeUnit(unit: SelectedContext["units"][number]): string {
  const fields = [
    `id: ${unit.id}`,
    unit.title ? `title: ${unit.title}` : null,
    unit.employer ? `employer: ${unit.employer}` : null,
    unit.role ? `role: ${unit.role}` : null,
    unit.dates ? `dates: ${unit.dates}` : null,
    unit.tags?.length ? `tags: ${unit.tags.join(", ")}` : null,
    unit.tools?.length ? `tools: ${unit.tools.join(", ")}` : null,
    unit.bullets?.length ? `bullets: ${unit.bullets.join(" | ")}` : null,
    unit.outcomes?.length ? `outcomes: ${unit.outcomes.join(" | ")}` : null
  ];

  return fields.filter(Boolean).join("\n");
}

export function buildEvidenceReport(jobDescription: string, context: SelectedContext): EvidenceReport {
  const supported_claims = context.units.map((unit) => ({
    claim: unit.title ?? unit.role ?? unit.id,
    unit_ids: [unit.id]
  }));

  const unsupported_requested_claims = ["certification", "degree", "kubernetes", "salesforce"]
    .filter((term) => jobDescription.toLowerCase().includes(term))
    .filter((term) => !JSON.stringify(context.units).toLowerCase().includes(term))
    .map((term) => ({ claim: term, reason: "Requested by job description but not found in selected source context." }));

  return {
    supported_claims,
    adjacent_claims: [],
    unsupported_requested_claims,
    excluded_experience: []
  };
}

function buildPrompt(jobDescription: string, context: SelectedContext): string {
  return [
    "Generate a concise markdown resume using only the selected source context.",
    "Do not invent employers, titles, dates, skills, metrics, tools, clients, outcomes, education, or certifications.",
    "If the job description asks for unsupported experience, mark it as a gap.",
    "Include evidence unit IDs for major claims.",
    "",
    "JOB DESCRIPTION:",
    jobDescription,
    "",
    "SELECTED EXPERIENCE UNITS:",
    context.units.map(summarizeUnit).join("\n\n---\n\n"),
    "",
    "CACHED RESUME TEXT FOR STYLE/STRUCTURE ONLY; THIS CACHE IS NOT SOURCE TRUTH:",
    context.artifact?.content ?? "(none)"
  ].join("\n");
}

export async function generateResumeMarkdown(
  request: GenerateResumeRequest,
  context: SelectedContext
): Promise<{ resumeMarkdown: string; evidenceReport: EvidenceReport }> {
  const mode = request.options?.mode ?? "generate";
  const evidenceReport = buildEvidenceReport(request.job_description, context);

  if (mode === "route_only") {
    return { resumeMarkdown: "", evidenceReport };
  }

  if (mode === "validate_only") {
    return { resumeMarkdown: context.artifact?.content ?? "", evidenceReport };
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new GenerationError("OPENAI_API_KEY is required for generate mode. Use options.mode=route_only to test routing without a model.");
  }

  const payload: PromptPayload = {
    operation: "resume_generation",
    instructions: [buildPrompt(request.job_description, context)],
    input: {},
    promptVersion: "resume.generate.openai.v1",
    schemaVersion: "markdown"
  };
  const result = await executeModelOperation({ profile: modelProfile(canonicalModelProfileIds.openai), prompt: payload, payload: payload.input, directive: defaultDirectivePacket, mode: "execute" });
  if (result.admission_status === "withheld" || result.provider_error_classification) {
    throw new GenerationError(`Model call failed: ${result.provider_error_classification ?? result.completion_state}.`);
  }
  const resumeMarkdown = textFromOpenAIResponse(result.raw_output).trim();

  if (!resumeMarkdown) {
    throw new GenerationError("Model response did not include resume markdown.");
  }

  return { resumeMarkdown, evidenceReport };
}
