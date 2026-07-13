export class ProviderConfigurationError extends Error {
  constructor(
    public readonly provider: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderExecutionError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly raw_output?: unknown,
    public readonly metadata?: {
      model?: string;
      prompt_version?: string;
      schema_version?: string;
      metrics?: {
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens?: number | null;
        estimated_cost_usd: number | null;
        latency_ms: number | null;
        measurement_source: "measured" | "derived" | "unavailable";
      };
      stop_reason?: string | null;
      provider_status?: "provider_error";
      provider_completion_state?: string | null;
      started_at?: string;
      completed_at?: string;
      model_operation?: unknown;
    }
  ) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}
