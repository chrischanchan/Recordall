# 個人助理：一掣語音紀錄 → AI 分流 → Notion + Telegram 晨早簡報

<p align="center">
  <a href="https://paypal.me/chrischanpiggybank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="請我飲杯咖啡" width="300">
  </a>
</p>

按 iPhone 動作按鈕錄音 → 本機轉文字 → Cloudflare Worker 用 Claude 識別**意圖**：
- **新紀錄**：分類做任務／會議記錄／想法／日記雜記，自動跌落對應嘅 Notion database
- **完成任務**：講「買牛奶搞掂咗」→ 自動剔走任務（D1 + Notion 齊剔）；對唔實嘅話 Telegram 彈掣畀你揀
- **補充舊紀錄**：講「頭先個會議記錄補充返⋯」→ 直接追加落原本嗰個 Notion page，新行動項目照樣變任務

每朝 8 點（用戶所在時區，喺 `.env` 嘅 `TIMEZONE`／`BRIEF_HOUR` 設定，夏令時間自動處理）Telegram 發 AI 整理嘅晨早簡報，可以喺 Telegram 一掣完成任務。

每段紀錄都會**先存原文入 D1 再交畀 AI**：AI 出錯或者請求中途斷線都唔會跌資料，紀錄會留做「待處理」，每小時自動重試，亦可以喺 Telegram 打 `/pending` 睇、`/retry` 即刻重試。

```
iPhone 動作按鈕 → 錄音 → 轉錄音訊（本機）→ GET /capture
                                              ↓
                        Cloudflare Worker（Hono + TypeScript）
                          ├─ Claude 分類 + 結構化（抽任務、寫會議摘要）
                          ├─ D1（主資料庫，任務狀態喺度）
                          ├─ Notion（四個 database 各一類）
                          ├─ Telegram webhook（/list、✅ 完成掣、打字直接紀錄）
                          └─ Cron 每小時：重試未處理紀錄；到咗 BRIEF_HOUR（用戶時區）→ Claude 寫晨早簡報 → Telegram
```

## 安裝（大約 15 分鐘）

### 1. 申請四個服務（一次性）

| 服務 | 步驟 | 攞到嘅嘢 |
|---|---|---|
| Cloudflare | 免費註冊 cloudflare.com → My Profile → API Tokens → Create Token（用「Edit Cloudflare Workers」模板，再加 Account / D1 / Edit 權限） | `CLOUDFLARE_API_TOKEN` |
| Telegram | 同 @BotFather 講 `/newbot`；同 @userinfobot 講嘢攞你嘅數字 id；**記得去自己個 bot 撳一次 Start** | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` |
| Notion | notion.so/my-integrations → New integration | `NOTION_TOKEN` |
| Anthropic | console.anthropic.com 充值最少 US$5（照日常用量用一年以上） | `ANTHROPIC_API_KEY` |

### 2. 喺 Notion 開一個空白 page

例如叫「個人助理」，右上角 ⋯ → Connections → 連接你頭先個 integration，然後抄低條 URL。
四個 database（Tasks／Meetings／Ideas／Journal）**唔使你自己建**，安裝腳本會喺呢個 page 下面自動起好。

### 3. 安裝（兩個方法揀一個）

安裝過程會：驗證每個 key（有問題即刻話你知點解決）→ 建 D1 資料庫同資料表 → 喺你個 Notion page 建四個 database → 產生設定檔 → 部署 Worker → 寫入 secrets → 註冊 Telegram webhook。

行得幾多次都得，唔會重複建嘢。**之後搬去第二個時區、想改簡報時間，改完設定再行多次就更新。**

#### 方法 A：喺 GitHub 撳掣（唔使裝任何嘢）👈 唔想掂終端機就用呢個

1. 撳右上角 **Fork**，複製一份呢個 repo 去你自己個 GitHub 帳戶
2. 喺你嗰份 fork：**Settings → Secrets and variables → Actions → New repository secret**，逐個加入下面六個（名要一模一樣）：
   `CLOUDFLARE_API_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`NOTION_TOKEN`、`NOTION_PARENT_PAGE`、`ANTHROPIC_API_KEY`
3. 去 **Actions** tab → 左邊揀「安裝／更新個人助理」→ 右邊撳 **Run workflow**，填好時區同簡報時間 → 撳綠色掣
4. 等一兩分鐘，**你個 Telegram 會私訊你**捷徑要用嘅網址同 token

> 🔐 你嘅 key 存喺 GitHub Secrets，GitHub 會自動喺記錄度遮住佢哋；捷徑 token 亦唔會出現喺 Actions 記錄，只會經 Telegram 私訊畀你。
> 第一次裝完，記得跟住 Telegram 嗰段指示，將 `CAPTURE_TOKEN` 都加做一個 secret，噉下次再行就唔會換新 token 整壞條捷徑。

#### 方法 B：喺自己電腦行（需要 Node.js）

```bash
npm install
```

將 `.env.example` 抄一份改名做 `.env`，填好上面攞到嘅資料同你嘅時區，然後：

```bash
npm run setup
```

### 4. iPhone 捷徑

跟 [shortcut-setup.md](shortcut-setup.md) 設定，用 Telegram 收到嗰個網址同 token，綁定動作按鈕。

## 測試

```bash
curl -X POST "https://<你的worker網址>/capture" -H "Authorization: Bearer <CAPTURE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"聽日下晝三點同陳生開會傾下季訂單，開會前要準備好報價單\"}"
```

應該會：Telegram 彈確認、Notion 對應 database 出現新 page。之後喺 Telegram 打 `/list` 睇任務。

本機開發：`npm run dev`，另開終端機 `curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"` 可以手動觸發每小時任務（只有用戶時區啱啱係 `BRIEF_HOUR` 嗰個鐘先會發簡報）。

## 已知限制

- Notion 係單向同步（Worker → Notion）：**喺 Notion app 入面手動改嘢**唔會反映返嚟 D1／Telegram。用語音或者 Telegram 完成／補充就冇呢個問題（兩邊都會更新）
- 「補充舊紀錄」只識最近 8 個紀錄；再舊嘅要直接喺 Notion 改
- iPhone 捷徑用 GET 方式送內容（部分 iPhone 嘅捷徑 app 發 POST 會出「network connection was lost」，懷疑係 iOS 對 HTTP/3 上 POST 唔重試嘅行為；workers.dev 唔畀閂 HTTP/3，綁自訂域名先可以），而 Cloudflare 對網址長度有約 16KB 上限（約 1,800 個中文字）。解決方法係 [shortcut-setup.md](shortcut-setup.md) 嘅「進階版：分段上傳」— 捷徑切段、伺服器 `?session&part&total` 收齊拼返，冇長度限制
- AI 分錯類嘅話，暫時要自己喺 Notion 搬；可以之後加「重新分類」button

## 成本

Cloudflare／Telegram／Notion 全免費。Claude API：每次紀錄 + 每朝簡報合共每月約 US$0.3–1（港紙幾蚊），視乎會議轉錄長度。
