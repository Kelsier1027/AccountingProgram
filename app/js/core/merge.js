// Record-level merge for edits made on several devices. Each record carries updatedAt;
// deletions are tombstones ({ id, deleted: true, updatedAt }) so they win over older edits.
import { COLLECTIONS, normalizeLedger } from './model.js';

const t = (r) => Date.parse(r?.updatedAt || 0) || 0;

export function mergeLedgers(localIn, remoteIn) {
  const local = normalizeLedger(structuredClone(localIn));
  const remote = normalizeLedger(structuredClone(remoteIn));
  const newerRoot = t(local) >= t(remote) ? local : remote;
  const out = { ...newerRoot, settings: { ...remote.settings, ...local.settings, ...newerRoot.settings } };
  let conflicts = 0;
  for (const c of COLLECTIONS) {
    const map = new Map();
    for (const r of remote[c]) map.set(r.id, r);
    for (const r of local[c]) {
      const other = map.get(r.id);
      if (!other) map.set(r.id, r);
      else if (t(r) >= t(other)) {
        if (JSON.stringify(r) !== JSON.stringify(other)) conflicts++;
        map.set(r.id, r);
      }
    }
    out[c] = [...map.values()];
  }
  out.updatedAt = new Date(Math.max(t(local), t(remote))).toISOString();
  return { ledger: out, conflicts };
}

/** Drop tombstones older than `days` to keep the file small. */
export function compact(ledger, days = 180) {
  const cutoff = Date.now() - days * 86400000;
  for (const c of COLLECTIONS) ledger[c] = ledger[c].filter((r) => !(r.deleted && t(r) < cutoff));
  return ledger;
}
