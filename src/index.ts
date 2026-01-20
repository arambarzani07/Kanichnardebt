// src/index.ts
import { handleUpdate } from "./telegram";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  DB: D1Database; // اگر binding ـی D1 ناوی DB ـە
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Always respond quickly to Telegram
    if (request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // Guard: token must exist
      if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("Missing TELEGRAM_BOT_TOKEN secret");
        return new Response("OK", { status: 200 });
      }

      // Read body safely
      const raw = await request.text();
      if (!raw) {
        console.error("Empty body from Telegram");
        return new Response("OK", { status: 200 });
      }

      let update: any;
      try {
        update = JSON.parse(raw);
      } catch (e) {
        console.error("Invalid JSON body", raw);
        return new Response("OK", { status: 200 });
      }

      // Process update async (so we return 200 fast)
      ctx.waitUntil(handleUpdate(env, update));

      return new Response("OK", { status: 200 });
    } catch (err: any) {
      console.error("Unhandled error in fetch()", err?.stack || err);
      // Still return 200 so Telegram doesn't keep failing
      return new Response("OK", { status: 200 });
    }
  },
};