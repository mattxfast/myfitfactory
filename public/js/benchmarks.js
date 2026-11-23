// myFitFactory — WOD de référence (benchmarks : Fran, Cindy, Murph…) : tirage au sort (🎲 de la carte « Nombre de séances »)
// (sans IA, gratuit, possible hors ligne), score saisi avec la séance, suivi des résultats dans la page PR.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

let benchmarks = [],
  benchmarkResults = [];
const DICE_ICON =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="9" cy="15" r="1"/><circle cx="15" cy="15" r="1"/></svg>';
const benchmarkFor = id => benchmarks.find(b => b.id === id) || null;
// Liste (gardée sur le téléphone : tirage hors ligne) et résultats ; sans réseau ni copie, la page reste utilisable.
async function loadBenchmarks() {
  try {
    const [list, results] = await Promise.all([api("/benchmarks"), api("/benchmark-results")]);
    benchmarks = list.benchmarks || [];
    benchmarkResults = results.results || [];
  } catch {}
  if (!$("#view-prs").hidden) renderPrs();
}
// Score : temps « 6:12 », ou tours et répétitions pour un AMRAP (« 12 tours + 5 »).
function benchmarkScoreLabel(b, value) {
  const v = Number(value);
  if (b?.score === "time") return formatDuration(v);
  if (b?.round_reps) {
    const rounds = Math.floor(v / b.round_reps),
      extra = v % b.round_reps;
    return rounds + (rounds > 1 ? " tours" : " tour") + (extra ? " + " + extra : "");
  }
  return v + " rép.";
}
const benchmarkBetter = (b, x, y) =>
  b.score === "time" ? Number(x.value) < Number(y.value) : Number(x.value) > Number(y.value);
// Meilleur résultat : en Rx s’il y en a un, sinon en Scaled.
function benchmarkBest(b, results) {
  const rx = results.filter(x => !Number(x.scaled)),
    pool = rx.length ? rx : results;
  return pool.reduce((best, x) => (!best || benchmarkBetter(b, x, best) ? x : best), null);
}

// ----- Page PR : rubrique « BENCHMARKS » (une carte par WOD de référence fait, historique, saisie à la main) -----
function renderBenchmarkSection() {
  const key = "records:benchmarks",
    collapsed = !!window.cfPrCategorySections[key],
    done = benchmarks
      .map(b => ({b, results: benchmarkResults.filter(x => x.benchmark_id === b.id)}))
      .filter(x => x.results.length);
  const cards = done
    .map(({b, results}) => {
      const best = benchmarkBest(b, results);
      return `<button type="button" class="pr-card card" data-benchmark-key="${esc(b.id)}"><h3>${esc(b.name)}</h3><div class="pr-value-line"><strong class="pr-best">${esc(benchmarkScoreLabel(b, best.value))}</strong><span class="pr-rm">${Number(best.scaled) ? "Scaled" : "Rx"}</span></div><small class="pr-pace">${results.length} résultat${results.length > 1 ? "s" : ""}</small></button>`;
    })
    .join("");
  return `<section class="admin-group pr-category-group ${collapsed ? "collapsed" : ""}" data-pr-category="${key}"><div class="admin-group-title" role="button" tabindex="0" data-toggle-pr-category="${key}" aria-expanded="${!collapsed}"><span class="admin-collapse-indicator">${collapsed ? "＋" : "−"}</span><span>BENCHMARKS</span><button type="button" class="admin-add" data-add-benchmark aria-label="Ajouter un résultat de benchmark" title="Ajouter un résultat">＋</button></div><div class="admin-group-body"><div class="pr-category-body">${cards || '<div class="admin-row section-empty"><span>Pas de benchmark réalisé</span></div>'}</div></div></section>`;
}
function bindBenchmarkSection(root) {
  root.querySelectorAll("[data-add-benchmark]").forEach(b => (b.onclick = () => openBenchmarkResultForm()));
  root
    .querySelectorAll("[data-benchmark-key]")
    .forEach(b => (b.onclick = () => openBenchmarkHistory(b.dataset.benchmarkKey)));
}
// Historique d’un benchmark (fenêtre de l’historique des PR) : courbe et liste, Rx / Scaled, séance ou saisie.
function openBenchmarkHistory(id) {
  const b = benchmarkFor(id),
    results = benchmarkResults
      .filter(x => x.benchmark_id === id)
      .sort((x, y) => y.result_date.localeCompare(x.result_date) || String(y.created_at).localeCompare(x.created_at));
  if (!b || !results.length) return;
  $("#prhistorytitle").textContent = b.name + " · " + (b.score === "time" ? "Temps" : "Tours et répétitions");
  // Courbe : temps (le plus court est le meilleur) ou répétitions, au format des PR.
  $("#prhistorychart").innerHTML = renderPrChart(
    results.map(x => ({
      ...x,
      record_date: x.result_date,
      created_at: String(x.created_at || ""),
      measurement_method: b.score === "time" ? "distance" : "reps",
      fixed_kind: b.score === "time" ? "distance" : null,
    }))
  );
  $("#prhistorylist").innerHTML =
    '<div class="pr-history-section-title">Liste des résultats</div>' +
    results
      .map(
        x =>
          `<div class="pr-history-row"><span class="pr-history-date">${fmt(x.result_date)}</span><strong>${esc(benchmarkScoreLabel(b, x.value))} <small class="pr-pace">${Number(x.scaled) ? "Scaled" : "Rx"}${x.source === "session" ? " · séance" : ""}</small></strong><div class="entryactions">${
            x.source === "manual"
              ? `<button type="button" class="smallbtn delete" data-delete-benchmark-result="${esc(x.id)}" aria-label="Supprimer ce résultat" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>`
              : ""
          }</div></div>`
      )
      .join("") +
    '<p class="hint">Un résultat issu d’une séance se modifie ou se supprime depuis l’historique des séances.</p>';
  $("#prhistorylist")
    .querySelectorAll("[data-delete-benchmark-result]")
    .forEach(
      button =>
        (button.onclick = async () => {
          if (!confirm("Supprimer ce résultat ?")) return;
          try {
            await api("/benchmark-results/" + button.dataset.deleteBenchmarkResult, {method: "DELETE"});
            benchmarkResults = benchmarkResults.filter(x => x.id !== button.dataset.deleteBenchmarkResult);
            renderPrs();
            if (benchmarkResults.some(x => x.benchmark_id === id)) openBenchmarkHistory(id);
            else $("#prhistorydialog").close();
            toast("Résultat supprimé.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  if (!$("#prhistorydialog").open) $("#prhistorydialog").showModal();
}
// Champs du score selon le benchmark : temps (min : s) ou tours + répétitions (AMRAP).
function benchmarkScoreFields(b, value = null) {
  const v = value === null || value === undefined || value === "" ? null : Number(value);
  if (b.score === "time")
    return `<label>Temps (min : s)<span class="score-time"><input name="score_min" type="number" min="0" max="1440" step="1" inputmode="numeric" placeholder="min" value="${v === null ? "" : Math.floor(v / 60)}"><span>:</span><input name="score_sec" type="number" min="0" max="59" step="1" inputmode="numeric" placeholder="s" value="${v === null ? "" : v % 60}"></span></label>`;
  const rr = b.round_reps || 1;
  return `<label>Tours + répétitions<span class="score-time"><input name="score_rounds" type="number" min="0" max="999" step="1" inputmode="numeric" placeholder="tours" value="${v === null ? "" : Math.floor(v / rr)}"><span>+</span><input name="score_extra" type="number" min="0" max="${rr - 1}" step="1" inputmode="numeric" placeholder="rép." value="${v === null ? "" : v % rr}"></span></label>`;
}
// Valeur saisie (null si vide) : secondes, ou total de répétitions.
function readBenchmarkScore(b, f) {
  if (b.score === "time") {
    const mn = f.score_min.value,
      sec = f.score_sec.value;
    if (mn === "" && sec === "") return {value: null};
    const v = Number(mn || 0) * 60 + Number(sec || 0);
    if (!Number.isInteger(v) || v < 1 || Number(sec || 0) > 59)
      return {error: "Temps invalide : minutes et secondes (0 à 59)."};
    return {value: v};
  }
  const rounds = f.score_rounds.value,
    extra = f.score_extra.value,
    rr = b.round_reps || 1;
  if (rounds === "" && extra === "") return {value: null};
  const v = Number(rounds || 0) * rr + Number(extra || 0);
  if (!Number.isInteger(v) || v < 1 || Number(extra || 0) >= rr)
    return {error: "Score invalide : tours, puis répétitions du tour entamé (moins de " + rr + ")."};
  return {value: v};
}
function openBenchmarkResultForm() {
  const form = $("#benchresultform"),
    f = form.elements;
  form.reset();
  f.benchmark_id.innerHTML = [...benchmarks]
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map(b => `<option value="${esc(b.id)}">${esc(b.name)} (${esc(b.kind)})</option>`)
    .join("");
  f.result_date.value = today();
  f.result_date.max = today();
  const sync = () => {
    const b = benchmarkFor(f.benchmark_id.value);
    $("#benchresultscore").innerHTML = b ? benchmarkScoreFields(b) : "";
  };
  f.benchmark_id.onchange = sync;
  sync();
  $("#benchresulterror").textContent = benchmarks.length ? "" : "Liste indisponible hors ligne pour l’instant.";
  $("#benchresultdialog").showModal();
}
$("#benchresultform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    b = benchmarkFor(f.benchmark_id.value);
  if (!b) return;
  const score = readBenchmarkScore(b, f);
  if (score.error || score.value === null) {
    $("#benchresulterror").textContent = score.error || "Indique ton score.";
    return;
  }
  const body = {
    client_id: crypto.randomUUID(),
    benchmark_id: b.id,
    result_date: f.result_date.value,
    value: score.value,
    scaled: f.scaled.checked,
    comment: f.comment.value.trim(),
  };
  try {
    await api("/benchmark-results", {method: "POST", body: JSON.stringify(body)});
    benchmarkResults = [
      ...benchmarkResults.filter(x => x.id !== body.client_id),
      {
        ...body,
        id: body.client_id,
        scaled: body.scaled ? 1 : 0,
        source: "manual",
        created_at: new Date().toISOString(),
      },
    ];
    $("#benchresultdialog").close();
    renderPrs();
    toast("Résultat enregistré.");
  } catch (x) {
    $("#benchresulterror").textContent = x.message;
  }
};

// ----- Bouton 🎲 de la page Séances : tirage d’un WOD de référence parmi toute la liste (sans choix du lieu) -----
const benchmarkCandidates = () => [...benchmarks].sort((a, b) => a.name.localeCompare(b.name, "fr"));
function showBenchmarkPreview() {
  const f = $("#benchform").elements,
    b = benchmarkFor(f.benchmark_id.value);
  $("#benchpreview").innerHTML = b
    ? `<p class="muted">${esc(b.kind)} · ~${b.minutes} min · ${b.score === "time" ? "temps" : "tours et répétitions"}</p><p class="daily-detail-body">${esc(String(b.content).replace(/^[^\n]*\n+/, ""))}</p>`
    : "";
  $("#benchsubmit").disabled = !b;
}
function drawBenchmark() {
  const f = $("#benchform").elements,
    list = benchmarkCandidates(),
    others = list.filter(b => b.id !== f.benchmark_id.value),
    pool = others.length ? others : list;
  f.benchmark_id.innerHTML = list
    .map(b => `<option value="${esc(b.id)}">${esc(b.name)} (${esc(b.kind)})</option>`)
    .join("");
  if (pool.length) f.benchmark_id.value = pool[Math.floor(Math.random() * pool.length)].id;
  showBenchmarkPreview();
}
function openBenchmarkDraw() {
  const form = $("#benchform"),
    f = form.elements;
  form.reset();
  const days = [today(), addDays(today(), 1)];
  f.wod_date.innerHTML = days
    .map(d => `<option value="${d}">${esc(dailyDayLabel(d) + " (" + wodDay(d) + ")")}</option>`)
    .join("");
  f.wod_date.value = dailyDefaultDate();
  $("#bencherror").textContent = benchmarks.length
    ? ""
    : "La liste des WOD de référence n’est pas encore sur ce téléphone : reconnecte-toi une fois au réseau.";
  f.benchmark_id.onchange = showBenchmarkPreview;
  drawBenchmark();
  $("#benchdialog").showModal();
}
$("#benchreroll").onclick = drawBenchmark;
$("#benchform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    body = {client_id: crypto.randomUUID(), benchmark_id: f.benchmark_id.value, wod_date: f.wod_date.value};
  if (!benchmarkFor(body.benchmark_id)) return;
  $("#benchsubmit").disabled = true;
  try {
    // Hors ligne : mis en file d’attente et affiché tout de suite (identifiant créé sur le téléphone).
    await api("/daily-wods/benchmark", {method: "POST", body: JSON.stringify(body)});
    $("#benchdialog").close();
    await loadSessions();
    toast("WOD de référence ajouté : bon courage !");
  } catch (x) {
    $("#bencherror").textContent = x.message;
  } finally {
    $("#benchsubmit").disabled = false;
  }
};
