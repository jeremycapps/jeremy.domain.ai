import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Archetype, GenerationRecord, ValidationStatus } from "../types.js";
import { getProjectRoot, toProjectRelative } from "./paths.js";

interface WriteGenerationRecordInput {
  requestId: string;
  jobDescription: string;
  archetype: Archetype;
  selectedFiles: string[];
  selectedCacheFiles: string[];
  selectedSourceFiles: string[];
  selectedExperienceUnits: string[];
  resumeMarkdown: string;
  validationStatus: ValidationStatus;
}

export async function writeGenerationRecord(
  input: WriteGenerationRecordInput,
  root = getProjectRoot()
): Promise<GenerationRecord> {
  const outputsDir = path.join(root, "outputs");
  await fs.mkdir(outputsDir, { recursive: true });

  const id = input.requestId || randomUUID();
  const createdAt = new Date().toISOString();
  const outputPath = path.join(outputsDir, `${id}.md`);
  const recordPath = path.join(outputsDir, `${id}.json`);

  await fs.writeFile(outputPath, input.resumeMarkdown, "utf8");

  const record: GenerationRecord = {
    id,
    created_at: createdAt,
    job_description_hash: createHash("sha256").update(input.jobDescription).digest("hex"),
    archetype: input.archetype,
    selected_files: input.selectedFiles,
    cache_path: input.selectedCacheFiles[0],
    source_path: input.selectedSourceFiles[0],
    selected_cache_files: input.selectedCacheFiles,
    selected_source_files: input.selectedSourceFiles,
    selected_experience_units: input.selectedExperienceUnits,
    output_file: toProjectRelative(root, outputPath),
    validation_status: input.validationStatus,
    may_use_as: ["draft_base", "style_reference", "structure_reference"],
    may_not_use_as: ["source_truth", "new_experience_evidence"]
  };

  await fs.writeFile(recordPath, `${JSON.stringify({ resume_generation: record }, null, 2)}\n`, "utf8");
  return record;
}
