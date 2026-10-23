/** Explicitly public sign-in labels supplied at runtime, never the private account roster.
 * These choices select a username only; Auth and database policies still determine access. */
export interface LoginChoice {
  username: string;
  label: string;
}

export function publicLoginChoices(raw = process.env.VERIFY_PUBLIC_LOGIN_CHOICES): LoginChoice[] {
  if (!raw) return [];
  const invalid = () => new Error('The public sign-in choices are invalid.');
  if (raw.length > 8192) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length > 20) throw invalid();
  const names = new Set<string>();
  const labels = new Set<string>();
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw invalid();
    const x = item as Record<string, unknown>;
    if (Object.keys(x).sort().join(',') !== 'label,username') throw invalid();
    if (typeof x.username !== 'string' || !/^[a-z][a-z0-9._-]{2,31}$/.test(x.username))
      throw invalid();
    if (
      typeof x.label !== 'string' ||
      !x.label.trim() ||
      x.label !== x.label.trim() ||
      x.label.length > 80 ||
      /[<>]/.test(x.label) ||
      Array.from(x.label).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw invalid();
    const normalized = x.label.normalize('NFKC').toLowerCase();
    if (names.has(x.username) || labels.has(normalized)) throw invalid();
    names.add(x.username);
    labels.add(normalized);
    return { username: x.username, label: x.label };
  });
}
