// Postgres/pg returns snake_case column names (fired_at, idempotency_key, ...).
// The shared-types package (and every client component) expects camelCase to
// match normal TS/JS conventions. Rather than rely on every route author to
// remember to alias every column in every query, every route runs its
// response through this once before res.json().
export function toCamelCase<T = unknown>(input: unknown): T {
  if (Array.isArray(input)) {
    return input.map((item) => toCamelCase(item)) as unknown as T;
  }
  if (input !== null && typeof input === "object" && !(input instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      result[camelKey] = toCamelCase(value);
    }
    return result as T;
  }
  return input as T;
}
