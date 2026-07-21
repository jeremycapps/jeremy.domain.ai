import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import type {
  AgentProvider,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  CorusProgram,
  CorusStageExecutionReceipts,
  CorusTransitionEvent,
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
import { runAttempt2AlignmentReplay } from "../src/lib/corusAlignmentReplay.js";
import { validateProjectionNoInvention } from "../src/lib/corusProjection.js";
import { applyCorusTransition, buildCorusProgramFromRun, loadCorusProgram, planNextCorusAction, replayCorusProgram, replayCorusProgramState, validateCorusProgram } from "../src/lib/corusProgram.js";
import { classifyProviderFailure } from "../src/lib/providerFailureClassification.js";
import { AnthropicCapabilityReductionProvider, capabilityReductionJsonSchema, classifyAnthropicCapabilityReductionFailure, providerReadiness } from "../src/providers/liveProviders.js";
import { metricsFromUsage, parseJsonObject, textFromOpenAIResponse } from "../src/providers/providerUtils.js";
import {
  MockCapabilityReductionProvider,
  MockContextualizationProvider,
  MockFailureAnalysisProvider,
  MockMalformedReductionProvider,
  MockValidationProvider
} from "../src/providers/mockProviders.js";
import { ProviderExecutionError } from "../src/providers/errors.js";
import { validateCapabilityValidationOutput, validateReductionReferences } from "../src/providers/validators.js";

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
  return { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 1, measurement_source: "measured" as const };
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

class RecordingContextualizationProvider extends MockContextualizationProvider {
  public calls: ContextualizeInput[] = [];
  async execute(input: ContextualizeInput): Promise<ProviderResult<Context>> {
    this.calls.push(input);
    return super.execute(input);
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

class ThrowingValidationProvider implements AgentProvider<ValidateCapabilitiesInput, CapabilityValidation> {
  constructor(private readonly message: string, private readonly raw: unknown) {}
  async execute(): Promise<ProviderResult<CapabilityValidation>> {
    throw new ProviderExecutionError("openai", this.message, this.raw, {
      model: "mock-openai",
      prompt_version: "validate.openai.v1",
      schema_version: "corus.validation.v1",
      metrics: { input_tokens: 7, output_tokens: 11, estimated_cost_usd: null, latency_ms: 13, measurement_source: "measured" }
    });
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

function preservedAttempt2OpenAIValidationRaw(text: string) {
  return {
    status: "completed",
    output: [
      { id: "rs_sanitized", type: "reasoning", content: [], summary: [] },
      {
        id: "msg_sanitized",
        type: "message",
        status: "completed",
        content: [{ type: "output_text", annotations: [], logprobs: [], text }],
        phase: "final_answer",
        role: "assistant"
      }
    ]
  };
}

async function onlyRunDir(root: string): Promise<string> {
  const dirs = await fs.readdir(path.join(root, "outputs"));
  assert.equal(dirs.length, 1);
  return path.join(root, "outputs", dirs[0]);
}

async function writeAlignmentReplayInputs(root: string) {
  const runId = "b9e4e3fd-0ca2-41f1-884e-dd43c57e5051";
  const runDir = path.join(root, "outputs", runId);
  const fixtureDir = path.join(root, "test", "fixtures", "prophet");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), "test", "fixtures", "prophet", "attempt2_alignment_fixture.yaml"),
    path.join(fixtureDir, "attempt2_alignment_fixture.yaml")
  );
  await fs.writeFile(
    path.join(runDir, "02-capabilities.yaml"),
    stringify({
      reducer: "capabilities",
      inputs: { subject: "jeremy_capps", target: "prophet_senior_product_manager_ai_foundry" },
      capabilities: [
        { id: "cap_maia_platform_technical_ownership", requirement_ref: "prophet_maia_product_execution", statement: "A", evidence_refs: ["e1"], support: "adjacent", confidence: "medium", generated_by: { provider: "anthropic", model: "m", prompt_version: "p" } },
        { id: "cap_platform_rollout_and_delivery_improvement", requirement_ref: "prophet_maia_product_execution", statement: "B", evidence_refs: ["e2"], support: "adjacent", confidence: "medium", generated_by: { provider: "anthropic", model: "m", prompt_version: "p" } },
        { id: "cap_architecture_tradeoff_to_roadmap_judgment", requirement_ref: "prophet_maia_product_execution", statement: "C", evidence_refs: ["e3"], support: "adjacent", confidence: "medium", generated_by: { provider: "anthropic", model: "m", prompt_version: "p" } },
        { id: "cap_operational_source_of_truth_for_platform_decisions", requirement_ref: "prophet_maia_product_execution", statement: "D", evidence_refs: ["e4"], support: "unsupported", confidence: "low", generated_by: { provider: "anthropic", model: "m", prompt_version: "p" } }
      ]
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, "07-projection.md"),
    [
      "# Capability Assessment",
      "",
      "## cap_maia_platform_technical_ownership",
      "A",
      "## cap_platform_rollout_and_delivery_improvement",
      "B",
      "## cap_architecture_tradeoff_to_roadmap_judgment",
      "C"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, "08-evaluation.yaml"),
    stringify({
      evaluation: {
        quality: {
          requirement_coverage: 1,
          capability_recall: 0,
          capability_precision: 0,
          evidence_accuracy: 1,
          classification_agreement: 0,
          unsupported_claims: 1,
          schema_valid: true,
          projection_fidelity: 0
        },
        differences: [
          { type: "unsupported_addition", generated_id: "cap_maia_platform_technical_ownership", message: "old" },
          { type: "unsupported_addition", generated_id: "cap_operational_source_of_truth_for_platform_decisions", message: "old" }
        ],
        hallucinations: [
          { type: "unsupported_capability", capability_id: "cap_operational_source_of_truth_for_platform_decisions", message: "old" }
        ],
        verdict: "worse"
      }
    }),
    "utf8"
  );
  return { runId, runDir };
}

test("both subject and target load through the same Context shape", async () => {
  const root = await tempRoot();
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root });
  assert.equal(run.contexts.subject.kind, "subject");
  assert.equal(run.contexts.target.kind, "target");
  assert.ok("content" in run.contexts.subject);
  assert.ok("content" in run.contexts.target);
});

test("structured target context ledger bypasses Gemini-style contextualization and preserves full scope", async () => {
  const root = await tempRoot();
  const targetFixture = path.join(process.cwd(), "test", "fixtures", "prophet", "prophet_senior_product_manager.yaml");
  const contextualizer = new RecordingContextualizationProvider();
  const run = await runCapabilityAnalysis(
    { subject_source: source("subject"), target_source: targetFixture, mode: "mocked" },
    {
      root,
      providers: {
        contextualizer,
        reducer: new MockCapabilityReductionProvider(),
        failureAnalyzer: new MockFailureAnalysisProvider(),
        validator: new MockValidationProvider()
      }
    }
  );

  const targetContexts = run.contexts.target.content.contexts as Array<{ id: string }>;
  const targetIds = targetContexts.map((entry) => entry.id);
  assert.equal(contextualizer.calls.length, 1);
  assert.equal(contextualizer.calls[0].position, "subject");
  assert.equal(targetIds.length, 34);
  assert.ok(targetIds.includes("prophet_ai_evaluation_protocols"));
  assert.ok(targetIds.includes("prophet_agent_lifecycle_management"));
  assert.ok(targetIds.includes("prophet_enterprise_data_governance"));
  assert.ok(targetIds.includes("prophet_qualifying_tradeoff_question"));
  assert.notDeepEqual(targetIds, ["prophet_maia_product_execution"]);
  assert.equal(run.contexts.target.generation.provider, "fixture");
  assert.equal(run.contexts.target.generation.model, "structured-context-ledger");
  assert.equal(run.contexts.target.generation.source_context_count, 34);
  assert.equal(run.contexts.target.generation.output_context_count, 34);

  const targetRecord = run.generation_records.find((record) => record.type === "contextualization" && record.input_refs.includes(targetFixture));
  assert.equal(targetRecord?.provider, "fixture");
  assert.equal(targetRecord?.raw_output_ref, undefined);
  await assert.rejects(fs.access(path.join(root, run.artifact_dir, "raw-01-target-context-provider.json")));

  const targetArtifact = parse(await fs.readFile(path.join(root, run.artifact_dir, "01-target-context.yaml"), "utf8")) as {
    context: { content: { contexts: Array<{ id: string }> } };
  };
  assert.equal(targetArtifact.context.content.contexts.length, 34);
});

test("raw unstructured target input still uses the contextualization provider", async () => {
  const root = await tempRoot();
  const contextualizer = new RecordingContextualizationProvider();
  await runCapabilityAnalysis(
    {
      subject_source: source("subject"),
      target_source: { id: "raw_target", description: "A raw unstructured job description that needs contextualization." },
      mode: "mocked"
    },
    {
      root,
      providers: {
        contextualizer,
        reducer: new MockCapabilityReductionProvider(),
        failureAnalyzer: new MockFailureAnalysisProvider(),
        validator: new MockValidationProvider()
      }
    }
  );

  assert.equal(contextualizer.calls.length, 2);
  assert.equal(contextualizer.calls[1].position, "target");
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

test("Anthropic reduction request includes the CapabilityReduction structured-output schema", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (inputUrl: string | URL | Request, init?: RequestInit) => {
    if (String(inputUrl).includes("count_tokens")) {
      return { ok: true, json: async () => ({ input_tokens: 10 }) } as Response;
    }
    requestBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () => ({
        content: [
          {
            text: JSON.stringify({
              reducer: "capabilities",
              inputs: { subject: "subject_subject", target: "target_target" },
              capabilities: [
                {
                  id: "cap_structured",
                  requirement_ref: "requirement_product_execution",
                  statement: "Structured capability.",
                  evidence_refs: ["evidence_product_execution"],
                  support: "supported",
                  confidence: "high",
                  generated_by: { provider: "anthropic", model: "mock", prompt_version: "reduce.anthropic.v1" }
                }
              ]
            })
          }
        ],
        usage: { input_tokens: 10, output_tokens: 20 }
      })
    } as Response;
  }) as typeof fetch;

  try {
    const contextualizer = new MockContextualizationProvider();
    const subjectContext = (await contextualizer.execute({ source: source("subject"), kind: "subject", position: "subject", input_ref: "subject" })).output;
    const targetContext = (await contextualizer.execute({ source: source("target"), kind: "target", position: "target", input_ref: "target" })).output;
    await new AnthropicCapabilityReductionProvider().execute({ contexts: { subject: subjectContext, target: targetContext } });

    const format = ((requestBody?.output_config as { format?: unknown })?.format ?? {}) as { type?: unknown; schema?: Record<string, unknown> };
    const schema = format.schema as { properties: Record<string, unknown> };
    const capabilities = schema.properties.capabilities as { items: { required: string[]; properties: Record<string, unknown> } };
    assert.equal(format.type, "json_schema");
    assert.deepEqual(schema, capabilityReductionJsonSchema());
    assert.deepEqual(requestBody?.thinking, { type: "disabled" });
    assert.equal(requestBody?.max_tokens, 4000);
    assert.equal((schema.properties.reducer as { const?: unknown }).const, "capabilities");
    assert.ok(capabilities.items.required.includes("requirement_ref"));
    assert.ok(capabilities.items.required.includes("evidence_refs"));
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test("Anthropic max-token truncation is classified as provider incomplete", () => {
  assert.equal(
    classifyAnthropicCapabilityReductionFailure({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"reducer\":" }] }, new SyntaxError("Unexpected end of JSON input")),
    "provider_incomplete_max_tokens"
  );
  assert.equal(classifyAnthropicCapabilityReductionFailure({ stop_reason: "end_turn" }, new SyntaxError("Unexpected token")), "invalid_structured_output");
});

test("CapabilityReduction schema requires requirement_ref and evidence_refs", () => {
  const schema = capabilityReductionJsonSchema() as { properties: Record<string, unknown> };
  const capabilities = schema.properties.capabilities as { items: { required: string[] } };
  assert.ok(capabilities.items.required.includes("requirement_ref"));
  assert.ok(capabilities.items.required.includes("evidence_refs"));
});

test("deterministic reduction validation rejects structurally valid invalid context references", async () => {
  const contextualizer = new MockContextualizationProvider();
  const subjectContext = (await contextualizer.execute({ source: source("subject"), kind: "subject", position: "subject", input_ref: "subject" })).output;
  const targetContext = (await contextualizer.execute({ source: source("target"), kind: "target", position: "target", input_ref: "target" })).output;
  const structurallyValidReduction: CapabilityReduction = {
    reducer: "capabilities",
    inputs: { subject: subjectContext.id, target: targetContext.id },
    capabilities: [
      {
        id: "cap_bad_refs",
        requirement_ref: "missing_requirement",
        statement: "Structurally valid but context-invalid.",
        evidence_refs: ["missing_evidence"],
        support: "supported",
        confidence: "high",
        generated_by: { provider: "anthropic", model: "mock", prompt_version: "reduce.anthropic.v1" }
      }
    ]
  };

  assert.throws(
    () => validateReductionReferences(structurallyValidReduction, { subject: subjectContext, target: targetContext }, "anthropic"),
    /requirement_ref must match a target context id/
  );
});

test("OpenAI Responses extraction reads validation JSON from output content", () => {
  const raw = preservedAttempt2OpenAIValidationRaw(
    JSON.stringify({
      status: "architect_required",
      findings: [{ capability_id: "cap_maia_platform_technical_ownership", decision: "architect_required", reason: "Needs architect review." }],
      validated_capability_ids: ["cap_platform_rollout_and_delivery_improvement"],
      rejected_capability_ids: ["cap_operational_source_of_truth_for_platform_decisions"]
    })
  );
  const validation = validateCapabilityValidationOutput(parseJsonObject(textFromOpenAIResponse(raw)), "openai");
  assert.equal(validation.status, "architect_required");
  assert.notEqual(validation.status, raw.status);
});

test("OpenAI extraction prefers output_text when present", () => {
  const raw = {
    output_text: JSON.stringify({ status: "passed", findings: [], validated_capability_ids: ["cap"], rejected_capability_ids: [] }),
    status: "completed",
    output: [
      {
        content: [
          {
            text: JSON.stringify({ status: "failed", findings: [], validated_capability_ids: [], rejected_capability_ids: ["cap"] })
          }
        ]
      }
    ]
  };
  const validation = validateCapabilityValidationOutput(parseJsonObject(textFromOpenAIResponse(raw)), "openai");
  assert.equal(validation.status, "passed");
});

test("OpenAI outer API status is never treated as domain validation status", () => {
  assert.throws(() => textFromOpenAIResponse({ status: "completed", output: [{ type: "reasoning", content: [] }] }), /did not contain assistant text/);
});

test("OpenAI extraction fails deterministically when assistant content is missing", () => {
  assert.throws(() => textFromOpenAIResponse({ status: "completed", output: [] }), /did not contain assistant text/);
});

test("OpenAI extraction fails deterministically when inner JSON is malformed", () => {
  const raw = preservedAttempt2OpenAIValidationRaw("{not-json");
  assert.throws(() => parseJsonObject(textFromOpenAIResponse(raw)), /Expected property name|JSON/);
});

test("generation records survive validation parser failure", async () => {
  const root = await tempRoot();
  let caught: unknown;
  try {
    await runCapabilityAnalysis(
      { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
      {
        root,
        providers: {
          contextualizer: new MockContextualizationProvider(),
          reducer: new FixedReductionProvider(),
          failureAnalyzer: new MockFailureAnalysisProvider(),
          validator: new ThrowingValidationProvider("OpenAI response did not contain assistant text.", { status: "completed", output: [] })
        }
      }
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProviderExecutionError);
  const runDir = await onlyRunDir(root);
  const records = JSON.parse(await fs.readFile(path.join(runDir, "generation-records.json"), "utf8")) as Array<{ type: string; validation_status: string; metrics: { input_tokens: number | null; latency_ms: number | null; measurement_source: string } }>;
  assert.ok(records.some((record) => record.type === "capability_validation" && record.validation_status === "error"));
  assert.ok(records.some((record) => record.type === "capability_validation" && record.metrics.input_tokens === 7 && record.metrics.latency_ms === 13 && record.metrics.measurement_source === "measured"));
});

test("generation records survive validation validator failure", async () => {
  const root = await tempRoot();
  let caught: unknown;
  try {
    await runCapabilityAnalysis(
      { subject_source: source("subject"), target_source: source("target"), mode: "mocked" },
      {
        root,
        providers: {
          contextualizer: new MockContextualizationProvider(),
          reducer: new FixedReductionProvider(),
          failureAnalyzer: new MockFailureAnalysisProvider(),
          validator: new ThrowingValidationProvider(
            "Validation output has invalid status.",
            preservedAttempt2OpenAIValidationRaw(JSON.stringify({ status: "completed", findings: [], validated_capability_ids: [], rejected_capability_ids: [] }))
          )
        }
      }
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProviderExecutionError);
  const runDir = await onlyRunDir(root);
  const records = JSON.parse(await fs.readFile(path.join(runDir, "generation-records.json"), "utf8")) as Array<{ type: string; validation_status: string }>;
  assert.ok(records.some((record) => record.type === "capability_validation" && record.validation_status === "error"));
});

test("generation records and architect artifact survive architect_required termination", async () => {
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
          status: "architect_required",
          findings: [{ severity: "error", type: "product_ambiguity", message: "Architect review required." }],
          validated_capability_ids: [],
          rejected_capability_ids: []
        })
      }
    }
  );
  assert.equal(run.status, "architect_required");
  await fs.access(path.join(root, run.artifact_dir, "generation-records.json"));
  await fs.access(path.join(root, run.artifact_dir, "04-architect-decision.yaml"));
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

test("measured provider metrics include latency measurement source", () => {
  const metrics = metricsFromUsage(Date.now() - 5, { input_tokens: 1, output_tokens: 2 });
  assert.equal(typeof metrics.latency_ms, "number");
  assert.equal(metrics.measurement_source, "measured");
});

test("unavailable latency remains null in evaluation reports", async () => {
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const unavailable = run.generation_records.map((record) => ({
    ...record,
    metrics: { ...record.metrics, latency_ms: null, measurement_source: "unavailable" as const }
  }));
  const report = evaluateCapabilityRun({
    run: { ...run, generation_records: unavailable },
    fixture: "unit",
    baselineRef: "baseline.yaml",
    baseline: { capabilities: [] }
  });
  assert.equal(report.evaluation.efficiency.latency_ms, null);
  assert.equal(report.evaluation.efficiency.measurement_source, "unavailable");
});

test("available measured latency is summed without treating unavailable as zero", async () => {
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const mixed = run.generation_records.map((record, index) => ({
    ...record,
    metrics:
      index === 0
        ? { ...record.metrics, latency_ms: null, measurement_source: "unavailable" as const }
        : { ...record.metrics, latency_ms: 5, measurement_source: "measured" as const }
  }));
  const report = evaluateCapabilityRun({
    run: { ...run, generation_records: mixed },
    fixture: "unit",
    baselineRef: "baseline.yaml",
    baseline: { capabilities: [] }
  });
  assert.equal(report.evaluation.efficiency.latency_ms, 5 * (mixed.length - 1));
  assert.equal(report.evaluation.efficiency.measurement_source, "measured");
});

test("derived latency in any contributing record marks aggregate latency as derived", async () => {
  const run = await runCapabilityAnalysis({ subject_source: source("subject"), target_source: source("target"), mode: "mocked" }, { root: await tempRoot() });
  const mixed = run.generation_records.map((record, index) => ({
    ...record,
    metrics:
      index === 0
        ? { ...record.metrics, latency_ms: 9, measurement_source: "derived" as const }
        : { ...record.metrics, latency_ms: 1, measurement_source: "measured" as const }
  }));
  const report = evaluateCapabilityRun({
    run: { ...run, generation_records: mixed },
    fixture: "unit",
    baselineRef: "baseline.yaml",
    baseline: { capabilities: [] }
  });
  assert.equal(report.evaluation.efficiency.latency_ms, 9 + mixed.length - 1);
  assert.equal(report.evaluation.efficiency.measurement_source, "derived");
});

test("attempt-2 alignment replay computes mapped diagnostics without changing strict metrics", async () => {
  const root = await tempRoot();
  const { runId } = await writeAlignmentReplayInputs(root);
  const replay = await runAttempt2AlignmentReplay({ root, runId });

  assert.deepEqual(replay.strict_metrics_preserved, {
    requirement_coverage: 1,
    capability_recall: 0,
    capability_precision: 0,
    evidence_accuracy: 1,
    classification_agreement: 0,
    unsupported_claims: 1,
    schema_valid: true,
    projection_fidelity: 0
  });
  assert.equal(replay.diagnostic_metrics.mapped_recall.numerator, 9);
  assert.equal(replay.diagnostic_metrics.mapped_recall.denominator, 9);
  assert.equal(replay.diagnostic_metrics.mapped_recall.score, 1);
  assert.equal(replay.diagnostic_metrics.mapped_precision.score, 1);
  assert.equal(replay.diagnostic_metrics.adjacent_accepted_projection_fidelity.score, 1);
  assert.equal(replay.diagnostic_metrics.rejected_output_exclusion.score, 1);
  assert.equal(replay.scope_compatibility.comparable, false);
  assert.equal(replay.prior_worse_verdict_status, "indeterminate");
});

test("attempt-2 alignment replay corrects difference taxonomy and suppresses rejected projection hallucination", async () => {
  const root = await tempRoot();
  const { runId } = await writeAlignmentReplayInputs(root);
  const replay = await runAttempt2AlignmentReplay({ root, runId });

  const rejected = replay.generated_to_baseline_mapping_table.find((row) => row.generated_id === "cap_operational_source_of_truth_for_platform_decisions");
  assert.equal(rejected?.corrected_difference_label, "rejected_unsupported");
  const adjacentRows = replay.generated_to_baseline_mapping_table.filter((row) => row.architect_disposition === "adjacent");
  assert.equal(adjacentRows.every((row) => row.corrected_difference_label === null), true);
  assert.deepEqual(replay.corrected_difference_taxonomy.hallucinations, []);
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

test("Prophet fixture run can be represented and replayed as a CorusProgram", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, "test", "fixtures"), { recursive: true });
  await fs.cp(path.join(process.cwd(), "test", "fixtures", "prophet"), path.join(root, "test", "fixtures", "prophet"), { recursive: true });

  const request = {
    subject_source: "test/fixtures/prophet/jeremy_corus.yaml",
    target_source: "test/fixtures/prophet/prophet_senior_product_manager.yaml",
    projection: "capability_assessment" as const,
    mode: "fixture" as const
  };
  const run = await runCapabilityAnalysis(request, { root });
  const program = buildCorusProgramFromRun({
    request,
    run,
    programId: "prophet-fixture-program-test",
    baselineRef: "test/fixtures/prophet/jeremy_prophet_senior_product_manager_capabilities.yaml"
  });
  const replayed = replayCorusProgram(program);

  assert.equal(program.schema_version, "corus.program.v1");
  assert.equal(program.object_schemas.objects.capability_reduction, "corus.capability_reduction.v1");
  assert.equal(program.state.status, "awaiting_author");
  assert.equal(program.state.current_process_id, "capability_admission");
  assert.equal(program.state.replay.replay_provider_calls_made, 0);
  assert.equal(program.state.replay.historical_provider_calls_made, 0);
  assert.equal(replayed.status, run.status);
  assert.deepEqual(replayed.capabilities, run.capabilities);
  assert.deepEqual(replayed.validation, run.validation);
  assert.deepEqual(replayed.projection, run.projection);
});

test("golden Prophet CorusProgram fixture replays with zero replay provider calls", async () => {
  const program = await loadCorusProgram(path.join(process.cwd(), "test", "fixtures", "prophet", "prophet_corus_program_golden.yaml"));
  const replayed = replayCorusProgram(program);

  assert.equal(program.state.mode, "fixture");
  assert.equal(program.state.source_refs.target, "test/fixtures/prophet/prophet_senior_product_manager.yaml");
  assert.equal(program.state.source_refs.baseline, "test/fixtures/prophet/jeremy_prophet_senior_product_manager_capabilities.yaml");
  assert.equal(program.state.replay.replay_provider_calls_made, 0);
  assert.equal(program.state.replay.historical_provider_calls_made, 0);
  assert.equal(replayed.status, "passed");
  assert.deepEqual(replayed.projection?.capability_ids, ["cap_product_execution"]);
});

const prophetProgramPath = path.join(process.cwd(), "test", "fixtures", "prophet", "prophet_corus_program_golden.yaml");

function copyProgram(program: CorusProgram): CorusProgram {
  return structuredClone(program);
}

function authorDecisionEvent(
  overrides: Partial<CorusTransitionEvent> = {}
): CorusTransitionEvent {
  return {
    process_id: "capability_admission",
    prior_status: "awaiting_author",
    returned_status: "admitted",
    artifact_refs: {
      author_review: "test/fixtures/prophet/prophet_corus_program_golden.yaml#author-review",
      author_decision: "test/fixtures/prophet/prophet_corus_program_golden.yaml#author-decision"
    },
    occurred_at: "2026-07-21T00:01:00.000Z",
    actor_ref: "author:jeremy",
    provider_calls_made: 0,
    ...overrides
  };
}

async function liveProgramConversionInput() {
  const fixtureProgram = await loadCorusProgram(prophetProgramPath);
  return {
    request: {
      subject_source: fixtureProgram.state.source_refs.subject,
      target_source: fixtureProgram.state.source_refs.target,
      projection: "capability_assessment" as const,
      mode: "live" as const
    },
    run: { ...replayCorusProgram(fixtureProgram), mode: "live" as const },
    programId: "prophet-live-provenance-test",
    baselineRef: fixtureProgram.state.source_refs.baseline
  };
}

test("live run conversion preserves exact stage-scoped execution receipt totals", async () => {
  const input = await liveProgramConversionInput();
  const stageExecutionReceipts: CorusStageExecutionReceipts = {
    structured_context_preservation: [{ id: "receipt-contexts", provider_calls_made: 2 }],
    capability_reduction: [{ id: "receipt-reduction", provider_calls_made: 1 }],
    capability_validation: [{ id: "receipt-validation", provider_calls_made: 1 }],
    projection: [{ id: "receipt-projection-zero", provider_calls_made: 0 }],
    capability_admission: [{ id: "receipt-admission-zero", provider_calls_made: 0 }]
  };
  const program = buildCorusProgramFromRun({ ...input, stageExecutionReceipts });

  assert.equal(program.state.replay.historical_provider_calls_made, 4);
  assert.equal(program.state.replay.replay_provider_calls_made, 0);
  assert.deepEqual(
    Object.fromEntries(program.state.history.map((event) => [event.process_id, event.provider_calls_made])),
    {
      structured_context_preservation: 2,
      capability_reduction: 1,
      capability_validation: 1,
      projection: 0,
      capability_admission: 0
    }
  );
  assert.deepEqual(program.state.history.map((event) => event.execution_receipts), Object.values(stageExecutionReceipts));
});

test("live run conversion rejects missing required execution receipts", async () => {
  const input = await liveProgramConversionInput();
  assert.throws(
    () => buildCorusProgramFromRun(input),
    /Live CorusProgram conversion requires execution receipts for process structured_context_preservation/
  );
});

test("Prophet continuation plans the exact side-effect-free author decision contract", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  const before = JSON.stringify(program);
  const action = planNextCorusAction(program);

  assert.deepEqual(action, {
    program_id: "prophet-fixture-program-golden",
    process_id: "capability_admission",
    operation: "author_decision",
    target: "capability_admission_checkpoint",
    reason: "Program is awaiting author admission; only an author decision can advance deterministic continuation.",
    required_input_refs: [
      "test/fixtures/prophet/prophet_corus_program_golden.yaml#projection",
      "test/fixtures/prophet/prophet_corus_program_golden.yaml#validation",
      "test/fixtures/prophet/jeremy_prophet_senior_product_manager_capabilities.yaml"
    ],
    expected_output_contract: {
      allowed_return_statuses: ["awaiting_author", "admitted", "blocked"],
      required_artifact_refs: ["author_review", "author_decision"]
    },
    execution_required: false
  });
  assert.equal(JSON.stringify(program), before);
  assert.equal(program.state.replay.replay_provider_calls_made, 0);
});

test("author transition applies the planned contract immutably and records provenance", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  const action = planNextCorusAction(program);
  assert.ok(action);
  const before = structuredClone(program);
  const artifact_refs = Object.fromEntries(
    action.expected_output_contract.required_artifact_refs.map((name) => [name, `test/fixtures/prophet/${name}.yaml`])
  );
  const event = authorDecisionEvent({ artifact_refs });
  const next = applyCorusTransition(program, event);

  assert.deepEqual(program, before);
  assert.notEqual(next, program);
  assert.equal(next.state.status, "admitted");
  assert.equal(next.state.history.length, program.state.history.length + 1);
  assert.deepEqual(next.state.history.at(-1), event);
  assert.equal(next.state.replay.replay_provider_calls_made, 0);
  assert.equal(next.state.replay.historical_provider_calls_made, 0);
  assert.equal(planNextCorusAction(next), null);
});

test("history replay is deterministic and agrees with serialized program state", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  const before = JSON.stringify(program);
  const first = replayCorusProgramState(program);
  const second = replayCorusProgramState(program);

  assert.deepEqual(first, second);
  assert.equal(first.status, program.state.status);
  assert.equal(first.current_process_id, program.state.current_process_id);
  assert.equal(first.current_process_start_status, program.state.current_process_start_status);
  assert.deepEqual(first.process_status, program.state.process_status);
  assert.equal(first.replay.replay_provider_calls_made, 0);
  assert.equal(JSON.stringify(program), before);
});

test("revise preserves the return status while explicitly re-entering capability reduction", async () => {
  const golden = await loadCorusProgram(prophetProgramPath);
  const program = copyProgram(golden);
  program.state.history = program.state.history.slice(0, 2);
  program.state.status = "completed_valid_output";
  program.state.current_process_id = "capability_validation";
  program.state.current_process_start_status = "completed_valid_output";
  program.state.process_status = {
    structured_context_preservation: "completed_valid_output",
    capability_reduction: "completed_valid_output",
    capability_validation: "ready",
    projection: "ready",
    capability_admission: "ready"
  };
  validateCorusProgram(program);

  const revised = applyCorusTransition(program, {
    process_id: "capability_validation",
    prior_status: "completed_valid_output",
    returned_status: "revise",
    artifact_refs: { capability_validation: "test/fixtures/prophet/revision-required.yaml" },
    occurred_at: "2026-07-21T00:01:00.000Z",
    actor_ref: "corus.validator",
    provider_calls_made: 0
  });
  assert.equal(revised.state.status, "revise");
  assert.equal(revised.state.current_process_id, "capability_reduction");
  assert.equal(revised.state.current_process_start_status, "completed_valid_output");
  assert.equal(planNextCorusAction(revised)?.process_id, "capability_reduction");

  const reducedAgain = applyCorusTransition(revised, {
    process_id: "capability_reduction",
    prior_status: "completed_valid_output",
    returned_status: "completed_valid_output",
    artifact_refs: { capability_reduction: "test/fixtures/prophet/revised-capabilities.yaml" },
    occurred_at: "2026-07-21T00:02:00.000Z",
    actor_ref: "corus.runtime",
    provider_calls_made: 0
  });
  assert.equal(reducedAgain.state.current_process_id, "capability_validation");
  assert.equal(reducedAgain.state.current_process_start_status, "completed_valid_output");
});

test("historical provider calls require and reconcile to execution receipts while replay calls remain zero", async () => {
  const program = copyProgram(await loadCorusProgram(prophetProgramPath));
  program.state.history[1] = {
    ...program.state.history[1],
    provider_calls_made: 2,
    execution_receipts: [{ id: "receipt-capability-reduction", provider_calls_made: 2 }]
  };
  program.state.replay.historical_provider_calls_made = 2;

  const validated = validateCorusProgram(program);
  const replayed = replayCorusProgramState(validated);
  assert.equal(replayed.replay.historical_provider_calls_made, 2);
  assert.equal(replayed.replay.replay_provider_calls_made, 0);
});

test("transition rejects skipping the required current process", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  assert.throws(() => applyCorusTransition(program, authorDecisionEvent({ process_id: "projection" })), /Cannot skip required process capability_admission/);
});

test("transition rejects an unsupported returned status", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  assert.throws(() => applyCorusTransition(program, authorDecisionEvent({ returned_status: "passed" })), /returned unsupported status passed/);
});

test("transition rejects completion without required artifact references", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  assert.throws(
    () => applyCorusTransition(program, authorDecisionEvent({ artifact_refs: { author_decision: "test/fixtures/prophet/author-decision.yaml" } })),
    /missing required artifact ref author_review/
  );
});

test("transition rejects changing an already completed process without an explicit change transition", async () => {
  const admitted = applyCorusTransition(await loadCorusProgram(prophetProgramPath), authorDecisionEvent());
  assert.throws(
    () => applyCorusTransition(admitted, authorDecisionEvent({ prior_status: "admitted", returned_status: "blocked" })),
    /Cannot change already completed process capability_admission/
  );
});

test("transition rejects advancing awaiting_author without an author decision", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  assert.throws(
    () => applyCorusTransition(program, authorDecisionEvent({ artifact_refs: { author_review: "test/fixtures/prophet/author-review.yaml" } })),
    /requires an author_decision artifact/
  );
});

test("transition rejects nonzero provider calls without execution receipts", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  assert.throws(
    () => applyCorusTransition(program, authorDecisionEvent({ provider_calls_made: 1 })),
    /with provider calls requires execution receipts/
  );
});

test("transition rejects provider calls inconsistent with execution receipts", async () => {
  const program = await loadCorusProgram(prophetProgramPath);
  assert.throws(
    () => applyCorusTransition(program, authorDecisionEvent({
      provider_calls_made: 2,
      execution_receipts: [{ id: "receipt-author-decision", provider_calls_made: 1 }]
    })),
    /provider_calls_made is inconsistent with execution receipts/
  );
});

test("validation rejects serialized state that disagrees with deterministic history replay", async () => {
  const program = copyProgram(await loadCorusProgram(prophetProgramPath));
  program.state.status = "admitted";
  assert.throws(() => validateCorusProgram(program), /history replays to a different current process, start status, or return status/);
});

test("validation rejects a history event with a missing actor_ref", async () => {
  const program = copyProgram(await loadCorusProgram(prophetProgramPath));
  program.state.history[0].actor_ref = "   ";
  assert.throws(() => validateCorusProgram(program), /actor_ref must be a nonempty string/);
});

test("validation rejects missing or invalid history event occurred_at", async () => {
  const missing = copyProgram(await loadCorusProgram(prophetProgramPath));
  delete (missing.state.history[0] as { occurred_at?: string }).occurred_at;
  assert.throws(() => validateCorusProgram(missing), /occurred_at must be a valid ISO-8601 timestamp/);

  const invalid = copyProgram(await loadCorusProgram(prophetProgramPath));
  invalid.state.history[0].occurred_at = "not-a-timestamp";
  assert.throws(() => validateCorusProgram(invalid), /occurred_at must be a valid ISO-8601 timestamp/);

  const invalidCalendarDate = copyProgram(await loadCorusProgram(prophetProgramPath));
  invalidCalendarDate.state.history[0].occurred_at = "2026-02-30T00:00:00Z";
  assert.throws(() => validateCorusProgram(invalidCalendarDate), /occurred_at must be a valid ISO-8601 timestamp/);
});
