// Test helper. Some flashcard tests apply the migrations to an in-memory
// Postgres (PGlite). PGlite is not a dependency of this branch, so those
// tests run the SQL only where it happens to be installed, and otherwise fall
// back to checking the migration text. Each test says which check it ran.

export interface PGliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export async function loadPGlite(): Promise<(new () => PGliteLike) | null> {
  // A variable specifier keeps tsc and bundlers from requiring the package.
  const specifier = "@electric-sql/pglite";
  try {
    const mod = (await import(specifier)) as { PGlite: new () => PGliteLike };
    return mod.PGlite;
  } catch {
    return null;
  }
}

/** The statements of a migration, with comments and blank lines removed. */
export function sqlStatements(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}
