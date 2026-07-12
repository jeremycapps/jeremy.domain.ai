import { randomUUID } from "node:crypto";
import type { CapabilityAnalysisRequest, CorusExecutionMode, ProjectionKind } from "../types.js";
import { providerReadiness } from "../providers/liveProviders.js";
import { runCapabilityAnalysis, structuredProviderError } from "../lib/corusOrchestrator.js";

export class CapabilityRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRequestError";
  }
}

function validateMode(mode: unknown): CorusExecutionMode {
  if (mode === undefined) return "mocked";
  if (mode === "mocked" || mode === "fixture" || mode === "live") return mode;
  throw new CapabilityRequestError("mode must be mocked, fixture, or live.");
}

function validateProjection(projection: unknown): ProjectionKind {
  if (projection === undefined) return "capability_assessment";
  if (projection === "capability_assessment" || projection === "resume") return projection;
  throw new CapabilityRequestError("projection must be capability_assessment or resume.");
}

export function validateCapabilityAnalysisRequest(body: unknown): CapabilityAnalysisRequest {
  if (!body || typeof body !== "object") {
    throw new CapabilityRequestError("Request body must be a JSON object.");
  }

  const request = body as Partial<CapabilityAnalysisRequest>;
  if (request.subject_source === undefined) {
    throw new CapabilityRequestError("subject_source is required.");
  }
  if (request.target_source === undefined) {
    throw new CapabilityRequestError("target_source is required.");
  }

  return {
    subject_source: request.subject_source,
    target_source: request.target_source,
    projection: validateProjection(request.projection),
    mode: validateMode(request.mode),
    run_label: request.run_label
  };
}

export async function handleCapabilityAnalysis(body: unknown) {
  const request = validateCapabilityAnalysisRequest(body);
  return runCapabilityAnalysis(request);
}

export function handleCapabilityReadiness(mode: unknown) {
  return providerReadiness(validateMode(mode));
}

export function buildCapabilityErrorResponse(error: unknown): { statusCode: number; body: object } {
  const statusCode = error instanceof CapabilityRequestError ? 400 : 500;
  return {
    statusCode,
    body: {
      run_id: randomUUID(),
      status: "failed",
      error: structuredProviderError(error)
    }
  };
}
