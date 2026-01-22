export interface Env {
  DB: D1Database;

  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TG_ID: string;

  APP_NAME?: string;
  DEFAULT_CURRENCY?: "IQD" | "USD";
  ALLOW_USD?: string; // "true"/"false"
}

type TgUpdate = any;

const K = {
  appName: (env: Env) => env.APP_NAME || "Kanichnar Debt",
  allowUsd: (env: Env) => (env.ALLOW_USD || "true").toLowerCase() === "true",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Normalize phone to a stable format: keep digits, ensure leading +964 if user enters local */
function normalizePhone(input: string): string | null {
  if (!input) return null;
  const digits = input.replace(/[^\d+]/g, "");
  if (!digits) return null;

  // If user gives +964... keep it
  if (digits.startsWith("+")) {
    const d = "+" + digits.replace(/[^\d]/g, "");
    if (d.length < 8) return null;
    return d;
  }

  // If user types 0750..., convert to +964750...
  let d = digits.replace(/[^\d]/g, "");
  if (d.startsWith("0") && d.length >= 10) d = d.slice(1);
  if (d.startsWith("964")) d = "+" + d;
  else if (d.length >= 9) d = "+964" + d;
  else return null;
  return d;
}

function parseCurrency(env: Env, token?: string): "IQD" | "USD" | null {
  if (!token) return env.DEFAULT_CURRENCY || "IQD";
  const t = token.toUpperCase();
  if (t === "IQD") return "IQD";
  if (t === "USD") return K.allowUsd(env) ? "USD" : null;
  return null;
}

function parseAmount(raw?: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[, ]/g, "");
  const v = Number(cleaned);
  if (!Number.isFinite(v)) return null;
  if (v <= 0) return null;
  return v;
}

function tgEscapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tgBold(s: string) {
  return `<b>${tgEscapeHtml(s)}</b>`;
}

function tgCode(s: string) {
  return `<code>${tgEscapeHtml(s)}</code>`;
}

async function tgApi(env: Env, method: string, payload: any) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram API error: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendMessageSafe(env: Env, chat_id: string, html: string, extra?: any) {
  // Outbox-first for reliability
  const payload = {
    chat_id,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };
  await env.DB.prepare(
    `INSERT INTO message_outbox (to_tg_id, payload_json, status) VALUES (?, ?, 'PENDING')`
  )
    .bind(String(chat_id), JSON.stringify(payload))
    .run();

  // Try sending now (fast path)
  try {
    await tgApi(env, "sendMessage", payload);
    await env.DB.prepare(
      `UPDATE message_outbox SET status='SENT', sent_at=datetime('now') WHERE to_tg_id=? AND payload_json=? AND status='PENDING'`
    )
      .bind(String(chat_id), JSON.stringify(payload))
      .run();
  } catch (e: any) {
    await env.DB.prepare(
      `UPDATE message_outbox SET status='FAILED', last_error=?, retry_count=retry_count+1 WHERE to_tg_id=? AND payload_json=? AND status='PENDING'`
    )
      .bind(String(e?.message || e), String(chat_id), JSON.stringify(payload))
      .run();
  }
}

async function ensureUser(env: Env, tg_id: string, full_name?: string) {
  await env.DB.prepare(
    `INSERT INTO users (tg_id, full_name, role) VALUES (?, ?, 'PENDING')
     ON CONFLICT(tg_id) DO UPDATE SET full_name=COALESCE(excluded.full_name, users.full_name), updated_at=datetime('now')`
  )
    .bind(String(tg_id), full_name || null)
    .run();
}

async function getUserRole(env: Env, tg_id: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT role, status FROM users WHERE tg_id=?`).bind(String(tg_id)).first<any>();
  if (!row) return "PENDING";
  if (row.status === "LOCKED") return "LOCKED";
  return row.role || "PENDING";
}

function isAdmin(env: Env, tg_id: string) {
  return String(tg_id) === String(env.ADMIN_TG_ID);
}

async function audit(env: Env, actor_tg_id: string | null, action: string, meta?: any, entity?: string, entity_id?: string) {
  await env.DB.prepare(
    `INSERT INTO audit_log (actor_tg_id, action, entity, entity_id, meta_json) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(actor_tg_id ? String(actor_tg_id) : null, action, entity || null, entity_id || null, meta ? JSON.stringify(meta) : null)
    .run();
}

/** Prevent double-processing the same Telegram update_id */
async function markUpdateProcessed(env: Env, update_id: number): Promise<boolean> {
  try {
    await env.DB.prepare(`INSERT INTO processed_updates (update_id) VALUES (?)`).bind(update_id).run();
    return true;
  } catch {
    return false; // already processed
  }
}

/** Command help text in Kurdish */
function helpText(env: Env, role: string) {
  const lines: string[] = [];
  lines.push(`${tgBold(K.appName(env))}`);
  lines.push(`سیستەمی بەڕێوەبردنی قەرز (تەنها قەرز، قسط نیە).`);
  lines.push(``);
  lines.push(`${tgBold("فرمانە سەرەکییەکان")}`);
  lines.push(`• /start`);
  lines.push(`• /help`);
  lines.push(`• /link <ژمارە> <ناو>  (داواکاری بەستنەوە)`);
  lines.push(`• /mydebt  (بۆ کڕیار)`);
  lines.push(`• /history  (بۆ کڕیار)`);

  if (role === "STAFF" || role === "ADMIN" || role === "OWNER") {
    lines.push(``);
    lines.push(`${tgBold("فرمانەکانی ستاف")}`);
    lines.push(`• /debtadd <ژمارە> <بڕ> <IQD|USD> <تێبینی>`);
    lines.push(`• /pay <ژمارە> <بڕ> <IQD|USD> <تێبینی>`);
    lines.push(`• /statement <ژمارە>`);
  }

  if (role === "ADMIN" || role === "OWNER") {
    lines.push(``);
    lines.push(`${tgBold("فرمانەکانی ئەدمین")}`);
    lines.push(`• /approve  (داواکارییە چاوەڕێکان)`);
    lines.push(`• /lock <tg_id>`);
  }

  return lines.join("\n");
}

/** Ensure there is always an owner/admin: the ADMIN_TG_ID becomes ADMIN if not exists */
async function bootstrapAdmin(env: Env) {
  const adminId = String(env.ADMIN_TG_ID);
  const row = await env.DB.prepare(`SELECT role FROM users WHERE tg_id=?`).bind(adminId).first<any>();
  if (!row) {
    await env.DB.prepare(`INSERT INTO users (tg_id, role, full_name, status) VALUES (?, 'ADMIN', 'Admin', 'ACTIVE')`)
      .bind(adminId)
      .run();
  } else if (row.role !== "ADMIN" && row.role !== "OWNER") {
    await env.DB.prepare(`UPDATE users SET role='ADMIN', updated_at=datetime('now') WHERE tg_id=?`).bind(adminId).run();
  }
}

async function handleStart(env: Env, tg_id: string, full_name?: string) {
  await ensureUser(env, tg_id, full_name);
  await bootstrapAdmin(env);
  const role = await getUserRole(env, tg_id);

  const msg =
    `${tgBold(K.appName(env))}\n` +
    `بەخێربێیت.\n\n` +
    `ئەگەر دەتەوێت بە سیستەمەکەوە پەیوەست بیت:\n` +
    `• /link ${tgCode("+9647500000000")} ${tgCode("ناوت")}\n\n` +
    `یارمەتی:\n` +
    `• /help`;

  await sendMessageSafe(env, tg_id, msg);
  await audit(env, tg_id, "START", { role });
}

async function handleLink(env: Env, tg_id: string, full_name: string | undefined, args: string[]) {
  // /link <phone> <name...>
  const phone = normalizePhone(args[0] || "");
  const name = args.slice(1).join(" ").trim() || full_name || "";

  if (!phone || name.length < 2) {
    await sendMessageSafe(
      env,
      tg_id,
      `تکایە بە شێوەی ئەمە بنووسە:\n/link ${tgCode("+9647500000000")} ${tgCode("ناوی کڕیار")}`
    );
    return;
  }

  await ensureUser(env, tg_id, full_name);
  await env.DB.prepare(
    `INSERT INTO approval_requests (requester_tg_id, phone, name, requested_role, status)
     VALUES (?, ?, ?, 'CUSTOMER', 'PENDING')`
  )
    .bind(String(tg_id), phone, name)
    .run();

  await env.DB.prepare(`UPDATE users SET phone=?, updated_at=datetime('now') WHERE tg_id=?`)
    .bind(phone, String(tg_id))
    .run();

  // Notify admin with buttons
  const adminId = String(env.ADMIN_TG_ID);
  const pending = await env.DB.prepare(
    `SELECT id FROM approval_requests WHERE requester_tg_id=? AND phone=? AND status='PENDING' ORDER BY id DESC LIMIT 1`
  )
    .bind(String(tg_id), phone)
    .first<any>();

  const reqId = pending?.id;
  const html =
    `${tgBold("داواکاری نوێ")}\n` +
    `TG: ${tgCode(String(tg_id))}\n` +
    `ژمارە: ${tgCode(phone)}\n` +
    `ناو: ${tgCode(name)}\n\n` +
    `پەسەند دەکەیت؟`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ پەسەند", callback_data: `APPROVE:${reqId}` },
        { text: "❌ ڕەت", callback_data: `REJECT:${reqId}` },
      ],
    ],
  };

  await sendMessageSafe(env, adminId, html, { reply_markup });
  await sendMessageSafe(env, tg_id, `داواکاری تۆ نێردرا بۆ ئەدمین. چاوەڕێ بکە بۆ پەسەندکردن.`);
  await audit(env, tg_id, "LINK_REQUEST", { phone, name, reqId });
}

async function approveRequest(env: Env, adminTgId: string, reqId: number, approve: boolean) {
  // Only admin
  if (!isAdmin(env, adminTgId)) {
    await sendMessageSafe(env, adminTgId, `دەسەڵاتت نیە.`);
    return;
  }

  const req = await env.DB.prepare(`SELECT * FROM approval_requests WHERE id=?`).bind(reqId).first<any>();
  if (!req || req.status !== "PENDING") {
    await sendMessageSafe(env, adminTgId, `ئەم داواکارییە نەدۆزرایەوە یان پێشتر چارەسەر کراوە.`);
    return;
  }

  const requesterTg = String(req.requester_tg_id);
  const phone = String(req.phone);
  const name = String(req.name);

  if (!approve) {
    await env.DB.prepare(
      `UPDATE approval_requests SET status='REJECTED', admin_tg_id=?, resolved_at=datetime('now') WHERE id=?`
    )
      .bind(String(adminTgId), reqId)
      .run();
    await sendMessageSafe(env, requesterTg, `داواکاری تۆ ڕەتکرایەوە. تکایە پەیوەندی بکە بە مارکێت.`);
    await audit(env, adminTgId, "APPROVAL_REJECT", { reqId, requesterTg, phone });
    return;
  }

  // Approve: create/update customer and balances, link to tg_id
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO customers (phone, name, tg_id) VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET name=excluded.name, tg_id=excluded.tg_id`
    ).bind(phone, name, requesterTg),

    env.DB.prepare(`UPDATE users SET role='CUSTOMER', status='ACTIVE', phone=?, updated_at=datetime('now') WHERE tg_id=?`)
      .bind(phone, requesterTg),

    env.DB.prepare(
      `UPDATE approval_requests SET status='APPROVED', admin_tg_id=?, resolved_at=datetime('now') WHERE id=?`
    ).bind(String(adminTgId), reqId),
  ]);

  // Ensure balances row exists
  const cust = await env.DB.prepare(`SELECT id FROM customers WHERE phone=?`).bind(phone).first<any>();
  if (cust?.id) {
    await env.DB.prepare(
      `INSERT INTO balances (customer_id, balance_iqd, balance_usd, last_activity_at)
       VALUES (?, 0, 0, datetime('now'))
       ON CONFLICT(customer_id) DO NOTHING`
    )
      .bind(cust.id)
      .run();
  }

  await sendMessageSafe(env, requesterTg, `✅ داواکاری تۆ پەسەندکرا. ئێستا دەتوانیت /mydebt و /history بەکاربهێنیت.`);
  await sendMessageSafe(env, adminTgId, `پەسەندکرا: ${tgCode(phone)} (${tgCode(name)})`);
  await audit(env, adminTgId, "APPROVAL_APPROVE", { reqId, requesterTg, phone });
}

async function getCustomerByPhone(env: Env, phoneRaw: string) {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  const cust = await env.DB.prepare(`SELECT * FROM customers WHERE phone=?`).bind(phone).first<any>();
  if (!cust) return null;
  const bal = await env.DB.prepare(`SELECT * FROM balances WHERE customer_id=?`).bind(cust.id).first<any>();
  return { phone, cust, bal };
}

async function updateBalanceWithTx(env: Env, actor_tg_id: string, phoneRaw: string, type: "DEBT_ADD" | "PAYMENT", amount: number, currency: "IQD" | "USD", note: string) {
  const found = await getCustomerByPhone(env, phoneRaw);
  if (!found) return { ok: false, msg: `کڕیار نەدۆزرایەوە. تکایە سەرەتا /link بکات یان ژمارەکە ڕاست بکە.` };

  const { cust } = found;

  // Use D1 transaction-like batch
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transactions (customer_id, actor_tg_id, type, amount, currency, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(cust.id, String(actor_tg_id), type, amount, currency, note || null),

    env.DB.prepare(
      `UPDATE balances
       SET
         balance_iqd = balance_iqd + ?,
         balance_usd = balance_usd + ?,
         last_activity_at = datetime('now')
       WHERE customer_id = ?`
    ).bind(
      currency === "IQD" ? (type === "DEBT_ADD" ? Math.round(amount) : -Math.round(amount)) : 0,
      currency === "USD" ? (type === "DEBT_ADD" ? amount : -amount) : 0,
      cust.id
    ),
  ]);

  const bal = await env.DB.prepare(`SELECT balance_iqd, balance_usd FROM balances WHERE customer_id=?`).bind(cust.id).first<any>();
  const newIqd = bal?.balance_iqd ?? 0;
  const newUsd = bal?.balance_usd ?? 0;

  // Notify customer if linked
  if (cust.tg_id) {
    const title = type === "DEBT_ADD" ? "زیادکردنی قەرز" : "پارەدان";
    const sign = type === "DEBT_ADD" ? "+" : "-";
    const html =
      `${tgBold("ئاگادارکردنەوە")} — ${tgBold(title)}\n` +
      `ژمارە: ${tgCode(found.phone)}\n` +
      `بڕ: ${tgCode(`${sign}${amount} ${currency}`)}\n` +
      (note ? `تێبینی: ${tgCode(note)}\n` : "") +
      `\n${tgBold("قەرزی ئێستا")}\n` +
      `IQD: ${tgCode(String(newIqd))}\n` +
      `USD: ${tgCode(String(newUsd))}`;

    await sendMessageSafe(env, String(cust.tg_id), html);
  }

  await audit(env, actor_tg_id, "TX_CREATE", { type, amount, currency, phone: found.phone }, "customer", String(cust.id));
  return { ok: true, msg: `تەواو. قەرزی نوێ: IQD=${newIqd} , USD=${newUsd}` };
}

async function handleMyDebt(env: Env, tg_id: string) {
  const cust = await env.DB.prepare(`SELECT id, phone, name FROM customers WHERE tg_id=?`).bind(String(tg_id)).first<any>();
  if (!cust) {
    await sendMessageSafe(env, tg_id, `تۆ هێشتا پەسەند نەکراویت. /link بەکاربهێنە.`);
    return;
  }
  const bal = await env.DB.prepare(`SELECT balance_iqd, balance_usd, last_activity_at FROM balances WHERE customer_id=?`).bind(cust.id).first<any>();
  const html =
    `${tgBold("قەرزی ئێستا")}\n` +
    `ناو: ${tgCode(cust.name)}\n` +
    `ژمارە: ${tgCode(cust.phone)}\n\n` +
    `IQD: ${tgCode(String(bal?.balance_iqd ?? 0))}\n` +
    `USD: ${tgCode(String(bal?.balance_usd ?? 0))}\n` +
    (bal?.last_activity_at ? `\nدوایین چالاکی: ${tgCode(bal.last_activity_at)}` : "");

  await sendMessageSafe(env, tg_id, html);
}

async function handleHistory(env: Env, tg_id: string) {
  const cust = await env.DB.prepare(`SELECT id, phone, name FROM customers WHERE tg_id=?`).bind(String(tg_id)).first<any>();
  if (!cust) {
    await sendMessageSafe(env, tg_id, `تۆ هێشتا پەسەند نەکراویت. /link بەکاربهێنە.`);
    return;
  }

  const rows = await env.DB.prepare(
    `SELECT type, amount, currency, note, created_at FROM transactions WHERE customer_id=? ORDER BY id DESC LIMIT 15`
  ).bind(cust.id).all<any>();

  const items = (rows?.results || []).map((r: any) => {
    const t = r.type === "DEBT_ADD" ? "قەرز +" : r.type === "PAYMENT" ? "پارەدان -" : "گۆڕانکاری";
    const n = r.note ? ` — ${r.note}` : "";
    return `• ${t} ${r.amount} ${r.currency} (${r.created_at})${n}`;
  });

  const html =
    `${tgBold("تاریخچەی دوایین مامەلەکان")}\n` +
    `ناو: ${tgCode(cust.name)}\n` +
    `ژمارە: ${tgCode(cust.phone)}\n\n` +
    (items.length ? items.join("\n") : "هیچ مامەلەیەک نیە.");

  await sendMessageSafe(env, tg_id, html);
}

async function handleApproveList(env: Env, tg_id: string) {
  if (!isAdmin(env, tg_id)) {
    await sendMessageSafe(env, tg_id, `دەسەڵاتت نیە.`);
    return;
  }
  const rows = await env.DB.prepare(
    `SELECT id, phone, name, created_at FROM approval_requests WHERE status='PENDING' ORDER BY id DESC LIMIT 10`
  ).all<any>();

  const list = (rows.results || [])
    .map((r: any) => `• #${r.id} ${r.phone} — ${r.name} (${r.created_at})`)
    .join("\n");

  const html = `${tgBold("داواکارییە چاوەڕێکان")}\n\n${list || "هیچ داواکارییەک نیە."}`;
  await sendMessageSafe(env, tg_id, html);
}

async function handleLock(env: Env, tg_id: string, args: string[]) {
  if (!isAdmin(env, tg_id)) {
    await sendMessageSafe(env, tg_id, `دەسەڵاتت نیە.`);
    return;
  }
  const target = (args[0] || "").trim();
  if (!target) {
    await sendMessageSafe(env, tg_id, `نمونە: /lock ${tgCode("123456789")}`);
    return;
  }
  await env.DB.prepare(`UPDATE users SET status='LOCKED', updated_at=datetime('now') WHERE tg_id=?`).bind(target).run();
  await sendMessageSafe(env, tg_id, `قفلکرا: ${tgCode(target)}`);
  await audit(env, tg_id, "LOCK_USER", { target });
}

function parseCommand(text: string): { cmd: string; args: string[] } | null {
  if (!text) return null;
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const parts = t.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

async function handleMessage(env: Env, msg: any) {
  const chatId = String(msg.chat?.id);
  const fromId = String(msg.from?.id);
  const fullName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || undefined;
  const role = await getUserRole(env, fromId);

  const cmdObj = parseCommand(msg.text || "");
  if (!cmdObj) {
    // keep it friendly
    await sendMessageSafe(env, chatId, `تکایە /help بنووسە بۆ بینینی فرمانەکان.`);
    return;
  }

  const { cmd, args } = cmdObj;

  if (cmd === "/start") return handleStart(env, fromId, fullName);
  if (cmd === "/help") {
    await ensureUser(env, fromId, fullName);
    await sendMessageSafe(env, chatId, helpText(env, isAdmin(env, fromId) ? "ADMIN" : role));
    return;
  }

  if (cmd === "/link") return handleLink(env, fromId, fullName, args);
  if (cmd === "/mydebt") return handleMyDebt(env, fromId);
  if (cmd === "/history") return handleHistory(env, fromId);

  // Staff/admin commands
  if (cmd === "/approve") return handleApproveList(env, fromId);
  if (cmd === "/lock") return handleLock(env, fromId, args);

  if (cmd === "/debtadd" || cmd === "/pay") {
    if (!(role === "STAFF" || role === "ADMIN" || role === "OWNER") && !isAdmin(env, fromId)) {
      await sendMessageSafe(env, chatId, `دەسەڵاتت نیە.`);
      return;
    }
    const phone = args[0];
    const amount = parseAmount(args[1]);
    const currency = parseCurrency(env, args[2]);
    const note = args.slice(3).join(" ").trim();

    if (!phone || !amount || !currency) {
      await sendMessageSafe(
        env,
        chatId,
        `نمونە:\n/debtadd ${tgCode("+9647500000000")} ${tgCode("50000")} ${tgCode("IQD")} ${tgCode("کڕینی کاڵا")}\n` +
          `/pay ${tgCode("+9647500000000")} ${tgCode("20000")} ${tgCode("IQD")} ${tgCode("پارەدان")}`
      );
      return;
    }

    const type = cmd === "/debtadd" ? "DEBT_ADD" : "PAYMENT";
    const result = await updateBalanceWithTx(env, fromId, phone, type, amount, currency, note);
    await sendMessageSafe(env, chatId, result.msg);
    return;
  }

  if (cmd === "/statement") {
    if (!(role === "STAFF" || role === "ADMIN" || role === "OWNER") && !isAdmin(env, fromId)) {
      await sendMessageSafe(env, chatId, `دەسەڵاتت نیە.`);
      return;
    }
    const phone = args[0];
    const found = await getCustomerByPhone(env, phone || "");
    if (!found) {
      await sendMessageSafe(env, chatId, `کڕیار نەدۆزرایەوە.`);
      return;
    }
    const bal = await env.DB.prepare(`SELECT balance_iqd, balance_usd FROM balances WHERE customer_id=?`)
      .bind(found.cust.id)
      .first<any>();

    const html =
      `${tgBold("وەسڵ/بیانی قەرز")}\n` +
      `ناو: ${tgCode(found.cust.name)}\n` +
      `ژمارە: ${tgCode(found.phone)}\n\n` +
      `IQD: ${tgCode(String(bal?.balance_iqd ?? 0))}\n` +
      `USD: ${tgCode(String(bal?.balance_usd ?? 0))}`;

    await sendMessageSafe(env, chatId, html);
    return;
  }

  await sendMessageSafe(env, chatId, `فرمان نەناسرا. /help بنووسە.`);
}

async function handleCallback(env: Env, cb: any) {
  const fromId = String(cb.from?.id);
  const data = String(cb.data || "");
  const messageChatId = String(cb.message?.chat?.id);

  // Always answer callback to avoid telegram spinner
  try {
    await tgApi(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "..." });
  } catch {}

  const [action, idStr] = data.split(":");
  const reqId = Number(idStr);

  if (!Number.isFinite(reqId)) {
    await sendMessageSafe(env, messageChatId, `هەڵە: داواکاری نەناسرا.`);
    return;
  }

  if (action === "APPROVE") {
    await approveRequest(env, fromId, reqId, true);
    return;
  }
  if (action === "REJECT") {
    await approveRequest(env, fromId, reqId, false);
    return;
  }

  await sendMessageSafe(env, messageChatId, `هەڵە: action نەناسرا.`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Health
      if (request.method === "GET" && url.pathname === "/health") {
        // DB sanity
        const dbOk = await env.DB.prepare("SELECT 1 AS ok").first<any>();
        return json({
          ok: true,
          service: env.APP_NAME || "kanichnar-debt",
          time: new Date().toISOString(),
          db: dbOk?.ok === 1 ? "ok" : "unknown",
          path: url.pathname,
        });
      }

      // Telegram webhook
      if (url.pathname === "/telegram") {
        const secret = url.searchParams.get("secret") || "";
        if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
          return text("forbidden", 403);
        }
        if (request.method !== "POST") return text("method not allowed", 405);

        const update: TgUpdate = await request.json().catch(() => null);
        if (!update) return text("bad request", 400);

        // Idempotency
        const updateId = update.update_id;
        if (typeof updateId === "number") {
          const firstTime = await markUpdateProcessed(env, updateId);
          if (!firstTime) {
            // already processed, always 200
            return text("ok", 200);
          }
        }

        await bootstrapAdmin(env);

        if (update.message) {
          await handleMessage(env, update.message);
        } else if (update.callback_query) {
          await handleCallback(env, update.callback_query);
        }

        return text("ok", 200);
      }

      // Default route
      return text("ok", 200);
    } catch (err: any) {
      // IMPORTANT: do not throw 500 back to Telegram webhook too often;
      // but here is generic endpoint. Telegram hits /telegram and we handle try/catch above anyway.
      console.error("Worker error:", err?.stack || err?.message || err);
      return text("error", 500);
    }
  },

  // Optional: scheduled event to retry FAILED/PENDING outbox (can add later)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try {
        // Retry up to 20 pending/failed messages per run
        const rows = await env.DB.prepare(
          `SELECT id, to_tg_id, payload_json, retry_count FROM message_outbox
           WHERE status IN ('PENDING','FAILED') AND retry_count < 5
           ORDER BY id ASC LIMIT 20`
        ).all<any>();

        for (const r of rows.results || []) {
          try {
            const payload = JSON.parse(r.payload_json);
            await tgApi(env, "sendMessage", payload);
            await env.DB.prepare(`UPDATE message_outbox SET status='SENT', sent_at=datetime('now') WHERE id=?`)
              .bind(r.id)
              .run();
          } catch (e: any) {
            await env.DB.prepare(`UPDATE message_outbox SET status='FAILED', retry_count=retry_count+1, last_error=? WHERE id=?`)
              .bind(String(e?.message || e), r.id)
              .run();
          }
        }
      } catch (e) {
        console.error("scheduled error", e);
      }
    })());
  }
};