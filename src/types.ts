export type ResumeMode = "generate" | "route_only" | "validate_only";

export type RouteConfidence = "high" | "medium" | "low";

export type ValidationStatus = "passed" | "failed" | "needs_review";

export type Archetype =
  | "technical_operations"
  | "ai_product_strategy"
  | "implementation_strategy"
  | "customer_success_systems"
  | "product_operations"
  | "general_operator";

export interface GenerateResumeRequest {
  job_description: string;
  options?: {
    mode?: ResumeMode;
    archetype_hint?: string | null;
    use_cache?: boolean;
  };
}

export interface ExperienceUnit {
  id: string;
  title?: string;
  employer?: string;
  role?: string;
  dates?: string;
  tags?: string[];
  tools?: string[];
  bullets?: string[];
  outcomes?: string[];
  [key: string]: unknown;
}

export interface CachedResumeArtifact {
  archetype: string;
  filename: string;
  cache_path: string;
  source_path?: string;
  content: string;
}

export interface FileInventory {
  data_files: string[];
  source_artifact_files: string[];
  cache_files: string[];
  route_files: string[];
  missing_required: string[];
}

export interface RouteDecision {
  archetype: Archetype;
  confidence: RouteConfidence;
  selected_files: string[];
  selected_experience_units: string[];
  reason: string;
}

export interface SelectedContext {
  files: string[];
  cache_files: string[];
  source_files: string[];
  experience_unit_ids: string[];
  used_full_context: boolean;
  selected_context_summary: string;
  units: ExperienceUnit[];
  artifact?: CachedResumeArtifact;
}

export interface EvidenceReport {
  supported_claims: Array<{ claim: string; unit_ids: string[] }>;
  adjacent_claims: Array<{ claim: string; unit_ids: string[]; warning: string }>;
  unsupported_requested_claims: Array<{ claim: string; reason: string }>;
  excluded_experience: Array<{ unit_id: string; reason: string }>;
}

export interface ValidationReport {
  status: ValidationStatus;
  unsupported_claims: Array<{ claim: string; reason: string }>;
  forbidden_claims: Array<{ claim: string; rule: string }>;
  recommended_edits: string[];
}

export interface GenerationRecord {
  id: string;
  created_at: string;
  job_description_hash: string;
  archetype: Archetype;
  selected_files: string[];
  cache_path?: string;
  source_path?: string;
  selected_cache_files: string[];
  selected_source_files: string[];
  selected_experience_units: string[];
  output_file: string;
  validation_status: ValidationStatus | "unvalidated";
  may_use_as: Array<"draft_base" | "style_reference" | "structure_reference">;
  may_not_use_as: Array<"source_truth" | "new_experience_evidence">;
}

export interface ResumeResponse {
  request_id: string;
  status: "ok" | "error";
  route_decision: RouteDecision;
  selected_context: Omit<SelectedContext, "units" | "artifact" | "selected_context_summary"> & {
    selected_context_summary: string;
  };
  resume_markdown: string;
  resume: {
    format: "markdown";
    content: string;
  };
  evidence_report: EvidenceReport;
  validation_report: ValidationReport;
  generation_record: GenerationRecord;
}

export type CorusExecutionMode = "mocked" | "fixture" | "live";
export type ContextPosition = "subject" | "target";
export type CapabilitySupport = "supported" | "adjacent" | "unsupported" | "unknown";
export type CapabilityConfidence = "high" | "medium" | "low";
export type CapabilityValidationStatus = "passed" | "revise" | "architect_required" | "failed" | "recovery_failed";
export type ProjectionKind = "resume" | "capability_assessment";

export interface ContextGenerationMetadata {
  operation: "contextualize";
  provider: string;
  model: string;
  prompt_version: string;
  input_refs: string[];
  schema_version: string;
  created_at: string;
  source_context_count?: number;
  output_context_count?: number;
  measurement_source?: "provider" | "local_preservation";
}

export interface Context {
  id: string;
  kind: string;
  label: string;
  sources: string[];
  content: Record<string, unknown>;
  generation: ContextGenerationMetadata;
}

export interface CapabilityCandidate {
  id: string;
  requirement_ref: string;
  statement: string;
  evidence_refs: string[];
  support: CapabilitySupport;
  confidence: CapabilityConfidence;
  generated_by: {
    provider: string;
    model: string;
    prompt_version: string;
  };
}

export interface CapabilityReduction {
  reducer: "capabilities";
  inputs: {
    subject: string;
    target: string;
  };
  capabilities: CapabilityCandidate[];
}

export interface ValidationFinding {
  capability_id?: string;
  severity: "info" | "warning" | "error";
  type:
    | "unsupported_capability"
    | "evidence_misattribution"
    | "fabricated_requirement"
    | "cross_context_leakage"
    | "claim_exaggeration"
    | "projection_invention"
    | "fabricated_evidence_reference"
    | "schema_error"
    | "product_ambiguity"
    | "correctable_content";
  message: string;
}

export interface CapabilityValidation {
  status: CapabilityValidationStatus;
  findings: ValidationFinding[];
  validated_capability_ids: string[];
  rejected_capability_ids: string[];
}

export interface CapabilityProjection {
  kind: ProjectionKind;
  format: "markdown";
  content: string;
  capability_ids: string[];
}

export interface StageGenerationRecord {
  id: string;
  type:
    | "contextualization"
    | "job_requirement_clustering"
    | "job_requirement_cluster_repair"
    | "cluster_integrity_validation"
    | "repaired_cluster_integrity_validation"
    | "cluster_admission"
    | "capability_reduction"
    | "failure_analysis"
    | "capability_validation"
    | "projection";
  created_at: string;
  started_at?: string;
  completed_at?: string;
  input_refs: string[];
  output_ref: string;
  raw_output_ref?: string;
  provider: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  validation_status: string;
  provider_completion_state?: string | null;
  metrics: {
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens?: number | null;
    estimated_cost_usd: number | null;
    latency_ms: number | null;
    measurement_source: "measured" | "derived" | "unavailable";
  };
  stop_reason?: string | null;
}

export interface ProviderMetrics {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens?: number | null;
  estimated_cost_usd: number | null;
  latency_ms: number | null;
  measurement_source: "measured" | "derived" | "unavailable";
}

export interface ProviderResult<TOutput> {
  output: TOutput;
  raw_output?: unknown;
  provider: string;
  model: string;
  prompt_version: string;
  metrics: ProviderMetrics;
  started_at?: string;
  completed_at?: string;
}

export interface AgentProvider<TInput, TOutput> {
  execute(input: TInput): Promise<ProviderResult<TOutput>>;
}

export interface ContextualizeInput {
  source: unknown;
  kind: string;
  position: ContextPosition;
  input_ref: string;
}

export interface JobRequirementClusteringPolicy {
  id: "corus.job_requirement_clustering_policy.v1";
  purpose: string;
  rules: string[];
}

export interface JobRequirementCluster {
  id: string;
  label: string;
  requirement_refs: string[];
  rationale: string;
  ambiguity?: string;
}

export interface JobRequirementOverlap {
  requirement_ref: string;
  cluster_refs: string[];
  rationale: string;
}

export interface JobRequirementClusters {
  schema_version: "corus.job_requirement_clusters.v1";
  job_description_ref: string;
  clustering_policy_ref: "corus.job_requirement_clustering_policy.v1";
  clusters: JobRequirementCluster[];
  unassigned_requirement_refs: string[];
  overlapping_requirements: JobRequirementOverlap[];
  generated_by: {
    role: "implementer";
    provider: string;
    model: string;
    prompt_version: "cluster-job-requirements.gemini.v1" | string;
  };
}

export interface JobRequirementClusteringInput {
  job_description: Context;
  job_description_ref: string;
  policy: JobRequirementClusteringPolicy;
  schema: Record<string, unknown>;
}

export interface JobRequirementClusterRepairInput {
  job_description: Context;
  job_description_ref: string;
  policy: JobRequirementClusteringPolicy;
  schema: Record<string, unknown>;
  previous_proposal: JobRequirementClusters;
  previous_proposal_ref: string;
  integrity_result: ClusterIntegrityResult;
  integrity_result_ref: string;
  missing_requirement_refs: string[];
}

export type ClusterIntegrityStatus = "valid" | "structurally_invalid" | "author_review_required";

export interface ClusterIntegrityResult {
  schema_version: "corus.job_requirement_cluster_integrity.v1";
  status: ClusterIntegrityStatus;
  checks: {
    original_requirement_count: number;
    accounted_requirement_count: number;
    all_original_requirements_accounted_for: boolean;
    unknown_requirement_refs: string[];
    missing_requirement_refs: string[];
    duplicate_cluster_ids: string[];
    duplicate_refs_within_clusters: Array<{ cluster_ref: string; requirement_ref: string }>;
    invalid_unassigned_refs: string[];
    unreported_overlaps: string[];
    invalid_overlap_refs: string[];
    original_ids_unchanged: boolean;
    original_text_unchanged: boolean;
    original_ledger_unchanged: boolean;
    applicant_context_absent: boolean;
  };
  review_conditions: {
    unassigned_requirement_refs: string[];
    overlapping_requirement_refs: string[];
    singleton_cluster_refs: string[];
    unusually_large_cluster_refs: string[];
    ambiguous_cluster_refs: string[];
  };
}

export interface JobRequirementClusteringRunResponse {
  run_id: string;
  run_status: "completed" | "failed";
  pipeline_status: "awaiting_author" | "provider_incomplete" | "schema_invalid" | "structurally_invalid" | "provider_error";
  objective_status: "not_evaluated";
  stage_status: {
    structured_context_preservation?: "completed_valid_output";
    structured_job_description_preservation: "completed_valid_output";
    job_requirement_clustering?: "completed_valid_output" | "provider_incomplete" | "schema_invalid" | "provider_error";
    live_job_requirement_clustering?: "completed_valid_output" | "provider_incomplete" | "schema_invalid" | "provider_error";
    cluster_integrity_validation?: "completed_valid_output" | "structurally_invalid";
    cluster_admission?: "awaiting_author";
    applicant_evidence_retrieval?: "not_reached";
    shared_capability_claim_generation?: "not_reached";
    shared_capability_validation?: "not_reached";
    capability_admission?: "not_reached";
    projection?: "not_reached";
    original_live_job_requirement_clustering?: "structurally_invalid";
    cluster_completeness_repair?: "completed_valid_output" | "provider_incomplete" | "schema_invalid" | "provider_error";
    repaired_cluster_integrity_validation?: "completed_valid_output" | "structurally_invalid";
  };
  contexts: {
    subject?: Context;
    target: Context;
  };
  clusters: JobRequirementClusters | null;
  integrity: ClusterIntegrityResult | null;
  generation_records: StageGenerationRecord[];
  artifact_dir: string;
  review_artifact_ref?: string;
  error?: {
    message: string;
    provider?: string;
    stage?: string;
  };
}

export interface ReduceCapabilitiesInput {
  contexts: {
    subject: Context;
    target: Context;
  };
  revision_findings?: ValidationFinding[];
  failure_analysis?: FailureAnalysis;
  prior_raw_output?: unknown;
  structural_error?: string;
  valid_subject_evidence_ids?: string[];
  valid_target_requirement_ids?: string[];
  previous_capabilities?: CapabilityCandidate[];
}

export interface ValidateCapabilitiesInput {
  capabilities: CapabilityCandidate[];
  contexts: {
    subject: Context;
    target: Context;
  };
}

export interface HandoffFailure {
  id: string;
  run_id: string;
  stage: "capability_reduction";
  provider: "anthropic";
  attempt: number;
  failure_type: "schema_validation";
  message: string;
  expected_schema_ref: "corus.capability_reduction.v1";
  raw_output_ref: string;
  subject_context_ref: string;
  target_context_ref: string;
  created_at: string;
}

export interface FailureAnalysisInput {
  handoff_failure: HandoffFailure;
  expected_schema: Record<string, unknown>;
  raw_provider_output: unknown;
  valid_subject_evidence_ids: string[];
  valid_target_requirement_ids: string[];
}

export interface FailureAnalysis {
  status: "correctable" | "architect_required" | "unrecoverable";
  failed_stage: "capability_reduction";
  failure_type: "schema_validation";
  diagnosis: string;
  corrections: Array<{
    field: string;
    instruction: string;
    reason: string;
  }>;
  retry_stage: "capability_reduction" | null;
  architecture_change_required: boolean;
  confidence: "high" | "medium" | "low";
}

export interface CapabilityAnalysisRequest {
  subject_source: unknown;
  target_source: unknown;
  projection?: ProjectionKind;
  mode?: CorusExecutionMode;
  run_label?: string;
}

export interface CapabilityAnalysisResponse {
  run_id: string;
  status: CapabilityValidationStatus;
  mode: CorusExecutionMode;
  contexts: {
    subject: Context;
    target: Context;
  };
  capabilities: CapabilityCandidate[];
  validation: CapabilityValidation;
  projection: CapabilityProjection | null;
  generation_records: StageGenerationRecord[];
  artifact_dir: string;
  handoff_failure?: HandoffFailure;
  failure_analysis?: FailureAnalysis;
  error?: {
    message: string;
    provider?: string;
    stage?: string;
  };
}

export interface ProviderReadiness {
  mode: CorusExecutionMode;
  ready: boolean;
  missing_credentials: string[];
  required_credentials: string[];
}

export interface ProviderModelAvailability {
  provider: string;
  model: string;
  available: boolean;
  checked: boolean;
  error?: string;
}

export interface EvaluationReport {
  evaluation: {
    fixture: string;
    baseline_ref: string;
    quality: {
      requirement_coverage: number;
      capability_recall: number;
      capability_precision: number;
      evidence_accuracy: number;
      classification_agreement: number;
      unsupported_claims: number;
      schema_valid: boolean;
      projection_fidelity: number;
    };
    efficiency: {
      model_calls: number;
      revision_cycles: number;
      input_tokens: number | null;
      output_tokens: number | null;
      estimated_cost_usd: number | null;
      latency_ms: number | null;
      measurement_source: "measured" | "derived" | "unavailable";
      human_interventions: number;
    };
    differences: Array<{ type: string; generated_id?: string; baseline_id?: string; message: string }>;
    hallucinations: Array<{ type: string; capability_id?: string; message: string }>;
    verdict: "worse" | "equivalent" | "better_with_review" | "better";
    measurement_notes: string[];
  };
}
