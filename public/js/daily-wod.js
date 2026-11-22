// myFitFactory — WOD du jour (page Séances) : l’athlète qui s’entraîne au jour le jour, hors programme, fait générer
// son entraînement par l’IA (aujourd’hui ou demain), le retrouve « hors prog » dans la rubrique « WOD Perso »
// de la semaine (rattaché à aucun programme), lance
// le chrono préréglé et enregistre sa séance quand il veut (elle est rattachée au WOD).
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.
// La génération demande le réseau : elle n’entre jamais dans la file d’attente hors ligne.

const dailyWodsById = new Map();
let dailyWods = [];
// WOD du jour déjà chargés (semaine affichée, séances) : retrouvés dans le formulaire de séance, même hors ligne.
// Ceux de la semaine chargée que le serveur ne renvoie plus (supprimés, ici ou sur un autre appareil) sont oubliés.
function rememberDailyWods(list, from = null) {
  const ids = new Set((list || []).map(w => w.id));
  if (from)
    for (const [id, w] of dailyWodsById)
      if (w.wod_date >= from && w.wod_date <= addDays(from, 6) && !ids.has(id)) dailyWodsById.delete(id);
  for (const w of list || []) dailyWodsById.set(w.id, {...dailyWodsById.get(w.id), ...w});
  return list || [];
}
const dailyDayLabel = d =>
  d === today() ? "Aujourd’hui" : d === addDays(today(), 1) ? "Demain" : wodDay(d).replace(/^\w/, c => c.toUpperCase());
// Texte du WOD sans sa première ligne (le titre, déjà affiché au-dessus).
const dailyBody = w => String(w?.content || "").replace(/^[^\n]*\n+/, "");
const dailyWodDone = w => datedWodDone(w, "daily_wod_id");
// La génération ne concerne qu’aujourd’hui ou demain : le bouton ✨ n’apparaît que sur la semaine qui les contient.
const dailyCanGenerate = from => {
  const to = addDays(from, 6);
  return (today() >= from && today() <= to) || (addDays(today(), 1) >= from && addDays(today(), 1) <= to);
};

// WOD du jour de la semaine : affichés en fin de rubrique « WOD Perso » (après ceux de la programmation), comme des entraînements
// en plus, rattachés à aucun programme. Même forme que les cartes de la programmation : texte à gauche, boutons à
// droite ; le titre du WOD en gras, « Hors prog · JJ/MM/AAAA » dessous ; un toucher sur la ligne ouvre le détail.
function dailyWodCards() {
  return dailyWods
    .map(w => {
      const n = dailyWodDone(w),
        future = w.wod_date > today();
      return `<article class="weekwod card ${n ? "done" : ""}"><div class="weekcount">${n ? "" : `<button type="button" class="smallbtn" data-daily-log="${w.id}" ${future ? "disabled" : ""} aria-label="${future ? "Prévu pour demain" : "Enregistrer la séance"}" title="${future ? "Prévu pour demain" : "Enregistrer la séance"}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button><button type="button" class="smallbtn delete" data-daily-del="${w.id}" aria-label="Supprimer ce WOD" title="Supprimer ce WOD"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>`}</div><div class="weekwod-text" role="button" tabindex="0" data-daily-open="${w.id}" aria-label="Voir le détail du WOD du ${fmt(w.wod_date)}"><b>${esc(w.title)}</b><p>Hors prog · ${fmt(w.wod_date)}</p></div></article>`;
    })
    .join("");
}
// À gauche de la carte « Nombre de séances » : un seul bouton « Nouveau WOD » (généré par l’IA, WOD de référence
// ou saisie manuelle, au choix dans une fenêtre), dans les deux interfaces, seulement sur la semaine qui contient
// aujourd’hui ou demain.
const dailyGenerateRow = from =>
  dailyCanGenerate(from)
    ? `<div class="weekstats-generate"><button type="button" class="smallbtn" data-wod-new aria-label="Nouveau WOD (IA, référence ou saisie manuelle)" title="Nouveau WOD"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6"/><path d="M9 15h6"/></svg></button></div>`
    : "";
// Fenêtre « Nouveau WOD » : trois façons de créer le WOD du jour.
function openNewWodChooser() {
  // Interface simplifiée : pas d’IA.
  $('[data-newwod="ai"]').hidden = simpleInterface();
  $("#newwoddialog").showModal();
}
document.querySelectorAll("[data-newwod]").forEach(
  b =>
    (b.onclick = () => {
      $("#newwoddialog").close();
      if (b.dataset.newwod === "ai") openAiDialog("daily");
      else if (b.dataset.newwod === "bench") openBenchmarkDraw();
      else openManualWod();
    })
);
// Saisie manuelle : mêmes blocs que les WOD de box ; modification possible tant qu’aucune séance n’y est rattachée.
const MANUAL_BLOCKS = [
  ["warmup", "Échauffement"],
  ["technique", "Travail technique"],
  ["strength", "Force"],
  ["metcon", "Metcon"],
  ["finisher", "Finisher"],
];
function openManualWod(w = null) {
  const form = $("#manualwodform"),
    f = form.elements,
    days = [today(), addDays(today(), 1)];
  if (w && !days.includes(w.wod_date)) days.unshift(w.wod_date);
  form.reset();
  f.id.value = w?.id || "";
  f.wod_date.innerHTML = days
    .map(d => `<option value="${d}">${esc(dailyDayLabel(d) + " (" + wodDay(d) + ")")}</option>`)
    .join("");
  f.wod_date.value = w?.wod_date || today();
  f.name.value = w?.manual?.name || "";
  for (const [key] of MANUAL_BLOCKS) f["block_" + key].value = w?.manual?.blocks?.[key] || "";
  f.score_type.value = w?.score_type || "none";
  $("#manualwodtitle").textContent = w ? "Modifier le WOD" : "Saisir un WOD";
  $("#manualwoderror").textContent = "";
  $("#manualwoddialog").showModal();
}
// WOD saisi hors ligne : affiché tout de suite (même forme que la réponse du serveur).
function describeManualWod(b) {
  const filled = MANUAL_BLOCKS.filter(([key]) => String(b.blocks?.[key] || "").trim()),
    title = String(b.name || "").trim() || "WOD perso";
  return {
    title,
    content: [title, ...filled.map(([key, label]) => label + "\n" + b.blocks[key].replace(/\s+$/, ""))].join("\n\n"),
    blocks: filled.map(([type, label]) => ({type, label, text: b.blocks[type].replace(/\s+$/, "")})),
    chrono: null,
    movement_ids: [],
    benchmark_id: null,
    score_type: b.score_type === "none" ? null : b.score_type,
    manual: {name: String(b.name || "").trim(), blocks: b.blocks},
  };
}
$("#manualwodform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    id = f.id.value,
    body = {
      wod_date: f.wod_date.value,
      name: f.name.value,
      blocks: Object.fromEntries(MANUAL_BLOCKS.map(([key]) => [key, f["block_" + key].value])),
      score_type: f.score_type.value,
    };
  if (!MANUAL_BLOCKS.some(([key]) => body.blocks[key].trim())) {
    $("#manualwoderror").textContent = "Écris au moins un bloc du WOD.";
    return;
  }
  $("#manualwodsubmit").disabled = true;
  try {
    if (id) {
      // Modification : demande le réseau.
      const d = await sendApi("/daily-wods/" + id, "PUT", body);
      rememberDailyWods([d.wod]);
    }
    // Création : mise en file d’attente hors ligne et affichée tout de suite (identifiant créé sur le téléphone).
    else
      await api("/daily-wods/manual", {
        method: "POST",
        body: JSON.stringify({...body, client_id: crypto.randomUUID()}),
      });
    $("#manualwoddialog").close();
    selectedWeekStart = mondayOf(body.wod_date);
    await loadSessions();
    toast(id ? "WOD modifié." : "WOD ajouté : bon entraînement !");
  } catch (x) {
    $("#manualwoderror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
  } finally {
    $("#manualwodsubmit").disabled = false;
  }
};
// Détail d’un WOD du jour, en fenêtre : texte complet, chrono et séance.
function openDailyDetail(id) {
  const w = dailyWodsById.get(id),
    dialog = $("#dailydetaildialog");
  if (!w) return;
  const done = dailyWodDone(w),
    future = w.wod_date > today();
  $("#dailydetailtitle").textContent = "WOD du " + fmt(w.wod_date);
  $("#dailydetailmeta").textContent =
    w.title + " · " + dailyDayLabel(w.wod_date) + (done ? " · séance enregistrée" : "");
  fillWodBody($("#dailydetailbody"), w.blocks, dailyBody(w));
  $("#dailydetailactions").innerHTML = done
    ? ""
    : `<button type="button" class="primary" data-daily-log="${w.id}" ${future ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg><span>${future ? "Prévu pour demain" : "Enregistrer la séance"}</span></button>${w.manual && !w.pending ? `<button type="button" class="smallbtn" data-daily-edit="${w.id}">Modifier</button>` : ""}`;
  bindDailySection($("#dailydetailactions"));
  // La fenêtre se ferme avant d’ouvrir le formulaire de séance.
  $("#dailydetailactions")
    .querySelectorAll("button")
    .forEach(b => {
      const run = b.onclick;
      b.onclick = () => {
        dialog.close();
        run?.();
      };
    });
  dialog.showModal();
}
function bindDailySection(root) {
  root
    .querySelectorAll("[data-daily-open]")
    .forEach(b => (b.onclick = e => (blurAfterTap(b, e), openDailyDetail(b.dataset.dailyOpen))));
  root.querySelectorAll("[data-wod-new]").forEach(b => (b.onclick = () => openNewWodChooser()));
  root
    .querySelectorAll("[data-daily-edit]")
    .forEach(b => (b.onclick = () => openManualWod(dailyWodsById.get(b.dataset.dailyEdit))));
  root
    .querySelectorAll("[data-daily-log]")
    .forEach(b => (b.onclick = () => openSession(null, "daily:" + b.dataset.dailyLog)));
  root.querySelectorAll("[data-daily-del]").forEach(
    b =>
      (b.onclick = async () => {
        if (!confirm("Supprimer ce WOD du jour ?")) return;
        try {
          await sendApi("/daily-wods/" + b.dataset.dailyDel, "DELETE");
          dailyWodsById.delete(b.dataset.dailyDel);
          await loadSessions();
          toast("WOD du jour supprimé.");
        } catch (e) {
          toast(e.offline ? OFFLINE_MESSAGE : e.message);
        }
      })
  );
}

// Date et titre du WOD du jour dans la fenêtre de génération commune.
function setupDailyAiForm(form, replaceId) {
  const f = form.elements,
    replaced = dailyWodsById.get(replaceId),
    days = [today(), addDays(today(), 1)];
  f.wod_date.innerHTML = days
    .map(d => `<option value="${d}">${esc(dailyDayLabel(d) + " (" + wodDay(d) + ")")}</option>`)
    .join("");
  f.wod_date.value = replaced && days.includes(replaced.wod_date) ? replaced.wod_date : days[0];
  $("#aititle").textContent = replaced ? "Générer un autre WOD du jour" : "Générer le WOD du jour";
}
async function generateDailyWod(f, request, replaceId) {
  aiProgress("Génération en cours… (jusqu’à une minute)");
  const {wod} = await sendApi(
    "/daily-wods",
    "POST",
    {...request, wod_date: f.wod_date.value, ...(replaceId ? {replace_id: replaceId} : {})},
    AI_TIMEOUT
  );
  rememberDailyWods([wod]);
  selectedWeekStart = mondayOf(wod.wod_date);
  return "WOD du jour prêt.";
}
