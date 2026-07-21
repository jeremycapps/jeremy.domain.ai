import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CorusProgram, CorusTransitionEvent } from "../src/types.js";
import {
  createCorusDomainMemory,
  persistCorusProgram,
  recoverCorusProgram,
  type CorusDomainMemory,
  type CorusMemoryEvent
} from "../src/lib/corusProgramMemory.js";
import { applyCorusTransition, loadCorusProgram, validateCorusProgram } from "../src/lib/corusProgram.js";

const occurredAt = "2026-07-21T12:00:00.000Z";
const goldenPath = path.join(process.cwd(), "test", "fixtures", "prophet", "prophet_corus_program_golden.yaml");

async function memoryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "domain-memory-test-"));
}

async function goldenProgram(): Promise<CorusProgram> {
  return loadCorusProgram(goldenPath);
}

function sourceInput(programRef: string, id = "source-one", content: unknown = { value: "source" }) {
  return {
    id,
    program_ref: programRef,
    schema_version: "test.source.v1",
    content,
    created_at: occurredAt,
    created_by: "author:test",
    status: "available",
    metadata: { category: "fixture" },
    source_refs: ["fixtures/source-one.yaml"]
  };
}

function proposalInput(programRef: string, id = "proposal-one", content: unknown = { value: "proposal" }) {
  return {
    id,
    program_ref: programRef,
    schema_version: "test.proposal.v1",
    content,
    created_at: "2026-07-21T12:01:00.000Z",
    created_by: "author:test",
    status: "awaiting_author",
    metadata: { category: "fixture" },
    source_refs: ["fixtures/source-one.yaml"]
  };
}

function decisionInput(programRef: string, proposalRefs: string[], decision: "accept" | "reject" = "accept", authorizedObjectRefs = proposalRefs) {
  return {
    id: `decision-${decision}`,
    program_ref: programRef,
    schema_version: "test.decision.v1",
    proposal_refs: proposalRefs,
    decision,
    authorized_object_refs: authorizedObjectRefs,
    actor_ref: "author:test",
    occurred_at: "2026-07-21T12:02:00.000Z",
    created_at: "2026-07-21T12:02:00.000Z",
    created_by: "author:test"
  };
}

function admissionInput(programRef: string, proposalRefs: string[], decisionRef: string, admittedObjectRefs = proposalRefs) {
  return {
    id: "admission-one",
    program_ref: programRef,
    schema_version: "test.admission.v1",
    proposal_refs: proposalRefs,
    decision_ref: decisionRef,
    admitted_object_refs: admittedObjectRefs,
    actor_ref: "author:test",
    occurred_at: "2026-07-21T12:03:00.000Z",
    created_at: "2026-07-21T12:03:00.000Z",
    created_by: "author:test"
  };
}

async function filesystemSnapshot(root: string): Promise<Array<{ path: string; hash: string; size: number; modified: number }>> {
  const snapshot: Array<{ path: string; hash: string; size: number; modified: number }> = [];
  async function visit(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else {
        const content = await fs.readFile(filePath);
        const stat = await fs.stat(filePath);
        snapshot.push({
          path: path.relative(root, filePath),
          hash: createHash("sha256").update(content).digest("hex"),
          size: stat.size,
          modified: stat.mtimeMs
        });
      }
    }
  }
  await visit(root);
  return snapshot;
}

test("DomainMemory captures sources, preserves proposals, and admits only through an explicit author decision", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  const programRef = "memory-authority-proof";
  const sourceRef = await memory.capture(sourceInput(programRef));
  const sourceRecord = await memory.read(sourceRef);
  assert.deepEqual(sourceRecord.content, { value: "source" });
  assert.equal(sourceRef.record_role, "canonical");

  const proposalRef = await memory.propose(proposalInput(programRef));
  assert.equal(proposalRef.record_role, "derived");
  assert.deepEqual(await memory.search({ program_ref: programRef, kinds: ["admitted_product"] }), []);

  const decisionRef = await memory.recordDecision(decisionInput(programRef, [proposalRef.id]));
  const admissionRef = await memory.recordAdmission(admissionInput(programRef, [proposalRef.id], decisionRef.id));
  const admission = await memory.read(admissionRef);
  assert.deepEqual(admission.content, {
    proposal_refs: [proposalRef.id],
    decision_ref: decisionRef.id,
    admitted_object_refs: [proposalRef.id],
    actor_ref: "author:test",
    occurred_at: "2026-07-21T12:03:00.000Z"
  });
});

test("DomainMemory exact-match search is stable and isolates Programs", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  await memory.capture({ ...sourceInput("program-a", "source-later"), created_at: "2026-07-21T12:02:00.000Z" });
  await memory.capture({ ...sourceInput("program-a", "source-earlier"), created_at: "2026-07-21T12:01:00.000Z" });
  await memory.capture(sourceInput("program-b", "source-other"));

  const first = await memory.search({
    program_ref: "program-a",
    kinds: ["source"],
    statuses: ["available"],
    metadata: { category: "fixture" },
    source_refs: ["fixtures/source-one.yaml"]
  });
  const second = await memory.search({
    program_ref: "program-a",
    kinds: ["source"],
    statuses: ["available"],
    metadata: { category: "fixture" },
    source_refs: ["fixtures/source-one.yaml"]
  });
  assert.deepEqual(first.map((ref) => ref.id), ["source-earlier", "source-later"]);
  assert.deepEqual(second, first);
  assert.equal(first.every((ref) => ref.program_ref === "program-a"), true);
  assert.deepEqual((await memory.search({ program_ref: "program-b" })).map((ref) => ref.id), ["source-other"]);
});

test("Prophet CorusProgram persists to versioned checkpoints and recovers in a fresh memory instance", async () => {
  const root = await memoryRoot();
  const program = await goldenProgram();
  const firstMemory = createCorusDomainMemory(root);
  const firstCheckpoint = await persistCorusProgram(firstMemory, program);
  const secondCheckpoint = await persistCorusProgram(firstMemory, program);
  assert.equal(firstCheckpoint.version, 1);
  assert.equal(secondCheckpoint.version, 2);
  assert.notEqual(firstCheckpoint.id, secondCheckpoint.id);

  const beforeRecovery = await filesystemSnapshot(root);
  const recovered = await recoverCorusProgram(createCorusDomainMemory(root), program.program_id);
  const afterRecovery = await filesystemSnapshot(root);

  assert.equal(recovered.recovered_state.state.status, "awaiting_author");
  assert.equal(recovered.recovered_state.state.current_process_id, "capability_admission");
  assert.equal(recovered.next_action?.operation, "author_decision");
  assert.equal(recovered.next_action?.execution_required, false);
  assert.equal(recovered.recovery_provider_calls, 0);
  assert.equal(recovered.historical_provider_calls, 0);
  assert.equal(recovered.replayed_event_refs.length, program.state.history.length);
  assert.deepEqual(recovered.recovered_state.state, program.state);
  assert.deepEqual(afterRecovery, beforeRecovery);
});

test("DomainMemory replays immutable Corus events appended after a checkpoint", async () => {
  const root = await memoryRoot();
  const program = await goldenProgram();
  const memory = createCorusDomainMemory(root);
  await persistCorusProgram(memory, program);
  const transition: CorusTransitionEvent = {
    process_id: "capability_admission",
    prior_status: "awaiting_author",
    returned_status: "awaiting_author",
    artifact_refs: {
      author_review: "memory://author-review",
      author_decision: "memory://author-decision-pending"
    },
    occurred_at: "2026-07-21T00:02:00.000Z",
    actor_ref: "author:test",
    provider_calls_made: 0
  };
  await memory.appendEvent({
    id: "event-000006-author-review",
    program_ref: program.program_id,
    schema_version: "corus.transition_event.v1",
    event: transition,
    actor_ref: transition.actor_ref,
    occurred_at: transition.occurred_at,
    created_at: transition.occurred_at,
    created_by: transition.actor_ref,
    status: transition.returned_status,
    metadata: { process_id: transition.process_id },
    source_refs: Object.values(transition.artifact_refs)
  } satisfies CorusMemoryEvent);

  const recovered = await createCorusDomainMemory(root).recover(program.program_id);
  assert.equal(recovered.recovered_state.state.history.length, program.state.history.length + 1);
  assert.deepEqual(recovered.recovered_state.state.history.at(-1), transition);
  assert.equal(recovered.next_action?.operation, "author_decision");
  assert.equal(recovered.recovery_provider_calls, 0);
});

test("Corus admission recovery re-verifies its explicit decision and authorized proposal", async () => {
  const root = await memoryRoot();
  const program = await goldenProgram();
  const memory = createCorusDomainMemory(root);
  await persistCorusProgram(memory, program);
  const [proposal] = await memory.search({ program_ref: program.program_id, kinds: ["proposal"] });
  const decision = await memory.recordDecision(decisionInput(program.program_id, [proposal.id]));
  const admission = await memory.recordAdmission(admissionInput(program.program_id, [proposal.id], decision.id));
  const transition: CorusTransitionEvent = {
    process_id: "capability_admission",
    prior_status: "awaiting_author",
    returned_status: "admitted",
    artifact_refs: { author_review: proposal.storage_ref, author_decision: decision.storage_ref },
    occurred_at: "2026-07-21T12:04:00.000Z",
    actor_ref: "author:test",
    provider_calls_made: 0
  };
  const admittedProgram = applyCorusTransition(program, transition);
  const event = await memory.appendEvent({
    id: "event-000006-admission",
    program_ref: program.program_id,
    schema_version: "corus.transition_event.v1",
    event: transition,
    actor_ref: transition.actor_ref,
    occurred_at: transition.occurred_at,
    created_at: transition.occurred_at,
    created_by: transition.actor_ref,
    status: transition.returned_status,
    source_refs: Object.values(transition.artifact_refs)
  } satisfies CorusMemoryEvent);
  const eventRefs = (await memory.search({ program_ref: program.program_id, kinds: ["program_event"] })).map((ref) => ref.id);
  assert.equal(eventRefs.includes(event.id), true);
  await memory.checkpoint({
    program_ref: program.program_id,
    schema_version: "corus.program_checkpoint.v1",
    state: admittedProgram,
    event_refs: eventRefs,
    admitted_record_refs: [admission.id],
    unresolved_proposal_refs: [],
    required_record_refs: [proposal.id, decision.id],
    created_at: transition.occurred_at,
    created_by: transition.actor_ref
  });

  const recovered = await createCorusDomainMemory(root).recover(program.program_id);
  assert.equal(recovered.recovered_state.state.status, "admitted");
  assert.deepEqual(recovered.admitted_record_refs.map((ref) => ref.id), [admission.id]);
  assert.equal(recovered.next_action, null);

  await fs.unlink(path.join(root, decision.storage_ref));
  await assert.rejects(createCorusDomainMemory(root).recover(program.program_id), /Referenced memory record decision-accept is missing/);
});

test("DomainMemory preserves exact historical execution-receipt totals", async () => {
  const root = await memoryRoot();
  const program = structuredClone(await goldenProgram());
  program.state.history[1] = {
    ...program.state.history[1],
    provider_calls_made: 3,
    execution_receipts: [{ id: "receipt-reduction", provider_calls_made: 3 }]
  };
  program.state.replay.historical_provider_calls_made = 3;
  validateCorusProgram(program);
  await persistCorusProgram(createCorusDomainMemory(root), program);

  const recovered = await createCorusDomainMemory(root).recover(program.program_id);
  assert.equal(recovered.historical_provider_calls, 3);
  assert.equal(recovered.recovered_state.state.replay.historical_provider_calls_made, 3);
  assert.equal(recovered.recovery_provider_calls, 0);
});

test("DomainMemory rejects admission without a decision or from a rejected decision", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  const proposal = await memory.propose(proposalInput("admission-invalid"));
  await assert.rejects(
    memory.recordAdmission(admissionInput("admission-invalid", [proposal.id], "")),
    /requires a decision reference/
  );
  const rejected = await memory.recordDecision(decisionInput("admission-invalid", [proposal.id], "reject", []));
  await assert.rejects(
    memory.recordAdmission(admissionInput("admission-invalid", [proposal.id], rejected.id)),
    /Rejected or non-accepting decisions cannot create admitted records/
  );
});

test("DomainMemory rejects admission of objects not authorized by the decision", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  const first = await memory.propose(proposalInput("admission-scope", "proposal-first"));
  const second = await memory.propose(proposalInput("admission-scope", "proposal-second"));
  const decision = await memory.recordDecision(decisionInput("admission-scope", [first.id, second.id], "accept", [first.id]));
  await assert.rejects(
    memory.recordAdmission(admissionInput("admission-scope", [second.id], decision.id, [second.id])),
    /does not authorize object proposal-second/
  );
});

test("DomainMemory rejects cross-Program and missing record references", async () => {
  const root = await memoryRoot();
  const memory = createCorusDomainMemory(root);
  const proposal = await memory.propose(proposalInput("program-one", "proposal-cross-program"));
  await assert.rejects(
    memory.recordDecision(decisionInput("program-two", [proposal.id])),
    /does not exist for program program-two/
  );
  await assert.rejects(
    memory.recordDecision(decisionInput("program-one", ["missing-proposal"])),
    /Memory record missing-proposal does not exist/
  );
  await assert.rejects(
    memory.checkpoint({
      program_ref: "program-one",
      schema_version: "test.checkpoint.v1",
      state: await goldenProgram(),
      event_refs: ["missing-event"],
      admitted_record_refs: [],
      unresolved_proposal_refs: [],
      created_at: occurredAt,
      created_by: "author:test"
    }),
    /Memory record missing-event does not exist/
  );
});

test("DomainMemory recovery rejects a missing referenced source record", async () => {
  const root = await memoryRoot();
  const memory = createCorusDomainMemory(root);
  const source = await memory.capture(sourceInput("missing-source-proof"));
  await memory.checkpoint({
    program_ref: "missing-source-proof",
    schema_version: "test.checkpoint.v1",
    state: await goldenProgram(),
    event_refs: [],
    admitted_record_refs: [],
    unresolved_proposal_refs: [],
    required_record_refs: [source.id],
    created_at: occurredAt,
    created_by: "author:test"
  });
  await fs.unlink(path.join(root, source.storage_ref));
  await assert.rejects(memory.recover("missing-source-proof"), /Referenced memory record source-one is missing/);
});

test("DomainMemory recovery rejects live Corus history without execution receipts", async () => {
  const root = await memoryRoot();
  const memory = createCorusDomainMemory(root);
  const program = structuredClone(await goldenProgram());
  program.program_id = "live-missing-receipts";
  program.state.mode = "live";
  const eventRefs: string[] = [];
  for (const [index, event] of program.state.history.entries()) {
    const ref = await memory.appendEvent({
      id: `event-${String(index + 1).padStart(6, "0")}`,
      program_ref: program.program_id,
      schema_version: "corus.transition_event.v1",
      event,
      actor_ref: event.actor_ref,
      occurred_at: event.occurred_at,
      created_at: event.occurred_at,
      created_by: event.actor_ref
    } satisfies CorusMemoryEvent);
    eventRefs.push(ref.id);
  }
  await memory.checkpoint({
    program_ref: program.program_id,
    schema_version: "corus.program_checkpoint.v1",
    state: program,
    event_refs: eventRefs,
    admitted_record_refs: [],
    unresolved_proposal_refs: [],
    created_at: program.state.history.at(-1)!.occurred_at,
    created_by: program.state.history.at(-1)!.actor_ref
  });
  await assert.rejects(memory.recover(program.program_id), /requires execution receipts, including explicit zero-call evidence/);
});

test("DomainMemory detects tampered content hashes", async () => {
  const root = await memoryRoot();
  const program = await goldenProgram();
  const memory = createCorusDomainMemory(root);
  await persistCorusProgram(memory, program);
  const [proposal] = await memory.search({ program_ref: program.program_id, kinds: ["proposal"] });
  const proposalPath = path.join(root, proposal.storage_ref);
  const stored = JSON.parse(await fs.readFile(proposalPath, "utf8")) as { content: { content: string } };
  stored.content.content = "tampered projection";
  await fs.writeFile(proposalPath, `${JSON.stringify(stored)}\n`, "utf8");

  await assert.rejects(createCorusDomainMemory(root).recover(program.program_id), /failed content hash verification/);
});

test("DomainMemory rejects immutable overwrite and duplicate IDs with different content", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  await memory.capture(sourceInput("immutable-proof", "duplicate-id", { version: 1 }));
  await assert.rejects(
    memory.capture(sourceInput("immutable-proof", "duplicate-id", { version: 2 })),
    /Duplicate memory record id duplicate-id has different content/
  );
});

test("DomainMemory rejects checkpoint and replay-state divergence", async () => {
  const root = await memoryRoot();
  const program = await goldenProgram();
  const memory = createCorusDomainMemory(root);
  await persistCorusProgram(memory, program);
  const eventRefs = (await memory.search({ program_ref: program.program_id, kinds: ["program_event"] })).map((ref) => ref.id);
  const proposalRefs = (await memory.search({ program_ref: program.program_id, kinds: ["proposal"] })).map((ref) => ref.id);
  const divergent = structuredClone(program);
  divergent.state.history.pop();
  await memory.checkpoint({
    program_ref: program.program_id,
    schema_version: "corus.program_checkpoint.v1",
    state: divergent,
    event_refs: eventRefs,
    admitted_record_refs: [],
    unresolved_proposal_refs: proposalRefs,
    created_at: "2026-07-21T00:03:00.000Z",
    created_by: "author:test"
  });
  await assert.rejects(memory.recover(program.program_id), /checkpoint and replay-state history diverge/);
});

test("DomainMemory rejects malformed actor and timestamp provenance", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  await assert.rejects(memory.capture({ ...sourceInput("bad-provenance"), created_by: " " }), /nonempty actor reference/);
  await assert.rejects(memory.capture({ ...sourceInput("bad-provenance"), created_at: "not-a-time" }), /valid ISO-8601 timestamp/);
  const transition = (await goldenProgram()).state.history[0];
  await assert.rejects(
    memory.appendEvent({
      id: "bad-event",
      program_ref: "bad-provenance",
      schema_version: "corus.transition_event.v1",
      event: transition,
      actor_ref: "",
      occurred_at: transition.occurred_at,
      created_at: transition.occurred_at,
      created_by: "author:test"
    } satisfies CorusMemoryEvent),
    /nonempty actor reference/
  );
});

test("DomainMemory rejects path traversal IDs and unknown Program recovery", async () => {
  const memory = createCorusDomainMemory(await memoryRoot());
  await assert.rejects(memory.search({ kinds: ["source"] } as never), /search requires program_ref/);
  await assert.rejects(memory.capture(sourceInput("../escape")), /path-safe identifier/);
  await assert.rejects(memory.capture(sourceInput("safe-program", "../escape")), /path-safe identifier/);
  await assert.rejects(memory.recover("unknown-program"), /Unknown DomainMemory program unknown-program/);
});
