import { exec } from "./db";
import { unixNow, safeJson } from "./utils";

export async function logAudit(
  env: { DB: D1Database },
  data: {
    actorTg?: string | null;
    action: string;
    entity?: string | null;
    entityId?: string | number | null;
    ok?: boolean;
    error?: string | null;
    meta?: any;
  }
) {
  await exec(
    env,
    `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_tg TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      entity_id TEXT,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      meta_json TEXT,
      created_at INTEGER NOT NULL
    );
    `
  );

  await exec(
    env,
    `
    INSERT INTO audit_logs (actor_tg, action, entity, entity_id, ok, error, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      data.actorTg ?? null,
      data.action,
      data.entity ?? null,
      data.entityId != null ? String(data.entityId) : null,
      data.ok === false ? 0 : 1,
      data.error ?? null,
      safeJson(data.meta ?? null),
      unixNow(),
    ]
  );
}

export async function auditError(
  env: { DB: D1Database },
  actorTg: string | null,
  where: string,
  err: any,
  meta?: any
) {
  const msg =
    (err && (err.message || err.toString?.() || String(err))) || "unknown error";

  await logAudit(env, {
    actorTg,
    action: "ERROR",
    entity: where,
    entityId: null,
    ok: false,
    error: msg,
    meta: meta ?? { stack: err?.stack ?? null },
  });
}