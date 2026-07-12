export type ProviderFailureClassification =
  | "transient_rate_limit"
  | "quota_or_billing"
  | "model_rate_limit"
  | "unknown_provider_failure";

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function classifyProviderFailure(value: unknown): ProviderFailureClassification {
  const text = textFrom(value).toLowerCase();

  if (/\binsufficient[_\s-]?quota\b/.test(text) || /\bbilling\b/.test(text) || /\bpayment\b/.test(text) || /\bcredit(s)?\b/.test(text)) {
    return "quota_or_billing";
  }

  if ((/\bmodel\b/.test(text) || /\btokens?\b/.test(text)) && (/\brate[_\s-]?limit/.test(text) || /\b429\b/.test(text))) {
    return "model_rate_limit";
  }

  if (/\b429\b/.test(text) || /\brate[_\s-]?limit/.test(text) || /\btoo many requests\b/.test(text)) {
    return "transient_rate_limit";
  }

  return "unknown_provider_failure";
}

export function retryAfterMilliseconds(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record.retry_after ?? record.retryAfter ?? record["retry-after"];
  const headers = record.headers && typeof record.headers === "object" ? (record.headers as Record<string, unknown>) : undefined;
  const header = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const raw = direct ?? header;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw * 1000;
  if (typeof raw !== "string") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
