# 程式 repo 與資料 repo 分離

目標：程式 repo（公開）不含任何個人資料；帳本、發票、薪資單等放在私有資料 repo。**不要把現有 repo 直接轉公開**——git 歷史含全部資料，刪檔無法抹除。

## 一次性遷移（方案 A）

1. 在 GitHub 把**現有 repo 改名**為資料 repo（例：`ledger-data`，保持 Private）。GitHub 會自動轉址；網頁設定頁的 repo 名稱要改成新名字。
2. 新建**乾淨的公開 repo**，名稱沿用 `AccountingProgram`；把本 PR 的內容（`app/ tools/ tests/ docs/ package.json wrangler.jsonc CLAUDE.md README.md .github/workflows/test.yml .claude/`）以**全新歷史**推上去（不要帶 `data/`、不要 fork／push 舊歷史）。
   ```bash
   git clone --no-local <舊 repo> new && cd new && rm -rf .git data graphify-out
   git init -b main && git add -A && git commit -m "init"   # 提交前先 git status 確認沒有 data/
   ```
3. 資料 repo 瘦身：刪掉 `app/ tools/ tests/ docs/ wrangler.jsonc package.json` 與舊 `.github/workflows/test.yml`，只留 `data/`；從公開 repo 的 `docs/data-repo-template/` 複製 `.github/workflows/*`、`CLAUDE.md`、`NOTES.md`、`.gitignore` 到資料 repo 根目錄，再把自己的付款習慣、卡號、分帳對象等寫進 `NOTES.md`（只放資料 repo，不要回寫到公開 repo）。
4. Cloudflare Workers 改連到新的公開 repo（`wrangler.jsonc` 只上傳 `app/`，Worker 名稱不變，網址不變）。
5. 發權杖：Fine-grained PAT 只授權**資料 repo**（Contents 讀寫；Actions 讀寫給「更新股價」）。到網頁設定頁換成新 repo 名稱。
6. 公開前檢查：新 repo 全文搜尋姓名、卡號末四碼、房東、薪資金額等；GitHub Secret scanning 開啟。
7. 舊歷史不外流的前提是資料 repo 一直是 Private；若曾 fork 或公開過，要視為已外洩。

## 日常使用（Claude session 或本機）

```bash
# 在資料 repo 內
git clone https://github.com/<帳號>/AccountingProgram code   # 已 gitignore
LEDGER_DIR=data node code/tools/ledger.mjs summary
```

`ledger.mjs`、`update-prices.mjs` 都只吃資料夾路徑，所以程式與資料可各自版本控管。程式有改動 → 到公開 repo 開 PR；資料的 commit 只在資料 repo。

## 不再自動做的事

- 公開 repo 的 `test.yml` 不再驗證 `ledger.json`；改由資料 repo 的 `validate.yml` 檢查。
- 股價排程在資料 repo 執行（Actions 分鐘數算在私有 repo 額度）。

## 遷移時常踩的坑

- **Cloudflare 連線會失效**：舊 repo 改名後再新建同名 repo，在 GitHub 看來是不同的 repo（內部 ID 不同），Cloudflare 的 GitHub 應用程式授權仍只對得到舊的。症狀：Worker 的 Settings → Builds 顯示「已與您的 Git 帳戶中斷連線」，建置一直失敗、線上停在舊版。處理：GitHub → Settings → Applications → Installed GitHub Apps → Cloudflare Workers and Pages → Configure，把新 repo 加進 Repository access，再到 Cloudflare 重新連線 Git 存放庫（分支 `main`、組建命令留空、部署命令 `npx wrangler deploy`）。
- **重新連線不會自動建置**：要有新的 commit 合併進 `main`，或在 Cloudflare 手動觸發，才會產生新的建置。
- **建置失敗時線上仍是舊版**：Workers 會繼續提供上一個成功的部署，所以網站看起來正常。部署後用 `curl` 比對 `app/js/` 的檔案內容確認是否為新版。
- **Secret Protection**：GitHub 新版把 Secret scanning 改名為 Secret Protection（Settings → Advanced Security）；公開 repo 預設已啟用，另外確認 Push protection 為 On。
