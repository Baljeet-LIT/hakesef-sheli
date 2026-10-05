'use strict';
/* הכסף שלי — personal money PWA. Data lives on the device (localStorage) and syncs to the cloud.
   No personal data in this file: it arrives from the cloud (or a one-time setup code).
   The model: wallets (bank, cash, Wolt) and savings hold money. Money comes in (income), moves between
   them (transfer), and goes out (expenses, debt payments). A count sets a balance; everything after it adds up. */

const KEY = 'mayfin.v1';
const DAY = 86400000;

/* ---------------- data ---------------- */

const WALLETS = [{ id: 'bank', name: 'בנק' }, { id: 'cash', name: 'מזומן' }, { id: 'wolt', name: 'וולט' }];
const DEFAULT_SETTINGS = {
  categories: [
    { id: 'food', name: 'אוכל בחוץ', color: '#c2703d' },
    { id: 'super', name: 'סופר ובית', color: '#6f9169' },
    { id: 'fun', name: 'בילויים', color: '#8a5bb0' },
    { id: 'transport', name: 'תחבורה ורכב', color: '#4f7ca8' },
    { id: 'care', name: 'טיפוח', color: '#c24f6b' },
    { id: 'misc', name: 'שונות', color: '#8c8273' },
    { id: 'home', name: 'חד פעמי', color: '#5a4175' },
  ],
  savings: [                       // {id,name,goal,target,where}
    { id: 'emergency', name: 'קופת חירום', goal: 'לימים קשים', target: 5000, where: '' },
    { id: 'invest', name: 'תיק השקעות', goal: '', target: 0, where: '' },
  ],
  debts: [],                       // {id,name,total,monthly,day,from?,steps?:[{from,monthly}]}
  woltCredit: 0,                   // monthly Wolt credit from work, arrives on the 1st
  woltCredits: [],                 // history: [{from: monthStart, amount}]
  woltReset: false,                // true: what's left of the credit is gone at the end of the month
  notify: { due: true, evening: true },
};

function fresh() {
  return {
    v: 2, setup: false, settings: clone(DEFAULT_SETTINGS),
    expenses: [],                  // {id,ts,amount,desc,cat,method:'card'|'cash'|'wolt',reimb?,back?:{ts,to,amount},src?,m}
    moves: [],                     // {id,ts,kind:'in'|'move'|'count'|'debt',amount,to?,from?,src?,note?,debtId?}
    learn: {}, apSeen: {}, inboxDone: {}, lastBackup: 0, created: Date.now(), lastMethod: 'card',
    migr: { simple: true }, cloud: null, sync: freshSync()
  };
}
function freshSync() { return { since: null, dirty: {}, tomb: [], docDirty: false, lastOk: 0, lastErr: '' }; }

let S = load();
const UI = { tab: 'today', monthOffset: 0, histCat: null, sheet: null, setSec: null, ctx: null }; // ctx: the account / debt sheet that's open

function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const o = JSON.parse(raw); return Object.assign(fresh(), { migr: {} }, o); } } catch (e) {}
  return fresh();
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('שגיאה בשמירה'); } }
function save() { if (S.cloud) S.sync.docDirty = true; persist(); scheduleSync(); }
function markExp(id) { if (S.cloud) S.sync.dirty[id] = true; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (+f(x) || 0), 0);

/* ---------------- time ---------------- */

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
function shortDate(t) { const d = new Date(t); return `${d.getDate()}.${d.getMonth() + 1}`; }
function timeLabel(t) { return new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }
function isoDay(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

/* ---------------- money helpers ---------------- */

function money(n, cur = true) {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString('he-IL');
  return `<span class="num">${v < 0 ? '-' : ''}${s}${cur ? ' ₪' : ''}</span>`;
}
function stripTags(h) { return h.replace(/<[^>]+>/g, ''); }
const plain = n => stripTags(money(n));
const cat = id => S.settings.categories.find(c => c.id === id) || { id, name: 'בלי קטגוריה', color: '#999' };
const debt = id => S.settings.debts.find(d => d.id === id);
const inRange = (t, a, b) => t >= a && t < b;
const expIn = (a, b, pred = () => true) => S.expenses.filter(x => inRange(x.ts, a, b) && pred(x));
const mine = x => !x.reimb;        // money someone owes back isn't your spending

/* ---------------- accounts: wallets and savings ---------------- */

const isWallet = id => WALLETS.some(w => w.id === id);
const accounts = () => [...WALLETS, ...S.settings.savings];
const acct = id => accounts().find(a => a.id === id) || null;
const acctName = id => id === 'pay' ? 'בתלוש' : acct(id)?.name || 'חיסכון שנמחק';
const accOf = method => method === 'cash' ? 'cash' : method === 'wolt' ? 'wolt' : 'bank';
const methodOf = id => id === 'bank' ? 'card' : id;

/* Wolt credit arrives by itself on the 1st of every month after the first count of the Wolt wallet. */
function creditAt(t) {
  const h = (S.settings.woltCredits || []).filter(c => c.from <= t).sort((a, b) => b.from - a.from)[0];
  return h ? h.amount : (S.settings.woltCredit || 0);
}
function woltAuto() {
  const first = S.moves.filter(m => m.kind === 'count' && m.to === 'wolt').sort((a, b) => a.ts - b.ts)[0];
  if (!first) return [];
  const out = [];
  for (let M = monthStart(first.ts, 1); M <= Date.now(); M = monthStart(M, 1)) {
    const amount = creditAt(M);
    if (amount > 0 || S.settings.woltReset) out.push({ id: 'wolt:' + ym(M), ts: M, kind: S.settings.woltReset ? 'count' : 'in', to: 'wolt', amount, note: 'קרדיט וולט', auto: true });
  }
  return out;
}
function allMoves() { return S.moves.concat(woltAuto()); }
function anchorOf(id, moves = allMoves()) {
  let a = null;
  for (const m of moves) if (m.kind === 'count' && m.to === id && (!a || m.ts > a.ts)) a = m;
  return a;
}
/* Last count + everything after it. A wallet that was never counted has no balance yet (null); a saving starts at 0. */
function balance(id) {
  const moves = allMoves(), a = anchorOf(id, moves);
  if (!a && isWallet(id)) return null;
  const since = a ? a.ts : -Infinity;
  let b = a ? a.amount : 0;
  for (const m of moves) {
    if (m.ts <= since || m.kind === 'count') continue;
    if (m.to === id && (m.kind === 'in' || m.kind === 'move')) b += m.amount;
    if (m.from === id && (m.kind === 'move' || m.kind === 'debt')) b -= m.amount;
  }
  for (const x of S.expenses) {
    if (x.ts > since && accOf(x.method) === id) b -= x.amount;
    if (x.back && x.back.to === id && x.back.ts > since) b += x.back.amount;
  }
  return b;
}
const savingsTotal = () => sum(S.settings.savings, s => balance(s.id));

/* What happened in an account since its last count (savings: ever). */
function ledger(id) {
  const moves = allMoves(), a = anchorOf(id, moves), since = a ? a.ts : -Infinity;
  const out = [];
  if (a) out.push({ ts: a.ts, t: a.auto ? 'קרדיט וולט חדש' : 'עדכון יתרה', a: a.amount, sign: '=', moveId: a.auto ? null : a.id });
  for (const m of moves) {
    if (m.ts <= since || m.kind === 'count') continue;
    if (m.kind === 'in' && m.to === id) out.push({ ts: m.ts, t: m.note || SRC[m.src] || 'הכנסה', a: m.amount, sign: '+', moveId: m.auto ? null : m.id });
    if (m.kind === 'move' && m.to === id) out.push({ ts: m.ts, t: `העברה מ${acctName(m.from)}`, a: m.amount, sign: '+', moveId: m.id });
    if (m.kind === 'move' && m.from === id) out.push({ ts: m.ts, t: `העברה ל${acctName(m.to)}`, a: m.amount, sign: '-', moveId: m.id });
    if (m.kind === 'debt' && m.from === id) out.push({ ts: m.ts, t: `תשלום ל${debt(m.debtId)?.name || 'חוב'}`, a: m.amount, sign: '-', moveId: m.id });
  }
  for (const x of S.expenses) {
    if (x.ts > since && accOf(x.method) === id) out.push({ ts: x.ts, t: x.desc || cat(x.cat).name, a: x.amount, sign: '-', expId: x.id });
    if (x.back && x.back.to === id && x.back.ts > since) out.push({ ts: x.back.ts, t: `החזירו לי: ${x.desc || cat(x.cat).name}`, a: x.back.amount, sign: '+', expId: x.id });
  }
  return out.sort((p, q) => q.ts - p.ts);
}

/* ---------------- money someone owes you back ---------------- */
// An expense marked "יחזירו לי" is in the air until it's marked returned: to a wallet, or inside the payslip.
const pendingReimb = () => S.expenses.filter(x => x.reimb && !x.back).sort((a, b) => a.ts - b.ts);

/* ---------------- debts: fixed installments, and when they end ---------------- */

/* Monthly payment due in the month starting at t. A debt can start later (d.from) or change amount (d.steps: [{from, monthly}]). */
function monthlyDue(d, t) {
  if (d.from && t < monthStart(d.from)) return 0;
  const step = (d.steps || []).filter(x => t >= monthStart(x.from)).sort((a, b) => b.from - a.from)[0];
  return step ? step.monthly : (d.monthly || 0);
}
const debtPays = id => S.moves.filter(m => m.kind === 'debt' && m.debtId === id);
const debtPaid = (id, before = Infinity) => sum(debtPays(id).filter(p => p.ts < before), p => p.amount);
const paidIn = (id, a, b) => sum(debtPays(id).filter(p => inRange(p.ts, a, b)), p => p.amount);
function debtLeft(id, before = Infinity) { const d = debt(id); return d ? Math.max(0, d.total - debtPaid(id, before)) : 0; }
const activeDebts = () => S.settings.debts.filter(d => debtLeft(d.id) > 0);
/* This month's installment and how much of it is still open. */
function debtMonth(d, off = 0) {
  const a = monthStart(Date.now(), off), b = monthStart(Date.now(), off + 1);
  const due = Math.min(monthlyDue(d, a), debtLeft(d.id, a)), paid = paidIn(d.id, a, b);
  return { due, paid, open: Math.max(0, Math.min(due - paid, debtLeft(d.id))) };
}
/* The schedule from this month on, by the fixed installments. end: the month of the last payment (null: no end in sight). */
function debtSchedule(d) {
  const rows = []; let left = debtLeft(d.id);
  for (let i = 0; i < 120 && left > 0.5; i++) {
    const M = monthStart(Date.now(), i);
    const due = Math.min(i === 0 ? debtMonth(d).open : monthlyDue(d, M), left);
    if (due > 0) { left -= due; rows.push({ M, due, left }); }
  }
  return { rows, end: left <= 0.5 ? (rows.length ? rows[rows.length - 1].M : Date.now()) : null };
}
function debtFreeDate() {
  let end = Date.now();
  for (const d of activeDebts()) { const s = debtSchedule(d); if (!s.end) return null; end = Math.max(end, s.end); }
  return end;
}

/* ---------------- cloud sync ---------------- */
// Expenses sync both ways (last edit wins); everything else is pushed as one document.
// The server keeps an inbox: changes sent from outside the phone (e.g. a wallet count), applied once.

function docOf() {
  const { expenses, sync, cloud, ...rest } = S;
  const f = debtFreeDate();
  rest.summary = {
    bal: Object.fromEntries(WALLETS.map(w => [w.id, balance(w.id)])),
    savings: S.settings.savings.map(s => ({ id: s.id, name: s.name, bal: Math.round(balance(s.id)) })),
    debtLeft: Math.round(sum(S.settings.debts, d => debtLeft(d.id))), debtFree: activeDebts().length && f ? monthOnly(f) + ' ' + new Date(f).getFullYear() : null,
    at: Date.now(),
  };
  return rest;
}
const expOut = x => ({ ...x, m: x.m || Date.now(), flags: { reimb: !!x.reimb, back: x.back || null } });
function expFromServer(e) {
  const x = { id: e.id, ts: +e.ts, amount: +e.amount, desc: e.desc || '', cat: e.cat, method: e.method === 'cash' || e.method === 'wolt' ? e.method : 'card', m: +e.m };
  const f = e.flags || {};
  if (f.reimb) x.reimb = true;
  if (f.back) x.back = f.back;
  if (e.source === 'applepay') x.src = 'applepay';
  return x;
}
const expKey = x => JSON.stringify([x.amount, x.cat, x.desc, x.ts, x.method || 'card', !!x.reimb, x.back || null]);
const sameExp = (a, b) => expKey(a) === expKey(b);
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
    const exps = ids.map(id => S.expenses.find(x => x.id === id)).filter(Boolean).map(expOut);
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
      const x = expFromServer(e);
      if (i < 0) { if (!sy.tomb.some(t => t.id === e.id)) { S.expenses.push(x); if (x.src) sortApplePay(x); else learnFrom(x); changed = true; } }
      else { const o = S.expenses[i]; if ((o.m || 0) <= x.m && !sameExp(o, x)) { S.expenses[i] = x; changed = true; } }
    }
    if (applyInbox(p.inbox || [])) changed = true;
    sy.since = p.now; sy.lastOk = Date.now(); sy.lastErr = '';
    if (changed) sy.docDirty = true; // the widget's balances follow
    persist();
    if (changed && !UI.sheet) render();
  } catch (e) {
    S.sync.lastErr = navigator.onLine === false ? 'אין אינטרנט' : String(e.message || e).slice(0, 120); persist();
  } finally {
    syncing = false;
    if (syncAgain || S.sync.docDirty && S.sync.lastErr === '') { syncAgain = false; scheduleSync(400); }
  }
}
/* Inbox item payload: { moves: [...], settings: {...}, debts: {id: patch} }. Each item is applied once. */
function applyInbox(items) {
  const fresh = items.filter(it => !S.inboxDone[it.id]);
  if (!fresh.length) return false;
  for (const it of fresh) {
    const p = it.payload || {};
    for (const m of p.moves || []) if (!S.moves.some(x => x.id === m.id)) S.moves.push(m);
    Object.assign(S.settings, p.settings || {});
    for (const [id, patch] of Object.entries(p.debts || {})) { const d = debt(id); if (d) Object.assign(d, patch); }
    S.inboxDone[it.id] = Date.now();
  }
  rpc('mf_inbox_ack', { p_ids: fresh.map(it => it.id) }).catch(() => {});
  return true;
}
async function connectCloud(cloud) {
  S.cloud = cloud; S.sync = freshSync(); persist();
  const p = await rpc('mf_pull', {});
  if (p.rev > 0 && p.doc && p.doc.settings && !S.expenses.length && !S.moves.length) {
    // new phone: take everything from the cloud
    const keep = { cloud: S.cloud, sync: S.sync };
    S = Object.assign(fresh(), { migr: {} }, p.doc, keep, { setup: true, expenses: [] });
    delete S.summary;
    migrate();
  } else {
    S.expenses.forEach(x => S.sync.dirty[x.id] = true);
    S.sync.docDirty = true;
  }
  persist();
  await sync();
}

/* ---------------- Apple Pay (logged by the iPhone automation) ---------------- */
// A merchant the app already knows gets its usual category. Unknown ones wait on the home screen for a category.
function sortApplePay(x) {
  const L = S.learn[x.desc.trim().toLowerCase()];
  if (!L || !S.settings.categories.some(c => c.id === L.cat)) return;
  if (L.cat !== x.cat) { x.cat = L.cat; x.m = Date.now(); markExp(x.id); }
  seenApplePay(x); learnFrom(x);
}
function seenApplePay(x) { S.apSeen[x.id] = 1; }
function unsortedApplePay() { return S.expenses.filter(x => x.src === 'applepay' && !S.apSeen[x.id] && x.ts > Date.now() - 45 * DAY).sort((a, b) => b.ts - a.ts); }

/* What you usually log under a description: its category and how you pay. */
function learnFrom(x) {
  const k = x.desc.trim().toLowerCase(); if (!k) return;
  const L = S.learn[k] || { desc: x.desc.trim(), n: 0 };
  Object.assign(L, { cat: x.cat, amount: x.amount, method: x.method || 'card', n: L.n + 1, last: Date.now() });
  S.learn[k] = L;
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
  return `<nav class="tabs">${t('today', 'היום', I.home)}${t('history', 'הוצאות', I.list)}<button class="fab" data-act="add" aria-label="הוצאה חדשה">${I.plus}</button>${t('month', 'החודש', I.cal)}${t('goals', 'מטרות', I.flag)}</nav>`;
}

function header(title, sub = '') {
  return `<div class="top"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><button class="icon-btn" data-act="tab" data-v="settings" aria-label="הגדרות">${I.gear}</button></div>`;
}

function expenseItem(x, showDay = false) {
  const c = cat(x.cat);
  const how = x.method === 'cash' ? ' · מזומן' : x.method === 'wolt' ? ' · וולט' : x.src === 'applepay' ? ' · אפל פיי' : '';
  const r = x.reimb ? (x.back ? ' · הוחזר' : ' · יחזירו לי') : '';
  return `<li class="item ${x.reimb ? 'is-reimb' : ''}" data-act="edit" data-id="${x.id}"><div class="cdot" style="background:${c.color}">${esc(c.name[0])}</div>
    <div class="main"><div class="n">${esc(x.desc || c.name)}</div><div class="s">${esc(c.name)}${how}${r} · ${showDay ? dayLabel(x.ts) + ' · ' : ''}${timeLabel(x.ts)}</div></div>
    <div class="amt">${money(x.amount)}</div></li>`;
}
function alert(kind, t, d, act = '') { return `<div class="alert ${kind}"><span class="dot"></span><div style="flex:1"><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}${act ? `<div class="act">${act}</div>` : ''}</div></div>`; }

/* ----- welcome ----- */
function viewWelcome() {
  return `<div style="padding-top:8vh">
    <h1 style="font-size:32px;margin:0 0 8px">הכסף שלי</h1>
    <p class="muted big" style="margin:0 0 26px">כמה יש בכל ארנק, מה נכנס, מה יצא ולאן. רישום הוצאה לוקח שלוש שניות.</p>
    <div class="card"><h3>יש לך קוד חיבור?</h3>
      <textarea class="field" id="setup-code" placeholder="הדבק כאן את הקוד שקיבלת"></textarea>
      <div class="sp"></div><button class="btn block" data-act="setup-code">התחברות</button></div>
    <button class="btn ghost block" data-act="setup-blank">להתחיל בלי קוד</button>
    <p class="muted small" style="text-align:center;margin-top:18px">בלי קוד, הנתונים נשמרים רק במכשיר הזה.</p></div>`;
}

/* ----- today ----- */
function viewToday() {
  let out = header('היום', new Date(Date.now()).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }));
  out += walletsCard();
  out += `<div class="grid2" style="margin-bottom:12px"><button class="btn block" data-act="income">הכנסה</button><button class="btn ghost block" data-act="transfer">העברה</button></div>`;
  out += alerts().join('');
  const ap = unsortedApplePay();
  if (ap.length) out += `<div class="card"><div class="row"><h3 style="margin:0">מאפל פיי · לבחור קטגוריה</h3><button class="btn ghost sm" data-act="ap-ok">הכל נכון</button></div><p class="muted small" style="margin:4px 0 0">מקומות חדשים. לחיצה כדי לתקן. מהפעם הבאה הם ייכנסו לבד לקטגוריה הנכונה.</p><ul class="list" style="margin-top:4px">${ap.slice(0, 5).map(x => expenseItem(x, true)).join('')}</ul></div>`;
  const pend = pendingReimb();
  if (pend.length) out += `<button class="reimb-line" data-act="reimb"><span>יחזירו לך ${money(sum(pend, x => x.amount))}</span><span class="muted">${pend.length === 1 ? esc(pend[0].desc || cat(pend[0].cat).name) : `${pend.length} הוצאות`} · החזירו?</span></button>`;
  out += spentCard();
  const recent = S.expenses.slice().sort((a, b) => b.ts - a.ts).slice(0, 6);
  out += `<div class="card"><h3>אחרונות</h3>
    ${recent.length ? `<ul class="list">${recent.map(x => expenseItem(x, true)).join('')}</ul><button class="btn ghost sm block" style="margin-top:8px" data-act="tab" data-v="history">כל ההוצאות</button>` : `<div class="empty">עוד לא נרשמו הוצאות.<br>לחיצה על הפלוס למטה, וזה לוקח שלוש שניות.</div>`}</div>`;
  return out;
}

/* The three wallets. Tap one to see what went in and out, or to count it. */
function walletsCard() {
  const t = w => { const b = balance(w.id); return `<button class="acct" data-act="acct" data-v="${w.id}"><span>${w.name}</span><b>${b == null ? 'לספור' : money(b)}</b></button>`; };
  const sv = S.settings.savings.length ? `<button class="acct-sub" data-act="tab" data-v="goals">בחסכונות ${money(savingsTotal())}</button>` : '';
  return `<div class="accts">${WALLETS.map(t).join('')}</div>${sv}`;
}

/* This month's spending, by category. Tap a category to log an expense in it. */
function spentCard() {
  const a = monthStart(), exps = expIn(a, Infinity, mine), today = sum(expIn(dayStart(), Infinity, mine), x => x.amount);
  const tiles = S.settings.categories.map(c => `<button class="tile" style="--c:${c.color}" data-act="tile" data-v="${c.id}"><span class="tn">${esc(c.name)}</span><span class="ta">${money(sum(exps.filter(x => x.cat === c.id), x => x.amount))}</span></button>`).join('');
  return `<div class="card"><button class="row" data-act="tab" data-v="month" style="width:100%"><h3 style="margin:0">הוצאת ב${monthOnly(a)}</h3><span class="muted small">${today ? `היום ${plain(today)}` : ''}</span></button>
    <div class="big-num" style="margin:2px 0 10px">${money(sum(exps, x => x.amount))}</div><div class="tiles">${tiles}</div></div>`;
}

function alerts() {
  const out = [], today = new Date(Date.now()).getDate();
  const uncounted = WALLETS.filter(w => balance(w.id) == null);
  if (uncounted.length) out.push(alert('', 'כמה יש עכשיו?', 'כותבים פעם אחת כמה יש, ומשם האפליקציה עוקבת לבד.', uncounted.map(w => `<button class="btn sm" data-act="count" data-v="${w.id}">${w.name}</button>`).join('')));
  for (const d of activeDebts()) {
    const m = debtMonth(d); if (m.open <= 0 || !d.day) continue;
    if (d.day < today) out.push(alert('bad', `${esc(d.name)} · ${money(m.open)}`, `היה ב-${d.day} לחודש ועוד לא סומן.`, `<button class="btn sm" data-act="pay-debt" data-v="${d.id}">שילמתי</button>`));
    else if (d.day - today <= 4) out.push(alert('warn', `${esc(d.name)} · ${money(m.open)}`, d.day === today ? 'היום.' : `ב-${d.day} לחודש.`, `<button class="btn sm ghost" data-act="pay-debt" data-v="${d.id}">שילמתי</button>`));
  }
  if (!S.cloud && S.expenses.length > 5 && Date.now() - (S.lastBackup || S.created) > 14 * DAY) out.push(alert('', 'כדאי לגבות', 'עברו שבועיים מהגיבוי האחרון. זה לוקח עשר שניות.', `<button class="btn sm ghost" data-act="backup">לגבות</button>`));
  return out;
}

/* ----- history ----- */
function viewHistory() {
  let out = header('הוצאות');
  const chip = (v, name, color) => `<button class="chip ${(UI.histCat || '') === v ? 'on' : ''}" ${color ? `style="--c:${color}"` : ''} data-act="hist-cat" data-v="${v}">${esc(name)}</button>`;
  out += `<div class="chips scroll" style="margin-bottom:12px">${chip('', 'הכל')}${S.settings.categories.map(c => chip(c.id, c.name, c.color)).join('')}${S.expenses.some(x => x.reimb) ? chip('_reimb', 'יחזירו לי', '#b08a2e') : ''}</div>`;
  const pred = UI.histCat === '_reimb' ? x => x.reimb : UI.histCat ? x => x.cat === UI.histCat : () => true;
  const list = S.expenses.filter(pred).sort((a, b) => b.ts - a.ts).slice(0, 400);
  if (!list.length) return out + `<div class="card"><div class="empty">אין עדיין הוצאות${UI.histCat ? ' כאן' : ''}.</div></div>`;
  const totals = {};
  list.forEach(x => { const m = monthStart(x.ts); totals[m] = (totals[m] || 0) + (UI.histCat === '_reimb' || mine(x) ? x.amount : 0); });
  let curM = null, curDay = null, html = '';
  for (const x of list) {
    const m = monthStart(x.ts), d = dayStart(x.ts);
    if (m !== curM) {
      if (curM !== null) html += `</ul></div>`;
      html += `<div class="daybar" style="font-size:15px;color:var(--ink)"><span>${monthName(m)}</span><span>${money(totals[m])}</span></div><div class="card" style="padding:4px 14px"><ul class="list">`;
      curM = m; curDay = null;
    }
    if (d !== curDay) { html += `<li class="daybar" style="margin:10px 0 0">${dayLabel(x.ts)}</li>`; curDay = d; }
    html += expenseItem(x);
  }
  return out + html + `</ul></div>`;
}

/* ----- month: where the money went ----- */
const SRC = { salary: 'משכורת', transfer: 'העברה', cash: 'מזומן שקיבלתי', other: 'אחר' };
function viewMonth() {
  const off = UI.monthOffset, a = monthStart(Date.now(), off), b = monthStart(Date.now(), off + 1);
  let out = `<div class="top"><div class="monthnav"><button class="icon-btn" data-act="month-nav" data-v="-1">${I.chevR}</button><h1 style="font-size:22px">${monthName(a)}</h1><button class="icon-btn" data-act="month-nav" data-v="1" ${off >= 0 ? 'disabled style="opacity:.3"' : ''}>${I.chevL}</button></div><button class="icon-btn" data-act="tab" data-v="settings">${I.gear}</button></div>`;
  const exps = expIn(a, b, mine), spent = sum(exps, x => x.amount);
  const ins = allMoves().filter(m => m.kind === 'in' || (m.auto && m.kind === 'count')).filter(m => inRange(m.ts, a, b)).sort((p, q) => p.ts - q.ts);
  const inSum = sum(ins, m => m.amount), debts = S.moves.filter(m => m.kind === 'debt' && inRange(m.ts, a, b)), debtSum = sum(debts, m => m.amount);
  const net = inSum - spent - debtSum;
  out += `<div class="card"><h3>נכנס ויצא</h3>
    <div class="row line"><span>נכנס</span><b style="color:var(--sage)">${money(inSum)}</b></div>
    <div class="row line"><span>הוצאות</span><b>${money(-spent)}</b></div>
    ${debtSum ? `<div class="row line"><span>תשלומי חובות</span><b>${money(-debtSum)}</b></div>` : ''}
    <div class="row line total"><span>${net >= 0 ? 'נשאר' : 'יצא יותר ממה שנכנס'}</span><b style="color:${net >= 0 ? 'var(--sage)' : 'var(--bad)'}">${money(Math.abs(net))}</b></div></div>`;
  const byCat = S.settings.categories.map(c => ({ c, s: sum(exps.filter(x => x.cat === c.id), x => x.amount) })).filter(o => o.s > 0).sort((p, q) => q.s - p.s);
  const top = byCat.length ? byCat[0].s : 1;
  out += `<div class="card"><h3>לאן הלך הכסף</h3>${byCat.length ? byCat.map(o => `<button class="catbar" data-act="cat-hist" data-v="${o.c.id}"><div class="row"><span>${esc(o.c.name)}</span><span class="muted">${money(o.s)} · ${Math.round(o.s / spent * 100)}%</span></div><div class="bar"><i style="width:${o.s / top * 100}%;background:${o.c.color}"></i></div></button>`).join('') : '<div class="empty">עוד אין הוצאות בחודש הזה.</div>'}</div>`;
  if (ins.length) out += `<div class="card"><h3>מה נכנס</h3><ul class="list">${ins.map(m => `<li class="item"><div class="main"><div class="n">${esc(m.note || SRC[m.src] || 'הכנסה')}</div><div class="s">${m.note && SRC[m.src] ? SRC[m.src] + ' · ' : ''}ל${esc(acctName(m.to))} · ${shortDate(m.ts)}</div></div><div class="amt" style="color:var(--sage)">${money(m.amount)}</div></li>`).join('')}</ul></div>`;
  if (debts.length) out += `<div class="card"><h3>תשלומי חובות</h3>${debts.sort((p, q) => p.ts - q.ts).map(m => `<div class="row line"><span>${esc(debt(m.debtId)?.name || 'חוב')} <span class="muted small">· ${shortDate(m.ts)} · מ${esc(acctName(m.from))}</span></span><b>${money(m.amount)}</b></div>`).join('')}</div>`;
  const air = expIn(a, b, x => x.reimb && !x.back);
  if (air.length) out += `<button class="reimb-line" data-act="reimb"><span>עוד מחכה שיחזירו לך ${money(sum(air, x => x.amount))}</span><span class="muted">לא נספר בהוצאות</span></button>`;
  return out;
}

/* ----- goals: savings and debts ----- */
function viewGoals() {
  let out = header('מטרות');
  out += `<div class="set-group" style="margin-top:0">חסכונות</div>`;
  for (const s of S.settings.savings) {
    const b = balance(s.id);
    out += `<button class="card saving" data-act="acct" data-v="${s.id}"><div class="row"><b class="sn">${esc(s.name)}</b><span class="big-num" style="font-size:22px">${money(b)}</span></div>
      ${s.goal ? `<div class="muted small">${esc(s.goal)}</div>` : ''}
      ${s.target > 0 ? `<div class="bar thin"><i style="width:${Math.max(0, Math.min(100, b / s.target * 100))}%"></i></div><div class="muted small">${b >= s.target ? 'הגעת ליעד' : `עוד ${plain(s.target - b)} ליעד של ${plain(s.target)}`}</div>` : ''}
      ${s.where ? `<div class="muted small">יושב ב: ${esc(s.where)}</div>` : ''}</button>`;
  }
  out += `<button class="btn ghost block" style="margin-bottom:6px" data-act="saving-edit">חיסכון חדש</button>`;

  const act = activeDebts(), closed = S.settings.debts.filter(d => debtLeft(d.id) <= 0);
  out += `<div class="set-group">חובות</div>`;
  if (act.length) {
    const left = sum(act, d => debtLeft(d.id)), total = sum(S.settings.debts, d => d.total), f = debtFreeDate();
    out += `<div class="card hero goal-hero"><div class="label">בלי אף חוב</div><div class="amount" style="font-size:34px">${f ? monthName(f) : 'עוד לא ידוע'}</div>
      <div class="meta">נשארו ${money(left)} מתוך ${money(total)}</div><div class="bar"><i style="width:${(1 - left / total) * 100}%"></i></div>
      <div class="meta small" style="opacity:.75">לפי התשלומים הקבועים. כל תשלום שנרשם מעדכן את זה.</div></div>`;
    for (const d of act) {
      const l = debtLeft(d.id), m = debtMonth(d), s = debtSchedule(d);
      const status = m.due <= 0 ? 'אין תשלום החודש' : m.open <= 0 ? `החודש שולם ${plain(m.paid)}` : `החודש ${plain(m.open)}${d.day ? ` ב-${d.day} לחודש` : ''}`;
      out += `<div class="card"><div class="row"><b class="sn">${esc(d.name)}</b><span class="big-num" style="font-size:22px">${money(l)}</span></div>
        <div class="bar thin"><i style="width:${d.total ? (1 - l / d.total) * 100 : 100}%"></i></div>
        <div class="row small" style="margin-top:6px"><span class="${m.open > 0 ? '' : 'ok-text'}">${status}</span><span class="muted">${s.end ? `נגמר ב${monthName(s.end)}` : 'בלי מועד סיום'}</span></div>
        <div class="row" style="margin-top:10px;justify-content:flex-start;gap:8px">${m.open > 0 ? `<button class="btn sm" data-act="pay-debt" data-v="${d.id}">שילמתי</button>` : `<button class="btn sm ghost" data-act="pay-debt" data-v="${d.id}">תשלום נוסף</button>`}<button class="btn sm ghost" data-act="debt" data-v="${d.id}">לוח תשלומים</button></div></div>`;
    }
    const months = [];
    for (let i = 0; i < 6; i++) { const M = monthStart(Date.now(), i), tot = sum(act, d => (debtSchedule(d).rows.find(r => r.M === M) || {}).due || 0); if (tot > 0) months.push([M, tot]); }
    if (months.length) out += `<div class="card"><h3>החודשים הקרובים</h3>${months.map(([M, t]) => `<div class="row line"><span>${monthName(M)}</span><b>${money(t)}</b></div>`).join('')}</div>`;
  } else if (S.settings.debts.length) out += `<div class="card"><div class="empty">אין חובות פתוחים.</div></div>`;
  if (closed.length) out += `<div class="card"><div class="row"><h3 style="margin:0">חובות שסגרת</h3><span style="color:var(--sage);font-weight:700">${money(sum(closed, d => d.total))}</span></div><div class="muted small" style="margin-top:4px">${closed.map(d => esc(d.name)).join(' · ')}</div></div>`;
  if (!S.settings.debts.length) out += `<div class="card"><div class="empty">אין חובות. אפשר להוסיף בהגדרות.</div></div>`;
  return out;
}

/* ----- settings ----- */
// A short menu; each item opens its own page (UI.setSec).
const SET_SECS = {
  categories: 'קטגוריות', wolt: 'קרדיט וולט', debts: 'חובות',
  notify: 'התראות', widget: "ווידג'ט במסך הבית", applepay: 'רישום אוטומטי מאפל פיי', connect: 'חיבור לענן',
  cloud: 'ענן וסנכרון', backup: 'גיבוי ושחזור',
};
function viewSettings() {
  const sec = UI.setSec && SET_SECS[UI.setSec] ? UI.setSec : null;
  if (sec) return `<div class="top"><button class="btn ghost sm" data-act="set-sec" data-v="">${I.chevR} הגדרות</button></div><h1 class="sec-title">${SET_SECS[sec]}</h1>` + settingsSection(sec);
  const st = S.settings, sy = S.sync;
  const rowS = (id, sub) => `<button class="set-row" data-act="set-sec" data-v="${id}"><span class="main"><span class="n">${SET_SECS[id]}</span>${sub ? `<span class="s">${sub}</span>` : ''}</span>${I.chevL}</button>`;
  const pushOn = S.pushOn && notifyState() === 'granted';
  const backupOld = Date.now() - (S.lastBackup || 0) > 14 * DAY;
  let out = `<div class="top"><h1>הגדרות</h1><button class="btn ghost sm" data-act="tab" data-v="today">סיום</button></div>`;
  out += `<div class="card list-card">
    ${rowS('categories', st.categories.map(c => esc(c.name)).slice(0, 4).join(', ') + (st.categories.length > 4 ? '…' : ''))}
    ${rowS('wolt', `${plain(st.woltCredit || 0)} בחודש · ב-1 לחודש`)}
    ${rowS('debts', st.debts.length ? `${activeDebts().length} פתוחים · נשארו ${plain(sum(st.debts, d => debtLeft(d.id)))}` : 'אין')}</div>`;
  out += `<div class="set-group">באייפון</div><div class="card list-card">${S.cloud
    ? rowS('notify', pushOn ? 'פועלות' : 'כבויות') + rowS('widget', 'דרך Scriptable') + rowS('applepay', 'כל תשלום נרשם לבד')
    : rowS('connect', 'צריך קוד חיבור')}</div>`;
  out += `<div class="set-group">הנתונים</div><div class="card list-card">
    ${S.cloud ? rowS('cloud', sy.lastErr ? '<span style="color:var(--bad)">הסנכרון נכשל</span>' : sy.lastOk ? `מסונכרן · ${dayLabel(sy.lastOk)}` : 'עוד לא סונכרן') : ''}
    ${rowS('backup', S.lastBackup ? `${backupOld && !S.cloud ? '<span style="color:var(--warn)">' : '<span>'}גיבוי אחרון: ${dayLabel(S.lastBackup)}</span>` : 'עוד לא גובה')}</div>`;
  out += `<button class="btn danger sm" style="margin:8px auto 0;display:flex" data-act="reset">מחיקת כל הנתונים</button>`;
  return out;
}

/* One editable item: a name on top, labeled numbers below. */
function editBlock(arr, i, name, fields, note = '') {
  return `<div class="edit-block"><div class="eb-top"><input data-set="${arr}.${i}.name" value="${esc(name)}" placeholder="שם"><button class="x" data-act="del-row" data-v="${arr}.${i}" aria-label="מחיקה">×</button></div>
    ${fields.length ? `<div class="eb-grid">${fields.map(([label, path, val, mode]) => `<label><span>${label}</span><input inputmode="${mode || 'decimal'}" data-set="${arr}.${i}.${path}" value="${val}"></label>`).join('')}</div>` : ''}${note ? `<div class="s">${note}</div>` : ''}</div>`;
}
function settingsSection(sec) {
  const st = S.settings;
  const note = t => `<p class="muted small" style="margin:10px 2px">${t}</p>`;
  const steps = arr => `<ol class="small steps">${arr.map(x => `<li>${x}</li>`).join('')}</ol>`;
  switch (sec) {
    case 'categories': return `<div class="card">${st.categories.map((c, i) => editBlock('categories', i, c.name, [])).join('')}
      <button class="btn ghost sm" data-act="add-row" data-v="categories">הוספת קטגוריה</button></div>${note('אפשר לשנות שם בכל רגע. קטגוריה שיש בה הוצאות אי אפשר למחוק.')}`;
    case 'wolt': return `<div class="card">
      <div class="set-line"><span>כמה נכנס כל חודש<small>נכנס לבד לארנק וולט ב-1 לחודש</small></span><input inputmode="decimal" id="wolt-credit" value="${st.woltCredit || 0}"></div>
      <button class="check ${st.woltReset ? 'done' : ''}" data-act="wolt-reset"><span class="box">${st.woltReset ? I.check : ''}</span><span class="main"><div class="n" style="text-decoration:none;color:var(--ink)">מה שלא נוצל נמחק בסוף החודש</div><div class="s">אם הקרדיט לא עובר לחודש הבא</div></span></button></div>
      ${note('שינוי בסכום חל מהחודש הבא. אם גם החודש נכנס סכום אחר, מעדכנים את היתרה בארנק וולט.')}`;
    case 'debts': return `<div class="card">${st.debts.map((d, i) => [d, i]).sort((a, b) => (debtLeft(a[0].id) <= 0) - (debtLeft(b[0].id) <= 0)).map(([d, i]) => editBlock('debts', i, d.name, [['סכום התחלתי', 'total', d.total], ['בחודש', 'monthly', d.monthly || 0], ['יום', 'day', d.day || '', 'numeric']], debtLeft(d.id) > 0 ? `נשאר עכשיו ${plain(debtLeft(d.id))}${(d.steps || []).length || d.from ? ' · יש לו שינוי מתוכנן בסכום החודשי' : ''}` : 'סגור')).join('') || '<div class="empty">אין חובות</div>'}
      <button class="btn ghost sm" data-act="add-row" data-v="debts">הוספת חוב</button></div>${note('"סכום התחלתי" הוא החוב ביום שהגדרת אותו. כל תשלום שנרשם יורד ממנו לבד.')}`;
    case 'notify': return viewNotifySettings();
    case 'widget': return `<div class="card">${steps(['להוריד מה-App Store את האפליקציה החינמית <b>Scriptable</b>.', 'ללחוץ כאן למטה על "העתקת הקוד".', 'לפתוח את Scriptable, פלוס למעלה, להדביק, ולקרוא לסקריפט <b>הכסף שלי</b>. אם כבר יש סקריפט כזה: לפתוח אותו, למחוק הכל ולהדביק.', 'במסך הבית: לחיצה ארוכה, הוספת ווידג\'ט, Scriptable, גודל בינוני. לחיצה ארוכה על הווידג\'ט, "עריכת ווידג\'ט", ובשדה Script לבחור "הכסף שלי".'])}
      <button class="btn block" data-act="copy-script">העתקת הקוד</button></div>${note('בקוד יש מפתח סודי. לא לשלוח אותו לאף אחד.')}`;
    case 'applepay': return `<div class="card"><p class="small" style="margin-top:0">כל תשלום באפל פיי נרשם לבד, ומגיעה התראה. צריך שהווידג'ט יהיה מותקן עם הקוד העדכני.</p>
      ${steps(['אפליקציית <b>קיצורים</b>, לשונית <b>אוטומציה</b>, פלוס, <b>עסקה</b>.', 'לסמן את הכרטיסים ולבחור <b>הפעלה מיידית</b>.', 'אוטומציה ריקה. פעולה <b>מלל</b>: בתוכה "קלט של קיצור", ללחוץ עליו ולבחור <b>כמות</b>. ירידת שורה, שוב "קלט של קיצור", ולבחור <b>בית העסק</b>.', 'פעולה של Scriptable בשם <b>Run Script</b>: לבחור "הכסף שלי", ב-Parameter לבחור את <b>מלל</b>, ולהשאיר את Run In App כבוי.', 'לשלם פעם אחת ולבדוק שמגיעה התראה.'])}</div>
      ${note('מקום שהאפליקציה מכירה נכנס לבד לקטגוריה הנכונה. מקום חדש מופיע במסך "היום" כדי לבחור לו קטגוריה, פעם אחת.')}`;
    case 'connect': return `<div class="card"><p class="muted small" style="margin-top:0">הדבק את קוד החיבור שקיבלת. אחרי זה אפשר ווידג'ט, התראות ורישום מאפל פיי.</p>
      <textarea class="field" id="cloud-code" placeholder="קוד חיבור"></textarea><div class="sp"></div><button class="btn block" data-act="cloud-code">התחברות</button></div>`;
    case 'cloud': { const sy = S.sync; return `<div class="card"><p style="margin-top:0">${sy.lastErr ? `<span style="color:var(--bad)">הסנכרון האחרון נכשל: ${esc(sy.lastErr)}</span>` : sy.lastOk ? `מסונכרן · ${dayLabel(sy.lastOk)} ${timeLabel(sy.lastOk)}` : 'עוד לא סונכרן'}${Object.keys(sy.dirty).length ? ` · ${Object.keys(sy.dirty).length} מחכות לעלות` : ''}</p>
      <button class="btn block" data-act="sync-now">סנכרון עכשיו</button></div>${note('הסנכרון קורה לבד. צריך את הכפתור רק אם משהו נראה לא מעודכן.')}
      <button class="btn danger sm" data-act="disconnect">ניתוק מהענן</button>`; }
    case 'backup': return `<div class="card"><p class="muted small" style="margin-top:0">${S.cloud ? 'הכל כבר נשמר בענן. גיבוי לקובץ הוא ביטחון נוסף.' : 'כדאי לגבות פעם בשבועיים: לשלוח לעצמך בוואטסאפ או לשמור בקבצים.'}${S.lastBackup ? ` גיבוי אחרון: ${dayLabel(S.lastBackup)}.` : ''}</p>
      <button class="btn block" data-act="backup">גיבוי עכשיו</button><div class="sp"></div><button class="btn ghost block" data-act="restore">שחזור מגיבוי</button></div>`;
  }
  return '';
}

/* ---------------- sheets ---------------- */

const root = document.getElementById('sheet-root');
let lockY = null; // page scroll while a sheet is open: the page is pinned so it can't be dragged behind the sheet
function lockPage() {
  if (lockY != null) return;
  lockY = window.scrollY;
  Object.assign(document.body.style, { position: 'fixed', top: `-${lockY}px`, left: '0', right: '0', overflow: 'hidden' });
}
function unlockPage() {
  if (lockY == null) return;
  Object.assign(document.body.style, { position: '', top: '', left: '', right: '', overflow: '' });
  window.scrollTo(0, lockY); lockY = null;
}
function openSheet(html, onMount) {
  root.innerHTML = `<div class="backdrop" data-act="close"></div><div class="sheet" role="dialog"><div class="sheet-head"><div class="grab"></div><button class="sheet-x" data-act="close" aria-label="סגירה">×</button></div>${html}</div>`;
  UI.sheet = true; UI.ctx = null; lockPage();
  const sh = root.querySelector('.sheet');
  dragToClose(sh);
  onMount && onMount(sh);
}
function closeSheet() { root.innerHTML = ''; UI.sheet = null; UI.ctx = null; unlockPage(); }
/* Pull the sheet down to close it (only when it's scrolled to the top). */
function dragToClose(sh) {
  let y0 = null, dy = 0, dragging = false;
  sh.addEventListener('touchstart', e => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; dragging = false; }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (!dragging && dy > 10) { dragging = true; sh.style.transition = 'none'; document.activeElement && document.activeElement.blur && document.activeElement.blur(); }
    if (!dragging) { if (dy < 0) y0 = null; return; }
    e.preventDefault();
    sh.style.transform = `translateY(${Math.max(0, dy - 10)}px)`;
  }, { passive: false });
  sh.addEventListener('touchend', () => {
    if (!dragging) { y0 = null; return; }
    sh.style.transition = 'transform .2s ease';
    if (dy > 110) { sh.style.transform = 'translateY(100%)'; setTimeout(() => { if (root.contains(sh)) closeSheet(); }, 180); }
    else sh.style.transform = '';
    y0 = null; dragging = false;
  });
}

/* When did it happen: today, yesterday, or any day from the calendar. */
function whenSeg(ts) {
  const d = dayStart(ts), t0 = dayStart(), which = d === t0 ? 0 : d === t0 - DAY ? 1 : 2;
  return `<div class="seg when"><button type="button" class="${which === 0 ? 'on' : ''}" data-when="0">היום</button><button type="button" class="${which === 1 ? 'on' : ''}" data-when="1">אתמול</button><label class="${which === 2 ? 'on' : ''}">${which === 2 ? shortDate(ts) : 'תאריך אחר'}<input type="date" data-when-date max="${isoDay(Date.now())}" value="${isoDay(ts)}"></label></div>`;
}
function pickWhen(v) { const t = new Date(Date.now()); if (v === '1') t.setDate(t.getDate() - 1); return t.getTime(); }
function pickDate(iso) { if (!iso) return null; const [y, m, d] = iso.split('-').map(Number), t = new Date(y, m - 1, d, 12).getTime(); return dayStart(t) === dayStart() ? Date.now() : Math.min(t, Date.now()); }
function bindWhen(el, set) {
  el.querySelectorAll('[data-when]').forEach(b => b.onclick = () => set(pickWhen(b.dataset.when)));
  const di = el.querySelector('[data-when-date]'); if (di) di.addEventListener('change', () => { const t = pickDate(di.value); if (t) set(t); });
}
/* Pick an account: wallets first, then savings. */
function acctChips(name, sel, ids, extra = []) {
  return `<div class="chips" data-pick="${name}">${[...extra, ...ids.map(id => [id, acctName(id)])].map(([id, n]) => `<button type="button" class="chip ${sel === id ? 'on' : ''}" data-id="${id}">${esc(n)}</button>`).join('')}</div>`;
}
const allAcctIds = () => accounts().map(a => a.id);
const balAfter = (id, delta) => { const b = balance(id); return b == null ? '' : `ב${acctName(id)} ${delta ? 'יהיו' : 'יש'} ${plain(b + delta)}`; };

/* ----- expense: add / edit ----- */
let D = null; // draft
function openAdd(existing) {
  D = existing ? { ...existing, amountStr: String(existing.amount), editing: true, method: existing.method || 'card' }
    : { id: uid(), ts: Date.now(), amountStr: '', desc: '', cat: null, editing: false, catTouched: false, method: S.lastMethod || 'card', methodTouched: false, reimb: false };
  openSheet(`<div id="add"></div>`, renderAdd);
}
function renderAdd() {
  const el = document.getElementById('add'); if (!el) return;
  const amt = parseFloat(D.amountStr || '0') || 0;
  const old = D.editing && S.expenses.find(x => x.id === D.id);
  const bal = id => { const b = balance(id); return b == null ? null : b + (old && accOf(old.method) === id ? old.amount : 0); };
  const from = accOf(D.method), fb = bal(from);
  let hint = '';
  if (amt > 0 && fb != null) hint = `יישאר ב${acctName(from)}: ${money(fb - amt)}`;
  if (amt > 0 && D.reimb) hint += `${hint ? ' · ' : ''}לא נספר בהוצאות שלך עד שיחזירו`;
  const twin = !D.editing && amt > 0 && D.method === 'card' && S.expenses.find(x => x.src === 'applepay' && Math.abs(x.amount - amt) < 0.01 && Date.now() - x.ts < 3 * 3600000);
  if (twin) hint = `כבר נרשם מאפל פיי: ${esc(twin.desc || cat(twin.cat).name)}, ${timeLabel(twin.ts)}. אין צורך לרשום שוב.`;
  const m = (v, label, id) => { const b = bal(id); return `<button class="${D.method === v ? 'on' : ''}" data-act="method" data-v="${v}">${label}${b != null ? `<small>${plain(b - (D.method === v ? amt : 0))}</small>` : ''}</button>`; };
  el.innerHTML = `
    <h2>${D.editing ? 'עריכת הוצאה' : 'הוצאה חדשה'}</h2>
    <div class="amount-display ${amt ? '' : 'zero'}"><span class="num">${D.amountStr || '0'}</span><span class="cur">₪</span></div>
    <div class="hint">${hint}</div>
    <input class="field" id="desc" placeholder="על מה? (לא חובה)" value="${esc(D.desc)}" autocomplete="off" enterkeyhint="done">
    <div class="seg" style="margin-top:10px">${m('card', 'כרטיס', 'bank')}${m('cash', 'מזומן', 'cash')}${m('wolt', 'וולט', 'wolt')}</div>
    <div style="margin-top:8px">${whenSeg(D.ts)}</div>
    <div class="lbl">קטגוריה</div>
    <div class="chips">${S.settings.categories.map(k => `<button class="chip ${D.cat === k.id ? 'on' : ''}" style="--c:${k.color}" data-act="pick-cat" data-v="${k.id}">${esc(k.name)}</button>`).join('')}</div>
    <button class="mini-check ${D.reimb ? 'on' : ''}" data-act="reimb-toggle"><span class="box">${D.reimb ? I.check : ''}</span>יחזירו לי</button>
    ${D.editing && D.reimb ? (D.back ? `<div class="muted small">הוחזר ${plain(D.back.amount)} ${D.back.to === 'pay' ? 'בתלוש' : `ל${esc(acctName(D.back.to))}`} · ${shortDate(D.back.ts)} · <button class="link" data-act="unback">לבטל</button></div>` : `<button class="btn ghost sm" data-act="return-one">החזירו לי</button>`) : ''}
    <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button class="key" data-act="key" data-v="${k}">${k}</button>`).join('')}</div>
    <button class="btn block" data-act="save-exp" ${amt > 0 && D.cat ? '' : 'disabled style="opacity:.45"'}>${amt > 0 && !D.cat ? 'בחר קטגוריה' : 'שמירה'}</button>
    ${D.editing ? `<div class="sp"></div><button class="btn danger block" data-act="del-exp">מחיקה</button>` : ''}`;
  bindWhen(el, t => { D.ts = t; renderAdd(); });
  const inp = el.querySelector('#desc');
  inp.addEventListener('input', () => {
    D.desc = inp.value;
    const k = S.learn[D.desc.trim().toLowerCase()];
    if (k && !D.catTouched && S.settings.categories.some(c => c.id === k.cat)) D.cat = k.cat;
    if (k && k.method && !D.methodTouched) D.method = k.method;
    if (!D.methodTouched && /וולט|wolt/i.test(D.desc)) D.method = 'wolt';
    const pos = inp.selectionStart; renderAdd();
    const n = document.getElementById('desc'); n.focus(); n.setSelectionRange(pos, pos);
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
}
function saveExpense() {
  const amount = Math.round((parseFloat(D.amountStr) || 0) * 100) / 100;
  if (!(amount > 0) || !D.cat) return;
  const x = { id: D.id, ts: D.ts, amount, desc: (D.desc || '').trim(), cat: D.cat, method: D.method === 'cash' || D.method === 'wolt' ? D.method : 'card', m: Date.now() };
  if (D.reimb) { x.reimb = true; if (D.back) x.back = D.back; }
  if (D.src) { x.src = D.src; seenApplePay(x); }
  if (!D.editing || !D.src) S.lastMethod = x.method;
  markExp(x.id);
  const i = S.expenses.findIndex(e => e.id === x.id);
  if (i >= 0) S.expenses[i] = x; else S.expenses.push(x);
  learnFrom(x); save(); closeSheet(); render();
  const b = balance(accOf(x.method));
  toast(`נשמר${b != null ? ` · ב${acctName(accOf(x.method))} ${plain(b)}` : ''}`);
}
function deleteExpense(id) {
  const old = S.expenses.find(x => x.id === id);
  if (old && S.cloud) { S.sync.tomb.push({ id: old.id, ts: old.ts, amount: old.amount, cat: old.cat, desc: '', m: Date.now() }); delete S.sync.dirty[old.id]; }
  S.expenses = S.expenses.filter(x => x.id !== id);
}

/* ----- money in ----- */
function openIncome(preTo) {
  const R = { src: preTo === 'cash' ? 'cash' : preTo && !isWallet(preTo) ? 'other' : 'salary', to: preTo || 'bank', ts: Date.now(), toTouched: !!preTo };
  openSheet(`<h2>הכנסה</h2><div id="inc"></div>`, sh => {
    const box = sh.querySelector('#inc');
    let amtVal = '', noteVal = '';
    const draw = () => {
      box.innerHTML = `<input class="field big-field" id="amt" inputmode="decimal" placeholder="כמה נכנס?" value="${esc(amtVal)}">
        <div class="lbl">מה זה?</div>
        <div class="chips" data-pick="src">${Object.entries(SRC).map(([k, n]) => `<button type="button" class="chip ${R.src === k ? 'on' : ''}" data-id="${k}">${n}</button>`).join('')}</div>
        <div class="sp"></div><input class="field" id="note" placeholder="ממי או על מה? (לא חובה)" value="${esc(noteVal)}">
        <div class="lbl">לאן נכנס?</div>${acctChips('to', R.to, allAcctIds())}
        <p class="muted small" style="margin:6px 2px 0">${balAfter(R.to, parseFloat(amtVal) || 0)}</p>
        <div class="lbl">מתי?</div>${whenSeg(R.ts)}
        <div class="sp"></div><button class="btn sage block" id="ok">שמירה</button>`;
      const amt = box.querySelector('#amt'), note = box.querySelector('#note');
      amt.addEventListener('input', () => { amtVal = amt.value; box.querySelector('p.muted').textContent = balAfter(R.to, parseFloat(amtVal) || 0); });
      note.addEventListener('input', () => noteVal = note.value);
      box.querySelectorAll('[data-pick="src"] [data-id]').forEach(b => b.onclick = () => { R.src = b.dataset.id; if (!R.toTouched) R.to = R.src === 'cash' ? 'cash' : 'bank'; draw(); });
      box.querySelectorAll('[data-pick="to"] [data-id]').forEach(b => b.onclick = () => { R.to = b.dataset.id; R.toTouched = true; draw(); });
      bindWhen(box, t => { R.ts = t; draw(); });
      box.querySelector('#ok').onclick = () => {
        const v = Math.round((parseFloat(amtVal) || 0) * 100) / 100; if (!(v > 0)) { amt.focus(); return; }
        S.moves.push({ id: uid(), ts: R.ts, kind: 'in', amount: v, to: R.to, src: R.src, note: noteVal.trim() });
        save(); closeSheet(); render(); toast(`נרשם · ${balAfter(R.to, 0) || 'נכנס'}`);
      };
    };
    draw();
    setTimeout(() => { const a = box.querySelector('#amt'); if (a && !a.value) a.focus(); }, 250);
  });
}

/* ----- moving money between accounts (an ATM withdrawal is a transfer from the bank to cash) ----- */
function openTransfer(preFrom, preTo) {
  const R = { from: preFrom || 'bank', to: preTo || (preFrom && preFrom !== 'bank' ? 'bank' : 'cash'), ts: Date.now() };
  openSheet(`<h2>העברה</h2><div id="tr"></div>`, sh => {
    const box = sh.querySelector('#tr');
    let amtVal = '';
    const after = () => { const v = parseFloat(amtVal) || 0; return [balAfter(R.from, -v), balAfter(R.to, v)].filter(Boolean).join(' · '); };
    const draw = () => {
      box.innerHTML = `<input class="field big-field" id="amt" inputmode="decimal" placeholder="כמה?" value="${esc(amtVal)}">
        <div class="lbl">מאיפה?</div>${acctChips('from', R.from, allAcctIds())}
        <div class="lbl">לאן?</div>${acctChips('to', R.to, allAcctIds().filter(id => id !== R.from))}
        <p class="muted small" id="after" style="margin:8px 2px 0">${after()}</p>
        <div class="lbl">מתי?</div>${whenSeg(R.ts)}
        <div class="sp"></div><button class="btn block" id="ok">העברתי</button>`;
      const amt = box.querySelector('#amt');
      amt.addEventListener('input', () => { amtVal = amt.value; box.querySelector('#after').textContent = after(); });
      box.querySelectorAll('[data-pick="from"] [data-id]').forEach(b => b.onclick = () => { R.from = b.dataset.id; if (R.to === R.from) R.to = R.from === 'bank' ? 'cash' : 'bank'; draw(); });
      box.querySelectorAll('[data-pick="to"] [data-id]').forEach(b => b.onclick = () => { R.to = b.dataset.id; draw(); });
      bindWhen(box, t => { R.ts = t; draw(); });
      box.querySelector('#ok').onclick = () => {
        const v = Math.round((parseFloat(amtVal) || 0) * 100) / 100; if (!(v > 0)) { amt.focus(); return; }
        S.moves.push({ id: uid(), ts: R.ts, kind: 'move', amount: v, from: R.from, to: R.to });
        save(); closeSheet(); render(); toast(`נרשם · ${after() || 'הועבר'}`);
      };
    };
    draw();
    setTimeout(() => { const a = box.querySelector('#amt'); if (a && !a.value) a.focus(); }, 250);
  });
}

/* ----- one account: balance, what happened, actions ----- */
function openAccount(id) {
  const a = acct(id); if (!a) return;
  const b = balance(id), anc = anchorOf(id), sv = !isWallet(id);
  const rows = ledger(id).slice(0, 40);
  openSheet(`<h2>${esc(a.name)}</h2>
    <div class="card" style="text-align:center"><div class="big-num" style="font-size:40px">${b == null ? '?' : money(b)}</div>
      ${sv && a.target > 0 ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, b / a.target * 100))}%"></i></div><div class="muted small">${b >= a.target ? 'הגעת ליעד' : `היעד ${plain(a.target)} · עוד ${plain(a.target - b)}`}</div>` : ''}
      ${sv && a.goal ? `<div class="small" style="margin-top:6px">${esc(a.goal)}</div>` : ''}${sv && a.where ? `<div class="muted small">יושב ב: ${esc(a.where)}</div>` : ''}
      ${!sv ? (anc ? `<div class="muted small">${anc.auto ? 'הקרדיט החודשי נכנס' : 'עודכן'} ${dayLabel(anc.ts)}</div>` : '<div class="muted small">כותבים פעם אחת כמה יש, ומשם זה מתעדכן לבד.</div>') : ''}</div>
    <div class="grid2"><button class="btn block" data-act="income" data-v="${id}">הכנסה לכאן</button><button class="btn ghost block" data-act="transfer" data-v="${id}">העברה מכאן</button></div>
    <div class="grid2" style="margin-top:8px"><button class="btn ghost block" data-act="count" data-v="${id}">עדכון יתרה</button>${sv ? `<button class="btn ghost block" data-act="saving-edit" data-v="${id}">עריכה</button>` : `<button class="btn ghost block" data-act="add-from" data-v="${id}">הוצאה מכאן</button>`}</div>
    ${rows.length ? `<div class="card" style="margin-top:12px"><h3>${sv ? 'תנועות' : 'מאז העדכון האחרון'}</h3><ul class="list">${rows.map(moveLi).join('')}</ul></div>` : ''}`);
  UI.ctx = ['acct', id];
}
function moveLi(m) {
  const attrs = m.expId ? `data-act="edit" data-id="${m.expId}"` : '';
  return `<li class="item" ${attrs}><div class="main"><div class="n">${esc(m.t)}</div><div class="s">${dayLabel(m.ts)} · ${timeLabel(m.ts)}</div></div><div class="amt" style="color:${m.sign === '+' ? 'var(--sage)' : 'var(--ink)'}">${signed(m.a, m.sign)}</div>${m.moveId ? `<button class="x" data-act="del-move" data-id="${m.moveId}" aria-label="מחיקה">×</button>` : ''}</li>`;
}
/* An amount with its sign inside the number, so it reads right in Hebrew: +12,000 ₪ / −214 ₪ */
function signed(a, sign) { const n = Math.abs(Math.round(a)).toLocaleString('he-IL'); return `<span class="num">${sign === '-' ? '−' : sign === '+' ? '+' : ''}${n} ₪</span>`; }
function deleteMove(id) { S.moves = S.moves.filter(m => m.id !== id); }

/* ----- set a balance (count the wallet, or copy the number from the bank app) ----- */
function openCount(id) {
  const cur = balance(id), name = acctName(id);
  const sub = id === 'bank' ? 'היתרה מהאפליקציה של הבנק, פחות חיובי אשראי שעוד לא ירדו.' : id === 'cash' ? 'סופרים שטרות ומטבעות, בערך זה מספיק.' : id === 'wolt' ? 'כמה קרדיט רשום עכשיו באפליקציה של וולט.' : 'כמה יש בו עכשיו.';
  openSheet(`<h2>כמה יש עכשיו ב${esc(name)}?</h2><p class="muted" style="margin-top:-6px">${sub}</p>
    <input class="field big-field" id="amt" inputmode="decimal" placeholder="סכום"><div id="diff"></div><div class="sp"></div><button class="btn block" id="ok">שמירה</button>`, sh => {
    const amt = sh.querySelector('#amt'), diffEl = sh.querySelector('#diff'); setTimeout(() => amt.focus(), 250);
    let logMissing = false;
    const upd = () => {
      const v = parseFloat(amt.value); logMissing = false;
      if (cur == null || !(v >= 0)) { diffEl.innerHTML = ''; return; }
      const d = Math.round(cur - v);
      if (d > 5 && id === 'cash') { logMissing = true; diffEl.innerHTML = alert('warn', `חסרים ${money(d)} שלא נרשמו`, 'כנראה משהו קטן במזומן שנשכח. בשמירה הם יירשמו כהוצאה "שונות".', `<button class="btn sm ghost" id="nolog">רק לעדכן, בלי הוצאה</button>`); sh.querySelector('#nolog').onclick = () => { logMissing = false; save1(); }; }
      else if (Math.abs(d) > 5) diffEl.innerHTML = `<p class="muted small" style="margin-top:10px">לפי האפליקציה היו ${money(cur)}. ההפרש ${money(Math.abs(d))}. מעדכן לפי מה שכתבת.</p>`;
      else diffEl.innerHTML = `<p class="small ok-text" style="margin-top:10px">מדויק.</p>`;
    };
    amt.addEventListener('input', upd);
    const save1 = () => {
      const v = parseFloat(amt.value); if (!(v >= 0)) { amt.focus(); return; }
      const ts = Date.now();
      if (logMissing) { const x = { id: uid(), ts: ts - 1, amount: Math.round(cur - v), desc: 'מזומן שלא נרשם', cat: S.settings.categories.some(c => c.id === 'misc') ? 'misc' : S.settings.categories[0].id, method: 'cash', m: ts }; S.expenses.push(x); markExp(x.id); }
      S.moves.push({ id: uid(), ts, kind: 'count', to: id, amount: v });
      save(); closeSheet(); render(); toast(`ב${name}: ${plain(v)}`);
    };
    sh.querySelector('#ok').onclick = save1;
  });
}

/* ----- a saving: new or edit ----- */
function openSavingEdit(id) {
  const s = id ? S.settings.savings.find(x => x.id === id) : null;
  openSheet(`<h2>${s ? 'עריכת חיסכון' : 'חיסכון חדש'}</h2>
    <div class="lbl" style="margin-top:0">שם</div><input class="field" id="name" value="${esc(s?.name || '')}" placeholder="למשל: טיסה ליוון">
    <div class="lbl">בשביל מה?</div><input class="field" id="goal" value="${esc(s?.goal || '')}" placeholder="לא חובה">
    <div class="lbl">כמה רוצים להגיע?</div><input class="field" id="target" inputmode="decimal" value="${s?.target || ''}" placeholder="לא חובה">
    <div class="lbl">איפה הכסף יושב?</div><input class="field" id="where" value="${esc(s?.where || '')}" placeholder="למשל: פיקדון בבנק, קרן כספית, מעטפה בבית">
    <div class="sp"></div><button class="btn block" id="ok">שמירה</button>
    ${s && !['emergency', 'invest'].includes(s.id) ? `<div class="sp"></div><button class="btn danger block" id="del">מחיקת החיסכון</button>` : ''}`, sh => {
    const v = k => sh.querySelector('#' + k).value.trim();
    if (!s) setTimeout(() => sh.querySelector('#name').focus(), 250);
    sh.querySelector('#ok').onclick = () => {
      if (!v('name')) { sh.querySelector('#name').focus(); return; }
      const o = s || { id: uid() };
      Object.assign(o, { name: v('name'), goal: v('goal'), target: parseFloat(v('target')) || 0, where: v('where') });
      if (!s) S.settings.savings.push(o);
      save(); closeSheet(); render(); toast(s ? 'עודכן' : 'נפתח חיסכון חדש');
    };
    const del = sh.querySelector('#del');
    if (del) del.onclick = () => {
      if (Math.round(balance(s.id))) { toast('קודם להעביר את הכסף ממנו'); return; }
      S.settings.savings = S.settings.savings.filter(x => x.id !== s.id);
      save(); closeSheet(); render(); toast('נמחק');
    };
  });
}

/* ----- debts ----- */
function openPayDebt(debtId) {
  const d = debt(debtId); if (!d) return;
  const m = debtMonth(d), R = { from: d.payFrom && acct(d.payFrom) ? d.payFrom : 'bank', ts: Date.now() };
  openSheet(`<h2>תשלום ל${esc(d.name)}</h2><p class="muted" style="margin-top:-6px">נשארו ${money(debtLeft(debtId))}${m.open > 0 ? ` · החודש ${money(m.open)}` : ''}</p><div id="pay"></div>`, sh => {
    const box = sh.querySelector('#pay');
    let amtVal = m.open > 0 ? String(m.open) : '';
    const draw = () => {
      box.innerHTML = `<input class="field big-field" id="amt" inputmode="decimal" placeholder="סכום" value="${esc(amtVal)}">
        <div class="lbl">מאיפה שילמת?</div>${acctChips('from', R.from, allAcctIds())}
        <p class="muted small" id="after" style="margin:6px 2px 0">${balAfter(R.from, -(parseFloat(amtVal) || 0))}</p>
        <div class="lbl">מתי?</div>${whenSeg(R.ts)}
        <div class="sp"></div><button class="btn sage block" id="ok">שילמתי</button>`;
      const amt = box.querySelector('#amt');
      amt.addEventListener('input', () => { amtVal = amt.value; box.querySelector('#after').textContent = balAfter(R.from, -(parseFloat(amtVal) || 0)); });
      box.querySelectorAll('[data-pick="from"] [data-id]').forEach(b => b.onclick = () => { R.from = b.dataset.id; draw(); });
      bindWhen(box, t => { R.ts = t; draw(); });
      box.querySelector('#ok').onclick = () => {
        const v = Math.min(Math.round((parseFloat(amtVal) || 0) * 100) / 100, debtLeft(debtId)); if (!(v > 0)) { amt.focus(); return; }
        S.moves.push({ id: uid(), ts: R.ts, kind: 'debt', debtId, amount: v, from: R.from });
        d.payFrom = R.from;
        save(); closeSheet(); render();
        toast(debtLeft(debtId) <= 0 ? `סגרת את החוב ל${d.name}` : `נרשם · נשארו ל${d.name} ${plain(debtLeft(debtId))}`);
      };
    };
    draw();
  });
}
function openDebt(debtId) {
  const d = debt(debtId); if (!d) return;
  const s = debtSchedule(d), pays = debtPays(debtId).sort((a, b) => b.ts - a.ts);
  openSheet(`<h2>${esc(d.name)}</h2>
    <div class="card" style="text-align:center"><div class="muted small">נשארו</div><div class="big-num" style="font-size:36px">${money(debtLeft(debtId))}</div><div class="muted small">${s.end ? `התשלום האחרון ב${monthName(s.end)}` : 'בלי מועד סיום: אין תשלום חודשי קבוע'}</div></div>
    ${s.rows.length ? `<div class="card"><h3>לוח תשלומים</h3><div class="sched muted small"><span>חודש</span><span>תשלום</span><span>נשאר אחריו</span></div>${s.rows.map(r => `<div class="sched"><span>${monthName(r.M)}</span><b>${money(r.due)}</b><span class="muted">${money(r.left)}</span></div>`).join('')}</div>` : ''}
    ${pays.length ? `<div class="card"><h3>מה ששילמת</h3><ul class="list">${pays.map(p => moveLi({ ts: p.ts, t: `מ${acctName(p.from)}`, a: p.amount, sign: '', moveId: p.id })).join('')}</ul></div>` : ''}
    <button class="btn block" data-act="pay-debt" data-v="${debtId}">רישום תשלום</button>`);
  UI.ctx = ['debt', debtId];
}

/* ----- someone paid you back ----- */
function openReimb(onlyId) {
  const pend = pendingReimb().filter(x => !onlyId || x.id === onlyId);
  if (!pend.length) { toast('אין כרגע הוצאות שמחכות להחזר'); return; }
  const R = { picked: new Set(pend.map(x => x.id)), to: 'pay', ts: Date.now(), amtTouched: false };
  openSheet(`<h2>החזירו לי</h2><div id="rb"></div>`, sh => {
    const box = sh.querySelector('#rb');
    let amtVal = '';
    const pickedSum = () => sum(pend.filter(x => R.picked.has(x.id)), x => x.amount);
    const draw = () => {
      if (!R.amtTouched) amtVal = pickedSum() ? String(Math.round(pickedSum() * 100) / 100) : '';
      box.innerHTML = `${pend.length > 1 ? `<div class="card" style="padding:4px 14px">${pend.map(x => `<button class="check ${R.picked.has(x.id) ? 'done' : ''}" data-p="${x.id}"><span class="box">${R.picked.has(x.id) ? I.check : ''}</span><span class="main"><div class="n" style="text-decoration:none;color:var(--ink)">${esc(x.desc || cat(x.cat).name)}</div><div class="s">${dayLabel(x.ts)}</div></span><span class="amt">${money(x.amount)}</span></button>`).join('')}</div>`
          : `<p class="muted" style="margin-top:-6px">${esc(pend[0].desc || cat(pend[0].cat).name)} · ${dayLabel(pend[0].ts)} · ${money(pend[0].amount)}</p>`}
        <div class="lbl">כמה החזירו?</div><input class="field big-field" id="amt" inputmode="decimal" value="${esc(amtVal)}">
        <div class="lbl">איך החזירו?</div>${acctChips('to', R.to, WALLETS.map(w => w.id), [['pay', 'בתלוש']])}
        <p class="muted small" style="margin:6px 2px 0">${R.to === 'pay' ? 'בתוך המשכורת, למשל קופה קטנה. אף ארנק לא משתנה, כי זה כבר נכנס עם המשכורת.' : balAfter(R.to, parseFloat(amtVal) || 0)}</p>
        <div class="lbl">מתי?</div>${whenSeg(R.ts)}
        <div class="sp"></div><button class="btn sage block" id="ok">שמירה</button>`;
      const amt = box.querySelector('#amt');
      amt.addEventListener('input', () => { amtVal = amt.value; R.amtTouched = true; });
      box.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const id = b.dataset.p; R.picked.has(id) ? R.picked.delete(id) : R.picked.add(id); draw(); });
      box.querySelectorAll('[data-pick="to"] [data-id]').forEach(b => b.onclick = () => { R.to = b.dataset.id; draw(); });
      bindWhen(box, t => { R.ts = t; draw(); });
      box.querySelector('#ok').onclick = () => {
        const v = Math.round((parseFloat(amtVal) || 0) * 100) / 100;
        const picked = pend.filter(x => R.picked.has(x.id));
        if (!picked.length) { toast('לסמן על איזו הוצאה זה'); return; }
        if (!(v >= 0)) { amt.focus(); return; }
        // each expense gets its own amount back; any difference sits on the last one
        let left = v;
        picked.forEach((x, i) => { const a = i === picked.length - 1 ? left : Math.min(x.amount, left); left -= a; x.back = { ts: R.ts, to: R.to, amount: Math.round(a * 100) / 100 }; x.m = Date.now(); markExp(x.id); });
        save(); closeSheet(); render(); toast(R.to === 'pay' ? 'נסגר' : `נרשם · ${balAfter(R.to, 0)}`);
      };
    };
    draw();
  });
}

/* ---------------- notifications ---------------- */

const NOTIFY_URL = () => S.cloud && `${S.cloud.url}/functions/v1/mf-notify`;
const NOTIFY_TYPES = [
  ['due', 'תשלום חוב: ערב לפני, ובבוקר של היום עצמו'],
  ['evening', 'בערב, אם לא נרשם כלום באותו יום'],
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
  const stt = notifyState(), on = Object.assign({ due: true, evening: true }, S.settings.notify || {});
  let body;
  if (stt === 'install') body = `<p class="muted small" style="margin-top:0">התראות עובדות רק כשהאפליקציה פתוחה מהאייקון במסך הבית, ובאייפון עם iOS 16.4 ומעלה.</p>`;
  else if (stt === 'unsupported') body = `<p class="muted small" style="margin-top:0">המכשיר הזה לא תומך בהתראות. צריך לעדכן את האייפון ל-iOS 16.4 ומעלה.</p>`;
  else if (stt === 'denied') body = `<p class="muted small" style="margin-top:0">ההתראות חסומות. כדי לפתוח: הגדרות האייפון, התראות, "הכסף שלי", ולהפעיל.</p>`;
  else if (stt !== 'granted' || !S.pushOn) body = `<p class="muted small" style="margin-top:0">תזכורת לפני תשלום חוב, ותזכורת ערב אם לא רשמת כלום.</p><button class="btn block" data-act="push-on">הפעלת התראות</button>`;
  else body = `${NOTIFY_TYPES.map(([k, label]) => `<button class="check ${on[k] ? 'done' : ''}" data-act="notify-toggle" data-v="${k}"><span class="box">${on[k] ? I.check : ''}</span><span class="main"><div class="n" style="text-decoration:none;color:var(--ink)">${label}</div></span></button>`).join('')}
    <div class="sp"></div><button class="btn ghost sm" data-act="push-test">שליחת התראת בדיקה</button>`;
  return `<div class="card">${body}</div>`;
}

/* ---------------- backup ---------------- */
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
    const doIt = txt => { try { const o = JSON.parse(txt); if (!o.settings) throw 0; S = Object.assign(fresh(), { migr: {} }, o); migrate(); save(); closeSheet(); UI.tab = 'today'; render(); toast('שוחזר'); } catch (e) { toast('הקובץ לא נראה כמו גיבוי'); } };
    sh.querySelector('#ok').onclick = async () => { const f = sh.querySelector('#f').files[0]; doIt(f ? await f.text() : sh.querySelector('#t').value); };
  });
}

/* Setup / connection code: "MF1." + base64url(JSON {cloud}) */
function decodeSetup(code) {
  code = code.trim().replace(/\s+/g, '');
  if (!code.startsWith('MF1.')) throw new Error('bad');
  const b64 = code.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const json = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  return JSON.parse(json);
}
function applySetup(o) {
  S.setup = true; save();
  if (o.cloud) return connectCloud(o.cloud);
}

/* Settings edits: data-set="path.to.value" */
function setPath(path, raw) {
  const parts = path.split('.'); let o = S.settings;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  const k = parts[parts.length - 1];
  o[k] = ['total', 'monthly', 'day', 'target'].includes(k) ? (parseFloat(raw) || 0) : raw;
  save();
}

/* ---------------- events ---------------- */

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act, v = b.dataset.v;
  switch (act) {
    case 'tab': UI.tab = v; if (v === 'settings') UI.setSec = null; if (v === 'month') UI.monthOffset = 0; if (v === 'history') UI.histCat = null; render(); window.scrollTo(0, 0); break;
    case 'add': openAdd(); break;
    case 'add-from': openAdd(); D.method = methodOf(v); D.methodTouched = true; renderAdd(); break;
    case 'tile': openAdd(); D.cat = v; D.catTouched = true; renderAdd(); break;
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
    case 'reimb-toggle': D.reimb = !D.reimb; if (!D.reimb) delete D.back; renderAdd(); break;
    case 'unback': delete D.back; renderAdd(); break;
    case 'return-one': { const id = D.id; saveExpense(); openReimb(id); break; }
    case 'save-exp': saveExpense(); break;
    case 'del-exp': deleteExpense(D.id); save(); closeSheet(); render(); toast('נמחק'); break;
    case 'hist-cat': UI.histCat = v || null; render(); break;
    case 'cat-hist': UI.tab = 'history'; UI.histCat = v; render(); window.scrollTo(0, 0); break;
    case 'month-nav': UI.monthOffset = Math.min(0, UI.monthOffset + parseInt(v, 10)); render(); break;
    case 'income': openIncome(v); break;
    case 'transfer': openTransfer(v); break;
    case 'acct': openAccount(v); break;
    case 'count': openCount(v); break;
    case 'del-move': { const ctx = UI.ctx; deleteMove(b.dataset.id); save(); render(); if (ctx) (ctx[0] === 'debt' ? openDebt : openAccount)(ctx[1]); toast('נמחק'); break; }
    case 'saving-edit': openSavingEdit(v); break;
    case 'reimb': openReimb(); break;
    case 'pay-debt': openPayDebt(v); break;
    case 'debt': openDebt(v); break;
    case 'backup': backup(); break;
    case 'restore': restore(); break;
    case 'reset': openSheet(`<h2>למחוק הכל?</h2><p class="muted">כל ההוצאות, הארנקים וההגדרות יימחקו מהמכשיר. אי אפשר לבטל.</p><button class="btn danger block" data-act="reset-yes">כן, למחוק</button>`); break;
    case 'reset-yes': S = fresh(); save(); closeSheet(); render(); break;
    case 'set-sec': UI.setSec = v || null; render(); window.scrollTo(0, 0); break;
    case 'add-row': {
      const arr = S.settings[v];
      if (v === 'debts') arr.push({ id: uid(), name: '', total: 0, monthly: 0, day: 10 });
      if (v === 'categories') arr.push({ id: uid(), name: '', color: ['#c2703d', '#6f9169', '#8a5bb0', '#4f7ca8', '#c24f6b', '#1fa0c9', '#b08a2e'][arr.length % 7] });
      save(); render(); break;
    }
    case 'del-row': {
      const [k, i] = v.split('.'), it = S.settings[k][+i];
      if (k === 'categories' && S.expenses.some(x => x.cat === it.id)) { toast('יש בה הוצאות. אפשר לשנות לה שם'); break; }
      if (k === 'debts' && debtPays(it.id).length) { toast('יש לחוב תשלומים רשומים, אז הוא נשאר'); break; }
      if (it.name && !confirm(`למחוק את "${it.name}"?`)) break;
      S.settings[k].splice(+i, 1); save(); render(); break;
    }
    case 'wolt-reset': S.settings.woltReset = !S.settings.woltReset; save(); render(); break;
    case 'setup-code': { try { const pr = applySetup(decodeSetup(document.getElementById('setup-code').value)); render(); if (pr) pr.then(() => { render(); toast('מחובר לענן'); }).catch(() => { render(); toast('לא הצלחתי להתחבר לענן. ננסה שוב אחר כך'); }); } catch (err) { toast('הקוד לא תקין. נסה להדביק שוב'); } break; }
    case 'setup-blank': S.setup = true; save(); render(); break;
    case 'cloud-code': {
      let o; try { o = decodeSetup(document.getElementById('cloud-code').value); } catch (err) { toast('הקוד לא תקין'); break; }
      if (!o.cloud) { toast('בקוד הזה אין פרטי ענן'); break; }
      toast('מתחבר…');
      connectCloud(o.cloud).then(() => { UI.setSec = null; render(); toast(S.sync.lastErr ? 'החיבור נכשל: ' + S.sync.lastErr : 'מחובר. הנתונים עלו לענן'); }).catch(() => { S.cloud = null; persist(); render(); toast('החיבור נכשל'); });
      break;
    }
    case 'sync-now': sync().then(() => { render(); toast(S.sync.lastErr ? 'לא הצליח: ' + S.sync.lastErr : 'מסונכרן'); }); break;
    case 'disconnect': UI.setSec = null; S.cloud = null; S.sync = freshSync(); persist(); render(); toast('נותק מהענן'); break;
    case 'copy-script': {
      if (!SCRIPT_TPL) { toast('רגע, טוען…'); loadScriptTpl(); break; }
      const code = SCRIPT_TPL.replace('__URL__', S.cloud.url).replace('__ANON__', S.cloud.anon).replace('__KEY__', S.cloud.key);
      navigator.clipboard.writeText(code).then(() => toast('הקוד הועתק. עכשיו לפתוח את Scriptable'), () => openSheet(`<h2>קוד לווידג'ט</h2><p class="muted">סמן הכל והעתק:</p><textarea class="field" style="min-height:260px">${esc(code)}</textarea>`));
      break;
    }
    case 'push-on': enableNotifications(); break;
    case 'push-test': testNotification(); break;
    case 'notify-toggle': { S.settings.notify = Object.assign({ due: true, evening: true }, S.settings.notify || {}); S.settings.notify[v] = !S.settings.notify[v]; save(); render(); break; }
    case 'ap-ok': unsortedApplePay().forEach(x => { seenApplePay(x); learnFrom(x); }); save(); render(); toast('מעולה. מהפעם הבאה זה לבד'); break;
  }
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-set]'); if (el) { setPath(el.dataset.set, el.value); return; }
  if (e.target.id === 'wolt-credit') {
    // a new amount counts from next month; earlier months keep what they had
    const st = S.settings, v = parseFloat(e.target.value) || 0, from = monthStart(Date.now(), 1);
    st.woltCredits = (st.woltCredits || []).filter(c => c.from < from);
    if (!st.woltCredits.length) st.woltCredits.push({ from: 0, amount: st.woltCredit || 0 });
    st.woltCredits.push({ from, amount: v }); st.woltCredit = v;
    save(); toast(`מ${monthOnly(from)}: ${plain(v)} בחודש`);
  }
});

let toastTimer;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2400); }

/* ---------------- migration from the budget version (2026-10-06) ---------------- */
// Weekly budget, plan, salary split, bills and monthly cash income are gone. Wallets have balances,
// savings are a list, debt payments are moves, and "יחזירו לי" is a mark on the expense instead of a category.
function migrate() {
  S.migr = S.migr || {};
  if (S.migr.simple || !S.setup) return;
  const st = S.settings, old = S, now = Date.now();
  S.moves = S.moves || []; S.apSeen = S.apSeen || {}; S.inboxDone = S.inboxDone || {};
  for (const p of old.debtPays || []) S.moves.push({ id: p.id, ts: p.ts, kind: 'debt', debtId: p.debtId, amount: p.amount, from: p.from === 'cash' ? 'cash' : 'bank' });
  const oldSav = sum(old.savings || [], x => x.amount) - sum((old.expenses || []).filter(x => x.cat === 'fromsav'), x => x.amount);
  const oldInv = sum(old.invest || [], x => x.amount);
  st.savings = clone(DEFAULT_SETTINGS.savings);
  if (st.emergencyGoal) st.savings[0].target = st.emergencyGoal;
  if (Math.round(oldSav)) S.moves.push({ id: uid(), ts: now, kind: 'count', to: 'emergency', amount: oldSav });
  if (Math.round(oldInv)) S.moves.push({ id: uid(), ts: now, kind: 'count', to: 'invest', amount: oldInv });
  const back = {};
  for (const r of old.receipts || []) for (const id of r.for || []) back[id] = { ts: r.ts, to: r.to === 'cash' ? 'cash' : 'bank' };
  for (const x of S.expenses) {
    let touched = false;
    if (x.cat === 'reimb') { x.reimb = true; x.cat = /דלק|paz|פז|סונול|sonol|delek|דור אלון|ten/i.test(x.desc) ? 'transport' : 'misc'; if (back[x.id]) x.back = { ...back[x.id], amount: x.amount }; touched = true; }
    if (x.cat === 'fromsav') { x.cat = 'home'; touched = true; }
    if (touched) { x.m = now; markExp(x.id); }
  }
  const keep = st.categories.filter(c => !['reimb', 'fromsav'].includes(c.id)).map(c => ({ id: c.id, name: c.id === 'home' ? 'חד פעמי' : c.name, color: c.color }));
  for (const c of DEFAULT_SETTINGS.categories) if (!keep.some(k => k.id === c.id)) keep.splice(Math.max(0, keep.findIndex(k => k.id === 'misc')), 0, clone(c));
  st.categories = keep;
  st.woltCredits = [{ from: 0, amount: st.woltCredit || 0 }];
  st.woltReset = !!st.woltReset;
  st.notify = { due: (st.notify || {}).due !== false, evening: (st.notify || {}).evening !== false };
  for (const d of st.debts) { delete d.noExtra; if (d.payFrom === 'home') d.payFrom = 'bank'; }
  for (const k of ['income', 'envelopes', 'bills', 'cashIncome', 'priority', 'emergencyGoal', 'commissionShareAfterDebts', 'weekOverrides', 'startMonth', 'salaryDay', 'bankName', 'savingsGoal']) delete st[k];
  for (const k of ['debtPays', 'savings', 'invest', 'incomes', 'topups', 'checks', 'cash', 'bank', 'receipts']) delete S[k];
  S.v = 2; S.migr = { simple: true };
  save();
}

/* ---------------- boot ---------------- */

// Preview hooks: #tab=month, #add, #seed, #setup=CODE, #now=2026-10-06 (testing only)
function applyHash() {
  const h = location.hash.slice(1);
  const nw = h.match(/now=([\d-]+)/); if (nw) { const fake = new Date(nw[1] + 'T13:00:00').getTime(); Date.now = () => fake + (performance.now() | 0); }
  const sc = h.match(/setup=(MF1\.[\w-]+)/); if (sc && !S.setup) { try { applySetup(decodeSetup(sc[1])); } catch (e) {} }
  if (h.includes('seed') && !S.setup) seed();
  const m = h.match(/tab=(\w+)/); if (m) UI.tab = m[1];
  render();
  if (h.includes('add')) openAdd();
}
window.addEventListener('hashchange', () => { const h = location.hash; if (h.includes('add')) openAdd(); else { const m = h.match(/tab=(\w+)/); if (m) { UI.tab = m[1]; render(); } } });
function seed() {
  S = fresh(); S.setup = true;
  const d = n => Date.now() - n * DAY;
  S.settings.woltCredit = 800; S.settings.woltCredits = [{ from: 0, amount: 800 }];
  S.settings.debts = [{ id: 'a', name: 'חוב לדוגמה', total: 6000, monthly: 1000, day: 10 }, { id: 'b', name: 'חוב שני', total: 3000, monthly: 500, day: 15, from: monthStart(Date.now(), 1) }];
  S.moves.push({ id: uid(), ts: d(20), kind: 'count', to: 'bank', amount: 4000 }, { id: uid(), ts: d(20), kind: 'count', to: 'cash', amount: 300 }, { id: uid(), ts: d(40), kind: 'count', to: 'wolt', amount: 500 },
    { id: uid(), ts: d(3), kind: 'in', to: 'bank', amount: 12000, src: 'salary', note: '' }, { id: uid(), ts: d(2), kind: 'move', from: 'bank', to: 'emergency', amount: 1500 });
  [['פלאפל', 38, 'food', 0, 'cash'], ['סופר', 214, 'super', 1, 'card'], ['בירה עם החבר׳ה', 180, 'fun', 2, 'card'], ['דלק', 280, 'transport', 2, 'card', true], ['שווארמה', 62, 'food', 3, 'wolt'], ['תספורת', 100, 'care', 4, 'card']].forEach(([desc, amount, c, n, method, reimb]) => { const x = { id: uid(), ts: d(n), desc, amount, cat: c, method }; if (reimb) x.reimb = true; S.expenses.push(x); learnFrom(x); });
  save();
}
migrate();
applyHash();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
let SCRIPT_TPL = null;
function loadScriptTpl() { fetch('scriptable.js').then(r => r.ok ? r.text() : null).then(t => { if (t) SCRIPT_TPL = t; }).catch(() => {}); }
if (S.cloud) { loadScriptTpl(); scheduleSync(300); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (!UI.sheet) render(); scheduleSync(200); } });
window.addEventListener('online', () => scheduleSync(200));
