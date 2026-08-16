export function isBootstrapOperator(userId: string, rawAllowlist: string | undefined): boolean {
  const normalizedUserId = userId.trim().toLowerCase();
  if (!normalizedUserId) return false;

  return (rawAllowlist ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalizedUserId);
}
