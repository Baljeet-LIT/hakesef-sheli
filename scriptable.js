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

function rightText(stack, str, font, color) {
  const row = stack.addStack(); row.layoutHorizontally(); row.addSpacer();
  const t = row.addText(str); t.font = font; t.textColor = color; t.rightAlignText(); t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}

function heroBlock(stack, d, width) {
  rightText(stack, 'נשאר השבוע', Font.mediumSystemFont(12), C.muted);
  stack.addSpacer(2);
  rightText(stack, fmt(d.week_left), Font.heavySystemFont(30), leftColor(d));
  stack.addSpacer(6);
  const img = stack.addImage(bar(width, 7, d.week_of ? d.week_left / d.week_of : 0, leftColor(d)));
  img.imageSize = new Size(width, 7);
  stack.addSpacer(6);
  const per = d.week_left > 0 ? `בערך ${fmt(d.week_left / d.days_left)} ליום` : 'מחכים ליום ראשון';
  rightText(stack, d.days_left <= 1 ? 'יום אחרון לשבוע' : `${d.days_left} ימים · ${per}`, Font.systemFont(11), C.muted);
}

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
    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    // RTL: tiles on the left, number on the right
    const grid = row.addStack(); grid.layoutVertically(); grid.spacing = 6;
    const cats = pocketCats.slice(0, 4);
    for (let r = 0; r < 2; r++) {
      const line = grid.addStack(); line.layoutHorizontally(); line.spacing = 6;
      cats.slice(r * 2, r * 2 + 2).reverse().forEach(c => tile(line, c, new Size(78, 60)));
    }
    row.addSpacer(12);
    const hero = row.addStack(); hero.layoutVertically();
    heroBlock(hero, d, 118);
    return w;
  }

  // large
  heroBlock(w, d, 300);
  w.addSpacer(12);
  const cats = [...pocketCats, ...d.categories.filter(c => c.env !== 'pocket' && c.env !== 'none')].slice(0, 8);
  const grid = w.addStack(); grid.layoutVertically(); grid.spacing = 6;
  for (let r = 0; r < 2; r++) {
    const line = grid.addStack(); line.layoutHorizontally(); line.spacing = 6;
    cats.slice(r * 4, r * 4 + 4).reverse().forEach(c => tile(line, c, new Size(71, 64)));
  }
  w.addSpacer();
  const s = d.summary || {};
  if (s.debtLeft > 0) rightText(w, `חובות: נשארו ${fmt(s.debtLeft)}${s.debtFree ? ` · בלי חובות ב${s.debtFree}` : ''}`, Font.systemFont(12), C.muted);
  else if (s.savings != null) rightText(w, `בקופה בצד: ${fmt(s.savings)}`, Font.systemFont(12), C.muted);
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
  a.addAction('שמירה');
  a.addCancelAction('ביטול');
  if (await a.presentAlert() < 0) return;
  const amount = parseFloat(String(a.textFieldValue(0)).replace(',', '.'));
  if (!(amount > 0)) { const e = new Alert(); e.title = 'לא נרשם'; e.message = 'צריך סכום גדול מאפס.'; e.addAction('אוקיי'); await e.present(); return; }
  const res = await rpc('mf_quick_add', { p_amount: amount, p_cat: cat.id, p_desc: a.textFieldValue(1) || '' });
  fm.writeString(cachePath, JSON.stringify(res));
  const ok = new Alert();
  ok.title = `נשמר · ${fmt(amount)}`;
  ok.message = `נשאר לך השבוע ${fmt(res.week_left)}`;
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
