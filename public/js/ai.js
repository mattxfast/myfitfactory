// myFitFactory — génération de WOD par IA.
// « program » (page Programmes) : tous les WOD sur toute la période ; « wod » (page Programmes) : un WOD sur toutes les
// semaines ; « week » : un WOD pour la semaine affichée ; « daily » (page Séances) : un WOD du jour hors programme.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.
// La génération demande le réseau : elle n’entre jamais dans la file d’attente hors ligne.

const AI_MAX_MOVEMENTS = 5,
  AI_TIMEOUT = 100000;
let aiRunning = false,
  aiCancelled = false,
  aiProfileRequest;

// Blocs proposés dans la fenêtre, dans l’ordre de la séance (« retour_au_calme » : le Finisher).
const AI_FORM_BLOCKS = ["echauffement", "technique", "force", "metcon", "retour_au_calme"];
function aiBlocks(f) {
  const blocks = {};
  for (const k of AI_FORM_BLOCKS) blocks[k] = f[k].checked;
  return blocks;
}
// Liste repliable des mouvements imposés d’un bloc (technique ou force), 5 au plus.
function renderAiMovements(kind) {
  const box = $(`[data-ai-movements="${kind}"]`);
  box.innerHTML = `<details><summary>Mouvements imposés (facultatif, ${AI_MAX_MOVEMENTS} max) : <span data-ai-count>aucun, au choix de l’IA</span></summary><div class="ai-movement-list">${
    movementCatalog
      .map(
        m =>
          `<label class="movement-check"><input type="checkbox" name="${kind}_movements" value="${esc(m.id)}"><span>${esc(m.name)}</span></label>`
      )
      .join("") || `<p class="muted">Le catalogue de mouvements est vide.</p>`
  }</div></details>`;
  const sync = () => {
    const checked = [...box.querySelectorAll("input:checked")];
    box.querySelectorAll("input").forEach(i => (i.disabled = !i.checked && checked.length >= AI_MAX_MOVEMENTS));
    box.querySelector("[data-ai-count]").textContent = checked.length
      ? checked.map(i => i.nextElementSibling.textContent).join(", ")
      : "aucun, au choix de l’IA";
  };
  box.onchange = sync;
}
function syncAiForm() {
  const f = $("#aiform").elements,
    mode = $("#aiform").dataset.mode;
  for (const kind of ["technique", "force"])
    $(`[data-ai-movements="${kind}"]`).hidden = mode === "program" || !f[kind].checked;
}
// origin : page où revenir après la génération (Séances pour la semaine et le WOD du jour, Programmes sinon).
async function openAiDialog(mode, pid, wodId = null, week = null, origin = mode === "week" ? "sessions" : "programs") {
  const dialog = $("#aidialog"),
    form = $("#aiform"),
    f = form.elements,
    p = programs.find(x => x.id === pid);
  if (aiRunning || dialog.open || (mode !== "daily" && !p)) return;
  form.reset();
  form.dataset.mode = mode;
  form.dataset.week = week || "";
  form.dataset.origin = mode === "daily" ? "sessions" : origin;
  f.program_id.value = pid || "";
  f.wod_id.value = wodId || "";
  form.querySelectorAll("[data-ai-mode]").forEach(el => (el.hidden = !el.dataset.aiMode.split(" ").includes(mode)));
  f.per_week.disabled = mode !== "program";
  $("#aierror").textContent = "";
  $("#aiprogress").hidden = true;
  $("#aisubmit").disabled = true;
  const weeks = p ? programWeeks(p) : [],
    plural = weeks.length + " semaine" + (weeks.length > 1 ? "s" : ""),
    w = p ? visibleWods(pid).find(x => x.id === wodId) : null;
  $("#aiintro").hidden = mode === "daily";
  if (mode === "daily") {
    setupDailyAiForm();
  } else if (mode === "program") {
    $("#aititle").textContent = "Générer le programme";
    $("#aiintro").textContent =
      "L’IA écrit le contenu de chaque WOD, semaine par semaine (" +
      plural +
      "). Les WOD manquants sont créés (« WOD 1 », « WOD 2 »…).";
    f.per_week.value = Math.min(7, Math.max(1, visibleWods(pid).length || 3));
    $("#aiintro").textContent +=
      " La thématique / structure de chaque WOD est ajoutée à sa consigne, et ses mouvements à travailler sont repris.";
  } else {
    // La thématique / structure du WOD est reprise dans la consigne particulière (modifiable avant de générer).
    f.instructions.value = wodTheme(w);
    // Mouvements à travailler du WOD : transmis à l’IA par le serveur, rappelés ici.
    const names = movementCatalog.filter(m => (w?.movement_ids || []).includes(m.id)).map(m => m.name);
    if (names.length) $("#aiintro").textContent += " Mouvements à travailler : " + names.join(", ") + ".";
    $("#aititle").textContent = "Générer « " + (w?.name || "WOD") + " »";
    $("#aiintro").textContent =
      mode === "wod"
        ? "L’IA écrit le contenu de ce WOD pour chaque semaine du programme (" + plural + "), avec une progression."
        : "L’IA écrit le contenu de ce WOD pour la semaine " +
          (weeks.includes(week) ? "S" + (weeks.indexOf(week) + 1) : "") +
          (p.coach_mode === "free" ? "" : " du " + fmt(week)) +
          (weeklyWodContent(wodId, week).trim() ? " (le contenu déjà écrit est remplacé)." : ".");
  }
  if (mode !== "program") for (const kind of ["technique", "force"]) renderAiMovements(kind);
  AI_FORM_BLOCKS.forEach(k => (f[k].onchange = syncAiForm));
  syncAiForm();
  dialog.showModal();
  // Un chargement du profil terminé après la fermeture ne doit pas modifier la prochaine ouverture.
  const profileRequest = sendApi("/ai-profile", "GET");
  aiProfileRequest = profileRequest;
  try {
    const d = await profileRequest;
    if (!dialog.open || aiProfileRequest !== profileRequest) return;
    for (const k of ["level", "goals", "equipment", "constraints"]) f[k].value = d.profile[k] || "";
    form.dataset.remaining = d.remaining;
    $("#aisubmit").disabled = !d.enabled;
    if (!d.enabled) {
      $("#aierror").textContent =
        "La génération par IA n’est pas encore activée : l’administrateur doit configurer la clé OpenAI.";
    }
  } catch (e) {
    if (!dialog.open || aiProfileRequest !== profileRequest) return;
    $("#aierror").textContent = e.offline ? OFFLINE_MESSAGE : e.message;
    $("#aisubmit").disabled = true;
  }
}
function aiRequest(f) {
  const picked = kind =>
    [...$("#aiform").querySelectorAll(`input[name="${kind}_movements"]:checked`)].map(i => i.value);
  return {
    duration_minutes: Number(f.duration_minutes.value),
    blocks: aiBlocks(f),
    technique_movements: $("#aiform").dataset.mode !== "program" && f.technique.checked ? picked("technique") : [],
    force_movements: $("#aiform").dataset.mode !== "program" && f.force.checked ? picked("force") : [],
    instructions: f.instructions.value.trim(),
  };
}
const aiGenerate = (wodId, week, request) =>
  sendApi("/wods/" + wodId + "/generate", "POST", {...request, week_start: week}, AI_TIMEOUT);
function aiProgress(t) {
  aiWaitStart($("#aiprogress"), t);
}
// Programme complet : crée les WOD manquants, puis génère chaque WOD de chaque semaine, l’un après l’autre (le
// contenu déjà écrit sert de contexte au suivant, pour la progression et la variété).
async function generateProgram(f, request) {
  const pid = f.program_id.value,
    p = programs.find(x => x.id === pid),
    perWeek = Number(f.per_week.value),
    weeks = programWeeks(p);
  if (!Number.isInteger(perWeek) || perWeek < 1 || perWeek > 7) throw Error("Entre 1 et 7 WOD par semaine.");
  const targets = visibleWods(pid).slice(0, perWeek),
    names = new Set(visibleWods(pid).map(w => w.name.toLowerCase()));
  const slots = [];
  for (const week of weeks)
    for (let i = 0; i < perWeek; i++) {
      const w = targets[i];
      if (!w || f.replace.checked || !weeklyWodContent(w.id, week).trim()) slots.push({week, index: i});
    }
  if (!confirmSlots(slots, weeks)) return false;
  for (let i = targets.length; i < perWeek; i++) {
    let n = i + 1;
    while (names.has(("WOD " + n).toLowerCase())) n++;
    const name = "WOD " + n;
    aiProgress("Création de « " + name + " »…");
    const created = await sendApi("/programs/" + pid + "/wods", "POST", {
      name,
      planned_comment: "",
      activity_id: defaultActivity()?.id,
      duration_minutes: request.duration_minutes,
      is_tracked: true,
    });
    names.add(name.toLowerCase());
    targets.push({id: created.id, name});
  }
  // Chaque WOD reçoit sa propre thématique / structure en tête de la consigne.
  const done = await runSlots(
    slots.map(s => ({week: s.week, wod: targets[s.index]})),
    request,
    wod => ({
      ...request,
      instructions: [wodTheme(visibleWods(pid).find(x => x.id === wod.id)), request.instructions]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 600),
    })
  );
  (window.cfExpandedWodProgramming || (window.cfExpandedWodProgramming = new Set())).add(targets[0].id);
  return doneMessage(done);
}
// Vérifie le quota restant et demande confirmation avant une génération en série.
function confirmSlots(slots, weeks) {
  if (!slots.length) throw Error("Tout a déjà un contenu. Coche « Remplacer le contenu déjà écrit ».");
  const remaining = Number($("#aiform").dataset.remaining);
  if (slots.length > remaining)
    throw Error(
      slots.length + " générations nécessaires, il en reste " + remaining + " pour 24 h. Réduis le nombre de WOD."
    );
  return confirm(
    "Générer " + slots.length + " WOD (" + weeks.length + " semaines) ? Cela peut prendre quelques minutes."
  );
}
const doneMessage = done =>
  aiCancelled ? "Génération interrompue : " + done + " WOD écrits." : done + " WOD générés.";
// Génère les créneaux l’un après l’autre, dans l’ordre des semaines : le contenu déjà écrit sert de contexte au
// suivant (progression, variété).
// Thématique / structure d’un WOD (champ du WOD), reprise dans la consigne particulière de la génération.
const wodTheme = w =>
  String(w?.planned_comment || "")
    .trim()
    .slice(0, 600);
async function runSlots(slots, request, requestFor = () => request) {
  let done = 0;
  for (const s of slots) {
    if (aiCancelled) break;
    const w = s.wod;
    aiProgress(
      "Génération " +
        (done + 1) +
        "/" +
        slots.length +
        " : " +
        w.name +
        ", " +
        weekName(
          programs.find(x => x.id === $("#aiform").elements.program_id.value),
          s.week
        ) +
        "… (ne ferme pas l’application)"
    );
    await aiGenerate(w.id, s.week, requestFor(w));
    done++;
  }
  return done;
}
// Un WOD sur toutes les semaines du programme (page Programmes).
async function generateWodWeeks(f, request) {
  const pid = f.program_id.value,
    weeks = programWeeks(programs.find(x => x.id === pid)),
    wod = visibleWods(pid).find(x => x.id === f.wod_id.value),
    slots = weeks.filter(week => f.replace.checked || !weeklyWodContent(wod.id, week).trim());
  if (!confirmSlots(slots, weeks)) return false;
  const done = await runSlots(
    slots.map(week => ({week, wod})),
    request
  );
  (window.cfExpandedWodProgramming || (window.cfExpandedWodProgramming = new Set())).add(wod.id);
  return doneMessage(done);
}
$("#aiform").onsubmit = async e => {
  e.preventDefault();
  if (aiRunning || $("#aisubmit").disabled) return;
  const form = e.target,
    f = form.elements,
    request = aiRequest(f),
    {mode, origin} = form.dataset;
  $("#aierror").textContent = "";
  if (!Object.values(request.blocks).some(Boolean)) {
    $("#aierror").textContent = "Choisis au moins un bloc.";
    return;
  }
  if (!navigator.onLine) {
    $("#aierror").textContent = OFFLINE_MESSAGE;
    return;
  }
  aiRunning = true;
  aiCancelled = false;
  $("#aisubmit").disabled = true;
  let message = null;
  try {
    await sendApi("/ai-profile", "PUT", {
      level: f.level.value,
      goals: f.goals.value,
      equipment: f.equipment.value,
      constraints: f.constraints.value,
    });
    if (mode === "daily") message = await generateDailyWod(f, request);
    else if (mode === "week") {
      aiProgress("Génération en cours… (jusqu’à une minute)");
      await aiGenerate(f.wod_id.value, form.dataset.week, request);
      message = "WOD généré : relis-le et ajuste-le si besoin.";
    } else if (mode === "wod") message = await generateWodWeeks(f, request);
    else message = await generateProgram(f, request);
    if (message && !aiCancelled) await aiWaitDone($("#aiprogress"), "C’est prêt !");
  } catch (x) {
    $("#aierror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
  } finally {
    aiRunning = false;
    $("#aisubmit").disabled = false;
    $("#aiprogress").hidden = true;
  }
  if (message) {
    $("#aidialog").close();
    toast(message);
  }
  // Pré-remplissage : on revient au formulaire « Créer mon WOD », rien n’est encore enregistré.
  if (mode === "daily") return;
  // Recharge aussi après une erreur : des WOD ont pu être créés ou générés avant elle.
  // On reste sur la page d’où la génération a été lancée (Séances ou Programmes).
  if (message !== false) {
    await load();
    switchView(origin);
  }
};
$("#closeai").onclick = () => {
  if (aiRunning && !confirm("Arrêter la génération ? Les WOD déjà écrits sont conservés.")) return;
  aiCancelled = true;
  $("#aidialog").close();
};
// Touche Échap pendant une génération : même confirmation que la croix.
$("#aidialog").oncancel = e => {
  if (aiRunning && !confirm("Arrêter la génération ? Les WOD déjà écrits sont conservés.")) e.preventDefault();
  else aiCancelled = true;
};
