// Some VTUnaija data plans are restricted (fail if the user owes airtime on
// that network) — they embed the warning directly in their own plan name,
// e.g. "Do Not Buy MTN AwoofData If You Are Owing MTN Airtime". Detecting
// this via a name match means it automatically covers any network/plan
// VTUnaija flags this way, without a hardcoded plan-id list to maintain.
export function isRestrictedPlanName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('do not buy') || lower.includes('owing');
}
