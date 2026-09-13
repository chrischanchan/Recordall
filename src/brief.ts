import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./classify";
import { listOpenTasks, sendMessage, taskButtons } from "./telegram";
import { localDate } from "./time";
import type { Env } from "./types";

const BRIEF_SYSTEM = `你係用戶嘅私人助理。根據以下未完成任務清單，寫一份簡潔嘅晨早簡報，用香港繁體中文書面語。

要求：
- 開頭一句簡短問候（提及今日日期同星期幾）
- 將任務按緩急排序：今日到期／逾期嘅放最前，之後係有期限嘅，最後係冇期限嘅
- 逾期任務要標明逾期
- 任務多嘅話可以分組（例如「今日必做」「本週內」「有空再做」）
- 結尾一句簡短鼓勵
- 純文字輸出，唔好用 markdown 符號（Telegram 直接顯示）
- 全文 300 字以內`;

export async function sendMorningBrief(env: Env): Promise<void> {
  const tasks = await listOpenTasks(env);

  if (tasks.length === 0) {
    await sendMessage(env, "🌞 早晨！今日冇未完成任務，享受清爽嘅一日！");
    return;
  }

  const today = new Intl.DateTimeFormat("zh-HK", {
    timeZone: env.TIMEZONE,
    dateStyle: "full",
  }).format(new Date());

  const taskList = tasks
    .map((t) => `- ${t.content}${t.due ? `（期限：${t.due}）` : ""}（建立於 ${localDate(env, t.created_at)}）`)
    .join("\n");
  const fallback = `🌞 早晨！你有 ${tasks.length} 項未完成任務：\n\n${taskList}`;

  let brief = "";
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: BRIEF_SYSTEM,
      messages: [{ role: "user", content: `今日係 ${today}。未完成任務：\n${taskList}` }],
    });
    if (response.stop_reason !== "max_tokens") {
      brief = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
    }
  } catch (err) {
    console.error("Claude brief failed:", err);
  }

  // Claude 出事／輸出空白都照發清單，唔好成個簡報冇咗
  await sendMessage(env, brief || fallback, taskButtons(tasks));
}
