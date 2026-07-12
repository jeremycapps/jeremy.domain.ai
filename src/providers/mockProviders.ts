import type {
  AgentProvider,
  CapabilityCandidate,
  CapabilityReduction,
  CapabilityValidation,
  Context,
  ContextualizeInput,
  ProviderResult,
  ReduceCapabilitiesInput,
  ValidateCapabilitiesInput,
  ValidationFinding
} from "../types.js";
import { contextRefs, normalizeContext } from "../lib/corusContext.js";
import { emptyMetrics } from "./providerUtils.js";

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

export function reviseValidation(findings: ValidationFinding[]): CapabilityValidation {
  return {
    status: "revise",
    findings,
    validated_capability_ids: [],
    rejected_capability_ids: []
  };
}
