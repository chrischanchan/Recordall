import type { Classification, Env } from "./types";

const NOTION_API = "https://api.notion.com/v1";

async function notionFetch(env: Env, path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Notion 每個 rich_text 上限 2000 字元、每次請求上限 100 個 block
function textToBlocks(text: string, maxBlocks = 90): any[] {
  const blocks: any[] = [];
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  for (const p of paragraphs) {
    for (let i = 0; i < p.length; i += 1900) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: p.slice(i, i + 1900) } }] },
      });
      if (blocks.length >= maxBlocks) return blocks;
    }
  }
  return blocks;
}

function heading(text: string): any {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function bullets(items: string[]): any[] {
  return items.map((item) => ({
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [{ type: "text", text: { content: item.slice(0, 1900) } }] },
  }));
}

/** 喺 Tasks database 建一個任務 page，回傳 page id */
export async function createTaskPage(env: Env, content: string, due: string | null): Promise<string> {
  const properties: any = {
    Name: { title: [{ text: { content: content.slice(0, 200) } }] },
    Done: { checkbox: false },
  };
  if (due) properties.Due = { date: { start: due } };
  const page = await notionFetch(env, "/pages", "POST", {
    parent: { database_id: env.NOTION_DB_TASKS },
    properties,
  });
  return page.id;
}

/** 修改 Notion 任務 page 嘅內容／期限 */
export async function updateTaskPage(
  env: Env,
  pageId: string,
  content: string | null,
  due: string | null,
): Promise<void> {
  const properties: any = {};
  if (content) properties.Name = { title: [{ text: { content: content.slice(0, 200) } }] };
  if (due) properties.Due = { date: { start: due } };
  if (!Object.keys(properties).length) return;
  await notionFetch(env, `/pages/${pageId}`, "PATCH", { properties });
}

/** 將 Notion 任務 page 剔做完成 */
export async function markTaskPageDone(env: Env, pageId: string): Promise<void> {
  await notionFetch(env, `/pages/${pageId}`, "PATCH", {
    properties: { Done: { checkbox: true } },
  });
}

/** 喺現有 page 尾部追加補充內容 */
export async function appendToPage(env: Env, pageId: string, text: string, newTasks: string[]): Promise<void> {
  const dateStr = new Intl.DateTimeFormat("zh-HK", {
    timeZone: env.TIMEZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
  const children: any[] = [heading(`補充（${dateStr}）`), ...textToBlocks(text, 40)];
  if (newTasks.length) children.push(...bullets(newTasks.map((t) => `➕ 新任務：${t}`)));
  await notionFetch(env, `/blocks/${pageId}/children`, "PATCH", { children });
}

/** 會議／想法／日記 page，回傳 page id */
export async function createContentPage(env: Env, c: Classification, rawText: string): Promise<string> {
  let databaseId: string;
  const children: any[] = [];

  if (c.type === "meeting") {
    databaseId = env.NOTION_DB_MEETINGS;
    if (c.meeting?.summary) {
      children.push(heading("摘要"), ...textToBlocks(c.meeting.summary, 10));
    }
    if (c.meeting?.decisions?.length) {
      children.push(heading("決定事項"), ...bullets(c.meeting.decisions));
    }
    if (c.tasks.length) {
      children.push(heading("行動項目"), ...bullets(c.tasks.map((t) => t.content + (t.due ? `（${t.due}）` : ""))));
    }
    children.push(heading("完整轉錄"), ...textToBlocks(rawText, 60));
  } else if (c.type === "idea") {
    databaseId = env.NOTION_DB_IDEAS;
    children.push(...textToBlocks(rawText));
  } else {
    databaseId = env.NOTION_DB_JOURNAL;
    children.push(...textToBlocks(rawText));
  }

  const properties: any = {
    Name: { title: [{ text: { content: c.title.slice(0, 200) } }] },
  };
  // Notion multi_select 選項名唔可以有英文逗號
  const tags = c.tags.map((t) => t.replace(/,/g, " ").trim().slice(0, 50)).filter(Boolean).slice(0, 3);
  if (tags.length) {
    properties.Tags = { multi_select: tags.map((name) => ({ name })) };
  }

  const page = await notionFetch(env, "/pages", "POST", {
    parent: { database_id: databaseId },
    properties,
    children: children.slice(0, 100),
  });
  return page.id;
}
