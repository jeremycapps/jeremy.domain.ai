import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { handleGenerateResume } from "../src/routes/generateResume.js";

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resume-router-"));
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.mkdir(path.join(root, "source_artifacts"), { recursive: true });
  await fs.mkdir(path.join(root, "cache"), { recursive: true });
  await fs.mkdir(path.join(root, "routes"), { recursive: true });
  await fs.writeFile(
    path.join(root, "data", "experience_units.yaml"),
    [
      "experience_units:",
      "  - id: eu_ai_strategy",
      "    title: AI product strategy work",
      "    employer: Jeremy Domain",
      "    role: Product strategist",
      "    dates: 2024",
      "    tags: [ai, strategy, product]",
      "    tools: [market intelligence]",
      "    bullets:",
      "      - Built market intelligence workflows for AI product decisions.",
      "  - id: eu_operations",
      "    title: Technical operations work",
      "    employer: Jeremy Domain",
      "    role: Technical operator",
      "    dates: 2023",
      "    tags: [operations, systems, automation]",
      "    tools: [automation]",
      "    bullets:",
      "      - Improved systems operations workflows."
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "source_artifacts", "ai_product_strategy.docx"),
    "original ai product strategy docx bytes",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "source_artifacts", "technical_operations.pdf"),
    "original technical operations pdf bytes",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "cache", "ai_product_strategy.md"),
    "# AI Product Strategy Resume\n\nEvidence IDs: eu_ai_strategy\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "cache", "technical_operations.md"),
    "# Technical Operations Resume\n\nEvidence IDs: eu_operations\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "data", "cache_manifest.yaml"),
    [
      "artifacts:",
      "  - archetype: ai_product_strategy",
      "    source_path: source_artifacts/ai_product_strategy.docx",
      "    cache_path: cache/ai_product_strategy.md",
      "  - archetype: technical_operations",
      "    source_path: source_artifacts/technical_operations.pdf",
      "    cache_path: cache/technical_operations.md"
    ].join("\n"),
    "utf8"
  );
  return root;
}

async function sha256(filePath: string) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

test("route_only request returns route, evidence, validation, and derivative generation record without model key", async () => {
  const root = await fixtureRoot();
  const sourcePath = path.join(root, "data", "experience_units.yaml");
  const sourceArtifactPath = path.join(root, "source_artifacts", "ai_product_strategy.docx");
  const beforeHash = await sha256(sourcePath);
  const beforeSourceArtifactHash = await sha256(sourceArtifactPath);
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const response = await handleGenerateResume(
      {
        job_description: "Need AI strategy and market intelligence product work.",
        options: { mode: "route_only", use_cache: true }
      },
      root
    );

    assert.equal(response.status, "ok");
    assert.equal(response.route_decision.archetype, "ai_product_strategy");
    assert.match(response.route_decision.confidence, /high|medium/);
    assert.deepEqual(response.selected_context.files, ["cache/ai_product_strategy.md"]);
    assert.deepEqual(response.selected_context.cache_files, ["cache/ai_product_strategy.md"]);
    assert.deepEqual(response.selected_context.source_files, ["source_artifacts/ai_product_strategy.docx"]);
    assert.deepEqual(response.selected_context.experience_unit_ids, ["eu_ai_strategy"]);
    assert.equal(response.resume.format, "markdown");
    assert.equal(response.evidence_report.supported_claims.length, 1);
    assert.equal(response.validation_report.status, "passed");
    assert.equal(response.generation_record.may_not_use_as.includes("source_truth"), true);
    assert.equal(response.generation_record.may_not_use_as.includes("new_experience_evidence"), true);
    assert.equal(response.generation_record.cache_path, "cache/ai_product_strategy.md");
    assert.equal(response.generation_record.source_path, "source_artifacts/ai_product_strategy.docx");
    assert.equal(await sha256(sourcePath), beforeHash);
    assert.equal(await sha256(sourceArtifactPath), beforeSourceArtifactHash);
  } finally {
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  }
});

test("missing experience_units.yaml fails clearly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resume-router-missing-"));
  await assert.rejects(
    () =>
      handleGenerateResume(
        {
          job_description: "Need product operations support.",
          options: { mode: "route_only" }
        },
        root
      ),
    /Missing required source truth file: data\/experience_units.yaml/
  );
});

test("short job description routes to low-confidence general operator without crashing", async () => {
  const root = await fixtureRoot();
  const response = await handleGenerateResume(
    {
      job_description: "Help.",
      options: { mode: "route_only" }
    },
    root
  );

  assert.equal(response.status, "ok");
  assert.equal(response.route_decision.archetype, "general_operator");
  assert.equal(response.route_decision.confidence, "low");
  assert.equal(response.selected_context.used_full_context, true);
});

test("generate mode returns a clear model-key error when no key is present", async () => {
  const root = await fixtureRoot();
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    await assert.rejects(
      () =>
        handleGenerateResume(
          {
            job_description: "Need systems operations and automation work.",
            options: { mode: "generate" }
          },
          root
        ),
      /OPENAI_API_KEY is required for generate mode/
    );
  } finally {
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  }
});
