import { randomUUID } from "node:crypto";
import type { GenerateResumeRequest, ResumeResponse, RouteDecision } from "../types.js";
import { generateResumeMarkdown } from "../lib/generateResume.js";
import { listCachedResumeArtifacts } from "../lib/loadArtifacts.js";
import { getAllExperienceUnits } from "../lib/loadContext.js";
import { routeJob } from "../lib/routeJob.js";
import { selectContext } from "../lib/selectContext.js";
import { validateResume } from "../lib/validateResume.js";
import { writeGenerationRecord } from "../lib/writeGenerationRecord.js";

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function validateRequest(body: unknown): GenerateResumeRequest {
  if (!body || typeof body !== "object") {
    throw new RequestValidationError("Request body must be a JSON object.");
  }

  const request = body as GenerateResumeRequest;
  if (typeof request.job_description !== "string" || request.job_description.trim() === "") {
    throw new RequestValidationError("job_description is required and must be a non-empty string.");
  }

  return {
    job_description: request.job_description,
    options: {
      mode: request.options?.mode ?? "generate",
      archetype_hint: request.options?.archetype_hint ?? null,
      use_cache: request.options?.use_cache ?? true
    }
  };
}

function emptyRouteDecision(): RouteDecision {
  return {
    archetype: "general_operator",
    confidence: "low",
    selected_files: [],
    selected_experience_units: [],
    reason: "Request failed before routing completed."
  };
}

export async function handleGenerateResume(body: unknown, root?: string): Promise<ResumeResponse> {
  const requestId = randomUUID();
  const request = validateRequest(body);
  const units = await getAllExperienceUnits(root);
  const artifacts = await listCachedResumeArtifacts(root);
  const routeDecision = routeJob(
    request.job_description,
    units,
    artifacts,
    request.options?.archetype_hint
  );
  const selectedContext = selectContext(routeDecision, units, artifacts);
  const { resumeMarkdown, evidenceReport } = await generateResumeMarkdown(request, selectedContext);
  const validationReport = validateResume(resumeMarkdown, evidenceReport, selectedContext.units);
  const generationRecord = await writeGenerationRecord(
    {
      requestId,
      jobDescription: request.job_description,
      archetype: routeDecision.archetype,
      selectedFiles: selectedContext.files,
      selectedCacheFiles: selectedContext.cache_files,
      selectedSourceFiles: selectedContext.source_files,
      selectedExperienceUnits: selectedContext.experience_unit_ids,
      resumeMarkdown,
      validationStatus: validationReport.status
    },
    root
  );

  return {
    request_id: requestId,
    status: "ok",
    route_decision: {
      ...routeDecision,
      selected_files: selectedContext.files,
      selected_experience_units: selectedContext.experience_unit_ids
    },
    selected_context: {
      files: selectedContext.files,
      cache_files: selectedContext.cache_files,
      source_files: selectedContext.source_files,
      experience_unit_ids: selectedContext.experience_unit_ids,
      used_full_context: selectedContext.used_full_context,
      selected_context_summary: selectedContext.selected_context_summary
    },
    resume_markdown: resumeMarkdown,
    resume: {
      format: "markdown",
      content: resumeMarkdown
    },
    evidence_report: evidenceReport,
    validation_report: validationReport,
    generation_record: generationRecord
  };
}

export function buildErrorResponse(error: unknown): { statusCode: number; body: object } {
  const message = error instanceof Error ? error.message : "Unknown backend error.";
  const statusCode = error instanceof RequestValidationError ? 400 : 500;

  return {
    statusCode,
    body: {
      request_id: randomUUID(),
      status: "error",
      route_decision: emptyRouteDecision(),
      error: {
        message
      }
    }
  };
}
