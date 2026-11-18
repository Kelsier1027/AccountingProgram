# 03 · 完整開發 Prompt

> 依據 01 的需求分析與 02 選定的 skill 撰寫。這份 prompt 就是第 4 步實作的規格書；之後要重建或延伸功能時，也可以直接交給 Claude Code。

---

## 角色與目標

你是全端工程師兼介面設計師。請在這個 repo 裡打造一個**個人記帳 PWA**。它沒有後端、沒有資料庫：資料是一個 JSON 檔，存在使用者的**私有 GitHub repo**，透過 GitHub REST API 讀寫。介面使用繁體中文、以新台幣為本位幣，手機和電腦瀏覽器都能使用。

實作時請遵循專案內的 skill：`.claude/skills/frontend-design`（視覺與文案）、`.claude/skills/reconciliation`（對帳分類），以及內建的 `dataviz`（圖表）。

## 技術限制

- 原生 HTML/CSS/JavaScript（ES modules），**不需要建置步驟**；不使用外部 CDN 與網路字型（離線可用、沒有供應鏈風險）。
- 純運算邏輯放在 `app/js/core/`，不得碰 DOM，讓瀏覽器與 Node（CLI、測試）共用。
- Node ≥ 20 的工具與測試只使用內建模組（`node:test`、`fetch`、`crypto.webcrypto`）。不需要 `npm install`。

## 目錄結構

```
app/                 靜態網站（部署這個資料夾）
  index.html, styles.css, manifest.webmanifest, sw.js, icon.svg
  js/core/           model / calc / match / importers / merge / crypto / util（純邏輯）
  js/                github 同步、store、charts、views、main
data/
  ledger.json        帳本（可加密）
  symbols.json       需要報價的股票代號（明文，只有代號，供 Actions 使用）
  prices.json        Actions 寫入的報價與匯率
tools/
  ledger.mjs         Claude Code／終端機用 CLI：summary、validate、import-invoices、import-card、match、encrypt/decrypt
  update-prices.mjs  抓股價與匯率（Actions 執行）
.github/workflows/
  update-prices.yml  排程 + 手動觸發
  deploy-pages.yml   部署 app/ 到 GitHub Pages
tests/               node:test 單元測試
CLAUDE.md            資料格式與 Claude Code 操作說明
```

## 資料模型（`ledger.json`，schemaVersion 1）

每筆記錄都有 `id`、`updatedAt`（ISO 時間），刪除時改成 `deleted: true`（刪除標記，用於合併）。金額單位為元，可帶小數。

- `settings`：`baseCurrency`（TWD）、`upColor`（`red`＝台股慣例）、`bankRules[]`（Moneybook 銀行明細規則 `{match, type(income|expense|skip), category?, merchant?, amount?, direction?(in|out), note?}`）
- `accounts[]`：`name, type(cash|bank|ewallet|securities|other), currency, balance, balanceDate?, moneybookKey?（「機構|帳戶名稱」）, note`
- `assets[]`：其他資產 `name, value, currency, note`
- `holdings[]`：`symbol`（Yahoo 格式：`2330.TW`、`6488.TWO`、`AAPL`）、`name, shares, avgCost, currency, manualPrice?`
- `issuers[]`：發卡銀行 `name, limit, statementDay, dueDay, overpaid?（溢繳款，從卡費扣除）, note`——台灣同一家銀行的信用卡共用信用額度、寄同一張合併帳單
- `cards[]`：`name, issuerId, bank, last4, statementLabel, autoCreated`（`statementLabel` 是帳單上印的卡別；從帳單自動建立的卡 `autoCreated: true`，名稱可自行修改）（舊版卡片上的 `bank`／`limit`／結帳日會自動轉到 `issuers`）
- `statements[]`：銀行合併帳單 `issuerId, period(YYYY-MM，結帳月份), closingDate, dueDate, total, minimum?, paidAmount, paidDate, closingEstimated?`（舊資料的 `cardId` 會自動對應到銀行）
- `transactions[]`：`date, amount(>0), type(expense|income), category, merchant, source(card|invoice|manual|bill|bank), cardId?, accountId?, bankRef?（Moneybook 銀行明細去重用）, totalFixed?（發票總額已依 Moneybook 校正）, statementId?, invoiceNo?, carrier?, items?[{name,amount}], paymentMethod?(card|cash|transfer|other), linkId?, topUp?（儲值，不算消費）, excluded?（不計入收支）, oneOff?（非日常支出，不列入日常支出估計）, split?（分帳 `{with, paid, mine, ref, group, paidBy?, settle?}`）, splitPlaceholder?, note`
- `links[]`：`cardTxId, otherTxIds[], method(auto|manual), score`——載具／帳單 ↔ 刷卡的配對
- `bills[]`：待繳項目 `name, category, amount, cycle(monthly|bimonthly|quarterly|yearly|once), dueDay（超過月底以月底計）, dueMonthOffset?（-1＝前一個月繳）, kind?（`income`＝每月固定收入，另有 `match` 關鍵字、`accountId`；`forecast`＝預計收支 `direction, date, certain`）, startMonth, payTo, payments[{period, date, amount, txId}]`
- `loans[]`：`name, kind(student|credit|mortgage|car|installment|other), term?(long|short), lender, principal, balance, rate, monthlyPayment, dueDay, startDate, endDate, payments[{date, amount, principalPart}]`
- `ious[]`：`direction(owedToMe|iOwe), person, amount, date, dueDate, note, repayments[{date,amount}], settled`
- `snapshots[]`：每天一筆 `date, assets, liabilities, netWorth`，畫趨勢圖用

`prices.json`：`{ updatedAt, quotes: { "2330.TW": { price, currency, time, source } }, fx: { USD: 32.4, ... } }`

## 計算規則

- **資產**＝帳戶餘額＋其他資產＋持股市值（現價：`manualPrice` 優先，其次是 `prices.json`，都沒有就用成本價並標示「無報價」）＋應收借款餘額。外幣依 `fx` 換算成台幣。
- **負債**＝貸款剩餘本金＋應付借款餘額＋各卡未繳金額（帳單 `total − paidAmount`，加上尚未歸入帳單的刷卡交易）。
- **淨值**＝資產 − 負債。
- **支出統計（去重）**：已配對的群組只算一次——計入刷卡那筆的金額，類別與品項沿用發票那筆；發票本身標記為已合併、不計入。

## 對帳引擎（`core/match.js`）

刷卡交易是「帳務端」；載具發票、繳費與手動記錄（付款方式為卡片或未指定）是「消費端」。

1. 候選條件：金額完全相同（或差距在 `amountTolerance` 內，預設 0），且日期差在 `dayWindow` 內（預設 ±3 天，刷卡可能延後入帳）。
2. 評分（0–1）：金額 0.5 ＋ 日期 0.3 ×（1 − 天數差／窗口）＋ 商家名稱相似度 0.2（正規化後計算 bigram Dice 係數，忽略全形／半形、空白、「股份有限公司」等字樣）。
3. 一對一指派：分數由高到低貪婪配對。分數 ≥ 0.85 且是唯一候選時，標為「自動」；其他列為「建議」，等使用者確認。
4. 拆單：仍未配對的刷卡交易，嘗試以同一天、同一商家的 2–3 張發票加總等於刷卡金額。
5. 結果分類（reconciliation skill）：已配對／建議／只有刷卡（可能沒索取發票、國外消費）／只有發票（現金付款或尚未入帳），並顯示天數。
6. 可以解除配對；手動配對可以把任意刷卡交易連到一或多筆消費端交易。

## 匯入器（`core/importers.js`）

- 財政部電子發票 CSV：以 `|` 分隔的 `M|載具名稱|載具號碼|發票日期(yyyyMMdd)|商店統編|商店店名|發票號碼|總金額|發票狀態|`、`D|發票號碼|小計|品項名稱|`；也要能處理逗號分隔、有表頭的版本。作廢發票略過。重複匯入以 `invoiceNo` 去重。
- 信用卡 CSV：通用解析（引號、逗號、BOM），使用者選擇日期、說明、金額欄位（記住每張卡的對應）。日期支援 `2026/11/03`、`2026-11-03`、`115/11/03`（民國年）、`20261103`。負數或「退款」視為退款。以 `date+amount+merchant` 指紋去重。

## 同步（`js/github.js` + `core/merge.js`）

- 設定：owner、repo、branch（預設 `main`）、路徑（預設 `data/ledger.json`）、fine-grained PAT（只授權該 repo：Contents 讀寫；更新股價需要 Actions 寫入）。權杖只存在 localStorage。
- 讀取：`GET /repos/{o}/{r}/contents/{path}?ref=` 取得 `sha`；大於 1MB 時改用 `git/blobs/{sha}`。UTF-8 安全的 base64。
- 寫入：`PUT` 時帶上 `sha`。遇到 409／422（sha 已過期）時，重新抓取 → **以記錄為單位做三方合併**（`updatedAt` 新者勝，刪除標記保留）→ 重試。
- 本機優先：每次修改都立刻存進 localStorage，並在 1.5 秒後排程同步；離線時標示「待同步」。
- 可選加密：PBKDF2（SHA-256，25 萬次）→ AES-GCM；檔案格式 `{ encrypted: true, v: 1, salt, iv, data }`。密碼只在記憶體中（可選擇記住在此裝置）。`symbols.json` 永遠是明文、只有代號。

## 股價

- `tools/update-prices.mjs`：從 `symbols.json`（帳本未加密時也會讀帳本裡的持股）取得代號，呼叫 Yahoo Finance chart API（`query1.finance.yahoo.com/v8/finance/chart/{symbol}`）抓價格與幣別，以及 `{CUR}TWD=X` 匯率；台股失敗時改用 TWSE OpenAPI（`STOCK_DAY_ALL`）作為備援。只更新抓得到的項目，保留舊值。
- `update-prices.yml`：台股收盤後與美股收盤後各跑一次（週一至週五）＋ `workflow_dispatch`；只有內容變動才 commit。
- UI 的「更新股價」按鈕呼叫 `POST /actions/workflows/update-prices.yml/dispatches`，接著輪詢 `prices.json` 直到 `updatedAt` 改變；也可以為單一持股手動輸入價格。

## 介面

頁面（hash 路由）：**總覽、收支、對帳、信用卡、股票、帳戶與資產、待繳、債務、借貸、設定**。手機用底部導覽（總覽、收支、對帳、股票、更多），桌面用側欄。

- 總覽：淨值主數字＋資產／負債；淨值趨勢折線圖（快照）；資產組成橫條；本月支出依類別長條（已去重）；待辦提醒（本期未繳的待繳項目、即將到期的卡費、待確認配對數、逾期借款）。
- 收支：月份篩選、搜尋、來源篩選；新增／編輯表單；已合併的項目顯示配對標記。
- 對帳：「自動配對全部」「確認建議」「手動配對」「解除配對」；分類計數與帳齡。
- 每種資料都有新增、編輯、刪除；表單用 `<dialog>`。
- 設定：GitHub 連線測試、加密、匯出／匯入 JSON、切換範例資料、清除本機資料。

設計（frontend-design）：主題是「存摺」——冷調紙白底、存摺藍綠為主色、朱印紅只用在需要注意的地方；數字一律等寬（tabular-nums）；系統中文字體（PingFang TC／Noto Sans TC／Microsoft JhengHei）。讓淨值那一列成為唯一的視覺重點，其他保持安靜。響應式到 360px、看得見的鍵盤焦點、尊重 `prefers-reduced-motion`、支援深色模式。

圖表（dataviz）：自製 SVG；單一 y 軸；2px 線條；長條端點 4px 圓角；類別色依參考調色盤固定順序；hover 提示；每張圖附表格檢視；深色模式使用深色色階。

## Claude Code 操作路徑

`CLAUDE.md` 要說明資料格式、規則（一定要更新 `updatedAt`、用刪除標記而非直接移除、不要提交權杖），以及 CLI 用法。例如：

```
node tools/ledger.mjs summary
node tools/ledger.mjs import-invoices ~/Downloads/einvoice.csv
node tools/ledger.mjs import-card ~/Downloads/card.csv --card <cardId> --date 0 --desc 2 --amount 3
node tools/ledger.mjs match --apply
```

## 驗收

1. `node --test tests/` 全部通過：計算、對帳（一對一、拆單、模糊名稱、日期窗口）、匯入器（M/D 格式、民國年）、合併（衝突與刪除標記）、加解密來回。
2. 在 Playwright 中以 390×844 與 1280×800 載入範例資料：各頁面都能渲染、主控台沒有錯誤；新增一筆交易後總覽數字有更新；對帳頁可以自動配對。
3. 文件：README（部署步驟、PAT 權限、私有 repo 的託管選項）、CLAUDE.md。
