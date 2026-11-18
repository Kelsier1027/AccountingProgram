// App state: local-first ledger in localStorage, synced to GitHub when configured.
import { emptyLedger, normalizeLedger, upsert, live, symbolsOf } from './core/model.js';
import { mergeLedgers, compact } from './core/merge.js';
import { encryptJson, decryptJson, isEncrypted } from './core/crypto.js';
import { snapshotOf } from './core/calc.js';
import { ymd } from './core/util.js';
import { GitHubStore, isConflict } from './github.js';

const K = {
  ledger: 'acct.ledger', prices: 'acct.prices', config: 'acct.config', sha: 'acct.sha',
  dirty: 'acct.dirty', pass: 'acct.pass', encPending: 'acct.encPending', symbols: 'acct.symbols', lastSync: 'acct.lastSync',
};
const read = (k, d = null) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

class Store extends EventTarget {
  constructor() {
    super();
    this.ledger = normalizeLedger(read(K.ledger) || emptyLedger());
    this.prices = read(K.prices) || { quotes: {}, fx: {} };
    this.config = { branch: 'main', path: 'data/ledger.json', encrypt: false, ...(read(K.config) || {}) };
    this.sha = read(K.sha);
    this.dirty = !!read(K.dirty);
    this.lastSync = read(K.lastSync);
    this.passphrase = read(K.pass) || null;
    // true while this device's encryption on/off choice has not been pushed yet;
    // until then the remote file's format must not overwrite the choice
    this.encryptPending = !!read(K.encPending);
    this.status = this.dirty ? 'pending' : 'idle';
    this.error = null;
    this.askPassphrase = async () => null; // set by UI
    this.timer = null;
  }

  get gh() {
    return new GitHubStore(this.config);
  }
  get remoteEnabled() {
    return this.gh.configured;
  }

  emit(type = 'change') {
    this.dispatchEvent(new Event(type));
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('status');
  }

  persistLocal() {
    write(K.ledger, this.ledger);
    write(K.dirty, this.dirty);
  }

  /** Apply a change. `fn` mutates the ledger; the result is saved locally and synced soon. */
  commit(fn, { silent = false } = {}) {
    const result = fn(this.ledger);
    this.dirty = true;
    this.persistLocal();
    if (!silent) this.emit('change');
    this.scheduleSync();
    return result;
  }

  scheduleSync(delay = 1500) {
    clearTimeout(this.timer);
    if (!this.remoteEnabled) {
      this.setStatus('local');
      return;
    }
    this.setStatus('pending');
    this.timer = setTimeout(() => this.sync().catch(() => {}), delay);
  }

  saveConfig(cfg) {
    this.config = { ...this.config, ...cfg };
    write(K.config, this.config);
    this.sha = null;
    write(K.sha, null);
    this.emit('status');
  }

  setPassphrase(p, remember) {
    this.passphrase = p || null;
    if (remember && p) write(K.pass, p);
    else localStorage.removeItem(K.pass);
  }

  replaceLedger(l, { markDirty = true } = {}) {
    this.ledger = normalizeLedger(l);
    this.dirty = markDirty;
    this.persistLocal();
    this.emit('change');
    if (markDirty) this.scheduleSync(300);
  }

  setPrices(p) {
    this.prices = p || { quotes: {}, fx: {} };
    write(K.prices, this.prices);
    this.emit('change');
  }

  /** Turn encryption on or off for the ledger file; takes effect on the next push. */
  setEncryption(on) {
    this.config.encrypt = !!on;
    write(K.config, this.config);
    this.encryptPending = true;
    write(K.encPending, true);
    // when turning off, keep the password until the plaintext file is pushed:
    // the sync still has to decrypt the current remote file once
  }

  /** Follow the format of the remote file, unless a local on/off choice is still unpushed. */
  followRemoteEncryption(remoteEncrypted) {
    if (this.encryptPending || this.config.encrypt === remoteEncrypted) return;
    this.config.encrypt = remoteEncrypted;
    write(K.config, this.config);
    if (!remoteEncrypted) this.setPassphrase(null, false);
  }

  async decode(text) {
    let obj = JSON.parse(text);
    this.followRemoteEncryption(isEncrypted(obj));
    if (isEncrypted(obj)) {
      let tries = 0;
      for (;;) {
        if (!this.passphrase) this.passphrase = await this.askPassphrase(tries > 0);
        if (!this.passphrase) throw new Error('帳本已加密，需要密碼才能讀取');
        try {
          obj = await decryptJson(obj, this.passphrase);
          break;
        } catch (e) {
          this.passphrase = null;
          localStorage.removeItem(K.pass);
          if (++tries >= 3) throw e;
        }
      }
    }
    return normalizeLedger(obj);
  }

  async encode(ledger) {
    if (this.config.encrypt) {
      if (!this.passphrase) this.passphrase = await this.askPassphrase(false);
      if (!this.passphrase) throw new Error('已啟用加密，但沒有輸入密碼');
      return JSON.stringify(await encryptJson(ledger, this.passphrase));
    }
    return JSON.stringify(ledger, null, 1);
  }

  /** Pull remote, merge with local edits, push the result. */
  async sync() {
    if (!this.remoteEnabled) {
      this.setStatus('local');
      return;
    }
    if (!navigator.onLine) {
      this.setStatus('offline');
      return;
    }
    this.setStatus('syncing');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.gh.getFile();
        let merged = this.ledger;
        if (remote) {
          const remoteLedger = await this.decode(remote.text);
          merged = this.dirty ? mergeLedgers(this.ledger, remoteLedger).ledger : remoteLedger;
          this.sha = remote.sha;
        }
        if (!this.dirty && remote) {
          this.ledger = merged;
          break;
        }
        this.takeSnapshot(merged);
        compact(merged);
        try {
          const text = await this.encode(merged);
          this.sha = await this.gh.putFile(text, remote?.sha, `ledger: update ${new Date().toISOString()}`);
          this.ledger = merged;
          this.dirty = false;
          this.encryptPending = false;
          write(K.encPending, false);
          if (!this.config.encrypt) this.setPassphrase(null, false);
          break;
        } catch (e) {
          if (isConflict(e) && attempt < 2) continue; // someone else pushed; merge again
          throw e;
        }
      }
      write(K.sha, this.sha);
      this.persistLocal();
      await this.pushSymbols();
      await this.pullPrices();
      this.lastSync = new Date().toISOString();
      write(K.lastSync, this.lastSync);
      this.setStatus('synced');
      this.emit('change');
    } catch (e) {
      this.setStatus('error', e.message);
      throw e;
    }
  }

  takeSnapshot(ledger) {
    const snap = snapshotOf(ledger, this.prices, ymd());
    const existing = live(ledger.snapshots).find((s) => s.date === snap.date);
    upsert(ledger, 'snapshots', existing ? { ...snap, id: existing.id } : snap);
  }

  async pushSymbols() {
    const symbols = symbolsOf(this.ledger);
    const key = JSON.stringify(symbols);
    if (read(K.symbols) === key) return;
    const path = dirOf(this.config.path) + 'symbols.json';
    const cur = await this.gh.getFile(path);
    if (cur && cur.text.trim() === JSON.stringify({ symbols }, null, 1).trim()) {
      write(K.symbols, key);
      return;
    }
    await this.gh.putFile(JSON.stringify({ symbols }, null, 1), cur?.sha, 'symbols: update watch list', path);
    write(K.symbols, key);
  }

  async pullPrices() {
    const f = await this.gh.getFile(dirOf(this.config.path) + 'prices.json');
    if (f) this.setPrices(JSON.parse(f.text));
  }

  /** Trigger the GitHub Action and wait (up to ~3 min) for prices.json to change. */
  async refreshPrices(onProgress = () => {}) {
    const before = this.prices?.updatedAt;
    await this.gh.dispatchWorkflow('update-prices.yml');
    onProgress('已觸發 GitHub Actions，等待報價…');
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      await this.pullPrices();
      if (this.prices?.updatedAt !== before) return true;
      onProgress(`等待報價中（${(i + 1) * 10} 秒）`);
    }
    return false;
  }

  clearLocal() {
    Object.values(K).forEach((k) => localStorage.removeItem(k));
    this.ledger = emptyLedger();
    this.prices = { quotes: {}, fx: {} };
    this.sha = null;
    this.dirty = false;
    this.passphrase = null;
    this.config = { branch: 'main', path: 'data/ledger.json', encrypt: false };
    this.emit('change');
    this.setStatus('local');
  }
}

export const store = new Store();
