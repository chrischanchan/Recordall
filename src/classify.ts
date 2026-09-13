import Anthropic from "@anthropic-ai/sdk";
import { today } from "./time";
import type { Env, Interpretation, RecentCapture, TaskRow } from "./types";

export const MODEL = "claude-sonnet-5";

const SYSTEM = `你係一個私人助理，負責理解用戶口述嘅錄音轉錄文字。用戶講嘢係香港粵語，轉錄可能有錯字，請按上下文理解。

用戶嘅說話屬於四種意圖之一：

1. "create"（預設）：記低新嘢。再分四類：
   - "task"：待辦事項、要做嘅嘢、提醒（一句可以包含幾個任務）
   - "meeting"：會議、傾談、對話嘅內容（通常較長，有多方觀點或討論）
   - "idea"：靈感、想法、計劃構思
   - "journal"：日記、生活雜記、感受、流水帳

2. "complete"：用戶話某啲嘢已經做完／搞掂／唔使做，而且明顯對應到「未完成任務」清單入面嘅項目。

3. "append"：用戶明示要補充或者跟進之前嘅**內容紀錄**（會議／想法／日記），例如提到「頭先個會」「補充返」，而且對應到「最近紀錄」清單入面嘅項目。

4. "update"：用戶想**修改／更正某個現有任務**嘅內容或期限——改收件人、改名、改日子、糾正錯誤等。判斷關鍵：句式似「唔係Ｘ，係Ｙ」「應該係⋯」「改做⋯」「Ｘ其實係Ｙ」，而且明顯對應到「未完成任務」清單入面嘅項目。**更正任務要用 update，唔好當 append 或 create（嗰啲會加新任務造成重複）。**

判斷步驟：**首先**逐個對照「未完成任務」清單——如果用戶講嘅嘢明顯指緊清單入面某個現有任務（提到相同嘅人名、事項、關鍵字），佢就係想 complete 或 update 嗰個任務，**唔好開新任務造成重複**。完全對唔上現有任務或紀錄，先至係 create。

例子（假設任務清單有「Send租約俾Egaver」同「同陳生開會傾訂單（期限聽日）」）：
- 「聽日要交電費同買牛奶」→ create，type=task，兩個任務
- 「租約搞掂咗」→ complete，對應「Send租約俾Egaver」
- 「租約唔係send俾Egaver，係send俾Agatha」→ update，content改做「Send租約俾Agatha」
- 「同陳生開會嗰個唔係聽日，改咗後日」→ update，due改做後日嘅日期，content唔使改（null）
- 「同陳生個會改咗喺公司開」→ update，content改做「同陳生開會傾訂單（喺公司）」
- 「頭先個會議記錄補充返，仲要跟進物流報價」→ append，對應最近嘅會議紀錄

輸出規則（只輸出一個 JSON object，唔好有任何其他文字或 markdown 圍欄）：
{"intent":"create|complete|append|update", ...其餘欄位視乎 intent}

intent="create" 時：
- type："task|meeting|idea|journal"
- title：簡短標題（15 字以內，繁體中文）
- tags：1-3 個簡短標籤（唔好用逗號）
- tasks：type="task" 時抽出全部任務（最少一個）；type="meeting" 時抽出跟進行動項目；其他類型畀空陣列。每個任務有 content（清晰、可執行嘅一句）同 due（有明確日子先填 YYYY-MM-DD，「聽日」「下星期五」等要換算做實際日期，冇提到就 null）
- meeting：type="meeting" 時填 {"summary":"重點摘要（繁體中文，200 字內）","decisions":["決定事項"]}；其他類型畀 null

intent="complete" 時：
- complete_task_ids：好肯定對應到嘅任務 id 陣列（可以多過一個）
- complete_candidates：唔太肯定、想畀用戶自己揀嘅候選任務 id 陣列
- 兩個都只可以用「未完成任務」清單入面出現過嘅 id

intent="update" 時：
- updates：[{"task_id":目標任務id,"content":"改完之後嘅完整任務內容（內容唔使改就 null）","due":"改完嘅期限 YYYY-MM-DD（期限唔使改就 null）"}]
- task_id 只可以用「未完成任務」清單入面出現過嘅 id；可以一次改多個任務

intent="append" 時：
- append_capture_id：「最近紀錄」清單入面對應嗰個 id
- append_text：整理好嘅補充內容（繁體中文，保留用戶原意）
- title：簡短講句補充咗乜（15 字以內）
- tasks：補充入面新嘅行動項目（規則同上），冇就空陣列`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceIds(value: unknown, valid: Set<number>): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((n) => valid.has(n));
}

function coerceDue(value: unknown): string | null {
  return typeof value === "string" && DATE_RE.test(value.trim()) ? value.trim() : null;
}

/** AI 完全解唔到嗰陣嘅保底：當日記照存，起碼唔會跌資料 */
function fallbackInterpretation(text: string): Interpretation {
  return {
    intent: "create",
    type: "journal",
    title: text.slice(0, 15),
    tags: [],
    tasks: [],
    meeting: null,
    complete_task_ids: [],
    complete_candidates: [],
    append_capture_id: null,
    append_text: "",
    updates: [],
  };
}

/** 由 model 輸出入面抽個 JSON object 出嚟：容忍圍欄、前後有廢話 */
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function interpret(
  env: Env,
  text: string,
  openTasks: TaskRow[],
  recentCaptures: RecentCapture[],
): Promise<Interpretation> {
  const taskList = openTasks.length
    ? openTasks.map((t) => `${t.id}｜${t.content}｜期限：${t.due ?? "冇"}`).join("\n")
    : "（冇）";
  const captureList = recentCaptures.length
    ? recentCaptures.map((c) => `${c.id}｜${c.type}｜${c.title ?? "（無標題）"}｜${c.created_at}`).join("\n")
    : "（冇）";

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `今日係 ${today(env)}（用戶當地時間，時區 ${env.TIMEZONE}），計「聽日」「後日」「今個禮拜」等相對日子一律以呢個日期為準。

未完成任務清單（id｜內容｜期限）：
${taskList}

最近紀錄（id｜類別｜標題｜時間，時間係 UTC）：
${captureList}

以下係錄音轉錄：

${text}`,
      },
    ],
  });

  let raw = "";
  for (const block of response.content) {
    if (block.type === "text") raw += block.text;
  }
  const obj = extractJson(raw);
  if (!obj) {
    console.error("AI output not parseable, falling back to journal:", raw.slice(0, 500));
    return fallbackInterpretation(text);
  }
  const parsed = obj as unknown as Interpretation;

  // 逐個欄位驗證，AI 輸出唔啱格式就穩陣咁 fallback
  const validTaskIds = new Set(openTasks.map((t) => t.id));
  const validCaptureIds = new Set(recentCaptures.map((c) => c.id));

  if (!["create", "complete", "append", "update"].includes(parsed.intent)) parsed.intent = "create";
  parsed.complete_task_ids = coerceIds(parsed.complete_task_ids, validTaskIds);
  parsed.complete_candidates = coerceIds(parsed.complete_candidates, validTaskIds);
  parsed.append_capture_id =
    typeof parsed.append_capture_id === "number" && validCaptureIds.has(parsed.append_capture_id)
      ? parsed.append_capture_id
      : null;
  parsed.append_text = typeof parsed.append_text === "string" ? parsed.append_text.trim() : "";

  // append 但對唔上紀錄 → 當新紀錄處理
  if (parsed.intent === "append" && (!parsed.append_capture_id || !parsed.append_text)) {
    parsed.intent = "create";
  }

  parsed.updates = Array.isArray(parsed.updates)
    ? parsed.updates
        .filter((u) => u && validTaskIds.has(Number(u.task_id)))
        .map((u) => ({
          task_id: Number(u.task_id),
          content: typeof u.content === "string" && u.content.trim() ? u.content.trim() : null,
          due: coerceDue(u.due),
        }))
        .filter((u) => u.content !== null || u.due !== null)
    : [];

  if (!["task", "meeting", "idea", "journal"].includes(parsed.type)) parsed.type = "journal";
  parsed.title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : text.slice(0, 15);
  parsed.tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  parsed.tasks = Array.isArray(parsed.tasks)
    ? parsed.tasks
        .filter((t) => t && typeof t.content === "string" && t.content.trim())
        .map((t) => ({ content: t.content.trim(), due: coerceDue(t.due) }))
    : [];
  if (parsed.type !== "meeting") parsed.meeting = null;

  // 話係任務但一個都抽唔出 → 成句當一個任務，唔好變咗隱形紀錄
  if (parsed.intent === "create" && parsed.type === "task" && parsed.tasks.length === 0) {
    parsed.tasks = [{ content: text.trim().slice(0, 200), due: null }];
  }
  return parsed;
}
