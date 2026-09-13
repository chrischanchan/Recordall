import type { Env } from "./types";

/**
 * 分段上傳：捷徑將長文字切做幾段，逐段 GET 上嚟（session + part + total）。
 * 收齊全部分段就拼返成段文字回傳，未齊就回傳 null。
 */
export async function storePart(
  env: Env,
  session: string,
  part: number,
  total: number,
  content: string,
): Promise<string | null> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO capture_parts (session, part, total, content) VALUES (?, ?, ?, ?)",
  )
    .bind(session, part, total, content)
    .run();

  const { results } = await env.DB.prepare(
    "SELECT part, content FROM capture_parts WHERE session = ? ORDER BY part",
  )
    .bind(session)
    .all<{ part: number; content: string }>();
  if (results.length < total) return null;

  await env.DB.prepare("DELETE FROM capture_parts WHERE session = ?").bind(session).run();
  return results.map((r) => r.content).join("");
}

/** 清走超過一日仲未齊嘅分段（捷徑中途斷咗） */
export async function purgeStaleParts(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM capture_parts WHERE created_at < datetime('now', '-1 day')").run();
}
