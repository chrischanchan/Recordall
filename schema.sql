-- 每一次按掣紀錄（原始文字 + AI 分類結果）
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- task | meeting | idea | journal
  title TEXT,
  raw_text TEXT NOT NULL,
  notion_page_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 任務（可能來自任務類 capture，亦可能係會議入面抽出嘅行動項目）
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  due TEXT,                        -- YYYY-MM-DD，可以係 NULL
  status TEXT NOT NULL DEFAULT 'open',  -- open | done
  capture_id INTEGER,
  notion_page_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- 捷徑分段上傳嘅暫存（收齊就會刪走）
CREATE TABLE IF NOT EXISTS capture_parts (
  session TEXT NOT NULL,
  part INTEGER NOT NULL,
  total INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session, part)
);
