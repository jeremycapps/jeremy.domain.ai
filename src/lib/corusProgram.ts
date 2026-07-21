import { promises as fs } from "node:fs";
import { parse, stringify } from "yaml";
import type {
  CapabilityAnalysisResponse,
  CapabilityAnalysisRequest,
  CapabilityReduction,
  CorusProgram,
  CorusProgramObjectSchemas,
  CorusProgramState,
  CorusProgramStatus
} from "../types.js";
import { sourceRefFromInput } from "./corusContext.js";
import { validateProjectionNoInvention } from "./corusProjection.js";
import { validateCapabilityValidationOutput, validateContextOutput, validateReductionOutput, validateReductionReferences } from "../providers/validators.js";

export const CORUS_PROGRAM_OBJECT_SCHEMAS: CorusProgramObjectSchemas = {
  schema_version: "corus.program_object_schemas.v1",
  objects: {
    context: "corus.context.v1",
    capability_reduction: "corus.capability_reduction.v1",
    capability_validation: "corus.validation.v1",
    capability_projection: "corus.projection.v1",
    generation_record: "corus.generation_record.v1"
  }
};

export const PROPHET_PROGRAM_CONSTRAINTS = [
  "Do not make live provider calls during replay.",
  "Preserve the existing Prophet fixture inputs, provider boundaries, artifacts, and validation rules.",
  "Do not redesign provider adapters, introduce LangGraph, add semantic retrieval, build UI, or extract a separate Domain package."
];

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(message);
}

function assertCanonicalObjectSchemas(value: Record<string, unknown>) {
  if (value.schema_version !== CORUS_PROGRAM_OBJECT_SCHEMAS.schema_version) {
    throw new Error("CorusProgram object_schemas schema_version is not canonical.");
  }
  assertObject(value.objects, "CorusProgram object_schemas must include objects.");
  for (const [name, schemaVersion] of Object.entries(CORUS_PROGRAM_OBJECT_SCHEMAS.objects)) {
    if (value.objects[name] !== schemaVersion) throw new Error(`CorusProgram object_schemas.${name} is not canonical.`);
  }
}

function assertProjection(value: unknown): asserts value is NonNullable<CorusProgramState["projection"]> {
  assertObject(value, "CorusProgram projection must be an object when present.");
  if (!(value.kind === "resume" || value.kind === "capability_assessment")) throw new Error("CorusProgram projection has invalid kind.");
  if (value.format !== "markdown") throw new Error("CorusProgram projection format must be markdown.");
  if (typeof value.content !== "string") throw new Error("CorusProgram projection must include content.");
  assertStringArray(value.capability_ids, "CorusProgram projection must include capability_ids.");
}

function programStatus(run: CapabilityAnalysisResponse): CorusProgramStatus {
  return run.projection ? "replayable" : "blocked";
}

export function buildCorusProgramFromRun(input: {
  request: CapabilityAnalysisRequest;
  run: CapabilityAnalysisResponse;
  programId?: string;
  objective?: string;
  constraints?: string[];
  baselineRef?: string;
}): CorusProgram {
  const reduction: CapabilityReduction = {
    reducer: "capabilities",
    inputs: {
      subject: input.run.contexts.subject.id,
      target: input.run.contexts.target.id
    },
    capabilities: input.run.capabilities
  };

  return validateCorusProgram({
    schema_version: "corus.program.v1",
    program_id: input.programId ?? `corus-program-${input.run.run_id}`,
    objective: input.objective ?? "Represent and replay the existing Prophet capability proof through recoverable Corus program state.",
    constraints: input.constraints ?? PROPHET_PROGRAM_CONSTRAINTS,
    object_schemas: CORUS_PROGRAM_OBJECT_SCHEMAS,
    state: {
      schema_version: "corus.program_state.v1",
      status: programStatus(input.run),
      run_id: input.run.run_id,
      mode: input.run.mode,
      source_refs: {
        subject: sourceRefFromInput(input.request.subject_source, "subject_source"),
        target: sourceRefFromInput(input.request.target_source, "target_source"),
        ...(input.baselineRef ? { baseline: input.baselineRef } : {})
      },
      contexts: input.run.contexts,
      reduction,
      validation: input.run.validation,
      projection: input.run.projection,
      generation_records: input.run.generation_records,
      artifact_dir: input.run.artifact_dir,
      handoff_failure: input.run.handoff_failure,
      failure_analysis: input.run.failure_analysis,
      replay: {
        provider_calls_made: 0,
        validation_rules: [
          "validateContextOutput",
          "validateReductionOutput",
          "validateReductionReferences",
          "validateCapabilityValidationOutput",
          "validateProjectionNoInvention"
        ]
      }
    }
  });
}

export function validateCorusProgram(value: unknown): CorusProgram {
  assertObject(value, "CorusProgram must be an object.");
  if (value.schema_version !== "corus.program.v1") throw new Error("CorusProgram schema_version must be corus.program.v1.");
  if (typeof value.program_id !== "string") throw new Error("CorusProgram must include program_id.");
  if (typeof value.objective !== "string") throw new Error("CorusProgram must include objective.");
  assertStringArray(value.constraints, "CorusProgram constraints must be a string array.");
  assertObject(value.object_schemas, "CorusProgram must include object_schemas.");
  assertCanonicalObjectSchemas(value.object_schemas);
  assertObject(value.state, "CorusProgram must include state.");
  const state = value.state as Record<string, unknown>;
  if (state.schema_version !== "corus.program_state.v1") throw new Error("CorusProgram state schema_version must be corus.program_state.v1.");
  if (!(state.status === "ready" || state.status === "replayable" || state.status === "blocked")) throw new Error("CorusProgram state has invalid status.");
  if (typeof state.run_id !== "string") throw new Error("CorusProgram state must include run_id.");
  if (!(state.mode === "mocked" || state.mode === "fixture" || state.mode === "live")) throw new Error("CorusProgram state has invalid mode.");
  assertObject(state.source_refs, "CorusProgram state must include source_refs.");
  if (typeof state.source_refs.subject !== "string" || typeof state.source_refs.target !== "string") {
    throw new Error("CorusProgram state source_refs must include subject and target.");
  }
  assertObject(state.contexts, "CorusProgram state must include contexts.");
  const contexts = {
    subject: validateContextOutput(state.contexts.subject, "program"),
    target: validateContextOutput(state.contexts.target, "program")
  };
  const reduction = validateReductionReferences(validateReductionOutput(state.reduction, "program"), contexts, "program");
  const validation = validateCapabilityValidationOutput(state.validation, "program");
  if (!Array.isArray(state.generation_records)) throw new Error("CorusProgram state must include generation_records array.");
  assertObject(state.replay, "CorusProgram state must include replay metadata.");
  if (state.replay.provider_calls_made !== 0) throw new Error("CorusProgram replay must record zero provider calls.");
  assertStringArray(state.replay.validation_rules, "CorusProgram replay validation_rules must be a string array.");

  if (state.projection !== null) {
    assertProjection(state.projection);
    if (validateProjectionNoInvention(state.projection, validation).length > 0) {
      throw new Error("CorusProgram projection includes capability ids not admitted by validation.");
    }
  }
  if (reduction.capabilities.map((capability) => capability.id).join("\n") !== ((state as { reduction: CapabilityReduction }).reduction.capabilities ?? []).map((capability) => capability.id).join("\n")) {
    throw new Error("CorusProgram reduction changed during validation.");
  }

  return value as unknown as CorusProgram;
}

export function replayCorusProgram(value: unknown): CapabilityAnalysisResponse {
  const program = validateCorusProgram(value);
  return {
    run_id: program.state.run_id,
    status: program.state.validation.status,
    mode: program.state.mode,
    contexts: program.state.contexts,
    capabilities: program.state.reduction.capabilities,
    validation: program.state.validation,
    projection: program.state.projection,
    generation_records: program.state.generation_records,
    artifact_dir: program.state.artifact_dir ?? "",
    handoff_failure: program.state.handoff_failure,
    failure_analysis: program.state.failure_analysis
  };
}

export async function loadCorusProgram(filePath: string): Promise<CorusProgram> {
  return validateCorusProgram(parse(await fs.readFile(filePath, "utf8")));
}

export async function writeCorusProgram(filePath: string, program: CorusProgram): Promise<string> {
  await fs.writeFile(filePath, stringify(validateCorusProgram(program)), "utf8");
  return filePath;
}
