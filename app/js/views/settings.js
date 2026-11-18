import { store } from '../store.js';
import { normalizeLedger } from '../core/model.js';
import { sampleLedger, samplePrices } from '../core/sample.js';
import { GitHubStore } from '../github.js';
import { esc, toast, confirmDialog, readFileText, $ } from '../ui.js';

export function renderSettings(root) {
  const c = store.config;
  root.innerHTML = `
  <section class="block">
    <h2>GitHub 同步</h2>
    <p class="intro">帳本會存成私有 repo 裡的 <code>${esc(c.path)}</code>。權杖只存在這台裝置的瀏覽器裡，不會上傳。換手機或電腦時，在那台裝置填入同樣的設定即可看到同一份資料。</p>
    <form id="gh" class="fields">
      <div class="field"><label for="g-owner">擁有者（帳號）</label><input id="g-owner" name="owner" value="${esc(c.owner || '')}" autocomplete="off" autocapitalize="off" required></div>
      <div class="field"><label for="g-repo">Repo 名稱</label><input id="g-repo" name="repo" value="${esc(c.repo || '')}" autocomplete="off" autocapitalize="off" required></div>
      <div class="field"><label for="g-branch">分支</label><input id="g-branch" name="branch" value="${esc(c.branch || 'main')}" autocapitalize="off"></div>
      <div class="field"><label for="g-path">帳本路徑</label><input id="g-path" name="path" value="${esc(c.path || 'data/ledger.json')}" autocapitalize="off"></div>
      <div class="field wide"><label for="g-token">Fine-grained personal access token</label>
        <input id="g-token" name="token" type="password" value="${esc(c.token || '')}" autocomplete="off" placeholder="github_pat_…">
        <small class="hint">到 GitHub → Settings → Developer settings → Fine-grained tokens 建立。Repository access 只選這個 repo；權限給 Contents「Read and write」，要用「更新股價」按鈕再加 Actions「Read and write」。</small></div>
      <div class="actions wide"><button type="button" class="btn ghost" id="g-test">測試連線</button><span class="spacer"></span>
        <button type="submit" class="btn primary">儲存並同步</button></div>
    </form>
    <p class="muted small">${store.lastSync ? `上次同步：${new Date(store.lastSync).toLocaleString('zh-TW')}` : '尚未同步'}${store.error ? `｜<span class="crit">${esc(store.error)}</span>` : ''}</p>
  </section>

  <section class="block">
    <h2>加密</h2>
    <p class="intro">開啟後，上傳到 GitHub 的帳本會先用你的密碼以 AES-256 加密，就算 repo 外流也看不到內容。密碼遺失就無法復原，請另外保存。股票代號清單（symbols.json）仍是明文，讓 Actions 能抓股價。</p>
    <div class="fields">
      <div class="field"><label class="check"><input type="checkbox" id="e-on" ${c.encrypt ? 'checked' : ''}> 加密帳本</label></div>
      <div class="field"><label for="e-pass">密碼</label><input id="e-pass" type="password" autocomplete="new-password" placeholder="${store.passphrase ? '（已輸入）' : ''}"></div>
      <div class="field"><label class="check"><input type="checkbox" id="e-remember" ${localStorage.getItem('acct.pass') ? 'checked' : ''}> 在這台裝置記住密碼</label></div>
      <div class="actions wide"><span class="spacer"></span><button class="btn primary" id="e-save">套用</button></div>
    </div>
  </section>

  <section class="block">
    <h2>顯示</h2>
    <div class="fields">
      <div class="field"><label for="d-up">股價漲跌顏色</label><select id="d-up">
        <option value="red" ${store.ledger.settings.upColor !== 'green' ? 'selected' : ''}>台股慣例：漲紅跌綠</option>
        <option value="green" ${store.ledger.settings.upColor === 'green' ? 'selected' : ''}>歐美慣例：漲綠跌紅</option></select></div>
      <div class="field"><label for="d-theme">外觀</label><select id="d-theme">
        ${[['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']].map(([v, l]) => `<option value="${v}" ${(localStorage.getItem('acct.theme') || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
  </section>

  <section class="block">
    <h2>資料</h2>
    <div class="toolbar">
      <button class="btn ghost" id="x-export">匯出 JSON 備份</button>
      <label class="btn ghost file-btn">匯入 JSON<input type="file" id="x-import" accept=".json,application/json" hidden></label>
      <button class="btn ghost" id="x-sample">載入範例資料</button>
      <button class="btn danger" id="x-clear">清除這台裝置的資料</button>
    </div>
    <p class="muted small">清除只會刪掉這個瀏覽器裡的副本與設定，GitHub 上的資料不受影響。</p>
  </section>`;

  const form = $('#gh', root);
  const vals = () => Object.fromEntries(new FormData(form).entries());
  $('#g-test', root).onclick = async () => {
    try {
      const info = await new GitHubStore(vals()).testConnection();
      toast(`連線成功：${info.fullName}${info.private ? '（私有）' : '（⚠ 公開 repo，請改用私有 repo 或開啟加密）'}${info.canPush ? '' : '，但沒有寫入權限'}`, info.private && info.canPush ? 'info' : 'error');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    store.saveConfig(vals());
    try {
      await store.sync();
      toast('已同步');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  $('#e-save', root).onclick = async () => {
    const on = $('#e-on', root).checked;
    const pass = $('#e-pass', root).value;
    const remember = $('#e-remember', root).checked;
    if (on && !pass && !store.passphrase) {
      toast('請輸入密碼', 'error');
      return;
    }
    if (!on && store.config.encrypt && !(await confirmDialog('關閉加密後，GitHub 上的帳本會改存成明文（repo 仍是私有）。確定關閉？', '關閉加密', true))) return;
    if (on) store.setPassphrase(pass || store.passphrase, remember);
    store.setEncryption(on);
    store.commit(() => {}, { silent: true }); // rewrite the remote file in the new format
    toast(on ? '已開啟加密，同步後 GitHub 上會改存成密文' : '已關閉加密，同步後 GitHub 上會改存成明文，其他裝置下次同步會自動跟上');
    renderSettings(root);
  };

  $('#d-up', root).onchange = (e) => store.commit((l) => { l.settings.upColor = e.target.value; });
  $('#d-theme', root).onchange = (e) => {
    localStorage.setItem('acct.theme', e.target.value);
    if (e.target.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = e.target.value;
  };

  $('#x-export', root).onclick = () => {
    const blob = new Blob([JSON.stringify(store.ledger, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#x-import', root).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await readFileText(f));
      if (!(await confirmDialog('用這個檔案取代目前的帳本？', '取代', true))) return;
      store.replaceLedger(normalizeLedger(obj));
      toast('已匯入');
    } catch {
      toast('檔案不是有效的 JSON 帳本', 'error');
    }
  };
  $('#x-sample', root).onclick = async () => {
    if (store.remoteEnabled) {
      toast('已連接 GitHub 時無法載入範例，以免覆蓋真實資料。請先清除這台裝置的資料。', 'error');
      return;
    }
    if (!(await confirmDialog('用範例資料取代這台裝置上的帳本？', '載入範例'))) return;
    store.replaceLedger(sampleLedger(), { markDirty: false });
    store.setPrices(samplePrices());
    toast('已載入範例資料');
    location.hash = '#/overview';
  };
  $('#x-clear', root).onclick = async () => {
    if (!(await confirmDialog('清除這台裝置上的帳本、權杖與設定？', '清除', true))) return;
    store.clearLocal();
    toast('已清除');
  };
}
