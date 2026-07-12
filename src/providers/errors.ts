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
    message: string
  ) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}
