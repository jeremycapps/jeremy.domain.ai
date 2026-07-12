import type { CapabilityReduction, CapabilityValidation, Context, FailureAnalysis } from "../types.js";
import { ProviderExecutionError } from "./errors.js";

const supports = new Set(["supported", "adjacent", "unsupported", "unknown"]);
const confidences = new Set(["high", "medium", "low"]);
const validationStatuses = new Set(["passed", "revise", "architect_required", "failed"]);
const failureAnalysisStatuses = new Set(["correctable", "architect_required", "unrecoverable"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateContextOutput(value: unknown, provider: string): Context {
  if (!isObject(value)) throw new ProviderExecutionError(provider, "Structured context output must be an object.");
  if (typeof value.id !== "string") throw new ProviderExecutionError(provider, "Structured context output is missing string id.");
  if (typeof value.kind !== "string") throw new ProviderExecutionError(provider, "Structured context output is missing string kind.");
  if (typeof value.label !== "string") throw new ProviderExecutionError(provider, "Structured context output is missing string label.");
  if (!stringArray(value.sources)) throw new ProviderExecutionError(provider, "Structured context output must include sources as string array.");
  if (!isObject(value.content)) throw new ProviderExecutionError(provider, "Structured context output must include content object.");
  if (!isObject(value.generation)) throw new ProviderExecutionError(provider, "Structured context output must include generation metadata.");
  return value as unknown as Context;
}

export function validateReductionOutput(value: unknown, provider: string): CapabilityReduction {
  if (!isObject(value)) throw new ProviderExecutionError(provider, "Structured reduction output must be an object.");
  if (value.reducer !== "capabilities") throw new ProviderExecutionError(provider, "Reduction output reducer must be capabilities.");
  if (!isObject(value.inputs)) throw new ProviderExecutionError(provider, "Reduction output must include named inputs.");
  if (typeof value.inputs.subject !== "string" || typeof value.inputs.target !== "string") {
    throw new ProviderExecutionError(provider, "Reduction output inputs must include subject and target ids.");
  }
  if (!Array.isArray(value.capabilities)) throw new ProviderExecutionError(provider, "Reduction output must include capabilities array.");

  for (const capability of value.capabilities) {
    if (!isObject(capability)) throw new ProviderExecutionError(provider, "Each capability must be an object.");
    if (typeof capability.id !== "string") throw new ProviderExecutionError(provider, "Each capability must include string id.");
    if (typeof capability.requirement_ref !== "string") throw new ProviderExecutionError(provider, "Each capability must include requirement_ref.");
    if (typeof capability.statement !== "string") throw new ProviderExecutionError(provider, "Each capability must include statement.");
    if (!stringArray(capability.evidence_refs)) throw new ProviderExecutionError(provider, "Each capability must include evidence_refs string array.");
    if (!supports.has(String(capability.support))) throw new ProviderExecutionError(provider, "Each capability must include valid support.");
    if (!confidences.has(String(capability.confidence))) throw new ProviderExecutionError(provider, "Each capability must include valid confidence.");
    if (!isObject(capability.generated_by)) throw new ProviderExecutionError(provider, "Each capability must include generated_by metadata.");
  }

  return value as unknown as CapabilityReduction;
}

export function validateCapabilityValidationOutput(value: unknown, provider: string): CapabilityValidation {
  if (!isObject(value)) throw new ProviderExecutionError(provider, "Structured validation output must be an object.");
  if (!validationStatuses.has(String(value.status))) throw new ProviderExecutionError(provider, "Validation output has invalid status.");
  if (!Array.isArray(value.findings)) throw new ProviderExecutionError(provider, "Validation output must include findings array.");
  if (!stringArray(value.validated_capability_ids)) {
    throw new ProviderExecutionError(provider, "Validation output must include validated_capability_ids string array.");
  }
  if (!stringArray(value.rejected_capability_ids)) {
    throw new ProviderExecutionError(provider, "Validation output must include rejected_capability_ids string array.");
  }
  return value as unknown as CapabilityValidation;
}

export function validateFailureAnalysisOutput(value: unknown, provider: string): FailureAnalysis {
  if (!isObject(value)) throw new ProviderExecutionError(provider, "Failure-analysis output must be an object.");
  if (!failureAnalysisStatuses.has(String(value.status))) throw new ProviderExecutionError(provider, "Failure-analysis output has invalid status.");
  if (value.failed_stage !== "capability_reduction") throw new ProviderExecutionError(provider, "Failure-analysis failed_stage must be capability_reduction.");
  if (value.failure_type !== "schema_validation") throw new ProviderExecutionError(provider, "Failure-analysis failure_type must be schema_validation.");
  if (typeof value.diagnosis !== "string") throw new ProviderExecutionError(provider, "Failure-analysis output must include diagnosis.");
  if (!Array.isArray(value.corrections)) throw new ProviderExecutionError(provider, "Failure-analysis output must include corrections array.");
  if (!(value.retry_stage === "capability_reduction" || value.retry_stage === null)) {
    throw new ProviderExecutionError(provider, "Failure-analysis retry_stage must be capability_reduction or null.");
  }
  if (typeof value.architecture_change_required !== "boolean") {
    throw new ProviderExecutionError(provider, "Failure-analysis output must include architecture_change_required boolean.");
  }
  if (!confidences.has(String(value.confidence))) throw new ProviderExecutionError(provider, "Failure-analysis output must include valid confidence.");
  for (const correction of value.corrections) {
    if (!isObject(correction)) throw new ProviderExecutionError(provider, "Each correction must be an object.");
    if (typeof correction.field !== "string") throw new ProviderExecutionError(provider, "Each correction must include field.");
    if (typeof correction.instruction !== "string") throw new ProviderExecutionError(provider, "Each correction must include instruction.");
    if (typeof correction.reason !== "string") throw new ProviderExecutionError(provider, "Each correction must include reason.");
  }
  return value as unknown as FailureAnalysis;
}
