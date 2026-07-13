import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Context, ContextPosition } from "../types.js";

export function structuredContextLedgerContextIds(source: unknown): string[] {
  if (!source || typeof source !== "object") return [];
  const record = source as Record<string, unknown>;
  const meta = record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : {};
  if (meta.file_type !== "corus_context_ledger") return [];
  const contexts = record.contexts;
  if (!Array.isArray(contexts)) return [];
  const ids: string[] = [];
  for (const context of contexts) {
    if (context && typeof context === "object" && typeof (context as { id?: unknown }).id === "string") {
      ids.push((context as { id: string }).id);
    }
  }
  return ids;
}

export function isStructuredContextLedger(source: unknown): boolean {
  return structuredContextLedgerContextIds(source).length > 0;
}

export function sourceRefFromInput(source: unknown, fallback: string): string {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    const maybePath = (source as { path?: unknown }).path;
    const maybeId = (source as { id?: unknown }).id;
    if (typeof maybePath === "string") return maybePath;
    if (typeof maybeId === "string") return maybeId;
  }
  return fallback;
}

export async function readSourceInput(source: unknown, root: string): Promise<unknown> {
  if (typeof source !== "string") return source;

  const sourcePath = path.isAbsolute(source) ? source : path.join(root, source);
  const raw = await fs.readFile(sourcePath, "utf8");
  if (sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml")) {
    return parse(raw);
  }

  return raw;
}

export function normalizeContext(source: unknown, kind: string, position: ContextPosition, inputRef: string): Context {
  const now = new Date().toISOString();

  if (source && typeof source === "object" && "context" in source) {
    return normalizeContext((source as { context: unknown }).context, kind, position, inputRef);
  }

  if (source && typeof source === "object" && "id" in source && "content" in source) {
    const candidate = source as Partial<Context>;
    return {
      id: String(candidate.id),
      kind: candidate.kind ?? kind,
      label: candidate.label ?? String(candidate.id),
      sources: candidate.sources ?? [inputRef],
      content: candidate.content ?? {},
      generation: candidate.generation ?? {
        operation: "contextualize",
        provider: "fixture",
        model: "fixture",
        prompt_version: "fixture.v1",
        input_refs: [inputRef],
        schema_version: "corus.context.v1",
        created_at: now
      }
    };
  }

  const ledger = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const sourceContextCount = structuredContextLedgerContextIds(ledger).length;
  const meta = ledger.meta && typeof ledger.meta === "object" ? (ledger.meta as Record<string, unknown>) : {};
  const subject = meta.subject && typeof meta.subject === "object" ? (meta.subject as Record<string, unknown>) : {};
  const id = String(subject.id ?? meta.id ?? `${position}_${kind}`);
  const label = String(subject.name ?? subject.role ?? subject.company ?? id);

  return {
    id,
    kind,
    label,
    sources: [inputRef],
    content: ledger,
    generation: {
      operation: "contextualize",
      provider: "fixture",
      model: "fixture",
      prompt_version: "fixture.v1",
      input_refs: [inputRef],
      schema_version: "corus.context.v1",
      created_at: now,
      ...(sourceContextCount > 0
        ? {
            source_context_count: sourceContextCount,
            output_context_count: sourceContextCount,
            measurement_source: "local_preservation" as const
          }
        : {})
    }
  };
}

export function contextRefs(context: Context): Set<string> {
  const refs = new Set<string>();
  const contexts = context.content.contexts;
  if (Array.isArray(contexts)) {
    for (const entry of contexts) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
        refs.add((entry as { id: string }).id);
      }
    }
  }
  return refs;
}
