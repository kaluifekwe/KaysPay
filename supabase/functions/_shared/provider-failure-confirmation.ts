export interface ProviderFailureObservation {
  at: string;
  status: string;
  message?: string;
}

export function hasSeparatedFailureConfirmation(
  previous: unknown,
  status: string,
  nowMs = Date.now(),
  minimumSeparationMs = 20_000,
): boolean {
  if (!previous || typeof previous !== "object") return false;
  const value = previous as Partial<ProviderFailureObservation>;
  const previousAt = typeof value.at === "string" ? new Date(value.at).getTime() : Number.NaN;
  return value.status === status && Number.isFinite(previousAt) && nowMs - previousAt >= minimumSeparationMs;
}
