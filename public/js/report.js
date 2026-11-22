// myFitFactory — bilan mensuel : bandeau « Ton bilan de … est prêt » en haut de la page Séances (7 premiers jours du
// mois), rubrique « BILANS MENSUELS » de la page PR, fenêtre du bilan (comparé au mois précédent) et commentaire du
// coach écrit par l’IA (facultatif). Notification le 1er du mois (Worker) : elle ouvre /?bilan=AAAA-MM.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

let reportMonths = null,
  reportPending = new URLSearchParams(location.search).get("bilan");
if (reportPending) {
  const u = new URL(location.href);
  u.searchParams.delete("bilan");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}
const monthLabel = month =>
  new Intl.DateTimeFormat("fr-FR", {month: "long", year: "numeric"}).format(new Date(month + "-15T12:00:00"));
const monthName = month => new Intl.DateTimeFormat("fr-FR", {month: "long"}).format(new Date(month + "-15T12:00:00"));
// « de novembre », « d’octobre », « d’avril », « d’août ».
const ofMonth = label => (/^[aeiouyâàéèêîôû]/i.test(label) ? "d’" : "de ") + label;
function previousMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? y - 1 + "-12" : y + "-" + String(m - 1).padStart(2, "0");
}
async function loadReportMonths() {
  try {
    reportMonths = await api("/monthly-reports");
  } catch {}
  renderReportBanner();
  if (!$("#view-prs").hidden) renderPrs();
  if (reportPending && reportMonths) {
    const month = reportPending;
    reportPending = null;
    openMonthlyReport(month);
  }
}
// Bandeau des 7 premiers jours du mois, si le mois écoulé a des séances ; fermé, il ne revient pas pour ce mois.
function renderReportBanner() {
  const box = $("#reportbanner"),
    month = previousMonth(today().slice(0, 7)),
    has = reportMonths?.months?.some(m => m.month === month && m.sessions > 0);
  let dismissed = "";
  try {
    dismissed = localStorage.getItem("fitfactory-report-dismissed") || "";
  } catch {}
  box.hidden = !(has && Number(today().slice(8, 10)) <= 7 && dismissed !== month);
  if (box.hidden) return;
  box.innerHTML = `<button type="button" class="report-banner-open" data-report-open="${month}"><b>Ton bilan ${esc(ofMonth(monthName(month)))} est prêt</b><span>Séances, régularité, mouvements, PR…</span></button><button type="button" class="smallbtn" data-report-dismiss aria-label="Masquer" title="Masquer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>`;
  box.querySelector("[data-report-open]").onclick = () => openMonthlyReport(month);
  box.querySelector("[data-report-dismiss]").onclick = () => {
    try {
      localStorage.setItem("fitfactory-report-dismissed", month);
    } catch {}
    box.hidden = true;
  };
}
// Page PR : rubrique « BILANS MENSUELS » (12 derniers mois avec séances).
function renderReportSection() {
  const key = "records:reports",
    collapsed = !!window.cfPrCategorySections[key],
    months = reportMonths?.months || [];
  const rows = months
    .map(
      m =>
        `<button type="button" class="admin-row report-row" data-report-open="${esc(m.month)}"><span>${esc(monthLabel(m.month))}${m.month === reportMonths.current ? ' <small class="muted">· en cours</small>' : ""}</span><small class="muted">${m.sessions} séance${m.sessions > 1 ? "s" : ""}</small></button>`
    )
    .join("");
  return `<section class="admin-group pr-category-group ${collapsed ? "collapsed" : ""}" data-pr-category="${key}"><div class="admin-group-title" role="button" tabindex="0" data-toggle-pr-category="${key}" aria-expanded="${!collapsed}"><span class="admin-collapse-indicator">${collapsed ? "＋" : "−"}</span><span>BILANS MENSUELS</span></div><div class="admin-group-body"><div class="report-list">${rows || '<div class="admin-row section-empty"><span>Pas encore de séance enregistrée</span></div>'}</div></div></section>`;
}
function bindReportSection(root) {
  root
    .querySelectorAll(".report-list [data-report-open]")
    .forEach(b => (b.onclick = () => openMonthlyReport(b.dataset.reportOpen)));
}
// Fenêtre du bilan.
let reportShown = null;
async function openMonthlyReport(month) {
  reportShown = month;
  $("#reporttitle").textContent = "Bilan " + ofMonth(monthLabel(month));
  $("#reportbody").innerHTML = '<p class="muted">Chargement…</p>';
  if (!$("#reportdialog").open) $("#reportdialog").showModal();
  try {
    renderMonthlyReport(await api("/monthly-report?month=" + month));
  } catch (e) {
    $("#reportbody").innerHTML = `<p class="error">${esc(e.offline ? OFFLINE_MESSAGE : e.message)}</p>`;
  }
}
function renderMonthlyReport(r) {
  const prev = monthName(previousMonth(r.month)),
    delta = r.total - r.prev_total,
    deltaText = r.prev_total || r.total ? (delta > 0 ? "+" : "") + delta + " par rapport à " + prev : "",
    list = (title, items) =>
      items.length
        ? `<h4 class="progress-title">${title}</h4><ul class="report-list-items">${items.join("")}</ul>`
        : "";
  $("#reportbody").innerHTML =
    (r.complete ? "" : '<p class="hint">Mois en cours : le bilan évolue jusqu’à la fin du mois.</p>') +
    `<div class="progress-tiles"><div><strong>${r.total}</strong><span>séance${r.total > 1 ? "s" : ""}${deltaText ? " · " + esc(deltaText) : ""}</span></div><div><strong>${r.active_weeks}/${r.weeks}</strong><span>semaines actives</span></div><div><strong>${r.days}</strong><span>jour${r.days > 1 ? "s" : ""} d’entraînement</span></div></div>` +
    (r.total
      ? `<h4 class="progress-title">Répartition</h4>${progressBars(PROGRESS_SOURCES.map(([keys, label]) => ({label, value: progressSourceCount(r.by_source, keys)})))}` +
        (r.movements.length
          ? `<h4 class="progress-title">Mouvements les plus travaillés</h4>${progressBars(r.movements.slice(0, 6).map(m => ({label: m.name, value: m.count})))}`
          : "")
      : '<p class="muted">Aucune séance ce mois-ci.</p>') +
    list(
      "À reprendre",
      r.to_resume.map(
        m => `<li>${esc(m.name)} <small class="muted">· travaillé les mois précédents, pas ce mois-ci</small></li>`
      )
    ) +
    list(
      "PR du mois",
      r.prs.map(
        p =>
          `<li>${esc(p.name)} : <b>${esc(prValue(p))}</b>${prFormatLabel(p) ? " · " + esc(prFormatLabel(p)) : ""} <small class="muted">· ${fmt(p.record_date)}</small></li>`
      )
    ) +
    list(
      "Benchmarks",
      r.benchmarks.map(
        b =>
          `<li>${esc(b.name)} : <b>${esc(benchmarkScoreLabel(benchmarkFor(b.benchmark_id), b.value))}</b> ${Number(b.scaled) ? "Scaled" : "Rx"} <small class="muted">· ${fmt(b.result_date)}</small></li>`
      )
    ) +
    (r.box_scores
      ? `<p class="report-line">${r.box_scores} score${r.box_scores > 1 ? "s" : ""} saisi${r.box_scores > 1 ? "s" : ""} sur des WOD de la box.</p>`
      : "") +
    `<h4 class="progress-title">Le mot du coach</h4><div id="reportcomment">${
      r.comment ? `<p class="report-comment">${esc(r.comment)}</p>` : ""
    }${
      reportMonths?.ai && r.total
        ? `<button type="button" class="smallbtn" id="reportcommentbtn">${AI_ICON}<span>${r.comment ? "Nouveau commentaire" : "Demander au coach (IA)"}</span></button>`
        : r.comment
          ? ""
          : '<p class="muted">Pas de commentaire.</p>'
    }</div>`;
  const button = $("#reportcommentbtn");
  if (button)
    button.onclick = async () => {
      button.disabled = true;
      button.querySelector("span").textContent = "Le coach écrit…";
      try {
        const d = await sendApi("/monthly-report/comment", "POST", {month: r.month}, 100000);
        if (reportShown === r.month) renderMonthlyReport({...r, comment: d.comment});
      } catch (e) {
        button.disabled = false;
        button.querySelector("span").textContent = "Demander au coach (IA)";
        toast(e.offline ? OFFLINE_MESSAGE : e.message);
      }
    };
}
$("#closereport").onclick = () => $("#reportdialog").close();
