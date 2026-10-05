// הכסף שלי — ווידג'ט ורישום מהיר (Scriptable)
// ------------------------------------------------------------
// בווידג'ט: כמה הוצאת החודש וכמה יש בכל ארנק. לחיצה על קטגוריה פותחת רישום מהיר.
// כשמריצים את הסקריפט עצמו: שואל קטגוריה, סכום, ושומר.
// מאוטומציית אפל פיי (קיצורים): מקבל סכום ושם בית עסק, ורושם לבד.
// אל תשתף את הקובץ הזה: יש בו את המפתח הסודי שלך.

const CLOUD = { url: '__URL__', anon: '__ANON__', key: '__KEY__' };

const C = {
  bg: new Color('#2d1f3f'), text: new Color('#f6f1fa'),
  muted: new Color('#c9bdd6'), sage: new Color('#a9c9a2'),
};
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), 'hakesef-cache.json');

async function rpc(fn, body = {}) {
  const r = new Request(`${CLOUD.url}/rest/v1/rpc/${fn}`);
  r.method = 'POST';
  r.timeoutInterval = 12;
  r.headers = { apikey: CLOUD.anon, Authorization: `Bearer ${CLOUD.anon}`, 'Content-Type': 'application/json' };
  r.body = JSON.stringify(Object.assign({ p_key: CLOUD.key }, body));
  const res = await r.loadJSON();
  if (res && res.code && res.message) throw new Error(res.message);
  return res;
}

async function getData() {
  try {
    const d = await rpc('mf_widget');
    fm.writeString(cachePath, JSON.stringify(d));
    return d;
  } catch (e) {
    if (fm.fileExists(cachePath)) { const d = JSON.parse(fm.readString(cachePath)); d.stale = true; return d; }
    throw e;
  }
}

const fmt = n => `${Math.round(n).toLocaleString('he-IL')} ₪`;

// On a Hebrew iPhone, widget stacks lay out right-to-left: the first item added sits on the right.
const RTL = /^he|^iw/.test(Device.language() || '') || /^he|^iw/.test(Device.locale() || '');

function line(stack, align, addContent) {
  const row = stack.addStack(); row.layoutHorizontally();
  if (align === 'center') { row.addSpacer(); addContent(row); row.addSpacer(); }
  else if ((align === 'right') !== RTL) { row.addSpacer(); addContent(row); }
  else { addContent(row); row.addSpacer(); }
}
function text(stack, str, font, color, align = 'right') {
  line(stack, align, row => { const t = row.addText(str); t.font = font; t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6; });
}
const rightText = (stack, str, font, color) => text(stack, str, font, color, 'right');
const wallet = (d, id) => (d.wallets || []).find(w => w.id === id) || {};
const walletLine = (d, ids) => ids.map(id => wallet(d, id)).filter(w => w.bal != null).map(w => `${w.name} ${fmt(w.bal)}`).join(' · ');

// What you spent this month, and what's in the wallets.
function heroBlock(stack, d, align = 'right') {
  text(stack, 'הוצאת החודש', Font.mediumSystemFont(13), C.muted, align);
  stack.addSpacer(2);
  text(stack, fmt(d.month_spent), Font.heavySystemFont(30), C.text, align);
  stack.addSpacer(6);
  if (d.today_spent > 0) text(stack, `היום ${fmt(d.today_spent)}`, Font.systemFont(11), C.muted, align);
  stack.addSpacer(4);
  for (const id of ['bank', 'cash', 'wolt']) { const w = wallet(d, id); if (w.bal != null) text(stack, `${w.name}: ${fmt(w.bal)}`, Font.semiboldSystemFont(12), C.sage, align); }
}
// Tiles in reading order (right to left on a Hebrew phone).
function tileRow(parent, cats, size) {
  const l = parent.addStack(); l.layoutHorizontally(); l.spacing = 6;
  (RTL ? cats : cats.slice().reverse()).forEach(c => tile(l, c, size));
}
const TILE_IDS = ['food', 'super', 'fun', 'misc'];

function tile(parent, c, size) {
  const t = parent.addStack();
  t.layoutVertically(); t.size = size; t.cornerRadius = 12; t.setPadding(6, 6, 6, 6);
  t.backgroundColor = new Color(c.color || '#5a4175', 0.9);
  t.url = `${URLScheme.forRunningScript()}?cat=${encodeURIComponent(c.id)}`;
  rightText(t, c.name, Font.semiboldSystemFont(11), C.text);
  t.addSpacer();
  rightText(t, fmt(c.month), Font.boldSystemFont(14), C.text);
}

function buildWidget(d) {
  const fam = config.widgetFamily || 'medium';
  const w = new ListWidget();
  w.url = URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const bank = wallet(d, 'bank').bal;

  if (fam === 'accessoryInline') { w.addText(`החודש ${fmt(d.month_spent)}`); return w; }
  if (fam === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const t = w.addText(`${Math.round(d.month_spent)}`); t.font = Font.boldSystemFont(16); t.centerAlignText(); t.minimumScaleFactor = 0.5;
    const s = w.addText('₪ החודש'); s.font = Font.systemFont(9); s.centerAlignText();
    return w;
  }
  if (fam === 'accessoryRectangular') {
    const a = w.addText('הוצאת החודש'); a.font = Font.systemFont(11);
    const b = w.addText(fmt(d.month_spent)); b.font = Font.boldSystemFont(20);
    if (bank != null) { const c = w.addText(`בבנק ${fmt(bank)}`); c.font = Font.systemFont(11); }
    return w;
  }

  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);

  if (fam === 'small') {
    heroBlock(w, d);
    w.addSpacer();
    rightText(w, 'לחיצה לרישום הוצאה', Font.systemFont(10), C.muted);
    return w;
  }

  if (fam === 'medium') {
    const picked = TILE_IDS.map(id => d.categories.find(c => c.id === id)).filter(Boolean);
    const cats = (picked.length === 4 ? picked : d.categories).slice(0, 4);
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    const addHero = () => { const hero = row.addStack(); hero.layoutVertically(); heroBlock(hero, d); };
    const addGrid = () => { const grid = row.addStack(); grid.layoutVertically(); grid.spacing = 6; tileRow(grid, cats.slice(0, 2), new Size(78, 60)); tileRow(grid, cats.slice(2, 4), new Size(78, 60)); };
    // numbers on the right, tiles on the left
    if (RTL) { addHero(); row.addSpacer(8); addGrid(); } else { addGrid(); row.addSpacer(8); addHero(); }
    return w;
  }

  // large
  heroBlock(w, d);
  w.addSpacer(12);
  const cats = d.categories.slice(0, 8);
  const grid = w.addStack(); grid.layoutVertically(); grid.spacing = 6;
  tileRow(grid, cats.slice(0, 4), new Size(71, 64));
  tileRow(grid, cats.slice(4, 8), new Size(71, 64));
  w.addSpacer();
  const s = d.summary || {};
  if (s.debtLeft > 0) rightText(w, `חובות: נשארו ${fmt(s.debtLeft)}${s.debtFree ? ` · בלי חובות ב${s.debtFree}` : ''}`, Font.systemFont(12), C.muted);
  for (const sv of s.savings || []) if (sv.bal) rightText(w, `${sv.name}: ${fmt(sv.bal)}`, Font.systemFont(12), C.muted);
  return w;
}

async function quickLog(d) {
  const params = args.queryParameters || {};
  const cats = d.categories;
  let cat = cats.find(c => c.id === params.cat);
  if (!cat) {
    const pick = new Alert();
    pick.title = 'הוצאה חדשה';
    pick.message = `הוצאת החודש: ${fmt(d.month_spent)}`;
    cats.forEach(c => pick.addAction(c.name));
    pick.addCancelAction('ביטול');
    const i = await pick.presentSheet();
    if (i < 0) return;
    cat = cats[i];
  }
  const a = new Alert();
  a.title = cat.name;
  a.message = walletLine(d, ['bank', 'cash', 'wolt']);
  const amt = a.addTextField('סכום', ''); amt.setDecimalPadKeyboard();
  a.addTextField('על מה? (לא חובה)', '');
  const bal = id => { const b = wallet(d, id).bal; return b != null ? ` (${fmt(b)})` : ''; };
  a.addAction(`שמירה · כרטיס${bal('bank')}`);
  a.addAction(`שמירה · מזומן${bal('cash')}`);
  a.addAction(`שמירה · וולט${bal('wolt')}`);
  a.addCancelAction('ביטול');
  const choice = await a.presentAlert();
  if (choice < 0) return;
  const method = ['card', 'cash', 'wolt'][choice] || 'card';
  const amount = parseFloat(String(a.textFieldValue(0)).replace(',', '.'));
  if (!(amount > 0)) { const e = new Alert(); e.title = 'לא נרשם'; e.message = 'צריך סכום גדול מאפס.'; e.addAction('אוקיי'); await e.present(); return; }
  const res = await rpc('mf_quick_add', { p_amount: amount, p_cat: cat.id, p_desc: a.textFieldValue(1) || '', p_method: method });
  fm.writeString(cachePath, JSON.stringify(res));
  const left = wallet(res, method === 'card' ? 'bank' : method);
  const ok = new Alert();
  ok.title = `נשמר · ${fmt(amount)}`;
  ok.message = `הוצאת החודש ${fmt(res.month_spent)}${left.bal != null ? `\n${left.name}: ${fmt(left.bal)}` : ''}`;
  ok.addAction('סגור');
  await ok.present();
}

// Apple Pay: the Shortcuts "Transaction" automation passes the amount and merchant
// (a text with the amount on the first line and the merchant after it, or a dictionary).
function parseAmount(v) {
  let t = String(v == null ? '' : v).replace(/[^\d.,]/g, '');
  if (/,\d{1,2}$/.test(t) && !t.includes('.')) t = t.replace(',', '.');
  return parseFloat(t.replace(/,/g, ''));
}
async function applePay(p) {
  let amount, merchant = '', raw = '';
  if (p && typeof p === 'object') { raw = String(p.amount || p.Amount || ''); amount = parseAmount(raw); merchant = String(p.merchant || p.Merchant || ''); }
  else { const lines = String(p).split(/\n/).map(x => x.trim()).filter(Boolean); raw = lines[0] || ''; amount = parseAmount(raw); merchant = lines.slice(1).join(' '); }
  const foreign = /\$|€|£|usd|eur|gbp|thb|฿/i.test(raw);
  const n = new Notification();
  if (!(amount > 0)) { n.title = 'אפל פיי: לא נרשם'; n.body = `לא הצלחתי לקרוא את הסכום (${raw}). כדאי לרשום ידנית.`; await n.schedule(); Script.setShortcutOutput(n.body); return; }
  const res = await rpc('mf_apple_pay', { p_amount: amount, p_merchant: (merchant + (foreign ? ` (${raw})` : '')).trim() });
  fm.writeString(cachePath, JSON.stringify(res));
  n.title = res.dup ? `כבר נרשם · ${fmt(amount)}` : `נרשם · ${fmt(amount)}${merchant ? ` · ${merchant}` : ''}`;
  n.body = foreign ? 'הסכום במטבע זר. כדאי לתקן באפליקציה לסכום בשקלים.'
    : res.known ? `${res.cat_name}${wallet(res, 'bank').bal != null ? ` · בבנק ${fmt(wallet(res, 'bank').bal)}` : ''}`
    : `מקום חדש, נכנס ל"${res.cat_name}". אפשר לתקן באפליקציה.`;
  await n.schedule();
  Script.setShortcutOutput(`${n.title}\n${n.body}`);
}

const fromShortcut = !config.runsInWidget && args.shortcutParameter != null && args.shortcutParameter !== '';
try {
  if (fromShortcut) {
    await applePay(args.shortcutParameter);
  } else {
    const d = await getData();
    if (config.runsInWidget) {
      Script.setWidget(buildWidget(d));
    } else if ((args.queryParameters || {}).preview) {
      await buildWidget(d).presentMedium();
    } else {
      await quickLog(d);
    }
  }
} catch (e) {
  if (config.runsInWidget) {
    const w = new ListWidget(); w.backgroundColor = C.bg;
    const t = w.addText('אין חיבור כרגע'); t.textColor = C.muted; t.font = Font.systemFont(12);
    Script.setWidget(w);
  } else if (fromShortcut) {
    const n = new Notification(); n.title = 'אפל פיי: לא נרשם'; n.body = `אין חיבור כרגע. כדאי לרשום ידנית. (${String(e.message || e).slice(0, 60)})`; await n.schedule();
  } else {
    const a = new Alert(); a.title = 'משהו לא עבד'; a.message = String(e.message || e); a.addAction('סגור'); await a.present();
  }
}
Script.complete();
