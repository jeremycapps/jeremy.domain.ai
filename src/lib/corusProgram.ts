import { promises as fs } from "node:fs";
import { parse, stringify } from "yaml";
import type {
  CapabilityAnalysisRequest,
  CapabilityAnalysisResponse,
  CapabilityReduction,
  CorusPlannedAction,
  CorusProcessDefinition,
  CorusProgram,
  CorusProgramObjectSchemas,
  CorusProgramState,
  CorusProgramStatus,
  CorusTransitionEvent
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
    generation_record: "corus.generation_record.v1",
    process_definition: "corus.process_definition.v1",
    transition_event: "corus.transition_event.v1"
  }
};

export const CORUS_PROCESS_DEFINITIONS: CorusProcessDefinition[] = [
  {
    id: "structured_context_preservation",
    required_inputs: ["subject_source", "target_source"],
    expected_outputs: ["subject_context", "target_context"],
    allowed_start_statuses: ["ready"],
    allowed_return_statuses: ["completed_valid_output"],
    required_artifact_refs: ["subject_context", "target_context"],
    transitions: { completed_valid_output: "capability_reduction" }
  },
  {
    id: "capability_reduction",
    required_inputs: ["subject_context", "target_context"],
    expected_outputs: ["capability_reduction"],
    allowed_start_statuses: ["completed_valid_output"],
    allowed_return_statuses: ["completed_valid_output", "failed", "architect_required"],
    required_artifact_refs: ["capability_reduction"],
    transitions: { completed_valid_output: "capability_validation", failed: null, architect_required: null }
  },
  {
    id: "capability_validation",
    required_inputs: ["capability_reduction", "subject_context", "target_context"],
    expected_outputs: ["capability_validation"],
    allowed_start_statuses: ["completed_valid_output"],
    allowed_return_statuses: ["passed", "revise", "failed", "architect_required"],
    required_artifact_refs: ["capability_validation"],
    transitions: { passed: "projection", revise: "capability_reduction", failed: null, architect_required: null }
  },
  {
    id: "projection",
    required_inputs: ["capability_validation", "capability_reduction"],
    expected_outputs: ["capability_projection"],
    allowed_start_statuses: ["passed"],
    allowed_return_statuses: ["completed_valid_output"],
    required_artifact_refs: ["capability_projection"],
    transitions: { completed_valid_output: "capability_admission" }
  },
  {
    id: "capability_admission",
    required_inputs: ["capability_projection", "capability_validation", "baseline"],
    expected_outputs: ["author_decision"],
    allowed_start_statuses: ["completed_valid_output", "awaiting_author"],
    allowed_return_statuses: ["awaiting_author", "admitted", "blocked"],
    required_artifact_refs: ["author_review"],
    transitions: { awaiting_author: "capability_admission", admitted: null, blocked: null }
  }
];

export const PROPHET_PROGRAM_CONSTRAINTS = [
  "Do not make live provider calls during replay.",
  "Preserve the existing Prophet fixture inputs, provider boundaries, artifacts, and validation rules.",
  "Do not redesign provider adapters, introduce LangGraph, add semantic retrieval, build UI, or extract a separate Domain package."
];

const terminalStatuses = new Set<CorusProgramStatus>(["admitted", "blocked", "failed", "architect_required", "replayable"]);
const validProgramStatuses = new Set<CorusProgramStatus>([
  "ready",
  "completed_valid_output",
  "passed",
  "revise",
  "failed",
  "architect_required",
  "recovery_failed",
  "awaiting_author",
  "admitted",
  "blocked",
  "replayable"
]);

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(message);
}

function assertProgramStatus(value: unknown, message: string): asserts value is CorusProgramStatus {
  if (typeof value !== "string" || !validProgramStatuses.has(value as CorusProgramStatus)) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function processMap(definitions: CorusProcessDefinition[]): Map<string, CorusProcessDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
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

function validateProcessDefinition(value: unknown): CorusProcessDefinition {
  assertObject(value, "Process definition must be an object.");
  if (typeof value.id !== "string") throw new Error("Process definition must include id.");
  assertStringArray(value.required_inputs, `Process ${value.id} required_inputs must be a string array.`);
  assertStringArray(value.expected_outputs, `Process ${value.id} expected_outputs must be a string array.`);
  if (!Array.isArray(value.allowed_start_statuses)) throw new Error(`Process ${value.id} allowed_start_statuses must be an array.`);
  if (!Array.isArray(value.allowed_return_statuses)) throw new Error(`Process ${value.id} allowed_return_statuses must be an array.`);
  for (const status of value.allowed_start_statuses) assertProgramStatus(status, `Process ${value.id} has invalid allowed start status.`);
  for (const status of value.allowed_return_statuses) assertProgramStatus(status, `Process ${value.id} has invalid allowed return status.`);
  assertStringArray(value.required_artifact_refs, `Process ${value.id} required_artifact_refs must be a string array.`);
  assertObject(value.transitions, `Process ${value.id} transitions must be an object.`);
  for (const [status, nextProcess] of Object.entries(value.transitions)) {
    assertProgramStatus(status, `Process ${value.id} has invalid transition status.`);
    if (!(typeof nextProcess === "string" || nextProcess === null)) throw new Error(`Process ${value.id} transition target must be a string or null.`);
  }
  return value as unknown as CorusProcessDefinition;
}

function assertProjection(value: unknown): asserts value is NonNullable<CorusProgramState["projection"]> {
  assertObject(value, "CorusProgram projection must be an object when present.");
  if (!(value.kind === "resume" || value.kind === "capability_assessment")) throw new Error("CorusProgram projection has invalid kind.");
  if (value.format !== "markdown") throw new Error("CorusProgram projection format must be markdown.");
  if (typeof value.content !== "string") throw new Error("CorusProgram projection must include content.");
  assertStringArray(value.capability_ids, "CorusProgram projection must include capability_ids.");
}

function providerCallsFromRecords(run: CapabilityAnalysisResponse): number {
  return run.generation_records.filter((record) => record.provider !== "codex" && record.provider !== "fixture").length;
}

function transitionEvent(input: {
  process_id: string;
  prior_status: CorusProgramStatus;
  returned_status: CorusProgramStatus;
  artifact_refs: Record<string, string>;
  actor_ref: string;
  provider_calls_made: number;
  occurred_at?: string;
}): CorusTransitionEvent {
  return {
    process_id: input.process_id,
    prior_status: input.prior_status,
    returned_status: input.returned_status,
    artifact_refs: input.artifact_refs,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    actor_ref: input.actor_ref,
    provider_calls_made: input.provider_calls_made
  };
}

function buildHistoryFromRun(run: CapabilityAnalysisResponse): CorusTransitionEvent[] {
  const refsByType = new Map(run.generation_records.map((record) => [record.type, record.output_ref]));
  const subjectRef = run.generation_records.find((record) => record.type === "contextualization" && record.input_refs.some((ref) => ref.includes("jeremy") || ref.includes("subject")))?.output_ref;
  const targetRef = run.generation_records.find((record) => record.type === "contextualization" && record.output_ref !== subjectRef)?.output_ref;
  const validationStatus = run.validation.status === "passed" ? "passed" : run.validation.status;
  const history: CorusTransitionEvent[] = [
    transitionEvent({
      process_id: "structured_context_preservation",
      prior_status: "ready",
      returned_status: "completed_valid_output",
      artifact_refs: {
        subject_context: subjectRef ?? refsByType.get("contextualization") ?? `${run.artifact_dir}/01-subject-context.yaml`,
        target_context: targetRef ?? `${run.artifact_dir}/01-target-context.yaml`
      },
      actor_ref: "corus.runtime",
      provider_calls_made: 0
    }),
    transitionEvent({
      process_id: "capability_reduction",
      prior_status: "completed_valid_output",
      returned_status: "completed_valid_output",
      artifact_refs: { capability_reduction: refsByType.get("capability_reduction") ?? `${run.artifact_dir}/02-capabilities.yaml` },
      actor_ref: "corus.runtime",
      provider_calls_made: providerCallsFromRecords({ ...run, generation_records: run.generation_records.filter((record) => record.type === "capability_reduction") })
    }),
    transitionEvent({
      process_id: "capability_validation",
      prior_status: "completed_valid_output",
      returned_status: validationStatus,
      artifact_refs: { capability_validation: refsByType.get("capability_validation") ?? `${run.artifact_dir}/03-validation.yaml` },
      actor_ref: "corus.runtime",
      provider_calls_made: providerCallsFromRecords({ ...run, generation_records: run.generation_records.filter((record) => record.type === "capability_validation") })
    })
  ];

  if (run.projection) {
    history.push(
      transitionEvent({
        process_id: "projection",
        prior_status: "passed",
        returned_status: "completed_valid_output",
        artifact_refs: { capability_projection: refsByType.get("projection") ?? `${run.artifact_dir}/04-projection.md` },
        actor_ref: "corus.runtime",
        provider_calls_made: 0
      }),
      transitionEvent({
        process_id: "capability_admission",
        prior_status: "completed_valid_output",
        returned_status: "awaiting_author",
        artifact_refs: { author_review: `${run.artifact_dir}/capability-admission-review.yaml` },
        actor_ref: "corus.runtime",
        provider_calls_made: 0
      })
    );
  }

  return history;
}

function replayHistory(definitions: CorusProcessDefinition[], history: CorusTransitionEvent[]): Pick<CorusProgramState, "status" | "current_process_id" | "process_status"> & { provider_calls_made: number } {
  const definitionsById = processMap(definitions);
  const processStatus = Object.fromEntries(definitions.map((definition) => [definition.id, "ready" as CorusProgramStatus]));
  let currentProcessId = definitions[0]?.id;
  let status: CorusProgramStatus = "ready";
  let providerCallsMade = 0;

  for (const event of history) {
    const definition = definitionsById.get(event.process_id);
    if (!definition) throw new Error(`Unknown process ${event.process_id}.`);
    if (event.process_id !== currentProcessId) throw new Error(`Cannot skip required process ${currentProcessId}; received ${event.process_id}.`);
    validateTransitionEvent(event, definition, status, processStatus[event.process_id]);
    processStatus[event.process_id] = event.returned_status;
    status = event.returned_status;
    providerCallsMade += event.provider_calls_made;
    currentProcessId = definition.transitions[event.returned_status] ?? event.process_id;
  }

  return { status, current_process_id: currentProcessId, process_status: processStatus, provider_calls_made: providerCallsMade };
}

function validateTransitionEvent(
  event: CorusTransitionEvent,
  definition: CorusProcessDefinition,
  currentStatus: CorusProgramStatus,
  processStatus: CorusProgramStatus
) {
  if (event.prior_status !== currentStatus) throw new Error(`Transition ${event.process_id} prior_status does not match current state.`);
  if (!definition.allowed_start_statuses.includes(event.prior_status)) throw new Error(`Transition ${event.process_id} starts from unsupported status ${event.prior_status}.`);
  if (!definition.allowed_return_statuses.includes(event.returned_status)) throw new Error(`Transition ${event.process_id} returned unsupported status ${event.returned_status}.`);
  if (terminalStatuses.has(processStatus) && event.returned_status !== "blocked") {
    throw new Error(`Cannot change already completed process ${event.process_id} without an explicit change transition.`);
  }
  for (const refName of definition.required_artifact_refs) {
    if (typeof event.artifact_refs[refName] !== "string" || event.artifact_refs[refName].length === 0) {
      throw new Error(`Transition ${event.process_id} is missing required artifact ref ${refName}.`);
    }
  }
  if (event.prior_status === "awaiting_author" && !event.artifact_refs.author_decision) {
    throw new Error("Awaiting-author continuation requires an author_decision artifact.");
  }
  if (!Number.isInteger(event.provider_calls_made) || event.provider_calls_made < 0) {
    throw new Error(`Transition ${event.process_id} provider_calls_made must be a nonnegative integer.`);
  }
  if (event.execution_receipts) {
    const receiptTotal = event.execution_receipts.reduce((sum, receipt) => sum + receipt.provider_calls_made, 0);
    if (receiptTotal !== event.provider_calls_made) {
      throw new Error(`Transition ${event.process_id} provider_calls_made is inconsistent with execution receipts.`);
    }
  }
}

function processStatusFromHistory(definitions: CorusProcessDefinition[], history: CorusTransitionEvent[]) {
  return replayHistory(definitions, history);
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
  const history = buildHistoryFromRun(input.run);
  const replay = processStatusFromHistory(CORUS_PROCESS_DEFINITIONS, history);

  return validateCorusProgram({
    schema_version: "corus.program.v1",
    program_id: input.programId ?? `corus-program-${input.run.run_id}`,
    objective: input.objective ?? "Represent and replay the existing Prophet capability proof through recoverable Corus program state.",
    constraints: input.constraints ?? PROPHET_PROGRAM_CONSTRAINTS,
    object_schemas: CORUS_PROGRAM_OBJECT_SCHEMAS,
    process_definitions: CORUS_PROCESS_DEFINITIONS,
    state: {
      schema_version: "corus.program_state.v1",
      status: replay.status,
      run_id: input.run.run_id,
      mode: input.run.mode,
      source_refs: {
        subject: sourceRefFromInput(input.request.subject_source, "subject_source"),
        target: sourceRefFromInput(input.request.target_source, "target_source"),
        ...(input.baselineRef ? { baseline: input.baselineRef } : {})
      },
      current_process_id: replay.current_process_id,
      process_status: replay.process_status,
      contexts: input.run.contexts,
      reduction,
      validation: input.run.validation,
      projection: input.run.projection,
      generation_records: input.run.generation_records,
      artifact_dir: input.run.artifact_dir,
      handoff_failure: input.run.handoff_failure,
      failure_analysis: input.run.failure_analysis,
      history,
      replay: {
        provider_calls_made: replay.provider_calls_made,
        validation_rules: [
          "validateContextOutput",
          "validateReductionOutput",
          "validateReductionReferences",
          "validateCapabilityValidationOutput",
          "validateProjectionNoInvention",
          "replayHistory"
        ]
      }
    }
  });
}

export function planNextCorusAction(value: unknown): CorusPlannedAction | null {
  const program = validateCorusProgram(value);
  const definition = processMap(program.process_definitions).get(program.state.current_process_id);
  if (!definition || terminalStatuses.has(program.state.status)) return null;

  const authorBoundary = program.state.status === "awaiting_author";
  return {
    program_id: program.program_id,
    process_id: definition.id,
    operation: authorBoundary ? "author_decision" : definition.id,
    target: authorBoundary ? "capability_admission_checkpoint" : definition.expected_outputs[0],
    reason: authorBoundary
      ? "Program is awaiting author admission; only an author decision can advance deterministic continuation."
      : `Process ${definition.id} is next because current status is ${program.state.status}.`,
    required_input_refs: definition.required_inputs,
    expected_output_contract: {
      allowed_return_statuses: definition.allowed_return_statuses,
      required_artifact_refs: authorBoundary ? ["author_decision"] : definition.required_artifact_refs
    },
    execution_required: !authorBoundary
  };
}

export function applyCorusTransition(value: unknown, event: CorusTransitionEvent): CorusProgram {
  const program = validateCorusProgram(value);
  const definition = processMap(program.process_definitions).get(program.state.current_process_id);
  if (!definition) throw new Error(`Unknown current process ${program.state.current_process_id}.`);
  if (event.process_id !== program.state.current_process_id) {
    throw new Error(`Cannot skip required process ${program.state.current_process_id}; received ${event.process_id}.`);
  }
  validateTransitionEvent(event, definition, program.state.status, program.state.process_status[event.process_id]);
  const next = clone(program);
  next.state.history = [...next.state.history, clone(event)];
  const replay = processStatusFromHistory(next.process_definitions, next.state.history);
  next.state.status = replay.status;
  next.state.current_process_id = replay.current_process_id;
  next.state.process_status = replay.process_status;
  next.state.replay.provider_calls_made = replay.provider_calls_made;
  return validateCorusProgram(next);
}

export function validateCorusProgram(value: unknown): CorusProgram {
  assertObject(value, "CorusProgram must be an object.");
  if (value.schema_version !== "corus.program.v1") throw new Error("CorusProgram schema_version must be corus.program.v1.");
  if (typeof value.program_id !== "string") throw new Error("CorusProgram must include program_id.");
  if (typeof value.objective !== "string") throw new Error("CorusProgram must include objective.");
  assertStringArray(value.constraints, "CorusProgram constraints must be a string array.");
  assertObject(value.object_schemas, "CorusProgram must include object_schemas.");
  assertCanonicalObjectSchemas(value.object_schemas);
  if (!Array.isArray(value.process_definitions)) throw new Error("CorusProgram must include process_definitions array.");
  const processDefinitions = value.process_definitions.map(validateProcessDefinition);
  assertObject(value.state, "CorusProgram must include state.");
  const state = value.state as Record<string, unknown>;
  if (state.schema_version !== "corus.program_state.v1") throw new Error("CorusProgram state schema_version must be corus.program_state.v1.");
  assertProgramStatus(state.status, "CorusProgram state has invalid status.");
  if (typeof state.run_id !== "string") throw new Error("CorusProgram state must include run_id.");
  if (!(state.mode === "mocked" || state.mode === "fixture" || state.mode === "live")) throw new Error("CorusProgram state has invalid mode.");
  assertObject(state.source_refs, "CorusProgram state must include source_refs.");
  if (typeof state.source_refs.subject !== "string" || typeof state.source_refs.target !== "string") {
    throw new Error("CorusProgram state source_refs must include subject and target.");
  }
  if (typeof state.current_process_id !== "string") throw new Error("CorusProgram state must include current_process_id.");
  assertObject(state.process_status, "CorusProgram state must include process_status.");
  assertObject(state.contexts, "CorusProgram state must include contexts.");
  const contexts = {
    subject: validateContextOutput(state.contexts.subject, "program"),
    target: validateContextOutput(state.contexts.target, "program")
  };
  const reduction = validateReductionReferences(validateReductionOutput(state.reduction, "program"), contexts, "program");
  const validation = validateCapabilityValidationOutput(state.validation, "program");
  if (!Array.isArray(state.generation_records)) throw new Error("CorusProgram state must include generation_records array.");
  if (!Array.isArray(state.history)) throw new Error("CorusProgram state must include history array.");
  assertObject(state.replay, "CorusProgram state must include replay metadata.");
  assertStringArray(state.replay.validation_rules, "CorusProgram replay validation_rules must be a string array.");
  const providerCallsMade = state.replay.provider_calls_made;
  if (!Number.isInteger(providerCallsMade) || (providerCallsMade as number) < 0) {
    throw new Error("CorusProgram replay provider_calls_made must be a nonnegative integer.");
  }
  const recordedProviderCallsMade = providerCallsMade as number;

  if (state.projection !== null) {
    assertProjection(state.projection);
    if (validateProjectionNoInvention(state.projection, validation).length > 0) {
      throw new Error("CorusProgram projection includes capability ids not admitted by validation.");
    }
  }
  if (reduction.capabilities.map((capability) => capability.id).join("\n") !== ((state as { reduction: CapabilityReduction }).reduction.capabilities ?? []).map((capability) => capability.id).join("\n")) {
    throw new Error("CorusProgram reduction changed during validation.");
  }

  const replay = processStatusFromHistory(processDefinitions, state.history as CorusTransitionEvent[]);
  if (replay.status !== state.status || replay.current_process_id !== state.current_process_id) {
    throw new Error("CorusProgram history replays to a different current process or status than serialized state.");
  }
  if (replay.provider_calls_made !== recordedProviderCallsMade) {
    throw new Error("CorusProgram replay provider_calls_made is inconsistent with transition history.");
  }
  for (const [processId, status] of Object.entries(replay.process_status)) {
    if (state.process_status[processId] !== status) {
      throw new Error(`CorusProgram process_status.${processId} does not match replayed history.`);
    }
  }

  return value as unknown as CorusProgram;
}

export function replayCorusProgramState(value: unknown): CorusProgramState {
  const program = validateCorusProgram(value);
  return clone(program.state);
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
