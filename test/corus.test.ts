import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentProvider,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../src/types.js";
import { createServer } from "../src/server.js";
import { evaluateCapabilityRun, classifyHallucinations, runProphetFixtureEvaluation } from "../src/lib/corusEvaluation.js";
import { runCapabilityAnalysis, structuredProviderError } from "../src/lib/corusOrchestrator.js";
import { validateProjectionNoInvention } from "../src/lib/corusProjection.js";
import { providerReadiness } from "../src/providers/liveProviders.js";
import { MockCapabilityReductionProvider, MockContextualizationProvider, MockValidationProvider } from "../src/providers/mockProviders.js";
import { ProviderExecutionError } from "../src/providers/errors.js";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "corus-test-"));
}

function source(kind: "subject" | "target") {
  return {
    meta: {
      subject: {
        id: kind === "subject" ? "jeremy" : "prophet_role",
        name: kind === "subject" ? "Jeremy" : undefined,
        role: kind === "target" ? "Senior Product Manager" : undefined
      }
    },
    contexts:
      kind === "subject"
        ? [
            {
              id: "evidence_product_execution",
              direction: "demonstrated",
              skill: { value: "Product execution" }
            }
          ]
        : [
            {
              id: "requirement_product_execution",
              direction: "requested",
              skill: { value: "Own product execution" }
            }
          ]
  };
}

function metrics() {
  return { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 1 };
}

function providerResult<T>(output: T, provider = "test", model = "test-model", prompt = "test.v1"): ProviderResult<T> {
  return { output, provider, model, prompt_version: prompt, metrics: metrics() };
}

class SequenceValidationProvider implements AgentProvider<ValidateCapabilitiesInput, CapabilityValidation> {
  public calls = 0;
  constructor(private readonly validations: CapabilityValidation[]) {}
  async execute(): Promise<ProviderResult<CapabilityValidation>> {
    const output = this.validations[Math.min(this.calls, this.validations.length - 1)];
    this.calls += 1;
    return providerResult(output, "openai", "mock-openai-validator", "validate.sequence.v1");
  }
}

class FixedReductionProvider implements AgentProvider<ReduceCapabilitiesInput, CapabilityReduction> {
  public calls: ReduceCapabilitiesInput[] = [];
  async execute(input: ReduceCapabilitiesInput): Promise<ProviderResult<CapabilityReduction>> {
    this.calls.push(input);
    const capabilities = input.revision_findings
      ? [
          {
            id: "cap_supported",
            requirement_ref: "requirement_product_execution",
            statement: "Supported product execution capability.",
            evidence_refs: ["evidence_product_execution"],
            support: "supported" as const,
            confidence: "high" as const,
            generated_by: { provider: "anthropic", model: "mock", prompt_version: "reduce.test.v1" }
          }
        ]
      : [
          {
            id: "cap_supported",
            requirement_ref: "requirement_product_execution",
            statement: "Supported product execution capability.",
            evidence_refs: ["evidence_product_execution"],
            support: "supported" as const,
            confidence: "high" as const,
            generated_by: { provider: "anthropic", model: "mock", prompt_version: "reduce.test.v1" }
          },
          {
            id: "cap_unsupported",
            requirement_ref: "requirement_product_execution",
            statement: "Unsupported claim.",
            evidence_refs: ["missing_evidence"],
            support: "unsupported" as const,
            confidence: "low" as const,
            generated_by: { provider: "anthropic", model: "mock", prompt_version: "reduce.test.v1" }
          }
        ];

    return providerResult({
      reducer: "capabilities",
      inputs: { subject: input.contexts.subject.id, target: input.contexts.target.id },
      capabilities
    }, "anthropic", "mock-claude", "reduce.test.v1");
  }
}

class FailingContextualizer implements AgentProvider<ContextualizeInput, Context> {
  async execute(): Promise<ProviderResult<Context>> {
    throw new ProviderExecutionError("google", "Gemini failed without exposing authorization headers.");
  }
}

test("both subject and target load through the same Context shape", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root });
  assert.equal(run.contexts.subject.kind, "subject");
  assert.equal(run.contexts.target.kind, "target");
  assert.ok("content" in run.contexts.subject);
  assert.ok("content" in run.contexts.target);
});

test("the capabilities reducer receives both named context positions", async () => {
  const root = await tempRoot();
  const reducer = new MockCapabilityReductionProvider();
  await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    { root, providers: { contextualizer: new MockContextualizationProvider(), reducer, validator: new MockValidationProvider() } }
  );
  assert.equal(reducer.calls[0].contexts.subject.kind, "subject");
  assert.equal(reducer.calls[0].contexts.target.kind, "target");
});

test("every supported capability contains resolvable evidence references", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root });
  const subjectRefs = new Set((run.contexts.subject.content.contexts as Array<{ id: string }>).map((entry) => entry.id));
  for (const capability of run.capabilities.filter((item) => item.support === "supported")) {
    assert.ok(capability.evidence_refs.length > 0);
    assert.ok(capability.evidence_refs.every((ref) => subjectRefs.has(ref)));
  }
});

test("unsupported capabilities cannot pass validation", async () => {
  const validator = new MockValidationProvider();
  const result = await validator.execute({
    capabilities: [
      {
        id: "bad",
        requirement_ref: "requirement_product_execution",
        statement: "Bad",
        evidence_refs: ["evidence_product_execution"],
        support: "unsupported",
        confidence: "low",
        generated_by: { provider: "anthropic", model: "mock", prompt_version: "x" }
      }
    ],
    contexts: {
      subject: (await new MockContextualizationProvider().execute({ source: source("subject"), kind: "subject", position: "subject", input_ref: "s" })).output,
      target: (await new MockContextualizationProvider().execute({ source: source("target"), kind: "target", position: "target", input_ref: "t" })).output
    }
  });
  assert.equal(result.output.status, "failed");
});

test("a revise result invokes Claude revision no more than once", async () => {
  const root = await tempRoot();
  const reducer = new FixedReductionProvider();
  const validator = new SequenceValidationProvider([
    {
      status: "revise",
      findings: [{ severity: "error", type: "correctable_content", message: "Remove unsupported claim." }],
      validated_capability_ids: [],
      rejected_capability_ids: ["cap_unsupported"]
    },
    {
      status: "passed",
      findings: [],
      validated_capability_ids: ["cap_supported"],
      rejected_capability_ids: []
    }
  ]);
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    { root, providers: { contextualizer: new MockContextualizationProvider(), reducer, validator } }
  );
  assert.equal(run.status, "passed");
  assert.equal(reducer.calls.length, 2);
  assert.equal(validator.calls, 2);
});

test("architect_required stops execution and returns an escalation", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    {
      root,
      providers: {
        contextualizer: new MockContextualizationProvider(),
        reducer: new MockCapabilityReductionProvider(),
        validator: new MockValidationProvider({
          status: "architect_required",
          findings: [{ severity: "error", type: "product_ambiguity", message: "Schema meaning is ambiguous." }],
          validated_capability_ids: [],
          rejected_capability_ids: []
        })
      }
    }
  );
  assert.equal(run.status, "architect_required");
  assert.equal(run.projection, null);
});

test("projection receives only validated capabilities", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    {
      root,
      providers: {
        contextualizer: new MockContextualizationProvider(),
        reducer: new FixedReductionProvider(),
        validator: new MockValidationProvider({
          status: "passed",
          findings: [],
          validated_capability_ids: ["cap_supported"],
          rejected_capability_ids: ["cap_unsupported"]
        })
      }
    }
  );
  assert.deepEqual(run.projection?.capability_ids, ["cap_supported"]);
});

test("projection cannot add an unsupported claim", () => {
  const invented = validateProjectionNoInvention(
    { kind: "capability_assessment", format: "markdown", content: "", capability_ids: ["cap_supported", "cap_bad"] },
    { status: "passed", findings: [], validated_capability_ids: ["cap_supported"], rejected_capability_ids: ["cap_bad"] }
  );
  assert.deepEqual(invented, ["cap_bad"]);
});

test("every stage writes a generation record", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root });
  assert.ok(run.generation_records.some((record) => record.type === "contextualization"));
  assert.ok(run.generation_records.some((record) => record.type === "capability_reduction"));
  assert.ok(run.generation_records.some((record) => record.type === "capability_validation"));
  assert.ok(run.generation_records.some((record) => record.type === "projection"));
  await fs.access(path.join(root, run.artifact_dir, "generation-records.json"));
});

test("provider failures return structured errors without secrets", async () => {
  let caught: unknown;
  try {
    await runCapabilityAnalysis(
        { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
        {
          root: os.tmpdir(),
          providers: {
            contextualizer: new FailingContextualizer(),
            reducer: new MockCapabilityReductionProvider(),
            validator: new MockValidationProvider()
          }
        }
      );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProviderExecutionError);
  const structured = structuredProviderError(caught);
  assert.equal(structured.provider, "google");
  assert.equal(JSON.stringify(structured).includes("Bearer"), false);
});

test("the existing health check continues to pass", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const body = await new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}/health`, (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => resolve(data));
    }).on("error", reject);
  });
  server.close();
  assert.equal(JSON.parse(body).status, "ok");
});

test("same mocked inputs produce structurally equivalent outputs", async () => {
  const first = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const second = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  assert.deepEqual(first.capabilities.map((capability) => capability.id), second.capabilities.map((capability) => capability.id));
  assert.equal(first.status, second.status);
});

test("golden evaluation classifies semantic matches without exact wording", async () => {
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const report = evaluateCapabilityRun({
    run,
    fixture: "unit",
    baselineRef: "baseline.yaml",
    baseline: { capabilities: [{ id: "baseline_execution", label: "Product Execution", definition: "Translate product ambition into shipped testable capability" }] }
  });
  assert.ok(report.evaluation.differences.some((difference) => difference.type === "wording_only" || difference.type === "semantic_match"));
});

test("generated supported discovery is distinguished from unsupported addition", async () => {
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const report = evaluateCapabilityRun({ run, fixture: "unit", baselineRef: "baseline.yaml", baseline: { capabilities: [] } });
  assert.ok(report.evaluation.differences.some((difference) => difference.type === "supported_new_discovery"));
});

test("cross-context leakage and fabricated evidence references are detected", () => {
  const hallucinations = classifyHallucinations({
    generated: [
      {
        id: "bad",
        requirement_ref: "missing_requirement",
        statement: "Bad",
        evidence_refs: ["requirement_product_execution", "missing_evidence"],
        support: "supported",
        confidence: "medium",
        generated_by: { provider: "anthropic", model: "mock", prompt_version: "x" }
      }
    ],
    validation: { status: "failed", findings: [], validated_capability_ids: [], rejected_capability_ids: ["bad"] },
    subjectEvidenceRefs: new Set(["evidence_product_execution"]),
    targetRequirementRefs: new Set(["requirement_product_execution"]),
    projectionCapabilityIds: []
  });
  assert.ok(hallucinations.some((item) => item.type === "cross_context_leakage"));
  assert.ok(hallucinations.some((item) => item.type === "fabricated_evidence_reference"));
});

test("efficiency metrics do not substitute for quality scores", async () => {
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const report = evaluateCapabilityRun({ run, fixture: "unit", baselineRef: "baseline.yaml", baseline: { capabilities: [] } });
  assert.equal(typeof report.evaluation.quality.requirement_coverage, "number");
  assert.equal(typeof report.evaluation.efficiency.model_calls, "number");
});

test("missing provider credentials produce an explicit readiness result", () => {
  const previous = [process.env.GEMINI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY];
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const readiness = providerReadiness("live");
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing_credentials, ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  [process.env.GEMINI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY] = previous;
});

test("fixture and mocked runs are never labeled as live runs", async () => {
  const mocked = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const fixture = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "fixture" }, { root: await tempRoot() });
  assert.equal(mocked.mode, "mocked");
  assert.equal(fixture.mode, "fixture");
});

test("Prophet fixture can produce a baseline comparison report without live credentials", async () => {
  const report = await runProphetFixtureEvaluation(process.cwd());
  assert.equal(report.evaluation.fixture, "prophet");
  assert.equal(typeof report.evaluation.quality.capability_recall, "number");
});
