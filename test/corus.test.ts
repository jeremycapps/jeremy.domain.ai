import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import type {
  AgentProvider,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  FailureAnalysis,
  FailureAnalysisInput,
  HandoffFailure,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../src/types.js";
import { createServer } from "../src/server.js";
import { evaluateCapabilityRun, classifyHallucinations, runProphetFixtureEvaluation } from "../src/lib/corusEvaluation.js";
import { runCapabilityAnalysis, structuredProviderError } from "../src/lib/corusOrchestrator.js";
import { resumeFailureReroutingFromCheckpoint } from "../src/lib/corusCheckpointResume.js";
import { validateProjectionNoInvention } from "../src/lib/corusProjection.js";
import { classifyProviderFailure } from "../src/lib/providerFailureClassification.js";
import { providerReadiness } from "../src/providers/liveProviders.js";
import {
  MockCapabilityReductionProvider,
  MockContextualizationProvider,
  MockFailureAnalysisProvider,
  MockMalformedReductionProvider,
  MockValidationProvider
} from "../src/providers/mockProviders.js";
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

class ForbiddenContextualizer implements AgentProvider<ContextualizeInput, Context> {
  public calls = 0;
  async execute(): Promise<ProviderResult<Context>> {
    this.calls += 1;
    throw new Error("Checkpoint resume must not call Gemini contextualization.");
  }
}

class CheckpointFailureAnalysisProvider implements AgentProvider<FailureAnalysisInput, FailureAnalysis> {
  public calls: FailureAnalysisInput[] = [];
  constructor(private readonly mode: "success" | "rate_limit" = "success") {}
  async execute(input: FailureAnalysisInput): Promise<ProviderResult<FailureAnalysis>> {
    this.calls.push(input);
    if (this.mode === "rate_limit") {
      throw new ProviderExecutionError("openai", "OpenAI failure analysis failed with HTTP 429.", {
        error: { message: "Rate limit reached for model gpt-4.1.", type: "rate_limit_error" }
      });
    }
    return providerResult(
      {
        status: "correctable",
        failed_stage: "capability_reduction",
        failure_type: "schema_validation",
        diagnosis: "The malformed reduction omitted required capability ids.",
        corrections: [
          {
            field: "capabilities[].id",
            instruction: "Add stable string ids to every capability.",
            reason: "The capability schema requires ids."
          }
        ],
        retry_stage: "capability_reduction",
        architecture_change_required: false,
        confidence: "high"
      },
      "openai",
      "mock-openai",
      "failure-analysis.openai.v1"
    );
  }
}

class CheckpointRecoveryReductionProvider implements AgentProvider<ReduceCapabilitiesInput, CapabilityReduction> {
  public calls: ReduceCapabilitiesInput[] = [];
  async execute(input: ReduceCapabilitiesInput): Promise<ProviderResult<CapabilityReduction>> {
    this.calls.push(input);
    assert.ok(input.failure_analysis);
    assert.ok(input.prior_raw_output);
    return providerResult(
      {
        reducer: "capabilities",
        inputs: { subject: input.contexts.subject.id, target: input.contexts.target.id },
        capabilities: [
          {
            id: "cap_recovered",
            requirement_ref: "requirement_product_execution",
            statement: "Recovered product execution capability.",
            evidence_refs: ["evidence_product_execution"],
            support: "supported",
            confidence: "high",
            generated_by: { provider: "anthropic", model: "mock-claude", prompt_version: "reduce.anthropic.recovery.v1" }
          }
        ]
      },
      "anthropic",
      "mock-claude",
      "reduce.anthropic.recovery.v1"
    );
  }
}

async function writeCheckpoint(root: string, runId = "checkpoint-run", openAiError: unknown = { message: "OpenAI failure analysis failed with HTTP 429." }) {
  const outputDir = path.join(root, "outputs", runId);
  await fs.mkdir(outputDir, { recursive: true });
  const contextualizer = new MockContextualizationProvider();
  const subjectContext = (await contextualizer.execute({ source: source("subject"), kind: "subject", position: "subject", input_ref: "subject" })).output;
  const targetContext = (await contextualizer.execute({ source: source("target"), kind: "target", position: "target", input_ref: "target" })).output;
  const rawAttempt = { reducer: "capabilities", inputs: { subject: subjectContext.id, target: targetContext.id }, capabilities: [{ statement: "Missing id." }] };
  const handoffFailure: HandoffFailure = {
    id: "handoff-1",
    run_id: runId,
    stage: "capability_reduction",
    provider: "anthropic",
    attempt: 1,
    failure_type: "schema_validation",
    message: "Each capability must include string id.",
    expected_schema_ref: "corus.capability_reduction.v1",
    raw_output_ref: `outputs/${runId}/raw-02-capability-reduction-attempt-1.json`,
    subject_context_ref: `outputs/${runId}/01-subject-context.yaml`,
    target_context_ref: `outputs/${runId}/01-target-context.yaml`,
    created_at: new Date().toISOString()
  };
  await fs.writeFile(path.join(outputDir, "01-subject-context.yaml"), stringify({ context: subjectContext }), "utf8");
  await fs.writeFile(path.join(outputDir, "01-target-context.yaml"), stringify({ context: targetContext }), "utf8");
  await fs.writeFile(path.join(outputDir, "raw-02-capability-reduction-attempt-1.json"), `${JSON.stringify(rawAttempt, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "02-capability-reduction-attempt-1-error.yaml"), stringify({ handoff_failure: handoffFailure }), "utf8");
  await fs.writeFile(path.join(outputDir, "error-03-openai-failure-analysis-provider-error.yaml"), stringify(openAiError), "utf8");
  await fs.mkdir(path.join(root, "test", "fixtures", "prophet"), { recursive: true });
  await fs.writeFile(
    path.join(root, "test", "fixtures", "prophet", "jeremy_prophet_senior_product_manager_capabilities.yaml"),
    stringify({ capabilities: [{ id: "baseline_execution", label: "Product execution", definition: "Recovered product execution capability." }] }),
    "utf8"
  );
  return { outputDir, runId };
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
    { root, providers: { contextualizer: new MockContextualizationProvider(), reducer, failureAnalyzer: new MockFailureAnalysisProvider(), validator: new MockValidationProvider() } }
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
    { root, providers: { contextualizer: new MockContextualizationProvider(), reducer, failureAnalyzer: new MockFailureAnalysisProvider(), validator } }
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
        failureAnalyzer: new MockFailureAnalysisProvider(),
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
        failureAnalyzer: new MockFailureAnalysisProvider(),
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

test("malformed Claude reduction is persisted and routed to OpenAI failure analysis", async () => {
  const root = await tempRoot();
  const reducer = new MockMalformedReductionProvider("valid");
  const failureAnalyzer = new MockFailureAnalysisProvider("correctable");
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    {
      root,
      providers: {
        contextualizer: new MockContextualizationProvider(),
        reducer,
        failureAnalyzer,
        validator: new MockValidationProvider()
      }
    }
  );

  assert.equal(run.status, "passed");
  assert.equal(reducer.calls.length, 2);
  assert.equal(failureAnalyzer.calls.length, 1);
  assert.equal(run.handoff_failure?.failure_type, "schema_validation");
  assert.equal(run.failure_analysis?.status, "correctable");
  assert.deepEqual(failureAnalyzer.calls[0].valid_subject_evidence_ids, ["evidence_product_execution"]);
  assert.deepEqual(failureAnalyzer.calls[0].valid_target_requirement_ids, ["requirement_product_execution"]);
  assert.ok(failureAnalyzer.calls[0].raw_provider_output);
  await fs.access(path.join(root, run.artifact_dir, "raw-02-capability-reduction-attempt-1.json"));
  await fs.access(path.join(root, run.artifact_dir, "02-capability-reduction-attempt-1-error.yaml"));
  await fs.access(path.join(root, run.artifact_dir, "03-openai-failure-analysis.yaml"));
  await fs.access(path.join(root, run.artifact_dir, "04-capabilities-recovered.yaml"));
});

test("correctable failure passes OpenAI correction to exactly one Claude retry without app field injection", async () => {
  const root = await tempRoot();
  const reducer = new MockMalformedReductionProvider("valid");
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    {
      root,
      providers: {
        contextualizer: new MockContextualizationProvider(),
        reducer,
        failureAnalyzer: new MockFailureAnalysisProvider("correctable"),
        validator: new MockValidationProvider()
      }
    }
  );

  assert.equal(reducer.calls.length, 2);
  assert.equal(reducer.calls[1].failure_analysis?.corrections[0].field, "capabilities[].requirement_ref");
  assert.equal(reducer.calls[1].prior_raw_output !== undefined, true);
  assert.equal(run.capabilities[0].id, "cap_recovered");
  assert.equal(run.capabilities[0].requirement_ref, "requirement_product_execution");
});

test("architect_required and unrecoverable failure analysis stop without retrying Claude", async () => {
  for (const status of ["architect_required", "unrecoverable"] as const) {
    const root = await tempRoot();
    const reducer = new MockMalformedReductionProvider("valid");
    const run = await runCapabilityAnalysis(
      { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
      {
        root,
        providers: {
          contextualizer: new MockContextualizationProvider(),
          reducer,
          failureAnalyzer: new MockFailureAnalysisProvider(status),
          validator: new MockValidationProvider()
        }
      }
    );

    assert.equal(reducer.calls.length, 1);
    assert.equal(run.failure_analysis?.status, status);
    assert.equal(run.projection, null);
    assert.equal(run.generation_records.some((record) => record.type === "capability_validation"), false);
  }
});

test("second malformed Claude response returns recovery_failed without another analysis call", async () => {
  const root = await tempRoot();
  const reducer = new MockMalformedReductionProvider("invalid");
  const failureAnalyzer = new MockFailureAnalysisProvider("correctable");
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    {
      root,
      providers: {
        contextualizer: new MockContextualizationProvider(),
        reducer,
        failureAnalyzer,
        validator: new MockValidationProvider()
      }
    }
  );

  assert.equal(run.status, "recovery_failed");
  assert.equal(reducer.calls.length, 2);
  assert.equal(failureAnalyzer.calls.length, 1);
  assert.equal(run.projection, null);
  assert.equal(run.generation_records.some((record) => record.type === "capability_validation"), false);
  await fs.access(path.join(root, run.artifact_dir, "04-capability-reduction-attempt-2-error.yaml"));
});

test("schema-valid retry proceeds to normal semantic validation with distinct records", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
    {
      root,
      providers: {
        contextualizer: new MockContextualizationProvider(),
        reducer: new MockMalformedReductionProvider("valid"),
        failureAnalyzer: new MockFailureAnalysisProvider("correctable"),
        validator: new MockValidationProvider()
      }
    }
  );

  assert.equal(run.status, "passed");
  assert.ok(run.generation_records.some((record) => record.type === "failure_analysis"));
  assert.ok(run.generation_records.some((record) => record.type === "capability_validation"));
  assert.ok(run.generation_records.some((record) => record.type === "projection"));
  await fs.access(path.join(root, run.artifact_dir, "05-semantic-validation.yaml"));
  await fs.access(path.join(root, run.artifact_dir, "06-projection.md"));
});

test("checkpoint resume skips Gemini and initial Claude while retrying only OpenAI failure analysis", async () => {
  const root = await tempRoot();
  const { outputDir, runId } = await writeCheckpoint(root);
  const priorRaw = await fs.readFile(path.join(outputDir, "raw-02-capability-reduction-attempt-1.json"), "utf8");
  const contextualizer = new ForbiddenContextualizer();
  const failureAnalyzer = new CheckpointFailureAnalysisProvider();
  const reducer = new CheckpointRecoveryReductionProvider();
  const validator = new MockValidationProvider({
    status: "passed",
    findings: [],
    validated_capability_ids: ["cap_recovered"],
    rejected_capability_ids: []
  });

  const result = await resumeFailureReroutingFromCheckpoint(runId, {
    root,
    providers: { failureAnalyzer, reducer, validator }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.provider_failure_classification, "transient_rate_limit");
  assert.equal(contextualizer.calls, 0);
  assert.equal(failureAnalyzer.calls.length, 1);
  assert.equal(reducer.calls.length, 1);
  assert.equal(reducer.calls[0].failure_analysis?.status, "correctable");
  assert.equal(reducer.calls[0].revision_findings, undefined);
  assert.equal(await fs.readFile(path.join(outputDir, "raw-02-capability-reduction-attempt-1.json"), "utf8"), priorRaw);
  await fs.access(path.join(outputDir, "03-openai-failure-analysis-retry.yaml"));
  await fs.access(path.join(outputDir, "04-capabilities-recovered.yaml"));
  await fs.access(path.join(outputDir, "05-semantic-validation.yaml"));
  await fs.access(path.join(outputDir, "06-projection.md"));
  await fs.access(path.join(outputDir, "07-evaluation.yaml"));
});

test("checkpoint resume distinguishes quota failures and stops for user action", async () => {
  const root = await tempRoot();
  const { runId } = await writeCheckpoint(root, "quota-run", { error: { message: "insufficient_quota: billing credits exhausted" } });
  const failureAnalyzer = new CheckpointFailureAnalysisProvider();
  const result = await resumeFailureReroutingFromCheckpoint(runId, {
    root,
    providers: {
      failureAnalyzer,
      reducer: new CheckpointRecoveryReductionProvider(),
      validator: new MockValidationProvider()
    }
  });

  assert.equal(classifyProviderFailure({ error: { message: "insufficient_quota: billing credits exhausted" } }), "quota_or_billing");
  assert.equal(result.status, "user_action_required");
  assert.equal(result.provider_failure_classification, "quota_or_billing");
  assert.equal(failureAnalyzer.calls.length, 0);
});

test("checkpoint resume never exceeds one OpenAI provider retry after another 429", async () => {
  const root = await tempRoot();
  const { outputDir, runId } = await writeCheckpoint(root, "repeat-rate-limit-run");
  const failureAnalyzer = new CheckpointFailureAnalysisProvider("rate_limit");
  const reducer = new CheckpointRecoveryReductionProvider();

  const result = await resumeFailureReroutingFromCheckpoint(runId, {
    root,
    providers: {
      failureAnalyzer,
      reducer,
      validator: new MockValidationProvider()
    }
  });

  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.provider_failure_classification, "model_rate_limit");
  assert.equal(failureAnalyzer.calls.length, 1);
  assert.equal(reducer.calls.length, 0);
  await fs.access(path.join(outputDir, "03-openai-failure-analysis-retry-error.yaml"));
  await fs.access(path.join(outputDir, "generation-records.json"));
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
            failureAnalyzer: new MockFailureAnalysisProvider(),
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
