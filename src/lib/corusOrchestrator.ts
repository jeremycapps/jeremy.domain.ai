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
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput
} from "../types.js";
import { readSourceInput, sourceRefFromInput } from "./corusContext.js";
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
import { MockCapabilityReductionProvider, MockContextualizationProvider, MockValidationProvider } from "../providers/mockProviders.js";
import { AnthropicCapabilityReductionProvider, GeminiContextualizationProvider, OpenAIValidationProvider, providerReadiness } from "../providers/liveProviders.js";
import { ProviderConfigurationError, ProviderExecutionError } from "../providers/errors.js";

export interface CapabilityProviders {
  contextualizer: AgentProvider<ContextualizeInput, Context>;
  reducer: AgentProvider<ReduceCapabilitiesInput, CapabilityReduction>;
  validator: AgentProvider<ValidateCapabilitiesInput, CapabilityValidation>;
}

async function executeProviderStage<T>(
  outputDir: string,
  rawErrorFilename: string,
  operation: () => Promise<ProviderResult<T>>
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
    throw error;
  }
}

export function providersForMode(mode: CorusExecutionMode): CapabilityProviders {
  if (mode === "live") {
    return {
      contextualizer: new GeminiContextualizationProvider(),
      reducer: new AnthropicCapabilityReductionProvider(),
      validator: new OpenAIValidationProvider()
    };
  }

  return {
    contextualizer: new MockContextualizationProvider(),
    reducer: new MockCapabilityReductionProvider(),
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
    artifact_dir: input.artifactDir
  };
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
    providers.contextualizer.execute({
      source: subjectSource,
      kind: "subject",
      position: "subject",
      input_ref: subjectRef
    })
  );
  const subjectArtifact = await writeYamlArtifact(outputDir, "01-subject-context.yaml", { context: subjectResult.output });
  const subjectRawArtifact = subjectResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-01-subject-context-provider.json", subjectResult.raw_output)
    : undefined;
  records.push(
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
    providers.contextualizer.execute({
      source: targetSource,
      kind: "target",
      position: "target",
      input_ref: targetRef
    })
  );
  const targetArtifact = await writeYamlArtifact(outputDir, "01-target-context.yaml", { context: targetResult.output });
  const targetRawArtifact = targetResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-01-target-context-provider.json", targetResult.raw_output)
    : undefined;
  records.push(
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

  const reductionResult = await executeProviderStage(outputDir, "raw-02-capabilities-provider-error.json", () =>
    providers.reducer.execute({ contexts: { subject: subjectResult.output, target: targetResult.output } })
  );
  let reduction = reductionResult.output;
  let capabilitiesArtifact = await writeYamlArtifact(outputDir, "02-capabilities.yaml", reduction);
  let reductionRawArtifact = reductionResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-02-capabilities-provider.json", reductionResult.raw_output)
    : undefined;
  records.push(
    stageRecord({
      type: "capability_reduction",
      input_refs: [artifactRef(root, subjectArtifact), artifactRef(root, targetArtifact)],
      output_ref: artifactRef(root, capabilitiesArtifact),
      raw_output_ref: reductionRawArtifact ? artifactRef(root, reductionRawArtifact) : undefined,
      provider: reductionResult.provider,
      model: reductionResult.model,
      prompt_version: reductionResult.prompt_version,
      schema_version: "corus.capabilities.v1",
      validation_status: "unvalidated",
      metrics: reductionResult.metrics
    })
  );

  let validationResult = await executeProviderStage(outputDir, "raw-03-validation-provider-error.json", () =>
    providers.validator.execute({
      capabilities: reduction.capabilities,
      contexts: { subject: subjectResult.output, target: targetResult.output }
    })
  );
  let validation = validationResult.output;
  let validationArtifact = await writeYamlArtifact(outputDir, "03-validation.yaml", { validation });
  let validationRawArtifact = validationResult.raw_output
    ? await writeJsonArtifact(outputDir, "raw-03-validation-provider.json", validationResult.raw_output)
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

  if (validation.status === "revise") {
    const revisedReduction = await executeProviderStage(outputDir, "raw-02-capabilities-revision-provider-error.json", () =>
      providers.reducer.execute({
        contexts: { subject: subjectResult.output, target: targetResult.output },
        previous_capabilities: reduction.capabilities,
        revision_findings: validation.findings
      })
    );
    reduction = revisedReduction.output;
    capabilitiesArtifact = await writeYamlArtifact(outputDir, "02-capabilities.yaml", reduction);
    reductionRawArtifact = revisedReduction.raw_output
      ? await writeJsonArtifact(outputDir, "raw-02-capabilities-revision-provider.json", revisedReduction.raw_output)
      : undefined;
    records.push(
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
      })
    );
    validation = validationResult.output;
    validationArtifact = await writeYamlArtifact(outputDir, "03-validation.yaml", { validation });
    validationRawArtifact = validationResult.raw_output
      ? await writeJsonArtifact(outputDir, "raw-03-validation-revision-provider.json", validationResult.raw_output)
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
  }

  if (validation.status === "architect_required" || validation.status === "failed") {
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
      records
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
      records
    });
  }

  const projection = projectValidatedCapabilities(reduction.capabilities, validation, request.projection ?? "capability_assessment");
  const projectionArtifact = await writeMarkdownArtifact(outputDir, "04-projection.md", projection.content);
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
      metrics: { input_tokens: null, output_tokens: null, estimated_cost_usd: null, latency_ms: 0 }
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
    artifact_dir: artifactRef(root, outputDir)
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
