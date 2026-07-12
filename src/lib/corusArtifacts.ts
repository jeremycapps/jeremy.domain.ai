import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import type { ProviderMetrics, StageGenerationRecord } from "../types.js";
import { getProjectRoot, toProjectRelative } from "./paths.js";

export async function createRunDirectory(runId: string, root = getProjectRoot()): Promise<string> {
  const outputDir = path.join(root, "outputs", runId);
  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
}

export async function writeYamlArtifact(outputDir: string, filename: string, value: unknown): Promise<string> {
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, stringify(value), "utf8");
  return filePath;
}

export async function writeMarkdownArtifact(outputDir: string, filename: string, content: string): Promise<string> {
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export function stageRecord(input: {
  type: StageGenerationRecord["type"];
  input_refs: string[];
  output_ref: string;
  provider: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  validation_status: string;
  metrics: ProviderMetrics;
}): StageGenerationRecord {
  return {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    ...input
  };
}

export async function writeGenerationRecords(outputDir: string, records: StageGenerationRecord[]): Promise<string> {
  const filePath = path.join(outputDir, "generation-records.json");
  await fs.writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return filePath;
}

export function artifactRef(root: string, filePath: string): string {
  return toProjectRelative(root, filePath);
}
