import { Hono, type Context } from "hono";
import { sendMorningBrief } from "./brief";
import { processCapture, retryPending, type CaptureResult } from "./capture";
import { purgeStaleParts, storePart } from "./parts";
import { completeTask } from "./tasks";
import { listOpenTasks, sendMessage, taskButtons, tgCall } from "./telegram";
import { localDate, localHour } from "./time";
import type { Env, TaskRow } from "./types";

type Ctx = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const HELP_TEXT = `指令：
/list — 未完成任務（可撳掣完成）
/done — 最近完成咗嘅任務
/all — 全部任務連狀態
/pending — 未處理到嘅紀錄
/retry — 即刻重試未處理嘅紀錄
/help — 呢個說明

直接打字就會當一次紀錄（新任務／會議／想法／日記，或者話我知完成咗、要修改邊個任務）。`;

function authorized(c: Ctx): boolean {
  return c.req.header("Authorization") === `Bearer ${c.env.CAPTURE_TOKEN}`;
}

app.get("/", (c) => c.text("personal assistant is running"));

// iPhone 捷徑入口（GET 版：部分裝置嘅 Shortcuts 發唔到 POST，用 query 參數傳內容）
// URL 有 ~16KB 上限，所以支援分段：?session=<id>&part=<第幾段>&total=<共幾段>&content=<呢段文字>，收齊先處理
app.get("/capture", async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const content = c.req.query("content")?.trim();
  if (!content) return c.text("personal assistant capture endpoint is ready");

  const session = c.req.query("session")?.trim();
  const part = Number(c.req.query("part"));
  const total = Number(c.req.query("total"));
  if (session && Number.isInteger(part) && Number.isInteger(total) && total > 1 && part >= 1 && part <= total) {
    const assembled = await storePart(c.env, session, part, total, content);
    if (assembled === null) {
      return reply(c, {
        intent: "part",
        label: "已收到分段",
        title: `${part}/${total}`,
        tasks: 0,
        notice: `📥 已收到第 ${part}/${total} 段，等緊其餘部分⋯`,
      });
    }
    return reply(c, await processCapture(c.env, assembled));
  }

  return reply(c, await processCapture(c.env, content));
});

/** ?format=text 回純文字摘要（iPhone 捷徑通知直接顯示），否則回 JSON */
function reply(c: Ctx, result: CaptureResult) {
  if (c.req.query("format") === "text") return c.text(result.notice);
  return c.json({ ok: true, ...result });
}

// iPhone 捷徑入口（POST 版：JSON、表單、檔案或純文字 body 都食）
app.post("/capture", async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const text = await readCaptureBody(c);
  if (!text) return c.json({ ok: false, error: "empty content" }, 400);

  return reply(c, await processCapture(c.env, text));
});

async function readCaptureBody(c: Ctx): Promise<string | undefined> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json<{ content?: unknown }>().catch(() => null);
    return typeof body?.content === "string" ? body.content.trim() || undefined : undefined;
  }
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody().catch(() => null);
    const value = form?.["content"] ?? form?.["file"];
    if (typeof value === "string") return value.trim() || undefined;
    if (value instanceof File) return (await value.text()).trim() || undefined;
    return undefined;
  }
  // Shortcuts 揀「檔案」做 request body 嗰陣係直接送檔案內容
  const raw = await c.req.text().catch(() => "");
  return raw.trim() || undefined;
}

// Telegram webhook
app.post("/telegram", async (c) => {
  if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ ok: false }, 401);
  }
  const update: any = await c.req.json().catch(() => null);
  if (!update) return c.json({ ok: true });

  // 撳「✅ 完成」button
  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.from?.id) !== c.env.TELEGRAM_CHAT_ID) {
      await tgCall(c.env, "answerCallbackQuery", { callback_query_id: cq.id, text: "呢個唔係你嘅助理" });
      return c.json({ ok: true });
    }
    const match = /^done:(\d+)$/.exec(cq.data ?? "");
    if (!match) {
      await tgCall(c.env, "answerCallbackQuery", { callback_query_id: cq.id });
      return c.json({ ok: true });
    }
    const task = await completeTask(c.env, Number(match[1]));
    if (task) {
      await tgCall(c.env, "answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `已完成：${task.content.slice(0, 50)}`,
      });
      await sendMessage(c.env, `✅ 已完成：${task.content}`);
    } else {
      await tgCall(c.env, "answerCallbackQuery", { callback_query_id: cq.id, text: "呢個任務已經完成咗" });
    }
    return c.json({ ok: true });
  }

  // 文字訊息（只理會你自己）
  const msg = update.message;
  if (!msg?.text || String(msg.chat?.id) !== c.env.TELEGRAM_CHAT_ID) return c.json({ ok: true });
  const text: string = msg.text.trim();

  if (text.startsWith("/")) {
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    await handleCommand(c.env, command);
    return c.json({ ok: true });
  }

  // 先即刻回覆 Telegram，再喺背景處理——唔會因為 AI 慢而俾 Telegram 重發造成重複紀錄
  c.executionCtx.waitUntil(
    processCapture(c.env, text).catch((err) => console.error("Telegram capture failed:", err)),
  );
  return c.json({ ok: true });
});

async function handleCommand(env: Env, command: string): Promise<void> {
  switch (command) {
    case "/list":
    case "/start": {
      const tasks = await listOpenTasks(env);
      if (tasks.length === 0) {
        await sendMessage(env, "冇未完成任務 🎉");
        return;
      }
      const list = tasks
        .map((t, i) => `${i + 1}. ${t.content}${t.due ? `（期限：${t.due}）` : ""}`)
        .join("\n");
      await sendMessage(env, `📋 未完成任務：\n${list}`, taskButtons(tasks));
      return;
    }
    case "/done": {
      const { results } = await env.DB.prepare(
        "SELECT * FROM tasks WHERE status = 'done' ORDER BY completed_at DESC LIMIT 20",
      ).all<TaskRow & { completed_at: string }>();
      if (results.length === 0) {
        await sendMessage(env, "仲未有完成咗嘅任務。");
        return;
      }
      const list = results.map((t) => `✅ ${t.content}（${localDate(env, t.completed_at)} 完成）`).join("\n");
      await sendMessage(env, `🏁 最近完成嘅任務：\n${list}`);
      return;
    }
    case "/all": {
      const { results } = await env.DB.prepare(
        "SELECT * FROM tasks ORDER BY status = 'done', due IS NULL, due, created_at LIMIT 50",
      ).all<TaskRow>();
      if (results.length === 0) {
        await sendMessage(env, "資料庫入面未有任何任務。");
        return;
      }
      const list = results
        .map((t) => `${t.status === "done" ? "✅" : "⬜"} ${t.content}${t.due ? `（期限：${t.due}）` : ""}`)
        .join("\n");
      await sendMessage(env, `📚 全部任務：\n${list}`);
      return;
    }
    case "/pending": {
      const { results } = await env.DB.prepare(
        "SELECT id, raw_text, created_at FROM captures WHERE type = 'pending' ORDER BY id",
      ).all<{ id: number; raw_text: string; created_at: string }>();
      if (results.length === 0) {
        await sendMessage(env, "冇未處理嘅紀錄 👍");
        return;
      }
      const list = results
        .map((r) => `#${r.id}（${localDate(env, r.created_at)}）${r.raw_text.slice(0, 60)}`)
        .join("\n");
      await sendMessage(env, `⏳ 未處理嘅紀錄（打 /retry 重試）：\n${list}`);
      return;
    }
    case "/retry": {
      const n = await retryPending(env, 0);
      await sendMessage(env, n ? `🔁 已重新處理 ${n} 個紀錄。` : "冇嘢需要重試，或者 AI 仍然未恢復。");
      return;
    }
    default:
      await sendMessage(env, HELP_TEXT);
  }
}

export default {
  fetch: app.fetch,
  // 每小時行一次：重試 pending 紀錄；用戶時區到咗 BRIEF_HOUR 就發晨早簡報（自動處理夏令時間）
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          await retryPending(env, 3);
          await purgeStaleParts(env);
        } catch (err) {
          console.error("hourly maintenance failed:", err);
        }
        const briefHour = Number(env.BRIEF_HOUR ?? "8");
        if (localHour(env) === briefHour) await sendMorningBrief(env);
      })(),
    );
  },
};
