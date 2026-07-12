import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  AgentProvider,
  CapabilityAnalysisResponse,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  FailureAnalysis,
  FailureAnalysisInput,
  HandoffFailure,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../types.js";
import {
  AnthropicCapabilityReductionProvider,
  expectedCapabilityReductionSchema,
  OpenAIFailureAnalysisProvider,
  OpenAIValidationProvider
} from "../providers/liveProviders.js";
import { ProviderExecutionError } from "../providers/errors.js";
import { artifactRef, stageRecord, writeGenerationRecords, writeJsonArtifact, writeMarkdownArtifact, writeYamlArtifact } from "./corusArtifacts.js";
import { evaluateCapabilityRun } from "./corusEvaluation.js";
import { projectValidatedCapabilities } from "./corusProjection.js";
import { getProjectRoot } from "./paths.js";
import { classifyProviderFailure, retryAfterMilliseconds, type ProviderFailureClassification } from "./providerFailureClassification.js";

export interface CheckpointResumeProviders {
  failureAnalyzer: AgentProvider<FailureAnalysisInput, FailureAnalysis>;
  reducer: AgentProvider<ReduceCapabilitiesInput, CapabilityReduction>;
  validator: AgentProvider<ValidateCapabilitiesInput, CapabilityValidation>;
}

export interface CheckpointResumeResult {
  run_id: string;
  status: "user_action_required" | "provider_unavailable" | CapabilityAnalysisResponse["status"];
  provider_failure_classification: ProviderFailureClassification;
  artifact_dir: string;
  run?: CapabilityAnalysisResponse;
}

function idsFromContext(context: Context): string[] {
  const contexts = context.content.contexts;
  if (!Array.isArray(contexts)) return [];
  return contexts
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

async function readYaml<T>(filePath: string): Promise<T> {
  return parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function emptyValidation(status: CapabilityValidation["status"]): CapabilityValidation {
  return { status, findings: [], validated_capability_ids: [], rejected_capability_ids: [] };
}

async function appendErrorRecord(input: {
  root: string;
  outputDir: string;
  records: CapabilityAnalysisResponse["generation_records"];
  handoffErrorRef: string;
  rawAttemptRef: string;
  filename: string;
  rawFilename: string;
  error: unknown;
  classification: ProviderFailureClassification;
}) {
  const rawOutput = input.error instanceof ProviderExecutionError ? input.error.raw_output : undefined;
  const rawErrorPath = rawOutput !== undefined ? await writeJsonArtifact(input.outputDir, input.rawFilename, rawOutput) : undefined;
  const errorPath = await writeYamlArtifact(input.outputDir, input.filename, {
    created_at: new Date().toISOString(),
    status: "provider_unavailable",
    provider: input.error instanceof ProviderExecutionError ? input.error.provider : undefined,
    classification: input.classification,
    message: input.error instanceof Error ? input.error.message : "Unknown provider error."
  });
  input.records.push(
    stageRecord({
      type: "failure_analysis",
      input_refs: [input.handoffErrorRef, input.rawAttemptRef],
      output_ref: artifactRef(input.root, errorPath),
      raw_output_ref: rawErrorPath ? artifactRef(input.root, rawErrorPath) : undefined,
      provider: input.error instanceof ProviderExecutionError ? input.error.provider : "openai",
      model: "unknown",
      prompt_version: "failure-analysis.openai.v1",
      schema_version: "corus.failure_analysis.v1",
      validation_status: `provider_unavailable:${input.classification}`,
      metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
    })
  );
}

function liveResumeProviders(): CheckpointResumeProviders {
  return {
    failureAnalyzer: new OpenAIFailureAnalysisProvider(),
    reducer: new AnthropicCapabilityReductionProvider(),
    validator: new OpenAIValidationProvider()
  };
}

export async function resumeFailureReroutingFromCheckpoint(
  runId: string,
  options: { root?: string; providers?: CheckpointResumeProviders; wait?: (milliseconds: number) => Promise<void> } = {}
): Promise<CheckpointResumeResult> {
  const root = options.root ?? getProjectRoot();
  const providers = options.providers ?? liveResumeProviders();
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const outputDir = path.join(root, "outputs", runId);
  const artifactDir = artifactRef(root, outputDir);
  const subjectArtifact = path.join(outputDir, "01-subject-context.yaml");
  const targetArtifact = path.join(outputDir, "01-target-context.yaml");
  const rawAttemptArtifact = path.join(outputDir, "raw-02-capability-reduction-attempt-1.json");
  const handoffErrorArtifact = path.join(outputDir, "02-capability-reduction-attempt-1-error.yaml");
  const sanitizedErrorArtifact = path.join(outputDir, "error-03-openai-failure-analysis-provider-error.yaml");

  const subject = (await readYaml<{ context: Context }>(subjectArtifact)).context;
  const target = (await readYaml<{ context: Context }>(targetArtifact)).context;
  const rawAttempt = await readJson(rawAttemptArtifact);
  const handoffFailure = (await readYaml<{ handoff_failure: HandoffFailure }>(handoffErrorArtifact)).handoff_failure;
  const sanitizedOpenAiError = await readYaml<unknown>(sanitizedErrorArtifact);
  const initialClassification = classifyProviderFailure(sanitizedOpenAiError);
  const records: CapabilityAnalysisResponse["generation_records"] = [];
  const rawAttemptRef = artifactRef(root, rawAttemptArtifact);
  const handoffErrorRef = artifactRef(root, handoffErrorArtifact);

  const classificationArtifact = await writeYamlArtifact(outputDir, "03-openai-failure-analysis-retry-classification.yaml", {
    created_at: new Date().toISOString(),
    provider: "openai",
    inspected_artifact: artifactRef(root, sanitizedErrorArtifact),
    classification: initialClassification
  });

  if (initialClassification === "quota_or_billing") {
    records.push(
      stageRecord({
        type: "failure_analysis",
        input_refs: [artifactRef(root, classificationArtifact)],
        output_ref: artifactRef(root, classificationArtifact),
        provider: "openai",
        model: "unknown",
        prompt_version: "failure-analysis.openai.v1",
        schema_version: "corus.failure_analysis.v1",
        validation_status: "user_action_required:quota_or_billing",
        metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
      })
    );
    await writeGenerationRecords(outputDir, records);
    return { run_id: runId, status: "user_action_required", provider_failure_classification: initialClassification, artifact_dir: artifactDir };
  }

  if (initialClassification === "unknown_provider_failure") {
    records.push(
      stageRecord({
        type: "failure_analysis",
        input_refs: [artifactRef(root, classificationArtifact)],
        output_ref: artifactRef(root, classificationArtifact),
        provider: "openai",
        model: "unknown",
        prompt_version: "failure-analysis.openai.v1",
        schema_version: "corus.failure_analysis.v1",
        validation_status: "provider_unavailable:unknown_provider_failure",
        metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
      })
    );
    await writeGenerationRecords(outputDir, records);
    return { run_id: runId, status: "provider_unavailable", provider_failure_classification: initialClassification, artifact_dir: artifactDir };
  }

  const retryAfter = retryAfterMilliseconds(sanitizedOpenAiError);
  if (retryAfter !== null && retryAfter > 0) await wait(retryAfter);

  const failureAnalysisInput: FailureAnalysisInput = {
    handoff_failure: handoffFailure,
    expected_schema: expectedCapabilityReductionSchema(),
    raw_provider_output: rawAttempt,
    valid_subject_evidence_ids: idsFromContext(subject),
    valid_target_requirement_ids: idsFromContext(target)
  };

  let failureAnalysisResult: ProviderResult<FailureAnalysis>;
  try {
    failureAnalysisResult = await providers.failureAnalyzer.execute(failureAnalysisInput);
  } catch (error) {
    const retryClassification = classifyProviderFailure(error instanceof ProviderExecutionError ? { message: error.message, raw_output: error.raw_output } : error);
    await appendErrorRecord({
      root,
      outputDir,
      records,
      handoffErrorRef,
      rawAttemptRef,
      filename: "03-openai-failure-analysis-retry-error.yaml",
      rawFilename: "raw-03-openai-failure-analysis-retry-provider-error.json",
      error,
      classification: retryClassification
    });
    await writeGenerationRecords(outputDir, records);
    return { run_id: runId, status: "provider_unavailable", provider_failure_classification: retryClassification, artifact_dir: artifactDir };
  }

  const failureAnalysis = failureAnalysisResult.output;
  const failureAnalysisArtifact = await writeYamlArtifact(outputDir, "03-openai-failure-analysis-retry.yaml", { failure_analysis: failureAnalysis });
  const failureAnalysisRawArtifact = failureAnalysisResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-03-openai-failure-analysis-retry-provider.json", failureAnalysisResult.raw_output)
    : undefined;
  records.push(
    stageRecord({
      type: "failure_analysis",
      input_refs: [handoffErrorRef, rawAttemptRef],
      output_ref: artifactRef(root, failureAnalysisArtifact),
      raw_output_ref: failureAnalysisRawArtifact ? artifactRef(root, failureAnalysisRawArtifact) : undefined,
      provider: failureAnalysisResult.provider,
      model: failureAnalysisResult.model,
      prompt_version: failureAnalysisResult.prompt_version,
      schema_version: "corus.failure_analysis.v1",
      validation_status: failureAnalysis.status,
      metrics: failureAnalysisResult.metrics
    })
  );

  if (failureAnalysis.status !== "correctable" || failureAnalysis.retry_stage !== "capability_reduction") {
    const status = failureAnalysis.status === "architect_required" ? "architect_required" : "failed";
    await writeGenerationRecords(outputDir, records);
    const run: CapabilityAnalysisResponse = {
      run_id: runId,
      status,
      mode: "live",
      contexts: { subject, target },
      capabilities: [],
      validation: emptyValidation(status),
      projection: null,
      generation_records: records,
      artifact_dir: artifactDir,
      handoff_failure: handoffFailure,
      failure_analysis: failureAnalysis
    };
    return { run_id: runId, status, provider_failure_classification: initialClassification, artifact_dir: artifactDir, run };
  }

  let reductionResult: ProviderResult<CapabilityReduction>;
  try {
    reductionResult = await providers.reducer.execute({
      contexts: { subject, target },
      failure_analysis: failureAnalysis,
      prior_raw_output: rawAttempt,
      structural_error: handoffFailure.message,
      valid_subject_evidence_ids: idsFromContext(subject),
      valid_target_requirement_ids: idsFromContext(target)
    });
  } catch (error) {
    if (!(error instanceof ProviderExecutionError) || error.provider !== "anthropic") throw error;
    const rawPath = await writeJsonArtifact(outputDir, "raw-04-capability-reduction-attempt-2.json", error.raw_output ?? {});
    const errorPath = await writeYamlArtifact(outputDir, "04-capability-reduction-attempt-2-error.yaml", {
      handoff_failure: {
        ...handoffFailure,
        attempt: 2,
        message: error.message,
        raw_output_ref: artifactRef(root, rawPath),
        created_at: new Date().toISOString()
      }
    });
    records.push(
      stageRecord({
        type: "capability_reduction",
        input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact), artifactRef(root, failureAnalysisArtifact)],
        output_ref: artifactRef(root, errorPath),
        raw_output_ref: artifactRef(root, rawPath),
        provider: "anthropic",
        model: "unknown",
        prompt_version: "reduce.anthropic.recovery.v1",
        schema_version: "corus.capabilities.v1",
        validation_status: "schema_invalid_attempt_2",
        metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
      })
    );
    await writeGenerationRecords(outputDir, records);
    const run: CapabilityAnalysisResponse = {
      run_id: runId,
      status: "recovery_failed",
      mode: "live",
      contexts: { subject, target },
      capabilities: [],
      validation: emptyValidation("recovery_failed"),
      projection: null,
      generation_records: records,
      artifact_dir: artifactDir,
      handoff_failure: handoffFailure,
      failure_analysis: failureAnalysis
    };
    return { run_id: runId, status: "recovery_failed", provider_failure_classification: initialClassification, artifact_dir: artifactDir, run };
  }

  const reduction = reductionResult.output;
  const capabilitiesArtifact = await writeYamlArtifact(outputDir, "04-capabilities-recovered.yaml", reduction);
  const reductionRawArtifact = reductionResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-04-capability-reduction-attempt-2.json", reductionResult.raw_output)
    : undefined;
  records.push(
    stageRecord({
      type: "capability_reduction",
      input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact), artifactRef(root, failureAnalysisArtifact)],
      output_ref: artifactRef(root, capabilitiesArtifact),
      raw_output_ref: reductionRawArtifact ? artifactRef(root, reductionRawArtifact) : undefined,
      provider: reductionResult.provider,
      model: reductionResult.model,
      prompt_version: reductionResult.prompt_version,
      schema_version: "corus.capabilities.v1",
      validation_status: "schema_valid_attempt_2",
      metrics: reductionResult.metrics
    })
  );

  const validationResult = await providers.validator.execute({ capabilities: reduction.capabilities, contexts: { subject, target } });
  const validation = validationResult.output;
  const validationArtifact = await writeYamlArtifact(outputDir, "05-semantic-validation.yaml", { validation });
  const validationRawArtifact = validationResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-05-semantic-validation-provider.json", validationResult.raw_output)
    : undefined;
  records.push(
    stageRecord({
      type: "capability_validation",
      input_refs: [artifactRef(root, capabilitiesArtifact), artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
      output_ref: artifactRef(root, validationArtifact),
      raw_output_ref: validationRawArtifact ? artifactRef(root, validationRawArtifact) : undefined,
      provider: validationResult.provider,
      model: validationResult.model,
      prompt_version: validationResult.prompt_version,
      schema_version: "corus.validation.v1",
      validation_status: validation.status,
      metrics: validationResult.metrics
    })
  );

  let projection: CapabilityAnalysisResponse["projection"] = null;
  if (validation.status === "passed") {
    projection = projectValidatedCapabilities(reduction.capabilities, validation, "capability_assessment");
    const projectionArtifact = await writeMarkdownArtifact(outputDir, "06-projection.md", projection.content);
    records.push(
      stageRecord({
        type: "projection",
        input_refs: [artifactRef(root, validationArtifact), artifactRef(root, capabilitiesArtifact)],
        output_ref: artifactRef(root, projectionArtifact),
        provider: "codex",
        model: "deterministic-projection",
        prompt_version: "projection.v1",
        schema_version: "corus.projection.v1",
        validation_status: validation.status,
        metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0, measurement_source: "measured" }
      })
    );
  }

  const run: CapabilityAnalysisResponse = {
    run_id: runId,
    status: validation.status,
    mode: "live",
    contexts: { subject, target },
    capabilities: reduction.capabilities,
    validation,
    projection,
    generation_records: records,
    artifact_dir: artifactDir,
    handoff_failure: handoffFailure,
    failure_analysis: failureAnalysis
  };
  await writeGenerationRecords(outputDir, records);

  if (projection) {
    const baselineRef = "test/fixtures/prophet/jeremy_prophet_senior_product_manager_capabilities.yaml";
    const baseline = parse(await fs.readFile(path.join(root, baselineRef), "utf8"));
    const report = evaluateCapabilityRun({ run, baseline, fixture: "prophet", baselineRef });
    await writeYamlArtifact(outputDir, "07-evaluation.yaml", report);
  }

  return { run_id: runId, status: run.status, provider_failure_classification: initialClassification, artifact_dir: artifactDir, run };
}
