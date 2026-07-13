import type {
  AgentProvider,
  CapabilityCandidate,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  FailureAnalysis,
  FailureAnalysisInput,
  JobRequirementClusteringInput,
  JobRequirementClusterRepairInput,
  JobRequirementClusters,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput,
  ValidationFinding
} from "../types.js";
import { contextRefs, normalizeContext } from "../lib/corusContext.js";
import { emptyMetrics } from "./providerUtils.js";
import { ProviderExecutionError } from "./errors.js";

function providerResult<T>(output: T, provider: string, model: string, promptVersion: string, startedAt: number): ProviderResult<T> {
  return {
    output,
    provider,
    model,
    prompt_version: promptVersion,
    metrics: emptyMetrics(startedAt)
  };
}

export class MockContextualizationProvider implements AgentProvider<ContextualizeInput, Context> {
  async execute(input: ContextualizeInput): Promise<ProviderResult<Context>> {
    const startedAt = Date.now();
    const context = normalizeContext(input.source, input.kind, input.position, input.input_ref);
    context.generation = {
      ...context.generation,
      provider: "google",
      model: "mock-gemini-contextualizer",
      prompt_version: "contextualize.mock.v1"
    };
    return providerResult(context, "google", "mock-gemini-contextualizer", "contextualize.mock.v1", startedAt);
  }
}

function firstContextId(context: Context, fallback: string): string {
  return [...contextRefs(context)][0] ?? fallback;
}

export class MockCapabilityReductionProvider implements AgentProvider<ReduceCapabilitiesInput, CapabilityReduction> {
  public calls: ReduceCapabilitiesInput[] = [];

  async execute(input: ReduceCapabilitiesInput): Promise<ProviderResult<CapabilityReduction>> {
    const startedAt = Date.now();
    this.calls.push(input);
    const subjectRef = firstContextId(input.contexts.subject, `${input.contexts.subject.id}_evidence`);
    const targetRef = firstContextId(input.contexts.target, `${input.contexts.target.id}_requirement`);
    const previous = input.previous_capabilities ?? [];
    const shouldRevise = input.revision_findings && input.revision_findings.length > 0;
    const capabilities: CapabilityCandidate[] = shouldRevise
      ? previous.filter((capability) => capability.support !== "unsupported")
      : [
          {
            id: "cap_product_execution",
            requirement_ref: targetRef,
            statement: "Translate ambiguous product ambition into shipped, testable capability.",
            evidence_refs: [subjectRef],
            support: "supported",
            confidence: "high",
            generated_by: {
              provider: "anthropic",
              model: "mock-claude-reducer",
              prompt_version: "reduce.mock.v1"
            }
          }
        ];

    return providerResult(
      {
        reducer: "capabilities",
        inputs: {
          subject: input.contexts.subject.id,
          target: input.contexts.target.id
        },
        capabilities
      },
      "anthropic",
      "mock-claude-reducer",
      "reduce.mock.v1",
      startedAt
    );
  }
}

export class MockMalformedReductionProvider implements AgentProvider<ReduceCapabilitiesInput, CapabilityReduction> {
  public calls: ReduceCapabilitiesInput[] = [];

  constructor(
    private readonly retryMode: "valid" | "invalid" = "valid",
    private readonly rawOutput: unknown = {
      reducer: "capabilities",
      inputs: { subject: "jeremy", target: "prophet_role" },
      capabilities: [{ id: "cap_missing_requirement", statement: "Malformed", evidence_refs: ["evidence_product_execution"], support: "supported", confidence: "high" }]
    }
  ) {}

  async execute(input: ReduceCapabilitiesInput): Promise<ProviderResult<CapabilityReduction>> {
    const startedAt = Date.now();
    this.calls.push(input);
    if (!input.failure_analysis || this.retryMode === "invalid") {
      throw new ProviderExecutionError("anthropic", "Each capability must include requirement_ref.", this.rawOutput);
    }

    return providerResult(
      {
        reducer: "capabilities",
        inputs: {
          subject: input.contexts.subject.id,
          target: input.contexts.target.id
        },
        capabilities: [
          {
            id: "cap_recovered",
            requirement_ref: input.valid_target_requirement_ids?.[0] ?? "requirement_product_execution",
            statement: "Recovered capability preserves the existing contract.",
            evidence_refs: [input.valid_subject_evidence_ids?.[0] ?? "evidence_product_execution"],
            support: "supported",
            confidence: "high",
            generated_by: {
              provider: "anthropic",
              model: "mock-claude-reducer",
              prompt_version: "reduce.anthropic.recovery.v1"
            }
          }
        ]
      },
      "anthropic",
      "mock-claude-reducer",
      "reduce.anthropic.recovery.v1",
      startedAt
    );
  }
}

export class MockValidationProvider implements AgentProvider<ValidateCapabilitiesInput, CapabilityValidation> {
  constructor(private readonly forced?: CapabilityValidation) {}

  async execute(input: ValidateCapabilitiesInput): Promise<ProviderResult<CapabilityValidation>> {
    const startedAt = Date.now();
    if (this.forced) {
      return providerResult(this.forced, "openai", "mock-openai-validator", "validate.mock.v1", startedAt);
    }

    const subjectRefs = contextRefs(input.contexts.subject);
    const targetRefs = contextRefs(input.contexts.target);
    const findings: ValidationFinding[] = [];
    const validated: string[] = [];
    const rejected: string[] = [];

    for (const capability of input.capabilities) {
      const evidenceMissing = capability.evidence_refs.some((ref) => !subjectRefs.has(ref));
      const requirementMissing = !targetRefs.has(capability.requirement_ref);
      if (capability.support === "unsupported") {
        findings.push({
          capability_id: capability.id,
          severity: "error",
          type: "unsupported_capability",
          message: "Unsupported capabilities cannot pass validation."
        });
        rejected.push(capability.id);
      } else if (evidenceMissing) {
        findings.push({
          capability_id: capability.id,
          severity: "error",
          type: "fabricated_evidence_reference",
          message: "Capability cites evidence not present in the subject context."
        });
        rejected.push(capability.id);
      } else if (requirementMissing) {
        findings.push({
          capability_id: capability.id,
          severity: "error",
          type: "fabricated_requirement",
          message: "Capability maps to a requirement not present in the target context."
        });
        rejected.push(capability.id);
      } else {
        validated.push(capability.id);
      }
    }

    const output: CapabilityValidation = {
      status: findings.length > 0 ? "failed" : "passed",
      findings,
      validated_capability_ids: validated,
      rejected_capability_ids: rejected
    };

    return providerResult(output, "openai", "mock-openai-validator", "validate.mock.v1", startedAt);
  }
}

export class MockFailureAnalysisProvider implements AgentProvider<FailureAnalysisInput, FailureAnalysis> {
  public calls: FailureAnalysisInput[] = [];

  constructor(private readonly status: FailureAnalysis["status"] = "correctable") {}

  async execute(input: FailureAnalysisInput): Promise<ProviderResult<FailureAnalysis>> {
    const startedAt = Date.now();
    this.calls.push(input);
    const output: FailureAnalysis = {
      status: this.status,
      failed_stage: "capability_reduction",
      failure_type: "schema_validation",
      diagnosis: "Claude omitted a required capability field.",
      corrections:
        this.status === "correctable"
          ? [{ field: "capabilities[].requirement_ref", instruction: "Use one supplied target requirement ID.", reason: "The schema requires requirement_ref." }]
          : [],
      retry_stage: this.status === "correctable" ? "capability_reduction" : null,
      architecture_change_required: this.status === "architect_required",
      confidence: "high"
    };
    return providerResult(output, "openai", "mock-openai-failure-analyzer", "failure-analysis.mock.v1", startedAt);
  }
}

function requirementIdsFromJobDescription(input: JobRequirementClusteringInput): string[] {
  const contexts = input.job_description.content.contexts;
  if (!Array.isArray(contexts)) return [];
  return contexts
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

export class MockJobRequirementClusteringProvider implements AgentProvider<JobRequirementClusteringInput, JobRequirementClusters> {
  public calls: JobRequirementClusteringInput[] = [];

  constructor(private readonly mode: "valid" | "provider_incomplete" | "schema_invalid" = "valid", private readonly forcedOutput?: unknown) {}

  async execute(input: JobRequirementClusteringInput): Promise<ProviderResult<JobRequirementClusters>> {
    const startedAt = Date.now();
    this.calls.push(input);
    if (this.mode === "provider_incomplete") {
      throw new ProviderExecutionError("gemini", "Gemini clustering stopped before emitting a final cluster payload.", {}, { stop_reason: "max_tokens" });
    }
    if (this.forcedOutput) {
      return providerResult(this.forcedOutput as JobRequirementClusters, "gemini", "mock-gemini-clusterer", "cluster-job-requirements.gemini.v1", startedAt);
    }

    const ids = requirementIdsFromJobDescription(input);
    const labels = [
      "Mock cluster 1",
      "Mock cluster 2",
      "Mock cluster 3",
      "Mock cluster 4",
      "Mock cluster 5",
      "Mock cluster 6",
      "Mock cluster 7"
    ];
    const clusters = labels.map((label, index) => {
      const start = index * 5;
      const requirementRefs = ids.slice(start, index === labels.length - 1 ? ids.length : start + 5);
      return {
        id: `cluster.mock_${index + 1}`,
        label,
        requirement_refs: requirementRefs,
        rationale: "Deterministic mock group used to test clustering pipeline mechanics."
      };
    });

    return providerResult(
      {
        schema_version: "corus.job_requirement_clusters.v1",
        job_description_ref: input.job_description_ref,
        clustering_policy_ref: input.policy.id,
        clusters,
        unassigned_requirement_refs: [],
        overlapping_requirements: [],
        generated_by: {
          role: "implementer",
          provider: "gemini",
          model: "mock-gemini-clusterer",
          prompt_version: "cluster-job-requirements.gemini.v1"
        }
      },
      "gemini",
      "mock-gemini-clusterer",
      "cluster-job-requirements.gemini.v1",
      startedAt
    );
  }
}


export class MockJobRequirementClusterRepairProvider implements AgentProvider<JobRequirementClusterRepairInput, JobRequirementClusters> {
  public calls: JobRequirementClusterRepairInput[] = [];

  constructor(private readonly mode: "valid" | "missing_one" = "valid") {}

  async execute(input: JobRequirementClusterRepairInput): Promise<ProviderResult<JobRequirementClusters>> {
    const startedAt = Date.now();
    this.calls.push(input);
    const repaired: JobRequirementClusters = JSON.parse(JSON.stringify(input.previous_proposal));
    repaired.generated_by = {
      role: "implementer",
      provider: "google",
      model: "mock-gemini-repairer",
      prompt_version: "cluster-job-requirements.gemini.repair.v1"
    };
    const targetCluster = repaired.clusters.find((cluster) => cluster.id === "technical_product_fluency") ?? repaired.clusters[0];
    const refs = this.mode === "missing_one" ? input.missing_requirement_refs.slice(0, 2) : input.missing_requirement_refs;
    for (const ref of refs) {
      if (!targetCluster.requirement_refs.includes(ref)) targetCluster.requirement_refs.push(ref);
    }
    return providerResult(repaired, "google", "mock-gemini-repairer", "cluster-job-requirements.gemini.repair.v1", startedAt);
  }
}

export function reviseValidation(findings: ValidationFinding[]): CapabilityValidation {
  return {
    status: "revise",
    findings,
    validated_capability_ids: [],
    rejected_capability_ids: []
  };
}
