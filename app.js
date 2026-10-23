import { createStore, isOnline } from "./store.js";

// Squad shape for each training: 18 open field slots + 2 goalkeepers + 3 slots the admin fills from the reserves = 23.
const OPEN = 18, GK = 2, HELD = 3, MAIN = OPEN + GK + HELD, BATCH = 5, MIN_MATCHES = 3;
const SIZES = [8, 9], DEFAULT_SIZE = 8; // players per team on the pitch, goalkeeper included
const REMIND_HOURS = 4;
const $ = s => document.querySelector(s);
const root = $("#root");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kora:" + s.trim()));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("show"); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove("show"), 2400); }
const cleanName = v => v.trim().replace(/\s+/g, " ");

// ---------- dates ----------
const parseDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmt = (s, o) => parseDate(s).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", o);
const longDate = s => fmt(s, { weekday: "long", day: "numeric", month: "long" });
const t12 = v => { let [h, m] = v.split(":").map(Number); const pm = h >= 12; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${pm ? "مساءً" : "صباحاً"}`; };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => ymd(new Date());
const daysTo = s => Math.round((parseDate(s) - parseDate(todayStr())) / 864e5);
const sortKey = t => t.date + " " + t.time;
const startOf = t => { const d = parseDate(t.date); const [h, m] = t.time.split(":").map(Number); d.setHours(h, m); return d; };
const hoursTo = t => (startOf(t) - Date.now()) / 36e5;
const icsStamp = d => `${ymd(d).replace(/-/g, "")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;

// ---------- state ----------
const D = { trainings: [], settings: undefined };
const U = {
  tab: ["reg", "line", "stats", "titles", "more"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "reg",
  viewId: null, role: "p", sel: null, draftTeams: null, draftFor: null, draftResult: null,
  sortK: "pts", newOpen: false, h2h: ["", ""], confirmDel: false, me: ls.get("kora.me") || "", addRole: "p",
};
let store;
const unlocked = () => D.settings && ls.get("kora.group") === D.settings.groupHash;
const isAdmin = () => D.settings && ls.get("kora.admin") === D.settings.adminHash;
const roster = () => (D.settings && D.settings.roster) || [];

function sorted() { return [...D.trainings].sort((a, b) => sortKey(b).localeCompare(sortKey(a))); }
function current() {
  const list = sorted();
  if (U.viewId) { const t = list.find(x => x.id === U.viewId); if (t) return t; }
  const upcoming = list.filter(t => t.date >= todayStr());
  return upcoming.length ? upcoming[upcoming.length - 1] : list[0];
}
const openIn = t => t.players.filter(p => p.status === "in" && p.role === "p");
const gkIn = t => t.players.filter(p => p.status === "in" && p.role === "gk");
const held = t => t.players.filter(p => p.status === "held");
const reserves = t => t.players.filter(p => p.status === "wait");
const mainSquad = t => t.players.filter(p => p.status === "in" || p.status === "held");
const roleOf = (t, n) => (t.players.find(p => p.name === n) || {}).role;

function promote(t) {
  for (const [role, cap] of [["p", OPEN], ["gk", GK]]) {
    while (t.players.filter(p => p.status === "in" && p.role === role).length < cap) {
      const w = t.players.find(p => p.status === "wait" && p.role === role);
      if (!w) break;
      w.status = "in";
    }
  }
}
function place(t, name, role) {
  if (t.players.some(p => p.name === name)) throw new Error(`${name} مسجّل من قبل`);
  const cap = role === "gk" ? GK : OPEN;
  const full = t.players.filter(p => p.status === "in" && p.role === role).length >= cap;
  t.players.push({ name, role, status: full ? "wait" : "in", at: Date.now() });
  return full;
}

// ---------- stats ----------
function computeStats() {
  const S = {};
  const get = n => S[n] ||= { n, m: 0, w: 0, d: 0, l: 0, g: 0, mvp: 0, att: 0, form: [] };
  roster().forEach(r => get(r.name));
  const list = [...D.trainings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (const t of list) {
    mainSquad(t).forEach(p => get(p.name).att++);
    if (!t.result || !t.teams) continue;
    const { a, b, scorers = {} } = t.result;
    for (const [side, names] of [["A", t.teams.A], ["B", t.teams.B]]) {
      const mine = side === "A" ? a : b, theirs = side === "A" ? b : a;
      const r = mine > theirs ? "W" : mine < theirs ? "L" : "D";
      names.forEach(n => { const s = get(n); s.m++; s[r === "W" ? "w" : r === "L" ? "l" : "d"]++; s.form.push(r); });
    }
    Object.entries(scorers).forEach(([n, g]) => get(n).g += g);
    const m = mvpOf(t); if (m) get(m).mvp++;
  }
  Object.values(S).forEach(s => {
    s.pts = s.m ? Math.round((s.w + s.d * 0.5) / s.m * 100) : null;
    s.streak = 0; for (let i = s.form.length - 1; i >= 0 && s.form[i] === "W"; i--) s.streak++;
  });
  return S;
}
function mvpOf(t) {
  const tally = {}; Object.values(t.votes || {}).forEach(n => tally[n] = (tally[n] || 0) + 1);
  const e = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  return e.length && (e.length === 1 || e[0][1] > e[1][1]) ? e[0][0] : null;
}
const rating = (S, n) => S[n]?.pts ?? 50;

function balance(t, jitter = 0) {
  const S = computeStats(), squad = mainSquad(t);
  const gks = squad.filter(p => p.role === "gk").map(p => p.name);
  const field = squad.filter(p => p.role !== "gk").map(p => ({ n: p.name, r: rating(S, p.name) + (Math.random() - .5) * jitter })).sort((a, b) => b.r - a.r);
  const A = gks[0] ? [gks[0]] : [], B = gks[1] ? [gks[1]] : [];
  gks.slice(2).forEach((n, i) => (i % 2 ? B : A).push(n));
  field.forEach((p, i) => { const k = i % 4; (k === 0 || k === 3 ? A : B).push(p.n); });
  if (jitter && Math.random() > .5) return { A: B, B: A };
  return { A, B };
}

// ---------- actions ----------
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message || "صار خطأ، جرّب مرة ثانية"); console.error(e); }
}
const A = {
  tab(el) { U.tab = el.dataset.v; history.replaceState(null, "", "#" + U.tab); render(); window.scrollTo(0, 0); },
  role(el) { U[el.dataset.k || "role"] = el.dataset.v; render(); },
  openNew() { U.newOpen = !U.newOpen; render(); },
  join(el) {
    const t = current(), role = el.dataset.v, n = U.me; let full;
    act(async () => { await store.updateTraining(t.id, t => { full = place(t, n, role); });
      toast(full ? (role === "gk" ? "خانات الحراس مكتملة، انضفت للاحتياط" : "الأساسيين مكتملين، انضفت للاحتياط") : (role === "gk" ? "انحجزت لك خانة حارس 🧤" : "انحجزت خانتك، نشوفك في التمرين ⚽")); });
  },
  leave(el) {
    const t = current(), n = el.dataset.n;
    act(() => store.updateTraining(t.id, t => { t.players = t.players.filter(p => p.name !== n); promote(t); }), n === U.me ? "انسحبت من التمرين" : "انشال الاسم");
  },
  unhold(el) {
    const t = current(), n = el.dataset.n;
    act(() => store.updateTraining(t.id, t => { const p = t.players.find(p => p.name === n); if (p) p.status = "wait"; }), "رجع للاحتياط");
  },
  shuffle() { U.draftTeams = balance(current(), 16); U.draftFor = current().id; U.sel = null; render(); toast("تم التوزيع حسب المستوى"); },
  pick(el) {
    const n = el.dataset.n, T = U.draftTeams;
    if (!U.sel) U.sel = n;
    else if (U.sel === n) U.sel = null;
    else {
      const t = current(), x = U.sel;
      if ((roleOf(t, x) === "gk") !== (roleOf(t, n) === "gk")) toast("بدّل حارس بحارس، ولاعب بلاعب");
      else {
        const tx = T.A.includes(x) ? T.A : T.B, tn = T.A.includes(n) ? T.A : T.B, ix = tx.indexOf(x), inn = tn.indexOf(n);
        tx[ix] = n; tn[inn] = x;
      }
      U.sel = null;
    }
    render();
  },
  saveTeams() { const t = current(), teams = U.draftTeams; act(() => store.updateTraining(t.id, t => { t.teams = teams; }), "انحفظت التشكيلة"); },
  score(el) { const r = U.draftResult; r[el.dataset.s] = Math.max(0, r[el.dataset.s] + +el.dataset.d); render(); },
  goal(el) { const r = U.draftResult; r.scorers[el.dataset.n] = (r.scorers[el.dataset.n] || 0) + 1; render(); },
  clearGoals() { U.draftResult.scorers = {}; render(); },
  saveResult() { const t = current(), r = U.draftResult; act(() => store.updateTraining(t.id, t => { t.result = { a: r.a, b: r.b, scorers: r.scorers }; }), "انحفظت النتيجة وتحدثت الإحصائيات"); },
  vote(el) {
    const t = current(), n = el.dataset.n, me = U.me;
    act(() => store.updateTraining(t.id, t => { t.votes = t.votes || {}; if (t.votes[me]) throw new Error("صوّتت من قبل"); t.votes[me] = n; }), "انحسب صوتك");
  },
  paid(el) {
    const t = current(), n = el.dataset.n;
    act(() => store.updateTraining(t.id, t => { t.fee = t.fee || { total: 0, paid: [] }; const p = new Set(t.fee.paid); p.has(n) ? p.delete(n) : p.add(n); t.fee.paid = [...p]; }));
  },
  view(el) { U.viewId = el.dataset.id; U.draftTeams = null; U.draftResult = null; U.tab = "reg"; render(); window.scrollTo(0, 0); },
  delTraining() {
    if (!U.confirmDel) { U.confirmDel = true; render(); return; }
    const t = current(); U.confirmDel = false; U.viewId = null;
    act(() => store.deleteTraining(t.id), "انحذف التمرين");
  },
  cancelDel() { U.confirmDel = false; render(); },
  logoutAdmin() { ls.set("kora.admin", null); render(); toast("طلعت من وضع المشرف"); },
  copy(el) {
    const text = el.dataset.text;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("انسخ النص"), () => toast("ما قدرت أنسخ، انسخه يدوياً"));
  },
};
A.remind = () => {
  const t = current(), start = startOf(t), end = new Date(+start + 2 * 36e5);
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kora//ar", "BEGIN:VEVENT",
    `UID:${t.id}@kora`, `DTSTAMP:${icsStamp(new Date())}`, `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
    `SUMMARY:⚽ ${D.settings.name}`, `LOCATION:${t.place}`, `DESCRIPTION:${location.origin + location.pathname}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:التمرين بعد ${REMIND_HOURS} ساعات`, `TRIGGER:-PT${REMIND_HOURS}H`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  a.download = `tamreen-${t.date}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  toast("افتح الملف واضغط إضافة للتقويم");
};
A.size = el => {
  const t = current(), size = +el.dataset.v;
  act(() => store.updateTraining(t.id, t => { t.size = size; }), `صارت ${size} ضد ${size}`);
};
A.sort = el => { U.sortK = el.dataset.k; render(); };

async function saveMe(name) {
  name = cleanName(name);
  if (!name) return toast("اكتب اسمك");
  if (name.length > 24) return toast("الاسم طويل، اختصره شوي");
  await act(() => store.updateSettings(s => { s.roster = s.roster || []; if (!s.roster.some(r => r.name === name)) s.roster.push({ name, at: Date.now() }); }));
  U.me = name; ls.set("kora.me", name); render();
  toast("هلا " + name + "! انحفظ اسمك");
}
const F = {
  async setup(f) {
    const g = f.group.value.trim(), a = f.admin.value.trim(), name = f.gname.value.trim() || "تمرين الشباب";
    if (g.length < 3 || a.length < 3) return toast("الرموز لازم تكون 3 حروف أو أكثر");
    if (g === a) return toast("خل رمز المشرف غير عن رمز القروب");
    const s = { name, groupHash: await sha(g), adminHash: await sha(a), roster: [] };
    ls.set("kora.group", s.groupHash); ls.set("kora.admin", s.adminHash);
    act(() => store.saveSettings(s), "جاهز! أرسل رمز القروب للشباب");
  },
  async gate(f) {
    if (await sha(f.code.value) === D.settings.groupHash) { ls.set("kora.group", D.settings.groupHash); render(); }
    else toast("الرمز غلط");
  },
  hello(f) { saveMe(f.existing?.value || f.name.value); },
  me(f) { saveMe(f.me.value); },
  async newTraining(f) {
    const t = { date: f.date.value, time: f.time.value, place: f.place.value.trim() || "الملعب", createdAt: Date.now(), players: [], teams: null, result: null, votes: {}, fee: { total: 0, paid: [] } };
    if (!t.date || !t.time) return toast("اختر التاريخ والوقت");
    await act(async () => { U.viewId = await store.addTraining(t); U.newOpen = false; U.draftTeams = null; U.draftResult = null; }, "انفتح التسجيل للتمرين الجديد");
    render();
  },
  addName(f) {
    const n = cleanName(f.name.value), role = U.addRole, t = current(); let full;
    if (!n) return toast("اكتب الاسم");
    act(async () => { await store.updateTraining(t.id, t => { full = place(t, n, role); }); const i = document.getElementById("add-name"); if (i) i.value = ""; toast(full ? `${n} انضاف للاحتياط` : `${n} انضاف للأساسيين`); });
  },
  hold(f) {
    const n = f.pick.value, t = current();
    if (!n) return;
    act(() => store.updateTraining(t.id, t => {
      if (held(t).length >= HELD) throw new Error("الخانات المحجوزة مكتملة");
      const p = t.players.find(p => p.name === n); if (p) p.status = "held";
    }), `${n} دخل الخانة المحجوزة`);
  },
  fee(f) {
    const t = current(), total = Math.max(0, Number(f.total.value) || 0);
    act(() => store.updateTraining(t.id, t => { t.fee = { ...(t.fee || { paid: [] }), total }; }), "انحفظ المبلغ");
  },
  async admin(f) {
    if (await sha(f.code.value) === D.settings.adminHash) { ls.set("kora.admin", D.settings.adminHash); toast("دخلت كمشرف"); render(); }
    else toast("رمز المشرف غلط");
  },
  async codes(f) {
    const ch = {};
    if (f.gname.value.trim()) ch.name = f.gname.value.trim();
    if (f.group.value.trim()) { if (f.group.value.trim().length < 3) return toast("رمز القروب قصير"); ch.groupHash = await sha(f.group.value); }
    if (f.admin.value.trim()) { if (f.admin.value.trim().length < 3) return toast("رمز المشرف قصير"); ch.adminHash = await sha(f.admin.value); }
    if (ch.groupHash) ls.set("kora.group", ch.groupHash);
    if (ch.adminHash) ls.set("kora.admin", ch.adminHash);
    act(() => store.updateSettings(s => Object.assign(s, ch)), "انحفظت الإعدادات");
  },
  h2h(f) { U.h2h = [f.p1.value, f.p2.value]; render(); },
};
root.addEventListener("click", e => { const el = e.target.closest("[data-act]"); if (el && A[el.dataset.act]) { e.preventDefault(); A[el.dataset.act](el); } });
root.addEventListener("submit", e => { e.preventDefault(); const f = e.target; F[f.dataset.form]?.(f); });
root.addEventListener("change", e => { const f = e.target.closest("form[data-live]"); if (f) F[f.dataset.form]?.(f); });

// ---------- views ----------
const svg = (p, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${p}</svg>`;
const ic = {
  reg: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M9 15l2 2 4-4"/>',
  line: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 12h16"/><circle cx="12" cy="12" r="3"/>',
  stats: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  titles: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  glove: '<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10M10 9V4.5a1.5 1.5 0 0 1 3 0V10M13 9.5V5.5a1.5 1.5 0 0 1 3 0V12M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-12 4.9L4.6 16a1.6 1.6 0 0 1 2.3-2.2L7 14"/>',
};
const tabs = [["reg", "التسجيل"], ["line", "التشكيلة"], ["stats", "الإحصائيات"], ["titles", "الألقاب"], ["more", "المزيد"]];

function header() {
  const t = current();
  let next = "";
  if (t) {
    const d = daysTo(t.date);
    const h = hoursTo(t), soon = d === 0 && h > 0 && h <= 12;
    const big = d < 0 || (d === 0 && h <= -2) ? "✓" : soon ? Math.ceil(h) : d === 0 ? "اليوم" : d === 1 ? "بكرة" : d;
    const sub = big === "✓" ? "التمرين انتهى" : soon ? (Math.ceil(h) <= 2 ? "ساعة على التمرين" : "ساعات على التمرين") : d <= 1 ? "التمرين" : "أيام على التمرين";
    next = `<div class="next"><span class="big">${big}</span><div class="txt"><b>${longDate(t.date)}</b>${sub} · ${t12(t.time)} · ${esc(t.place)}</div></div>`;
  }
  return `<header class="top"><div class="wrap"><div class="hrow"><img src="icons/icon-192.png" alt="">
    <h1 class="brand">${esc(D.settings.name)}<small>${isAdmin() ? "أنت مشرف · " : ""}${U.me ? "هلا " + esc(U.me) : "سجّل اسمك"}</small></h1>
    ${isOnline() ? "" : '<span class="mode" title="البيانات محفوظة في هذا المتصفح بس">وضع التجربة</span>'}</div>${next}</div></header>`;
}
function shell(body) {
  return `${header()}<nav class="tabs" role="tablist"><div class="in">${tabs.map(([k, l]) => `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${U.tab === k}"><span class="pill">${svg(ic[k])}</span>${l}</button>`).join("")}</div></nav>
    <main class="screen wrap">${body}</main>`;
}

function newTrainingForm() {
  if (!isAdmin()) return "";
  if (!U.newOpen) return `<button class="btn ghost" data-act="openNew">+ بداية تسجيل تمرين جديد</button>`;
  const d = new Date(); d.setDate(d.getDate() + 1);
  const last = sorted()[0];
  return `<form class="card" data-form="newTraining" style="border:1.5px dashed var(--blue)">
    <h3>تمرين جديد</h3><p class="hint">اختر التاريخ والوقت من التقويم.</p>
    <div class="btns"><label class="f">التاريخ<input type="date" id="nt-date" name="date" value="${ymd(d)}" required></label>
    <label class="f">الوقت<input type="time" id="nt-time" name="time" value="${last ? last.time : "21:00"}" required></label></div>
    <label class="f">المكان<input id="nt-place" name="place" value="${esc(last ? last.place : "ملعب الحي")}"></label>
    <div class="btns"><button class="btn" type="submit">افتح التسجيل</button><button class="btn ghost" type="button" data-act="openNew">إلغاء</button></div>
    <p class="hint">يبدأ قائمة فاضية، والتمارين السابقة تبقى في الأرشيف.</p></form>`;
}

function myStatus(t) {
  const past = t.date < todayStr();
  const p = t.players.find(p => p.name === U.me);
  if (!p) {
    if (past) return "";
    return `<div class="card" style="gap:10px"><h3>تبي تلعب يا ${esc(U.me)}؟</h3>
      <div class="btns"><button class="btn big" data-act="join" data-v="p">⚽ سجّلني لاعب</button><button class="btn big gold" data-act="join" data-v="gk">🧤 سجّلني حارس</button></div>
      <p class="hint">إذا امتلت الخانات تنضاف للاحتياط، وتدخل تلقائياً إذا انسحب أحد.</p></div>`;
  }
  let num, title, sub, cls = "";
  if (p.status === "in" && p.role === "p") { num = openIn(t).indexOf(p) + 1; title = "أنت في الأساسيين"; sub = `خانة رقم ${num} من ${OPEN}`; }
  else if (p.status === "in") { num = "🧤"; title = "أنت حارس التمرين"; sub = "خانة حارس ثابتة"; }
  else if (p.status === "held") { num = svg(ic.lock, 'style="width:24px;height:24px"'); title = "أنت في خانة محجوزة"; sub = "المشرف اختارك للأساسيين"; }
  else { num = reserves(t).indexOf(p) + 1; title = "أنت في الاحتياط"; sub = `ترتيبك ${num}، وتدخل أول ما تفضى خانة${p.role === "gk" ? " حارس" : ""}`; cls = "wait"; }
  return `<div class="mine ${cls}"><span class="num">${num}</span><div class="t"><b>${title}</b>${sub}</div>${past ? "" : `<button class="btn small danger" data-act="leave" data-n="${esc(p.name)}">انسحاب</button>`}</div>
    ${hoursTo(t) > REMIND_HOURS ? `<button class="btn ghost" data-act="remind">⏰ ذكّرني قبل التمرين بـ${REMIND_HOURS} ساعات</button>` : ""}`;
}

function slot({ no, name, cls = "", x = "", extra = "" }) {
  const me = name && name === U.me;
  return `<div class="slot ${cls}${name ? "" : " open"}${me ? " me" : ""}"><span class="no">${no}</span><span class="nm">${name ? esc(name) + (me ? " (أنت)" : "") : extra || "فاضي"}</span>${x}</div>`;
}

function regView() {
  const t = current();
  if (!t) return `${newTrainingForm()}<div class="card"><h3>ما فيه تمرين مفتوح للحين</h3><p class="hint">${isAdmin() ? "افتح تمرين جديد من الزر فوق." : "أول ما يفتح المشرف التسجيل، تقدر تحجز خانتك من هنا."}</p></div>${emptySquad()}`;
  const admin = isAdmin(), past = t.date < todayStr();
  const canX = n => !past && (admin || n === U.me);
  const xBtn = n => canX(n) ? `<button class="x" data-act="leave" data-n="${esc(n)}" aria-label="شيل ${esc(n)}" title="شيل">×</button>` : "";
  const field = openIn(t), gks = gkIn(t), hl = held(t), res = reserves(t), squad = mainSquad(t);
  const resSlots = BATCH * (Math.floor(res.length / BATCH) + 1);
  const shareText = `${D.settings.name}\nتمرين ${longDate(t.date)} · ${t12(t.time)} · ${t.place}\n\nالحراس:\n${gks.map(p => "🧤 " + p.name).join("\n") || "—"}\n\nالأساسيين (${squad.length}/${MAIN}):\n${[...field, ...hl].map((p, i) => `${i + 1}. ${p.name}`).join("\n")}${res.length ? `\n\nالاحتياط:\n${res.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}` : ""}\n\nسجّل من هنا: ${location.origin + location.pathname}`;
  const holdSel = admin && res.length && !past ? `<form data-form="hold" data-live style="flex:1;min-width:0"><select name="pick" aria-label="اختر من الاحتياط"><option value="">+ اختر لاعب</option>${res.map(p => `<option>${esc(p.name)}</option>`).join("")}</select></form>` : "";
  return `${newTrainingForm()}${myStatus(t)}
    <section class="card">
      <div class="sec-h"><h2>الأساسيين</h2><span class="cnt"><b>${squad.length}</b> / ${MAIN}</span></div>
      <div class="bar"><i style="width:${squad.length / MAIN * 100}%"></i></div>
      <div class="legend"><span><i style="background:var(--gold)"></i>حارس (${GK})</span><span><i style="background:var(--blue)"></i>محجوزة للمشرف (${HELD})</span><span><i style="background:var(--navy)"></i>مفتوحة للكل (${OPEN})</span></div>
      <span class="label">الحراس</span>
      <div class="slots">${[0, 1].map(i => slot({ no: svg(ic.glove), name: gks[i]?.name, cls: "gk", x: gks[i] ? xBtn(gks[i].name) : "", extra: "خانة حارس" })).join("")}</div>
      <span class="label">محجوزة للمشرف · يختارهم من الاحتياط</span>
      <div class="slots">${[0, 1, 2].map(i => hl[i]
        ? slot({ no: svg(ic.lock), name: hl[i].name, cls: "held", x: admin && !past ? `<button class="x" data-act="unhold" data-n="${esc(hl[i].name)}" aria-label="رجّعه للاحتياط" title="رجّعه للاحتياط">↩</button>` : "" })
        : `<div class="slot held open"><span class="no">${svg(ic.lock)}</span>${i === hl.length && holdSel ? holdSel : `<span class="nm">محجوزة</span>`}</div>`).join("")}</div>
      <span class="label">مفتوحة للكل</span>
      <div class="slots">${Array.from({ length: OPEN }, (_, i) => slot({ no: i + 1, name: field[i]?.name, x: field[i] ? xBtn(field[i].name) : "" })).join("")}</div>
    </section>
    <section class="card">
      <div class="sec-h"><h2>الاحتياط</h2><span class="cnt"><b>${res.length}</b> / ${resSlots}</span></div>
      <p class="hint">إذا انسحب أحد من الخانات المفتوحة، يدخل أول واحد في الاحتياط مكانه تلقائياً.${resSlots > BATCH ? ` انفتحت دفعة احتياط ${resSlots / BATCH}.` : ` إذا امتلت ${BATCH} خانات تنفتح ${BATCH} زيادة.`}</p>
      <div class="slots">${Array.from({ length: resSlots }, (_, i) => slot({ no: i + 1, name: res[i]?.name, cls: "res" + (res[i]?.role === "gk" ? " gk" : ""), x: res[i] ? xBtn(res[i].name) : "" })).join("")}</div>
    </section>
    ${admin && !past ? `<form class="card" data-form="addName"><h3>إضافة اسم (للمشرف)</h3><p class="hint">لواحد ما عنده جوال أو ما قدر يسجّل.</p>
      <div class="role" role="radiogroup"><button type="button" role="radio" data-act="role" data-k="addRole" data-v="p" aria-checked="${U.addRole === "p"}">لاعب</button><button type="button" role="radio" data-act="role" data-k="addRole" data-v="gk" aria-checked="${U.addRole === "gk"}">حارس</button></div>
      <div class="joinrow"><input id="add-name" name="name" placeholder="الاسم" list="roster-list" autocomplete="off" maxlength="24"><button class="btn" type="submit">إضافة</button></div>
      <datalist id="roster-list">${roster().map(r => `<option value="${esc(r.name)}">`).join("")}</datalist></form>` : ""}
    <div class="btns"><a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">أرسل القائمة للواتساب</a>
      <button class="btn ghost" data-act="copy" data-text="${esc(shareText)}">نسخ</button></div>
    ${groupReminder(t)}${feeCard(t)}`;
}
function emptySquad() {
  return `<section class="card" style="opacity:.75"><div class="sec-h"><h2>الأساسيين</h2><span class="cnt"><b>0</b> / ${MAIN}</span></div>
    <div class="legend"><span><i style="background:var(--gold)"></i>حارس (${GK})</span><span><i style="background:var(--blue)"></i>محجوزة للمشرف (${HELD})</span><span><i style="background:var(--navy)"></i>مفتوحة للكل (${OPEN})</span></div>
    <div class="slots">${slot({ no: svg(ic.glove), cls: "gk", extra: "خانة حارس" }).repeat(2)}${`<div class="slot held open"><span class="no">${svg(ic.lock)}</span><span class="nm">محجوزة</span></div>`.repeat(3)}${Array.from({ length: OPEN }, (_, i) => slot({ no: i + 1 })).join("")}</div></section>`;
}

function groupReminder(t) {
  const h = hoursTo(t);
  if (!isAdmin() || h <= 0) return "";
  const due = h <= REMIND_HOURS + 0.5;
  const text = `⏰ تذكير: ${D.settings.name}\nالتمرين ${daysTo(t.date) === 0 ? "اليوم" : longDate(t.date)} الساعة ${t12(t.time)} · ${t.place}\n\nالأساسيين:\n${mainSquad(t).map((p, i) => `${i + 1}. ${p.role === "gk" ? "🧤 " : ""}${p.name}`).join("\n")}\n\nاللي ما يقدر يجي ينسحب من هنا عشان يدخل الاحتياط: ${location.origin + location.pathname}`;
  return `<div class="card" style="${due ? "border-color:var(--gold);box-shadow:0 0 0 1px var(--gold)" : ""}"><div class="row"><h3>⏰ تذكير القروب</h3>${due ? '<span class="chip gold">وقته الحين</span>' : `<span class="chip">قبل التمرين بـ${REMIND_HOURS} ساعات</span>`}</div>
    <p class="hint">${due ? "باقي أقل من " + REMIND_HOURS + " ساعات. أرسل التذكير للقروب." : `يتفعّل هذا التذكير الساعة ${t12(new Date(+startOf(t) - REMIND_HOURS * 36e5).toTimeString().slice(0, 5))}، ورسالته جاهزة فيها أسماء الأساسيين.`}</p>
    <a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">أرسل التذكير للواتساب</a></div>`;
}
function feeCard(t) {
  const fee = t.fee || { total: 0, paid: [] }, people = mainSquad(t);
  if (!isAdmin() && !fee.total) return "";
  const per = people.length ? Math.ceil(fee.total / people.length) : 0;
  return `<div class="card"><div class="row"><h3>رسوم الملعب</h3>${fee.total ? `<span class="chip blue">${per} ريال على الشخص</span>` : ""}</div>
    ${isAdmin() ? `<form data-form="fee" class="joinrow"><input id="fee-total" name="total" type="number" min="0" inputmode="numeric" placeholder="إيجار الملعب بالريال" value="${fee.total || ""}"><button class="btn small" type="submit">حفظ</button></form>` : `<p class="hint">الإيجار ${fee.total} ريال مقسوم على ${people.length} من الأساسيين.</p>`}
    ${fee.total ? `<p class="hint">دفع ${fee.paid.filter(n => people.some(p => p.name === n)).length} من ${people.length}</p><ol class="plain">${people.map(p => { const on = fee.paid.includes(p.name); return `<li>${esc(p.name)}${isAdmin() ? `<button class="paid ${on ? "on" : ""}" data-act="paid" data-n="${esc(p.name)}">${on ? "دفع" : "ما دفع"}</button>` : `<span class="chip ${on ? "win" : ""}" style="margin-inline-start:auto">${on ? "دفع" : "باقي"}</span>`}</li>`; }).join("")}</ol>` : ""}</div>`;
}

function spots(n, bottom) {
  const out = [], rows = []; let left = n;
  while (left > 0) { const k = Math.min(4, left); rows.push(k); left -= k; }
  rows.forEach((k, r) => {
    const y = rows.length === 1 ? 70 : 82 - r * (26 / (rows.length - 1));
    for (let i = 0; i < k; i++) out.push([(i + 1) * 100 / (k + 1), bottom ? y : 100 - y]);
  });
  return out;
}
const sizeOf = t => (t && t.size) || DEFAULT_SIZE;
// first goalkeeper and the first (size - 1) field players start; everyone else in the team is on the bench
function split(t, names) {
  const size = sizeOf(t), gk = t ? names.filter(n => roleOf(t, n) === "gk") : [], field = t ? names.filter(n => roleOf(t, n) !== "gk") : [];
  return { gk: gk[0], field: field.slice(0, size - 1), bench: [...gk.slice(1), ...field.slice(size - 1)] };
}
function pitch(t, T, S, admin) {
  const team = (names, side) => {
    const { gk, field } = split(t, names);
    const cap = sizeOf(t) - 1, pos = spots(cap, side === "A");
    const btn = (n, x, y, isGk) => n
      ? `<button class="pl ${side}${isGk ? " gk" : ""}${U.sel === n ? " sel" : ""}" style="right:${x}%;top:${y}%" data-act="pick" data-n="${esc(n)}" ${admin ? "" : "disabled"} title="مستوى ${rating(S, n)}%"><span class="dot">${rating(S, n)}</span><span class="nm">${esc(n)}</span></button>`
      : `<span class="pl empty${isGk ? " gk" : ""}" style="right:${x}%;top:${y}%"><span class="dot">${isGk ? "🧤" : "+"}</span><span class="nm">${isGk ? "حارس" : "فاضي"}</span></span>`;
    const gy = side === "A" ? 92 : 8;
    return btn(gk, 50, gy, true) + Array.from({ length: cap }, (_, i) => btn(field[i], pos[i][0], pos[i][1], false)).join("");
  };
  return `<div class="pitch"><div class="circle"></div><div class="box t"></div><div class="box b"></div>
    <span class="tlabel" style="top:18px">البيج</span><span class="tlabel" style="bottom:18px">الأزرق</span>${team(T.A, "A")}${team(T.B, "B")}</div>`;
}

function sizeBar(t, admin) {
  const size = sizeOf(t);
  if (!admin || !t) return `<div class="row"><span class="chip blue">${size} ضد ${size}</span><span class="hint">كل فريق ${size} لاعبين مع الحارس</span></div>`;
  return `<div class="role" role="radiogroup" aria-label="عدد اللاعبين">${SIZES.map(n => `<button type="button" role="radio" data-act="size" data-v="${n}" aria-checked="${size === n}">${n} ضد ${n}</button>`).join("")}</div>`;
}
function bench(t, T, admin) {
  if (!t) return "";
  const col = (names, side, label) => {
    const b = split(t, names).bench;
    return `<div class="card" style="padding:12px;gap:8px;flex:1;min-width:0"><span class="label">${label} · ${b.length}</span>${b.length
      ? `<div class="scorers">${b.map(n => `<button data-act="pick" data-n="${esc(n)}" class="${U.sel === n ? "on" : ""}" ${admin ? "" : "disabled"}>${roleOf(t, n) === "gk" ? "🧤 " : ""}${esc(n)}</button>`).join("")}</div>`
      : '<span class="hint">ما فيه</span>'}</div>`;
  };
  return `<div class="row" style="align-items:stretch;flex-wrap:nowrap">${col(T.A, "A", "🔵 دكة الأزرق")}${col(T.B, "B", "🟤 دكة البيج")}</div>`;
}
function lineView() {
  const t = current(), S = computeStats(), admin = isAdmin();
  if (!t) return `<h2>التشكيلة</h2>${pitch(null, { A: [], B: [] }, S, false)}<p class="hint">الملعب يتعبّى أول ما يسجّل الشباب في تمرين.</p>`;
  if (U.draftFor !== t.id || !U.draftTeams) { U.draftTeams = t.teams ? structuredClone(t.teams) : balance(t); U.draftFor = t.id; }
  // keep the draft in step with registrations until the admin saves a lineup
  if (!t.teams && !admin) U.draftTeams = balance(t);
  const T = U.draftTeams;
  const reg = new Set(mainSquad(t).map(p => p.name));
  const stale = t.teams && ([...t.teams.A, ...t.teams.B].some(n => !reg.has(n)) || reg.size !== t.teams.A.length + t.teams.B.length);
  const avg = names => { const f = names.filter(n => roleOf(t, n) !== "gk"); return f.length ? Math.round(f.reduce((s, n) => s + rating(S, n), 0) / f.length) + "%" : "—"; };
  const teamLines = names => { const s = split(t, names); return [s.gk && "🧤 " + s.gk, ...s.field.map(n => "• " + n)].filter(Boolean).join("\n") + (s.bench.length ? `\nدكة: ${s.bench.join("، ")}` : ""); };
  const teamText = `تشكيلة تمرين ${longDate(t.date)} · ${sizeOf(t)} ضد ${sizeOf(t)}\n\n🔵 الأزرق:\n${teamLines(T.A)}\n\n🟤 البيج:\n${teamLines(T.B)}`;
  return `<div class="row"><h2>التشكيلة</h2>${admin ? `<button class="btn small" data-act="shuffle">⚖️ توزيع متوازن</button>` : t.teams ? '<span class="chip blue">معتمدة من المشرف</span>' : '<span class="chip">مقترحة تلقائياً</span>'}</div>
    ${stale ? `<p class="hint" style="color:var(--loss)">تغيّرت قائمة الأساسيين بعد حفظ التشكيلة.${admin ? " اضغط توزيع متوازن واحفظها من جديد." : ""}</p>` : ""}
    <div class="balance"><div class="side"><span class="label">🔵 الأزرق · ${T.A.length}</span><b>${avg(T.A)}</b><span class="hint">متوسط المستوى</span></div><span class="vs">ضد</span>
      <div class="side"><span class="label">البيج 🟤 · ${T.B.length}</span><b>${avg(T.B)}</b><span class="hint">متوسط المستوى</span></div></div>
    ${sizeBar(t, admin)}
    ${pitch(t, T, S, admin)}
    ${bench(t, T, admin)}
    <p class="hint">الرقم داخل الدائرة مستوى اللاعب، والجديد يبدأ من 50. الحارس بإطار ذهبي.${admin ? " اضغط على لاعبين عشان تبدّل مكانهم (بين الفريقين أو بين الملعب والدكة)، وبعدها احفظ." : ""}</p>
    <div class="btns">${admin ? `<button class="btn" data-act="saveTeams">حفظ التشكيلة</button>` : ""}
      <a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(teamText)}" target="_blank" rel="noopener">أرسل للواتساب</a>
      <button class="btn ghost" data-act="copy" data-text="${esc(teamText)}">نسخ</button></div>
    ${resultCard(t)}${mvpCard(t)}`;
}

function resultCard(t) {
  if (!t.teams) return isAdmin() ? `<p class="hint">احفظ التشكيلة أول عشان تقدر تسجّل النتيجة.</p>` : "";
  const r = t.result;
  if (!isAdmin()) {
    if (!r) return "";
    return `<div class="card"><span class="label">النتيجة</span><div class="score"><div><div class="tn">الأزرق</div><div class="bigscore">${r.a}</div></div><span class="vs">–</span><div><div class="tn">البيج</div><div class="bigscore">${r.b}</div></div></div>
      ${Object.keys(r.scorers || {}).length ? `<p class="hint">الأهداف: ${Object.entries(r.scorers).map(([n, g]) => `${esc(n)}${g > 1 ? " ×" + g : ""}`).join("، ")}</p>` : ""}</div>`;
  }
  if (!U.draftResult || U.draftResult.id !== t.id) U.draftResult = { id: t.id, a: r?.a ?? 0, b: r?.b ?? 0, scorers: { ...(r?.scorers || {}) } };
  const d = U.draftResult, goals = side => t.teams[side].reduce((s, n) => s + (d.scorers[n] || 0), 0);
  const warn = goals("A") > d.a || goals("B") > d.b;
  return `<div class="card"><h3>${r ? "تعديل النتيجة" : "بعد المباراة · سجّل النتيجة"}</h3>
    <div class="score"><div><div class="tn">🔵 الأزرق</div><div class="step"><button data-act="score" data-s="a" data-d="1" aria-label="زيادة">+</button><output>${d.a}</output><button data-act="score" data-s="a" data-d="-1" aria-label="نقص">−</button></div></div>
      <span class="vs">–</span><div><div class="tn">البيج 🟤</div><div class="step"><button data-act="score" data-s="b" data-d="1" aria-label="زيادة">+</button><output>${d.b}</output><button data-act="score" data-s="b" data-d="-1" aria-label="نقص">−</button></div></div></div>
    <div class="row"><span class="label">مين سجّل؟ اضغط على الاسم لكل هدف</span><button class="btn small ghost" data-act="clearGoals">مسح الأهداف</button></div>
    ${["A", "B"].map(s => `<div class="scorers">${t.teams[s].map(n => `<button data-act="goal" data-n="${esc(n)}" class="${d.scorers[n] ? "on" : ""}">${s === "A" ? "🔵" : "🟤"} ${esc(n)}${d.scorers[n] ? ` <b>${d.scorers[n]}</b>` : ""}</button>`).join("")}</div>`).join("")}
    ${warn ? `<p class="hint" style="color:var(--loss)">عدد الأهداف المسجلة أكثر من النتيجة.</p>` : ""}
    <button class="btn" data-act="saveResult">${r ? "تحديث النتيجة" : "اعتماد النتيجة وتحديث الإحصائيات"}</button></div>`;
}

function mvpCard(t) {
  if (!t.result || !t.teams) return "";
  const players = [...t.teams.A, ...t.teams.B], votes = t.votes || {};
  const tally = {}; Object.values(votes).forEach(n => tally[n] = (tally[n] || 0) + 1);
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const mvp = mvpOf(t), played = players.includes(U.me), voted = votes[U.me];
  return `<div class="card"><div class="row"><h3>⭐ رجل المباراة</h3><span class="chip">${Object.keys(votes).length} صوت من ${players.length}</span></div>
    ${top.length ? `<p class="hint">${mvp ? `المتصدر: <b style="color:var(--blue)">${esc(mvp)}</b> · ` : "تعادل بالأصوات · "}${top.map(([n, c]) => `${esc(n)} ${c}`).join("، ")}</p>` : ""}
    ${!played ? `<p class="hint">التصويت للي لعبوا المباراة بس.</p>`
      : voted ? `<p class="hint">صوّتت لـ ${esc(voted)}.</p>`
      : `<span class="label">صوّت (مرة وحدة، وما تقدر تصوّت لنفسك)</span><div class="scorers">${players.filter(n => n !== U.me).map(n => `<button data-act="vote" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>`}</div>`;
}

function statsView() {
  const all = Object.values(computeStats());
  const cols = [["n", "اللاعب"], ["m", "لعب"], ["w", "فوز"], ["d", "تعادل"], ["l", "خسارة"], ["g", "أهداف"], ["mvp", "نجم"], ["att", "حضور"], ["pts", "المستوى"], ["form", "آخر 5"]];
  const rows = [...all].sort((a, b) => (b[U.sortK] ?? -1) - (a[U.sortK] ?? -1) || b.att - a.att || a.n.localeCompare(b.n, "ar"));
  const top = k => { const p = [...all].sort((a, b) => b[k] - a[k])[0]; return p && p[k] > 0 ? p : null; };
  const L = [["الهدّاف", top("g"), "g", "هدف"], ["أكثر فوز", top("w"), "w", "فوز"], ["أكثر حضور", top("att"), "att", "تمرين"]];
  const cell = (v, cls = "") => `<td class="${v ? cls : "z"}">${v}</td>`;
  const body = rows.length ? rows.map(p => `<tr class="${p.n === U.me ? "me" : ""}"><td><b>${esc(p.n)}</b></td>${cell(p.m)}${cell(p.w, "w")}${cell(p.d)}${cell(p.l, "l")}${cell(p.g)}${cell(p.mvp)}${cell(p.att)}<td class="${p.pts == null ? "z" : ""}">${p.pts == null ? "—" : p.pts + "%"}</td><td><span class="form">${Array.from({ length: 5 }, (_, i) => `<i class="${p.form.slice(-5)[i] || ""}"></i>`).join("")}</span></td></tr>`).join("")
    : `<tr><td class="z">اسمك هنا</td>${'<td class="z">0</td>'.repeat(7)}<td class="z">—</td><td><span class="form">${"<i></i>".repeat(5)}</span></td></tr>`;
  return `<h2>الإحصائيات المتراكمة</h2>
    <div class="leaders">${L.map(([t, p, k, u]) => `<div class="lead"><span class="label">${t}</span><span class="v">${p ? p[k] : "—"}</span><span class="n">${p ? esc(p.n) + " · " + u : "ما أحد للحين"}</span></div>`).join("")}</div>
    <div class="tablewrap"><table><thead><tr>${cols.map(([k, t]) => `<th ${k === "n" || k === "form" ? "" : `data-act="sort" data-k="${k}"`} class="${k === U.sortK ? "on" : ""}">${t}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="hint">اضغط على عنوان أي عمود للترتيب.${all.some(s => s.m) ? "" : " الأرقام تتعبى بعد أول نتيجة يسجّلها المشرف."}</p>
    <section class="card"><h3>وش يتحسب؟</h3><dl class="how">
      <dt>لعب</dt><dd>عدد المباريات اللي لعبتها في التشكيلة المعتمدة وانسجلت نتيجتها.</dd>
      <dt>فوز / تعادل / خسارة</dt><dd>نتيجة فريقك في كل مباراة.</dd>
      <dt>أهداف</dt><dd>الأهداف اللي سجّلها لك المشرف بعد المباراة.</dd>
      <dt>نجم</dt><dd>كم مرة صرت رجل المباراة بتصويت اللاعبين.</dd>
      <dt>حضور</dt><dd>كم تمرين كنت فيه من الأساسيين.</dd>
      <dt>المستوى</dt><dd>(الفوز + نص التعادل) ÷ عدد المباريات. الجديد يبدأ من 50%، ويُستخدم لتوزيع الفرق بالتساوي.</dd>
      <dt>آخر 5</dt><dd>🟩 فوز · 🟥 خسارة · ⬜ تعادل.</dd></dl></section>`;
}

const titleIc = {
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z" fill="currentColor"/>',
  boot: '<path d="M5 4h6v7l8 3a2 2 0 0 1 1 2v2H4z" fill="currentColor"/>',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" fill="currentColor"/>',
  star: '<path d="M12 2l3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z" fill="currentColor"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2" fill="currentColor"/>',
  fire: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9z" fill="currentColor"/>',
  crumb: '<circle cx="8" cy="9" r="3" fill="currentColor"/><circle cx="16" cy="8" r="2" fill="currentColor"/><circle cx="14" cy="16" r="3.5" fill="currentColor"/><circle cx="7" cy="17" r="1.6" fill="currentColor"/>',
  cloud: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1A4 4 0 0 1 17 18z" fill="currentColor"/>',
  ghost: '<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z" fill="currentColor"/>',
};
function titlesView() {
  const all = Object.values(computeStats()), S = all.filter(s => s.m), Q = S.filter(s => s.m >= MIN_MATCHES);
  const best = (list, f, ok = () => true) => list.filter(ok).sort((a, b) => f(b) - f(a))[0] || null;
  const done = D.trainings.filter(t => t.date < todayStr() || t.result).length;
  const T = [
    { t: "الأسطورة", i: "crown", hero: 1, p: best(Q, s => s.pts * 1000 + s.w), why: s => `أعلى مستوى ${s.pts}% في ${s.m} مباراة`, rule: `أعلى مستوى، بشرط ${MIN_MATCHES} مباريات أو أكثر` },
    { t: "القنّاص", i: "boot", p: best(S, s => s.g, s => s.g > 0), why: s => `أكثر واحد يسجل: ${s.g} هدف`, rule: "أكثر عدد أهداف" },
    { t: "جالب الحظ", i: "shield", p: best(S, s => s.w, s => s.w > 0), why: s => `أكثر عدد فوز: ${s.w}`, rule: "أكثر عدد فوز" },
    { t: "نجم القروب", i: "star", p: best(S, s => s.mvp, s => s.mvp > 0), why: s => `رجل المباراة ${s.mvp} مرة`, rule: "أكثر مرات رجل المباراة" },
    { t: "الملتزم", i: "cal", p: best(all, s => s.att, s => s.att > 0), why: s => `حضر ${s.att} تمرين`, rule: "أكثر حضور مع الأساسيين" },
    { t: "المولّع", i: "fire", p: best(S, s => s.streak, s => s.streak >= 2), why: s => `${s.streak} انتصارات ورا بعض`, rule: "أطول سلسلة فوز حالية (2 أو أكثر)" },
    { t: "الفتّيت", i: "crumb", neg: 1, p: best(S, s => s.l, s => s.l > 0), why: s => `أكثر عدد خسارة: ${s.l}`, rule: "أكثر عدد خسارة" },
    { t: "المنحوس", i: "cloud", neg: 1, p: best(Q, s => -s.pts), why: s => `أقل مستوى ${s.pts}%`, rule: `أقل مستوى، بشرط ${MIN_MATCHES} مباريات أو أكثر` },
    { t: "الغايب", i: "ghost", neg: 1, p: best(all, s => -s.att, s => s.att > 0 && s.att < done), why: s => `حضر ${s.att} من ${done} تمرين`, rule: "أقل حضور" },
  ];
  return `<h2>ألقاب الموسم</h2><p class="hint" style="margin-top:-10px">تتحدث تلقائياً بعد كل نتيجة. تحت كل لقب شرطه لين يكسبه أحد.</p>
    <div class="badges">${T.map(b => `<div class="badge${b.hero ? " hero" : ""}${b.neg ? " neg" : ""}${b.p ? "" : " none"}"><div class="medal"><svg viewBox="0 0 24 24" aria-hidden="true">${titleIc[b.i]}</svg></div>
      <div><h4>${b.t}</h4><div class="who">${b.p ? esc(b.p.n) : "ما أحد للحين"}</div><p class="why">${b.p ? b.why(b.p) : b.rule}</p></div></div>`).join("")}</div>`;
}

function moreView() {
  const list = sorted(), cur = current(), names = Object.values(computeStats()).filter(s => s.m).map(s => s.n).sort((a, b) => a.localeCompare(b, "ar"));
  let h2h = "";
  const [p1, p2] = U.h2h;
  if (p1 && p2 && p1 !== p2) {
    const tog = { w: 0, d: 0, l: 0 }, vs = { a: 0, b: 0, d: 0 };
    for (const t of D.trainings) {
      if (!t.result || !t.teams) continue;
      const side = n => t.teams.A.includes(n) ? "A" : t.teams.B.includes(n) ? "B" : null, s1 = side(p1), s2 = side(p2);
      if (!s1 || !s2) continue;
      const diff = t.result.a - t.result.b, r1 = diff === 0 ? 0 : (diff > 0) === (s1 === "A") ? 1 : -1;
      if (s1 === s2) tog[r1 > 0 ? "w" : r1 < 0 ? "l" : "d"]++; else vs[r1 > 0 ? "a" : r1 < 0 ? "b" : "d"]++;
    }
    h2h = `<span class="label">ضد بعض</span><div class="h2hres"><div><b>${vs.a}</b>فوز ${esc(p1)}</div><div><b>${vs.d}</b>تعادل</div><div><b>${vs.b}</b>فوز ${esc(p2)}</div></div>
      <span class="label">مع بعض في نفس الفريق</span><div class="h2hres"><div><b>${tog.w}</b>فوز</div><div><b>${tog.d}</b>تعادل</div><div><b>${tog.l}</b>خسارة</div></div>`;
  }
  const opt = sel => `<option value="">اختر لاعب</option>` + names.map(n => `<option ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("");
  return `<h2>أرشيف التمارين</h2>
    ${list.length ? `<ul class="arch">${list.map(t => `<li data-act="view" data-id="${t.id}" class="${cur && cur.id === t.id ? "cur" : ""}"><div><div class="d">${longDate(t.date)}</div><span class="hint">${mainSquad(t).length} أساسي · ${esc(t.place)}${mvpOf(t) ? " · ⭐ " + esc(mvpOf(t)) : ""}</span></div>
      <span class="s">${t.result ? `${t.result.a} – ${t.result.b}` : '<span class="chip">بدون نتيجة</span>'}</span></li>`).join("")}</ul>` : `<div class="card empty">ما فيه تمارين للحين.</div>`}
    ${isAdmin() && cur ? (U.confirmDel ? `<div class="card"><p style="margin:0">متأكد تبي تحذف تمرين ${longDate(cur.date)}؟ بتنحذف أسماؤه ونتيجته من الإحصائيات.</p><div class="btns"><button class="btn danger" data-act="delTraining">إيه، احذفه</button><button class="btn ghost" data-act="cancelDel">لا</button></div></div>` : `<button class="btn danger small" style="align-self:flex-start" data-act="delTraining">حذف التمرين المحدد</button>`) : ""}
    <h2>المواجهات</h2>
    ${names.length > 1 ? `<form class="card" data-form="h2h" data-live><div class="h2h"><select id="h2h-1" name="p1" aria-label="اللاعب الأول">${opt(p1)}</select><select id="h2h-2" name="p2" aria-label="اللاعب الثاني">${opt(p2)}</select></div>${h2h || '<p class="hint">اختر لاعبين وشوف مين يغلب مين، وكيف نتايجهم إذا لعبوا مع بعض.</p>'}</form>` : `<p class="hint">تظهر بعد ما يلعب لاعبين على الأقل.</p>`}
    <h2>اللاعبين المسجلين (${roster().length})</h2>
    <div class="card">${roster().length ? `<div class="scorers">${roster().map(r => `<span class="chip ${r.name === U.me ? "blue" : ""}" style="font-size:13px;padding:4px 11px">${esc(r.name)}</span>`).join("")}</div>` : '<p class="hint">ما أحد سجّل اسمه للحين.</p>'}</div>
    <h2>إعداداتي</h2>
    <form class="card" data-form="me"><label class="f">اسمي<input id="me-name" name="me" value="${esc(U.me)}" maxlength="24" list="roster-me"></label><datalist id="roster-me">${roster().map(r => `<option value="${esc(r.name)}">`).join("")}</datalist><button class="btn small" style="align-self:flex-start" type="submit">حفظ</button></form>
    ${isAdmin() ? `<form class="card" data-form="codes"><h3>إعدادات المشرف</h3>
        <label class="f">اسم القروب<input id="set-name" name="gname" value="${esc(D.settings.name)}"></label>
        <label class="f">رمز قروب جديد (اتركه فاضي إذا ما تبي تغيره)<input id="set-group" name="group" autocomplete="off"></label>
        <label class="f">رمز مشرف جديد<input id="set-admin" name="admin" autocomplete="off"></label>
        <div class="btns"><button class="btn small" type="submit">حفظ</button><button class="btn small ghost" type="button" data-act="logoutAdmin">خروج من وضع المشرف</button></div>
        <p class="hint">إذا غيّرت رمز القروب، الكل يحتاج يدخل الرمز الجديد.</p></form>`
      : `<form class="card" data-form="admin"><label class="f">دخول المشرف (فتح التمارين، الخانات المحجوزة، التشكيلة، النتائج، الرسوم)<input id="admin-code" name="code" type="password" autocomplete="off"></label><button class="btn small ghost" style="align-self:flex-start" type="submit">دخول</button></form>`}`;
}

const gateWrap = inner => `<div class="gatewrap">${inner}</div>`;
function setupView() {
  return gateWrap(`<form class="gate" data-form="setup"><img src="icons/icon-192.png" alt=""><h1>تجهيز القروب</h1>
    <p class="hint">أول مرة يفتح التطبيق. حط رمز للقروب ترسله للشباب، ورمز مشرف تحتفظ فيه لنفسك.</p>
    <label class="f">اسم القروب<input id="su-name" name="gname" value="تمرين الشباب"></label>
    <label class="f">رمز القروب<input id="su-group" name="group" required autocomplete="off"></label>
    <label class="f">رمز المشرف<input id="su-admin" name="admin" type="password" required autocomplete="off"></label>
    <button class="btn big" type="submit">ابدأ</button></form>`);
}
function gateView() {
  return gateWrap(`<form class="gate" data-form="gate"><img src="icons/icon-192.png" alt=""><h1>${esc(D.settings.name)}</h1><p class="hint">اكتب رمز القروب اللي أرسله لك المشرف.</p>
    <input id="gate-code" name="code" autocomplete="off" aria-label="رمز القروب" required><button class="btn big" type="submit">دخول</button></form>`);
}
function helloView() {
  const r = roster();
  return gateWrap(`<form class="gate" data-form="hello"><img src="icons/icon-192.png" alt=""><h1>وش اسمك؟</h1>
    <p class="hint">تسجّله مرة وحدة وينحفظ في جوالك، وبعدها تحجز خانتك في أي تمرين بضغطة.</p>
    <label class="f">اسمك اللي يعرفونك فيه<input id="hello-name" name="name" maxlength="24" autocomplete="off" placeholder="مثلاً: أبو فهد"></label>
    ${r.length ? `<label class="f">أو مسجّل من قبل؟ اختر اسمك<select id="hello-existing" name="existing"><option value="">—</option>${r.map(x => `<option>${esc(x.name)}</option>`).join("")}</select></label>` : ""}
    <button class="btn big" type="submit">احفظ اسمي</button></form>`);
}

function render() {
  // keep what the user is typing when a live update re-renders the page
  const keep = {}; root.querySelectorAll("input[id]").forEach(i => keep[i.id] = i.value);
  const focus = document.activeElement?.id;
  if (D.settings === undefined) return;
  if (D.settings === null) root.innerHTML = setupView();
  else if (!unlocked()) root.innerHTML = gateView();
  else if (!U.me) root.innerHTML = helloView();
  else root.innerHTML = shell({ reg: regView, line: lineView, stats: statsView, titles: titlesView, more: moreView }[U.tab]());
  Object.entries(keep).forEach(([id, v]) => { const i = document.getElementById(id); if (i && (v || (i.type !== "date" && i.type !== "time"))) i.value = v; });
  if (focus) document.getElementById(focus)?.focus();
}

(async () => {
  try {
    store = await createStore();
    store.subscribe(d => { D.trainings = d.trainings; D.settings = d.settings; render(); });
  } catch (e) {
    console.error(e);
    root.innerHTML = gateWrap(`<div class="gate"><h1>ما قدرت أتصل</h1><p class="hint">تأكد من الإنترنت وحدّث الصفحة. (${esc(e.message || e)})</p></div>`);
  }
})();
