import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResumeArtifact } from "../types.js";
import { getProjectRoot, toProjectRelative } from "./paths.js";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export async function listResumeArtifacts(root = getProjectRoot()): Promise<ResumeArtifact[]> {
  const dir = path.join(root, "resumes");
  let entries;

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const artifactPath = path.join(dir, entry.name);
        return {
          archetype: entry.name.replace(/\.md$/, ""),
          filename: entry.name,
          path: toProjectRelative(root, artifactPath),
          content: await fs.readFile(artifactPath, "utf8")
        };
      })
  );

  return artifacts.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function getResumeArtifact(archetype: string, root = getProjectRoot()): Promise<ResumeArtifact> {
  const artifacts = await listResumeArtifacts(root);
  const artifact = artifacts.find((item) => item.archetype === archetype);

  if (!artifact) {
    throw new ArtifactError(`Missing resume artifact for archetype "${archetype}" in resumes/.`);
  }

  return artifact;
}
