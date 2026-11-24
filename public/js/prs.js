// FitFactory — records personnels : cartes, graphiques, historique, saisie.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

function isLoadBased(method) {
  return method === "load" || method === "force";
}
// PR ENGINE : « temps sur une distance » (fixed_kind distance : fixed_value en m, valeur = temps en s, le plus court
// gagne) ou « distance dans un temps » (fixed_kind time : fixed_value en s, valeur = distance en m) ; sans format
// (anciens PR) : distance seule en m. Un PR = un mouvement + son format (comme les RM des charges).
const lowerIsBetter = record => record.measurement_method === "distance" && record.fixed_kind === "distance";
function prKey(record) {
  const format = isLoadBased(record.measurement_method)
    ? record.rep_count
    : record.measurement_method === "distance" && record.fixed_kind
      ? record.fixed_kind + "=" + Number(record.fixed_value)
      : record.measurement_method;
  return record.movement_id + ":" + format;
}
// 75 → « 1:15 », 3725 → « 1:02:05 ».
function formatDuration(sec) {
  const t = Math.round(Number(sec)),
    h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
// Durée fixe d'un format : « 12 min », « 1 h », « 1:30 ».
function formatFixedDuration(sec) {
  const t = Number(sec);
  return t % 3600 === 0 ? t / 3600 + " h" : t % 60 === 0 ? t / 60 + " min" : formatDuration(t);
}
// 500 → « 500 m », 2800 → « 2,8 km », 21097.5 → « Semi-marathon ».
function formatDistance(m) {
  const v = Number(m);
  if (v === 21097.5) return "Semi-marathon";
  if (v === 42195) return "Marathon";
  return v >= 1000
    ? (v / 1000).toLocaleString("fr-FR", {maximumFractionDigits: 3}) + " km"
    : v.toLocaleString("fr-FR", {maximumFractionDigits: 1}) + " m";
}
function prValue(record) {
  if (isLoadBased(record.measurement_method)) return Number(record.value).toLocaleString("fr-FR") + " kg";
  if (record.measurement_method === "distance")
    return record.fixed_kind === "distance" ? formatDuration(record.value) : formatDistance(record.value);
  return Number(record.value).toLocaleString("fr-FR") + " reps";
}
// Format d'un PR : « 3 RM », « 2 km », « 12 min » (rien pour les répétitions et les anciennes distances).
function prFormatLabel(record) {
  if (isLoadBased(record.measurement_method)) return record.rep_count + " RM";
  if (record.measurement_method === "distance" && record.fixed_kind)
    return record.fixed_kind === "distance"
      ? formatDistance(record.fixed_value)
      : formatFixedDuration(record.fixed_value);
  return "";
}
// Allure d'un PR ENGINE : au 500 m pour le rameur, au km sinon.
function prPace(record) {
  if (record.measurement_method !== "distance" || !record.fixed_kind) return "";
  const [meters, seconds] =
    record.fixed_kind === "distance"
      ? [Number(record.fixed_value), Number(record.value)]
      : [Number(record.value), Number(record.fixed_value)];
  if (!(meters > 0 && seconds > 0)) return "";
  const rower = /rameur|row|aviron|erg/i.test(record.movement_name || ""),
    per = rower ? 500 : 1000;
  // Distance égale à l'unité d'allure (500 m au rameur, 1 km sinon) : l'allure répéterait le temps.
  if (record.fixed_kind === "distance" && meters === per) return "";
  return formatDuration((seconds * per) / meters) + " /" + (rower ? "500 m" : "km");
}
function renderPrChart(records) {
  const sorted = [...records].sort(
    (a, b) => a.record_date.localeCompare(b.record_date) || a.created_at.localeCompare(b.created_at)
  );
  const width = 340,
    height = 150,
    left = 46,
    right = 8,
    top = 8,
    bottom = 22,
    values = sorted.map(x => Number(x.value)),
    max = Math.max(...values);
  const rawStep = (max || 1) / 4,
    magnitude = Math.pow(10, Math.floor(Math.log10(rawStep))),
    normalized = rawStep / magnitude,
    // Temps : graduations rondes en secondes, minutes ou heures.
    timeSteps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = lowerIsBetter(records[0])
    ? timeSteps.find(x => x >= rawStep) || Math.ceil(rawStep / 3600) * 3600
    : (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const axisMax = step * 4,
    plotHeight = height - top - bottom,
    plotWidth = width - left - right;
  const method = sorted[0].measurement_method,
    timed = lowerIsBetter(sorted[0]),
    unit = method === "load" || method === "force" ? "kg" : timed ? "" : method === "distance" ? "m" : "reps";
  // Temps (PR ENGINE sur une distance) : graduations en mn:s ; un temps qui baisse est un progrès.
  const formatTick = n =>
    timed ? formatDuration(n) : Number(n.toFixed(6)).toLocaleString("fr-FR", {maximumFractionDigits: 2}) + " " + unit;
  const yFor = value => height - bottom - (Number(value) / axisMax) * plotHeight;
  const grid = Array.from({length: 5}, (_, i) => {
    const value = step * i,
      y = yFor(value);
    return (
      '<line x1="' +
      left +
      '" y1="' +
      y +
      '" x2="' +
      (width - right) +
      '" y2="' +
      y +
      '" class="pr-gridline"/><text x="' +
      (left - 7) +
      '" y="' +
      (y + 3) +
      '" text-anchor="end" class="pr-y-label">' +
      esc(formatTick(value)) +
      "</text>"
    );
  }).join("");
  const points = sorted.map((x, i) => ({
    x: left + (sorted.length === 1 ? plotWidth / 2 : (i * plotWidth) / (sorted.length - 1)),
    y: yFor(x.value),
    date: x.record_date,
    value: x.value,
  }));
  const poly = points.map(p => p.x + "," + p.y).join(" ");
  return (
    '<svg class="pr-sparkline" viewBox="0 0 ' +
    width +
    " " +
    height +
    '" role="img" aria-label="Évolution du record' +
    (timed ? " (temps)" : " en " + unit) +
    ", axe vertical de 0 à " +
    esc(formatTick(axisMax)) +
    '">' +
    grid +
    '<line x1="' +
    left +
    '" y1="' +
    top +
    '" x2="' +
    left +
    '" y2="' +
    (height - bottom) +
    '" class="pr-y-axis"/>' +
    (points.length > 1 ? '<polyline points="' + poly + '" class="pr-line"/>' : "") +
    points
      .map(
        p =>
          '<circle cx="' +
          p.x +
          '" cy="' +
          p.y +
          '" r="4" class="pr-point"><title>' +
          esc(p.date) +
          " : " +
          esc(formatTick(Number(p.value))) +
          "</title></circle>"
      )
      .join("") +
    '</svg><div class="pr-chart-dates"><span>' +
    fmt(sorted[0].record_date) +
    "</span><span>" +
    fmt(sorted[sorted.length - 1].record_date) +
    "</span></div>"
  );
}
window.cfPrCategorySections = window.cfPrCategorySections || {};
function renderPrCategory(category, items) {
  const key = "records:" + category,
    label = esc(movementCategoryLabels[category].toUpperCase()),
    collapsed = !!window.cfPrCategorySections[key];
  const content = items
    .map(
      x =>
        '<button type="button" class="pr-card card" data-pr-key="' +
        esc(x.key) +
        '"><h3>' +
        esc(x.movement_name) +
        '</h3><div class="pr-value-line"><strong class="pr-best">' +
        prValue(x.best) +
        "</strong>" +
        (prFormatLabel(x.best) ? '<span class="pr-rm">' + esc(prFormatLabel(x.best)) + "</span>" : "") +
        "</div>" +
        (prPace(x.best) ? '<small class="pr-pace">' + esc(prPace(x.best)) + "</small>" : "") +
        "</button>"
    )
    .join("");
  // Rubrique au style des bandeaux de titre (administration, Mon compte), repliable.
  return (
    '<section class="admin-group pr-category-group ' +
    (collapsed ? "collapsed" : "") +
    '" data-pr-category="' +
    key +
    '"><div class="admin-group-title" role="button" tabindex="0" data-toggle-pr-category="' +
    key +
    '" aria-expanded="' +
    !collapsed +
    '"><span class="admin-collapse-indicator">' +
    (collapsed ? "＋" : "−") +
    "</span><span>" +
    label +
    '</span><button type="button" class="admin-add" data-add-pr="' +
    category +
    '" aria-label="Ajouter un PR ' +
    label +
    '" title="Ajouter un PR">＋</button></div><div class="admin-group-body"><div class="pr-category-body">' +
    (content || '<div class="admin-row section-empty"><span>Pas de PR enregistré</span></div>') +
    "</div></div></section>"
  );
}
// Score de forme (rubrique en tête de la page PR) : calculé par le serveur (GET /api/fitness-score), gardé hors ligne.
let fitnessData = null;
async function loadFitness() {
  try {
    fitnessData = await api("/fitness-score");
  } catch {
    return;
  }
  renderPrs();
}
// Radar : un axe par pilier (0 au centre, 100 au bord) ; un pilier à compléter compte pour 0.
function fitnessRadar(pillars) {
  const n = pillars.length,
    R = 78,
    point = (i, v) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [(Math.cos(a) * R * v) / 100, (Math.sin(a) * R * v) / 100];
    },
    poly = values =>
      values
        .map((v, i) =>
          point(i, v)
            .map(x => x.toFixed(1))
            .join(",")
        )
        .join(" ");
  const grid = [25, 50, 75, 100]
      .map(v => `<polygon class="fitness-radar-grid" points="${poly(pillars.map(() => v))}"/>`)
      .join(""),
    axes = pillars
      .map((_, i) => {
        const [x, y] = point(i, 100);
        return `<line class="fitness-radar-grid" x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      })
      .join(""),
    labels = pillars
      .map((p, i) => {
        const [x, y] = point(i, 118);
        return `<text class="fitness-radar-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${esc(p.label)}</text>`;
      })
      .join("");
  return `<svg class="fitness-radar" viewBox="-150 -104 300 212" role="img" aria-label="Radar des 8 piliers du score de forme">${grid}${axes}<polygon class="fitness-radar-value" points="${poly(pillars.map(p => p.score ?? 0))}"/>${labels}</svg>`;
}
function renderFitness() {
  const d = fitnessData,
    key = "records:fitness",
    collapsed = !!window.cfPrCategorySections[key];
  if (!d) return "";
  // Aucune donnée encore (tous les piliers à 0 ou à compléter) : un message à la place du radar vide.
  const empty = d.pillars.every(p => !p.score),
    total = d.score === null ? "—" : d.score,
    pillars = d.pillars
      .map(
        p =>
          `<div class="fitness-pillar ${p.score === null ? "missing" : ""}"><div class="fitness-pillar-head"><b>${esc(p.label)}</b><span>${p.score === null ? "à compléter" : p.score}</span></div><div class="fitness-bar"><span style="width:${p.score ?? 0}%"></span></div><small>${esc(p.score === null ? p.hint || "" : p.detail || "")}</small></div>`
      )
      .join(""),
    missing = d.profile_missing?.length
      ? `<div class="fitness-profile"><span>Pour un score juste, complète ton profil : ${esc(d.profile_missing.join(", "))}.</span><button type="button" class="smallbtn" data-fitness-profile>Compléter</button></div>`
      : "";
  return `<section class="admin-group pr-category-group fitness-group ${collapsed ? "collapsed" : ""}" data-pr-category="${key}"><div class="admin-group-title" role="button" tabindex="0" data-toggle-pr-category="${key}" aria-expanded="${!collapsed}"><span class="admin-collapse-indicator">${collapsed ? "＋" : "−"}</span><span>SCORE DE FORME</span><span class="fitness-total">${total}<small>/100</small></span></div><div class="admin-group-body"><div class="pr-category-body"><div class="fitness-panel card">${
    empty
      ? `<p class="fitness-empty">Ton score se construit avec tes séances et tes PR : enregistre ta première séance pour le voir apparaître.</p>${missing}`
      : `<div class="fitness-summary">${fitnessRadar(d.pillars)}<div class="fitness-headline"><strong>${total}<small>/100</small></strong><span class="fitness-level">${esc(d.level || "Score à construire")}</span><p>${d.complete ? "Calculé sur tes 8 piliers." : "Calculé sur les piliers renseignés ; les autres sont à compléter."}</p></div></div>${missing}<details class="fitness-details" ${window.cfFitnessDetailOpen ? "open" : ""}><summary>Détail des 8 piliers</summary><div class="fitness-pillars">${pillars}</div></details>`
  }<p class="fitness-note">Score personnel, visible de toi seul. <button type="button" class="fitness-how" data-fitness-how>Comment est-il calculé ?</button></p></div></div></div></section>`;
}
const FITNESS_TABS = [
  ["forme", "Forme"],
  ["records", "Records"],
  ["bilans", "Bilans"],
];
function fitnessTab() {
  if (!window.cfFitnessTab)
    try {
      window.cfFitnessTab = localStorage.getItem("fitfactory-fitness-tab");
    } catch {}
  return FITNESS_TABS.some(([k]) => k === window.cfFitnessTab) ? window.cfFitnessTab : "forme";
}
function renderPrs() {
  const groups = new Map();
  for (const r of prRecords) {
    const key = prKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const catalogOrder = new Map(movementCatalog.map((m, i) => [m.id, i])),
    catalogCategories = new Map(movementCatalog.map(m => [m.id, m.category]));
  const items = [...groups.entries()]
    .map(([key, records]) => {
      records.sort((a, b) => a.record_date.localeCompare(b.record_date) || a.created_at.localeCompare(b.created_at));
      const better = (a, b) =>
          lowerIsBetter(b) ? Number(b.value) < Number(a.value) : Number(b.value) > Number(a.value),
        best = records.reduce((a, b) => (better(a, b) ? b : a));
      return {
        key,
        records,
        best,
        movement_name: best.movement_name,
        movement_id: best.movement_id,
        category: catalogCategories.get(best.movement_id) ?? movementCategory(best),
        measurement_method: best.measurement_method,
        rep_count: best.rep_count,
        fixed_kind: best.fixed_kind,
        fixed_value: best.fixed_value,
      };
    })
    .sort(
      (a, b) =>
        (catalogOrder.get(a.movement_id) ?? Number.MAX_SAFE_INTEGER) -
          (catalogOrder.get(b.movement_id) ?? Number.MAX_SAFE_INTEGER) ||
        (isLoadBased(a.measurement_method) ? Number(a.rep_count) : 0) -
          (isLoadBased(b.measurement_method) ? Number(b.rep_count) : 0) ||
        String(a.fixed_kind || "").localeCompare(String(b.fixed_kind || "")) ||
        Number(a.fixed_value || 0) - Number(b.fixed_value || 0)
    );
  // Une rubrique par famille ayant des mouvements au catalogue (même sans PR), avec son bouton ＋.
  const withMovements = new Set([...movementCatalog.map(movementCategory), ...items.map(x => x.category)]),
    families = Object.keys(movementCategoryLabels).filter(category => withMovements.has(category));
  // Onglet « Mon fitness » : trois sous-onglets (Forme, Records, Bilans), le dernier ouvert est mémorisé.
  const tab = fitnessTab(),
    content =
      tab === "forme"
        ? renderFitness() + renderProgressSection()
        : tab === "bilans"
          ? renderReportSection()
          : (families.length
              ? families
                  .map(category =>
                    renderPrCategory(
                      category,
                      items.filter(x => x.category === category)
                    )
                  )
                  .join("")
              : '<div class="card empty">Aucun mouvement dans le catalogue : l’administrateur doit d’abord en ajouter.</div>') +
            renderBenchmarkSection();
  $("#prcards").innerHTML =
    '<div class="fitness-tabs" role="tablist" aria-label="Mon fitness">' +
    FITNESS_TABS.map(
      ([key, label]) =>
        `<button type="button" role="tab" class="fitness-tab ${key === tab ? "active" : ""}" aria-selected="${key === tab}" data-fitness-tab="${key}">${label}</button>`
    ).join("") +
    "</div>" +
    content;
  const body = $("#prcards");
  body.hidden = false;
  body.querySelectorAll("[data-fitness-tab]").forEach(
    b =>
      (b.onclick = () => {
        try {
          localStorage.setItem("fitfactory-fitness-tab", b.dataset.fitnessTab);
        } catch {}
        window.cfFitnessTab = b.dataset.fitnessTab;
        renderPrs();
      })
  );
  body.querySelectorAll("[data-toggle-pr-category]").forEach(button => {
    const toggle = () => {
      const key = button.dataset.togglePrCategory,
        isCollapsed = !window.cfPrCategorySections[key];
      window.cfPrCategorySections[key] = isCollapsed;
      button.closest(".pr-category-group").classList.toggle("collapsed", isCollapsed);
      button.setAttribute("aria-expanded", String(!isCollapsed));
      button.querySelector(".admin-collapse-indicator").textContent = isCollapsed ? "＋" : "−";
    };
    button.onclick = e => {
      if (!e.target.closest(".admin-add")) toggle();
    };
    button.onkeydown = e => {
      if (e.target === button && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        toggle();
      }
    };
  });
  body.querySelectorAll("[data-add-pr]").forEach(b => (b.onclick = () => openPrForm(null, b.dataset.addPr)));
  bindBenchmarkSection(body);
  bindProgressSection(body);
  bindReportSection(body);
  body.querySelectorAll("[data-fitness-profile]").forEach(b => (b.onclick = () => switchView("account")));
  // Détail des piliers replié par défaut ; l’état reste le même quand la page se redessine.
  body.querySelectorAll(".fitness-details").forEach(d => (d.ontoggle = () => (window.cfFitnessDetailOpen = d.open)));
  body.querySelectorAll("[data-fitness-how]").forEach(b => (b.onclick = () => $("#fitnesshowdialog").showModal()));
  body
    .querySelectorAll("[data-pr-key]")
    .forEach(button => (button.onclick = () => openPrHistory(button.dataset.prKey)));
}
function openPrHistory(key) {
  const records = prRecords
    .filter(r => prKey(r) === key)
    .sort((a, b) => b.record_date.localeCompare(a.record_date) || b.created_at.localeCompare(a.created_at));
  if (!records.length) return;
  const first = records[0],
    label = prFormatLabel(first) || (first.measurement_method === "distance" ? "Distance" : "Répétitions");
  $("#prhistorytitle").textContent = first.movement_name + " · " + label;
  $("#prhistorychart").innerHTML = renderPrChart(records);
  $("#prhistorylist").innerHTML =
    '<div class="pr-history-section-title">Liste des valeurs</div>' +
    records
      .map(
        r =>
          '<div class="pr-history-row"><span class="pr-history-date">' +
          fmt(r.record_date) +
          "</span><strong>" +
          prValue(r) +
          (prPace(r) ? ' <small class="pr-pace">' + esc(prPace(r)) + "</small>" : "") +
          '</strong><div class="entryactions"><button type="button" class="smallbtn" data-edit-pr="' +
          r.id +
          '" aria-label="Modifier ce PR" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button type="button" class="smallbtn delete" data-delete-pr="' +
          r.id +
          '" aria-label="Supprimer ce PR" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div></div>'
      )
      .join("");
  $("#prhistorylist")
    .querySelectorAll("[data-edit-pr]")
    .forEach(
      b =>
        (b.onclick = () => {
          const record = prRecords.find(x => x.id === b.dataset.editPr);
          if (record) {
            $("#prhistorydialog").close();
            openPrForm(record);
          }
        })
    );
  $("#prhistorylist")
    .querySelectorAll("[data-delete-pr]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (!confirm("Supprimer définitivement ce PR ?")) return;
          try {
            await api("/prs/" + b.dataset.deletePr, {method: "DELETE"});
            await loadPrs();
            const remaining = prRecords.filter(r => prKey(r) === key);
            if (remaining.length) openPrHistory(key);
            else $("#prhistorydialog").close();
            toast("PR supprimé.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#prhistorydialog").showModal();
}
function syncPrForm() {
  const f = $("#prform"),
    movement = movementCatalog.find(m => m.id === f.elements.movement_id.value),
    method = movement?.measurement_method,
    load = isLoadBased(method),
    distance = method === "distance";
  $("#prvaluelabel").textContent = load ? "Charge (kg)" : distance ? "Distance (m)" : "Nombre de répétitions";
  $("#prvalue").step = load ? "0.5" : distance ? "0.1" : "1";
  $("#prvalue").min = load ? "0.5" : distance ? "0.1" : "1";
  $("#prvalue").placeholder = load ? "Ex. 80" : distance ? "Ex. 500" : "Ex. 15";
  $("#prrmfield").hidden = !load;
  f.elements.rep_count.required = load;
  f.elements.rep_count.disabled = !load;
  // ENGINE : format (temps sur une distance / distance dans un temps), valeur fixe, puis temps ou distance réalisé.
  const kind = f.elements.fixed_kind.value,
    onDistance = distance && kind === "distance",
    onTime = distance && kind === "time";
  $("#prvaluefield").hidden = distance;
  f.elements.value.required = !distance;
  f.elements.value.disabled = distance;
  $("#prenginefields").hidden = !distance;
  $("#prfixeddistancefield").hidden = !onDistance;
  $("#prfixedtimefield").hidden = !onTime;
  $("#protherdistance").hidden = !(onDistance && f.elements.fixed_distance.value === "other");
  $("#prothertime").hidden = !(onTime && f.elements.fixed_time.value === "other");
  $("#prtimefield").hidden = !onDistance;
  $("#prdistancefield").hidden = !onTime;
}
// Temps saisi en heures / minutes / secondes (cases séparées) → secondes ; null si vide ou invalide.
function readTime(f, prefix) {
  const raw = ["h", "min", "sec"].map(k => f.elements[prefix + "_" + k].value.trim());
  if (raw.every(x => x === "")) return null;
  const [h, m, sec] = raw.map(x => (x === "" ? 0 : Number(x)));
  if (![h, m, sec].every(x => Number.isInteger(x) && x >= 0) || sec > 59) return null;
  const total = h * 3600 + m * 60 + sec;
  return total > 0 ? total : null;
}
function fillTime(f, prefix, seconds) {
  const t = Math.round(Number(seconds));
  f.elements[prefix + "_h"].value = Math.floor(t / 3600) || "";
  f.elements[prefix + "_min"].value = Math.floor((t % 3600) / 60);
  f.elements[prefix + "_sec"].value = t % 60;
}
// Valeurs du formulaire ENGINE → {fixed_kind, fixed_value, value} (ou {error}).
function readEnginePr(f) {
  const el = f.elements,
    kind = el.fixed_kind.value,
    meters = (v, unit) => Number(String(v).replace(",", ".")) * (unit === "km" ? 1000 : 1);
  if (kind === "distance") {
    const fixed =
        el.fixed_distance.value === "other"
          ? meters(el.other_distance.value, el.other_distance_unit.value)
          : Number(el.fixed_distance.value),
      time = readTime(f, "duration");
    if (!(fixed > 0)) return {error: "Indique la distance."};
    if (!time) return {error: "Indique ton temps en minutes et secondes (secondes de 0 à 59)."};
    return {fixed_kind: kind, fixed_value: Math.round(fixed * 10) / 10, value: time};
  }
  const fixed = el.fixed_time.value === "other" ? readTime(f, "other_time") : Number(el.fixed_time.value),
    dist = meters(el.distance.value, el.distance_unit.value);
  if (!fixed) return {error: "Indique la durée en minutes et secondes (secondes de 0 à 59)."};
  if (!(dist > 0)) return {error: "Indique la distance parcourue."};
  return {fixed_kind: kind, fixed_value: fixed, value: Math.round(dist * 10) / 10};
}
// Formulaire ENGINE pré-rempli pour la modification d'un PR.
function fillEnginePr(f, record) {
  const el = f.elements;
  el.fixed_kind.value = record.fixed_kind === "distance" ? "distance" : "time";
  if (record.fixed_kind === "distance") {
    const preset = [...el.fixed_distance.options].some(o => Number(o.value) === Number(record.fixed_value));
    el.fixed_distance.value = preset ? String(Number(record.fixed_value)) : "other";
    if (!preset) {
      el.other_distance.value = record.fixed_value;
      el.other_distance_unit.value = "m";
    }
    fillTime(f, "duration", record.value);
  } else {
    if (record.fixed_kind === "time") {
      const preset = [...el.fixed_time.options].some(o => Number(o.value) === Number(record.fixed_value));
      el.fixed_time.value = preset ? String(Number(record.fixed_value)) : "other";
      if (!preset) fillTime(f, "other_time", record.fixed_value);
    }
    el.distance.value = record.value;
    el.distance_unit.value = "m";
  }
}
// Ouvre le formulaire de PR : vide pour une création, pré-rempli pour la modification d'un PR existant.
// category : famille choisie avec le ＋ d’une rubrique (seuls ses mouvements sont proposés).
function openPrForm(record = null, category = "") {
  const f = $("#prform");
  f.reset();
  f.elements.record_date.value = today();
  f.elements.movement_id.innerHTML = movementCatalog
    .filter(m => !category || movementCategory(m) === category)
    .map(m => '<option value="' + m.id + '">' + esc(m.name) + "</option>")
    .join("");
  f.elements.pr_id.value = record?.id || "";
  if (record) {
    f.elements.movement_id.value = record.movement_id;
    f.elements.record_date.value = record.record_date;
    f.elements.value.value = record.value;
    if (record.rep_count) f.elements.rep_count.value = String(record.rep_count);
    if (record.measurement_method === "distance") fillEnginePr(f, record);
  }
  $("#prformtitle").textContent = record ? "Modifier le PR" : "Nouveau PR";
  $("#prformsubmit").textContent = record ? "Enregistrer les modifications" : "Enregistrer le PR";
  $("#prformerror").textContent = "";
  syncPrForm();
  if (!f.elements.movement_id.options.length) {
    toast("Aucun mouvement disponible dans le catalogue.");
    return;
  }
  $("#prdialog").showModal();
}
$("#closepr").onclick = () => $("#prdialog").close();
$("#prform").elements.movement_id.onchange = syncPrForm;
for (const name of ["fixed_kind", "fixed_distance", "fixed_time"]) $("#prform").elements[name].onchange = syncPrForm;
$("#prform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target,
    movement = movementCatalog.find(m => m.id === f.elements.movement_id.value);
  if (!movement) {
    $("#prformerror").textContent = "Sélectionne un mouvement.";
    return;
  }
  const body = {
    movement_id: movement.id,
    record_date: f.elements.record_date.value,
    value: Number(f.elements.value.value),
    rep_count: isLoadBased(movement.measurement_method) ? Number(f.elements.rep_count.value) : null,
  };
  if (movement.measurement_method === "distance") {
    const engine = readEnginePr(f);
    if (engine.error) {
      $("#prformerror").textContent = engine.error;
      return;
    }
    Object.assign(body, engine);
  }
  try {
    await api(f.elements.pr_id.value ? "/prs/" + f.elements.pr_id.value : "/prs", {
      method: f.elements.pr_id.value ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#prdialog").close();
    await loadPrs();
    toast(f.elements.pr_id.value ? "PR modifié." : "PR enregistré.");
  } catch (err) {
    $("#prformerror").textContent = err.message;
  }
};

$("#toggle-catalog-reorder").onclick = () => {
  window.cfCatalogReorder = !window.cfCatalogReorder;
  if (renderAdmin.last) renderAdmin(...renderAdmin.last);
};
$("#closeprhistory").onclick = () => $("#prhistorydialog").close();
$("#closefitnesshow").onclick = () => $("#fitnesshowdialog").close();
