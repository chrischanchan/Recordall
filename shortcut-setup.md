# iPhone 捷徑設定（動作按鈕一掣紀錄）

需要 iOS 18 或以上（「轉錄音訊」動作係 iOS 18 新增，本機轉文字、支援粵語）。

**開始之前**，你要有自己嗰套安裝完成後嘅兩樣嘢（安裝腳本會私訊咗去你個 Telegram）：
- **你的Worker網址** — 類似 `https://personal-assistant.xxxxx.workers.dev`
- **你的 CAPTURE_TOKEN** — 一串 64 位英數字

下面凡見到 `<你的Worker網址>` 同 `<你的 CAPTURE_TOKEN>`，就換成你自己嗰個。

兩個版本揀一個：
- **簡單版**（5 個動作）— 短錄音夠用，上限約 1,800 個中文字（十分鐘左右嘅講話）
- **進階版**（8 個動作）— 自動分段上傳，**冇長度限制**，錄一個鐘會議都得

---

## 簡單版

打開「捷徑」app → 新增捷徑，依次加入：

1. **錄音**（Record Audio）
   - 「開始錄音」設定為「立即」
   - 「完成錄音」設定為「輕點時」← 關鍵：講幾秒定講一個鐘都得，講完撳一下就停

2. **轉錄音訊**（Transcribe Audio）
   - 輸入：上一步嘅「錄音」
   - 語言：中文（廣東話－香港）
   - ※ 搵唔到呢個動作 = iOS 版本未夠 18，改用「聽寫文字」動作代替（停止聆聽設「輕點時」）

3. **URL 編碼**（URL Encode）
   - 輸入：上一步嘅「轉寫的文字」變數

4. **取得 URL 內容**（Get Contents of URL）
   - 方法：**GET**
   - 標頭（Headers）：`Authorization` = `Bearer <你的 CAPTURE_TOKEN>`
   - URL：`<你的Worker網址>/capture?format=text&content=` 後面直接插入「**URL 編碼的文字**」變數（喺鍵盤上面嗰行變數列撳入去）
   - ※ `format=text` 令伺服器回一段現成嘅中文摘要，下一步直接彈通知就得

5. **顯示通知**（Show Notification）
   - 內容：「URL 內容」變數

### 點解用 GET 唔用 POST

本來設計係 POST + JSON body（伺服器兩樣都支援），但部分 iPhone 嘅捷徑 app 發 POST 會出「網絡連線中斷」——懷疑係 iOS 喺 HTTP/3 上唔會重試 POST，而 workers.dev 強制開 HTTP/3。GET 一定通。

---

## 進階版：分段上傳（無長度限制）

同簡單版一樣由 1、2 步（錄音、轉錄音訊）開始，跟住：

3. **配對文字**（Match Text）
   - 文字：「轉寫的文字」變數
   - 規則（正規表達式）：`[\s\S]{1,1500}`
   - ※ 輸出係一個「配對項目」（Matches）清單，每項最多 1,500 字

4. **計數**（Count）
   - 計「項目」數量，輸入：「配對項目」→ 得出「計數」

5. **格式化日期**（Format Date）
   - 日期欄位：**目前日期**（Current Date）
   - Date Format 揀 **自訂（Custom）**，Format String 打 `yyyyMMddHHmmss`
   - → 得出「格式化的日期」，做呢次上傳嘅編號

6. **重複每個項目**（Repeat with Each）— 輸入：「**配對項目**」（Matches，唔係日期！）
   - 6a. **URL 編碼**：輸入「重複項目」
   - 6b. **取得 URL 內容**：方法 GET，Headers 加 `Authorization` = `Bearer <你的 CAPTURE_TOKEN>`，URL：
     `<你的Worker網址>/capture?format=text&session=`【格式化的日期】`&part=`【重複索引】`&total=`【計數】`&content=`【URL 編碼的文字】
     （【】入面係變數，逐個喺鍵盤上面嘅變數列插入）
   - 結束重複

7. **從列表取得項目**（Get Item from List）
   - 輸入：「重複結果」（Repeat Results）；取得：**最後一個項目**（Last Item）
   - ※ 前面幾段只回「已收到第 N/M 段」，最後一段先係完整結果

8. **顯示通知**（Show Notification）
   - 內容：上一步嘅「項目」變數

短錄音只會切出一段、送一次，效果同簡單版一樣；長會議自動分幾段送，最後一段到齊伺服器先開始 AI 處理。

---

## 通知會顯示啲乜

伺服器回嘅摘要係現成嘅，例如新任務：

```
📌 已記錄為任務：《銀行入錢及交報稅表》

▫️ 去銀行入錢（2026-09-02）
▫️ 交報稅表（2026-09-04）
```

會議記錄仲會多埋一句 AI 摘要；語音完成／修改任務就會顯示剔咗邊個、改咗啲乜。

## 綁定動作按鈕

設定 → 動作按鈕 → 揀「捷徑」→ 揀你頭先建立嘅捷徑。

## 日常用法

- 撳側邊動作按鈕 → 即刻講嘢（「聽日要交電費同埋買牛奶」／成場會議照講）→ 講完輕點螢幕停止 → 幾秒後通知同 Telegram 都會話你知 AI 分咗去邊類
- 講「〇〇搞掂咗／做完喇」→ 自動剔走對應任務（Notion 都會打剔）；AI 對唔實邊個任務嘅話，Telegram 會彈掣畀你揀
- 講「頭先個會議記錄補充返⋯」「啱啱個想法仲有⋯」→ 自動追加落原本嗰個 Notion page
- 喺 Telegram 直接打字畀個 bot 都一樣會行 AI 分流
- Telegram 指令：`/list` 未完成任務（撳「✅」完成）、`/done` 最近完成咗嘅、`/all` 全部任務連狀態、`/pending` 未處理嘅紀錄、`/retry` 即刻重試、`/help` 說明
- 每朝 8 點（你所在時區，喺 `.env` 嘅 `TIMEZONE`／`BRIEF_HOUR` 設定）自動收到 AI 整理嘅晨早簡報
