# 02 · Skill / Plugin 評估與安裝紀錄

> 記錄日期：2026-11-16

## 搜尋方式

- 使用者自己的 claude.ai skills（關鍵字：accounting、budget、finance、expense tracker、github pages、pwa、frontend design）→ **無結果**
- Anthropic Plugin Directory（關鍵字：accounting、finance、expense tracker、frontend、web app、github）
- 本 session 內建 skills

## 候選與決定

| 候選 | 來源／發行者 | 能力 | 與需求的關係 | 決定 |
|------|-------------|------|-------------|------|
| **frontend-design**（plugin，只含 1 個 skill） | Anthropic 官方，`anthropics/claude-plugins-official`，Apache-2.0，reach = contained | UI 視覺方向、字體、版面、文案指引 | R2/R3 的介面品質 | ✅ 安裝為專案 skill |
| **Finance** plugin 中的 `reconciliation` skill | Anthropic 官方，`anthropics/knowledge-work-plugins`，Apache-2.0 | 對帳方法論：差異分類、時間差、帳齡 | R4h 載具 ↔ 信用卡對帳 | ✅ 只安裝這一個 skill |
| Finance plugin 其餘部分（journal-entry、SOX 等 skill；BigQuery / Snowflake / Gmail / Slack 等 MCP 連接器） | 同上 | 企業會計結帳 | 個人記帳用不到；MCP 連接器會擴大存取範圍 | ❌ 不安裝 |
| **dataviz**（內建 skill） | Claude Code 內建 | 圖表選型、已驗證色盲友善的配色、標記規格 | 總覽頁圖表 | ✅ 直接使用（不需安裝） |
| github（MCP plugin） | GitHub 官方 | GitHub API | session 已內建 GitHub 工具 | ❌ 重複 |
| TRES Finance、NetSuite Finance Analyst | 第三方 | 區塊鏈會計、NetSuite | 不相關，且需要連外部服務 | ❌ |
| Finance Tutor、Finance & Ops Skills Index | 社群 | 教學、QuickBooks/Xero 索引 | 不相關；後者 reach = privileged | ❌ |

## 安全檢查

兩個 skill 安裝前都已下載原始檔並逐行閱讀：

1. **檔案組成**：都只有 `SKILL.md`（純 Markdown 指引）與授權檔。沒有腳本、hook、MCP 伺服器或二進位檔。
2. **內容掃描**：搜尋 `curl|http|bash|rm |eval|token|secret|ignore previous`。唯一的 URL 在 Apache 授權文字裡；沒有指令要求執行命令、連外、讀取憑證，也沒有提示詞注入。
3. **權限範圍**：skill 只在被呼叫時把文字載入上下文，不會擴大任何工具權限。
4. **來源**：兩者都來自 Anthropic 官方 GitHub repo 的 `main` 分支（經目錄審查，publisher tier = anthropic）。
5. **授權**：Apache-2.0，已將 `LICENSE.txt` 與 skill 一起保存。

## 安裝位置

```
.claude/skills/frontend-design/SKILL.md   (+ LICENSE.txt)
.claude/skills/reconciliation/SKILL.md    (+ LICENSE.txt)
```

這是專案層級安裝：之後任何人在這個 repo 用 Claude Code（例如用 CLI 匯入帳單、對帳）都會自動載入這兩個 skill。若要安裝到 claude.ai 帳號層級，可在 Plugin Directory 安裝 **frontend-design**（只含 skill，風險最低）。

## 如何套用到本專案

- **frontend-design**：先訂出設計 token（色彩／字體／版面／原則），對照「常見 AI 產生的預設樣式」清單檢查再實作；文案用使用者語言、按鈕寫清楚會發生什麼事；空狀態要引導下一步。
- **reconciliation**：把對帳結果分成「已配對」「時間差（刷卡入帳延遲，屬正常）」「需調查（只有一邊有）」；顯示未配對項目的帳齡。
- **dataviz**：圖表類型依資料用途選；類別色依固定順序使用參考調色盤；一律單一 y 軸；hover 提示；深色模式另外選色；提供表格檢視。

## Graphify（2026-11-18 加入）

目的：把程式碼建成知識圖譜，讓 Claude 先查圖譜再讀需要的行數，減少每次重讀原始檔的 token。

安全檢查（PyPI `graphifyy` 0.9.112，MIT，Repository：github.com/Graphify-Labs/graphify）：

- 基本相依只有 networkx、numpy、rapidfuzz、pyyaml、tree-sitter 系列；呼叫 LLM 的 openai／anthropic 等都是可選安裝。
- 沒有遙測：唯一的「analytics」是建圖後印出的 Graphify Cloud 推廣連結（只印文字，不送資料，可用 `GRAPHIFY_NO_CTA=1` 關閉）。
- 網路存取只在使用者明確要求時：`graphify add <url>`（有 SSRF 防護）與可選的 LLM 後端（需要各自的 API key）。
- 程式碼用本機 AST 解析，不花 token、不送出原始碼；文件／圖片的語意抽取才會用到模型，本專案以 `--code-only` 建圖。
- `install --project` 會寫入 `.claude/skills/graphify/`、`.claude/CLAUDE.md` 與 `.claude/settings.json` 的 PreToolUse／SessionStart hooks（每次 Read／Grep／Bash 前執行 `graphify hook-guard`，約 0.2 秒，逾時 10 秒）。hooks 已改成找不到 `graphify` 時直接略過，避免沒安裝的環境每次都報錯。

設定：

- `.graphifyignore` 排除 `data/`（帳本、薪資單、身分證字號、銀行明細不進圖譜）。
- `graphify-out/` 不進版控，由雲端環境 `AccountingProgram` 的 setup script 在每次開工時 `pip install graphifyy` 並 `graphify extract . --code-only` 重建（約 2 秒）。
