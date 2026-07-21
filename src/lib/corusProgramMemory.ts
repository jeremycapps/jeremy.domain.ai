import type { CorusPlannedAction, CorusProgram, CorusTransitionEvent } from "../types.js";
import {
  FilesystemDomainMemory,
  canonicalMemoryJson,
  memoryContentHash,
  type CheckpointRef,
  type MemoryRecovery,
  type ProgramEventMemoryInput
} from "./domainMemory.js";
import { applyCorusTransition, planNextCorusAction, validateCorusProgram } from "./corusProgram.js";

export type CorusMemoryEvent = ProgramEventMemoryInput<CorusTransitionEvent>;
export type CorusDomainMemory = FilesystemDomainMemory<CorusProgram, CorusMemoryEvent, CorusPlannedAction>;
export type CorusMemoryRecovery = MemoryRecovery<CorusProgram, CorusPlannedAction>;

function eventId(event: CorusTransitionEvent, index: number): string {
  return `event-${String(index + 1).padStart(6, "0")}-${memoryContentHash(event).slice(0, 12)}`;
}

function sourceId(role: string, sourceRef: string): string {
  return `source-${role}-${memoryContentHash(sourceRef).slice(0, 12)}`;
}

function assertCheckpointHistory(program: CorusProgram, events: CorusMemoryEvent[]): CorusProgram {
  if (events.length !== program.state.history.length) {
    throw new Error("CorusProgram checkpoint and replay-state history diverge.");
  }
  for (let index = 0; index < events.length; index += 1) {
    const memoryEvent = events[index];
    const stateEvent = program.state.history[index];
    if (
      memoryEvent.program_ref !== program.program_id ||
      memoryEvent.actor_ref !== stateEvent.actor_ref ||
      memoryEvent.occurred_at !== stateEvent.occurred_at ||
      canonicalMemoryJson(memoryEvent.event) !== canonicalMemoryJson(stateEvent)
    ) {
      throw new Error(`CorusProgram checkpoint and replay-state history diverge at event ${index + 1}.`);
    }
  }
  return program;
}

export function createCorusDomainMemory(root: string): CorusDomainMemory {
  return new FilesystemDomainMemory<CorusProgram, CorusMemoryEvent, CorusPlannedAction>({
    root,
    recoveryPolicy: {
      validateCheckpoint(state, checkpointEvents) {
        const candidate = state as Partial<CorusProgram>;
        if (!candidate.state || !Array.isArray(candidate.state.history) || candidate.state.history.length !== checkpointEvents.length) {
          throw new Error("CorusProgram checkpoint and replay-state history diverge.");
        }
        return assertCheckpointHistory(validateCorusProgram(state), checkpointEvents);
      },
      applyEvent(state, memoryEvent) {
        if (memoryEvent.program_ref !== state.program_id) throw new Error("Cross-Program Corus event replay is not allowed.");
        if (memoryEvent.actor_ref !== memoryEvent.event.actor_ref || memoryEvent.occurred_at !== memoryEvent.event.occurred_at) {
          throw new Error("Corus memory event provenance does not match its transition event.");
        }
        return applyCorusTransition(state, memoryEvent.event);
      },
      validateRecovered(state) {
        return validateCorusProgram(state);
      },
      plan(state) {
        return planNextCorusAction(state);
      },
      historicalProviderCalls(state) {
        return state.state.replay.historical_provider_calls_made;
      }
    }
  });
}

export async function persistCorusProgram(memory: CorusDomainMemory, value: unknown): Promise<CheckpointRef> {
  const program = validateCorusProgram(value);
  const firstEvent = program.state.history[0];
  const lastEvent = program.state.history.at(-1);
  if (!firstEvent || !lastEvent) throw new Error("CorusProgram persistence requires nonempty history.");

  const sourceRecordIds: string[] = [];
  for (const [role, sourceRef] of Object.entries(program.state.source_refs)) {
    if (!sourceRef) continue;
    const ref = await memory.capture({
      id: sourceId(role, sourceRef),
      program_ref: program.program_id,
      schema_version: "domain.memory_source_pointer.v1",
      content: { role, source_ref: sourceRef },
      created_at: firstEvent.occurred_at,
      created_by: firstEvent.actor_ref,
      source_refs: [sourceRef]
    });
    sourceRecordIds.push(ref.id);
  }

  const eventRecordIds: string[] = [];
  for (const [index, event] of program.state.history.entries()) {
    const ref = await memory.appendEvent({
      id: eventId(event, index),
      program_ref: program.program_id,
      schema_version: "corus.transition_event.v1",
      event,
      actor_ref: event.actor_ref,
      occurred_at: event.occurred_at,
      created_at: event.occurred_at,
      created_by: event.actor_ref,
      status: event.returned_status,
      metadata: { process_id: event.process_id, prior_status: event.prior_status, returned_status: event.returned_status },
      source_refs: Object.values(event.artifact_refs)
    });
    eventRecordIds.push(ref.id);
  }

  const unresolvedProposalIds: string[] = [];
  if (program.state.projection && program.state.status !== "admitted") {
    const proposalRef = await memory.propose({
      id: `proposal-${memoryContentHash(program.state.projection).slice(0, 16)}`,
      program_ref: program.program_id,
      schema_version: "corus.projection.v1",
      content: program.state.projection,
      created_at: lastEvent.occurred_at,
      created_by: lastEvent.actor_ref,
      status: program.state.status,
      metadata: { current_process_id: program.state.current_process_id },
      source_refs: [
        ...Object.values(lastEvent.artifact_refs),
        ...program.state.generation_records.flatMap((record) => record.input_refs)
      ],
      record_role: "derived"
    });
    unresolvedProposalIds.push(proposalRef.id);
  }

  const admittedRecords = await memory.search({ program_ref: program.program_id, kinds: ["admitted_product"], statuses: ["admitted"] });
  if (program.state.status === "admitted" && admittedRecords.length === 0) {
    throw new Error("An admitted CorusProgram requires an explicit DomainMemory admission record.");
  }

  return memory.checkpoint({
    program_ref: program.program_id,
    schema_version: "corus.program_checkpoint.v1",
    state: program,
    event_refs: eventRecordIds,
    admitted_record_refs: admittedRecords.map((ref) => ref.id),
    unresolved_proposal_refs: unresolvedProposalIds,
    required_record_refs: [...sourceRecordIds, ...unresolvedProposalIds],
    created_at: lastEvent.occurred_at,
    created_by: lastEvent.actor_ref,
    metadata: { status: program.state.status, current_process_id: program.state.current_process_id }
  });
}

export async function recoverCorusProgram(memory: CorusDomainMemory, programId: string): Promise<CorusMemoryRecovery> {
  return memory.recover(programId);
}
