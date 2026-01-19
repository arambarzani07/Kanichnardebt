import { handleMessage } from "./message";
import { auditError } from "./audit";

export interface Env {
  BOT_TOKEN: string;        // Secret (Cloudflare)
  ADMIN_TG_ID: string;      // Variable
  WEBHOOK_SECRET?: string;  // Optional secret
  DB: D1Database;
}

function okJson(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Health check
      if (request.method === "GET") {
        return okJson({ ok: true, service: "kanichnar-debt", path: url.pathname });
      }

      if (request.method !== "POST") {
        return okJson({ ok: false, error: "Method not allowed" }, 405);
      }

      // Optional webhook secret verification
      const expected = (env.WEBHOOK_SECRET || "").trim();
      if (expected) {
        const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
        if (got !== expected) {
          return okJson({ ok: false, error: "Unauthorized" }, 401);
        }
      }

      const update = await request.json<any>();
      await handleMessage(env, update);

      return okJson({ ok: true });
    } catch (err: any) {
      await auditError(
        env,
        null,
        "index.fetch",
        err,
        { note: "worker top-level failure" }
      );
      return okJson({ ok: false, error: "Internal error" }, 500);
    }
  },
};