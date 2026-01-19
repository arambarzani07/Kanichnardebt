export interface EnvDB {
  DB: D1Database;
}

export async function exec(env: EnvDB, sql: string, params: any[] = []): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

export async function one<T>(
  env: EnvDB,
  sql: string,
  params: any[] = []
): Promise<{ row: T | null }> {
  const res = await env.DB.prepare(sql).bind(...params).first<T>();
  return { row: (res as any) ?? null };
}

export async function all<T>(
  env: EnvDB,
  sql: string,
  params: any[] = []
): Promise<{ rows: T[] }> {
  const res = await env.DB.prepare(sql).bind(...params).all<T>();
  return { rows: (res?.results as any) ?? [] };
}