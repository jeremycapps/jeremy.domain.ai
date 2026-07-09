import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { ExperienceUnit, FileInventory } from "../types.js";
import { getProjectRoot, toProjectRelative } from "./paths.js";

export class SourceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceContextError";
  }
}

async function listFilesIfDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function inventoryExistingFiles(root = getProjectRoot()): Promise<FileInventory> {
  const dataFiles = await listFilesIfDir(path.join(root, "data"));
  const resumeFiles = await listFilesIfDir(path.join(root, "resumes"));
  const routeFiles = await listFilesIfDir(path.join(root, "routes"));
  const required = path.join(root, "data", "experience_units.yaml");
  const missing_required: string[] = [];

  try {
    await fs.access(required);
  } catch {
    missing_required.push("data/experience_units.yaml");
  }

  return {
    data_files: dataFiles.map((file) => toProjectRelative(root, file)),
    resume_files: resumeFiles.map((file) => toProjectRelative(root, file)),
    route_files: routeFiles.map((file) => toProjectRelative(root, file)),
    missing_required
  };
}

function normalizeUnits(parsed: unknown): ExperienceUnit[] {
  const candidate =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { experience_units?: unknown }).experience_units)
        ? (parsed as { experience_units: unknown[] }).experience_units
        : null;

  if (!candidate) {
    throw new SourceContextError("data/experience_units.yaml must contain a YAML list or an experience_units list.");
  }

  return candidate.map((unit, index) => {
    if (!unit || typeof unit !== "object") {
      throw new SourceContextError(`Experience unit at index ${index} must be an object.`);
    }

    const id = (unit as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new SourceContextError(`Experience unit at index ${index} is missing a string id.`);
    }

    return unit as ExperienceUnit;
  });
}

export async function getAllExperienceUnits(root = getProjectRoot()): Promise<ExperienceUnit[]> {
  const filePath = path.join(root, "data", "experience_units.yaml");
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourceContextError("Missing required source truth file: data/experience_units.yaml");
    }
    throw error;
  }

  try {
    return normalizeUnits(parse(raw));
  } catch (error) {
    if (error instanceof SourceContextError) throw error;
    throw new SourceContextError(`Unable to parse data/experience_units.yaml: ${(error as Error).message}`);
  }
}

export async function getExperienceUnitsById(ids: string[], root = getProjectRoot()): Promise<ExperienceUnit[]> {
  const units = await getAllExperienceUnits(root);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const missing = ids.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw new SourceContextError(`Experience unit ids not found: ${missing.join(", ")}`);
  }

  return ids.map((id) => byId.get(id)!);
}
