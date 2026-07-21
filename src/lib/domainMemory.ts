import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type MemoryKind = "source" | "proposal" | "decision" | "admitted_product" | "program_event" | "checkpoint";
export type MemoryRecordRole = "canonical" | "derived";
export type MemoryMetadataValue = string | number | boolean | null;

export interface MemoryRecordRef {
  id: string;
  kind: MemoryKind;
  program_ref: string;
  schema_version: string;
  content_hash: string;
  created_at: string;
  created_by: string;
  storage_ref: string;
  record_role: MemoryRecordRole;
}

export interface CheckpointRef extends MemoryRecordRef {
  kind: "checkpoint";
  version: number;
}

export interface MemoryQuery {
  program_ref: string;
  ids?: string[];
  kinds?: MemoryKind[];
  statuses?: string[];
  metadata?: Record<string, MemoryMetadataValue>;
  source_refs?: string[];
}

interface BaseMemoryInput<TContent> {
  id: string;
  program_ref: string;
  schema_version: string;
  content: TContent;
  created_at: string;
  created_by: string;
  status?: string;
  metadata?: Record<string, MemoryMetadataValue>;
  source_refs?: string[];
  record_role?: MemoryRecordRole;
}

export type SourceMemoryInput<TContent = unknown> = BaseMemoryInput<TContent>;
export type ProposalMemoryInput<TContent = unknown> = BaseMemoryInput<TContent>;

export type MemoryDecision = "accept" | "reject" | "revise" | "supersede";

export interface DecisionMemoryInput {
  id: string;
  program_ref: string;
  schema_version: string;
  proposal_refs: string[];
  decision: MemoryDecision;
  authorized_object_refs: string[];
  actor_ref: string;
  occurred_at: string;
  reason?: string;
  created_at: string;
  created_by: string;
  metadata?: Record<string, MemoryMetadataValue>;
  source_refs?: string[];
}

export interface AdmissionMemoryInput {
  id: string;
  program_ref: string;
  schema_version: string;
  proposal_refs: string[];
  decision_ref: string;
  admitted_object_refs: string[];
  actor_ref: string;
  occurred_at: string;
  created_at: string;
  created_by: string;
  metadata?: Record<string, MemoryMetadataValue>;
  source_refs?: string[];
}

export interface ProgramEventMemoryInput<TEvent> {
  id: string;
  program_ref: string;
  schema_version: string;
  ordinal: number;
  parent_event_ref: string | null;
  event: TEvent;
  actor_ref: string;
  occurred_at: string;
  created_at: string;
  created_by: string;
  status?: string;
  metadata?: Record<string, MemoryMetadataValue>;
  source_refs?: string[];
}

export interface EventCursor {
  ordinal: number;
  event_ref: string;
}

export interface CheckpointInput<TProgramState> {
  id?: string;
  program_ref: string;
  schema_version: string;
  state: TProgramState;
  event_refs: string[];
  event_cursor: EventCursor | null;
  admitted_record_refs: string[];
  unresolved_proposal_refs: string[];
  required_record_refs?: string[];
  created_at: string;
  created_by: string;
  metadata?: Record<string, MemoryMetadataValue>;
}

export interface MemoryValidation {
  status: "valid";
  verified_record_refs: string[];
}

export interface MemoryRecovery<TProgramState, TNextAction = unknown> {
  program_id: string;
  recovered_state: TProgramState;
  checkpoint_ref: CheckpointRef;
  replayed_event_refs: MemoryRecordRef[];
  admitted_record_refs: MemoryRecordRef[];
  unresolved_proposal_refs: MemoryRecordRef[];
  historical_provider_calls: number;
  recovery_provider_calls: 0;
  validation: MemoryValidation;
  next_action: TNextAction | null;
}

export interface StoredMemoryRecord<TContent = unknown> {
  ref: MemoryRecordRef;
  status?: string;
  metadata: Record<string, MemoryMetadataValue>;
  source_refs: string[];
  content: TContent;
}

export interface DomainMemory<TProgramState, TProgramEvent, TNextAction = unknown> {
  recover(programId: string): Promise<MemoryRecovery<TProgramState, TNextAction>>;
  search(query: MemoryQuery): Promise<MemoryRecordRef[]>;
  capture(input: SourceMemoryInput): Promise<MemoryRecordRef>;
  propose(input: ProposalMemoryInput): Promise<MemoryRecordRef>;
  recordDecision(input: DecisionMemoryInput): Promise<MemoryRecordRef>;
  recordAdmission(input: AdmissionMemoryInput): Promise<MemoryRecordRef>;
  appendEvent(event: TProgramEvent): Promise<MemoryRecordRef>;
  checkpoint(input: CheckpointInput<TProgramState>): Promise<CheckpointRef>;
  read(ref: MemoryRecordRef): Promise<StoredMemoryRecord>;
}

export interface MemoryRecoveryPolicy<TProgramState, TProgramEvent, TNextAction> {
  validateCheckpoint(state: unknown, checkpointEvents: TProgramEvent[]): TProgramState;
  applyEvent(state: TProgramState, event: TProgramEvent): TProgramState;
  validateRecovered(state: unknown): TProgramState;
  plan(state: TProgramState): TNextAction | null;
  historicalProviderCalls(state: TProgramState): number;
}

interface MemoryManifestEntry {
  ref: MemoryRecordRef;
  status?: string;
  metadata: Record<string, MemoryMetadataValue>;
  source_refs: string[];
}

interface MemoryManifest {
  schema_version: "domain.memory_manifest.v1";
  program_ref: string;
  records: MemoryManifestEntry[];
}

interface StoredCheckpoint<TProgramState> {
  version: number;
  state: TProgramState;
  event_refs: string[];
  event_cursor: EventCursor | null;
  admitted_record_refs: string[];
  unresolved_proposal_refs: string[];
  required_record_refs: string[];
}

interface CurrentCheckpointPointer {
  schema_version: "domain.memory_current_checkpoint.v1";
  checkpoint_ref: CheckpointRef;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !safeIdPattern.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a path-safe identifier.`);
  }
}

function assertActor(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a nonempty actor reference.`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isoTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} must be a string array.`);
  }
}

function assertNonemptyStringArray(value: unknown, label: string): asserts value is string[] {
  assertStringArray(value, label);
  if (value.length === 0) throw new Error(`${label} must not be empty.`);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

export function canonicalMemoryJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function memoryContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalMemoryJson(value)).digest("hex");
}

function refsEqual(left: MemoryRecordRef, right: MemoryRecordRef): boolean {
  const core = (value: MemoryRecordRef) => ({
    id: value.id,
    kind: value.kind,
    program_ref: value.program_ref,
    schema_version: value.schema_version,
    content_hash: value.content_hash,
    created_at: value.created_at,
    created_by: value.created_by,
    storage_ref: value.storage_ref,
    record_role: value.record_role
  });
  return canonicalMemoryJson(core(left)) === canonicalMemoryJson(core(right));
}

function stableEntrySort(left: MemoryManifestEntry, right: MemoryManifestEntry): number {
  return left.ref.created_at.localeCompare(right.ref.created_at) || left.ref.id.localeCompare(right.ref.id) || left.ref.program_ref.localeCompare(right.ref.program_ref);
}

export class FilesystemDomainMemory<TProgramState, TProgramEvent, TNextAction = unknown>
  implements DomainMemory<TProgramState, TProgramEvent, TNextAction>
{
  readonly root: string;

  constructor(input: { root: string; recoveryPolicy: MemoryRecoveryPolicy<TProgramState, TProgramEvent, TNextAction> }) {
    if (!input.root || !path.isAbsolute(input.root)) throw new Error("DomainMemory root must be an explicit absolute path.");
    this.root = path.resolve(input.root);
    this.recoveryPolicy = input.recoveryPolicy;
  }

  private readonly recoveryPolicy: MemoryRecoveryPolicy<TProgramState, TProgramEvent, TNextAction>;

  private programDir(programId: string): string {
    assertSafeId(programId, "Program id");
    return path.join(this.root, "programs", programId);
  }

  private manifestPath(programId: string): string {
    return path.join(this.programDir(programId), "manifest.json");
  }

  private pointerPath(programId: string): string {
    return path.join(this.programDir(programId), "current-checkpoint.json");
  }

  private storagePath(ref: Pick<MemoryRecordRef, "storage_ref">): string {
    const resolved = path.resolve(this.root, ref.storage_ref);
    if (!(resolved === this.root || resolved.startsWith(`${this.root}${path.sep}`))) throw new Error("Memory storage_ref escapes the configured root.");
    return resolved;
  }

  private async readManifest(programId: string): Promise<MemoryManifest> {
    try {
      const value = JSON.parse(await fs.readFile(this.manifestPath(programId), "utf8")) as MemoryManifest;
      if (
        value.schema_version !== "domain.memory_manifest.v1" ||
        value.program_ref !== programId ||
        !Array.isArray(value.records) ||
        value.records.some((entry) => !entry.ref || entry.ref.program_ref !== programId)
      ) {
        throw new Error(`DomainMemory manifest for ${programId} is invalid.`);
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema_version: "domain.memory_manifest.v1", program_ref: programId, records: [] };
      }
      throw error;
    }
  }

  private async writeAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${canonicalMemoryJson(value)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, filePath);
  }

  private async updateManifest(entry: MemoryManifestEntry): Promise<void> {
    const manifest = await this.readManifest(entry.ref.program_ref);
    const existing = manifest.records.find((item) => item.ref.id === entry.ref.id);
    if (existing) {
      if (!refsEqual(existing.ref, entry.ref)) throw new Error(`Duplicate memory record id ${entry.ref.id} has different content.`);
      return;
    }
    manifest.records.push(entry);
    manifest.records.sort(stableEntrySort);
    await this.writeAtomic(this.manifestPath(entry.ref.program_ref), manifest);
  }

  private async store<TContent>(input: BaseMemoryInput<TContent>, kind: MemoryKind): Promise<MemoryRecordRef> {
    assertSafeId(input.program_ref, "Program id");
    assertSafeId(input.id, "Record id");
    assertActor(input.created_by, "created_by");
    assertTimestamp(input.created_at, "created_at");
    const contentHash = memoryContentHash(input.content);
    const storageRef = path.posix.join("programs", input.program_ref, "records", kind, `${input.id}.json`);
    const ref: MemoryRecordRef = {
      id: input.id,
      kind,
      program_ref: input.program_ref,
      schema_version: input.schema_version,
      content_hash: contentHash,
      created_at: input.created_at,
      created_by: input.created_by,
      storage_ref: storageRef,
      record_role: input.record_role ?? "canonical"
    };
    const record: StoredMemoryRecord<TContent> = {
      ref,
      ...(input.status ? { status: input.status } : {}),
      metadata: input.metadata ?? {},
      source_refs: input.source_refs ?? [],
      content: input.content
    };
    const manifest = await this.readManifest(input.program_ref);
    const indexed = manifest.records.find((entry) => entry.ref.id === input.id);
    if (indexed && !refsEqual(indexed.ref, ref)) throw new Error(`Duplicate memory record id ${input.id} has different content.`);
    const filePath = this.storagePath(ref);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(filePath, `${canonicalMemoryJson(record)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await fs.readFile(filePath, "utf8")) as StoredMemoryRecord;
      if (canonicalMemoryJson(existing) !== canonicalMemoryJson(record)) {
        throw new Error(`Immutable memory record ${input.id} cannot be overwritten with different content.`);
      }
    }
    await this.updateManifest({ ref, status: input.status, metadata: input.metadata ?? {}, source_refs: input.source_refs ?? [] });
    return ref;
  }

  private async readById(programId: string, recordId: string): Promise<StoredMemoryRecord> {
    assertSafeId(programId, "Program id");
    assertSafeId(recordId, "Record id");
    const manifest = await this.readManifest(programId);
    const entry = manifest.records.find((item) => item.ref.id === recordId);
    if (!entry) throw new Error(`Memory record ${recordId} does not exist for program ${programId}.`);
    return this.read(entry.ref);
  }

  private async requireRecord(programId: string, recordId: string, kind?: MemoryKind): Promise<StoredMemoryRecord> {
    const record = await this.readById(programId, recordId);
    if (record.ref.program_ref !== programId) throw new Error(`Cross-Program record reference ${recordId} is not allowed.`);
    if (kind && record.ref.kind !== kind) throw new Error(`Memory record ${recordId} must be kind ${kind}.`);
    return record;
  }

  private eventInput(record: StoredMemoryRecord): ProgramEventMemoryInput<unknown> {
    if (record.ref.kind !== "program_event") throw new Error(`Memory record ${record.ref.id} must be kind program_event.`);
    const event = record.content as ProgramEventMemoryInput<unknown>;
    if (!event || event.id !== record.ref.id || event.program_ref !== record.ref.program_ref) {
      throw new Error(`Program event ${record.ref.id} has invalid stream identity.`);
    }
    if (!Number.isInteger(event.ordinal) || event.ordinal < 1) {
      throw new Error(`Program event ${record.ref.id} must have a positive monotonic ordinal.`);
    }
    if (!(event.parent_event_ref === null || typeof event.parent_event_ref === "string")) {
      throw new Error(`Program event ${record.ref.id} has an invalid parent_event_ref.`);
    }
    if (event.ordinal === 1 && event.parent_event_ref !== null) {
      throw new Error(`First Program event ${record.ref.id} must not have a parent.`);
    }
    if (event.ordinal > 1 && !event.parent_event_ref) {
      throw new Error(`Program event ${record.ref.id} is missing its parent event.`);
    }
    return event;
  }

  private async programEventRecords(programId: string): Promise<StoredMemoryRecord[]> {
    const manifest = await this.readManifest(programId);
    const records: StoredMemoryRecord[] = [];
    for (const entry of manifest.records.filter((item) => item.ref.kind === "program_event")) {
      const record = await this.read(entry.ref);
      this.eventInput(record);
      records.push(record);
    }
    return records;
  }

  private async verifyCheckpointEventChain(
    programId: string,
    eventRefs: string[],
    cursor: EventCursor | null
  ): Promise<StoredMemoryRecord[]> {
    if (eventRefs.length === 0) {
      if (cursor !== null) throw new Error("An empty checkpoint event stream must use a null cursor.");
      return [];
    }
    if (!cursor || !Number.isInteger(cursor.ordinal) || cursor.ordinal < 1 || typeof cursor.event_ref !== "string") {
      throw new Error("A nonempty checkpoint event stream requires a valid event cursor.");
    }
    if (new Set(eventRefs).size !== eventRefs.length) throw new Error("Checkpoint event_refs contain duplicate events.");
    const records: StoredMemoryRecord[] = [];
    let parentEventRef: string | null = null;
    for (let index = 0; index < eventRefs.length; index += 1) {
      const record = await this.requireRecord(programId, eventRefs[index], "program_event");
      const event = this.eventInput(record);
      const expectedOrdinal = index + 1;
      if (event.ordinal !== expectedOrdinal) {
        throw new Error(`Checkpoint Program event stream has a sequence gap at ordinal ${expectedOrdinal}.`);
      }
      if (event.parent_event_ref !== parentEventRef) {
        throw new Error(`Checkpoint Program event ${event.id} does not descend from ${parentEventRef ?? "the stream root"}.`);
      }
      records.push(record);
      parentEventRef = record.ref.id;
    }
    if (cursor.ordinal !== records.length || cursor.event_ref !== records.at(-1)!.ref.id) {
      throw new Error("Checkpoint event cursor does not identify the verified tail event.");
    }
    return records;
  }

  private async verifyAdmission(programId: string, record: StoredMemoryRecord): Promise<void> {
    if (record.ref.kind !== "admitted_product") throw new Error(`Memory record ${record.ref.id} must be kind admitted_product.`);
    const admission = record.content as {
      proposal_refs?: string[];
      decision_ref?: string;
      admitted_object_refs?: string[];
      actor_ref?: string;
      occurred_at?: string;
    };
    assertActor(admission.actor_ref, "Admission actor_ref");
    assertTimestamp(admission.occurred_at, "Admission occurred_at");
    if (!admission.decision_ref) throw new Error(`Admission ${record.ref.id} requires a decision reference.`);
    assertNonemptyStringArray(admission.proposal_refs, `Admission ${record.ref.id} proposal_refs`);
    assertNonemptyStringArray(admission.admitted_object_refs, `Admission ${record.ref.id} admitted_object_refs`);
    const decisionRecord = await this.requireRecord(programId, admission.decision_ref, "decision");
    const decision = decisionRecord.content as {
      proposal_refs?: string[];
      decision?: MemoryDecision;
      authorized_object_refs?: string[];
      actor_ref?: string;
      occurred_at?: string;
    };
    assertActor(decision.actor_ref, `Decision ${admission.decision_ref} actor_ref`);
    assertTimestamp(decision.occurred_at, `Decision ${admission.decision_ref} occurred_at`);
    assertNonemptyStringArray(decision.proposal_refs, `Decision ${admission.decision_ref} proposal_refs`);
    assertStringArray(decision.authorized_object_refs, `Decision ${admission.decision_ref} authorized_object_refs`);
    if (decision.decision !== "accept") throw new Error(`Admission ${record.ref.id} is not backed by an accepting decision.`);
    for (const proposalRef of admission.proposal_refs) {
      await this.requireRecord(programId, proposalRef, "proposal");
      if (!decision.proposal_refs?.includes(proposalRef)) throw new Error(`Decision ${admission.decision_ref} does not cover proposal ${proposalRef}.`);
    }
    for (const objectRef of admission.admitted_object_refs) {
      await this.requireRecord(programId, objectRef);
      if (!decision.authorized_object_refs?.includes(objectRef)) {
        throw new Error(`Decision ${admission.decision_ref} does not authorize object ${objectRef}.`);
      }
    }
  }

  async read(ref: MemoryRecordRef): Promise<StoredMemoryRecord> {
    assertSafeId(ref.program_ref, "Program id");
    assertSafeId(ref.id, "Record id");
    let record: StoredMemoryRecord;
    try {
      record = JSON.parse(await fs.readFile(this.storagePath(ref), "utf8")) as StoredMemoryRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Referenced memory record ${ref.id} is missing.`);
      throw error;
    }
    if (!record.ref || !refsEqual(record.ref, ref)) throw new Error(`Memory record ${ref.id} reference metadata is invalid.`);
    if (memoryContentHash(record.content) !== ref.content_hash) throw new Error(`Memory record ${ref.id} failed content hash verification.`);
    return record;
  }

  async capture(input: SourceMemoryInput): Promise<MemoryRecordRef> {
    return this.store(input, "source");
  }

  async propose(input: ProposalMemoryInput): Promise<MemoryRecordRef> {
    return this.store({ ...input, record_role: input.record_role ?? "derived" }, "proposal");
  }

  async recordDecision(input: DecisionMemoryInput): Promise<MemoryRecordRef> {
    assertActor(input.actor_ref, "Decision actor_ref");
    assertTimestamp(input.occurred_at, "Decision occurred_at");
    if (!(input.decision === "accept" || input.decision === "reject" || input.decision === "revise" || input.decision === "supersede")) {
      throw new Error("Decision must be accept, reject, revise, or supersede.");
    }
    assertNonemptyStringArray(input.proposal_refs, "Decision proposal_refs");
    assertStringArray(input.authorized_object_refs, "Decision authorized_object_refs");
    for (const proposalRef of input.proposal_refs) await this.requireRecord(input.program_ref, proposalRef, "proposal");
    for (const objectRef of input.authorized_object_refs) await this.requireRecord(input.program_ref, objectRef);
    return this.store(
      {
        id: input.id,
        program_ref: input.program_ref,
        schema_version: input.schema_version,
        content: {
          proposal_refs: input.proposal_refs,
          decision: input.decision,
          authorized_object_refs: input.authorized_object_refs,
          actor_ref: input.actor_ref,
          occurred_at: input.occurred_at,
          ...(input.reason ? { reason: input.reason } : {})
        },
        created_at: input.created_at,
        created_by: input.created_by,
        status: input.decision,
        metadata: input.metadata,
        source_refs: input.source_refs
      },
      "decision"
    );
  }

  async recordAdmission(input: AdmissionMemoryInput): Promise<MemoryRecordRef> {
    assertActor(input.actor_ref, "Admission actor_ref");
    assertTimestamp(input.occurred_at, "Admission occurred_at");
    if (typeof input.decision_ref !== "string" || input.decision_ref.length === 0) throw new Error("Admission requires a decision reference.");
    assertNonemptyStringArray(input.proposal_refs, "Admission proposal_refs");
    assertNonemptyStringArray(input.admitted_object_refs, "Admission admitted_object_refs");
    const decisionRecord = await this.requireRecord(input.program_ref, input.decision_ref, "decision");
    const decision = decisionRecord.content as {
      proposal_refs?: string[];
      decision?: MemoryDecision;
      authorized_object_refs?: string[];
    };
    if (decision.decision !== "accept") throw new Error("Rejected or non-accepting decisions cannot create admitted records.");
    for (const proposalRef of input.proposal_refs) {
      await this.requireRecord(input.program_ref, proposalRef, "proposal");
      if (!decision.proposal_refs?.includes(proposalRef)) throw new Error(`Decision ${input.decision_ref} does not cover proposal ${proposalRef}.`);
    }
    for (const objectRef of input.admitted_object_refs) {
      await this.requireRecord(input.program_ref, objectRef);
      if (!decision.authorized_object_refs?.includes(objectRef)) {
        throw new Error(`Decision ${input.decision_ref} does not authorize object ${objectRef}.`);
      }
    }
    return this.store(
      {
        id: input.id,
        program_ref: input.program_ref,
        schema_version: input.schema_version,
        content: {
          proposal_refs: input.proposal_refs,
          decision_ref: input.decision_ref,
          admitted_object_refs: input.admitted_object_refs,
          actor_ref: input.actor_ref,
          occurred_at: input.occurred_at
        },
        created_at: input.created_at,
        created_by: input.created_by,
        status: "admitted",
        metadata: input.metadata,
        source_refs: input.source_refs
      },
      "admitted_product"
    );
  }

  async appendEvent(event: TProgramEvent): Promise<MemoryRecordRef> {
    const input = event as unknown as ProgramEventMemoryInput<unknown>;
    assertActor(input.actor_ref, "Program event actor_ref");
    assertTimestamp(input.occurred_at, "Program event occurred_at");
    assertSafeId(input.program_ref, "Program id");
    assertSafeId(input.id, "Record id");
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) throw new Error("Program event ordinal must be a positive integer.");
    if (input.ordinal === 1 && input.parent_event_ref !== null) throw new Error("The first Program event must have a null parent_event_ref.");
    if (input.ordinal > 1 && (!input.parent_event_ref || typeof input.parent_event_ref !== "string")) {
      throw new Error(`Program event ordinal ${input.ordinal} requires a parent_event_ref.`);
    }
    const existingEvents = await this.programEventRecords(input.program_ref);
    for (const record of existingEvents) {
      const existing = this.eventInput(record);
      if (existing.ordinal === input.ordinal && existing.id !== input.id) {
        throw new Error(`Program event stream has duplicate ordinal ${input.ordinal}.`);
      }
      if (input.parent_event_ref && existing.parent_event_ref === input.parent_event_ref && existing.id !== input.id) {
        throw new Error(`Program event stream forks from parent ${input.parent_event_ref}.`);
      }
    }
    if (input.ordinal > 1) {
      const parentRecord = await this.requireRecord(input.program_ref, input.parent_event_ref!, "program_event");
      const parent = this.eventInput(parentRecord);
      if (parent.ordinal !== input.ordinal - 1) {
        throw new Error(`Program event ${input.id} creates a sequence gap after parent ${parent.id}.`);
      }
    }
    return this.store(
      {
        id: input.id,
        program_ref: input.program_ref,
        schema_version: input.schema_version,
        content: event,
        created_at: input.created_at,
        created_by: input.created_by,
        status: input.status,
        metadata: { ...input.metadata, event_ordinal: input.ordinal, parent_event_ref: input.parent_event_ref },
        source_refs: input.source_refs
      },
      "program_event"
    );
  }

  async checkpoint(input: CheckpointInput<TProgramState>): Promise<CheckpointRef> {
    assertSafeId(input.program_ref, "Program id");
    assertActor(input.created_by, "Checkpoint created_by");
    assertTimestamp(input.created_at, "Checkpoint created_at");
    const manifest = await this.readManifest(input.program_ref);
    const version = manifest.records.filter((entry) => entry.ref.kind === "checkpoint").length + 1;
    const id = input.id ?? `checkpoint-${String(version).padStart(6, "0")}`;
    await this.verifyCheckpointEventChain(input.program_ref, input.event_refs, input.event_cursor);
    for (const admissionRef of input.admitted_record_refs) await this.requireRecord(input.program_ref, admissionRef, "admitted_product");
    for (const proposalRef of input.unresolved_proposal_refs) await this.requireRecord(input.program_ref, proposalRef, "proposal");
    for (const requiredRef of input.required_record_refs ?? []) await this.requireRecord(input.program_ref, requiredRef);
    const ref = await this.store(
      {
        id,
        program_ref: input.program_ref,
        schema_version: input.schema_version,
        content: {
          version,
          state: input.state,
          event_refs: input.event_refs,
          event_cursor: input.event_cursor,
          admitted_record_refs: input.admitted_record_refs,
          unresolved_proposal_refs: input.unresolved_proposal_refs,
          required_record_refs: input.required_record_refs ?? []
        } satisfies StoredCheckpoint<TProgramState>,
        created_at: input.created_at,
        created_by: input.created_by,
        status: "checkpointed",
        metadata: { ...input.metadata, version }
      },
      "checkpoint"
    );
    const checkpointRef: CheckpointRef = { ...ref, kind: "checkpoint", version };
    await this.writeAtomic(this.pointerPath(input.program_ref), {
      schema_version: "domain.memory_current_checkpoint.v1",
      checkpoint_ref: checkpointRef
    } satisfies CurrentCheckpointPointer);
    return checkpointRef;
  }

  async search(query: MemoryQuery): Promise<MemoryRecordRef[]> {
    if (!query.program_ref) throw new Error("DomainMemory search requires program_ref to preserve Program isolation.");
    assertSafeId(query.program_ref, "Program id");
    return (await this.readManifest(query.program_ref)).records
      .filter((entry) => !query.ids || query.ids.includes(entry.ref.id))
      .filter((entry) => !query.kinds || query.kinds.includes(entry.ref.kind))
      .filter((entry) => !query.statuses || (entry.status !== undefined && query.statuses.includes(entry.status)))
      .filter((entry) => !query.metadata || Object.entries(query.metadata).every(([key, value]) => entry.metadata[key] === value))
      .filter((entry) => !query.source_refs || query.source_refs.every((sourceRef) => entry.source_refs.includes(sourceRef)))
      .sort(stableEntrySort)
      .map((entry) => entry.ref);
  }

  async recover(programId: string): Promise<MemoryRecovery<TProgramState, TNextAction>> {
    assertSafeId(programId, "Program id");
    let pointer: CurrentCheckpointPointer;
    try {
      pointer = JSON.parse(await fs.readFile(this.pointerPath(programId), "utf8")) as CurrentCheckpointPointer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown DomainMemory program ${programId}.`);
      throw error;
    }
    if (pointer.schema_version !== "domain.memory_current_checkpoint.v1" || pointer.checkpoint_ref.program_ref !== programId) {
      throw new Error(`Current checkpoint pointer for ${programId} is invalid.`);
    }
    const checkpointRecord = await this.read(pointer.checkpoint_ref);
    if (checkpointRecord.ref.kind !== "checkpoint") throw new Error(`Current checkpoint for ${programId} is not a checkpoint record.`);
    const checkpoint = checkpointRecord.content as StoredCheckpoint<unknown>;
    if (!checkpoint || !Number.isInteger(checkpoint.version) || !Array.isArray(checkpoint.event_refs) || !(checkpoint.event_cursor === null || typeof checkpoint.event_cursor === "object")) {
      throw new Error(`Checkpoint ${checkpointRecord.ref.id} has invalid content.`);
    }
    const verified = new Set<string>([checkpointRecord.ref.id]);
    const checkpointEventRecords = await this.verifyCheckpointEventChain(programId, checkpoint.event_refs, checkpoint.event_cursor);
    const checkpointEvents = checkpointEventRecords.map((record) => record.content as TProgramEvent);
    const replayedEventRefs = checkpointEventRecords.map((record) => record.ref);
    for (const record of checkpointEventRecords) verified.add(record.ref.id);
    for (const recordId of checkpoint.required_record_refs ?? []) {
      const record = await this.requireRecord(programId, recordId);
      verified.add(record.ref.id);
    }
    const admittedRecords: MemoryRecordRef[] = [];
    for (const recordId of checkpoint.admitted_record_refs ?? []) {
      const record = await this.requireRecord(programId, recordId, "admitted_product");
      await this.verifyAdmission(programId, record);
      admittedRecords.push(record.ref);
      verified.add(record.ref.id);
    }
    const unresolvedProposals: MemoryRecordRef[] = [];
    for (const recordId of checkpoint.unresolved_proposal_refs ?? []) {
      const record = await this.requireRecord(programId, recordId, "proposal");
      unresolvedProposals.push(record.ref);
      verified.add(record.ref.id);
    }
    let recoveredState = this.recoveryPolicy.validateCheckpoint(checkpoint.state, checkpointEvents);
    const allEventRecords = await this.programEventRecords(programId);
    const eventsByOrdinal = new Map<number, StoredMemoryRecord>();
    const cursorOrdinal = checkpoint.event_cursor?.ordinal ?? 0;
    for (const record of allEventRecords) {
      const event = this.eventInput(record);
      const duplicate = eventsByOrdinal.get(event.ordinal);
      if (duplicate && duplicate.ref.id !== record.ref.id) {
        throw new Error(`Program event stream has duplicate ordinal ${event.ordinal}.`);
      }
      eventsByOrdinal.set(event.ordinal, record);
      if (event.ordinal <= cursorOrdinal && checkpoint.event_refs[event.ordinal - 1] !== record.ref.id) {
        throw new Error(`Program event ${record.ref.id} predates or branches away from the checkpoint cursor.`);
      }
    }
    const maximumOrdinal = Math.max(cursorOrdinal, ...eventsByOrdinal.keys());
    let parentEventRef = checkpoint.event_cursor?.event_ref ?? null;
    for (let ordinal = cursorOrdinal + 1; ordinal <= maximumOrdinal; ordinal += 1) {
      const record = eventsByOrdinal.get(ordinal);
      if (!record) throw new Error(`Program event stream has a sequence gap at ordinal ${ordinal}.`);
      const event = this.eventInput(record);
      if (event.parent_event_ref !== parentEventRef) {
        throw new Error(`Program event ${event.id} has a missing parent or branches away from the checkpoint cursor.`);
      }
      recoveredState = this.recoveryPolicy.applyEvent(recoveredState, record.content as TProgramEvent);
      replayedEventRefs.push(record.ref);
      verified.add(record.ref.id);
      parentEventRef = record.ref.id;
    }
    recoveredState = this.recoveryPolicy.validateRecovered(recoveredState);
    return {
      program_id: programId,
      recovered_state: recoveredState,
      checkpoint_ref: { ...pointer.checkpoint_ref, kind: "checkpoint", version: checkpoint.version },
      replayed_event_refs: replayedEventRefs,
      admitted_record_refs: admittedRecords,
      unresolved_proposal_refs: unresolvedProposals,
      historical_provider_calls: this.recoveryPolicy.historicalProviderCalls(recoveredState),
      recovery_provider_calls: 0,
      validation: { status: "valid", verified_record_refs: [...verified].sort() },
      next_action: this.recoveryPolicy.plan(recoveredState)
    };
  }
}
