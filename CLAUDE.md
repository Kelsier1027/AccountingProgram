# CLAUDE.md

**一律使用繁體中文（台灣用語）回覆使用者。** 程式碼、指令、檔名與識別字維持原文。

個人記帳 PWA（**公開程式 repo，不含任何資料**）：資料放在另一個私有「資料 repo」的 `data/ledger.json`，網頁（`app/`）透過 GitHub API 讀寫該檔案。CLI 以環境變數 `LEDGER_DIR`（預設 `data`）指向資料資料夾。使用者會請你匯入帳單、對帳、修正記錄、回答財務問題或加功能。

**絕不把帳本、發票、薪資單、卡號、姓名等個人資料 commit 進這個 repo**（測試資料一律用虛構內容）。

## 省 token 的做法

- **不要整份讀 `ledger.json`**（近 1 MB）：用 CLI 查（`summary`、`list`、`forecast`），或寫小段 `node -e` 只取需要的欄位。
- **找程式碼先查知識圖譜**：`graphify query "<問題>"`、`graphify explain "<函式>"`、`graphify path "<A>" "<B>"`，只讀圖譜指到的行數。改完程式執行 `graphify update .`（只跑 AST，不花 token）。圖譜不含 `data/`。
- 功能規則細節在 `docs/04-domain-notes.md`（`graphify section "<標題>"` 可只取一段）；資料欄位在 `docs/03-prompt.md`。

## CLI（`node tools/ledger.mjs <指令>`，與網頁共用 `app/js/core/`）

| 指令 | 用途 |
|------|------|
| `summary [--month YYYY-MM]` | 淨值、資產負債、當月支出（已去重）、未繳款項 |
| `validate` | 檢查格式與配對（**修改後務必執行**） |
| `import-invoices <csv>` | 財政部載具 CSV（依發票號碼去重；原始檔放 `data/invoices/`） |
| `import-card <檔案> --bank <銀行>` | 信用卡合併帳單（CSV／網銀頁面／PDF）；欄位、卡號、帳單資訊自動判斷，未知卡號自動建卡 |
| `match [--apply] [--all]` | 刷卡 ↔ 載具配對；先不加 `--apply` 看清單，`--all` 須搭配 `--apply` |
| `bank --bank <銀行> [--limit N] [--statement-day N] [--due-day N]` | 銀行共用額度、結帳日／繳款日 |
| `add-statement --bank <銀行> --period YYYY-MM --closing YYYY-MM-DD …` | 依網銀數字建立某期合併帳單 |
| `add-installment` | 為分期款建立分期帳務 |
| `delete-invoices --from … --to … [--apply]` | 刪除期間內的載具發票 |
| `import-moneybook <資料夾或 CSV…>` | Moneybook 匯出檔（帳戶、明細、帳單、發票） |
| `bank-rule --match <文字> --type income\|expense\|skip …` | 記住銀行明細怎麼記 |
| `import-payslips` | 依 `data/payslips/payslips.json` 匯入薪資與獎金 |
| `import-splits <CSV…> [--from YYYY-MM-DD]` | 分帳 App 帳期 CSV（原始檔放 `data/splits/`） |
| `plan` / `forecast [--scenario expected]` | 可投入金額／資金缺口預警 |
| `list <collection>` | 列出記錄 |

帳本若加密（`{"encrypted": true}`）需要使用者提供 `LEDGER_PASSPHRASE`，不要猜也不要寫進檔案。

## 手動改 JSON 的規則

- 修改記錄要更新它的 `updatedAt`（ISO），否則多裝置合併時會被蓋掉；**刪除用刪除標記** `{ id, deleted: true, updatedAt }`，不要直接移除。
- id 前綴：`acc_ ast_ hld_ iss_ crd_ stm_ tx_ lnk_ bil_ lon_ iou_ snp_`。金額一律正數，收入／退款用 `type: "income"`，日期 `YYYY-MM-DD`。
- 配對：`links[]` 的 `{ cardTxId, otherTxIds[] }`，相關交易有相同 `linkId`。
- 股票代號用 Yahoo 格式（`2330.TW`、`6488.TWO`、`AAPL`）；不要改 `data/prices.json`（GitHub Actions 產生）。

## 最重要的帳務規則（細節見 `docs/04-domain-notes.md`）

- 已配對的刷卡＋發票只算刷卡那筆；繳卡費不是支出；信用卡帳單與額度**以銀行為單位**。
- 不算消費的標記：分期款 `installment`、儲值 `topUp`、別人付的 `excluded`、分帳還款 `split.settle`；搬家等一次性花費 `oneOff` 仍算支出但不列入日常支出平均。
- 分帳 `split = { with, paid, mine }`：收支只算 `mine`，差額是對方欠款（`splitBalances()`）。
- `bills[]` 有三種：待繳（無 `kind`）、每月固定收入（`kind: "income"`）、預計收支（`kind: "forecast"`）。
- 淨值只扣短期負債；學貸等長期負債另列（`netWorthAll`）。

## 薪資文件

原始檔存 `data/payslips/`（`YYYY-MM.pdf`、`bonus-…`、`raise-…`、`tax-…`，md5 重複略過）→ 逐項轉錄到 `payslips.json` 並驗算應發 − 應扣 = 實發 → `import-payslips`。多半是掃描 PDF，要先轉圖片判讀。

## 開發

- 無建置步驟、無 npm 相依；測試 `npm test`，預覽 `npm run serve`。
- `app/js/core/` 只放純邏輯（不碰 DOM）；介面文案遵循 `.claude/skills/frontend-design`，對帳遵循 `.claude/skills/reconciliation`，圖表遵循 `dataviz` skill。
- **絕不 commit 權杖或密碼。**
