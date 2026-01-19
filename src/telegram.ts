function apiBase(env: { BOT_TOKEN: string }) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}`;
}

export function tgEscape(text: string): string {
  // For HTML parse_mode
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function tgBold(text: string): string {
  return `<b>${tgEscape(text)}</b>`;
}

export function tgCode(text: string): string {
  return `<code>${tgEscape(text)}</code>`;
}

export async function sendMessage(
  env: { BOT_TOKEN: string },
  chatId: number,
  htmlText: string,
  opts?: { disablePreview?: boolean }
) {
  const body = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: opts?.disablePreview ?? true,
  };

  const res = await fetch(`${apiBase(env)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }
}

export async function sendMessageSafe(
  env: { BOT_TOKEN: string },
  chatId: number,
  htmlText: string
) {
  try {
    await sendMessage(env, chatId, htmlText);
  } catch {
    // swallow error to avoid breaking whole update
  }
}