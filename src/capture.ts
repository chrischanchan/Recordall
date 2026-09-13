import { interpret } from "./classify";
import { appendToPage, createContentPage, createTaskPage, updateTaskPage } from "./notion";
import { completeTask } from "./tasks";
import { listOpenTasks, sendMessage, taskButtons } from "./telegram";
import {
  TYPE_LABEL,
  type Env,
  type ExtractedTask,
  type Interpretation,
  type RecentCapture,
  type TaskRow,
} from "./types";

export interface CaptureResult {
  intent: string;
  label: string;
  title: string;
  tasks: number;
  /** 人睇嘅完整摘要，Telegram 同 iPhone 通知共用 */
  notice: string;
}

interface CaptureOptions {
  /** 重試已存在嘅 pending 紀錄時傳入，唔會再插新 row */
  captureId?: number;
  /** 自動重試時唔好每次都彈 Telegram 警告 */
  silentFailure?: boolean;
}

// captures.type 除咗四類內容之外仲有：pending（原文已存、AI 未處理）、command（完成／修改／補充指令嘅原文）
const CONTENT_TYPES_SQL = "('task','meeting','idea','journal')";

/**
 * 核心流程：先將原文存入 D1（唔會跌資料）→ AI 意圖識別 → 按意圖處理 → Notion → Telegram。
 * Notion／Telegram 失敗只記 log；AI 失敗就留低 pending，之後自動重試。
 */
export async function processCapture(env: Env, text: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
  let captureId = opts.captureId;
  if (captureId === undefined) {
    const inserted = await env.DB.prepare("INSERT INTO captures (type, raw_text) VALUES ('pending', ?)")
      .bind(text)
      .run();
    captureId = inserted.meta.last_row_id;
  }

  const openTasks = await listOpenTasks(env);
  const { results: recentCaptures } = await env.DB.prepare(
    `SELECT id, type, title, notion_page_id, created_at FROM captures WHERE type IN ${CONTENT_TYPES_SQL} ORDER BY id DESC LIMIT 8`,
  ).all<RecentCapture>();

  let it: Interpretation;
  try {
    it = await interpret(env, text, openTasks, recentCaptures);
  } catch (err) {
    console.error(`interpret failed, capture #${captureId} kept as pending:`, err);
    const notice = `⚠️ AI 暫時處理唔到，原文已經保存（#${captureId}），每小時會自動重試，或者打 /retry 即刻再試。\n\n「${text.slice(0, 200)}」`;
    if (!opts.silentFailure) await safeSend(env, notice);
    return { intent: "pending", label: "待處理（原文已保存）", title: text.slice(0, 20), tasks: 0, notice };
  }

  if (it.intent === "create") {
    return handleCreate(env, it, text, captureId);
  }

  let result: CaptureResult;
  if (it.intent === "complete") result = await handleComplete(env, it, openTasks);
  else if (it.intent === "update") result = await handleUpdate(env, it, openTasks);
  else result = await handleAppend(env, it, recentCaptures);

  await env.DB.prepare("UPDATE captures SET type = 'command', title = ? WHERE id = ?")
    .bind(`${result.label}：${result.title}`.slice(0, 100), captureId)
    .run();
  return result;
}

/** 重新處理仲係 pending 嘅紀錄（AI 之前出錯／請求中途斷線）。回傳成功處理嘅數目。 */
export async function retryPending(env: Env, minAgeMinutes: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, raw_text FROM captures WHERE type = 'pending' AND created_at <= datetime('now', ?) ORDER BY id LIMIT 10",
  )
    .bind(`-${minAgeMinutes} minutes`)
    .all<{ id: number; raw_text: string }>();

  let done = 0;
  for (const row of results) {
    const result = await processCapture(env, row.raw_text, { captureId: row.id, silentFailure: true });
    if (result.intent !== "pending") done++;
  }
  return done;
}

/** 建任務（D1 + Notion）。回傳 Notion 係咪全部成功。 */
async function createTasks(env: Env, tasks: ExtractedTask[], captureId: number): Promise<boolean> {
  let notionOk = true;
  for (const t of tasks) {
    let pageId: string | null = null;
    try {
      pageId = await createTaskPage(env, t.content, t.due);
    } catch (err) {
      notionOk = false;
      console.error("Notion task page failed:", err);
    }
    await env.DB.prepare("INSERT INTO tasks (content, due, capture_id, notion_page_id) VALUES (?, ?, ?, ?)")
      .bind(t.content, t.due, captureId, pageId)
      .run();
  }
  return notionOk;
}

function formatTaskLine(t: ExtractedTask, prefix = ""): string {
  return `▫️ ${prefix}${t.content}${t.due ? `（${t.due}）` : ""}`;
}

async function handleCreate(env: Env, it: Interpretation, text: string, captureId: number): Promise<CaptureResult> {
  await env.DB.prepare("UPDATE captures SET type = ?, title = ? WHERE id = ?").bind(it.type, it.title, captureId).run();

  // 非任務類 → 建內容 page
  let notionOk = true;
  if (it.type !== "task") {
    try {
      const pageId = await createContentPage(env, it, text);
      await env.DB.prepare("UPDATE captures SET notion_page_id = ? WHERE id = ?").bind(pageId, captureId).run();
    } catch (err) {
      notionOk = false;
      console.error("Notion content page failed:", err);
    }
  }

  // 任務（task 類本身，或 meeting 抽出嘅行動項目）
  if (!(await createTasks(env, it.tasks, captureId))) notionOk = false;

  const lines = [`📌 已記錄為${TYPE_LABEL[it.type]}：《${it.title}》`];
  if (it.tasks.length) lines.push("", ...it.tasks.map((t) => formatTaskLine(t)));
  if (it.type === "meeting" && it.meeting?.summary) lines.push("", `摘要：${it.meeting.summary.slice(0, 150)}`);
  if (!notionOk) lines.push("", "⚠️ 同步 Notion 失敗，資料已保存喺本地資料庫，請檢查 Notion 設定。");
  const notice = lines.join("\n");
  await safeSend(env, notice);

  return { intent: "create", label: TYPE_LABEL[it.type], title: it.title, tasks: it.tasks.length, notice };
}

async function handleComplete(env: Env, it: Interpretation, openTasks: TaskRow[]): Promise<CaptureResult> {
  const doneNames: string[] = [];
  for (const id of it.complete_task_ids) {
    const task = await completeTask(env, id);
    if (task) doneNames.push(task.content);
  }

  const lines: string[] = [];
  if (doneNames.length) lines.push("✅ 已完成：", ...doneNames.map((n) => `▫️ ${n}`));

  // 唔肯定嘅（或者一個都對唔上）→ 畀掣用戶自己揀
  let candidates = openTasks.filter((t) => it.complete_candidates.includes(t.id));
  if (!doneNames.length && !candidates.length) {
    candidates = openTasks;
    lines.push("🤔 你話有嘢完成咗，但我對唔實係邊個任務，撳掣話我知：");
  } else if (candidates.length) {
    lines.push("", "🤔 呢啲我唔肯定，係嘅話撳掣完成：");
  }

  if (!lines.length) lines.push("🤷 你冇未完成任務，冇嘢可以剔。");
  const notice = lines.join("\n");
  await safeSend(env, notice, candidates.length ? taskButtons(candidates) : undefined);

  return {
    intent: "complete",
    label: "完成任務",
    title: doneNames.join("、") || "待你喺 Telegram 確認",
    tasks: doneNames.length,
    notice,
  };
}

async function handleUpdate(env: Env, it: Interpretation, openTasks: TaskRow[]): Promise<CaptureResult> {
  const changed: string[] = [];
  let notionOk = true;

  for (const u of it.updates) {
    const task = openTasks.find((t) => t.id === u.task_id);
    if (!task) continue;
    const newContent = u.content ?? task.content;
    const newDue = u.due ?? task.due;

    await env.DB.prepare("UPDATE tasks SET content = ?, due = ? WHERE id = ?").bind(newContent, newDue, u.task_id).run();

    if (task.notion_page_id) {
      try {
        await updateTaskPage(env, task.notion_page_id, u.content, u.due);
      } catch (err) {
        notionOk = false;
        console.error("Notion update task failed:", err);
      }
    }

    const parts: string[] = [];
    if (u.content) parts.push(`${task.content} → ${newContent}`);
    if (u.due) parts.push(`期限改為 ${newDue}`);
    changed.push(parts.join("，"));
  }

  if (changed.length) {
    const lines = ["✏️ 已修改任務：", ...changed.map((c) => `▫️ ${c}`)];
    if (!notionOk) lines.push("", "⚠️ 同步 Notion 失敗，本地資料庫已更新。");
    const notice = lines.join("\n");
    await safeSend(env, notice);
    return { intent: "update", label: "修改任務", title: changed[0], tasks: changed.length, notice };
  }

  // AI 話係修改但對唔實邊個任務 → 唔好亂改，話返畀用戶知
  const list = openTasks.map((t) => `▫️ ${t.content}`).join("\n");
  const notice = `🤔 你想修改任務，但我對唔實係邊一個。而家嘅未完成任務：\n${list}\n\n請講清楚啲再試（例如「送租約嗰個任務，收件人改做 Agatha」）。`;
  await safeSend(env, notice);
  return { intent: "update", label: "修改任務", title: "對唔實目標，未有修改", tasks: 0, notice };
}

async function handleAppend(env: Env, it: Interpretation, recentCaptures: RecentCapture[]): Promise<CaptureResult> {
  const target = recentCaptures.find((c) => c.id === it.append_capture_id)!;

  // 補充內容駁落原始紀錄後面
  await env.DB.prepare("UPDATE captures SET raw_text = raw_text || ? WHERE id = ?")
    .bind(`\n\n【補充】${it.append_text}`, target.id)
    .run();

  let notionOk = true;
  if (target.notion_page_id) {
    try {
      await appendToPage(env, target.notion_page_id, it.append_text, it.tasks.map((t) => t.content));
    } catch (err) {
      notionOk = false;
      console.error("Notion append failed:", err);
    }
  }

  // 補充入面嘅新行動項目照樣變任務
  if (!(await createTasks(env, it.tasks, target.id))) notionOk = false;

  const lines = [`📎 已補充到《${target.title ?? "（無標題）"}》：${it.title}`];
  if (it.tasks.length) lines.push("", ...it.tasks.map((t) => formatTaskLine(t, "新任務：")));
  if (!target.notion_page_id) {
    lines.push("", "ℹ️ 呢個紀錄冇對應嘅 Notion page，補充只保存喺本地資料庫。");
  } else if (!notionOk) {
    lines.push("", "⚠️ 同步 Notion 失敗，補充已保存喺本地資料庫。");
  }
  const notice = lines.join("\n");
  await safeSend(env, notice);

  return { intent: "append", label: "補充紀錄", title: target.title ?? it.title, tasks: it.tasks.length, notice };
}

async function safeSend(env: Env, text: string, replyMarkup?: unknown): Promise<void> {
  try {
    await sendMessage(env, text, replyMarkup);
  } catch (err) {
    console.error("Telegram send failed:", err);
  }
}
