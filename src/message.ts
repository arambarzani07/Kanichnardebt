import type { Currency, Role } from "./constants";
import { COMMANDS, ROLES, CURRENCIES, isAdmin } from "./constants";
import { sendMessageSafe, tgBold, tgCode } from "./telegram";
import {
  getMessageText,
  getChatId,
  getTelegramUserId,
  splitArgs,
  normalizePhone,
  isValidPhone,
  unixNow,
} from "./utils";
import { exec, one, all } from "./db";
import { logAudit, auditError } from "./audit";

type Env = {
  BOT_TOKEN: string;
  ADMIN_TG_ID: string;
  DB: D1Database;
};

async function ensureSchema(env: Env) {
  // Minimal schema (if migrations not applied yet, this keeps bot working)
  await exec(
    env,
    `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'customer',
      phone TEXT,
      name TEXT,
      username TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    `
  );

  await exec(
    env,
    `
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL UNIQUE,
      created_by_tg INTEGER,
      created_at INTEGER NOT NULL
    );
    `
  );

  await exec(
    env,
    `
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      full_name TEXT,
      note TEXT,
      created_by_tg INTEGER,
      created_at INTEGER NOT NULL
    );
    `
  );

  await exec(
    env,
    `
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      note TEXT,
      created_by_tg INTEGER,
      created_at INTEGER NOT NULL
    );
    `
  );

  await exec(
    env,
    `
    CREATE TABLE IF NOT EXISTS notify_links (
      phone TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      tg_id INTEGER,
      linked_at INTEGER NOT NULL
    );
    `
  );

  await exec(env, `CREATE INDEX IF NOT EXISTS idx_tx_phone ON transactions(phone);`);
  await exec(env, `CREATE INDEX IF NOT EXISTS idx_tx_created_at ON transactions(created_at);`);
}

/* =========================
 * Role + User
 * ========================= */
async function resolveRole(env: Env, tgId: number): Promise<Role> {
  if (isAdmin(env, tgId)) return ROLES.ADMIN;

  const staffRow = await one<{ tg_id: number }>(
    env,
    `SELECT tg_id FROM staff WHERE tg_id=?`,
    [tgId]
  );
  if (staffRow.row?.tg_id) return ROLES.STAFF;

  return ROLES.CUSTOMER;
}

async function upsertUserFromTelegram(env: Env, tgId: number, update: any): Promise<void> {
  const from =
    update?.message?.from ??
    update?.edited_message?.from ??
    update?.callback_query?.from ??
    {};

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
  const username = from.username || null;

  const role = await resolveRole(env, tgId);
  const now = unixNow();

  await exec(
    env,
    `
    INSERT INTO users (tg_id, role, name, username, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET
      role=excluded.role,
      name=COALESCE(excluded.name, users.name),
      username=COALESCE(excluded.username, users.username),
      updated_at=excluded.updated_at
    `,
    [tgId, role, name, username, now, now]
  );
}

async function getUser(env: Env, tgId: number) {
  const r = await one<any>(env, `SELECT * FROM users WHERE tg_id=?`, [tgId]);
  return r.row;
}

/* =========================
 * Customer + Balance
 * ========================= */
async function ensureCustomerExists(env: Env, phone: string, createdByTg?: number) {
  await exec(
    env,
    `
    INSERT INTO customers (phone, created_by_tg, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(phone) DO NOTHING
    `,
    [phone, createdByTg ?? null, unixNow()]
  );
}

function parseCurrency(raw?: string): Currency {
  const c = (raw || "").toUpperCase().trim();
  if (c === "USD") return CURRENCIES.USD;
  return CURRENCIES.IQD;
}

function parseAmount(raw?: string): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

async function calcBalance(env: Env, phone: string, currency: Currency): Promise<number> {
  const r = await one<{ debt_sum: number; pay_sum: number }>(
    env,
    `
    SELECT
      COALESCE(SUM(CASE WHEN type='debt' THEN amount ELSE 0 END),0) AS debt_sum,
      COALESCE(SUM(CASE WHEN type='payment' THEN amount ELSE 0 END),0) AS pay_sum
    FROM transactions
    WHERE phone=? AND currency=?
    `,
    [phone, currency]
  );

  const debt = Number(r.row?.debt_sum ?? 0);
  const pay = Number(r.row?.pay_sum ?? 0);
  return debt - pay;
}

async function formatCustomerSummary(env: Env, phone: string): Promise<string> {
  const iqd = await calcBalance(env, phone, CURRENCIES.IQD);
  const usd = await calcBalance(env, phone, CURRENCIES.USD);

  return (
    `${tgBold("دۆخی قەرز")}\n` +
    `ژمارە: ${tgCode(phone)}\n` +
    `IQD: ${tgCode(String(iqd))}\n` +
    `USD: ${tgCode(String(usd))}`
  );
}

/* =========================
 * Notify link
 * ========================= */
async function linkPhoneToChat(env: Env, phone: string, chatId: number, tgId: number) {
  await exec(
    env,
    `
    INSERT INTO notify_links (phone, chat_id, tg_id, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      chat_id=excluded.chat_id,
      tg_id=excluded.tg_id,
      linked_at=excluded.linked_at
    `,
    [phone, chatId, tgId, unixNow()]
  );

  await exec(
    env,
    `UPDATE users SET phone=?, updated_at=? WHERE tg_id=?`,
    [phone, unixNow(), tgId]
  );
}

async function notifyCustomerIfLinked(env: Env, phone: string, htmlText: string) {
  const link = await one<{ chat_id: number }>(
    env,
    `SELECT chat_id FROM notify_links WHERE phone=?`,
    [phone]
  );
  if (!link.row?.chat_id) return;

  await sendMessageSafe(env, link.row.chat_id, `🔔 ${tgBold("ئاگادارکردنەوە")}\n${htmlText}`);
}

/* =========================
 * Staff
 * ========================= */
async function addStaff(env: Env, staffTgId: number, createdByTg: number) {
  await exec(
    env,
    `
    INSERT INTO staff (tg_id, created_by_tg, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tg_id) DO NOTHING
    `,
    [staffTgId, createdByTg, unixNow()]
  );
}

async function removeStaff(env: Env, staffTgId: number) {
  await exec(env, `DELETE FROM staff WHERE tg_id=?`, [staffTgId]);
}

/* =========================
 * Transactions
 * ========================= */
async function addTransaction(
  env: Env,
  phone: string,
  type: "debt" | "payment",
  amount: number,
  currency: Currency,
  createdByTg: number,
  note?: string
) {
  await ensureCustomerExists(env, phone, createdByTg);

  await exec(
    env,
    `
    INSERT INTO transactions (phone, type, amount, currency, note, created_by_tg, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [phone, type, Math.trunc(amount), currency, note ?? null, createdByTg, unixNow()]
  );
}

function helpText(role: Role): string {
  if (role === ROLES.ADMIN) {
    return (
      `${tgBold("یارمەتی - ئەدمین")}\n\n` +
      `${tgBold("کارمەند")}\n` +
      `${tgCode("/addstaff <tg_id>")} زیادکردنی کارمەند\n` +
      `${tgCode("/removestaff <tg_id>")} سڕینەوەی کارمەند\n\n` +
      `${tgBold("کڕیار")}\n` +
      `${tgCode("/addcustomer <phone> <name?>")} زیادکردنی کڕیار\n` +
      `${tgCode("/deletecustomer <phone>")} سڕینەوەی کڕیار\n` +
      `${tgCode("/customer <phone>")} بینینی دۆخی کڕیار\n\n` +
      `${tgBold("قەرز/پارەدان")}\n` +
      `${tgCode("/adddebt <phone> <amount> <IQD|USD> <note?>")} قەرز زیاد بکە\n` +
      `${tgCode("/pay <phone> <amount> <IQD|USD> <note?>")} پارە وەربگرە\n\n` +
      `${tgBold("کڕیار بەخۆی")}\n` +
      `${tgCode("/link 0750xxxxxxx")} بەستن بە ژمارە\n` +
      `${tgCode("/me")} بینینی قەرزەکان\n\n` +
      `${tgCode("/help")} یارمەتی`
    );
  }

  if (role === ROLES.STAFF) {
    return (
      `${tgBold("یارمەتی - کارمەند")}\n\n` +
      `${tgBold("کڕیار")}\n` +
      `${tgCode("/addcustomer <phone> <name?>")} زیادکردنی کڕیار\n` +
      `${tgCode("/customer <phone>")} بینینی دۆخی کڕیار\n\n` +
      `${tgBold("قەرز/پارەدان")}\n` +
      `${tgCode("/adddebt <phone> <amount> <IQD|USD> <note?>")} قەرز زیاد بکە\n` +
      `${tgCode("/pay <phone> <amount> <IQD|USD> <note?>")} پارە وەربگرە\n\n` +
      `${tgCode("/help")} یارمەتی`
    );
  }

  return (
    `${tgBold("یارمەتی - کڕیار")}\n\n` +
    `${tgCode("/link 0750xxxxxxx")} بەستن بە ژمارە\n` +
    `${tgCode("/me")} بینینی قەرزەکان (IQD & USD)\n` +
    `${tgCode("/help")} یارمەتی`
  );
}

function startText(role: Role): string {
  return (
    `👋 سڵاو!\n\n` +
    `ئەمە بۆتی ${tgBold("Kanichnar Debt")} ـە (تەنها بۆ بەڕێوەبردنی قەرز).\n\n` +
    helpText(role)
  );
}

/* =========================
 * Reports (simple)
 * ========================= */
async function reportLast(env: Env, phone: string, limit = 10): Promise<string> {
  const r = await all<any>(
    env,
    `SELECT type, amount, currency, note, created_at FROM transactions WHERE phone=? ORDER BY created_at DESC LIMIT ?`,
    [phone, limit]
  );

  if (!r.rows.length) return `${tgBold("ڕاپۆرت")}\nهیچ مامەڵەیەک نیە.`;

  const lines = r.rows.map((x) => {
    const t = x.type === "payment" ? "پارەدان" : "قەرز";
    const note = x.note ? ` | ${tgCode(String(x.note))}` : "";
    return `• ${t}: ${tgCode(String(x.amount))} ${String(x.currency)}${note}`;
  });

  return `${tgBold("دوایین مامەڵەکان")}\nژمارە: ${tgCode(phone)}\n\n${lines.join("\n")}`;
}

/* =========================
 * Main handler
 * ========================= */
export async function handleMessage(env: Env, update: any) {
  const chatId = getChatId(update);
  const tgId = getTelegramUserId(update);
  const textRaw = getMessageText(update);

  if (!chatId || !tgId || !textRaw) return;

  const text = textRaw.trim();

  await ensureSchema(env);
  await upsertUserFromTelegram(env, tgId, update);

  const user = await getUser(env, tgId);
  const role: Role = (user?.role as Role) || ROLES.CUSTOMER;

  try {
    // START
    if (text.startsWith(COMMANDS.START)) {
      await logAudit(env, { actorTg: String(tgId), action: "START", entity: "users", entityId: user?.id ?? null, meta: { role } });
      await sendMessageSafe(env, chatId, startText(role));
      return;
    }

    // HELP
    if (text.startsWith(COMMANDS.HELP)) {
      await sendMessageSafe(env, chatId, helpText(role));
      return;
    }

    // LINK (customer)
    if (text.startsWith(COMMANDS.LINK)) {
      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");

      if (!isValidPhone(phone)) {
        await sendMessageSafe(env, chatId, `ژمارە هەڵەیە.\nنمونە: ${tgCode("/link 0750xxxxxxx")}`);
        return;
      }

      await ensureCustomerExists(env, phone, tgId);
      await linkPhoneToChat(env, phone, chatId, tgId);

      await logAudit(env, { actorTg: String(tgId), action: "LINK_PHONE", entity: "customers", entityId: phone, meta: { phone } });

      const summary = await formatCustomerSummary(env, phone);
      await sendMessageSafe(env, chatId, `✅ بەسەرکەوتوویی بە ژمارەکەوە بەسترا.\n\n${summary}`);
      return;
    }

    // ME (customer)
    if (text.startsWith(COMMANDS.ME)) {
      const phone = user?.phone ? String(user.phone) : "";
      if (!phone) {
        await sendMessageSafe(env, chatId, `تۆ هێشتا بە ژمارەی مۆبایلەوە نەبەسترای.\nنمونە: ${tgCode("/link 0750xxxxxxx")}`);
        return;
      }

      const summary = await formatCustomerSummary(env, phone);
      await sendMessageSafe(env, chatId, summary);
      return;
    }

    // From here: staff/admin only
    const isStaff = role === ROLES.ADMIN || role === ROLES.STAFF;

    // ADD STAFF (admin only)
    if (text.startsWith(COMMANDS.ADD_STAFF)) {
      if (role !== ROLES.ADMIN) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const staffTg = Number(args[0] || 0);

      if (!Number.isFinite(staffTg) || staffTg <= 0) {
        await sendMessageSafe(env, chatId, `هەڵە. نمونە: ${tgCode("/addstaff 123456789")}`);
        return;
      }

      await addStaff(env, staffTg, tgId);
      await logAudit(env, { actorTg: String(tgId), action: "CREATE_STAFF", entity: "staff", entityId: staffTg, meta: { staffTg } });

      await sendMessageSafe(env, chatId, `✅ کارمەند زیادکرا: ${tgCode(String(staffTg))}`);
      return;
    }

    // REMOVE STAFF (admin only)
    if (text.startsWith(COMMANDS.REMOVE_STAFF)) {
      if (role !== ROLES.ADMIN) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const staffTg = Number(args[0] || 0);

      if (!Number.isFinite(staffTg) || staffTg <= 0) {
        await sendMessageSafe(env, chatId, `هەڵە. نمونە: ${tgCode("/removestaff 123456789")}`);
        return;
      }

      await removeStaff(env, staffTg);
      await logAudit(env, { actorTg: String(tgId), action: "REMOVE_STAFF", entity: "staff", entityId: staffTg, meta: { staffTg } });

      await sendMessageSafe(env, chatId, `✅ کارمەند سڕایەوە: ${tgCode(String(staffTg))}`);
      return;
    }

    // ADD CUSTOMER (admin+staff)
    if (text.startsWith(COMMANDS.ADD_CUSTOMER)) {
      if (!isStaff) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");
      const name = args.slice(1).join(" ").trim() || null;

      if (!isValidPhone(phone)) {
        await sendMessageSafe(env, chatId, `ژمارە هەڵەیە.\nنمونە: ${tgCode("/addcustomer 0750xxxxxxx ناو")}`);
        return;
      }

      await exec(
        env,
        `
        INSERT INTO customers (phone, full_name, created_by_tg, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          full_name=COALESCE(excluded.full_name, customers.full_name)
        `,
        [phone, name, tgId, unixNow()]
      );

      await logAudit(env, { actorTg: String(tgId), action: "CREATE_CUSTOMER", entity: "customers", entityId: phone, meta: { phone, name } });

      await sendMessageSafe(
        env,
        chatId,
        `✅ کڕیار تۆمارکرا.\nژمارە: ${tgCode(phone)}${name ? `\nناو: ${tgCode(name)}` : ""}`
      );
      return;
    }

    // DELETE CUSTOMER (admin only)
    if (text.startsWith(COMMANDS.DELETE_CUSTOMER)) {
      if (role !== ROLES.ADMIN) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");

      if (!isValidPhone(phone)) {
        await sendMessageSafe(env, chatId, `ژمارە هەڵەیە.\nنمونە: ${tgCode("/deletecustomer 0750xxxxxxx")}`);
        return;
      }

      await exec(env, `DELETE FROM customers WHERE phone=?`, [phone]);
      await exec(env, `DELETE FROM transactions WHERE phone=?`, [phone]);
      await exec(env, `DELETE FROM notify_links WHERE phone=?`, [phone]);

      await logAudit(env, { actorTg: String(tgId), action: "DELETE_CUSTOMER", entity: "customers", entityId: phone, meta: { phone } });

      await sendMessageSafe(env, chatId, `✅ کڕیار و مامەڵەکانی سڕایەوە.\nژمارە: ${tgCode(phone)}`);
      return;
    }

    // VIEW CUSTOMER (admin+staff)
    if (text.startsWith(COMMANDS.CUSTOMER)) {
      if (!isStaff) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");
      if (!isValidPhone(phone)) {
        await sendMessageSafe(env, chatId, `هەڵە. نمونە: ${tgCode("/customer 0750xxxxxxx")}`);
        return;
      }

      const summary = await formatCustomerSummary(env, phone);
      await sendMessageSafe(env, chatId, summary);
      return;
    }

    // REPORT (admin+staff)
    if (text.startsWith(COMMANDS.REPORT)) {
      if (!isStaff) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }
      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");
      if (!isValidPhone(phone)) {
        await sendMessageSafe(env, chatId, `هەڵە. نمونە: ${tgCode("/report 0750xxxxxxx")}`);
        return;
      }
      const rep = await reportLast(env, phone, 10);
      await sendMessageSafe(env, chatId, rep);
      return;
    }

    // ADD DEBT (admin+staff)
    if (text.startsWith(COMMANDS.ADD_DEBT)) {
      if (!isStaff) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");
      const amount = parseAmount(args[1]);
      const currency = parseCurrency(args[2]);
      const note = args.slice(3).join(" ").trim() || undefined;

      if (!isValidPhone(phone) || amount <= 0) {
        await sendMessageSafe(env, chatId, `هەڵە.\nنمونە: ${tgCode("/adddebt 0750xxxxxxx 5000 IQD نوت")}`);
        return;
      }

      await addTransaction(env, phone, "debt", amount, currency, tgId, note);

      await logAudit(env, { actorTg: String(tgId), action: "ADD_DEBT", entity: "transactions", entityId: phone, meta: { phone, amount, currency, note } });

      await notifyCustomerIfLinked(
        env,
        phone,
        `قەرز زیادکرا: ${tgCode(String(amount))} ${currency}${note ? `\nنوت: ${tgCode(note)}` : ""}`
      );

      const bal = await calcBalance(env, phone, currency);
      await sendMessageSafe(env, chatId, `✅ قەرز تۆمارکرا.\nقەرزی نوێ (${currency}): ${tgCode(String(bal))}`);
      return;
    }

    // PAYMENT (admin+staff)
    if (text.startsWith(COMMANDS.ADD_PAYMENT)) {
      if (!isStaff) {
        await sendMessageSafe(env, chatId, "دەسەڵاتت نیە.");
        return;
      }

      const args = splitArgs(text);
      const phone = normalizePhone(args[0] || "");
      const amount = parseAmount(args[1]);
      const currency = parseCurrency(args[2]);
      const note = args.slice(3).join(" ").trim() || undefined;

      if (!isValidPhone(phone) || amount <= 0) {
        await sendMessageSafe(env, chatId, `هەڵە.\nنمونە: ${tgCode("/pay 0750xxxxxxx 5000 IQD نوت")}`);
        return;
      }

      await addTransaction(env, phone, "payment", amount, currency, tgId, note);

      await logAudit(env, { actorTg: String(tgId), action: "ADD_PAYMENT", entity: "transactions", entityId: phone, meta: { phone, amount, currency, note } });

      await notifyCustomerIfLinked(
        env,
        phone,
        `پارە وەرگیرا: ${tgCode(String(amount))} ${currency}${note ? `\nنوت: ${tgCode(note)}` : ""}`
      );

      const bal = await calcBalance(env, phone, currency);
      await sendMessageSafe(env, chatId, `✅ پارەدان تۆمارکرا.\nقەرزی نوێ (${currency}): ${tgCode(String(bal))}`);
      return;
    }

    // Default
    await sendMessageSafe(env, chatId, `فەرمان نەناسرا.\n${tgCode("/help")} بۆ یارمەتی`);
  } catch (err: any) {
    await auditError(env, String(tgId), "message.handleMessage", err, { text });
    await sendMessageSafe(env, chatId, "هەڵەیەک ڕوویدا. دووبارە هەوڵ بدە.");
  }
}