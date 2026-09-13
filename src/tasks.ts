import { markTaskPageDone } from "./notion";
import type { Env, TaskRow } from "./types";

/**
 * 完成一個任務：更新 D1 + Notion 打剔。
 * 回傳任務 row；任務唔存在或者已經完成就回傳 null。
 */
export async function completeTask(env: Env, taskId: number): Promise<TaskRow | null> {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
  if (!task || task.status !== "open") return null;

  await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?")
    .bind(taskId)
    .run();

  if (task.notion_page_id) {
    try {
      await markTaskPageDone(env, task.notion_page_id);
    } catch (err) {
      console.error("Notion mark done failed:", err);
    }
  }
  return task;
}
