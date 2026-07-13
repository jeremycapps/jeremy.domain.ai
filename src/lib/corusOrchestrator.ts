import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  CapabilityAnalysisRequest,
  CapabilityAnalysisResponse,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  CorusExecutionMode,
  FailureAnalysis,
  FailureAnalysisInput,
  HandoffFailure,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../types.js";
import { isStructuredContextLedger, normalizeContext, readSourceInput, sourceRefFromInput } from "./corusContext.js";
import {
  artifactRef,
  createRunDirectory,
  stageRecord,
  writeGenerationRecords,
  writeJsonArtifact,
  writeMarkdownArtifact,
  writeYamlArtifact
} from "./corusArtifacts.js";
import { projectValidatedCapabilities } from "./corusProjection.js";
import { getProjectRoot } from "./paths.js";
import { MockCapabilityReductionProvider, MockContextualizationProvider, MockFailureAnalysisProvider, MockValidationProvider } from "../providers/mockProviders.js";
import {
  AnthropicCapabilityReductionProvider,
  expectedCapabilityReductionSchema,
  GeminiContextualizationProvider,
  OpenAIFailureAnalysisProvider,
  OpenAIValidationProvider,
  providerReadiness
} from "../providers/liveProviders.js";
import { ProviderConfigurationError, ProviderExecutionError } from "../providers/errors.js";
import { emptyMetrics } from "../providers/providerUtils.js";
import { validateContextOutput } from "../providers/validators.js";

export interface CapabilityProviders {
  contextualizer: AgentProvider<ContextualizeInput, Context>;
  reducer: AgentProvider<ReduceCapabilitiesInput, CapabilityReduction>;
  failureAnalyzer: AgentProvider<FailureAnalysisInput, FailureAnalysis>;
  validator: AgentProvider<ValidateCapabilitiesInput, CapabilityValidation>;
}

async function executeProviderStage<T>(
  outputDir: string,
  rawErrorFilename: string,
  operation: () => Promise<ProviderResult<T>>,
  checkpoint?: {
    root: string;
    records: CapabilityAnalysisResponse["generation_records"];
    type: CapabilityAnalysisResponse["generation_records"][number]["type"];
    input_refs: string[];
    provider: string;
    model: string;
    prompt_version: string;
    schema_version: string;
  }
): Promise<ProviderResult<T>> {
  try {
    return await operation();
  } catch (error) {
    const rawOutput = error instanceof ProviderExecutionError ? error.raw_output : undefined;
    if (rawOutput !== undefined) {
      await writeJsonArtifact(outputDir, rawErrorFilename, rawOutput);
    }
    await writeYamlArtifact(outputDir, rawErrorFilename.replace(/^raw-/, "error-").replace(/\.json$/, ".yaml"), {
      created_at: new Date().toISOString(),
      status: "error",
      provider: error instanceof ProviderExecutionError ? error.provider : undefined,
      message: error instanceof Error ? error.message : "Unknown provider error."
    });
    if (checkpoint) {
      const metadata = error instanceof ProviderExecutionError ? error.metadata : undefined;
      checkpoint.records.push(
        stageRecord({
          type: checkpoint.type,
          input_refs: checkpoint.input_refs,
          output_ref: artifactRef(checkpoint.root, pathFromOutputDir(outputDir, rawErrorFilename.replace(/^raw-/, "error-").replace(/\.json$/, ".yaml"))),
          raw_output_ref: rawOutput !== undefined ? artifactRef(checkpoint.root, pathFromOutputDir(outputDir, rawErrorFilename)) : undefined,
          provider: error instanceof ProviderExecutionError ? error.provider : checkpoint.provider,
          model: metadata?.model ?? checkpoint.model,
          prompt_version: metadata?.prompt_version ?? checkpoint.prompt_version,
          schema_version: metadata?.schema_version ?? checkpoint.schema_version,
          validation_status: "error",
          metrics: metadata?.metrics ?? {
            input_tokens: null,
            output_tokens: null,
            estimated_cost_usd: null,
            latency_ms: null,
            measurement_source: "unavailable"
          }
        })
      );
      await writeGenerationRecords(outputDir, checkpoint.records);
    }
    throw error;
  }
}

function pathFromOutputDir(outputDir: string, filename: string): string {
  return `${outputDir}/${filename}`;
}

async function checkpointRecord(
  outputDir: string,
  records: CapabilityAnalysisResponse["generation_records"],
  record: CapabilityAnalysisResponse["generation_records"][number]
) {
  records.push(record);
  await writeGenerationRecords(outputDir, records);
}

function preserveStructuredContextLedger(input: ContextualizeInput): ProviderResult<Context> | undefined {
  if (!isStructuredContextLedger(input.source)) return undefined;
  const startedAt = Date.now();
  const output = validateContextOutput(normalizeContext(input.source, input.kind, input.position, input.input_ref), "fixture");
  output.generation.provider = "fixture";
  output.generation.model = "structured-context-ledger";
  output.generation.prompt_version = "contextualize.preserve-ledger.v1";
  return {
    output,
    provider: "fixture",
    model: "structured-context-ledger",
    prompt_version: "contextualize.preserve-ledger.v1",
    metrics: emptyMetrics(startedAt)
  };
}

async function contextualizeSource(input: ContextualizeInput, contextualizer: AgentProvider<ContextualizeInput, Context>): Promise<ProviderResult<Context>> {
  return preserveStructuredContextLedger(input) ?? contextualizer.execute(input);
}

export function providersForMode(mode: CorusExecutionMode): CapabilityProviders {
  if (mode === "live") {
    return {
      contextualizer: new GeminiContextualizationProvider(),
      reducer: new AnthropicCapabilityReductionProvider(),
      failureAnalyzer: new OpenAIFailureAnalysisProvider(),
      validator: new OpenAIValidationProvider()
    };
  }

  return {
    contextualizer: new MockContextualizationProvider(),
    reducer: new MockCapabilityReductionProvider(),
    failureAnalyzer: new MockFailureAnalysisProvider(),
    validator: new MockValidationProvider()
  };
}

function failedResponse(input: {
  runId: string;
  mode: CorusExecutionMode;
  status: CapabilityValidation["status"];
  subject: Context;
  target: Context;
  reduction: CapabilityReduction;
  validation: CapabilityValidation;
  artifactDir: string;
  records: CapabilityAnalysisResponse["generation_records"];
  handoffFailure?: HandoffFailure;
  failureAnalysis?: FailureAnalysis;
}): CapabilityAnalysisResponse {
  return {
    run_id: input.runId,
    status: input.status,
    mode: input.mode,
    contexts: { subject: input.subject, target: input.target },
    capabilities: input.reduction.capabilities,
    validation: input.validation,
    projection: null,
    generation_records: input.records,
    artifact_dir: input.artifactDir,
    handoff_failure: input.handoffFailure,
    failure_analysis: input.failureAnalysis
  };
}

function idsFromContext(context: Context): string[] {
  const contexts = context.content.contexts;
  if (!Array.isArray(contexts)) return [];
  return contexts
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

async function persistReductionFailure(input: {
  root: string;
  outputDir: string;
  runId: string;
  attempt: number;
  error: ProviderExecutionError;
  subjectArtifact: string;
  targetArtifact: string;
}): Promise<{ handoffFailure: HandoffFailure; rawOutputRef: string; errorRef: string }> {
  const rawName = input.attempt === 1 ? "raw-02-capability-reduction-attempt-1.json" : "raw-04-capability-reduction-attempt-2.json";
  const errorName = input.attempt === 1 ? "02-capability-reduction-attempt-1-error.yaml" : "04-capability-reduction-attempt-2-error.yaml";
  const rawPath = await writeJsonArtifact(input.outputDir, rawName, input.error.raw_output ?? {});
  const rawOutputRef = artifactRef(input.root, rawPath);
  const handoffFailure: HandoffFailure = {
    id: randomUUID(),
    run_id: input.runId,
    stage: "capability_reduction",
    provider: "anthropic",
    attempt: input.attempt,
    failure_type: "schema_validation",
    message: input.error.message,
    expected_schema_ref: "corus.capability_reduction.v1",
    raw_output_ref: rawOutputRef,
    subject_context_ref: artifactRef(input.root, input.subjectArtifact),
    target_context_ref: artifactRef(input.root, input.targetArtifact),
    created_at: new Date().toISOString()
  };
  const errorPath = await writeYamlArtifact(input.outputDir, errorName, { handoff_failure: handoffFailure });
  return { handoffFailure, rawOutputRef, errorRef: artifactRef(input.root, errorPath) };
}

export async function runCapabilityAnalysis(
  request: CapabilityAnalysisRequest,
  options: { root?: string; providers?: CapabilityProviders } = {}
): Promise<CapabilityAnalysisResponse> {
  const root = options.root ?? getProjectRoot();
  const mode = request.mode ?? "mocked";
  const readiness = providerReadiness(mode);
  if (!readiness.ready) {
    throw new ProviderConfigurationError("readiness", `Missing credentials for live mode: ${readiness.missing_credentials.join(", ")}`);
  }

  const providers = options.providers ?? providersForMode(mode);
  const runId = randomUUID();
  const outputDir = await createRunDirectory(runId, root);
  const records: CapabilityAnalysisResponse["generation_records"] = [];
  const subjectRef = sourceRefFromInput(request.subject_source, "subject_source");
  const targetRef = sourceRefFromInput(request.target_source, "target_source");
  const subjectSource = await readSourceInput(request.subject_source, root);
  const targetSource = await readSourceInput(request.target_source, root);

  const subjectResult = await executeProviderStage(outputDir, "raw-01-subject-context-provider-error.json", () =>
    contextualizeSource(
      {
        source: subjectSource,
        kind: "subject",
        position: "subject",
        input_ref: subjectRef
      },
      providers.contextualizer
    )
  );
  const subjectArtifact = await writeYamlArtifact(outputDir, "01-subject-context.yaml", { context: subjectResult.output });
  const subjectRawArtifact = subjectResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-01-subject-context-provider.json", subjectResult.raw_output)
    : undefined;
  await checkpointRecord(
    outputDir,
    records,
    stageRecord({
      type: "contextualization",
      input_refs: [subjectRef],
      output_ref: artifactRef(root, subjectArtifact),
      raw_output_ref: subjectRawArtifact ? artifactRef(root, subjectRawArtifact) : undefined,
      provider: subjectResult.provider,
      model: subjectResult.model,
      prompt_version: subjectResult.prompt_version,
      schema_version: subjectResult.output.generation.schema_version,
      validation_status: "created",
      metrics: subjectResult.metrics
    })
  );

  const targetResult = await executeProviderStage(outputDir, "raw-01-target-context-provider-error.json", () =>
    contextualizeSource(
      {
        source: targetSource,
        kind: "target",
        position: "target",
        input_ref: targetRef
      },
      providers.contextualizer
    )
  );
  const targetArtifact = await writeYamlArtifact(outputDir, "01-target-context.yaml", { context: targetResult.output });
  const targetRawArtifact = targetResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-01-target-context-provider.json", targetResult.raw_output)
    : undefined;
  await checkpointRecord(
    outputDir,
    records,
    stageRecord({
      type: "contextualization",
      input_refs: [targetRef],
      output_ref: artifactRef(root, targetArtifact),
      raw_output_ref: targetRawArtifact ? artifactRef(root, targetRawArtifact) : undefined,
      provider: targetResult.provider,
      model: targetResult.model,
      prompt_version: targetResult.prompt_version,
      schema_version: targetResult.output.generation.schema_version,
      validation_status: "created",
      metrics: targetResult.metrics
    })
  );

  let handoffFailure: HandoffFailure | undefined;
  let failureAnalysis: FailureAnalysis | undefined;
  let reductionResult: ProviderResult<CapabilityReduction>;

  try {
    reductionResult = await providers.reducer.execute({ contexts: { subject: subjectResult.output, target: targetResult.output } });
  } catch (error) {
    if (!(error instanceof ProviderExecutionError) || error.provider !== "anthropic") throw error;
    const persistedFailure = await persistReductionFailure({
      root,
      outputDir,
      runId,
      attempt: 1,
      error,
      subjectArtifact,
      targetArtifact
    });
    handoffFailure = persistedFailure.handoffFailure;
    await checkpointRecord(
      outputDir,
      records,
      stageRecord({
        type: "capability_reduction",
        input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
        output_ref: persistedFailure.errorRef,
        raw_output_ref: persistedFailure.rawOutputRef,
        provider: "anthropic",
        model: "unknown",
        prompt_version: "reduce.anthropic.v1",
        schema_version: "corus.capabilities.v1",
        validation_status: "schema_invalid_attempt_1",
        metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
      })
    );

    const failureAnalysisInput: FailureAnalysisInput = {
      handoff_failure: handoffFailure,
      expected_schema: expectedCapabilityReductionSchema(),
      raw_provider_output: error.raw_output ?? {},
      valid_subject_evidence_ids: idsFromContext(subjectResult.output),
      valid_target_requirement_ids: idsFromContext(targetResult.output)
    };
    let failureAnalysisResult: ProviderResult<FailureAnalysis>;
    try {
      failureAnalysisResult = await providers.failureAnalyzer.execute(failureAnalysisInput);
    } catch (analysisError) {
      const rawOutput = analysisError instanceof ProviderExecutionError ? analysisError.raw_output : undefined;
      const rawErrorPath =
        rawOutput !== undefined ? await writeJsonArtifact(outputDir, "raw-03-openai-failure-analysis-provider-error.json", rawOutput) : undefined;
      const analysisErrorPath = await writeYamlArtifact(outputDir, "error-03-openai-failure-analysis-provider-error.yaml", {
        created_at: new Date().toISOString(),
        status: "error",
        provider: analysisError instanceof ProviderExecutionError ? analysisError.provider : undefined,
        message: analysisError instanceof Error ? analysisError.message : "Unknown failure-analysis error."
      });
      await checkpointRecord(
        outputDir,
        records,
        stageRecord({
          type: "failure_analysis",
          input_refs: [persistedFailure.errorRef, persistedFailure.rawOutputRef],
          output_ref: artifactRef(root, analysisErrorPath),
          raw_output_ref: rawErrorPath ? artifactRef(root, rawErrorPath) : undefined,
          provider: analysisError instanceof ProviderExecutionError ? analysisError.provider : "openai",
          model: "unknown",
          prompt_version: "failure-analysis.openai.v1",
          schema_version: "corus.failure_analysis.v1",
          validation_status: "error",
          metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
        })
      );
      await writeGenerationRecords(outputDir, records);
      return failedResponse({
        runId,
        mode,
        status: "failed",
        subject: subjectResult.output,
        target: targetResult.output,
        reduction: { reducer: "capabilities", inputs: { subject: subjectResult.output.id, target: targetResult.output.id }, capabilities: [] },
        validation: { status: "failed", findings: [], validated_capability_ids: [], rejected_capability_ids: [] },
        artifactDir: artifactRef(root, outputDir),
        records,
        handoffFailure
      });
    }
    failureAnalysis = failureAnalysisResult.output;
    const failureAnalysisArtifact = await writeYamlArtifact(outputDir, "03-openai-failure-analysis.yaml", { failure_analysis: failureAnalysis });
    const failureAnalysisRawArtifact = failureAnalysisResult.raw_output
      ? await writeJsonArtifact(outputDir, "raw-03-openai-failure-analysis-provider.json", failureAnalysisResult.raw_output)
      : undefined;
    await checkpointRecord(
      outputDir,
      records,
      stageRecord({
        type: "failure_analysis",
        input_refs: [persistedFailure.errorRef, persistedFailure.rawOutputRef],
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
      return failedResponse({
        runId,
        mode,
        status,
        subject: subjectResult.output,
        target: targetResult.output,
        reduction: { reducer: "capabilities", inputs: { subject: subjectResult.output.id, target: targetResult.output.id }, capabilities: [] },
        validation: { status, findings: [], validated_capability_ids: [], rejected_capability_ids: [] },
        artifactDir: artifactRef(root, outputDir),
        records,
        handoffFailure,
        failureAnalysis
      });
    }

    try {
      reductionResult = await providers.reducer.execute({
        contexts: { subject: subjectResult.output, target: targetResult.output },
        failure_analysis: failureAnalysis,
        prior_raw_output: error.raw_output ?? {},
        structural_error: error.message,
        valid_subject_evidence_ids: idsFromContext(subjectResult.output),
        valid_target_requirement_ids: idsFromContext(targetResult.output)
      });
    } catch (retryError) {
      if (!(retryError instanceof ProviderExecutionError) || retryError.provider !== "anthropic") throw retryError;
      const persistedRetryFailure = await persistReductionFailure({
        root,
        outputDir,
        runId,
        attempt: 2,
        error: retryError,
        subjectArtifact,
        targetArtifact
      });
      await checkpointRecord(
        outputDir,
        records,
        stageRecord({
          type: "capability_reduction",
          input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact), artifactRef(root, failureAnalysisArtifact)],
          output_ref: persistedRetryFailure.errorRef,
          raw_output_ref: persistedRetryFailure.rawOutputRef,
          provider: "anthropic",
          model: "unknown",
          prompt_version: "reduce.anthropic.recovery.v1",
          schema_version: "corus.capabilities.v1",
          validation_status: "schema_invalid_attempt_2",
          metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: null, measurement_source: "unavailable" }
        })
      );
      await writeGenerationRecords(outputDir, records);
      return failedResponse({
        runId,
        mode,
        status: "recovery_failed",
        subject: subjectResult.output,
        target: targetResult.output,
        reduction: { reducer: "capabilities", inputs: { subject: subjectResult.output.id, target: targetResult.output.id }, capabilities: [] },
        validation: { status: "recovery_failed", findings: [], validated_capability_ids: [], rejected_capability_ids: [] },
        artifactDir: artifactRef(root, outputDir),
        records,
        handoffFailure,
        failureAnalysis
      });
    }
  }
  let reduction = reductionResult.output;
  let capabilitiesArtifact = await writeYamlArtifact(outputDir, handoffFailure ? "04-capabilities-recovered.yaml" : "02-capabilities.yaml", reduction);
  let reductionRawArtifact = reductionResult.raw_output
    ? await writeJsonArtifact(outputDir, handoffFailure ? "raw-04-capability-reduction-attempt-2.json" : "raw-02-capabilities-provider.json", reductionResult.raw_output)
    : undefined;
  await checkpointRecord(
    outputDir,
    records,
    stageRecord({
      type: "capability_reduction",
      input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
      output_ref: artifactRef(root, capabilitiesArtifact),
      raw_output_ref: reductionRawArtifact ? artifactRef(root, reductionRawArtifact) : undefined,
      provider: reductionResult.provider,
      model: reductionResult.model,
      prompt_version: reductionResult.prompt_version,
      schema_version: "corus.capabilities.v1",
      validation_status: handoffFailure ? "schema_valid_attempt_2" : "unvalidated",
      metrics: reductionResult.metrics
    })
  );

  let validationResult = await executeProviderStage(outputDir, "raw-03-validation-provider-error.json", () =>
    providers.validator.execute({
      capabilities: reduction.capabilities,
      contexts: { subject: subjectResult.output, target: targetResult.output }
    }),
    {
      root,
      records,
      type: "capability_validation",
      input_refs: [artifactRef(root, capabilitiesArtifact), artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
      provider: "openai",
      model: "unknown",
      prompt_version: "validate.openai.v1",
      schema_version: "corus.validation.v1"
    }
  );
  let validation = validationResult.output;
  let validationArtifact = await writeYamlArtifact(outputDir, handoffFailure ? "05-semantic-validation.yaml" : "03-validation.yaml", { validation });
  let validationRawArtifact = validationResult.raw_output
    ? await writeJsonArtifact(outputDir, handoffFailure ? "raw-05-semantic-validation-provider.json" : "raw-03-validation-provider.json", validationResult.raw_output)
    : undefined;
  await checkpointRecord(
    outputDir,
    records,
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

  if (validation.status === "revise") {
    const revisedReduction = await executeProviderStage(outputDir, "raw-02-capabilities-revision-provider-error.json", () =>
      providers.reducer.execute({
        contexts: { subject: subjectResult.output, target: targetResult.output },
        previous_capabilities: reduction.capabilities,
        revision_findings: validation.findings
      }),
      {
        root,
        records,
        type: "capability_reduction",
        input_refs: [artifactRef(root, validationArtifact)],
        provider: "anthropic",
        model: "unknown",
        prompt_version: "reduce.anthropic.v1",
        schema_version: "corus.capabilities.v1"
      }
    );
    reduction = revisedReduction.output;
    capabilitiesArtifact = await writeYamlArtifact(outputDir, "02-capabilities.yaml", reduction);
    reductionRawArtifact = revisedReduction.raw_output
      ? await writeJsonArtifact(outputDir, "raw-02-capabilities-revision-provider.json", revisedReduction.raw_output)
      : undefined;
    await checkpointRecord(
      outputDir,
      records,
      stageRecord({
        type: "capability_reduction",
        input_refs: [artifactRef(root, validationArtifact)],
        output_ref: artifactRef(root, capabilitiesArtifact),
        raw_output_ref: reductionRawArtifact ? artifactRef(root, reductionRawArtifact) : undefined,
        provider: revisedReduction.provider,
        model: revisedReduction.model,
        prompt_version: revisedReduction.prompt_version,
        schema_version: "corus.capabilities.v1",
        validation_status: "revised",
        metrics: revisedReduction.metrics
      })
    );

    validationResult = await executeProviderStage(outputDir, "raw-03-validation-revision-provider-error.json", () =>
      providers.validator.execute({
        capabilities: reduction.capabilities,
        contexts: { subject: subjectResult.output, target: targetResult.output }
      }),
      {
        root,
        records,
        type: "capability_validation",
        input_refs: [artifactRef(root, capabilitiesArtifact), artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
        provider: "openai",
        model: "unknown",
        prompt_version: "validate.openai.v1",
        schema_version: "corus.validation.v1"
      }
    );
    validation = validationResult.output;
    validationArtifact = await writeYamlArtifact(outputDir, "03-validation.yaml", { validation });
    validationRawArtifact = validationResult.raw_output
      ? await writeJsonArtifact(outputDir, "raw-03-validation-revision-provider.json", validationResult.raw_output)
      : undefined;
    await checkpointRecord(
      outputDir,
      records,
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
  }

  if (validation.status === "architect_required") {
    await writeYamlArtifact(outputDir, handoffFailure ? "06-architect-decision.yaml" : "04-architect-decision.yaml", {
      status: "architect_required",
      validation,
      decision: "Architect review required before semantic recommendation can be implemented."
    });
    await writeGenerationRecords(outputDir, records);
    return failedResponse({
      runId,
      mode,
      status: validation.status,
      subject: subjectResult.output,
      target: targetResult.output,
      reduction,
      validation,
      artifactDir: artifactRef(root, outputDir),
      records,
      handoffFailure,
      failureAnalysis
    });
  }

  if (validation.status === "failed") {
    await writeGenerationRecords(outputDir, records);
    return failedResponse({
      runId,
      mode,
      status: validation.status,
      subject: subjectResult.output,
      target: targetResult.output,
      reduction,
      validation,
      artifactDir: artifactRef(root, outputDir),
      records,
      handoffFailure,
      failureAnalysis
    });
  }

  if (validation.status !== "passed") {
    await writeGenerationRecords(outputDir, records);
    return failedResponse({
      runId,
      mode,
      status: validation.status,
      subject: subjectResult.output,
      target: targetResult.output,
      reduction,
      validation,
      artifactDir: artifactRef(root, outputDir),
      records,
      handoffFailure,
      failureAnalysis
    });
  }

  const projection = projectValidatedCapabilities(reduction.capabilities, validation, request.projection ?? "capability_assessment");
  const projectionArtifact = await writeMarkdownArtifact(outputDir, handoffFailure ? "06-projection.md" : "04-projection.md", projection.content);
  await checkpointRecord(
    outputDir,
    records,
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
  await writeGenerationRecords(outputDir, records);

  return {
    run_id: runId,
    status: "passed",
    mode,
    contexts: { subject: subjectResult.output, target: targetResult.output },
    capabilities: reduction.capabilities,
    validation,
    projection,
    generation_records: records,
    artifact_dir: artifactRef(root, outputDir),
    handoff_failure: handoffFailure,
    failure_analysis: failureAnalysis
  };
}

export function structuredProviderError(error: unknown, stage?: string) {
  if (error instanceof ProviderConfigurationError || error instanceof ProviderExecutionError) {
    return {
      message: error.message,
      provider: error.provider,
      stage
    };
  }

  return {
    message: error instanceof Error ? error.message : "Unknown capability-analysis error.",
    stage
  };
}
