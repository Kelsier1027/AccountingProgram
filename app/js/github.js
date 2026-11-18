// Minimal GitHub REST client for reading/writing one JSON file in a (private) repo.
import { utf8ToB64, b64ToUtf8 } from './core/crypto.js';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HINTS = {
  401: '權杖無效或已過期，請到「設定」重新貼上。',
  403: '權杖沒有這個操作的權限（Contents 需要「讀寫」，更新股價需要 Actions「讀寫」）。',
  404: '找不到 repo 或檔案。請確認擁有者、repo 名稱、分支，以及權杖是否授權了這個 repo。',
};

export class GitHubStore {
  constructor({ owner, repo, branch = 'main', path = 'data/ledger.json', token }) {
    Object.assign(this, { owner, repo, branch, path, token });
  }

  get configured() {
    return !!(this.owner && this.repo && this.token);
  }

  async request(method, url, body) {
    const res = await fetch(`https://api.github.com${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GitHubError(res.status, HINTS[res.status] || data.message || `GitHub 回應 ${res.status}`);
    return data;
  }

  repoUrl(p = '') {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${p}`;
  }

  async testConnection() {
    const info = await this.request('GET', this.repoUrl());
    return { private: info.private, fullName: info.full_name, canPush: !!info.permissions?.push, defaultBranch: info.default_branch };
  }

  /** Returns { sha, text } or null when the file does not exist yet. */
  async getFile(path = this.path) {
    try {
      const enc = path.split('/').map(encodeURIComponent).join('/');
      const data = await this.request('GET', this.repoUrl(`/contents/${enc}?ref=${encodeURIComponent(this.branch)}`));
      if (data.content && data.encoding === 'base64') return { sha: data.sha, text: b64ToUtf8(data.content.replace(/\n/g, '')) };
      // > 1 MB: content is omitted, fetch the blob instead
      const blob = await this.request('GET', this.repoUrl(`/git/blobs/${data.sha}`));
      return { sha: data.sha, text: b64ToUtf8(blob.content.replace(/\n/g, '')) };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async putFile(text, sha, message, path = this.path) {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const body = { message, content: utf8ToB64(text), branch: this.branch };
    if (sha) body.sha = sha;
    const data = await this.request('PUT', this.repoUrl(`/contents/${enc}`), body);
    return data.content.sha;
  }

  async dispatchWorkflow(file = 'update-prices.yml') {
    await this.request('POST', this.repoUrl(`/actions/workflows/${file}/dispatches`), { ref: this.branch });
  }
}

export const isConflict = (e) => e instanceof GitHubError && (e.status === 409 || e.status === 422);
