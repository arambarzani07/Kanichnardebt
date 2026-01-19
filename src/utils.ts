export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export function splitArgs(text: string): string[] {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/g).slice(1);
}

export function getMessageText(update: any): string | null {
  return (
    update?.message?.text ??
    update?.edited_message?.text ??
    update?.callback_query?.data ??
    null
  );
}

export function getChatId(update: any): number | null {
  return (
    update?.message?.chat?.id ??
    update?.edited_message?.chat?.id ??
    update?.callback_query?.message?.chat?.id ??
    null
  );
}

export function getTelegramUserId(update: any): number | null {
  return (
    update?.message?.from?.id ??
    update?.edited_message?.from?.id ??
    update?.callback_query?.from?.id ??
    null
  );
}

/**
 * Phone normalize (Kurdistan/Iraq style)
 * Accept: 0750xxxxxxx, 750xxxxxxx, +964750xxxxxxx, 964750xxxxxxx
 * Return: 0750xxxxxxx (local format)
 */
export function normalizePhone(raw: string): string {
  let s = (raw || "").trim();
  s = s.replace(/[^\d+]/g, "");

  if (s.startsWith("+964")) s = s.slice(4);
  if (s.startsWith("964")) s = s.slice(3);

  // now s likely starts with 7xxxxxxxxx
  if (s.length === 10 && s.startsWith("7")) return "0" + s;
  if (s.length === 11 && s.startsWith("07")) return s;

  return s;
}

export function isValidPhone(phone: string): boolean {
  const p = normalizePhone(phone);
  return /^07\d{9}$/.test(p);
}

export function safeJson(obj: unknown): string {
  try {
    return JSON.stringify(obj ?? null);
  } catch {
    return "{}";
  }
}