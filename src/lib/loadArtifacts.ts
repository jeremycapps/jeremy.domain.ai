import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { CachedResumeArtifact } from "../types.js";
import { getProjectRoot, toProjectRelative } from "./paths.js";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

type ManifestEntry = {
  archetype?: string;
  source_path?: string;
  cache_path: string;
};

async function loadCacheManifest(root: string): Promise<ManifestEntry[]> {
  const manifestPath = path.join(root, "data", "cache_manifest.yaml");
  let raw: string;

  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArtifactError("Missing runtime cache manifest: data/cache_manifest.yaml");
    }
    throw error;
  }

  const parsed = parse(raw) as unknown;
  const entries =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { artifacts?: unknown }).artifacts)
      ? (parsed as { artifacts: unknown[] }).artifacts
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { cache_manifest?: unknown }).cache_manifest)
        ? (parsed as { cache_manifest: unknown[] }).cache_manifest
        : null;

  if (entries) {
    return entries.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new ArtifactError(`Cache manifest entry at index ${index} must be an object.`);
      }

      const cachePath = (entry as { cache_path?: unknown }).cache_path;
      if (typeof cachePath !== "string" || cachePath.trim() === "") {
        throw new ArtifactError(`Cache manifest entry at index ${index} is missing cache_path.`);
      }

      const sourcePath = (entry as { source_path?: unknown }).source_path;
      const archetype = (entry as { archetype?: unknown }).archetype;

      return {
        archetype: typeof archetype === "string" ? archetype : undefined,
        source_path: typeof sourcePath === "string" ? sourcePath : undefined,
        cache_path: cachePath
      };
    });
  }

  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([sourcePath, cachePath]) => ({
        source_path: sourcePath,
        cache_path: cachePath as string
      }));
  }

  throw new ArtifactError("data/cache_manifest.yaml must contain artifacts entries or source_path to cache_path mappings.");
}

function archetypeFromCachePath(cachePath: string): string {
  return path.basename(cachePath).replace(/\.(md|markdown|txt)$/i, "");
}

export async function listCachedResumeArtifacts(root = getProjectRoot()): Promise<CachedResumeArtifact[]> {
  const manifest = await loadCacheManifest(root);
  const artifacts = await Promise.all(
    manifest.map(async (entry) => {
      const absoluteCachePath = path.resolve(root, entry.cache_path);
      const relativeCachePath = toProjectRelative(root, absoluteCachePath);

      if (!relativeCachePath.startsWith("cache/")) {
        throw new ArtifactError(`Runtime cache entry must point inside cache/: ${entry.cache_path}`);
      }

      return {
        archetype: entry.archetype ?? archetypeFromCachePath(entry.cache_path),
        filename: path.basename(entry.cache_path),
        cache_path: relativeCachePath,
        source_path: entry.source_path,
        content: await fs.readFile(absoluteCachePath, "utf8")
      };
    })
  );

  return artifacts.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function getCachedResumeArtifact(archetype: string, root = getProjectRoot()): Promise<CachedResumeArtifact> {
  const artifacts = await listCachedResumeArtifacts(root);
  const artifact = artifacts.find((item) => item.archetype === archetype);

  if (!artifact) {
    throw new ArtifactError(`Missing cached resume artifact for archetype "${archetype}" in cache manifest.`);
  }

  return artifact;
}
