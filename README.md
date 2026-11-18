# 記帳本 AccountingProgram

個人記帳 PWA。**不需要伺服器或資料庫**：帳本是一個 JSON 檔，存在你的**私有 GitHub repo** 裡，網頁透過 GitHub API 直接讀寫。手機、平板、任何電腦的瀏覽器都能使用，也可以加到手機主畫面，離線時一樣能看。

| 功能 | 說明 |
|------|------|
| 資產 | 銀行、現金、電子支付（支援外幣）、其他資產 |
| 股票 | 台股上市／上櫃、美股；依最新股價計算市值與未實現損益（GitHub Actions 每個交易日自動抓價，也可以手動輸入價格） |
| 信用卡 | 卡片、每期帳單（應繳、已繳、截止日）、刷卡明細 CSV 匯入，計算未繳卡費 |
| 載具 | 匯入財政部電子發票平台的 CSV，保留品項明細 |
| **對帳合併** | 自動把「刷卡明細」與「載具發票」對成同一筆（看金額、日期差、商家名稱相似度，也能處理一次刷卡對多張發票），支出只算一次 |
| 待繳 | 房租、電費等週期帳單（每月／每兩月／每季／每年），提醒本期未繳與逾期 |
| 債務 | 學貸、信貸、房貸：剩餘本金、利率、還款紀錄（利息自動記成支出） |
| 借貸 | 別人欠我、我欠別人，可部分還款 |
| 總覽 | 淨值、資產組成、本月支出（已去重）、淨值趨勢、待辦提醒 |
| 安全 | 權杖只存在你的瀏覽器；可選擇用密碼 AES-256 加密後再上傳 |

需求分析、skill 評估與完整規格放在 [`docs/`](docs/)。

---

## 安裝步驟

### 1. 資料 repo（另開一個私有 repo）

這個 repo 只有程式，**不含任何資料**，可以公開。帳本另存在你自己的**私有資料 repo**：`data/ledger.json`，股價 `data/prices.json`。資料 repo 的範本（workflow、CLAUDE.md、.gitignore）在 `docs/data-repo-template/`，建立與遷移步驟見 `docs/split-repos.md`。**資料 repo 一定要保持 Private。**

### 2. 建立 GitHub 權杖（Fine-grained personal access token）

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

- Repository access：**Only select repositories** → 只選**資料 repo**
- Permissions → Repository permissions：
  - **Contents：Read and write**（必要，用來讀寫帳本）
  - **Actions：Read and write**（選用，讓 app 的「更新股價」按鈕可以立即觸發抓價）
- 到期日建議設 1 年，到期後重新產生並貼到 app 的設定頁即可

### 3. 部署網頁（擇一）

網頁本身（`app/` 資料夾）不含任何資料或密鑰，部署在公開網址也安全；資料只能用你的權杖讀取。

**A. Cloudflare Workers（免費、可連私有 repo，推薦，目前使用中）**
1. Cloudflare Dashboard → Workers & Pages → Create → 匯入 Git repository，選這個（程式）repo
2. repo 裡的 `wrangler.jsonc` 已設定好：Worker 名稱 `accountingprogram`、只上傳 `app/`；部署指令用預設的 `npx wrangler deploy`
3. Worker → Settings → Build → **Build watch paths** 填 `app/*` 與 `wrangler.jsonc`，記帳與股價的 commit 就不會觸發部署
4. 部署後會得到 `https://accountingprogram.<你的子網域>.workers.dev` 網址

（也可以改用 Cloudflare Pages：Build command 留空、Build output directory 填 `app`。）

**B. GitHub Pages（私有 repo 需要 GitHub Pro 等付費方案）**
1. Repo → Settings → Pages → Source 選 **GitHub Actions**
2. 部署用的 workflow 已移除（目前改用 Cloudflare Pages）。要改用 GitHub Pages 時，新增一個用 `actions/upload-pages-artifact` 上傳 `app/` 的 workflow 即可

**C. 另開一個公開 repo 只放網頁**
把 `app/` 的內容複製到另一個公開 repo（例如 `你的帳號.github.io`），開啟 Pages。資料仍留在這個私有 repo。

### 4. 第一次開啟

1. 打開部署好的網址 → **設定** → 填入擁有者（你的 GitHub 帳號）、**資料 repo** 名稱、分支 `main`、權杖 → **測試連線** → **儲存並同步**
2. 手機用 Safari／Chrome 開同一個網址，填同樣的設定 → 「加入主畫面」
3. 想先試用的話，在未連接 GitHub 的狀態下按「載入範例資料」

### 5. 股價自動更新

資料 repo 裡的 `.github/workflows/update-prices.yml`（範本在 `docs/data-repo-template/`）會在台股收盤後（台北 14:40）與美股收盤後執行，從 Yahoo Finance 抓股價與匯率（台股失敗時改用證交所／櫃買中心 OpenAPI），寫入 `data/prices.json`。

- 代號格式：上市 `2330.TW`、上櫃 `6488.TWO`、美股 `AAPL`（在 app 輸入 `2330` 會自動補上 `.TW`）
- 第一次可以到 repo 的 Actions 頁面手動執行 **update-prices** 確認正常
- 抓不到報價的持股會顯示「無報價」並以成本計算，可在持股裡輸入手動股價

---

## 日常使用

1. **月初**：到「信用卡」新增上期帳單；到「待繳」按「繳費」
2. **匯入**：「收支」→ 匯入載具 CSV（財政部電子發票平台 → 載具消費明細 → 匯出）、匯入刷卡明細（網銀下載的 CSV，第一次指定欄位後會記住）
3. **對帳**：「對帳」→ 合併高信心配對 → 逐筆確認建議 → 只有刷卡或只有發票的項目視情況手動合併或標為現金
4. **總覽**：看淨值、本月支出與待辦

## 同步怎麼運作

- 每次修改會先存在瀏覽器（離線也能用），1.5 秒後上傳到 GitHub。
- 兩台裝置同時修改時，以「每筆記錄的最後修改時間」合併，不會整份覆蓋。刪除會留下刪除標記，確保另一台裝置也會刪掉。
- 每次同步會記錄當天的淨值快照，用來畫趨勢圖。
- Git 歷史就是完整的版本紀錄，改錯可以從 GitHub 還原任何一個版本。

## 用 Claude Code 操作

在這個 repo 用 Claude Code 時，`CLAUDE.md` 會說明資料格式，也可以用 CLI：

```bash
node tools/ledger.mjs summary
```

```bash
node tools/ledger.mjs import-invoices ~/Downloads/einvoice.csv
```

```bash
node tools/ledger.mjs import-card ~/Downloads/card.csv --card "玉山 Pi 卡" --date 0 --desc 2 --amount 3
```

```bash
node tools/ledger.mjs match --apply
```

加密的帳本要先設定 `LEDGER_PASSPHRASE` 環境變數。修改完 commit 並 push，app 下次開啟就會看到。

## 開發

```bash
npm test
```

```bash
npm run serve
```

CLI 處理資料 repo 的帳本：`LEDGER_DIR=<資料 repo>/data node tools/ledger.mjs summary`（預設 `data`）。

`npm run serve` 會在 http://localhost:8080 啟動本機伺服器。沒有建置步驟，也沒有任何 npm 相依套件。

```
app/            靜態網站（部署這個資料夾）
  js/core/      純邏輯：計算、對帳、匯入、合併、加密（瀏覽器與 Node 共用）
  js/views/     各頁面
docs/data-repo-template/  私有資料 repo 的範本（workflow、CLAUDE.md）
tools/          CLI 與抓股價腳本
tests/          node:test 單元測試
docs/           需求分析、skill 評估、完整規格
.claude/skills/ 專案用 Claude Code skill（frontend-design、reconciliation）
```

## 安全注意事項

- **資料 repo** 必須是 **Private**（程式 repo 可公開，但絕不可 commit 個人資料）；設定頁的「測試連線」會在 repo 是公開的時候提醒你。
- 權杖只授權單一 repo、最小權限；不要把權杖寫進任何檔案或 commit。
- 在公用電腦上使用後，到設定頁「清除這台裝置的資料」。
- 想更進一步保護，開啟「加密」：GitHub 上只會存密文（`symbols.json` 仍是明文，只有股票代號）。
