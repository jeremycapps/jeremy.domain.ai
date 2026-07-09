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

export interface ResumeArtifact {
  archetype: string;
  filename: string;
  path: string;
  content: string;
}

export interface FileInventory {
  data_files: string[];
  resume_files: string[];
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
  experience_unit_ids: string[];
  used_full_context: boolean;
  selected_context_summary: string;
  units: ExperienceUnit[];
  artifact?: ResumeArtifact;
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
