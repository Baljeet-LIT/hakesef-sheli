// הכסף שלי — ווידג'ט ורישום מהיר (Scriptable)
// ------------------------------------------------------------
// בווידג'ט: מציג כמה נשאר לך השבוע. לחיצה על קטגוריה פותחת רישום מהיר.
// כשמריצים את הסקריפט עצמו: שואל קטגוריה, סכום, ושומר.
// אל תשתף את הקובץ הזה: יש בו את המפתח הסודי שלך.

const CLOUD = { url: '__URL__', anon: '__ANON__', key: '__KEY__' };

const C = {
  bg: new Color('#2d1f3f'), card: new Color('#3d2a52'), text: new Color('#f6f1fa'),
  muted: new Color('#c9bdd6'), sage: new Color('#a9c9a2'), warn: new Color('#e2a64a'), bad: new Color('#ef7a72'),
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

function bar(w, h, pct, color) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true;
  const bg = new Path(); bg.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(bg); ctx.setFillColor(new Color('#ffffff', 0.18)); ctx.fillPath();
  const fw = Math.max(0, Math.min(1, pct)) * w;
  if (fw > 0) {
    const p = new Path(); p.addRoundedRect(new Rect(w - fw, 0, fw, h), h / 2, h / 2); // fills from the right (RTL)
    ctx.addPath(p); ctx.setFillColor(color); ctx.fillPath();
  }
  return ctx.getImage();
}

function leftColor(d) {
  if (d.week_left < 0) return C.bad;
  const elapsed = (7 - d.days_left) / 7, pace = d.week_of ? d.week_spent / d.week_of : 0;
  return pace > elapsed + 0.15 && d.week_left < d.week_of * 0.5 ? C.warn : C.sage;
}

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

function heroBlock(stack, d, width, align = 'center') {
  text(stack, 'נשאר השבוע', Font.mediumSystemFont(13), C.muted, align);
  stack.addSpacer(2);
  text(stack, fmt(d.week_left), Font.heavySystemFont(32), leftColor(d), align);
  stack.addSpacer(8);
  line(stack, align, row => { const img = row.addImage(bar(width, 7, d.week_of ? d.week_left / d.week_of : 0, leftColor(d))); img.imageSize = new Size(width, 7); });
  stack.addSpacer(8);
  const per = d.week_left > 0 ? `בערך ${fmt(d.week_left / d.days_left)} ליום` : 'מחכים ליום ראשון';
  text(stack, d.days_left <= 1 ? 'יום אחרון לשבוע' : `${d.days_left} ימים · ${per}`, Font.systemFont(11), C.muted, align);
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
  const shown = c.env === 'pocket' ? c.week : c.month;
  rightText(t, fmt(shown), Font.boldSystemFont(14), C.text);
  if (c.week_budget > 0 && c.env === 'pocket') {
    t.addSpacer(3);
    const img = t.addImage(bar(size.width - 12, 4, 1 - c.week / c.week_budget, new Color('#ffffff', 0.9)));
    img.imageSize = new Size(size.width - 12, 4);
  }
}

function buildWidget(d) {
  const fam = config.widgetFamily || 'medium';
  const w = new ListWidget();
  w.url = URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  if (fam === 'accessoryInline') { w.addText(`נשאר ${fmt(d.week_left)} השבוע`); return w; }
  if (fam === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const t = w.addText(`${Math.round(d.week_left)}`); t.font = Font.boldSystemFont(16); t.centerAlignText(); t.minimumScaleFactor = 0.5;
    const s = w.addText('₪ לשבוע'); s.font = Font.systemFont(9); s.centerAlignText();
    return w;
  }
  if (fam === 'accessoryRectangular') {
    const a = w.addText('נשאר השבוע'); a.font = Font.systemFont(11);
    const b = w.addText(fmt(d.week_left)); b.font = Font.boldSystemFont(20);
    const c = w.addText(`${d.days_left} ימים עד ראשון`); c.font = Font.systemFont(11);
    return w;
  }

  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);

  if (fam === 'small') {
    heroBlock(w, d, 125);
    w.addSpacer();
    rightText(w, 'לחיצה לרישום הוצאה', Font.systemFont(10), C.muted);
    return w;
  }

  const pocketCats = d.categories.filter(c => c.env === 'pocket');
  if (fam === 'medium') {
    const picked = TILE_IDS.map(id => d.categories.find(c => c.id === id)).filter(Boolean);
    const cats = (picked.length === 4 ? picked : pocketCats).slice(0, 4);
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    const addHero = () => { const hero = row.addStack(); hero.layoutVertically(); heroBlock(hero, d, 110); };
    const addGrid = () => { const grid = row.addStack(); grid.layoutVertically(); grid.spacing = 6; tileRow(grid, cats.slice(0, 2), new Size(78, 60)); tileRow(grid, cats.slice(2, 4), new Size(78, 60)); };
    // number on the right, tiles on the left
    if (RTL) { addHero(); row.addSpacer(8); addGrid(); } else { addGrid(); row.addSpacer(8); addHero(); }
    return w;
  }

  // large
  heroBlock(w, d, 300);
  w.addSpacer(12);
  const cats = [...pocketCats, ...d.categories.filter(c => c.env !== 'pocket' && c.env !== 'none')].slice(0, 8);
  const grid = w.addStack(); grid.layoutVertically(); grid.spacing = 6;
  tileRow(grid, cats.slice(0, 4), new Size(71, 64));
  tileRow(grid, cats.slice(4, 8), new Size(71, 64));
  w.addSpacer();
  const s = d.summary || {};
  if (s.debtLeft > 0) rightText(w, `חובות: נשארו ${fmt(s.debtLeft)}${s.debtFree ? ` · בלי חובות ב${s.debtFree}` : ''}`, Font.systemFont(12), C.muted);
  else if (s.invest != null) rightText(w, `בתיק ההשקעות: ${fmt(s.invest)}`, Font.systemFont(12), C.muted);
  else if (s.savings != null) rightText(w, `בקופה בצד: ${fmt(s.savings)}`, Font.systemFont(12), C.muted);
  if (d.cash != null) rightText(w, `בארנק: ${fmt(d.cash)}`, Font.systemFont(12), C.muted);
  (d.monthly || []).forEach(m => rightText(w, `${m.name} החודש: נשארו ${fmt(m.left)}`, Font.systemFont(12), C.muted));
  return w;
}

async function quickLog(d) {
  const params = args.queryParameters || {};
  const cats = d.categories.filter(c => c.env !== 'none').concat(d.categories.filter(c => c.env === 'none'));
  let cat = cats.find(c => c.id === params.cat);
  if (!cat) {
    const pick = new Alert();
    pick.title = 'הוצאה חדשה';
    pick.message = `נשאר השבוע: ${fmt(d.week_left)}`;
    cats.forEach(c => pick.addAction(c.name));
    pick.addCancelAction('ביטול');
    const i = await pick.presentSheet();
    if (i < 0) return;
    cat = cats[i];
  }
  const a = new Alert();
  a.title = cat.name;
  a.message = `נשאר השבוע: ${fmt(d.week_left)}`;
  const amt = a.addTextField('סכום', ''); amt.setDecimalPadKeyboard();
  a.addTextField('על מה? (לא חובה)', '');
  a.addAction('שמירה · כרטיס');
  a.addAction(`שמירה · מזומן${d.cash != null ? ` (בארנק ${fmt(d.cash)})` : ''}`);
  if (d.wolt_of > 0) a.addAction(`שמירה · וולט (קרדיט ${fmt(Math.max(0, d.wolt_left))})`);
  a.addCancelAction('ביטול');
  const choice = await a.presentAlert();
  if (choice < 0) return;
  const method = ['card', 'cash', 'wolt'][choice] || 'card';
  const amount = parseFloat(String(a.textFieldValue(0)).replace(',', '.'));
  if (!(amount > 0)) { const e = new Alert(); e.title = 'לא נרשם'; e.message = 'צריך סכום גדול מאפס.'; e.addAction('אוקיי'); await e.present(); return; }
  const res = await rpc('mf_quick_add', { p_amount: amount, p_cat: cat.id, p_desc: a.textFieldValue(1) || '', p_method: method });
  fm.writeString(cachePath, JSON.stringify(res));
  const ok = new Alert();
  ok.title = `נשמר · ${fmt(amount)}`;
  ok.message = `נשאר לך השבוע ${fmt(res.week_left)}${method === 'cash' && res.cash != null ? `\nבארנק: ${fmt(res.cash)}` : ''}`;
  ok.addAction('סגור');
  await ok.present();
}

try {
  const d = await getData();
  if (config.runsInWidget) {
    Script.setWidget(buildWidget(d));
  } else if ((args.queryParameters || {}).preview) {
    await buildWidget(d).presentMedium();
  } else {
    await quickLog(d);
  }
} catch (e) {
  if (config.runsInWidget) {
    const w = new ListWidget(); w.backgroundColor = C.bg;
    const t = w.addText('אין חיבור כרגע'); t.textColor = C.muted; t.font = Font.systemFont(12);
    Script.setWidget(w);
  } else {
    const a = new Alert(); a.title = 'משהו לא עבד'; a.message = String(e.message || e); a.addAction('סגור'); await a.present();
  }
}
Script.complete();
