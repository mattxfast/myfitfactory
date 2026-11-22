// FitFactory — saisie et modification d’une séance, planification d’un WOD.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

function defaultActivity() {
  return activities.find(a => a.is_default) || activities[0];
}
function fillActivitySelect(select, selected = "") {
  select.innerHTML = activities
    .filter(a => a.is_active)
    .map(a => `<option value="${a.id}">${esc(a.name)}</option>`)
    .join("");
  if (selected) select.value = selected;
  else if (defaultActivity()) select.value = defaultActivity().id;
}
// Les WOD et les séances de référence suivent la date saisie, même hors de la semaine affichée.
let sessionFormWeek = null,
  editedSession = null;
function loadSessionFormWeek(date, onLoaded) {
  const week = mondayOf(date || today()),
    data = {week, sessions: null, boxWods: [], dailyWods: []};
  sessionFormWeek = data;
  if (week === loadedSessionWeek) {
    Object.assign(data, {sessions, boxWods, dailyWods});
    return;
  }
  api("/week-data?from=" + week + "&to=" + addDays(week, 6))
    .then(d => {
      if (sessionFormWeek !== data || !$("#sessiondialog").open) return;
      data.sessions = d.sessions;
      data.boxWods = rememberBoxWods(d.boxWods);
      data.dailyWods = rememberDailyWods(d.dailyWods);
    })
    .catch(() => {
      data.sessions = [];
    })
    .then(() => {
      if (sessionFormWeek === data && $("#sessiondialog").open) onLoaded();
    });
}
// WOD de box choisi dans la liste (valeur « box:<id> »), sinon null.
function selectedBoxWod() {
  const v = $("#sessionform").elements.wod_id.value || "";
  return v.startsWith("box:") ? boxWodsById.get(v.slice(4)) || null : null;
}
// WOD du jour choisi dans la liste (valeur « daily:<id> »), sinon null.
function selectedDailyWod() {
  const v = $("#sessionform").elements.wod_id.value || "";
  return v.startsWith("daily:") ? dailyWodsById.get(v.slice(6)) || null : null;
}
function selectedProgramWod() {
  const f = $("#sessionform").elements;
  return (wodsByProgram[f.program_id.value] || []).find(w => w.id === f.wod_id.value);
}
function fillWodOptions(pid, selected = "") {
  const fields = $("#sessionform").elements,
    f = fields.wod_id,
    date = fields.session_date.value || today(),
    weekSessions = sessionFormWeek.sessions || [],
    done = new Set(weekSessions.map(s => s.wod_id)),
    ws = pid === "none" ? [] : visibleWods(pid).filter(w => w.id === editedSession?.wod_id || !done.has(w.id)),
    list = sessionFormWeek.boxWods.filter(
      w => w.wod_date <= today() && (w.id === editedSession?.box_wod_id || !datedWodDone(w, "box_wod_id", weekSessions))
    ),
    dailyList = sessionFormWeek.dailyWods.filter(
      w =>
        w.wod_date <= today() &&
        (w.id === editedSession?.daily_wod_id || !datedWodDone(w, "daily_wod_id", weekSessions))
    );
  const originalBox = boxWodsById.get(editedSession?.box_wod_id),
    originalDaily = dailyWodsById.get(editedSession?.daily_wod_id);
  if (originalBox && !list.some(w => w.id === originalBox.id)) list.push(originalBox);
  if (originalDaily && !dailyList.some(w => w.id === originalDaily.id)) dailyList.push(originalDaily);
  const severalBoxes = new Set(list.map(w => w.box_id)).size > 1,
    programOptions = ws.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join(""),
    boxOptions = list
      .map(
        w =>
          `<option value="box:${w.id}">${esc(wodDay(w.wod_date) + " · " + boxWodLabel(w) + (severalBoxes ? " (" + w.box_name + ")" : ""))}</option>`
      )
      .join("");
  const dailyOptions = dailyList
    .sort((a, b) => a.wod_date.localeCompare(b.wod_date))
    .map(w => `<option value="daily:${w.id}">${esc(wodDay(w.wod_date) + " · " + w.title)}</option>`)
    .join("");
  // WOD du jour : à la suite des WOD de la programmation, dans le même groupe « WOD Perso » (comme la rubrique de la
  // page Séances).
  const planned = programOptions + dailyOptions;
  f.innerHTML =
    (boxOptions
      ? (planned ? `<optgroup label="WOD Perso">${planned}</optgroup>` : "") +
        `<optgroup label="WOD de la box">${boxOptions}</optgroup>`
      : planned) + `<option value="other">Autres</option>`;
  if (!selected && pid === "none") {
    // Parmi les WOD disponibles, privilégie celui du jour, puis celui de la box à la date de la séance.
    const daily = dailyList.find(w => w.wod_date === date),
      box = list.find(w => w.wod_date === date);
    selected = daily ? "daily:" + daily.id : box ? "box:" + box.id : "";
  }
  if (selected) f.value = selected;
  if (f.selectedIndex < 0) f.selectedIndex = 0;
  f.disabled = sessionFormWeek.sessions === null;
  syncSessionWod();
}
// Mouvements (catalogue pour un WOD de box ou « hors programme ») et score selon le WOD choisi.
function syncSessionWod(session = null) {
  const f = $("#sessionform"),
    boxWod = selectedBoxWod(),
    dailyWod = selectedDailyWod(),
    box = $("#sessionmovementchecks");
  // WOD de box, WOD du jour ou « Autres » : tous les mouvements du catalogue ; sinon ceux du programme (ou le
  // catalogue s’il n’en a pas).
  renderSessionMovementChecks(
    boxWod || dailyWod || f.elements.wod_id.value === "other" ? "none" : f.elements.program_id.value,
    f.elements.session_id.value
  );
  // Nouvelle séance sur un WOD du jour : les mouvements reconnus dans le WOD sont cochés par défaut.
  if (dailyWod && !f.elements.session_id.value && box.dataset.presetWod !== "daily:" + dailyWod.id) {
    const preset = new Set(dailyWod.movement_ids || []);
    box.querySelectorAll('input[name="catalog_movement_ids"]').forEach(i => (i.checked = preset.has(i.value)));
    box.dataset.presetWod = "daily:" + dailyWod.id;
  }
  // Nouvelle séance sur un WOD de la programmation : ses mouvements à travailler sont cochés par défaut, une seule fois
  // par WOD choisi (dans la liste du programme, ou ajoutés en fin de liste).
  const programWod = selectedProgramWod();
  if (
    !boxWod &&
    !dailyWod &&
    programWod?.movement_ids?.length &&
    !f.elements.session_id.value &&
    box.dataset.presetWod !== "wod:" + programWod.id
  ) {
    const preset = movementCatalog.filter(cm => programWod.movement_ids.includes(cm.id)),
      programItems = movementsByProgram[f.elements.program_id.value] || [];
    box.querySelectorAll("input").forEach(i => {
      i.checked =
        i.name === "catalog_movement_ids"
          ? preset.some(cm => cm.id === i.value)
          : preset.some(cm => sameMovement(programItems.find(pm => pm.id === i.value) || {name: ""}, cm));
    });
    box.dataset.presetWod = "wod:" + programWod.id;
  }
  // Nouvelle séance sur un WOD de box : ses mouvements (cochés par le gestionnaire) sont cochés par défaut,
  // une seule fois par WOD choisi ; l’utilisateur peut ensuite les modifier.
  if (boxWod && !f.elements.session_id.value && box.dataset.presetWod !== boxWod.id) {
    const preset = new Set(boxWod.movement_ids || []);
    box.querySelectorAll('input[name="catalog_movement_ids"]').forEach(i => (i.checked = preset.has(i.value)));
    box.dataset.presetWod = boxWod.id;
  }
  renderSessionScore(session);
  syncSessionMovementCount();
}
// Liste des mouvements repliée par défaut : le titre indique combien sont cochés.
function syncSessionMovementCount() {
  const n = $("#sessionmovementchecks").querySelectorAll("input:checked").length;
  $("#sessionmovementcount").textContent = n ? n + (n > 1 ? " cochés" : " coché") : "aucun coché";
}
$("#sessionmovementchecks").onchange = syncSessionMovementCount;
function applySessionWodDefaults() {
  const fields = $("#sessionform").elements,
    wod = selectedProgramWod();
  fillActivitySelect(fields.activity_id, wod?.activity_id || defaultActivity()?.id);
  fields.duration_minutes.value = wod?.duration_minutes || defaultActivity()?.duration_minutes || 60;
}
$("#sessionform").elements.program_id.onchange = e => {
  fillWodOptions(e.target.value);
  applySessionWodDefaults();
  applyPlannedSessionNote();
};
function applyPlannedSessionNote() {
  const f = $("#sessionform"),
    field = f.elements.actual_comment,
    previous = field.dataset.plannedDefault || "";
  if (field.value === previous || !field.value.trim()) {
    const boxWod = selectedBoxWod(),
      dailyWod = selectedDailyWod(),
      wod = (wodsByProgram[f.elements.program_id.value] || []).find(x => x.id === f.elements.wod_id.value);
    const week = mondayOf(f.elements.session_date.value || today());
    const planned = boxWod
      ? boxWod.content || ""
      : dailyWod
        ? dailyWod.content || ""
        : wod
          ? weeklyWodContent(wod.id, week) || wod.planned_comment || ""
          : "";
    field.value = planned;
    field.dataset.plannedDefault = planned;
  }
  fitSessionNote();
}
// « Réalisé / notes » : 3 lignes au repos, la zone s’agrandit pendant la saisie (jusqu’à environ 12 lignes).
function fitSessionNote() {
  const field = $("#sessionform").elements.actual_comment;
  field.style.height = "";
  if (document.activeElement === field) field.style.height = Math.min(field.scrollHeight + 2, 300) + "px";
}
$("#sessionform").elements.actual_comment.addEventListener("input", fitSessionNote);
$("#sessionform").elements.actual_comment.addEventListener("focus", fitSessionNote);
$("#sessionform").elements.wod_id.onchange = e => {
  const w = (wodsByProgram[$("#sessionform").elements.program_id.value] || []).find(x => x.id === e.target.value);
  if (w) {
    fillActivitySelect($("#sessionform").elements.activity_id, w.activity_id || defaultActivity()?.id);
    $("#sessionform").elements.duration_minutes.value = w.duration_minutes || defaultActivity()?.duration_minutes || 60;
  }
  syncSessionWod();
  applyPlannedSessionNote();
};
$("#sessionform").elements.session_date.onchange = e => {
  const fields = $("#sessionform").elements,
    selected = fields.wod_id.value,
    refill = () => {
      fillWodOptions(fields.program_id.value, selected);
      if (!editedSession && !fields.wod_id.disabled && fields.wod_id.value !== selected) applySessionWodDefaults();
      applyPlannedSessionNote();
    };
  if (mondayOf(e.target.value || today()) !== sessionFormWeek.week) {
    loadSessionFormWeek(e.target.value, refill);
    refill();
  } else applyPlannedSessionNote();
};
// Score d’un WOD de box : catégorie de la box et valeur selon le type (temps, répétitions, charge).
// WOD de référence choisi comme WOD du jour : son score (temps ou tours) est suivi dans la page PR.
function selectedBenchmark() {
  const d = selectedDailyWod();
  return d?.benchmark_id ? benchmarkFor(d.benchmark_id) : null;
}
function renderSessionScore(session = null) {
  const f = $("#sessionform").elements,
    boxWod = selectedBoxWod(),
    bench = !boxWod && selectedBenchmark(),
    programWod = selectedProgramWod(),
    box = $("#scoreinputs"),
    savedType = session
      ? programWod?.id === session.wod_id && session.program_score_type
      : programWod && box.dataset.wod === programWod.id
        ? box.dataset.type
        : null,
    // WOD saisi à la main : le type de score choisi à la saisie.
    manualWod =
      !boxWod && !bench && (selectedDailyWod()?.manual || selectedDailyWod()?.common_wod_id)
        ? selectedDailyWod()
        : null,
    type = boxWod?.score_type || manualWod?.score_type || savedType || programWod?.score_type || "none",
    key = f.wod_id.value,
    show = !!bench || type !== "none";
  $("#sessionscoresection").hidden = !show;
  f.score_category_id.closest("label").hidden = !boxWod;
  f.score_category_id.disabled = !boxWod || !show;
  if (!show) {
    box.innerHTML = "";
    box.dataset.wod = "";
    box.dataset.type = "";
    return;
  }
  // Les rechargements des options de la semaine ne doivent pas effacer une saisie en cours.
  if (box.dataset.wod === key && !session) return;
  box.dataset.wod = key;
  box.dataset.type = type;
  $("#sessionscoresection .hint").textContent = bench
    ? "Facultatif : il est suivi dans la page PR, rubrique Benchmarks."
    : boxWod
      ? "Facultatif : il alimente le classement du WOD entre les membres de la box."
      : "Facultatif : il est ajouté à ton historique pour ce WOD.";
  const v = session?.score_value ?? null;
  if (bench) {
    box.innerHTML =
      benchmarkScoreFields(bench, v) +
      `<label class="checkbox-label"><input type="checkbox" name="score_scaled" ${Number(session?.score_scaled) ? "checked" : ""}> Scaled</label>`;
    return;
  }
  if (boxWod) {
    const cats = boxCategories.filter(c => c.box_id === boxWod.box_id),
      previous = session?.score_category_id || f.score_category_id.value;
    f.score_category_id.innerHTML = cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    if (cats.some(c => c.id === previous)) f.score_category_id.value = previous;
  }
  box.innerHTML =
    type === "time"
      ? `<label>Temps (min : s)<span class="score-time"><input name="score_min" type="number" min="0" max="1440" step="1" inputmode="numeric" placeholder="min" value="${v === null ? "" : Math.floor(v / 60)}"><span>:</span><input name="score_sec" type="number" min="0" max="59" step="1" inputmode="numeric" placeholder="s" value="${v === null ? "" : v % 60}"></span></label>`
      : type === "load"
        ? `<label>Charge (kg)<input name="score_amount" type="number" min="0.5" max="1000" step="0.5" inputmode="decimal" value="${v ?? ""}"></label>`
        : `<label>${type === "rounds" ? "Tours" : "Répétitions"}<input name="score_amount" type="number" min="1" max="100000" step="1" inputmode="numeric" value="${v ?? ""}"></label>`;
}
// Valeur du score saisie (null si vide) ; le temps est converti en secondes.
function readSessionScore() {
  const f = $("#sessionform").elements,
    boxWod = selectedBoxWod(),
    bench = !boxWod && selectedBenchmark(),
    type = $("#scoreinputs").dataset.type;
  if (bench) {
    const score = readBenchmarkScore(bench, f);
    return score.error ? score : {score_value: score.value, score_scaled: !!f.score_scaled?.checked};
  }
  if (!type) return {score_value: null};
  let value = null;
  if (type === "time") {
    const mn = f.score_min.value,
      sec = f.score_sec.value;
    if (mn !== "" || sec !== "") value = Number(mn || 0) * 60 + Number(sec || 0);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 86400 || Number(sec || 0) > 59))
      return {error: "Temps invalide : minutes et secondes (0 à 59), 24 h au maximum."};
  } else if (f.score_amount.value !== "") value = Number(f.score_amount.value);
  return boxWod
    ? {score_value: value, score_category_id: value === null ? null : f.score_category_id.value}
    : {score_value: value, score_type: value === null ? null : type};
}
// Mouvement du programme correspondant à un mouvement du catalogue (même identifiant de catalogue ou même nom).
const sameMovement = (pm, cm) =>
  pm.catalog_movement_id === cm.id || pm.name.trim().toLowerCase() === cm.name.trim().toLowerCase();
function renderSessionMovementChecks(pid, sessionId = "") {
  const box = $("#sessionmovementchecks"),
    programItems = movementsByProgram[pid] || [],
    fromCatalog = !programItems.length,
    items = fromCatalog ? movementCatalog : programItems,
    field = fromCatalog ? "catalog_movement_ids" : "movement_ids",
    // Programme avec mouvements à travailler : les mouvements propres au WOD choisi (ou déjà cochés dans la
    // séance) qui n’y figurent pas sont ajoutés en fin de liste.
    wod = (wodsByProgram[pid] || []).find(w => w.id === $("#sessionform").elements.wod_id.value),
    extraIds = fromCatalog
      ? []
      : [
          ...(wod?.movement_ids || []),
          ...catalogChecks.filter(c => sessionId && c.session_id === sessionId).map(c => c.catalog_movement_id),
        ],
    extras = movementCatalog.filter(cm => extraIds.includes(cm.id) && !programItems.some(pm => sameMovement(pm, cm))),
    // Cases déjà cochées dans le formulaire ouvert (changement de date ou de WOD) : gardées.
    ticked = new Set([...box.querySelectorAll("input:checked")].map(x => x.name + ":" + x.value)),
    isChecked = m =>
      ticked.has(field + ":" + m.id) ||
      (fromCatalog
        ? catalogChecks.some(c => c.session_id === sessionId && c.catalog_movement_id === m.id) ||
          // Séance « Autres » enregistrée avec des mouvements du programme : retrouvés dans la liste complète.
          movementChecks.some(
            c =>
              c.session_id === sessionId &&
              Object.values(movementsByProgram)
                .flat()
                .some(pm => pm.id === c.movement_id && pm.catalog_movement_id === m.id)
          )
        : movementChecks.some(c => c.session_id === sessionId && c.movement_id === m.id));
  $("#sessionmovementsection").hidden = !items.length;
  box.innerHTML =
    items
      .map(
        m =>
          `<label class="movement-check"><input type="checkbox" name="${field}" value="${esc(m.id)}" ${isChecked(m) ? "checked" : ""}><span>${esc(m.name)}</span></label>`
      )
      .join("") +
    extras
      .map(
        m =>
          `<label class="movement-check"><input type="checkbox" name="catalog_movement_ids" value="${esc(m.id)}" ${ticked.has("catalog_movement_ids:" + m.id) || catalogChecks.some(c => c.session_id === sessionId && c.catalog_movement_id === m.id) ? "checked" : ""}><span>${esc(m.name)}</span></label>`
      )
      .join("");
}
function openSession(s = null, presetWodId = "") {
  const f = $("#sessionform");
  editedSession = s;
  f.reset();
  $("#sessionmovementchecks").innerHTML = "";
  $("#sessionmovementchecks").dataset.presetWod = "";
  $("#sessionmovementdetails").open = false;
  $("#sessionpartnerdetails").open = false;
  f.elements.session_date.max = today();
  f.elements.session_id.value = s?.id || "";
  f.elements.actual_comment.value = s?.actual_comment || "";
  f.elements.actual_comment.dataset.plannedDefault = "";
  const weekEnd = addDays(selectedWeekStart, 6),
    defaultDate = selectedWeekStart > today() ? today() : weekEnd < today() ? weekEnd : today(),
    presetBoxWod = presetWodId.startsWith("box:") ? boxWodsById.get(presetWodId.slice(4)) : null,
    presetDaily = presetWodId.startsWith("daily:") ? dailyWodsById.get(presetWodId.slice(6)) : null,
    presetDate = presetBoxWod?.wod_date || presetDaily?.wod_date,
    sessionDate = s?.session_date || (presetDate && presetDate <= today() ? presetDate : defaultDate);
  f.elements.session_date.value = sessionDate;
  // Programmes réels + « Hors programme » (programme technique caché, créé par le serveur si besoin).
  f.elements.program_id.innerHTML =
    programs
      .filter(p => !isFallbackProgram(p))
      .map(p => `<option value="${p.id}">${esc(p.name)}</option>`)
      .join("") + `<option value="none">Sans programme</option>`;
  let selectedProgram = s ? programs.find(p => p.id === s.program_id) : null;
  if (!selectedProgram && presetWodId)
    selectedProgram = programs.find(p => (wodsByProgram[p.id] || []).some(x => x.id === presetWodId));
  if (!selectedProgram) selectedProgram = programForDate(sessionDate);
  f.elements.program_id.value = selectedProgram && !isFallbackProgram(selectedProgram) ? selectedProgram.id : "none";
  const pid = f.elements.program_id.value;
  // Séance sur un WOD de box : le WOD est retrouvé même s’il n’est pas dans la semaine de la séance.
  if (s?.box_wod_id)
    rememberBoxWods([
      {
        id: s.box_wod_id,
        box_id: s.box_id,
        box_name: s.box_name,
        wod_date: s.box_wod_date || s.session_date,
        name: s.wod_name,
        content: s.planned_comment || "",
        score_type: s.score_type || "none",
        ...boxWodsById.get(s.box_wod_id),
      },
    ]);
  // Séance sur un WOD du jour : le WOD est retrouvé même s’il n’est pas dans la semaine affichée.
  if (s?.daily_wod_id)
    rememberDailyWods([
      {
        id: s.daily_wod_id,
        wod_date: s.daily_wod_date || s.session_date,
        title: s.wod_name,
        content: s.planned_comment || "",
        benchmark_id: s.benchmark_id,
        score_type: s.score_type,
        ...dailyWodsById.get(s.daily_wod_id),
      },
    ]);
  const initialWod = s?.box_wod_id
    ? "box:" + s.box_wod_id
    : s?.daily_wod_id
      ? "daily:" + s.daily_wod_id
      : s?.wod_name === "Autres"
        ? "other"
        : s?.wod_id || presetWodId;
  const refill = () => {
    fillWodOptions(f.elements.program_id.value, initialWod);
    if (!s) applyPlannedSessionNote();
  };
  loadSessionFormWeek(sessionDate, refill);
  fillWodOptions(pid, initialWod);
  const selectedWod = selectedProgramWod();
  fillActivitySelect(f.elements.activity_id, s?.activity_id || selectedWod?.activity_id || defaultActivity()?.id);
  f.elements.duration_minutes.value =
    s?.duration_minutes || selectedWod?.duration_minutes || defaultActivity()?.duration_minutes || 60;
  const defaultStart = new Date(Date.now() - Number(f.elements.duration_minutes.value) * 60000);
  f.elements.start_time.value = s?.started_at
    ? new Date(s.started_at).toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", hour12: false})
    : defaultStart.toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", hour12: false});
  f.elements.start_time.dataset.manual = "";
  f.elements.start_time.onchange = () => {
    f.elements.start_time.dataset.manual = "1";
  };
  f.elements.duration_minutes.oninput = () => {
    if (!f.elements.start_time.dataset.manual) {
      const d = new Date(Date.now() - Number(f.elements.duration_minutes.value || 0) * 60000);
      f.elements.start_time.value = d.toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", hour12: false});
    }
  };
  $("#scoreinputs").dataset.wod = "";
  syncSessionWod(s);
  if (!s) applyPlannedSessionNote();
  $("#sessiontitle").textContent = s ? "Modifier la séance" : "Enregistrer une séance";
  setSessionPartners(s);
  $("#sessiondialog").showModal();
}
// Partenaires tagués : ceux déjà invités (avec l’état de l’invitation ; une invitation acceptée ou refusée ne se
// retire plus) et ceux ajoutés par la recherche (comptes de l’application, par prénom et nom, 10 au plus).
let sessionPartners = [],
  partnerTimer = null;
const partnerName = x => [x.first_name, x.last_name].filter(Boolean).join(" ");
const PARTNER_STATUS = {pending: "en attente", accepted: "a accepté", declined: "a refusé"};
function setSessionPartners(s) {
  sessionPartners = s
    ? sessionTags
        .filter(t => t.session_id === s.id)
        .map(t => ({id: t.to_user_id, name: partnerName(t), status: t.status}))
    : [];
  $("#partnersearch").value = "";
  $("#partnerresults").innerHTML = "";
  renderPartners();
}
function renderPartners() {
  const n = sessionPartners.length;
  $("#sessionpartnercount").textContent = n ? n + (n > 1 ? " partenaires" : " partenaire") : "aucun";
  $("#partnerchips").innerHTML = sessionPartners
    .map(
      p =>
        `<span class="tracked-tag partner-chip">${esc(p.name)}${p.status ? " · " + PARTNER_STATUS[p.status] : ""}${!p.status || p.status === "pending" ? `<button type="button" data-partner-remove="${esc(p.id)}" aria-label="Retirer ${esc(p.name)}" title="Retirer">×</button>` : ""}</span>`
    )
    .join("");
  $("#partnerchips")
    .querySelectorAll("[data-partner-remove]")
    .forEach(
      b =>
        (b.onclick = () => {
          sessionPartners = sessionPartners.filter(p => p.id !== b.dataset.partnerRemove);
          renderPartners();
        })
    );
}
$("#partnersearch").onkeydown = e => {
  if (e.key === "Enter") e.preventDefault(); // pas d’enregistrement de la séance depuis la recherche
};
$("#partnersearch").oninput = e => {
  clearTimeout(partnerTimer);
  const q = e.target.value.trim(),
    results = $("#partnerresults");
  if (q.length < 2) {
    results.innerHTML = "";
    return;
  }
  partnerTimer = setTimeout(async () => {
    try {
      const d = await sendApi("/users/search?q=" + encodeURIComponent(q), "GET");
      if ($("#partnersearch").value.trim() !== q) return;
      const list = d.users.filter(x => !sessionPartners.some(p => p.id === x.id));
      results.innerHTML =
        list
          .map(
            x =>
              `<button type="button" class="smallbtn partner-result" data-partner-add="${esc(x.id)}">＋ ${esc(partnerName(x))}</button>`
          )
          .join("") || `<p class="muted">Personne trouvée.</p>`;
      results.querySelectorAll("[data-partner-add]").forEach(
        b =>
          (b.onclick = () => {
            if (sessionPartners.length >= 10) return toast("10 partenaires au plus par séance.");
            const x = list.find(y => y.id === b.dataset.partnerAdd);
            sessionPartners.push({id: x.id, name: partnerName(x)});
            $("#partnersearch").value = "";
            results.innerHTML = "";
            renderPartners();
          })
      );
    } catch (x) {
      results.innerHTML = `<p class="muted">${esc(x.offline ? OFFLINE_MESSAGE : x.message)}</p>`;
    }
  }, 250);
};
let choiceWodId = "";
function openWodChoice(wodId) {
  const planned = weeklyPlans.some(x => x.wod_id === wodId);
  if (selectedWeekStart < mondayOf(today())) {
    openSession(null, wodId);
    return;
  }
  if (planned) {
    if (selectedWeekStart > mondayOf(today())) {
      toast("Cette séance est planifiée pour une semaine future.");
      return;
    }
    openSession(null, wodId);
    return;
  }
  choiceWodId = wodId;
  const w = programs.flatMap(p => wodsByProgram[p.id] || []).find(x => x.id === wodId);
  $("#wodchoicetitle").textContent = w?.name || "Que souhaites-tu faire ?";
  $("#choice-record").disabled = selectedWeekStart > mondayOf(today());
  $("#choice-plan").textContent = "Planifier";
  $("#wodchoice").showModal();
}
$("#closewodchoice").onclick = () => $("#wodchoice").close();
$("#choice-record").onclick = () => {
  const id = choiceWodId;
  $("#wodchoice").close();
  openSession(null, id);
};
$("#choice-plan").onclick = async () => {
  const id = choiceWodId;
  try {
    await api("/weekly-plans", {method: "POST", body: JSON.stringify({week_start: selectedWeekStart, wod_id: id})});
    $("#wodchoice").close();
    await changeWeek(selectedWeekStart);
    toast("WOD planifié.");
  } catch (e) {
    toast(e.message);
  }
};
function addSessionFromWeek() {
  if (selectedWeekStart > mondayOf(today())) {
    toast("Impossible de saisir une séance sur une semaine future.");
    return;
  }
  openSession();
}
$("#closesession").onclick = () => $("#sessiondialog").close();
async function saveSession(event) {
  if (event) event.preventDefault();
  const form = $("#sessionform");
  if (form.elements.wod_id.disabled || !form.reportValidity()) return;
  const f = new FormData(form),
    id = f.get("session_id");
  if (f.get("session_date") > today()) {
    $("#sessionerror").textContent = "Impossible d’enregistrer une séance à une date future.";
    return;
  }
  const button = $("#savesession");
  button.disabled = true;
  $("#sessionerror").textContent = "";
  const body = {
    program_id: f.get("program_id"),
    wod_id: f.get("wod_id"),
    session_date: f.get("session_date"),
    activity_id: f.get("activity_id"),
    duration_minutes: Number(f.get("duration_minutes")),
    started_at: new Date(f.get("session_date") + "T" + f.get("start_time")).toISOString(),
    actual_comment: f.get("actual_comment"),
    movement_ids: [...form.querySelectorAll('input[name="movement_ids"]:checked')].map(x => x.value),
    catalog_movement_ids: [...form.querySelectorAll('input[name="catalog_movement_ids"]:checked')].map(x => x.value),
    tagged_user_ids: sessionPartners.map(p => p.id),
  };
  const boxWod = selectedBoxWod(),
    dailyWod = selectedDailyWod(),
    score = readSessionScore();
  if (score.error) {
    $("#sessionerror").textContent = score.error;
    button.disabled = false;
    return;
  }
  Object.assign(
    body,
    {
      box_wod_id: boxWod?.id ?? null,
      daily_wod_id: dailyWod?.id ?? null,
      score_category_id: null,
      score_scaled: null,
      score_type: null,
    },
    score
  );
  // WOD de box ou du jour : la séance est rattachée au programme technique « Hors programme ».
  if (boxWod || dailyWod) Object.assign(body, {program_id: "none", wod_id: "other"});
  try {
    await api(id ? "/sessions/" + id : "/sessions", {method: id ? "PUT" : "POST", body: JSON.stringify(body)});
    if (!boxWod && !dailyWod)
      await api("/weekly-plans", {
        method: "DELETE",
        body: JSON.stringify({week_start: mondayOf(body.session_date), wod_id: body.wod_id}),
      });
    $("#sessiondialog").close();
    selectedWeekStart = mondayOf(body.session_date);
    await load(); // recharge aussi les programmes (état « contient des séances »)
    renderWeek();
    toast(id ? "Séance modifiée." : "Séance enregistrée.");
  } catch (x) {
    $("#sessionerror").textContent = x.message;
  } finally {
    button.disabled = false;
  }
}
$("#sessionform").onsubmit = saveSession;
$("#savesession").onclick = () => saveSession();
