# 帳務規則與資料細節

`CLAUDE.md` 只放每次都會用到的規則；各功能的計算方式與資料欄位細節放在這裡，需要時再讀（或用 `graphify section "<標題>"` 取出單一段落）。完整欄位見 `docs/03-prompt.md`，計算見 `app/js/core/calc.js`。

## 資料模型與計算規則

`accounts, assets, holdings, issuers, cards, statements, transactions, links, bills, loans, ious, snapshots`，完整欄位見 `docs/03-prompt.md` 的「資料模型」，計算規則見 `app/js/core/calc.js`。

- 交易 `source`：`card`（刷卡）、`invoice`（載具）、`manual`、`bill`（繳待繳項目產生的支出）、`bank`（銀行帳戶明細，Moneybook 匯入，`bankRef` 去重）。
- **Moneybook 匯入**（`app/js/core/moneybook.js`）：自己帳戶間同額一出一入、繳卡費、電子支付儲值、外幣與證券交割不計收支；Moneybook 的發票金額是含稅總額，會修正財政部明細加總（`totalFixed`，之後重新匯入財政部 CSV 不會改回）；財政部資料期間內 Moneybook 有、帳本沒有的發票視為已作廢。帳戶 `balanceDate` 晚於匯出日的餘額不會被覆蓋。信用卡帳戶為正數代表溢繳，記在 `issuers[].overpaid`。
- 去重：已配對的群組只計算刷卡那筆（`effectiveTransactions`）。外送平台（foodpanda／Uber Eats）的平台費發票（幾元）會以 `kind: 'fee'` 建議合併到同平台、一天內的刷卡（刷卡金額含餐點，餐廳發票另開）。
- 卡費負債（以銀行計）= 該銀行未繳的合併帳單 + 該銀行所有卡在最後一次結帳日之後的未出帳刷卡。
- **帳單以銀行為單位**（台灣是合併帳單）：`statements[]` 用 `issuerId`，結帳日／繳款日（`statementDay`、`dueDay`）設在 `issuers`。舊資料以 `cardId` 記的帳單會依卡片自動對應到銀行（`statementIssuerId`）。刷卡明細用 `statementId` 歸入合併帳單。刷卡交易可以只有 `issuerId`、沒有 `cardId`（匯入時沒對到卡號），一樣計入該銀行的帳單與額度（`txIssuerId`）。
- 信用額度以**銀行**為單位共用：`issuers[]`（`name, limit, statementDay, dueDay, note`）存每家銀行的共用額度，卡片以 `issuerId` 指向銀行（另存 `bank` 名稱供舊版相容）。新增卡片時用 `ensureIssuer()` 依銀行名稱找到或建立銀行（`issuerKey` 會正規化別名：「玉山」=「玉山銀行」、「台北富邦」=「富邦」、「中信」=「中國信託」）。卡片可以不必事先建立：匯入帳單時依末四碼對應，找不到就自動建立（`statementLabel` 記帳單上的卡別，`autoCreated: true`），使用者再自行取名；之後一律以末四碼對應。已用額度 = 該銀行所有卡的未繳合計 ＋ 該銀行分期帳務尚未出帳的金額（銀行會先從額度扣住，`issuerUsage().installmentHeld`）。
- 繳卡費不是支出（支出在刷卡時已計入）。
- **儲值**：刷卡儲值到店家 App 或電子錢包（摩斯等）標 `topUp: true`，計入卡費但不算消費、也不和發票配對；實際消費以使用時的發票計（`notSpending()`）。
- **非日常支出**：`oneOff: true`（搬家等一次性花費）仍算支出，但投資規劃的日常支出平均不採計（標在刷卡或合併的發票任一邊都算）。2026/11 搬新家的 TAOBAO、小北／文采、全聯（10/31、11/14）、康達盛通（11/1、11/14）已標記。
- **不計入收支**：`excluded: true`（別人付的，例如家人副卡付的 YouTube Premium）保留記錄但不算收入或支出、不配對。
- **每月固定收入**：`bills[]` 中 `kind: "income"` 的項目（薪資）：`amount` 為平常金額、`dueDay` 入帳日、`match` 為銀行明細關鍵字。`incomeStatus()` 依 `billId` 或關鍵字找當月入帳，算出與上月的差額；手動「記錄入帳」後再匯入同一筆銀行明細不會重複（同方向、同金額、3 天內視為同一筆）。
- **分帳**（`app/js/core/split.js`）：交易的 `split = { with, paid（我付的）, mine（我的份）, ref, group }`；收支、類別、投資規劃日常支出只算 `mine`（`countedAmount()`、`effectiveTransactions`），卡費與帳戶照全額。往來餘額 `splitBalances()` ＝ Σ(paid − mine) − 對方還款 + 我還款，正數計入應收、負數計入應付。對方代付記 `source: 'split'`、`paidBy: 'other'`；帳本找不到的付款記 `splitPlaceholder: true`（分帳暫記），之後匯入同金額、2 天內的刷卡或發票會自動接手（`absorbSplitPlaceholders`）；還款記 `split.settle: true`，不算收支。發票合併進刷卡時分帳會移到刷卡那筆。分帳對象的帳期 CSV 逐筆匯入（`import-splits`）。
- 刷卡明細顯示「銀行 ****末四碼」（`cardLabel()`）。
- **投資規劃**（`app/js/core/plan.js`，網頁「投資規劃」頁）：可動用存款＝bank／cash／ewallet 帳戶（不含證券戶）。逐日推算：未繳帳單於繳款日、未出帳刷卡於下一個繳款日、分期後續期數、待繳項目、固定收入（已逾期未入帳的不計）、應付借款；日常支出取近 90 天平均（只取有刷卡資料之後的期間，避免只有發票的月份讓刷卡比例失真；排除待繳項目涵蓋的類別、分期購買、超過門檻的一次性支出），刷卡部分延後 35 天扣。可投入＝最低餘額 − 安全存量（`settings.plan.reserveMonths` 個月的固定＋日常支出）；每月可定期投入＝固定收入 − 固定支出 − 日常支出。設定存在 `settings.plan`。
- **資金缺口預警**（`app/js/core/forecast.js`，網頁「現金流規劃」頁上半部；下半部是可投入金額）：用投資規劃的逐日推算（`simulate()`）推 12 個月。保守情境只算薪資與 `certain` 的預計收支；預期情境再加上預估獎金等。預計收支存在 `bills[]`、`kind: "forecast"`（`direction: in|out, amount, date, certain`），不算待繳。缺口＝餘額低於 0：`need` 給最早不足日、最深缺口與日期、何時補回；`remedies` 試算賣股（台股手續費 0.1425%、ETF 證交稅 0.1%／股票 0.3%、T+2；美股 T+1 加匯回約 5 個工作天）、借貸利息（信貸 4%、預借現金 15%＋3.5%、循環 15%，`settings.forecast` 可改）、可收回欠款、每月需少花多少。2027 年的三筆獎金已依 2025 年發放月數預估。總覽在保守情境有缺口時提醒。
- **短期／長期負債**：`loanTerm()` 依 `loans[].term`（`long`／`short`），未設定時學貸、信貸、房貸、車貸為長期，其餘（含信用卡分期）為短期。`totals()` 的 `netWorth` 只扣短期負債（卡費＋應付＋短期貸款），`netWorthAll` 再扣長期負債。
- **待繳項目的繳費日**：`billDueDate()`；`dueDay` 超過當月天數以月底計（31＝每月最後一天），`dueMonthOffset: -1` 表示在前一個月繳（12 月房租 11/30 前繳）。本期已繳且下一期的繳費日落在本月時，`billStatus()` 會改顯示下一期。
- **分期付款**：刷卡明細中的「分期０１－１０」標為 `installment: { no, of }`（「分期全退」為 `{ cancelled: true }`），計入卡費但**不算消費**、也不和發票配對；消費以購買當天的發票全額計入。尚未出帳的期數是負債：`loans[]` 中 `kind: "installment"` 的分期帳務（`principal, periods, shop, issuerId`），剩餘 = 總額 − 已出現在卡上的分期款（`loanBalance`），分期款以 `installment.loanId` 對應（`linkInstallments`）。
- 檔案可能是 Big5 編碼（台灣銀行常見），CLI 會自動判斷。

## 薪資文件

使用者會上傳薪資明細表、獎金單、調薪通知、扣繳憑單（PDF 或截圖，多半是掃描圖，要先轉成圖片再判讀）。流程：

1. 原始檔存到 `data/payslips/`，依內容改名：`YYYY-MM.pdf`（薪資所屬月份）、`bonus-…`、`raise-…`、`tax-…`；重複的檔案（md5 相同）略過。
2. 逐項轉錄到 `data/payslips/payslips.json`：`slips[]`（應發、應扣、實發、勞退、特休／請假、備註）、`bonuses[]`、`salaryChanges[]`、`taxDocuments[]`。每份都要驗算應發 − 應扣 = 實發。
3. `node tools/ledger.mjs import-payslips` 匯入：薪資記在次月 5 日（`薪資` 固定收入項目），獎金另記一筆收入；年度扣繳憑單只存資料、不產生交易。

## 使用者的付款習慣

每個人的消費與付款習慣不同，個人化的對帳備忘（商家別名、常用卡、代付對象等）放在資料 repo 的 `NOTES.md`，不要寫進這個公開 repo。通用的品牌別名對照在 `app/js/core/util.js` 的 `BRANDS`。
