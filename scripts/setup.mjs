#!/usr/bin/env node
/**
 * 一鍵安裝：讀 .env → 驗證所有 API key → 建 D1 同四個 Notion database
 * → 寫 wrangler.jsonc → 部署 Worker → set secrets → 註冊 Telegram webhook。
 *
 * 用法：npm run setup              （行得幾多次都得，唔會重複建嘢）
 *       npm run setup -- --yes     （唔使確認，直接行）
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const REQUIRED = [
  "CLOUDFLARE_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "NOTION_TOKEN",
  "NOTION_PARENT_PAGE",
  "ANTHROPIC_API_KEY",
];

const HEX32 = /^[0-9a-f]{32}$/;
let stepNo = 0;

const die = (msg) => {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
};
const step = (msg) => console.log(`\n[${++stepNo}] ${msg}`);
const ok = (msg) => console.log(`    ✅ ${msg}`);

/* ── .env ──────────────────────────────────────────────── */

function readEnv() {
  if (!existsSync(".env")) die("搵唔到 .env。請將 .env.example 抄一份做 .env 再填好啲資料。");
  const env = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) die(`.env 未填：${missing.join("、")}`);
  return env;
}

function saveToEnv(key, value) {
  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(".env", lines.join("\n"), "utf8");
}

/* ── 外部指令同 API ─────────────────────────────────────── */

function wrangler(args, env) {
  return execSync(`npx wrangler ${args}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN },
  });
}

async function notion(env, path, method = "GET", body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message ?? JSON.stringify(data)}`);
  return data;
}

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

/* ── 各步驟 ────────────────────────────────────────────── */

/** Notion page id 可以係成條 URL，抽最後嗰串 32 位英數 */
function parsePageId(raw) {
  const ids = raw.replace(/-/g, "").match(/[0-9a-f]{32}/gi);
  if (!ids?.length) die(`NOTION_PARENT_PAGE 格式唔啱：${raw}\n貼成條 Notion page URL 或者 32 位 id 都得。`);
  return ids[ids.length - 1].toLowerCase();
}

async function verifyAll(env, parentPageId) {
  step("驗證各項設定⋯");

  wrangler("whoami", env);
  ok("Cloudflare API token");

  const bot = await telegram(env, "getMe");
  ok(`Telegram bot：@${bot.username}`);

  const chat = await telegram(env, "getChat", { chat_id: env.TELEGRAM_CHAT_ID }).catch(() => null);
  if (!chat) {
    die(
      `Telegram 搵唔到你個 chat（id ${env.TELEGRAM_CHAT_ID}）。\n` +
        `請去 https://t.me/${bot.username} 撳「Start」同個 bot 講聲，再行多次。`,
    );
  }
  ok(`Telegram 收件人：${chat.first_name ?? chat.title ?? chat.id}`);

  const page = await notion(env, `/pages/${parentPageId}`).catch((err) => {
    die(
      `Notion 開唔到你指定嘅 page：${err.message}\n` +
        `請喺嗰個 page 右上角 ⋯ → Connections → 連接你個 integration，再行多次。`,
    );
  });
  const titleProp = Object.values(page.properties ?? {}).find((p) => p.type === "title");
  ok(`Notion page：${titleProp?.title?.[0]?.plain_text ?? "（無標題）"}`);

  // count_tokens 唔收費，用嚟驗 key 最抵
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
  });
  if (!res.ok) die(`Anthropic API key 用唔到（${res.status}）：${(await res.text()).slice(0, 200)}`);
  ok("Anthropic API key");
}

function ensureDatabase(env, name) {
  step(`準備 D1 資料庫「${name}」⋯`);
  let id = null;
  try {
    const list = JSON.parse(wrangler("d1 list --json", env));
    id = list.find((d) => d.name === name)?.uuid ?? null;
  } catch {
    /* 舊版 wrangler 冇 --json，當冇搵到照建 */
  }
  if (id) {
    ok(`已存在，沿用（${id}）`);
    return id;
  }
  const out = wrangler(`d1 create ${name}`, env);
  id = /"database_id"\s*:\s*"([^"]+)"/.exec(out)?.[1] ?? /\b([0-9a-f-]{36})\b/.exec(out)?.[1];
  if (!id) die(`建立 D1 失敗，wrangler 輸出：\n${out}`);
  ok(`已建立（${id}）`);
  return id;
}

const TAG_PROPS = { Name: { title: {} }, Tags: { multi_select: {} } };
const NOTION_DBS = [
  ["NOTION_DB_TASKS", "Tasks 任務", "✅", { Name: { title: {} }, Done: { checkbox: {} }, Due: { date: {} } }],
  ["NOTION_DB_MEETINGS", "Meetings 會議記錄", "🗣️", TAG_PROPS],
  ["NOTION_DB_IDEAS", "Ideas 想法", "💡", TAG_PROPS],
  ["NOTION_DB_JOURNAL", "Journal 日記雜記", "📓", TAG_PROPS],
];

/** 已經有效嘅就沿用，冇先建，唔會整多幾個出嚟 */
async function ensureNotionDatabases(env, parentPageId, existing) {
  step("準備四個 Notion database⋯");
  const ids = {};
  for (const [key, title, emoji, properties] of NOTION_DBS) {
    const current = existing[key];
    if (HEX32.test(current ?? "")) {
      const alive = await notion(env, `/databases/${current}`).catch(() => null);
      if (alive && !alive.archived) {
        ids[key] = current;
        ok(`${title}：已存在，沿用`);
        continue;
      }
    }
    const db = await notion(env, "/databases", "POST", {
      parent: { type: "page_id", page_id: parentPageId },
      icon: { type: "emoji", emoji },
      title: [{ type: "text", text: { content: title } }],
      properties,
    });
    ids[key] = db.id.replace(/-/g, "");
    ok(`${title}：已建立`);
  }
  return ids;
}

function writeWranglerConfig({ workerName, d1Name, d1Id, timezone, briefHour, notionIds }) {
  step("寫入 wrangler.jsonc⋯");
  writeFileSync(
    "wrangler.jsonc",
    `{
  // 呢個檔由 \`npm run setup\` 自動產生，改咗 .env 之後再行一次就會更新
  "name": "${workerName}",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],

  // 每小時行一次：重試未處理紀錄 + 到咗 BRIEF_HOUR（用戶時區）就發晨早簡報
  "triggers": {
    "crons": ["0 * * * *"]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "${d1Name}",
      "database_id": "${d1Id}"
    }
  ],

  "vars": {
    "TIMEZONE": "${timezone}",
    "BRIEF_HOUR": "${briefHour}",
    "NOTION_DB_TASKS": "${notionIds.NOTION_DB_TASKS}",
    "NOTION_DB_MEETINGS": "${notionIds.NOTION_DB_MEETINGS}",
    "NOTION_DB_IDEAS": "${notionIds.NOTION_DB_IDEAS}",
    "NOTION_DB_JOURNAL": "${notionIds.NOTION_DB_JOURNAL}"
  },

  "observability": {
    "enabled": true
  }
}
`,
    "utf8",
  );
  ok("已寫入");
}

function readExistingVars() {
  if (!existsSync("wrangler.jsonc")) return {};
  const text = readFileSync("wrangler.jsonc", "utf8");
  const vars = {};
  for (const [, key, value] of text.matchAll(/"(NOTION_DB_[A-Z]+)"\s*:\s*"([^"]*)"/g)) vars[key] = value;
  return vars;
}

function setSecrets(env, captureToken) {
  step("寫入 secrets⋯");
  const secrets = {
    CAPTURE_TOKEN: captureToken,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,
    NOTION_TOKEN: env.NOTION_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  };
  const tmp = ".secrets.tmp.json";
  writeFileSync(tmp, JSON.stringify(secrets), "utf8");
  try {
    wrangler(`secret bulk ${tmp}`, env);
    ok(`已寫入 ${Object.keys(secrets).length} 個`);
  } finally {
    unlinkSync(tmp);
  }
}

/* ── 主流程 ────────────────────────────────────────────── */

const env = readEnv();
const parentPageId = parsePageId(env.NOTION_PARENT_PAGE);
const workerName = env.WORKER_NAME || "personal-assistant";
const d1Name = env.D1_NAME || "assistant-db";
const timezone = env.TIMEZONE || "Asia/Hong_Kong";
const briefHour = env.BRIEF_HOUR || "8";

console.log(`
━━━ 個人助理：一鍵安裝 ━━━
  Worker 名稱  ${workerName}
  D1 資料庫    ${d1Name}
  時區／簡報   ${timezone} ${briefHour}:00
`);

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("確認開始？(y/N) ");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) die("已取消。");
}

await verifyAll(env, parentPageId);

const d1Id = ensureDatabase(env, d1Name);
const notionIds = await ensureNotionDatabases(env, parentPageId, readExistingVars());
writeWranglerConfig({ workerName, d1Name, d1Id, timezone, briefHour, notionIds });

step("建立資料表⋯");
wrangler(`d1 execute ${d1Name} --remote --file=./schema.sql -y`, env);
ok("已建立");

step("部署 Worker⋯");
const deployOut = wrangler("deploy", env);
const url = /(https:\/\/[^\s]*workers\.dev)/.exec(deployOut)?.[1];
if (!url) {
  console.log(deployOut);
  die("部署完成但搵唔到網址。如果上面寫住要先登記 workers.dev subdomain，請去 Cloudflare dashboard 開好再行多次。");
}
ok(url);

const captureToken = env.CAPTURE_TOKEN || randomBytes(32).toString("hex");
// 喺 GitHub Actions 度行嘅話，即刻叫佢遮住條 token，唔好留喺 workflow 記錄
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${captureToken}`);
if (!env.CAPTURE_TOKEN) saveToEnv("CAPTURE_TOKEN", captureToken);
setSecrets(env, captureToken);

step("註冊 Telegram webhook⋯");
await telegram(env, "setWebhook", { url: `${url}/telegram`, secret_token: captureToken });
await telegram(env, "setMyCommands", {
  commands: [
    { command: "list", description: "睇未完成任務（可撳掣完成）" },
    { command: "done", description: "最近完成咗嘅任務" },
    { command: "all", description: "全部任務連狀態" },
    { command: "pending", description: "未處理到嘅紀錄" },
    { command: "retry", description: "即刻重試未處理嘅紀錄" },
    { command: "help", description: "說明" },
  ],
});
ok("已註冊");

const bot = await telegram(env, "getMe");
// 捷徑要用嘅網址同 token 經 Telegram 私訊送返畀本人——喺 GitHub Actions 度行嘅話，
// 呢個就係攞 token 嘅唯一途徑（workflow 記錄會遮住佢）
const freshTokenInActions = process.env.GITHUB_ACTIONS && !env.CAPTURE_TOKEN;
await telegram(env, "sendMessage", {
  chat_id: env.TELEGRAM_CHAT_ID,
  text: `🎉 安裝完成！你個人助理已經上線。

iPhone 捷徑要用嘅兩樣嘢：

1️⃣ 網址
${url}/capture?format=text&content=

2️⃣ 標頭 Authorization
Bearer ${captureToken}

設定步驟見 shortcut-setup.md。打 /help 睇下有咩用法。

⚠️ 第 2 樣嘢等於你個助理嘅鎖匙，唔好畀人、唔好連捷徑一齊 share。${
    freshTokenInActions
      ? `

📌 重要：而家去 GitHub → Settings → Secrets and variables → Actions，
加一個叫 CAPTURE_TOKEN 嘅 secret，值就係上面第 2 樣嘢（唔要 "Bearer " 呢個字）。
唔加嘅話，下次再行安裝會產生新 token，你條捷徑就會失效。`
      : ""
  }`,
});

console.log(`
━━━ 安裝完成 ━━━

Telegram bot   @${bot.username}
Worker 網址    ${url}

📲 iPhone 捷徑要用嘅網址同 token，已經私訊咗去你個 Telegram。
${process.env.GITHUB_ACTIONS ? "（呢度唔會顯示，去 Telegram 睇）" : `   Authorization  Bearer ${captureToken}`}
`);
