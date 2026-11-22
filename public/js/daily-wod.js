// myFitFactory — WOD du jour (page Séances) : l’athlète qui s’entraîne au jour le jour, hors programme, fait générer
// son entraînement par l’IA (aujourd’hui ou demain), le retrouve « en plus » dans la rubrique « WOD de la programmation »
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

// WOD du jour de la semaine : affichés en fin de rubrique « WOD de la programmation », comme des entraînements
// en plus, rattachés à aucun programme. Même forme que les cartes de la programmation : texte à gauche, boutons à
// droite ; le titre du WOD en gras, « En plus · JJ/MM/AAAA » dessous ; un toucher sur la ligne ouvre le détail.
function dailyWodCards() {
  return dailyWods
    .map(w => {
      const n = dailyWodDone(w),
        future = w.wod_date > today();
      return `<article class="weekwod card ${n ? "done" : ""}"><div class="weekcount">${n ? "" : `<button type="button" class="smallbtn" data-daily-log="${w.id}" ${future ? "disabled" : ""} aria-label="${future ? "Prévu pour demain" : "Enregistrer la séance"}" title="${future ? "Prévu pour demain" : "Enregistrer la séance"}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button><button type="button" class="smallbtn delete" data-daily-del="${w.id}" aria-label="Supprimer ce WOD" title="Supprimer ce WOD"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>`}</div><div class="weekwod-text" role="button" tabindex="0" data-daily-open="${w.id}" aria-label="Voir le détail du WOD du ${fmt(w.wod_date)}"><b>${esc(w.title)}</b><p>En plus · ${fmt(w.wod_date)}</p></div></article>`;
    })
    .join("");
}
// Boutons du titre de la rubrique « WOD de la programmation » : WOD de référence au hasard (🎲) et WOD généré par
// l’IA (✨), seulement sur la semaine qui contient aujourd’hui ou demain.
const dailyHeadingActions = from =>
  dailyCanGenerate(from)
    ? `<button type="button" class="smallbtn weekheading-action" data-bench-new aria-label="Tirer un WOD de référence (Fran, Cindy…)" title="WOD de référence au hasard">${DICE_ICON}</button><button type="button" class="smallbtn weekheading-action" data-daily-new aria-label="Générer un WOD en plus avec l’IA" title="Générer un WOD en plus avec l’IA">${AI_ICON}</button>`
    : "";
// Sans programmation ni WOD en plus : le message de la rubrique vide propose directement de générer un WOD (✨ IA)
// ou d’en tirer un de référence (🎲), à la place des boutons du titre.
const dailyEmptyCard = (from, text) =>
  dailyCanGenerate(from)
    ? `<article class="weekwod card section-empty daily-empty"><span>${esc(text)}</span><span class="daily-empty-actions"><button type="button" class="primary" data-daily-new>${AI_ICON}<span>Générer</span></button><button type="button" class="smallbtn" data-bench-new>${DICE_ICON}<span>WOD de référence</span></button></span></article>`
    : sectionEmpty(text);
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
  $("#dailydetailbody").textContent = dailyBody(w);
  $("#dailydetailactions").innerHTML = done
    ? ""
    : `<button type="button" class="primary" data-daily-log="${w.id}" ${future ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg><span>${future ? "Prévu pour demain" : "Enregistrer la séance"}</span></button>`;
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
  root.querySelectorAll("[data-daily-new]").forEach(b => (b.onclick = () => openAiDialog("daily")));
  root.querySelectorAll("[data-bench-new]").forEach(b => (b.onclick = () => openBenchmarkDraw()));
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
