const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function assertSafeId(value: unknown, label = "identifier"): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.includes("..")) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
  return value;
}

export function nextSequentialId(prefix: string, existing: Iterable<string>): string {
  const used = new Set(existing);
  for (let index = 1; index <= 999_999; index += 1) {
    const candidate = `${prefix}-${String(index).padStart(3, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`exhausted ${prefix} identifiers`);
}
