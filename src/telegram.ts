import type { Env, TaskRow } from "./types";

const TG_API = "https://api.telegram.org";
// Telegram 單條訊息上限 4096 字元，留啲餘地
const TG_MAX_LEN = 4000;

export async function tgCall(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) console.error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data;
}

/** 超長訊息自動分段（盡量喺換行位切），button 掛喺最後一段。回傳係咪全部發送成功。 */
export async function sendMessage(env: Env, text: string, replyMarkup?: unknown): Promise<boolean> {
  const chunks = splitMessage(text);
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const data = await tgCall(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: chunks[i],
      reply_markup: isLast ? replyMarkup : undefined,
    });
    if (!data.ok) ok = false;
  }
  return ok;
}

function splitMessage(text: string): string[] {
  const trimmed = text.trim() || "（空訊息）";
  if (trimmed.length <= TG_MAX_LEN) return [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > TG_MAX_LEN) {
    let cut = rest.lastIndexOf("\n", TG_MAX_LEN);
    if (cut < TG_MAX_LEN / 2) cut = TG_MAX_LEN;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 每個未完成任務一個「✅ 完成」button */
export function taskButtons(tasks: TaskRow[]): unknown {
  return {
    inline_keyboard: tasks.slice(0, 30).map((t) => [
      { text: `✅ ${t.content.slice(0, 40)}`, callback_data: `done:${t.id}` },
    ]),
  };
}

export async function listOpenTasks(env: Env): Promise<TaskRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE status = 'open' ORDER BY due IS NULL, due, created_at",
  ).all<TaskRow>();
  return results;
}
