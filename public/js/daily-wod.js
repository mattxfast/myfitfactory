// myFitFactory — WOD du jour (page Séances) : l’athlète qui s’entraîne au jour le jour, hors programme, fait générer
// son entraînement par l’IA (aujourd’hui ou demain), le retrouve « hors prog » dans la rubrique « Mes WOD »
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
function dailyDefaultDate() {
  const now = today(),
    tomorrow = addDays(now, 1);
  return selectedWeekStart === tomorrow ? tomorrow : now;
}

// WOD personnels de la semaine : en fin de « Mes WOD » en mode avancé et dans « WOD à faire » en mode simplifié.
// Un toucher sur la ligne ouvre le détail.
// La copie créée par « Je le fais » est accessible depuis le détail du WOD du jour et le formulaire de séance.
const persoDailyWods = () => dailyWods.filter(w => !w.common_wod_id);
function dailyWodCards(wods = persoDailyWods()) {
  return wods
    .map(w => {
      const n = dailyWodDone(w),
        future = w.wod_date > today();
      return `<article class="weekwod card ${n ? "done" : ""}"><div class="weekcount">${n ? "" : `<button type="button" class="smallbtn" data-daily-log="${w.id}" ${future ? "disabled" : ""} aria-label="${future ? "Prévu pour demain" : "Enregistrer la séance"}" title="${future ? "Prévu pour demain" : "Enregistrer la séance"}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button><button type="button" class="smallbtn delete" data-daily-del="${w.id}" aria-label="Supprimer ce WOD" title="Supprimer ce WOD"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>`}</div><div class="weekwod-text" role="button" tabindex="0" data-daily-open="${w.id}" aria-label="Voir le détail du WOD du ${fmt(w.wod_date)}"><b>${esc(w.title)}</b><p>Hors prog · ${fmt(w.wod_date)}</p></div></article>`;
    })
    .join("");
}
// À gauche de « Nombre de séances » : accès au choix d’un WOD sur la semaine qui contient aujourd’hui ou demain.
const dailyGenerateRow = from =>
  dailyCanGenerate(from)
    ? `<div class="weekstats-generate"><button type="button" class="smallbtn" data-wod-new aria-label="Choisir un WOD" title="Choisir un WOD"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6"/><path d="M9 15h6"/></svg></button></div>`
    : "";
// Fenêtre « Choisir un WOD » : création d’un WOD personnel ou accès au WOD du jour.
// « Généré par l’IA » et « Saisie manuelle » mènent au même formulaire : l’IA le pré-remplit (sa fenêtre de
// génération s’ouvre par-dessus), on relit et on ajuste avant d’enregistrer.
document.querySelectorAll("[data-newwod]").forEach(
  b =>
    (b.onclick = () => {
      $("#newwoddialog").close();
      if (b.dataset.newwod === "common") openCommonWodDetail();
      else if (b.dataset.newwod === "bench") openBenchmarkDraw();
      else {
        openManualWod();
        if (b.dataset.newwod === "ai") openAiDialog("daily");
      }
    })
);
// Création d’un WOD : mêmes blocs que les WOD de box, écrits à la main ou pré-remplis par l’IA (puis relus et
// ajustés) ; modification possible tant qu’aucune séance n’y est rattachée.
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
  f.wod_date.value = w?.wod_date || dailyDefaultDate();
  f.name.value = w?.manual?.name || "";
  for (const [key] of MANUAL_BLOCKS) f["block_" + key].value = w?.manual?.blocks?.[key] || "";
  f.score_type.value = w?.score_type || "none";
  // Mouvements du catalogue reconnus par l’IA : cochés d’office dans la séance.
  form.dataset.movements = JSON.stringify(w?.movement_ids || []);
  $("#manualwodtitle").textContent = w ? "Modifier le WOD" : "Créer mon WOD";
  $("#manualwoderror").textContent = "";
  $("#manualwoddialog").showModal();
}
// WOD saisi hors ligne : affiché tout de suite (même forme que la réponse du serveur).
function describeManualWod(b) {
  const filled = MANUAL_BLOCKS.filter(([key]) => String(b.blocks?.[key] || "").trim()),
    title = String(b.name || "").trim() || "Mon WOD";
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
      movement_ids: JSON.parse(e.target.dataset.movements || "[]"),
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
  root.querySelectorAll("[data-wod-new]").forEach(
    b =>
      (b.onclick = () => {
        updateCommonWodChoice();
        $("#newwoddialog").showModal();
      })
  );
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

// Pré-remplissage par l’IA du formulaire « Créer mon WOD » : la fenêtre de génération commune (durée, blocs,
// consigne, profil) s’ouvre par-dessus ; le résultat remplit le nom (s’il est vide), les blocs et les mouvements.
$("#manualwodai").onclick = () => {
  const f = $("#manualwodform").elements;
  if (MANUAL_BLOCKS.some(([key]) => f["block_" + key].value.trim()) && !confirm("Remplacer les blocs déjà écrits ?"))
    return;
  openAiDialog("daily");
};
function setupDailyAiForm() {
  $("#aititle").textContent = "Pré-remplir avec l’IA";
}
async function generateDailyWod(f, request) {
  aiProgress("Génération en cours… (jusqu’à une minute)");
  const form = $("#manualwodform"),
    m = form.elements,
    {draft} = await sendApi(
      "/daily-wods",
      "POST",
      {...request, wod_date: m.wod_date.value || today(), draft: true},
      AI_TIMEOUT
    );
  if (!m.name.value.trim()) m.name.value = draft.name || "";
  for (const [key] of MANUAL_BLOCKS) m["block_" + key].value = draft.blocks?.[key] || "";
  form.dataset.movements = JSON.stringify(draft.movement_ids || []);
  return "Blocs pré-remplis : relis-les et ajuste-les avant d’enregistrer.";
}

// ----- WOD aléatoire du jour : le même WOD pour tous (généré chaque nuit), « Je le fais », classement -----
const canUseCommonWod = () => !!preferences?.common_wod;
function currentCommonWod() {
  const wod = commonWod?.wod;
  return canUseCommonWod() && wod?.wod_date === today() ? wod : null;
}
function commonWodTitle(wod) {
  return wod.title
    .replace(/^WOD commun(?: du)?\b/i, "WOD du")
    .replace(/^WOD du(?=\s*(?:[:–—-]|$))/, "WOD du " + fmt(wod.wod_date));
}
function updateCommonWodChoice() {
  const button = $('[data-newwod="common"]'),
    wod = currentCommonWod();
  button.hidden = !wod;
  if (wod) button.querySelector("small").textContent = commonWodTitle(wod);
}
// Chargé à part (la page s’affiche sans l’attendre) ; dernière copie gardée sur le téléphone, comme les autres lectures.
let commonWodRequest = 0;
async function loadCommonWod() {
  const request = ++commonWodRequest,
    data = await api("/common-wod").catch(() => null);
  if (request !== commonWodRequest) return;
  commonWod = data;
  if ($("#newwoddialog").open) updateCommonWodChoice();
  refreshSessionCommonWod();
}
const COMMON_SCORE_HINT = {time: "Pour le temps", reps: "Aux répétitions", load: "À la charge"};
function openCommonWodDetail() {
  const w = currentCommonWod();
  if (!w) return;
  const dialog = $("#dailydetaildialog"),
    actions = $("#dailydetailactions"),
    joinedId = commonWod.joined_id,
    joined = dailyWodsById.get(joinedId),
    done = joined && dailyWodDone(joined);
  $("#dailydetailtitle").textContent = "Le WOD du jour";
  $("#dailydetailmeta").textContent = [
    commonWodTitle(w),
    COMMON_SCORE_HINT[w.score_type],
    done ? "séance enregistrée" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  fillWodBody($("#dailydetailbody"), w.blocks, dailyBody(w));
  actions.innerHTML =
    (joinedId
      ? done
        ? ""
        : `<button type="button" class="primary" data-common-log><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg><span>Enregistrer la séance</span></button>`
      : `<button type="button" class="primary" data-common-join>Je le fais</button>`) +
    (w.score_type ? `<button type="button" class="smallbtn" data-common-board>Classement</button>` : "");
  const join = actions.querySelector("[data-common-join]"),
    log = actions.querySelector("[data-common-log]"),
    board = actions.querySelector("[data-common-board]");
  if (join) join.onclick = () => joinCommonWod(join);
  if (log)
    log.onclick = () => {
      dialog.close();
      openSession(null, "daily:" + joinedId);
    };
  if (board)
    board.onclick = () => {
      dialog.close();
      openCommonLeaderboard(w.id);
    };
  if (!dialog.open) dialog.showModal();
}
// La copie personnelle est créée une seule fois, depuis le détail ou à l’enregistrement de la séance.
async function attachCommonWod(id) {
  const {wod} = await sendApi("/common-wod/" + id + "/join", "POST", {});
  rememberDailyWods([wod]);
  if (commonWod?.wod?.id === id) commonWod.joined_id = wod.id;
  return wod;
}
async function joinCommonWod(button) {
  const wod = currentCommonWod();
  if (!wod) return;
  button.disabled = true;
  try {
    await attachCommonWod(wod.id);
    selectedWeekStart = mondayOf(wod.wod_date);
    await loadSessions();
    if (button.closest("dialog")?.open) openCommonWodDetail();
    toast("C’est parti ! Enregistre ta séance et ton score une fois le WOD fait.");
  } catch (e) {
    toast(e.offline ? OFFLINE_MESSAGE : e.message);
  } finally {
    button.disabled = false;
  }
}
// Classement d’un WOD aléatoire (celui du jour, ou un plus ancien depuis l’historique des séances).
async function openCommonLeaderboard(id) {
  if (!id) return;
  const known = commonWod?.wod?.id === id ? commonWod.wod : null,
    meta = w => ["WOD aléatoire du " + fmt(w.wod_date), COMMON_SCORE_HINT[w.score_type]].filter(Boolean).join(" · ");
  $("#leaderboardtitle").textContent = known?.title || "Classement";
  $("#leaderboardmeta").textContent = known ? meta(known) : "";
  $("#leaderboardbody").innerHTML = `<p class="muted">Chargement…</p>`;
  $("#leaderboarddialog").showModal();
  try {
    const d = await api("/common-wod/" + id + "/leaderboard"),
      w = d.wod;
    $("#leaderboardtitle").textContent = w.title;
    $("#leaderboardmeta").textContent = meta(w);
    $("#leaderboardbody").innerHTML = d.ranking.length
      ? `<ol class="leaderboard-list">${d.ranking
          .map(
            x =>
              `<li class="${x.me ? "me" : ""}"><span class="leaderboard-rank">${x.rank}</span><span class="leaderboard-name">${esc(x.name)}</span><b>${esc(formatScore(w.score_type, x.value))}</b></li>`
          )
          .join("")}</ol>`
      : `<p class="muted">Aucun score pour l’instant : enregistre le tien !</p>`;
  } catch (e) {
    $("#leaderboardbody").innerHTML = `<p class="error">${esc(e.offline ? OFFLINE_MESSAGE : e.message)}</p>`;
  }
}
