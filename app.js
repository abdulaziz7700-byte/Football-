import { createStore, isOnline } from "./store.js";

const MAX_FIELD = 13, MAX_GK = 2, MIN_MATCHES = 3;
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
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("show"); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove("show"), 2200); }

// ---------- dates ----------
const parseDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmt = (s, o) => parseDate(s).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", o);
const t12 = v => { let [h, m] = v.split(":").map(Number); const pm = h >= 12; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${pm ? "مساءً" : "صباحاً"}`; };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const when = ms => { const d = new Date(ms); return d.toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("ar-SA-u-nu-latn", { hour: "numeric", minute: "2-digit" }); };
const sortKey = t => t.date + " " + t.time;

// ---------- state ----------
const D = { trainings: [], settings: undefined };
const U = {
  tab: ["reg", "line", "stats", "titles", "more"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "reg",
  viewId: null, role: "p", sel: null, draftTeams: null, draftFor: null, draftResult: null,
  sortK: "pts", newOpen: false, h2h: ["", ""], confirmDel: false, me: ls.get("kora.me") || "",
};
let store;
const unlocked = () => D.settings && ls.get("kora.group") === D.settings.groupHash;
const isAdmin = () => D.settings && ls.get("kora.admin") === D.settings.adminHash;

function sorted() { return [...D.trainings].sort((a, b) => sortKey(b).localeCompare(sortKey(a))); }
function current() {
  const list = sorted();
  if (U.viewId) { const t = list.find(x => x.id === U.viewId); if (t) return t; }
  const upcoming = list.filter(t => t.date >= todayStr());
  return upcoming.length ? upcoming[upcoming.length - 1] : list[0];
}
const inField = t => t.players.filter(p => p.status === "in" && p.role === "p");
const inGk = t => t.players.filter(p => p.status === "in" && p.role === "gk");
const waiting = t => t.players.filter(p => p.status === "wait");
const roleOf = (t, n) => (t.players.find(p => p.name === n) || {}).role;

function promote(t) {
  for (const [role, cap] of [["p", MAX_FIELD], ["gk", MAX_GK]]) {
    while (t.players.filter(p => p.status === "in" && p.role === role).length < cap) {
      const w = t.players.find(p => p.status === "wait" && p.role === role);
      if (!w) break;
      w.status = "in";
    }
  }
}

// ---------- stats ----------
function computeStats() {
  const S = {};
  const get = n => S[n] ||= { n, m: 0, w: 0, d: 0, l: 0, g: 0, mvp: 0, att: 0, form: [] };
  const list = [...D.trainings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (const t of list) {
    t.players.filter(p => p.status === "in").forEach(p => get(p.name).att++);
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
  const S = computeStats();
  const gks = inGk(t).map(p => p.name);
  const field = inField(t).map(p => ({ n: p.name, r: rating(S, p.name) + (Math.random() - .5) * jitter })).sort((a, b) => b.r - a.r);
  const A = gks[0] ? [gks[0]] : [], B = gks[1] ? [gks[1]] : [];
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
  role(el) { U.role = el.dataset.v; render(); },
  openNew() { U.newOpen = !U.newOpen; render(); },
  leave(el) {
    const t = current(), n = el.dataset.n;
    act(() => store.updateTraining(t.id, t => { t.players = t.players.filter(p => p.name !== n); promote(t); }), "انشال الاسم");
  },
  shuffle() { U.draftTeams = balance(current(), 16); U.draftFor = current().id; U.sel = null; render(); toast("تم التوزيع حسب المستوى"); },
  pick(el) {
    const n = el.dataset.n, T = U.draftTeams;
    if (!U.sel) U.sel = n;
    else if (U.sel === n) U.sel = null;
    else {
      const t = current(), x = U.sel;
      if ((roleOf(t, x) === "gk") !== (roleOf(t, n) === "gk")) toast("بدّل حارس بحارس، ولاعب بلاعب");
      else if (T.A.includes(x) === T.A.includes(n)) toast("اختر لاعب من كل فريق");
      else { const [a, b] = T.A.includes(x) ? [x, n] : [n, x]; T.A[T.A.indexOf(a)] = b; T.B[T.B.indexOf(b)] = a; }
      U.sel = null;
    }
    render();
  },
  saveTeams() {
    const t = current(), teams = U.draftTeams;
    act(() => store.updateTraining(t.id, t => { t.teams = teams; }), "انحفظت التشكيلة");
  },
  score(el) { const r = U.draftResult; r[el.dataset.s] = Math.max(0, r[el.dataset.s] + +el.dataset.d); render(); },
  goal(el) { const r = U.draftResult; r.scorers[el.dataset.n] = (r.scorers[el.dataset.n] || 0) + 1; render(); },
  clearGoals() { U.draftResult.scorers = {}; render(); },
  saveResult() {
    const t = current(), r = U.draftResult;
    act(() => store.updateTraining(t.id, t => { t.result = { a: r.a, b: r.b, scorers: r.scorers }; }), "انحفظت النتيجة وتحدثت الإحصائيات");
  },
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
const F = {
  async setup(f) {
    const g = f.group.value.trim(), a = f.admin.value.trim(), name = f.gname.value.trim() || "تمرين الشباب";
    if (g.length < 3 || a.length < 3) return toast("الرموز لازم تكون 3 حروف أو أكثر");
    if (g === a) return toast("خل رمز المشرف غير عن رمز القروب");
    const s = { name, groupHash: await sha(g), adminHash: await sha(a) };
    ls.set("kora.group", s.groupHash); ls.set("kora.admin", s.adminHash);
    act(() => store.saveSettings(s), "جاهز! أرسل رمز القروب للشباب");
  },
  async gate(f) {
    if (await sha(f.code.value) === D.settings.groupHash) { ls.set("kora.group", D.settings.groupHash); render(); }
    else toast("الرمز غلط");
  },
  async newTraining(f) {
    const t = { date: f.date.value, time: f.time.value, place: f.place.value.trim() || "الملعب", createdAt: Date.now(), players: [], teams: null, result: null, votes: {}, fee: { total: 0, paid: [] } };
    if (!t.date || !t.time) return toast("اختر التاريخ والوقت");
    await act(async () => { U.viewId = await store.addTraining(t); U.newOpen = false; U.draftTeams = null; U.draftResult = null; }, "انفتح التسجيل للتمرين الجديد");
    render();
  },
  join(f) {
    const n = f.name.value.trim().replace(/\s+/g, " "), role = U.role, t = current();
    if (!n) return toast("اكتب اسمك أول");
    if (n.length > 24) return toast("الاسم طويل، اختصره شوي");
    let msg = "";
    act(async () => {
      await store.updateTraining(t.id, t => {
        if (t.players.some(p => p.name === n)) throw new Error("الاسم مسجّل من قبل");
        const cap = role === "gk" ? MAX_GK : MAX_FIELD;
        const full = t.players.filter(p => p.status === "in" && p.role === role).length >= cap;
        t.players.push({ name: n, role, status: full ? "wait" : "in", at: Date.now() });
        msg = full ? (role === "gk" ? "خانات الحراس مكتملة، انضفت للانتظار" : "العدد مكتمل، انضفت لقائمة الانتظار") : (role === "gk" ? "تم تسجيلك حارس" : "تم تسجيلك، نشوفك في التمرين");
      });
      if (!U.me) { U.me = n; ls.set("kora.me", n); }
      toast(msg);
    });
  },
  fee(f) {
    const t = current(), total = Math.max(0, Number(f.total.value) || 0);
    act(() => store.updateTraining(t.id, t => { t.fee = { ...(t.fee || { paid: [] }), total }; }), "انحفظ المبلغ");
  },
  me(f) { U.me = f.me.value.trim(); ls.set("kora.me", U.me || null); toast(U.me ? "تم، أنت " + U.me : "انشال اسمك"); render(); },
  async admin(f) {
    if (await sha(f.code.value) === D.settings.adminHash) { ls.set("kora.admin", D.settings.adminHash); toast("دخلت كمشرف"); render(); }
    else toast("رمز المشرف غلط");
  },
  async codes(f) {
    const s = { ...D.settings };
    if (f.gname.value.trim()) s.name = f.gname.value.trim();
    if (f.group.value.trim()) { if (f.group.value.trim().length < 3) return toast("رمز القروب قصير"); s.groupHash = await sha(f.group.value); }
    if (f.admin.value.trim()) { if (f.admin.value.trim().length < 3) return toast("رمز المشرف قصير"); s.adminHash = await sha(f.admin.value); }
    ls.set("kora.group", s.groupHash); ls.set("kora.admin", s.adminHash);
    act(() => store.saveSettings(s), "انحفظت الإعدادات");
  },
  h2h(f) { U.h2h = [f.p1.value, f.p2.value]; render(); },
};
root.addEventListener("click", e => { const el = e.target.closest("[data-act]"); if (el && A[el.dataset.act]) { e.preventDefault(); A[el.dataset.act](el); } });
root.addEventListener("submit", e => { e.preventDefault(); const f = e.target; F[f.dataset.form]?.(f); });
root.addEventListener("change", e => { const f = e.target.closest("form[data-live]"); if (f) F[f.dataset.form]?.(f); });

// ---------- views ----------
const ic = {
  reg: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M9 15l2 2 4-4"/>',
  line: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 12h16"/><circle cx="12" cy="12" r="3"/>',
  stats: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  titles: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
};
const gkIc = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 3h2v7h1V2h2v8h1V3h2v8h1V6h2v8a7 7 0 0 1-14 0V8h2z"/></svg>';
const tabs = [["reg", "التسجيل"], ["line", "التشكيلة"], ["stats", "الإحصائيات"], ["titles", "الألقاب"], ["more", "المزيد"]];

function shell(body) {
  return `<div class="app">
    <header class="top"><h1 class="brand">${esc(D.settings.name)}<small>${isAdmin() ? "أنت مشرف" : U.me ? "هلا " + esc(U.me) : "سجّل اسمك للتمرين الجاي"}</small></h1>
      ${isOnline() ? "" : '<span class="mode" title="البيانات محفوظة في هذا المتصفح بس">وضع التجربة</span>'}</header>
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${U.tab === k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ic[k]}</svg>${l}</button>`).join("")}</nav>
    <div class="screen">${body}</div></div>`;
}

function dayCard(t) {
  return `<div class="day"><div class="cal"><b>${fmt(t.date, { day: "numeric" })}</b><span>${fmt(t.date, { month: "long" })}</span></div>
    <h3>تمرين ${fmt(t.date, { weekday: "long", day: "numeric", month: "long" })}</h3>
    <p>${t12(t.time)} · ${esc(t.place)}${t.date < todayStr() ? " · انتهى" : ""}</p></div>`;
}

function newTrainingForm() {
  if (!isAdmin()) return "";
  if (!U.newOpen) return `<button class="btn ghost" data-act="openNew">+ بداية تسجيل تمرين جديد</button>`;
  const d = new Date(); d.setDate(d.getDate() + 1);
  const def = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const last = sorted()[0];
  return `<form class="card" data-form="newTraining" style="border:1px dashed var(--blue)">
    <span class="label">تمرين جديد · اختر التاريخ والوقت من التقويم</span>
    <div class="btns"><label class="f">التاريخ<input type="date" id="nt-date" name="date" value="${def}" required></label>
    <label class="f">الوقت<input type="time" id="nt-time" name="time" value="${last ? last.time : "21:00"}" required></label></div>
    <label class="f">المكان<input id="nt-place" name="place" value="${esc(last ? last.place : "ملعب الحي")}"></label>
    <div class="btns"><button class="btn" type="submit">افتح التسجيل</button><button class="btn ghost" type="button" data-act="openNew">إلغاء</button></div>
    <p class="hint">يبدأ قائمة تسجيل فاضية، والتمارين السابقة تبقى في الأرشيف.</p></form>`;
}

function regView() {
  const t = current();
  if (!t) return `<h2>التسجيل</h2>${newTrainingForm()}<div class="empty">ما فيه تمرين مفتوح للحين.${isAdmin() ? "" : " المشرف يفتح التسجيل من هنا."}</div>`;
  const field = inField(t), gks = inGk(t), wait = waiting(t);
  const canX = n => isAdmin() || n === U.me;
  const li = p => `<li class="${p.name === U.me ? "me" : ""}">${esc(p.name)}${p.name === U.me ? ' <span class="chip gold">أنت</span>' : ""}${p.role === "gk" && p.status === "wait" ? ' <span class="chip">حارس</span>' : ""}<span class="t">${when(p.at)}</span>${canX(p.name) ? `<button class="x" data-act="leave" data-n="${esc(p.name)}" aria-label="شيل ${esc(p.name)}" title="انسحاب">×</button>` : ""}</li>`;
  const shareText = `${D.settings.name}\nتمرين ${fmt(t.date, { weekday: "long", day: "numeric", month: "long" })} · ${t12(t.time)} · ${t.place}\n\nالحراس:\n${gks.map(p => "🧤 " + p.name).join("\n") || "—"}\n\nاللاعبين (${field.length}/${MAX_FIELD}):\n${field.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}${wait.length ? `\n\nالانتظار:\n${wait.map(p => p.name).join("\n")}` : ""}\n\nسجّل من هنا: ${location.origin + location.pathname}`;
  const past = t.date < todayStr();
  return `${newTrainingForm()}${dayCard(t)}
    ${past ? "" : `<form data-form="join" class="card" style="background:transparent;padding:0">
      <div class="role" role="radiogroup" aria-label="تسجّل كـ">
        <button type="button" role="radio" data-act="role" data-v="p" aria-checked="${U.role === "p"}">لاعب</button>
        <button type="button" role="radio" data-act="role" data-v="gk" aria-checked="${U.role === "gk"}">حارس مرمى</button></div>
      <p class="hint">${U.role === "gk" ? "فيه خانتين ثابتة للحراس، ما تنحسب من الـ13 لاعب." : "فيه 13 خانة للاعبين، واللي بعدهم يدخلون قائمة الانتظار."}</p>
      <div class="joinrow"><input id="join-name" name="name" placeholder="اكتب اسمك" value="${esc(U.me)}" autocomplete="off" aria-label="اسمك" maxlength="24"><button class="btn" type="submit">سجّلني</button></div></form>`}
    <div class="meter"><div class="row"><span class="label">الحراس · خانتين ثابتة</span><span><b>${gks.length}</b> من ${MAX_GK}</span></div>
      <div class="gkslots">${[0, 1].map(i => gks[i] ? `<div class="gkslot">${gkIc}<span>${esc(gks[i].name)}</span>${canX(gks[i].name) ? `<button class="x" style="margin-inline-start:auto;border:0;background:none;color:var(--loss);font-size:18px;cursor:pointer" data-act="leave" data-n="${esc(gks[i].name)}" aria-label="شيل">×</button>` : ""}</div>` : `<div class="gkslot empty">${gkIc}خانة حارس فاضية</div>`).join("")}</div></div>
    <div class="meter"><div class="row"><span class="label">اللاعبين</span><span><b>${field.length}</b> من ${MAX_FIELD}</span></div>
      <div class="bar"><i style="width:${field.length / MAX_FIELD * 100}%"></i></div></div>
    ${field.length ? `<ol class="players">${field.map(li).join("")}</ol>` : `<div class="empty">ما أحد سجّل للحين. كن أول واحد!</div>`}
    <div class="label">قائمة الانتظار</div>
    ${wait.length ? `<ol class="players">${wait.map(li).join("")}</ol>` : `<p class="hint">فاضية · إذا انسحب أحد من الأساسيين يدخل أول واحد في الانتظار مكانه تلقائياً.</p>`}
    <div class="btns"><a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">أرسل القائمة للواتساب</a>
      <button class="btn ghost" data-act="copy" data-text="${esc(shareText)}">نسخ</button></div>
    ${feeCard(t)}`;
}

function feeCard(t) {
  const fee = t.fee || { total: 0, paid: [] }, people = t.players.filter(p => p.status === "in");
  if (!isAdmin() && !fee.total) return "";
  const per = people.length ? Math.ceil(fee.total / people.length) : 0;
  return `<div class="card fee"><div class="row"><h3>رسوم الملعب</h3>${fee.total ? `<span class="chip blue">${per} ريال على الشخص</span>` : ""}</div>
    ${isAdmin() ? `<form data-form="fee" class="joinrow"><input id="fee-total" name="total" type="number" min="0" inputmode="numeric" placeholder="إيجار الملعب بالريال" value="${fee.total || ""}"><button class="btn small" type="submit">حفظ</button></form>` : `<p class="hint">الإيجار ${fee.total} ريال مقسوم على ${people.length} حاضر.</p>`}
    ${fee.total ? `<p class="hint">دفع ${fee.paid.filter(n => people.some(p => p.name === n)).length} من ${people.length}</p><ol class="players">${people.map(p => { const on = fee.paid.includes(p.name); return `<li>${esc(p.name)}<span class="t"></span>${isAdmin() ? `<button class="paid ${on ? "on" : ""}" data-act="paid" data-n="${esc(p.name)}">${on ? "دفع" : "ما دفع"}</button>` : `<span class="chip ${on ? "win" : ""}">${on ? "دفع" : "باقي"}</span>`}</li>`; }).join("")}</ol>` : ""}</div>`;
}

function spots(n, bottom) {
  const out = [], rows = []; let left = n;
  while (left > 0) { const k = Math.min(3, left); rows.push(k); left -= k; }
  rows.forEach((k, r) => {
    const y = rows.length === 1 ? 70 : 80 - r * (24 / (rows.length - 1));
    for (let i = 0; i < k; i++) out.push([(i + 1) * 100 / (k + 1), bottom ? y : 100 - y]);
  });
  return out;
}

function lineView() {
  const t = current();
  if (!t) return `<div class="empty">ما فيه تمرين للحين.</div>`;
  const S = computeStats();
  if (U.draftFor !== t.id || !U.draftTeams) { U.draftTeams = t.teams ? structuredClone(t.teams) : balance(t); U.draftFor = t.id; }
  const T = U.draftTeams, admin = isAdmin();
  const registered = new Set(t.players.filter(p => p.status === "in").map(p => p.name));
  const stale = t.teams && ([...t.teams.A, ...t.teams.B].some(n => !registered.has(n)) || registered.size !== t.teams.A.length + t.teams.B.length);
  const avg = names => { const f = names.filter(n => roleOf(t, n) !== "gk"); return f.length ? Math.round(f.reduce((s, n) => s + rating(S, n), 0) / f.length) + "%" : "—"; };
  const team = (names, side) => {
    const gk = names.filter(n => roleOf(t, n) === "gk"), field = names.filter(n => roleOf(t, n) !== "gk");
    const pos = spots(field.length, side === "A");
    const btn = (n, x, y) => `<button class="pl ${side}${roleOf(t, n) === "gk" ? " gk" : ""}${U.sel === n ? " sel" : ""}" style="right:${x}%;top:${y}%" data-act="pick" data-n="${esc(n)}" ${admin ? "" : "disabled"} title="مستوى ${rating(S, n)}%"><span class="dot">${rating(S, n)}</span><span class="nm">${esc(n)}</span></button>`;
    return gk.map(n => btn(n, 50, side === "A" ? 91 : 9)).join("") + field.map((n, i) => btn(n, pos[i][0], pos[i][1])).join("");
  };
  if (!T.A.length && !T.B.length) return `<h2>التشكيلة</h2><div class="empty">التشكيلة تطلع هنا بعد ما يسجل الشباب.</div>`;
  const teamText = `تشكيلة تمرين ${fmt(t.date, { weekday: "long", day: "numeric", month: "long" })}\n\n🔵 الأزرق:\n${T.A.map(n => (roleOf(t, n) === "gk" ? "🧤 " : "• ") + n).join("\n")}\n\n🟤 البيج:\n${T.B.map(n => (roleOf(t, n) === "gk" ? "🧤 " : "• ") + n).join("\n")}`;
  return `<div class="row"><h2>التشكيلة</h2>${admin ? `<button class="btn small" data-act="shuffle">توزيع متوازن</button>` : t.teams ? '<span class="chip blue">معتمدة</span>' : '<span class="chip">مقترحة</span>'}</div>
    ${stale ? `<p class="hint" style="color:var(--loss)">تغيرت قائمة التسجيل بعد حفظ التشكيلة.${admin ? " اضغط توزيع متوازن واحفظها من جديد." : ""}</p>` : ""}
    <div class="balance"><div class="side"><span class="label">الأزرق · ${T.A.length}</span><b>${avg(T.A)}</b><span class="hint">متوسط المستوى</span></div><span class="vs">ضد</span>
      <div class="side"><span class="label">البيج · ${T.B.length}</span><b>${avg(T.B)}</b><span class="hint">متوسط المستوى</span></div></div>
    <div class="pitch"><div class="circle"></div><div class="box t"></div><div class="box b"></div>
      <span class="tlabel" style="top:16px">البيج</span><span class="tlabel" style="bottom:16px">الأزرق</span>${team(T.A, "A")}${team(T.B, "B")}</div>
    <p class="hint">الرقم داخل الدائرة مستوى اللاعب (نسبة نقاطه من مبارياته، والجديد يبدأ من 50). الحارس بإطار ذهبي.${admin ? " اضغط لاعبين من فريقين عشان تبدّلهم." : ""}</p>
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
  const d = U.draftResult, goals = (side) => t.teams[side].reduce((s, n) => s + (d.scorers[n] || 0), 0);
  const warn = goals("A") > d.a || goals("B") > d.b;
  return `<div class="card"><span class="label">${r ? "تعديل النتيجة" : "بعد المباراة · سجّل النتيجة"}</span>
    <div class="score"><div><div class="tn">الأزرق</div><div class="step"><button data-act="score" data-s="a" data-d="1" aria-label="زيادة">+</button><output>${d.a}</output><button data-act="score" data-s="a" data-d="-1" aria-label="نقص">−</button></div></div>
      <span class="vs">–</span><div><div class="tn">البيج</div><div class="step"><button data-act="score" data-s="b" data-d="1" aria-label="زيادة">+</button><output>${d.b}</output><button data-act="score" data-s="b" data-d="-1" aria-label="نقص">−</button></div></div></div>
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
  return `<div class="card"><div class="row"><h3>رجل المباراة</h3><span class="chip">${Object.keys(votes).length} صوت من ${players.length}</span></div>
    ${top.length ? `<p class="hint">${mvp ? `المتصدر: <b style="color:var(--blue)">${esc(mvp)}</b> · ` : "تعادل بالأصوات · "}${top.map(([n, c]) => `${esc(n)} ${c}`).join("، ")}</p>` : ""}
    ${!U.me ? `<p class="hint">عشان تصوّت، حط اسمك من صفحة المزيد.</p>`
      : !played ? `<p class="hint">التصويت للي لعبوا المباراة بس.</p>`
      : voted ? `<p class="hint">صوّتت لـ ${esc(voted)}.</p>`
      : `<span class="label">صوّت (مرة وحدة، وما تقدر تصوّت لنفسك)</span><div class="scorers">${players.filter(n => n !== U.me).map(n => `<button data-act="vote" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>`}</div>`;
}

function statsView() {
  const S = Object.values(computeStats()).filter(s => s.m);
  if (!S.length) return `<h2>الإحصائيات</h2><div class="empty">الإحصائيات تبدأ بعد أول نتيجة يسجلها المشرف.</div>`;
  const cols = [["n", "اللاعب"], ["m", "لعب"], ["w", "فوز"], ["d", "تعادل"], ["l", "خسارة"], ["g", "أهداف"], ["mvp", "نجم"], ["pts", "المستوى"], ["form", "آخر 5"]];
  const rows = [...S].sort((a, b) => (b[U.sortK] ?? -1) - (a[U.sortK] ?? -1) || b.m - a.m);
  const top = k => [...S].sort((a, b) => b[k] - a[k])[0];
  const att = Object.values(computeStats()).sort((a, b) => b.att - a.att)[0];
  const L = [["الهدّاف", top("g"), "g", "هدف"], ["أكثر فوز", top("w"), "w", "فوز"], ["أكثر حضور", att, "att", "تمرين"]];
  return `<h2>الإحصائيات المتراكمة</h2>
    <div class="leaders">${L.map(([t, p, k, u]) => `<div class="lead"><span class="label">${t}</span><span class="v">${p[k]}</span><span class="n">${esc(p.n)} · ${u}</span></div>`).join("")}</div>
    <div class="tablewrap"><table><thead><tr>${cols.map(([k, t]) => `<th ${k === "n" || k === "form" ? "" : `data-act="sort" data-k="${k}"`} class="${k === U.sortK ? "on" : ""}">${t}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(p => `<tr><td><b>${esc(p.n)}</b></td><td>${p.m}</td><td class="w">${p.w}</td><td>${p.d}</td><td class="l">${p.l}</td><td>${p.g}</td><td>${p.mvp}</td><td>${p.pts}%</td><td><span class="form">${p.form.slice(-5).map(c => `<i class="${c}"></i>`).join("")}</span></td></tr>`).join("")}</tbody></table></div>
    <p class="hint">اضغط على عنوان أي عمود للترتيب. المستوى = الفوز بنقطة والتعادل بنص نقطة، مقسوم على عدد المباريات. آخر 5: أخضر فوز، أحمر خسارة، رمادي تعادل.</p>`;
}
A.sort = el => { U.sortK = el.dataset.k; render(); };

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
  const best = (list, f, ok = () => true) => { const c = list.filter(ok).sort((a, b) => f(b) - f(a)); return c[0] || null; };
  const done = D.trainings.filter(t => t.date < todayStr() || t.result).length;
  const T = [
    { t: "الأسطورة", i: "crown", hero: 1, p: best(Q, s => s.pts * 1000 + s.w), why: s => `أعلى مستوى ${s.pts}% في ${s.m} مباراة`, rule: `أعلى مستوى، بشرط ${MIN_MATCHES} مباريات أو أكثر` },
    { t: "القنّاص", i: "boot", p: best(S, s => s.g, s => s.g > 0), why: s => `أكثر واحد يسجل: ${s.g} هدف`, rule: "أكثر عدد أهداف" },
    { t: "جالب الحظ", i: "shield", p: best(S, s => s.w, s => s.w > 0), why: s => `أكثر عدد فوز: ${s.w}`, rule: "أكثر عدد فوز" },
    { t: "نجم القروب", i: "star", p: best(S, s => s.mvp, s => s.mvp > 0), why: s => `رجل المباراة ${s.mvp} مرة`, rule: "أكثر مرات رجل المباراة" },
    { t: "الملتزم", i: "cal", p: best(all, s => s.att, s => s.att > 0), why: s => `حضر ${s.att} تمرين`, rule: "أكثر حضور" },
    { t: "المولّع", i: "fire", p: best(S, s => s.streak, s => s.streak >= 2), why: s => `${s.streak} انتصارات ورا بعض`, rule: "أطول سلسلة فوز حالية (2 أو أكثر)" },
    { t: "الفتّيت", i: "crumb", neg: 1, p: best(S, s => s.l, s => s.l > 0), why: s => `أكثر عدد خسارة: ${s.l}`, rule: "أكثر عدد خسارة" },
    { t: "المنحوس", i: "cloud", neg: 1, p: best(Q, s => -s.pts), why: s => `أقل مستوى ${s.pts}%`, rule: `أقل مستوى، بشرط ${MIN_MATCHES} مباريات أو أكثر` },
    { t: "الغايب", i: "ghost", neg: 1, p: best(all, s => -s.att, s => s.att > 0 && s.att < done), why: s => `حضر ${s.att} من ${done} تمرين`, rule: "أقل حضور" },
  ];
  return `<h2>ألقاب الموسم</h2><p class="hint" style="margin-top:-8px">تتحدث تلقائياً بعد كل نتيجة.</p>
    <div class="badges">${T.map(b => `<div class="badge${b.hero ? " hero" : ""}${b.neg ? " neg" : ""}${b.p ? "" : " none"}"><div class="medal"><svg viewBox="0 0 24 24" aria-hidden="true">${titleIc[b.i]}</svg></div>
      <div><h4>${b.t}</h4><div class="who">${b.p ? esc(b.p.n) : "ما أحد للحين"}</div><p class="why">${b.p ? b.why(b.p) : b.rule}</p></div></div>`).join("")}</div>`;
}

function moreView() {
  const list = sorted(), cur = current(), names = Object.values(computeStats()).filter(s => s.m).map(s => s.n).sort((a, b) => a.localeCompare(b, "ar"));
  let h2h = "";
  const [p1, p2] = U.h2h;
  if (p1 && p2 && p1 !== p2) {
    let tog = { w: 0, d: 0, l: 0 }, vs = { a: 0, b: 0, d: 0 };
    for (const t of D.trainings) {
      if (!t.result || !t.teams) continue;
      const s1 = t.teams.A.includes(p1) ? "A" : t.teams.B.includes(p1) ? "B" : null, s2 = t.teams.A.includes(p2) ? "A" : t.teams.B.includes(p2) ? "B" : null;
      if (!s1 || !s2) continue;
      const diff = t.result.a - t.result.b, r1 = diff === 0 ? 0 : (diff > 0) === (s1 === "A") ? 1 : -1;
      if (s1 === s2) tog[r1 > 0 ? "w" : r1 < 0 ? "l" : "d"]++; else vs[r1 > 0 ? "a" : r1 < 0 ? "b" : "d"]++;
    }
    h2h = `<span class="label">ضد بعض</span><div class="h2hres"><div><b>${vs.a}</b>فوز ${esc(p1)}</div><div><b>${vs.d}</b>تعادل</div><div><b>${vs.b}</b>فوز ${esc(p2)}</div></div>
      <span class="label">مع بعض في نفس الفريق</span><div class="h2hres"><div><b>${tog.w}</b>فوز</div><div><b>${tog.d}</b>تعادل</div><div><b>${tog.l}</b>خسارة</div></div>`;
  }
  const opt = sel => `<option value="">اختر لاعب</option>` + names.map(n => `<option ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("");
  return `<h2>أرشيف التمارين</h2>
    ${list.length ? `<ul class="arch">${list.map(t => `<li data-act="view" data-id="${t.id}" class="${cur && cur.id === t.id ? "cur" : ""}"><div><div class="d">${fmt(t.date, { weekday: "long", day: "numeric", month: "long" })}</div><span class="hint">${t.players.filter(p => p.status === "in").length} حاضر · ${esc(t.place)}${mvpOf(t) ? " · رجل المباراة " + esc(mvpOf(t)) : ""}</span></div>
      <span class="s">${t.result ? `${t.result.a} – ${t.result.b}` : '<span class="chip">بدون نتيجة</span>'}</span></li>`).join("")}</ul>` : `<div class="empty">ما فيه تمارين للحين.</div>`}
    ${isAdmin() && cur ? (U.confirmDel ? `<div class="card"><p style="margin:0">متأكد تبي تحذف تمرين ${fmt(cur.date, { weekday: "long", day: "numeric", month: "long" })}؟ بتنحذف أسماؤه ونتيجته من الإحصائيات.</p><div class="btns"><button class="btn danger" data-act="delTraining">إيه، احذفه</button><button class="btn ghost" data-act="cancelDel">لا</button></div></div>` : `<button class="btn danger small" style="align-self:flex-start" data-act="delTraining">حذف التمرين المحدد</button>`) : ""}
    <h2>المواجهات</h2>
    ${names.length > 1 ? `<form class="card" data-form="h2h" data-live><div class="h2h"><select id="h2h-1" name="p1" aria-label="اللاعب الأول">${opt(p1)}</select><select id="h2h-2" name="p2" aria-label="اللاعب الثاني">${opt(p2)}</select></div>${h2h || '<p class="hint">اختر لاعبين وشوف مين يغلب مين، وكيف نتايجهم إذا لعبوا مع بعض.</p>'}</form>` : `<p class="hint">تظهر بعد ما يلعب لاعبين على الأقل.</p>`}
    <h2>إعداداتي</h2>
    <form class="card" data-form="me"><label class="f">اسمي (عشان يتعلّم اسمك وتقدر تنسحب وتصوّت)<input id="me-name" name="me" value="${esc(U.me)}" maxlength="24"></label><button class="btn small" style="align-self:flex-start" type="submit">حفظ</button></form>
    ${isAdmin() ? `<form class="card" data-form="codes"><h3>إعدادات المشرف</h3>
        <label class="f">اسم القروب<input id="set-name" name="gname" value="${esc(D.settings.name)}"></label>
        <label class="f">رمز قروب جديد (اتركه فاضي إذا ما تبي تغيره)<input id="set-group" name="group" autocomplete="off"></label>
        <label class="f">رمز مشرف جديد<input id="set-admin" name="admin" autocomplete="off"></label>
        <div class="btns"><button class="btn small" type="submit">حفظ</button><button class="btn small ghost" type="button" data-act="logoutAdmin">خروج من وضع المشرف</button></div>
        <p class="hint">إذا غيّرت رمز القروب، الكل يحتاج يدخل الرمز الجديد.</p></form>`
      : `<form class="card" data-form="admin"><label class="f">دخول المشرف (فتح التمارين، التشكيلة، النتائج، الرسوم)<input id="admin-code" name="code" type="password" autocomplete="off"></label><button class="btn small ghost" style="align-self:flex-start" type="submit">دخول</button></form>`}`;
}

function setupView() {
  return `<form class="gate" data-form="setup"><h1>تجهيز القروب</h1>
    <p class="hint">أول مرة تفتح التطبيق. حط رمز للقروب ترسله للشباب، ورمز مشرف تحتفظ فيه لنفسك.</p>
    <label class="f">اسم القروب<input id="su-name" name="gname" value="تمرين الشباب"></label>
    <label class="f">رمز القروب<input id="su-group" name="group" required autocomplete="off"></label>
    <label class="f">رمز المشرف<input id="su-admin" name="admin" type="password" required autocomplete="off"></label>
    <button class="btn" type="submit">ابدأ</button></form>`;
}
function gateView() {
  return `<form class="gate" data-form="gate"><h1>${esc(D.settings.name)}</h1><p class="hint">اكتب رمز القروب اللي أرسله لك المشرف.</p>
    <input id="gate-code" name="code" autocomplete="off" aria-label="رمز القروب" required><button class="btn" type="submit">دخول</button></form>`;
}

function render() {
  // keep what the user is typing when a live update re-renders the page
  const keep = {}; root.querySelectorAll("input[id]").forEach(i => keep[i.id] = i.value);
  const focus = document.activeElement?.id;
  if (D.settings === undefined) return;
  if (D.settings === null) root.innerHTML = setupView();
  else if (!unlocked()) root.innerHTML = gateView();
  else root.innerHTML = shell({ reg: regView, line: lineView, stats: statsView, titles: titlesView, more: moreView }[U.tab]());
  Object.entries(keep).forEach(([id, v]) => { const i = document.getElementById(id); if (i && i.type !== "date" && i.type !== "time") i.value = v; else if (i && v) i.value = v; });
  if (focus) document.getElementById(focus)?.focus();
}

(async () => {
  try {
    store = await createStore();
    store.subscribe(d => { D.trainings = d.trainings; D.settings = d.settings; render(); });
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="gate"><h1>ما قدرت أتصل</h1><p class="hint">تأكد من الإنترنت وإعدادات Firebase، وحدّث الصفحة.</p></div>`;
  }
})();
