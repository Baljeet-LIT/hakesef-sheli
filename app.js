'use strict';
/* הכסף שלי — personal money PWA. All data lives on the device (localStorage).
   No personal data in this file: May's plan arrives via a one-time setup code. */

const KEY = 'mayfin.v1';
const DAY = 86400000;

/* ---------------- data ---------------- */

const DEFAULT_SETTINGS = {
  income: 17500,                 // stable monthly net (no commissions)
  envelopes: [
    { id: 'pocket', name: 'כסף הכיס', type: 'weekly', amount: 1000, fromIncome: true },
    { id: 'wolt', name: 'וולט', type: 'monthly', amount: 0, fromIncome: false },
    { id: 'clothes', name: 'בגדים', type: 'fund', amount: 0, fromIncome: false },
  ],
  categories: [
    { id: 'food', name: 'אוכל בחוץ', env: 'pocket', budget: 1300, color: '#c2703d' },
    { id: 'super', name: 'סופר ובית', env: 'pocket', budget: 900, color: '#6f9169' },
    { id: 'fun', name: 'בילויים', env: 'pocket', budget: 1200, color: '#8a5bb0' },
    { id: 'hair', name: 'תספורת', env: 'pocket', budget: 300, color: '#4f7ca8' },
    { id: 'misc', name: 'שונות', env: 'pocket', budget: 630, color: '#8c8273' },
    { id: 'wolt', name: 'וולט', env: 'wolt', budget: 0, color: '#1fa0c9' },
    { id: 'clothes', name: 'בגדים', env: 'clothes', budget: 0, color: '#c24f6b' },
    { id: 'home', name: 'מחשבון הבית', env: 'none', budget: 0, color: '#5a4175' },
    { id: 'fromsav', name: 'מהקופה בצד', env: 'savings', budget: 0, color: '#6b5a80' },
  ],
  bills: [],                     // {id,name,amount,day}
  debts: [],                     // {id,name,total,monthly,day}
  priority: ['emergency'],       // order extra money goes: debt ids + 'emergency'
  emergencyGoal: 5000,
  savingsGoal: 40000,
  commissionShareAfterDebts: 0.3 // part of a commission that's yours once debts are gone
};

function fresh() {
  return {
    v: 1, setup: false, settings: clone(DEFAULT_SETTINGS),
    expenses: [], debtPays: [], savings: [], incomes: [], topups: [],
    checks: {}, learn: {}, lastBackup: 0, created: Date.now(),
    cash: [], lastMethod: 'card',
    cloud: null, sync: freshSync()
  };
}
function freshSync() { return { since: null, dirty: {}, tomb: [], docDirty: false, lastOk: 0, lastErr: '' };
}

let S = load();
const UI = { tab: 'today', monthOffset: 0, histCat: null, sheet: null };

function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return Object.assign(fresh(), JSON.parse(raw)); } catch (e) {}
  return fresh();
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('שגיאה בשמירה'); } }
function save() { if (S.cloud) S.sync.docDirty = true; persist(); scheduleSync(); }
function markExp(id) { if (S.cloud) S.sync.dirty[id] = true; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (+f(x) || 0), 0);

/* ---------------- time ---------------- */

function weekStart(t = Date.now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
function monthStart(t = Date.now(), off = 0) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + off, 1).getTime(); }
function ym(t = Date.now()) { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function dayStart(t = Date.now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function monthName(t) { return new Date(t).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }); }
function monthOnly(t) { return new Date(t).toLocaleDateString('he-IL', { month: 'long' }); }
function dayLabel(t) {
  const d0 = dayStart(), d = dayStart(t);
  if (d === d0) return 'היום';
  if (d === d0 - DAY) return 'אתמול';
  return new Date(t).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
}
function timeLabel(t) { return new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }

/* ---------------- money helpers ---------------- */

function money(n, cur = true) {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString('he-IL');
  return `<span class="num">${v < 0 ? '-' : ''}${s}${cur ? ' ₪' : ''}</span>`;
}
const cat = id => S.settings.categories.find(c => c.id === id) || { id, name: id, env: 'none', color: '#999' };
const env = id => S.settings.envelopes.find(e => e.id === id);
const debt = id => S.settings.debts.find(d => d.id === id);
const inRange = (t, a, b) => t >= a && t < b;
const expIn = (a, b, pred = () => true) => S.expenses.filter(x => inRange(x.ts, a, b) && pred(x));
const catsOf = envId => S.settings.categories.filter(c => c.env === envId).map(c => c.id);

function pocketMonthly() { return sum(S.settings.envelopes.filter(e => e.fromIncome && e.type === 'weekly'), e => e.amount * 52 / 12) + sum(S.settings.envelopes.filter(e => e.fromIncome && e.type === 'monthly'), e => e.amount); }
function billsMonthly() { return sum(S.settings.bills, b => b.amount); }
function baseFree() { return S.settings.income - billsMonthly() - pocketMonthly(); } // before debts

function weekAmount(e, ws) { const o = (S.settings.weekOverrides || {})[String(ws)]; return o != null ? o : e.amount; }
function envStatus(e, now = Date.now()) {
  const cats = catsOf(e.id);
  if (e.type === 'weekly') {
    const a = weekStart(now), spent = sum(expIn(a, a + 7 * DAY, x => cats.includes(x.cat)), x => x.amount), of = weekAmount(e, a);
    return { spent, left: of - spent, of, from: a, to: a + 7 * DAY, special: of !== e.amount };
  }
  if (e.type === 'monthly') {
    const a = monthStart(now), b = monthStart(now, 1), spent = sum(expIn(a, b, x => cats.includes(x.cat)), x => x.amount);
    return { spent, left: e.amount - spent, of: e.amount, from: a, to: b };
  }
  // fund: all top-ups minus all spending ever
  const inn = sum(S.topups.filter(t => t.env === e.id), t => t.amount);
  const spent = sum(S.expenses.filter(x => cats.includes(x.cat)), x => x.amount);
  return { spent, left: inn - spent, of: inn };
}

function debtPaid(id, before = Infinity) { return sum(S.debtPays.filter(p => p.debtId === id && p.ts < before), p => p.amount); }
function debtLeft(id, before = Infinity) { const d = debt(id); return d ? Math.max(0, d.total - debtPaid(id, before)) : 0; }
function totalDebtLeft() { return sum(S.settings.debts, d => debtLeft(d.id)); }
function totalDebt() { return sum(S.settings.debts, d => d.total); }
function savingsBalance() { return sum(S.savings, s => s.amount) - sum(S.expenses.filter(x => cat(x.cat).env === 'savings'), x => x.amount); }
/* Cash wallet: last count + withdrawals since - cash expenses since. null until the first count. */
function cashAnchor() { return (S.cash || []).filter(c => c.kind === 'count').sort((a, b) => b.ts - a.ts)[0] || null; }
function cashBalance() {
  const a = cashAnchor(); if (!a) return null;
  return a.amount + sum((S.cash || []).filter(c => c.kind === 'withdraw' && c.ts > a.ts), c => c.amount)
    - sum(S.expenses.filter(x => x.method === 'cash' && x.ts > a.ts), x => x.amount);
}
/* Run a hypothetical change and return the forecast, leaving the real state untouched. */
function whatIf(change) { const snap = JSON.stringify(S); try { change(); return forecast(); } finally { S = JSON.parse(snap); } }
function dateLabel(t) { return t ? monthName(t) : 'עוד לא ידוע'; }
function impactLine(before, after) {
  const row = (label, a, b) => {
    if (a === b) return `<div class="row"><span>${label}</span><b>${dateLabel(b)}</b></div>`;
    const better = (b || Infinity) < (a || Infinity);
    return `<div class="row"><span>${label}</span><span><s class="muted">${dateLabel(a)}</s> <b style="color:${better ? 'var(--sage)' : 'var(--bad)'}">${dateLabel(b)}</b></span></div>`;
  };
  return `<div class="card" style="margin-top:10px"><h3>מה זה עושה לתוכנית</h3>${totalDebtLeft() > 0 ? row('בלי חובות', before.debtFree, after.debtFree) : ''}${row(`${stripTags(money(S.settings.savingsGoal))} בצד`, before.goal, after.goal)}</div>`;
}

/* How much of this month's money is still unassigned in the home account. */
function planStarted(a) { return !S.settings.startMonth || a >= S.settings.startMonth; }
function monthMoney(off = 0) {
  const a = monthStart(Date.now(), off), b = monthStart(Date.now(), off + 1);
  if (!planStarted(a)) return { free: 0, commissions: 0, saved: 0, topped: 0, homeSpent: 0, regularDue: 0, before: true };
  let committed = 0, regularDue = 0;
  for (const d of S.settings.debts) {
    const leftAtStart = debtLeft(d.id, a);
    const due = Math.min(d.monthly || 0, leftAtStart);
    const paid = sum(S.debtPays.filter(p => p.debtId === d.id && inRange(p.ts, a, b)), p => p.amount);
    regularDue += due;
    committed += Math.max(due, paid);
  }
  const commissions = sum(S.incomes.filter(i => inRange(i.ts, a, b)), i => i.amount);
  const saved = sum(S.savings.filter(s => inRange(s.ts, a, b) && !s.opening), s => s.amount);
  const topped = sum(S.topups.filter(t => inRange(t.ts, a, b)), t => t.amount);
  const homeSpent = sum(expIn(a, b, x => cat(x.cat).env === 'none'), x => x.amount);
  const free = baseFree() + commissions - committed - saved - topped - homeSpent;
  return { free, commissions, saved, topped, homeSpent, regularDue };
}

/* Where the next shekel should go, following the plan's priority list. */
function nextTarget() {
  for (const p of S.settings.priority) {
    if (p === 'emergency') { if (savingsBalance() < S.settings.emergencyGoal) return { kind: 'emergency', name: 'קופת חירום', need: S.settings.emergencyGoal - savingsBalance() }; }
    else if (debt(p) && debtLeft(p) > 0) return { kind: 'debt', id: p, name: debt(p).name, need: debtLeft(p) };
  }
  for (const d of S.settings.debts) if (debtLeft(d.id) > 0) return { kind: 'debt', id: d.id, name: d.name, need: debtLeft(d.id) };
  return { kind: 'savings', name: 'חיסכון', need: Infinity };
}

/* Split an amount along the priority list. Returns the planned moves (not yet applied). */
function planAllocation(amount) {
  const moves = []; let left = Math.round(amount);
  let sav = savingsBalance(); const dl = {}; S.settings.debts.forEach(d => dl[d.id] = debtLeft(d.id));
  const order = [...S.settings.priority, ...S.settings.debts.map(d => d.id).filter(id => !S.settings.priority.includes(id))];
  for (const p of order) {
    if (left <= 0) break;
    if (p === 'emergency') {
      const need = Math.max(0, S.settings.emergencyGoal - sav), x = Math.min(need, left);
      if (x > 0) { moves.push({ kind: 'save', amount: x, name: 'קופת חירום' }); sav += x; left -= x; }
    } else if (dl[p] > 0) {
      const x = Math.min(dl[p], left);
      moves.push({ kind: 'debt', id: p, amount: x, name: debt(p).name }); dl[p] -= x; left -= x;
    }
  }
  if (left > 0) moves.push({ kind: 'save', amount: left, name: 'חיסכון' });
  return moves;
}
function applyMoves(moves, note) {
  const ts = Date.now();
  for (const m of moves) {
    if (m.kind === 'save') S.savings.push({ id: uid(), ts, amount: m.amount, note });
    else S.debtPays.push({ id: uid(), ts, debtId: m.id, amount: m.amount, note });
  }
}

/* Month-by-month forecast from today's balances. */
function forecast() {
  const dl = {}; S.settings.debts.forEach(d => dl[d.id] = debtLeft(d.id));
  let sav = savingsBalance();
  const order = [...S.settings.priority, ...S.settings.debts.map(d => d.id).filter(id => !S.settings.priority.includes(id))];
  let debtFree = totalDebtLeft() <= 0 ? Date.now() : null, goal = sav >= S.settings.savingsGoal ? Date.now() : null;
  const cur = monthMoney(0);
  let carry = 0;
  for (let m = 0; m < 120 && (!debtFree || !goal); m++) {
    const t = monthStart(Date.now(), m);
    if (!planStarted(t)) continue;
    let pool;
    if (m === 0) {
      // this month: pending regular payments still go out, plus whatever is unassigned
      for (const d of S.settings.debts) {
        const paidNow = sum(S.debtPays.filter(p => p.debtId === d.id && p.ts >= t), p => p.amount);
        const pending = Math.max(0, Math.min(d.monthly || 0, debtLeft(d.id, t)) - paidNow);
        dl[d.id] = Math.max(0, dl[d.id] - pending);
      }
      pool = cur.free;
    } else {
      pool = baseFree();
      for (const d of S.settings.debts) { const x = Math.min(d.monthly || 0, dl[d.id]); dl[d.id] -= x; pool -= x; }
    }
    pool += carry; carry = 0;
    if (pool < 0) { carry = pool; pool = 0; }
    for (const p of order) {
      if (pool <= 0) break;
      if (p === 'emergency') { const x = Math.min(Math.max(0, S.settings.emergencyGoal - sav), pool); sav += x; pool -= x; }
      else if (dl[p] > 0) { const x = Math.min(dl[p], pool); dl[p] -= x; pool -= x; }
    }
    sav += Math.max(0, pool);
    if (!debtFree && sum(Object.values(dl)) <= 0) debtFree = t;
    if (!goal && sav >= S.settings.savingsGoal) goal = t;
  }
  return { debtFree, goal };
}

/* ---------------- cloud sync ---------------- */
// Phone is the source of truth for everything except expenses logged from the widget.
// Expenses sync both ways (last edit wins); the rest of the state is pushed as one document.

function docOf() {
  const { expenses, sync, cloud, ...rest } = S;
  const f = forecast();
  rest.summary = { debtLeft: Math.round(totalDebtLeft()), debtTotal: totalDebt(), debtFree: f.debtFree ? monthOnly(f.debtFree) + ' ' + new Date(f.debtFree).getFullYear() : null, savings: Math.round(savingsBalance()), savingsGoal: S.settings.savingsGoal, at: Date.now() };
  return rest;
}
async function rpc(fn, body = {}) {
  const c = S.cloud;
  const r = await fetch(`${c.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ p_key: c.key }, body)) });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return r.json();
}
let syncing = false, syncAgain = false, syncTimer = null;
function scheduleSync(ms = 1200) { if (!S.cloud) return; clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (!S.cloud) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const sy = S.sync;
    const ids = Object.keys(sy.dirty);
    const exps = ids.map(id => S.expenses.find(x => x.id === id)).filter(Boolean).map(x => ({ ...x, m: x.m || Date.now() }));
    const tomb = sy.tomb.slice();
    tomb.forEach(t => exps.push({ ...t, deleted: true }));
    const pushDoc = sy.docDirty;
    if (exps.length || pushDoc) {
      sy.docDirty = false;
      try { await rpc('mf_push', { p_doc: pushDoc ? docOf() : null, p_expenses: exps }); }
      catch (e) { if (pushDoc) sy.docDirty = true; throw e; }
      ids.forEach(id => delete sy.dirty[id]);
      sy.tomb = sy.tomb.filter(t => !tomb.includes(t));
    }
    const p = await rpc('mf_pull', { p_since_ms: sy.since ? sy.since - 120000 : null });
    let changed = false;
    for (const e of p.expenses) {
      const i = S.expenses.findIndex(x => x.id === e.id);
      if (sy.dirty[e.id]) continue;
      if (e.deleted) { if (i >= 0) { S.expenses.splice(i, 1); changed = true; } continue; }
      const x = { id: e.id, ts: +e.ts, amount: +e.amount, desc: e.desc || '', cat: e.cat, method: e.method === 'cash' ? 'cash' : 'card', m: +e.m };
      if (i < 0) { if (!sy.tomb.some(t => t.id === e.id)) { S.expenses.push(x); learnFrom(x); changed = true; } }
      else { const o = S.expenses[i]; if ((o.m || 0) <= x.m && (o.amount !== x.amount || o.cat !== x.cat || o.desc !== x.desc || o.ts !== x.ts || (o.method || 'card') !== x.method)) { S.expenses[i] = x; changed = true; } }
    }
    sy.since = p.now; sy.lastOk = Date.now(); sy.lastErr = '';
    if (changed) sy.docDirty = true; // widget summary follows new expenses
    persist();
    if (changed && !UI.sheet) render();
  } catch (e) {
    S.sync.lastErr = navigator.onLine === false ? 'אין אינטרנט' : String(e.message || e).slice(0, 120); persist();
  } finally {
    syncing = false;
    if (syncAgain || S.sync.docDirty && S.sync.lastErr === '') { syncAgain = false; scheduleSync(400); }
  }
}
async function connectCloud(cloud) {
  S.cloud = cloud; S.sync = freshSync(); persist();
  const p = await rpc('mf_pull', {});
  if (p.rev > 0 && p.doc && p.doc.settings && !S.expenses.length && !S.debtPays.length) {
    // new phone: take everything from the cloud
    const keep = { cloud: S.cloud, sync: S.sync };
    S = Object.assign(fresh(), p.doc, keep, { setup: true, expenses: [] });
    delete S.summary;
  } else {
    S.expenses.forEach(x => S.sync.dirty[x.id] = true);
    S.sync.docDirty = true;
  }
  persist();
  await sync();
}

/* ---------------- learning (quick-add suggestions) ---------------- */

function learnFrom(x) {
  const k = x.desc.trim().toLowerCase(); if (!k) return;
  const L = S.learn[k] || { desc: x.desc.trim(), n: 0 };
  Object.assign(L, { cat: x.cat, amount: x.amount, method: x.method || 'card', n: L.n + 1, last: Date.now() });
  S.learn[k] = L;
}
function suggestions(q = '') {
  q = q.trim().toLowerCase();
  const all = Object.values(S.learn).filter(l => !q || l.desc.toLowerCase().includes(q));
  const score = l => l.n * 2 + (l.last > Date.now() - 7 * DAY ? 4 : 0) + (q && l.desc.toLowerCase().startsWith(q) ? 10 : 0);
  return all.sort((a, b) => score(b) - score(a)).slice(0, 10);
}

/* ---------------- checklist (month routine) ---------------- */

function monthItems(off = 0) {
  const a = monthStart(Date.now(), off);
  const items = [];
  if (!planStarted(a)) return items;
  for (const b of S.settings.bills) items.push({ id: 'bill:' + b.id, name: b.name, amount: b.amount, day: b.day, kind: 'bill' });
  for (const d of S.settings.debts) if ((d.monthly || 0) > 0 && debtLeft(d.id, a) > 0) items.push({ id: 'debt:' + d.id, name: d.name, amount: Math.min(d.monthly, debtLeft(d.id, a)), day: d.day, kind: 'debt', debtId: d.id });
  items.sort((x, y) => (x.day || 0) - (y.day || 0));
  items.push({ id: 'routine:review', name: 'בדיקה חודשית של 20 דקות', day: 1, kind: 'routine' });
  return items;
}
function isChecked(key, id) { return !!(S.checks[key] && S.checks[key][id]); }
function toggleCheck(off, item) {
  const key = ym(monthStart(Date.now(), off));
  S.checks[key] = S.checks[key] || {};
  const cur = S.checks[key][item.id];
  if (cur) {
    if (cur.payId) S.debtPays = S.debtPays.filter(p => p.id !== cur.payId);
    delete S.checks[key][item.id];
  } else {
    const rec = { ts: Date.now() };
    if (item.kind === 'debt') {
      const a = monthStart(Date.now(), off), b = monthStart(Date.now(), off + 1);
      const ts = Math.min(Math.max(Date.now(), a), b - 1);
      const p = { id: uid(), ts, debtId: item.debtId, amount: item.amount, note: 'תשלום חודשי' };
      S.debtPays.push(p); rec.payId = p.id;
    }
    S.checks[key][item.id] = rec;
  }
  save();
}

/* ---------------- icons ---------------- */

const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  chevL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
};

/* ---------------- render ---------------- */

const app = document.getElementById('app');
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function render() {
  if (!S.setup) { app.innerHTML = viewWelcome(); return; }
  const views = { today: viewToday, history: viewHistory, month: viewMonth, goals: viewGoals, settings: viewSettings };
  app.innerHTML = (views[UI.tab] || viewToday)() + tabBar();
}

function tabBar() {
  const t = (id, label, icon) => `<button class="tab ${UI.tab === id ? 'on' : ''}" data-act="tab" data-v="${id}">${icon}<span>${label}</span></button>`;
  return `<nav class="tabs">${t('today', 'היום', I.home)}${t('history', 'הוצאות', I.list)}<button class="fab" data-act="add" aria-label="הוצאה חדשה">${I.plus}</button>${t('month', 'החודש', I.cal)}${t('goals', 'המטרות', I.flag)}</nav>`;
}

function header(title, sub = '') {
  return `<div class="top"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><button class="icon-btn" data-act="tab" data-v="settings" aria-label="הגדרות">${I.gear}</button></div>`;
}

function expenseItem(x, showDay = false) {
  const c = cat(x.cat);
  return `<li class="item" data-act="edit" data-id="${x.id}"><div class="cdot" style="background:${c.color}">${esc(c.name[0])}</div>
    <div class="main"><div class="n">${esc(x.desc || c.name)}</div><div class="s">${esc(c.name)}${x.method === 'cash' ? ' · מזומן' : ''} · ${showDay ? dayLabel(x.ts) + ' · ' : ''}${timeLabel(x.ts)}</div></div>
    <div class="amt">${money(x.amount)}</div></li>`;
}

/* ----- welcome ----- */
function viewWelcome() {
  return `<div style="padding-top:8vh">
    <h1 style="font-size:32px;margin:0 0 8px">הכסף שלי</h1>
    <p class="muted big" style="margin:0 0 26px">כאן רושמים הוצאות בשנייה, ורואים בכל רגע כמה נשאר לשבוע, מה צריך לשלם ואיפה אתה עומד מול החובות.</p>
    <div class="card"><h3>יש לך קוד הגדרה?</h3>
      <textarea class="field" id="setup-code" placeholder="הדבק כאן את הקוד שקיבלת"></textarea>
      <div class="sp"></div><button class="btn block" data-act="setup-code">טען את התוכנית שלי</button></div>
    <button class="btn ghost block" data-act="setup-blank">להתחיל בלי קוד</button>
    <p class="muted small" style="text-align:center;margin-top:18px">הנתונים נשמרים רק במכשיר הזה.</p></div>`;
}

/* ----- today ----- */
function viewToday() {
  const now = Date.now(), pocket = env('pocket');
  let out = header('היום', new Date(Date.now()).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }));

  if (pocket) {
    const st = envStatus(pocket);
    const daysLeft = Math.max(1, Math.ceil((st.to - now) / DAY));
    const elapsed = (now - st.from) / (7 * DAY);
    const pace = st.of > 0 ? st.spent / st.of : 0;
    const cls = st.left < 0 ? 'bad' : (pace > elapsed + 0.15 && st.left < st.of * 0.5 ? 'warn' : '');
    const perDay = st.left / daysLeft;
    const pct = Math.max(0, Math.min(100, (st.left / st.of) * 100));
    let msg;
    if (st.left < 0) msg = `עברת את השבוע ב-${money(-st.left)}. מהיום עד יום ראשון מחכים, בלי למשוך מחשבון הבית.`;
    else if (daysLeft === 1) msg = `זה היום האחרון של השבוע. מחר נכנסים ${money(st.of)} חדשים.`;
    else msg = `עוד ${daysLeft} ימים עד יום ראשון · בערך ${money(perDay)} ליום`;
    out += `<div class="card hero ${cls}" data-act="week-edit">
      <div class="label">נשאר לך השבוע</div>
      <div class="amount">${money(st.left, false)}<span class="cur">₪</span></div>
      <div class="bar"><i style="width:${pct}%"></i><span class="mark" style="inset-inline-start:${(1 - elapsed) * 100}%"></span></div>
      <div class="meta">${msg}</div>${st.special ? `<div class="meta small" style="opacity:.75;margin-top:4px">סכום מיוחד לשבוע הזה (בדרך כלל ${money(pocket.amount)}). לחיצה כדי לשנות.</div>` : ''}</div>`;
  }

  // other envelopes
  const minis = S.settings.envelopes.filter(e => e.id !== 'pocket').map(e => ({ e, st: envStatus(e) })).filter(({ e, st }) => e.amount > 0 || st.of > 0 || st.spent > 0);
  const cb = cashBalance();
  const walletCard = `<button class="card mini wallet" data-act="wallet" style="text-align:start"><div class="l">בארנק (מזומן)</div><div class="v">${cb == null ? '<span style="font-size:15px">לספור</span>' : money(cb)}</div><div class="l">${cb == null ? 'כמה יש לך עכשיו?' : 'לחיצה לפרטים'}</div></button>`;
  out += `<div class="grid3">${walletCard}${minis.map(({ e, st }) => `<div class="card mini"><div class="l">${esc(e.name)}${e.type === 'monthly' ? ' · החודש' : ''}</div><div class="v">${money(st.left)}</div><div class="l">מתוך ${money(st.of)}</div></div>`).join('')}</div><div class="sp"></div>`;

  out += tiles();
  out += alerts().join('');

  const today = expIn(dayStart(), dayStart() + DAY).sort((a, b) => b.ts - a.ts);
  out += `<div class="card"><div class="row"><h3 style="margin:0">היום</h3><span class="muted small">${today.length ? money(sum(today, x => x.amount)) : ''}</span></div>
    ${today.length ? `<ul class="list" style="margin-top:6px">${today.map(x => expenseItem(x)).join('')}</ul>` : `<div class="empty">עוד לא נרשמו הוצאות היום.<br>לחיצה על הפלוס למטה, וזה לוקח שלוש שניות.</div>`}</div>`;
  return out;
}

function tiles() {
  const ws = weekStart(), ms = monthStart();
  const cats = S.settings.categories.filter(c => c.env !== 'none' && c.env !== 'savings');
  if (!cats.length) return '';
  return `<div class="tiles">${cats.map(c => {
    const weekly = c.env === 'pocket';
    const spent = sum(expIn(weekly ? ws : ms, Infinity, x => x.cat === c.id), x => x.amount);
    const wb = weekly && c.budget ? c.budget * 12 / 52 : 0;
    return `<button class="tile" style="--c:${c.color}" data-act="tile" data-v="${c.id}"><span class="tn">${esc(c.name)}</span><span class="ta">${money(spent)}</span>${wb ? `<span class="tb"><i style="width:${Math.max(0, Math.min(100, (1 - spent / wb) * 100))}%"></i></span>` : `<span class="ts">${weekly ? 'השבוע' : 'החודש'}</span>`}</button>`;
  }).join('')}</div>`;
}

function alerts() {
  const out = [], now = new Date(Date.now()), day = now.getDate(), key = ym();
  const items = monthItems(0).filter(i => i.kind !== 'routine' && !isChecked(key, i.id));
  const late = items.filter(i => i.day && i.day < day);
  const soon = items.filter(i => i.day && i.day >= day && i.day - day <= 4);
  if (late.length) out.push(alert('bad', 'לא סומן כמשולם', late.map(i => `${esc(i.name)} · ${money(i.amount)} · היה ב-${i.day}`).join('<br>'), `<button class="btn sm" data-act="tab" data-v="month">לסמן</button>`));
  if (soon.length) out.push(alert('warn', 'תשלומים בימים הקרובים', soon.map(i => `${esc(i.name)} · ${money(i.amount)} · ${i.day === day ? 'היום' : 'ב-' + i.day + ' לחודש'}`).join('<br>'), `<button class="btn sm ghost" data-act="tab" data-v="month">לתשלומים</button>`));

  const mm = monthMoney(0);
  if (day >= 3 && mm.free > 50) {
    const t = nextTarget();
    out.push(alert('ok', `יש ${money(mm.free)} שעוד לא קיבלו תפקיד החודש`, `לפי התוכנית הם הולכים ל${esc(t.name)}.`, `<button class="btn sm sage" data-act="allocate-month">להעביר עכשיו</button>`));
  }
  if (!isChecked(key, 'routine:review') && day <= 5) out.push(alert('', 'תחילת חודש', 'עשרים דקות: לבדוק שהמשכורות נכנסו ושהוראות הקבע יצאו.', `<button class="btn sm ghost" data-act="tab" data-v="month">לרשימה</button>`));
  if (S.expenses.length > 5 && Date.now() - (S.lastBackup || S.created) > 14 * DAY) out.push(alert('', 'כדאי לגבות', 'עברו שבועיים מהגיבוי האחרון. זה לוקח עשר שניות.', `<button class="btn sm ghost" data-act="backup">לגבות</button>`));
  return out;
}
function alert(kind, t, d, act = '') { return `<div class="alert ${kind}"><span class="dot"></span><div style="flex:1"><div class="t">${t}</div><div class="d">${d}</div>${act ? `<div class="act">${act}</div>` : ''}</div></div>`; }

/* ----- history ----- */
function viewHistory() {
  let out = header('הוצאות');
  const cats = S.settings.categories;
  out += `<div class="chips scroll" style="margin-bottom:12px"><button class="chip ${!UI.histCat ? 'on' : ''}" data-act="hist-cat" data-v="">הכל</button>${cats.map(c => `<button class="chip ${UI.histCat === c.id ? 'on' : ''}" style="--c:${c.color}" data-act="hist-cat" data-v="${c.id}">${esc(c.name)}</button>`).join('')}</div>`;
  const list = S.expenses.filter(x => !UI.histCat || x.cat === UI.histCat).sort((a, b) => b.ts - a.ts).slice(0, 300);
  if (!list.length) return out + `<div class="card"><div class="empty">אין עדיין הוצאות${UI.histCat ? ' בקטגוריה הזאת' : ''}.</div></div>`;
  let curWeek = null, curDay = null, html = '';
  const weekTotals = {};
  list.forEach(x => { const w = weekStart(x.ts); weekTotals[w] = (weekTotals[w] || 0) + x.amount; });
  for (const x of list) {
    const w = weekStart(x.ts), d = dayStart(x.ts);
    if (w !== curWeek) {
      if (curWeek !== null) html += `</ul></div>`;
      const label = w === weekStart() ? 'השבוע' : w === weekStart() - 7 * DAY ? 'שבוע שעבר' : 'שבוע של ' + new Date(w).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
      html += `<div class="daybar" style="font-size:15px;color:var(--ink)"><span>${label}</span><span>${money(weekTotals[w])}</span></div><div class="card" style="padding:4px 14px"><ul class="list">`;
      curWeek = w; curDay = null;
    }
    if (d !== curDay) { html += `<li class="daybar" style="margin:10px 0 0">${dayLabel(x.ts)}</li>`; curDay = d; }
    html += expenseItem(x);
  }
  return out + html + `</ul></div>`;
}

/* ----- month ----- */
function viewMonth() {
  const off = UI.monthOffset, a = monthStart(Date.now(), off), b = monthStart(Date.now(), off + 1), key = ym(a);
  let out = `<div class="top"><div class="monthnav"><button class="icon-btn" data-act="month-nav" data-v="-1">${I.chevR}</button><h1 style="font-size:22px">${monthName(a)}</h1><button class="icon-btn" data-act="month-nav" data-v="1" ${off >= 0 ? 'disabled style="opacity:.3"' : ''}>${I.chevL}</button></div><button class="icon-btn" data-act="tab" data-v="settings">${I.gear}</button></div>`;

  // spending by category
  const exps = expIn(a, b);
  const pocketCats = S.settings.categories.filter(c => c.env === 'pocket');
  const pocketSpent = sum(exps.filter(x => cat(x.cat).env === 'pocket'), x => x.amount);
  const pocketBudget = sum(pocketCats, c => c.budget);
  out += `<div class="card"><h3>כסף הכיס החודש</h3><div class="row"><span class="big-num">${money(pocketSpent)}</span><span class="muted">מתוך בערך ${money(pocketBudget)}</span></div>
    ${pocketCats.map(c => { const s = sum(exps.filter(x => x.cat === c.id), x => x.amount); const p = c.budget ? Math.min(100, s / c.budget * 100) : 0; return `<div class="catbar"><div class="row"><span>${esc(c.name)}</span><span class="muted">${money(s)}${c.budget ? ` / ${money(c.budget)}` : ''}</span></div>${c.budget ? `<div class="bar"><i style="width:${p}%;background:${s > c.budget ? 'var(--bad)' : c.color}"></i></div>` : ''}</div>`; }).join('')}
    ${(() => { const others = S.settings.categories.filter(c => c.env !== 'pocket').map(c => ({ c, s: sum(exps.filter(x => x.cat === c.id), x => x.amount) })).filter(o => o.s > 0); return others.length ? `<div class="sp"></div><h3>מחוץ לכסף הכיס</h3>${others.map(o => `<div class="row" style="padding:4px 0"><span>${esc(o.c.name)}</span><span class="muted">${money(o.s)}</span></div>`).join('')}` : ''; })()}
  </div>`;

  // checklist
  const items = monthItems(off), today = new Date(Date.now()).getDate();
  out += `<div class="card"><h3>תשלומים ושגרה</h3>${items.length ? items.map(i => {
    const done = isChecked(key, i.id), late = !done && off === 0 && i.day && i.day < today;
    return `<button class="check ${done ? 'done' : ''} ${late ? 'late' : ''}" data-act="check" data-v="${esc(i.id)}"><span class="box">${done ? I.check : ''}</span><span class="main"><div class="n">${esc(i.name)}</div><div class="s">${i.day ? 'ב-' + i.day + ' לחודש' : ''}${late ? ' · עבר המועד' : ''}${i.kind === 'debt' ? ' · נרשם כתשלום חוב' : ''}</div></span>${i.amount ? `<span class="amt">${money(i.amount)}</span>` : ''}</button>`;
  }).join('') : '<div class="empty">אין תשלומים קבועים. אפשר להוסיף בהגדרות.</div>'}</div>`;

  // money left to assign
  if (off === 0 && !planStarted(a)) out += `<div class="card"><div class="empty">התוכנית מתחילה ב${monthName(S.settings.startMonth)}.</div></div>`;
  if (off === 0 && planStarted(a)) {
    const mm = monthMoney(0), t = nextTarget();
    out += `<div class="card"><h3>כסף בלי תפקיד החודש</h3><div class="big-num">${money(Math.max(0, mm.free))}</div>
      <p class="muted small" style="margin:6px 0 12px">מה שנשאר מהמשכורות אחרי הדירה, החשבונות, החובות הקבועים וכסף הכיס${mm.commissions ? `, כולל עמלות של ${money(mm.commissions)}` : ''}. לפי התוכנית, הבא בתור: <b>${esc(t.name)}</b>.</p>
      ${mm.free > 0 ? `<button class="btn sage block" data-act="allocate-month">להעביר לפי התוכנית</button>` : ''}
      <div class="sp"></div><div class="row"><button class="btn ghost sm" data-act="events">קרה משהו?</button><button class="btn ghost sm" data-act="topup">הוספה לקופת בגדים</button></div></div>`;
    out += viewInsights();
  }
  return out;
}

/* ----- goals ----- */
function viewGoals() {
  let out = header('המטרות');
  const f = forecast(), left = totalDebtLeft(), total = totalDebt(), sav = savingsBalance(), st = S.settings;
  out += `<div class="card hero goal-hero">
    <div class="label">${left > 0 ? 'בלי אף חוב' : 'אין לך חובות'}</div>
    <div class="amount" style="font-size:34px">${left > 0 ? (f.debtFree ? monthName(f.debtFree) : 'עוד לא ידוע') : 'סגרת הכל'}</div>
    <div class="meta">${left > 0 ? `נשארו ${money(left)} מתוך ${money(total)}` : ''}${f.goal ? `${left > 0 ? ' · ' : ''}${money(st.savingsGoal)} בצד ב${monthName(f.goal)}` : ''}</div>
    ${total > 0 ? `<div class="bar"><i style="width:${(1 - left / total) * 100}%"></i></div>` : ''}
    <div class="meta small" style="opacity:.75">לפי הקצב של התוכנית, בלי עמלות. כל עמלה מקדימה את התאריך.</div></div>`;

  out += `<button class="btn block" style="margin:0 0 12px" data-act="events">קרה משהו? בונוס, הוצאה גדולה, שינוי</button>`;
  // savings
  const eg = st.emergencyGoal, sg = st.savingsGoal;
  out += `<div class="card"><div class="row"><h3 style="margin:0">הקופה בצד</h3><span class="muted small">יעד ${money(sg)}</span></div>
    <div class="big-num" style="margin-top:6px">${money(sav)}</div>
    <div class="bar"><i style="width:${Math.min(100, sav / sg * 100)}%"></i><span class="mark" style="inset-inline-start:${eg / sg * 100}%"></span></div>
    <div class="muted small">${sav < eg ? `קופת חירום: עוד ${money(eg - sav)} עד ${money(eg)}` : 'קופת החירום מלאה'}</div>
    <div class="sp"></div><div class="row"><button class="btn ghost sm" data-act="saving" data-v="1">הפקדה</button><button class="btn ghost sm" data-act="saving" data-v="-1">משיכה</button></div></div>`;

  // debts
  for (const d of st.debts) {
    const l = debtLeft(d.id), p = d.total ? (1 - l / d.total) * 100 : 100;
    out += `<div class="card"><div class="row"><h3 style="margin:0;color:var(--ink);font-size:17px">${esc(d.name)}</h3><span class="muted small">${l <= 0 ? 'סגור' : d.monthly ? `${money(d.monthly)} ב-${d.day} לחודש` : 'בלי מועד קבוע'}</span></div>
      <div class="row" style="margin-top:6px"><span class="big-num" style="font-size:24px">${l <= 0 ? 'סגרת' : money(l)}</span><span class="muted small">${l > 0 ? `מתוך ${money(d.total)}` : ''}</span></div>
      <div class="bar"><i style="width:${p}%"></i></div>
      ${l > 0 ? `<button class="btn ghost sm" data-act="pay-debt" data-v="${d.id}">רישום תשלום</button>` : ''}</div>`;
  }
  if (!st.debts.length) out += `<div class="card"><div class="empty">לא הוגדרו חובות. אפשר להוסיף בהגדרות.</div></div>`;

  // recent moves
  const moves = [...S.debtPays.map(p => ({ ts: p.ts, t: `${debt(p.debtId)?.name || 'חוב'}`, a: p.amount, id: p.id, k: 'pay' })), ...S.savings.map(s => ({ ts: s.ts, t: s.amount >= 0 ? 'הפקדה לקופה' : 'משיכה מהקופה', a: s.amount, id: s.id, k: 'sav' })), ...S.incomes.map(i => ({ ts: i.ts, t: 'עמלה נכנסה', a: i.amount, id: i.id, k: 'inc' }))].sort((a, b) => b.ts - a.ts).slice(0, 12);
  if (moves.length) out += `<div class="card"><h3>תנועות אחרונות</h3><ul class="list">${moves.map(m => `<li class="item"><div class="main"><div class="n">${esc(m.t)}</div><div class="s">${dayLabel(m.ts)}</div></div><div class="amt">${money(m.a)}</div><button class="x" data-act="del-move" data-k="${m.k}" data-id="${m.id}" aria-label="מחיקה">×</button></li>`).join('')}</ul></div>`;
  return out;
}

/* ----- settings ----- */
function viewSettings() {
  const st = S.settings;
  const line = (label, path, val) => `<div class="set-line"><span>${label}</span><input inputmode="decimal" data-set="${path}" value="${val}"></div>`;
  let out = `<div class="top"><h1>הגדרות</h1><button class="btn ghost sm" data-act="tab" data-v="today">סיום</button></div>`;
  out += `<div class="card"><h3>המספרים הגדולים</h3>
    ${line('הכנסה חודשית בטוחה (נטו)', 'income', st.income)}
    ${st.envelopes.map((e, i) => line(`${e.name} ${e.type === 'weekly' ? '(בשבוע)' : e.type === 'monthly' ? '(בחודש)' : '(קופה)'}`, `envelopes.${i}.amount`, e.amount)).join('')}
    ${line('יעד קופת חירום', 'emergencyGoal', st.emergencyGoal)}
    ${line('יעד חיסכון', 'savingsGoal', st.savingsGoal)}
    <p class="muted small">הקופה של הבגדים נטענת מ"הוספה לקופת בגדים" במסך החודש.</p></div>`;

  out += `<div class="card"><h3>תשלומים קבועים מחשבון הבית</h3><div class="form-row h"><span>שם</span><span>סכום</span><span>יום</span><span></span></div>
    ${st.bills.map((b, i) => `<div class="form-row"><input data-set="bills.${i}.name" value="${esc(b.name)}"><input inputmode="decimal" data-set="bills.${i}.amount" value="${b.amount}"><input inputmode="numeric" data-set="bills.${i}.day" value="${b.day || ''}"><button class="x" data-act="del-row" data-v="bills.${i}">×</button></div>`).join('')}
    <button class="btn ghost sm" data-act="add-row" data-v="bills">הוספת תשלום</button></div>`;

  out += `<div class="card"><h3>חובות</h3><div class="form-row h" style="grid-template-columns:1fr 80px 70px 50px 36px"><span>שם</span><span>סה"כ</span><span>בחודש</span><span>יום</span><span></span></div>
    ${st.debts.map((d, i) => `<div class="form-row" style="grid-template-columns:1fr 80px 70px 50px 36px"><input data-set="debts.${i}.name" value="${esc(d.name)}"><input inputmode="decimal" data-set="debts.${i}.total" value="${d.total}"><input inputmode="decimal" data-set="debts.${i}.monthly" value="${d.monthly || 0}"><input inputmode="numeric" data-set="debts.${i}.day" value="${d.day || ''}"><button class="x" data-act="del-row" data-v="debts.${i}">×</button></div>`).join('')}
    <button class="btn ghost sm" data-act="add-row" data-v="debts">הוספת חוב</button>
    <p class="muted small">"סה"כ" הוא הסכום בזמן ההגדרה. תשלומים שנרשמים באפליקציה יורדים ממנו לבד.</p></div>`;

  const names = { emergency: 'קופת חירום' };
  st.debts.forEach(d => names[d.id] = d.name);
  const pri = [...st.priority.filter(p => names[p]), ...st.debts.map(d => d.id).filter(id => !st.priority.includes(id))];
  out += `<div class="card"><h3>הסדר שבו הולך כסף נוסף</h3>${pri.map((p, i) => `<div class="set-line"><span>${i + 1}. ${esc(names[p])}</span><span><button class="btn ghost sm" data-act="pri" data-v="${p}" data-d="-1" ${i === 0 ? 'disabled style="opacity:.3"' : ''}>למעלה</button></span></div>`).join('')}</div>`;

  out += `<div class="card"><h3>קטגוריות</h3><div class="form-row h" style="grid-template-columns:1fr 90px 1fr 36px"><span>שם</span><span>יעד חודשי</span><span>יורד מ-</span><span></span></div>
    ${st.categories.map((c, i) => `<div class="form-row" style="grid-template-columns:1fr 90px 1fr 36px"><input data-set="categories.${i}.name" value="${esc(c.name)}"><input inputmode="decimal" data-set="categories.${i}.budget" value="${c.budget || 0}"><select class="field" style="padding:8px" data-set="categories.${i}.env">${[...st.envelopes.map(e => [e.id, e.name]), ['none', 'חשבון הבית'], ['savings', 'הקופה בצד']].map(([v, n]) => `<option value="${v}" ${c.env === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><button class="x" data-act="del-row" data-v="categories.${i}">×</button></div>`).join('')}
    <button class="btn ghost sm" data-act="add-row" data-v="categories">הוספת קטגוריה</button></div>`;

  const bf = baseFree(), dm = sum(st.debts.filter(d => debtLeft(d.id) > 0), d => d.monthly || 0);
  out += `<div class="card"><h3>החשבון החודשי</h3>
    <div class="row"><span>הכנסה</span>${money(st.income)}</div><div class="row"><span>תשלומים קבועים</span>${money(-billsMonthly())}</div><div class="row"><span>כסף הכיס (ממוצע חודשי)</span>${money(-pocketMonthly())}</div><div class="row"><span>חובות קבועים</span>${money(-dm)}</div>
    <div class="row" style="font-weight:800;margin-top:6px"><span>נשאר לחובות ולחיסכון</span>${money(bf - dm)}</div></div>`;

  if (S.cloud) {
    const sy = S.sync;
    out += `<div class="card"><h3>ענן</h3><p class="small" style="margin-top:0">${sy.lastErr ? `<span style="color:var(--bad)">הסנכרון האחרון נכשל: ${esc(sy.lastErr)}</span>` : sy.lastOk ? `מסונכרן · ${dayLabel(sy.lastOk)} ${timeLabel(sy.lastOk)}` : 'עוד לא סונכרן'}${Object.keys(sy.dirty).length ? ` · ${Object.keys(sy.dirty).length} מחכות לעלות` : ''}</p>
      <div class="row"><button class="btn ghost sm" data-act="sync-now">סנכרון עכשיו</button><button class="btn danger sm" data-act="disconnect">ניתוק</button></div></div>
      ${viewNotifySettings()}
      <div class="card"><h3>ווידג'ט במסך הבית</h3>
      <ol class="small" style="padding-inline-start:18px;margin:0 0 12px;line-height:1.7">
        <li>להוריד מה-App Store את האפליקציה החינמית <b>Scriptable</b>.</li>
        <li>ללחוץ כאן על "העתקת קוד לווידג'ט".</li>
        <li>לפתוח את Scriptable, ללחוץ על הפלוס למעלה, להדביק, ולקרוא לסקריפט <b>הכסף שלי</b> (לחיצה על השם למעלה).</li>
        <li>במסך הבית: לחיצה ארוכה, הוספת ווידג'ט, Scriptable, לבחור גודל בינוני. אחר כך לחיצה ארוכה על הווידג'ט, "עריכת ווידג'ט", ובשדה Script לבחור "הכסף שלי".</li>
        <li>בונוס: בהגדרות האייפון, כפתור הפעולה (Action Button), לבחור קיצור דרך שמריץ את הסקריפט "הכסף שלי". ככה לחיצה על הכפתור בצד פותחת רישום הוצאה.</li>
      </ol>
      <button class="btn block" data-act="copy-script">העתקת קוד לווידג'ט</button>
      <p class="muted small">בקוד יש מפתח סודי. לא לשלוח אותו לאף אחד.</p></div>`;
  } else {
    out += `<div class="card"><h3>חיבור לענן ולווידג'ט</h3><p class="muted small" style="margin-top:0">הדבק את קוד החיבור שקיבלת. הנתונים שבאייפון יעלו לענן, ואז אפשר להוסיף ווידג'ט ולרשום הוצאות גם בלי לפתוח את האפליקציה.</p>
      <textarea class="field" id="cloud-code" placeholder="קוד חיבור"></textarea><div class="sp"></div><button class="btn block" data-act="cloud-code">התחברות</button></div>`;
  }
  out += `<div class="card"><h3>גיבוי</h3><p class="muted small" style="margin-top:0">הנתונים שמורים רק באייפון. כדאי לגבות פעם בשבועיים (לשלוח לעצמך בוואטסאפ או לשמור בקבצים).</p>
    <div class="row"><button class="btn sm" data-act="backup">גיבוי עכשיו</button><button class="btn ghost sm" data-act="restore">שחזור מגיבוי</button></div>
    ${S.lastBackup ? `<p class="muted small">גיבוי אחרון: ${dayLabel(S.lastBackup)}</p>` : ''}</div>
    <div class="card"><h3>איפוס</h3><button class="btn danger sm" data-act="reset">מחיקת כל הנתונים</button></div>`;
  return out;
}

/* ---------------- sheets ---------------- */

const root = document.getElementById('sheet-root');
function openSheet(html, onMount) {
  root.innerHTML = `<div class="backdrop" data-act="close"></div><div class="sheet" role="dialog"><div class="grab"></div>${html}</div>`;
  UI.sheet = true; onMount && onMount(root.querySelector('.sheet'));
}
function closeSheet() { root.innerHTML = ''; UI.sheet = null; }

/* Quick add / edit */
let D = null; // draft
function openAdd(existing) {
  D = existing ? { ...existing, amountStr: String(existing.amount), editing: true, method: existing.method || 'card' } : { id: uid(), ts: Date.now(), amountStr: '', desc: '', cat: null, editing: false, catTouched: false, method: S.lastMethod || 'card', methodTouched: false };
  openSheet(`<div id="add"></div>`, renderAdd);
}
function renderAdd() {
  const el = document.getElementById('add'); if (!el) return;
  const amt = parseFloat(D.amountStr || '0') || 0;
  const pocket = env('pocket'), st = pocket ? envStatus(pocket) : null;
  const c = D.cat ? cat(D.cat) : null;
  let hint = '';
  if (c && amt > 0) {
    const e = env(c.env);
    if (e) { const s = envStatus(e); const after = s.left - (D.editing ? amt - (S.expenses.find(x => x.id === D.id)?.amount || 0) : amt); hint = `אחרי זה יישאר ב${e.name}: ${money(after)}`; }
    else hint = 'יורד מחשבון הבית, לא מכסף הכיס';
  } else if (st) hint = `נשאר השבוע: ${money(st.left)}`;
  const sugg = suggestions(D.desc).filter(s => s.desc !== D.desc);
  const isYesterday = dayStart(D.ts) === dayStart() - DAY;
  el.innerHTML = `
    <div class="row"><h2>${D.editing ? 'עריכת הוצאה' : 'הוצאה חדשה'}</h2><div class="seg" style="width:150px"><button class="${!isYesterday ? 'on' : ''}" data-act="when" data-v="0">היום</button><button class="${isYesterday ? 'on' : ''}" data-act="when" data-v="1">אתמול</button></div></div>
    ${sugg.length ? `<div class="chips scroll" style="margin-bottom:8px">${sugg.map(s => `<button class="chip" data-act="sugg" data-v="${esc(s.desc)}">${esc(s.desc)}<span class="a num">${Math.round(s.amount)}</span></button>`).join('')}</div>` : ''}
    <div class="amount-display ${amt ? '' : 'zero'}"><span class="num">${D.amountStr || '0'}</span><span class="cur">₪</span></div>
    <div class="hint">${hint}</div>
    <input class="field" id="desc" placeholder="על מה? (לא חובה)" value="${esc(D.desc)}" autocomplete="off" enterkeyhint="done">
    <div class="seg" style="margin-top:10px"><button class="${D.method !== 'cash' ? 'on' : ''}" data-act="method" data-v="card">כרטיס / אפל פיי</button><button class="${D.method === 'cash' ? 'on' : ''}" data-act="method" data-v="cash">מזומן${cashBalance() != null ? ` · בארנק ${stripTags(money(cashBalance() - (D.method === 'cash' ? amt : 0)))}` : ''}</button></div>
    <div class="lbl">קטגוריה</div>
    <div class="chips">${S.settings.categories.filter(k => k.env !== 'savings' || D.cat === k.id).map(k => `<button class="chip ${D.cat === k.id ? 'on' : ''}" style="--c:${k.color}" data-act="pick-cat" data-v="${k.id}">${esc(k.name)}</button>`).join('')}</div>
    <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button class="key" data-act="key" data-v="${k}">${k}</button>`).join('')}</div>
    <button class="btn block" data-act="save-exp" ${amt > 0 && D.cat ? '' : 'disabled style="opacity:.45"'}>${amt > 0 && !D.cat ? 'בחר קטגוריה' : 'שמירה'}</button>
    ${D.editing ? `<div class="sp"></div><button class="btn danger block" data-act="del-exp">מחיקה</button>` : ''}`;
  const inp = el.querySelector('#desc');
  inp.addEventListener('input', () => {
    D.desc = inp.value;
    const k = S.learn[D.desc.trim().toLowerCase()];
    if (k && !D.catTouched) D.cat = k.cat;
    if (k && k.method && !D.methodTouched) D.method = k.method;
    const pos = inp.selectionStart; renderAdd();
    const n = document.getElementById('desc'); n.focus(); n.setSelectionRange(pos, pos);
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
}
function saveExpense() {
  const amount = Math.round((parseFloat(D.amountStr) || 0) * 100) / 100;
  if (!(amount > 0) || !D.cat) return;
  const x = { id: D.id, ts: D.ts, amount, desc: (D.desc || '').trim(), cat: D.cat, method: D.method === 'cash' ? 'cash' : 'card', m: Date.now() };
  S.lastMethod = x.method;
  markExp(x.id);
  const i = S.expenses.findIndex(e => e.id === x.id);
  if (i >= 0) S.expenses[i] = x; else S.expenses.push(x);
  learnFrom(x); save(); closeSheet(); render();
  const e = env(cat(x.cat).env);
  toast((e ? `נשמר · נשאר ב${e.name}: ${stripTags(money(envStatus(e).left))}` : 'נשמר') + (x.method === 'cash' && cashBalance() != null ? ` · בארנק ${stripTags(money(cashBalance()))}` : ''));
}
function stripTags(h) { return h.replace(/<[^>]+>/g, ''); }

/* Generic amount prompt */
function askAmount({ title, sub = '', cta = 'שמירה', initial = '', note = false }, onOk) {
  openSheet(`<h2>${title}</h2>${sub ? `<p class="muted" style="margin-top:-6px">${sub}</p>` : ''}
    <input class="field" id="amt" inputmode="decimal" placeholder="סכום" value="${initial}" style="font-size:26px;text-align:center;font-weight:800">
    ${note ? `<div class="sp"></div><input class="field" id="note" placeholder="הערה (לא חובה)">` : ''}
    <div class="sp"></div><button class="btn block" id="ok">${cta}</button>`, sh => {
    const a = sh.querySelector('#amt'); setTimeout(() => a.focus(), 250);
    sh.querySelector('#ok').onclick = () => { const v = parseFloat(a.value); if (!(v > 0)) { a.focus(); return; } onOk(v, sh.querySelector('#note')?.value || ''); };
  });
}

function showAllocation(amount, title, note, extra) {
  const moves = planAllocation(amount);
  openSheet(`<h2>${title}</h2><p class="muted" style="margin-top:-6px">כך מתחלקים ${money(amount)} לפי התוכנית:</p>
    <div class="card">${moves.map(m => `<div class="row" style="padding:6px 0"><span>${m.kind === 'debt' ? 'תשלום ל' : 'הפקדה ל'}${esc(m.name)}</span><b>${money(m.amount)}</b></div>`).join('')}</div>
    <p class="muted small">אחרי שאישרת, תעביר את הכסף בפועל מהבנק. כאן זה רק נרשם.</p>
    <button class="btn sage block" id="ok">מאשר, רשום</button>`, sh => {
    sh.querySelector('#ok').onclick = () => { extra && extra(); applyMoves(moves, note); save(); closeSheet(); render(); toast('נרשם'); };
  });
}

/* ---------------- life events: extra money, big expense, lasting change ---------------- */

function openEvents() {
  openSheet(`<h2>קרה משהו?</h2><p class="muted" style="margin-top:-6px">התוכנית מתעדכנת לבד, ותראה מיד מה זה עושה לתאריכים.</p>
    <button class="card" style="width:100%;text-align:start" data-act="ev-income"><div class="t" style="font-weight:800;font-size:17px">נכנס כסף נוסף</div><div class="muted small">בונוס, עמלה, מתנה, החזר מס</div></button>
    <button class="card" style="width:100%;text-align:start" data-act="ev-expense"><div class="t" style="font-weight:800;font-size:17px">הוצאה גדולה שלא תכננתי</div><div class="muted small">תיקון, טיפול רפואי, קנס, משהו שנשבר</div></button>
    <button class="card" style="width:100%;text-align:start" data-act="ev-change"><div class="t" style="font-weight:800;font-size:17px">משהו השתנה לאורך זמן</div><div class="muted small">העלאה במשכורת, דירה חדשה, חוב חדש, מנוי חדש</div></button>`);
}

function openIncomeEvent() {
  const debts = totalDebtLeft() > 0;
  let kind = 'bonus';
  openSheet(`<h2>נכנס כסף נוסף</h2>
    <div class="seg" id="kind"><button class="on" data-k="bonus">בונוס</button><button data-k="commission">עמלה</button><button data-k="gift">מתנה</button><button data-k="other">אחר</button></div>
    <div class="lbl">כמה נכנס, נטו?</div><input class="field" id="amt" inputmode="decimal" placeholder="סכום" style="font-size:26px;text-align:center;font-weight:800">
    <div class="lbl">כמה מזה לעצמך, לפינוק?</div><input class="field" id="mine" inputmode="decimal" placeholder="0">
    <p class="muted small" id="rule" style="margin:6px 2px 0">${debts ? 'לפי הכלל שקבענו: כל עוד יש חובות, הכל הולך לתוכנית. אם בכל זאת בא לך משהו קטן, זה בסדר. תראה למטה כמה זה עולה.' : 'לפי הכלל שקבענו: 30% לך, 70% לקופה.'}</p>
    <div id="prev"></div><div class="sp"></div><button class="btn sage block" id="ok" disabled style="opacity:.45">מאשר, רשום</button>`, sh => {
    const amt = sh.querySelector('#amt'), mine = sh.querySelector('#mine'), prev = sh.querySelector('#prev'), ok = sh.querySelector('#ok');
    setTimeout(() => amt.focus(), 250);
    sh.querySelectorAll('#kind button').forEach(b => b.onclick = () => { kind = b.dataset.k; sh.querySelectorAll('#kind button').forEach(x => x.classList.toggle('on', x === b)); });
    let touchedMine = false;
    mine.addEventListener('input', () => { touchedMine = true; upd(); });
    amt.addEventListener('input', upd);
    function parts() {
      const v = parseFloat(amt.value) || 0;
      if (!touchedMine && !debts) mine.value = v ? Math.round(v * S.settings.commissionShareAfterDebts) : '';
      const me = Math.min(v, Math.max(0, parseFloat(mine.value) || 0));
      return { v, me, plan: v - me };
    }
    function upd() {
      const { v, me, plan } = parts();
      if (!(v > 0)) { prev.innerHTML = ''; ok.disabled = true; ok.style.opacity = .45; return; }
      const moves = planAllocation(plan), before = forecast();
      const after = whatIf(() => { S.incomes.push({ id: 'x', ts: Date.now(), amount: v }); if (me > 0) S.topups.push({ id: 'y', ts: Date.now(), env: 'pocket-bonus', amount: me }); applyMoves(moves, ''); });
      prev.innerHTML = `<div class="card" style="margin-top:12px"><h3>לאן זה הולך</h3>${moves.map(m => `<div class="row" style="padding:4px 0"><span>${m.kind === 'debt' ? 'תשלום ל' : 'הפקדה ל'}${esc(m.name)}</span><b>${money(m.amount)}</b></div>`).join('')}${me ? `<div class="row" style="padding:4px 0"><span>לך, לחשבון הכיס</span><b>${money(me)}</b></div>` : ''}</div>${impactLine(before, after)}`;
      ok.disabled = false; ok.style.opacity = 1;
    }
    ok.onclick = () => {
      const { v, me, plan } = parts(); if (!(v > 0)) return;
      const ts = Date.now();
      S.incomes.push({ id: uid(), ts, amount: v, kind });
      if (me > 0) S.topups.push({ id: uid(), ts, env: 'pocket-bonus', amount: me, fromCommission: true });
      applyMoves(planAllocation(plan), { bonus: 'בונוס', commission: 'עמלה', gift: 'מתנה', other: 'כסף נוסף' }[kind]);
      save(); closeSheet(); render(); toast(me > 0 ? `נרשם. את ה-${stripTags(money(me))} שלך תעביר לחשבון הכיס` : 'נרשם. עכשיו להעביר בבנק לפי הרשימה');
    };
  });
}

function openExpenseEvent() {
  let mode = 'month';
  openSheet(`<h2>הוצאה גדולה שלא תכננתי</h2><p class="muted" style="margin-top:-6px">קורה לכולם. בשביל זה יש קופה בצד. נרשום את זה ונראה איך התוכנית מתיישרת.</p>
    <input class="field" id="amt" inputmode="decimal" placeholder="סכום" style="font-size:26px;text-align:center;font-weight:800">
    <div class="sp"></div><input class="field" id="desc" placeholder="על מה? (למשל: תיקון שיניים)">
    <div class="lbl">מאיפה משלמים?</div>
    <div class="seg" id="mode"><button class="on" data-m="month">קודם מהכסף של החודש</button><button data-m="savings">מהקופה בצד</button></div>
    <div id="prev"></div><div class="sp"></div><button class="btn block" id="ok" disabled style="opacity:.45">רשום</button>`, sh => {
    const amt = sh.querySelector('#amt'), desc = sh.querySelector('#desc'), prev = sh.querySelector('#prev'), ok = sh.querySelector('#ok');
    setTimeout(() => amt.focus(), 250);
    sh.querySelectorAll('#mode button').forEach(b => b.onclick = () => { mode = b.dataset.m; sh.querySelectorAll('#mode button').forEach(x => x.classList.toggle('on', x === b)); upd(); });
    amt.addEventListener('input', upd);
    function split(v) {
      const free = Math.max(0, monthMoney(0).free), sav = Math.max(0, savingsBalance());
      let fromMonth, fromSav;
      if (mode === 'month') { fromMonth = Math.min(v, free); fromSav = Math.min(v - fromMonth, sav); }
      else { fromSav = Math.min(v, sav); fromMonth = 0; }
      const rest = v - fromMonth - fromSav; // not covered: comes out of the coming months
      return { fromMonth: fromMonth + rest, fromSav, rest };
    }
    function records(v, sp) {
      const ts = Date.now(), d = desc.value.trim() || 'הוצאה גדולה', out = [];
      if (sp.fromMonth > 0) out.push({ id: uid(), ts, amount: Math.round(sp.fromMonth), desc: d, cat: 'home', m: ts });
      const savCat = (S.settings.categories.find(c => c.env === 'savings') || {}).id;
      if (sp.fromSav > 0 && savCat) out.push({ id: uid(), ts, amount: Math.round(sp.fromSav), desc: d, cat: savCat, m: ts });
      return out;
    }
    function upd() {
      const v = parseFloat(amt.value) || 0;
      if (!(v > 0)) { prev.innerHTML = ''; ok.disabled = true; ok.style.opacity = .45; return; }
      const sp = split(v), before = forecast(), after = whatIf(() => S.expenses.push(...records(v, sp)));
      prev.innerHTML = `<div class="card" style="margin-top:12px"><h3>ככה זה מתחלק</h3>
        ${sp.fromMonth - sp.rest > 0 ? `<div class="row" style="padding:4px 0"><span>מהכסף שנשאר החודש</span><b>${money(sp.fromMonth - sp.rest)}</b></div>` : ''}
        ${sp.fromSav > 0 ? `<div class="row" style="padding:4px 0"><span>מהקופה בצד</span><b>${money(sp.fromSav)}</b></div>` : ''}
        ${sp.rest > 0 ? `<div class="row" style="padding:4px 0"><span>מהחודשים הבאים</span><b style="color:var(--bad)">${money(sp.rest)}</b></div>` : ''}
        ${sp.fromSav > 0 ? `<p class="muted small" style="margin:6px 0 0">הקופה תתמלא שוב לבד. היא ראשונה בתור לפני החובות.</p>` : ''}</div>${impactLine(before, after)}`;
      ok.disabled = false; ok.style.opacity = 1;
    }
    ok.onclick = () => {
      const v = parseFloat(amt.value) || 0; if (!(v > 0)) return;
      const recs = records(v, split(v));
      recs.forEach(x => { S.expenses.push(x); markExp(x.id); });
      save(); closeSheet(); render(); toast('נרשם. התוכנית עודכנה');
    };
  });
}

function openChangeEvent() {
  openSheet(`<h2>משהו השתנה לאורך זמן</h2><p class="muted" style="margin-top:-6px">מעדכנים את המספר בהגדרות, והתאריכים במסך המטרות מתעדכנים לבד.</p>
    <div class="card">
      <div class="set-line"><span>המשכורת עלתה או ירדה</span><button class="btn ghost sm" data-act="go-set" data-v="nums">לעדכן</button></div>
      <div class="set-line"><span>דירה, מנוי או תשלום קבוע חדש</span><button class="btn ghost sm" data-act="go-set" data-v="bills">לעדכן</button></div>
      <div class="set-line"><span>חוב חדש, או שסגרת הסדר אחר</span><button class="btn ghost sm" data-act="go-set" data-v="debts">לעדכן</button></div>
      <div class="set-line"><span>כסף הכיס לא מספיק, או נשאר הרבה</span><button class="btn ghost sm" data-act="go-set" data-v="nums">לעדכן</button></div>
    </div>
    <p class="muted small">שינוי חד-פעמי לשבוע אחד, כמו חג או חתונה, עושים בלחיצה על הכרטיס הסגול במסך "היום".</p>`);
}

/* ---------------- what the app has learned (monthly check-in) ---------------- */

function insights() {
  const end = weekStart(), start = end - 28 * DAY;
  const first = S.expenses.length ? Math.min(...S.expenses.map(x => x.ts)) : Infinity;
  if (first > end - 21 * DAY) return null; // needs about 3 full weeks of data
  const span = Math.min(28, Math.round((end - Math.max(start, weekStart(first))) / DAY));
  const weeks = span / 7, perMonth = 365 / 12 / span;
  const pocket = env('pocket'), pCats = catsOf('pocket');
  const weekAvg = sum(expIn(end - span * DAY, end, x => pCats.includes(x.cat)), x => x.amount) / weeks;
  const cats = S.settings.categories.filter(c => c.env === 'pocket' && c.budget > 0).map(c => {
    const avg = sum(expIn(end - span * DAY, end, x => x.cat === c.id), x => x.amount) * perMonth;
    return { c, avg, diff: avg - c.budget };
  }).filter(o => o.avg >= 50 && Math.abs(o.diff) > 100 && Math.abs(o.diff) > o.c.budget * 0.2).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return { weekAvg, weeks, pocket, cats };
}
function viewInsights() {
  const ins = insights();
  if (!ins) return '';
  const { weekAvg, weeks, pocket, cats } = ins;
  let out = `<div class="card"><h3>מה למדתי עליך</h3><p style="margin:0 0 8px">ב-${Math.round(weeks)} השבועות האחרונים הוצאת בממוצע <b>${money(weekAvg)}</b> בשבוע מכסף הכיס, מתוך ${money(pocket.amount)}.</p>`;
  const target = Math.round(weekAvg / 50) * 50;
  if (pocket && weekAvg > pocket.amount * 1.08) {
    const before = forecast(), after = whatIf(() => { env("pocket").amount = target; });
    out += `<p class="small muted" style="margin:0 0 8px">אתה עובר את הסכום באופן קבוע. אפשר להמשיך להתאמץ, או להגדיר ${money(target)} בשבוע ולקבל את המחיר בתוכנית: בלי חובות ב${dateLabel(after.debtFree)} במקום ${dateLabel(before.debtFree)}.</p><button class="btn ghost sm" data-act="set-weekly" data-v="${target}">לשנות ל-${money(target)} בשבוע</button>`;
  } else if (pocket && weekAvg < pocket.amount * 0.85 && weekAvg > 0) {
    const before = forecast(), after = whatIf(() => { env('pocket').amount = target; });
    out += `<p class="small muted" style="margin:0 0 8px">נשאר לך כסף בכל שבוע. אם תוריד ל-${money(target)} בשבוע, ההפרש ילך לתוכנית: בלי חובות ב${dateLabel(after.debtFree)} במקום ${dateLabel(before.debtFree)}. אפשר גם להשאיר ככה וליהנות.</p><button class="btn ghost sm" data-act="set-weekly" data-v="${target}">להוריד ל-${money(target)} בשבוע</button>`;
  }
  if (cats.length) out += `<div class="sp"></div>${cats.slice(0, 3).map(o => `<div class="set-line"><span class="small">${esc(o.c.name)}: בערך ${money(o.avg)} בחודש, היעד ${money(o.c.budget)}</span><button class="btn ghost sm" data-act="set-budget" data-v="${o.c.id}" data-d="${Math.round(o.avg / 50) * 50}">לעדכן יעד</button></div>`).join('')}<p class="muted small">היעדים לפי קטגוריה עוזרים לראות לאן הולך הכסף. הם לא משנים את הסכום השבועי.</p>`;
  return out + `</div>`;
}

/* ---------------- wallet ---------------- */

function openWallet() {
  const bal = cashBalance(), a = cashAnchor();
  const since = a ? a.ts : 0;
  const moves = [
    ...(S.cash || []).filter(c => c.ts >= since).map(c => ({ ts: c.ts, t: c.kind === 'count' ? 'ספירת ארנק' : 'משיכה מכספומט', a: c.kind === 'count' ? c.amount : c.amount, sign: c.kind === 'count' ? '=' : '+', id: c.id })),
    ...S.expenses.filter(x => x.method === 'cash' && x.ts > since).map(x => ({ ts: x.ts, t: x.desc || cat(x.cat).name, a: x.amount, sign: '-' })),
  ].sort((p, q) => q.ts - p.ts).slice(0, 15);
  openSheet(`<h2>הארנק</h2>
    <div class="card" style="text-align:center"><div class="muted small">יש לך במזומן, לפי האפליקציה</div><div class="big-num" style="font-size:40px">${bal == null ? '?' : money(bal)}</div>
      ${a ? `<div class="muted small">ספירה אחרונה: ${dayLabel(a.ts)}</div>` : '<div class="muted small">עוד לא ספרת. ספור פעם אחת, ומשם האפליקציה עוקבת לבד.</div>'}</div>
    <div class="grid2"><button class="btn block" data-act="cash-count">ספרתי את הארנק</button><button class="btn ghost block" data-act="cash-withdraw">משכתי מזומן</button></div>
    ${moves.length ? `<div class="card" style="margin-top:12px"><h3>מאז הספירה</h3><ul class="list">${moves.map(m => `<li class="item"><div class="main"><div class="n">${esc(m.t)}</div><div class="s">${dayLabel(m.ts)} · ${timeLabel(m.ts)}</div></div><div class="amt" style="color:${m.sign === '-' ? 'var(--ink)' : 'var(--sage)'}">${m.sign === '-' ? '−' : m.sign === '+' ? '+' : ''}${money(m.a)}</div>${m.id ? `<button class="x" data-act="cash-del" data-id="${m.id}">×</button>` : ''}</li>`).join('')}</ul></div>` : ''}
    <p class="muted small">משיכה מהכספומט היא לא הוצאה. הכסף רק עובר מהחשבון לארנק. ההוצאה נרשמת כשאתה משלם במזומן.</p>`);
}
function cashCount() {
  const bal = cashBalance();
  openSheet(`<h2>כמה יש בארנק עכשיו?</h2><p class="muted" style="margin-top:-6px">סופרים שטרות ומטבעות, בערך זה מספיק.</p>
    <input class="field" id="amt" inputmode="decimal" placeholder="סכום" style="font-size:26px;text-align:center;font-weight:800"><div id="diff"></div><div class="sp"></div><button class="btn block" id="ok">שמירה</button>`, sh => {
    const amt = sh.querySelector('#amt'), diffEl = sh.querySelector('#diff'); setTimeout(() => amt.focus(), 250);
    let mode = 'plain';
    const upd = () => {
      const v = parseFloat(amt.value); mode = 'plain';
      if (bal == null || !(v >= 0)) { diffEl.innerHTML = ''; return; }
      const d = Math.round(bal - v);
      if (d > 5) { mode = 'missing'; diffEl.innerHTML = `<div class="alert warn" style="margin-top:12px"><span class="dot"></span><div><div class="t">חסרים ${money(d)} שלא נרשמו</div><div class="d">כנראה משהו קטן במזומן שנשכח. בשמירה נרשום אותם כהוצאה "שונות", כדי שהשבוע יהיה מדויק.</div><div class="act"><button class="btn sm ghost" id="nolog">רק לעדכן, בלי הוצאה</button></div></div></div>`; sh.querySelector('#nolog').onclick = () => { mode = 'plain'; save1(); }; }
      else if (d < -5) diffEl.innerHTML = `<p class="muted small" style="margin-top:10px">יש ${money(-d)} יותר ממה שחשבתי. אולי נרשמה הוצאה במזומן שבעצם שולמה בכרטיס. מעדכן לפי הספירה.</p>`;
      else diffEl.innerHTML = `<p class="small" style="margin-top:10px;color:var(--sage);font-weight:700">מדויק. כל הכבוד.</p>`;
    };
    amt.addEventListener('input', upd);
    const save1 = () => {
      const v = parseFloat(amt.value); if (!(v >= 0)) { amt.focus(); return; }
      const ts = Date.now();
      if (mode === 'missing') { const miss = Math.round(bal - v); const misc = S.settings.categories.find(c => c.id === 'misc') ? 'misc' : S.settings.categories.find(c => c.env === 'pocket').id; const x = { id: uid(), ts: ts - 1, amount: miss, desc: 'מזומן שלא נרשם', cat: misc, method: 'cash', m: ts }; S.expenses.push(x); markExp(x.id); }
      S.cash = S.cash || []; S.cash.push({ id: uid(), ts, kind: 'count', amount: v });
      save(); closeSheet(); render(); toast(`בארנק: ${stripTags(money(v))}`);
    };
    sh.querySelector('#ok').onclick = save1;
  });
}

/* ---------------- notifications ---------------- */

const NOTIFY_URL = () => S.cloud && `${S.cloud.url}/functions/v1/mf-notify`;
const NOTIFY_TYPES = [
  ['sunday', 'יום ראשון בבוקר: שבוע חדש, כמה יש'],
  ['due', 'תשלומים: ערב לפני, ובבוקר של היום עצמו'],
  ['budget', 'כשכסף הכיס מתחיל להיגמר'],
  ['evening', 'בערב, אם לא נרשם כלום באותו יום'],
  ['cash', 'ביום שישי: לספור את הארנק'],
  ['month', 'ב-1 לחודש: בדיקה חודשית'],
];
function notifyState() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return standalone ? 'unsupported' : 'install';
  return Notification.permission; // default | granted | denied
}
function b64ToBytes(b64) { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function enableNotifications() {
  const perm = await Notification.requestPermission(); // must run straight from the tap on iOS
  if (perm !== 'granted') { render(); toast('ההתראות לא אושרו. אפשר לאשר בהגדרות האייפון'); return; }
  let step = 'מפתח';
  try {
    const publicKey = await rpc('mf_vapid_public', {});
    if (typeof publicKey !== 'string' || publicKey.length < 80) throw new Error('bad key');
    step = 'רישום המכשיר';
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    step = 'שמירה בשרת';
    await rpc('mf_subscribe', { p_sub: sub.toJSON() });
    S.pushOn = true; persist(); render(); toast('ההתראות פועלות');
  } catch (e) { toast(`נתקע בשלב "${step}": ${String(e.message || e).slice(0, 60)}`); }
}
async function testNotification() {
  try {
    const res = await fetch(NOTIFY_URL(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test', key: S.cloud.key }) });
    const txt = await res.text(); let r = {}; try { r = JSON.parse(txt); } catch (e) {}
    toast(r.sent ? 'נשלחה. תוך כמה שניות היא אמורה להגיע' : r.sent === 0 ? 'לא נמצא מכשיר רשום. נסה להפעיל שוב' : `השליחה נכשלה (${res.status})`);
  } catch (e) { toast('השליחה נכשלה: ' + String(e.message || e).slice(0, 60)); }
}
function viewNotifySettings() {
  if (!S.cloud) return '';
  const stt = notifyState(), on = Object.assign({ sunday: true, due: true, evening: true, budget: true, cash: true, month: true }, S.settings.notify || {});
  let body;
  if (stt === 'install') body = `<p class="muted small" style="margin-top:0">התראות עובדות רק כשהאפליקציה פתוחה מהאייקון במסך הבית, ובאייפון עם iOS 16.4 ומעלה.</p>`;
  else if (stt === 'unsupported') body = `<p class="muted small" style="margin-top:0">המכשיר הזה לא תומך בהתראות. צריך לעדכן את האייפון ל-iOS 16.4 ומעלה.</p>`;
  else if (stt === 'denied') body = `<p class="muted small" style="margin-top:0">ההתראות חסומות. כדי לפתוח: הגדרות האייפון, התראות, "הכסף שלי", ולהפעיל.</p>`;
  else if (stt !== 'granted' || !S.pushOn) body = `<p class="muted small" style="margin-top:0">תזכורות לתשלומים, לשבוע החדש, ולספירת הארנק. בלי ספאם: כל התראה נשלחת רק כשיש סיבה.</p><button class="btn block" data-act="push-on">הפעלת התראות</button>`;
  else body = `${NOTIFY_TYPES.map(([k, label]) => `<button class="check ${on[k] ? 'done' : ''}" data-act="notify-toggle" data-v="${k}"><span class="box">${on[k] ? I.check : ''}</span><span class="main"><div class="n" style="text-decoration:none;color:var(--ink)">${label}</div></span></button>`).join('')}
    <div class="sp"></div><button class="btn ghost sm" data-act="push-test">שליחת התראת בדיקה</button>`;
  return `<div class="card"><h3>התראות</h3>${body}</div>`;
}

/* Backup */
async function backup() {
  const data = JSON.stringify(S);
  const name = `הכסף-שלי-גיבוי-${new Date(Date.now()).toISOString().slice(0, 10)}.json`;
  try {
    const file = new File([data], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'גיבוי הכסף שלי' }); S.lastBackup = Date.now(); save(); render(); toast('גובה'); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(data); S.lastBackup = Date.now(); save(); render(); toast('הגיבוי הועתק. הדבק אותו בפתק או שלח לעצמך'); }
  catch (e) { openSheet(`<h2>גיבוי</h2><p class="muted">העתק את הטקסט ושמור אותו:</p><textarea class="field" style="min-height:200px">${esc(data)}</textarea>`); S.lastBackup = Date.now(); save(); }
}
function restore() {
  openSheet(`<h2>שחזור מגיבוי</h2><p class="muted" style="margin-top:-6px">בחר קובץ גיבוי, או הדבק את הטקסט שלו. זה מחליף את כל מה שיש עכשיו.</p>
    <input type="file" id="f" accept=".json,application/json" class="field"><div class="sp"></div>
    <textarea class="field" id="t" placeholder="או הדבק כאן"></textarea><div class="sp"></div><button class="btn block" id="ok">שחזור</button>`, sh => {
    const doIt = txt => { try { const o = JSON.parse(txt); if (!o.settings) throw 0; S = Object.assign(fresh(), o); save(); closeSheet(); UI.tab = 'today'; render(); toast('שוחזר'); } catch (e) { toast('הקובץ לא נראה כמו גיבוי'); } };
    sh.querySelector('#ok').onclick = async () => { const f = sh.querySelector('#f').files[0]; doIt(f ? await f.text() : sh.querySelector('#t').value); };
  });
}

/* Setup code: "MF1." + base64url(JSON) */
function decodeSetup(code) {
  code = code.trim().replace(/\s+/g, '');
  if (!code.startsWith('MF1.')) throw new Error('bad');
  const b64 = code.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const json = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  return JSON.parse(json);
}
function applySetup(o) {
  if (!o.settings && o.cloud) { S.setup = true; persist(); return connectCloud(o.cloud); }
  S.settings = Object.assign(clone(DEFAULT_SETTINGS), o.settings || {});
  if (o.savings) S.savings.push({ id: uid(), ts: Date.now(), amount: o.savings, note: 'יתרת פתיחה', opening: true });
  for (const t of o.topups || []) S.topups.push({ id: uid(), ts: Math.max(Date.now(), t.ts || 0), env: t.env, amount: t.amount });
  S.setup = true; save();
  if (o.cloud) return connectCloud(o.cloud);
}

/* Settings edits: data-set="path.to.value" */
function setPath(path, raw) {
  const parts = path.split('.'); let o = S.settings;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  const k = parts[parts.length - 1];
  const numeric = ['amount', 'income', 'emergencyGoal', 'savingsGoal', 'total', 'monthly', 'day', 'budget'].includes(k);
  o[k] = numeric ? (parseFloat(raw) || 0) : raw;
  save();
}

/* ---------------- events ---------------- */

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act, v = b.dataset.v;
  switch (act) {
    case 'tab': UI.tab = v; if (v === 'month') UI.monthOffset = 0; render(); window.scrollTo(0, 0); break;
    case 'add': openAdd(); break;
    case 'close': closeSheet(); break;
    case 'edit': { const x = S.expenses.find(x => x.id === b.dataset.id); if (x) openAdd(x); break; }
    case 'key': {
      let s = D.amountStr;
      if (v === '⌫') s = s.slice(0, -1);
      else if (v === '.') { if (!s.includes('.')) s = (s || '0') + '.'; }
      else if (!(s.includes('.') && s.split('.')[1].length >= 2) && s.length < 7) s = (s === '0' ? '' : s) + v;
      D.amountStr = s; renderAdd(); break;
    }
    case 'pick-cat': D.cat = v; D.catTouched = true; renderAdd(); break;
    case 'method': D.method = v; D.methodTouched = true; renderAdd(); break;
    case 'sugg': { const l = S.learn[v.toLowerCase()]; if (l) { D.desc = l.desc; D.cat = l.cat; if (l.method && !D.methodTouched) D.method = l.method; if (!parseFloat(D.amountStr)) D.amountStr = String(l.amount); } renderAdd(); break; }
    case 'when': { const t = new Date(Date.now()); if (v === '1') t.setDate(t.getDate() - 1); D.ts = t.getTime(); renderAdd(); break; }
    case 'save-exp': saveExpense(); break;
    case 'del-exp': { const old = S.expenses.find(x => x.id === D.id); if (old && S.cloud) { S.sync.tomb.push({ id: old.id, ts: old.ts, amount: old.amount, cat: old.cat, desc: '', m: Date.now() }); delete S.sync.dirty[old.id]; } }
      S.expenses = S.expenses.filter(x => x.id !== D.id); save(); closeSheet(); render(); toast('נמחק'); break;
    case 'hist-cat': UI.histCat = v || null; render(); break;
    case 'month-nav': UI.monthOffset = Math.min(0, UI.monthOffset + parseInt(v, 10)); render(); break;
    case 'check': { const it = monthItems(UI.monthOffset).find(i => i.id === v); if (it) { toggleCheck(UI.monthOffset, it); render(); } break; }
    case 'allocate-month': { const mm = monthMoney(0); if (mm.free > 0) showAllocation(Math.round(mm.free), 'הכסף של החודש', 'יתרה חודשית'); break; }
    case 'income': case 'ev-income': openIncomeEvent(); break;
    case 'events': openEvents(); break;
    case 'ev-expense': openExpenseEvent(); break;
    case 'ev-change': openChangeEvent(); break;
    case 'go-set': closeSheet(); UI.tab = 'settings'; render(); { const h = { nums: 0, bills: 1, debts: 2 }[v]; const cards = document.querySelectorAll('#app .card'); if (cards[h]) cards[h].scrollIntoView({ behavior: 'smooth', block: 'start' }); } break;
    case 'set-weekly': { const e = env('pocket'); e.amount = +v; save(); render(); toast('עודכן. התאריכים במסך המטרות התעדכנו'); break; }
    case 'set-budget': { const c = cat(v); c.budget = +b.dataset.d; save(); render(); toast('היעד עודכן'); break; }
    case 'topup': askAmount({ title: 'הוספה לקופת בגדים', sub: 'יוצא מהכסף שנשאר החודש' }, a => { S.topups.push({ id: uid(), ts: Date.now(), env: 'clothes', amount: a }); save(); closeSheet(); render(); toast('נוסף לקופת הבגדים'); }); break;
    case 'saving': { const sign = parseInt(v, 10); askAmount({ title: sign > 0 ? 'הפקדה לקופה' : 'משיכה מהקופה', sub: sign < 0 ? 'רק למקרה חירום אמיתי.' : '', note: true }, (a, note) => { S.savings.push({ id: uid(), ts: Date.now(), amount: sign * a, note }); save(); closeSheet(); render(); toast('נרשם'); }); break; }
    case 'pay-debt': { const d = debt(v); askAmount({ title: `תשלום ל${d.name}`, sub: `נשארו ${stripTags(money(debtLeft(v)))}`, initial: d.monthly || '' }, a => { S.debtPays.push({ id: uid(), ts: Date.now(), debtId: v, amount: Math.min(a, debtLeft(v)) }); save(); closeSheet(); render(); toast(debtLeft(v) <= 0 ? `סגרת את החוב ל${d.name}` : 'נרשם'); }); break; }
    case 'del-move': {
      const k = b.dataset.k, id = b.dataset.id;
      if (k === 'pay') { S.debtPays = S.debtPays.filter(p => p.id !== id); for (const m in S.checks) for (const c in S.checks[m]) if (S.checks[m][c].payId === id) delete S.checks[m][c]; }
      if (k === 'sav') S.savings = S.savings.filter(p => p.id !== id);
      if (k === 'inc') S.incomes = S.incomes.filter(p => p.id !== id);
      save(); render(); toast('נמחק'); break;
    }
    case 'backup': backup(); break;
    case 'restore': restore(); break;
    case 'reset': openSheet(`<h2>למחוק הכל?</h2><p class="muted">כל ההוצאות, התשלומים וההגדרות יימחקו מהמכשיר. אי אפשר לבטל.</p><button class="btn danger block" data-act="reset-yes">כן, למחוק</button>`); break;
    case 'reset-yes': S = fresh(); save(); closeSheet(); render(); break;
    case 'add-row': {
      const arr = S.settings[v];
      if (v === 'bills') arr.push({ id: uid(), name: '', amount: 0, day: 1 });
      if (v === 'debts') arr.push({ id: uid(), name: '', total: 0, monthly: 0, day: 10 });
      if (v === 'categories') arr.push({ id: uid(), name: '', env: 'pocket', budget: 0, color: ['#c2703d', '#6f9169', '#8a5bb0', '#4f7ca8', '#c24f6b', '#1fa0c9'][arr.length % 6] });
      save(); render(); break;
    }
    case 'del-row': { const [k, i] = v.split('.'); S.settings[k].splice(+i, 1); save(); render(); break; }
    case 'pri': {
      const st = S.settings, names = ['emergency', ...st.debts.map(d => d.id)];
      const pri = [...st.priority.filter(p => names.includes(p)), ...st.debts.map(d => d.id).filter(id => !st.priority.includes(id))];
      const i = pri.indexOf(v); if (i > 0) { [pri[i - 1], pri[i]] = [pri[i], pri[i - 1]]; st.priority = pri; save(); render(); }
      break;
    }
    case 'setup-code': { try { const pr = applySetup(decodeSetup(document.getElementById('setup-code').value)); render(); toast('התוכנית נטענה'); if (pr) pr.then(() => { render(); toast('מחובר לענן'); }).catch(() => { render(); toast('לא הצלחתי להתחבר לענן. ננסה שוב אחר כך'); }); } catch (err) { toast('הקוד לא תקין. נסה להדביק שוב'); } break; }
    case 'cloud-code': {
      let o; try { o = decodeSetup(document.getElementById('cloud-code').value); } catch (err) { toast('הקוד לא תקין'); break; }
      if (!o.cloud) { toast('בקוד הזה אין פרטי ענן'); break; }
      toast('מתחבר…');
      connectCloud(o.cloud).then(() => { render(); toast(S.sync.lastErr ? 'החיבור נכשל: ' + S.sync.lastErr : 'מחובר. הנתונים עלו לענן'); }).catch(e => { S.cloud = null; persist(); render(); toast('החיבור נכשל'); });
      break;
    }
    case 'sync-now': sync().then(() => { render(); toast(S.sync.lastErr ? 'לא הצליח: ' + S.sync.lastErr : 'מסונכרן'); }); break;
    case 'copy-script': {
      if (!SCRIPT_TPL) { toast('רגע, טוען…'); loadScriptTpl(); break; }
      const code = SCRIPT_TPL.replace('__URL__', S.cloud.url).replace('__ANON__', S.cloud.anon).replace('__KEY__', S.cloud.key);
      navigator.clipboard.writeText(code).then(() => toast('הקוד הועתק. עכשיו לפתוח את Scriptable'), () => openSheet(`<h2>קוד לווידג'ט</h2><p class="muted">סמן הכל והעתק:</p><textarea class="field" style="min-height:260px">${esc(code)}</textarea>`));
      break;
    }
    case 'week-edit': {
      const e = env('pocket'); if (!e) break;
      const ws = weekStart(), cur = weekAmount(e, ws);
      askAmount({ title: 'הסכום לשבוע הזה', sub: `בדרך כלל ${stripTags(money(e.amount))}. אפשר לשנות רק לשבוע הזה, למשל בחג או בשבוע של אירוע.`, initial: cur, cta: 'שמירה' }, v => {
        S.settings.weekOverrides = S.settings.weekOverrides || {};
        if (v === e.amount) delete S.settings.weekOverrides[String(ws)]; else S.settings.weekOverrides[String(ws)] = v;
        save(); closeSheet(); render(); toast('עודכן לשבוע הזה');
      });
      break;
    }
    case 'wallet': openWallet(); break;
    case 'cash-count': cashCount(); break;
    case 'cash-withdraw': askAmount({ title: 'משכתי מזומן', sub: 'כמה הוצאת מהכספומט?' }, a => { S.cash = S.cash || []; if (!cashAnchor()) { toast('קודם לספור את הארנק פעם אחת'); cashCount(); return; } S.cash.push({ id: uid(), ts: Date.now(), kind: 'withdraw', amount: a }); save(); closeSheet(); render(); toast(`בארנק: ${stripTags(money(cashBalance()))}`); }); break;
    case 'cash-del': S.cash = (S.cash || []).filter(c => c.id !== b.dataset.id); save(); openWallet(); render(); break;
    case 'push-on': enableNotifications(); break;
    case 'push-test': testNotification(); break;
    case 'notify-toggle': { S.settings.notify = Object.assign({ sunday: true, due: true, evening: true, budget: true, cash: true, month: true }, S.settings.notify || {}); S.settings.notify[v] = !S.settings.notify[v]; save(); render(); break; }
    case 'disconnect': S.cloud = null; S.sync = freshSync(); persist(); render(); toast('נותק מהענן'); break;
    case 'tile': openAdd(); D.cat = v; D.catTouched = true; renderAdd(); break;
    case 'setup-blank': S.setup = true; save(); UI.tab = 'settings'; render(); break;
  }
});
document.addEventListener('change', e => { const el = e.target.closest('[data-set]'); if (el) { setPath(el.dataset.set, el.value); if (el.tagName === 'SELECT') render(); } });

let toastTimer;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2400); }

/* ---------------- boot ---------------- */

// Preview hooks: #tab=month, #add, #setup=CODE, #now=2026-10-06 (testing only)
function applyHash() {
  const h = location.hash.slice(1);
  const nw = h.match(/now=([\d-]+)/); if (nw) { const fake = new Date(nw[1] + 'T13:00:00').getTime(), real = Date.now(), start = real; Date.now = () => fake + (performance.now() | 0); }
  const sc = h.match(/setup=(MF1\.[\w-]+)/); if (sc && !S.setup) { try { applySetup(decodeSetup(sc[1])); } catch (e) {} }
  if (h.includes('seed') && !S.expenses.length) seed();
  const m = h.match(/tab=(\w+)/); if (m) UI.tab = m[1];
  render();
  if (h.includes('add')) openAdd();
  if (h.includes('wallet') && S.setup) openWallet();
}
window.addEventListener('hashchange', () => { const h = location.hash; if (h.includes('wallet')) openWallet(); else if (h.includes('add')) openAdd(); else { const m = h.match(/tab=(\w+)/); if (m) { UI.tab = m[1]; render(); } } });
function seed() {
  const d = n => Date.now() - n * DAY;
  [['פלאפל', 38, 'food', 0], ['סופר', 214, 'super', 1], ['בירה עם החבר׳ה', 180, 'fun', 2], ['קפה', 16, 'food', 0], ['שווארמה', 62, 'food', 3], ['קפה', 16, 'food', 4]].forEach(([desc, amount, c, n]) => { const x = { id: uid(), ts: d(n), desc, amount, cat: c }; S.expenses.push(x); learnFrom(x); });
  save();
}
applyHash();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
(function migrate() {
  S.migr = S.migr || {};
  if (!S.migr.fromsav && S.setup) {
    if (!S.settings.categories.some(c => c.env === 'savings')) S.settings.categories.push({ id: 'fromsav', name: 'מהקופה בצד', env: 'savings', budget: 0, color: '#6b5a80' });
    S.migr.fromsav = true; save();
  }
  if (!S.migr.transitionWeek && S.setup && S.settings.startMonth === new Date(2026, 9, 1).getTime()) {
    const ws = String(new Date(2026, 8, 27).getTime());
    S.settings.weekOverrides = S.settings.weekOverrides || {};
    if (S.settings.weekOverrides[ws] == null) S.settings.weekOverrides[ws] = 900;
    S.migr.transitionWeek = true; save(); render();
  }
})();
let SCRIPT_TPL = null;
function loadScriptTpl() { fetch('scriptable.js').then(r => r.ok ? r.text() : null).then(t => { if (t) SCRIPT_TPL = t; }).catch(() => {}); }
if (S.cloud) { loadScriptTpl(); scheduleSync(300); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (!UI.sheet) render(); scheduleSync(200); } });
window.addEventListener('online', () => scheduleSync(200));
