export interface Env {
  DB: D1Database;
  TIMEZONE: string; // IANA 時區，例如 America/Los_Angeles、Asia/Hong_Kong
  BRIEF_HOUR?: string; // 晨早簡報幾點發（用戶時區，0-23），預設 8
  CAPTURE_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  NOTION_TOKEN: string;
  NOTION_DB_TASKS: string;
  NOTION_DB_MEETINGS: string;
  NOTION_DB_IDEAS: string;
  NOTION_DB_JOURNAL: string;
  ANTHROPIC_API_KEY: string;
}

export type CaptureType = "task" | "meeting" | "idea" | "journal";

export interface ExtractedTask {
  content: string;
  due: string | null; // YYYY-MM-DD
}

export interface Classification {
  type: CaptureType;
  title: string;
  tags: string[];
  tasks: ExtractedTask[]; // task 類：任務本身（可以多過一個）；meeting 類：抽出嘅行動項目
  meeting: {
    summary: string;
    decisions: string[];
  } | null;
}

export type Intent = "create" | "complete" | "append" | "update";

export interface TaskUpdate {
  task_id: number;
  content: string | null; // null = 唔改內容
  due: string | null; // null = 唔改期限
}

export interface Interpretation extends Classification {
  intent: Intent;
  /** intent=complete：好肯定嘅任務 id */
  complete_task_ids: number[];
  /** intent=complete：唔肯定、要用戶撳掣揀嘅候選任務 id */
  complete_candidates: number[];
  /** intent=append：要補充嘅 capture id */
  append_capture_id: number | null;
  /** intent=append：整理好嘅補充內容 */
  append_text: string;
  /** intent=update：要修改嘅任務 */
  updates: TaskUpdate[];
}

export interface RecentCapture {
  id: number;
  type: string;
  title: string | null;
  notion_page_id: string | null;
  created_at: string;
}

export interface TaskRow {
  id: number;
  content: string;
  due: string | null;
  status: string;
  notion_page_id: string | null;
  created_at: string;
}

export const TYPE_LABEL: Record<CaptureType, string> = {
  task: "任務",
  meeting: "會議記錄",
  idea: "想法",
  journal: "日記雜記",
};
