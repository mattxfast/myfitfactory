// FitFactory — box : adhésions (Mon compte) et espace gestionnaire (icône maison en haut, pages WOD, membres et infos).
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

let boxes = [],
  boxPending = {members: 0, managers: 0, coaches: 0},
  boxMemberships = [],
  boxCategories = [],
  managedBoxId = "",
  managedBox = null,
  managedWodWeek = "",
  boxListReorder = new Set();
const SCORE_LABELS = {time: "Temps (For Time)", reps: "Répétitions (AMRAP)", load: "Charge (kg)", none: "Sans score"};
const defaultWodName = (date, type = "WOD") => (type || "WOD") + " du " + fmt(date);
// Libellé d’un WOD de box : son type devant son nom, sauf si le nom commence déjà par le type.
const boxWodLabel = w =>
  w.type_name && !String(w.name || "").startsWith(w.type_name) ? w.type_name + " · " + w.name : w.name;
// WOD de box déjà chargés (semaine affichée, formulaire de séance, séances) : nom et type de score hors ligne.
const boxWodsById = new Map();
function rememberBoxWods(list) {
  for (const w of list || []) boxWodsById.set(w.id, {...boxWodsById.get(w.id), ...w});
  return list || [];
}
const memberBoxIds = () => boxIds("member");
// Score affiché : temps en min:s (h:min:s au-delà d’une heure), répétitions ou charge en kg.
function formatScore(type, value) {
  if (value === null || value === undefined || value === "") return "";
  const v = Number(value);
  if (type === "time") {
    const h = Math.floor(v / 3600),
      mn = Math.floor((v % 3600) / 60),
      sec = String(v % 60).padStart(2, "0");
    return h ? h + ":" + String(mn).padStart(2, "0") + ":" + sec : mn + ":" + sec;
  }
  if (type === "reps") return v + " rép.";
  if (type === "rounds") return v + (v === 1 ? " tour" : " tours");
  if (type === "load") return v.toLocaleString("fr-FR") + " kg";
  return String(v);
}
const TROPHY_ICON =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20.5h6"/></svg>';
const wodDay = date =>
  new Intl.DateTimeFormat("fr-FR", {weekday: "short", day: "2-digit", month: "2-digit"}).format(
    new Date(date + "T12:00:00")
  );
const boxFolded = new Set();
const BOX_ICONS = {
  edit: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  del: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>',
  ok: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  up: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  down: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>',
};
const personName = x => [x.first_name, x.last_name].filter(Boolean).join(" ") || x.email || "";
const boxName = id => boxes.find(b => b.id === id)?.name || "";
const boxIds = (role, status = "approved") =>
  boxMemberships.filter(m => m.role === role && m.status === status).map(m => m.box_id);

function setBoxes(d) {
  boxes = d.boxes || [];
  boxMemberships = d.memberships || [];
  boxCategories = d.categories || [];
  boxPending = d.pending || {members: 0, managers: 0, coaches: 0};
  renderMyBoxes();
  renderBoxNav();
}
async function loadBoxes() {
  setBoxes(await api("/boxes"));
}

// ----- Mon compte : mes box et demandes -----
function renderMyBoxes() {
  const label = m =>
    m.role === "manager"
      ? m.status === "pending"
        ? "gestionnaire · en attente de validation par un administrateur"
        : "gestionnaire"
      : m.status === "pending"
        ? "membre · en attente de validation par la box"
        : "membre";
  // Une ligne par box : icône athlète (membre) et/ou icône gestionnaire, celles de la barre du haut, chacune avec
  // son bouton pour quitter ce rôle (ou annuler la demande).
  const boxIdsSorted = [...new Set(boxMemberships.map(m => m.box_id))].sort((a, b) =>
      boxName(a).localeCompare(boxName(b), "fr")
    ),
    role = m =>
      `<span class="box-role ${m.status === "pending" ? "pending" : ""}" title="${esc(label(m))}"><span class="box-role-icon" role="img" aria-label="${esc(label(m))}">${m.role === "manager" ? MANAGER_ICON : ATHLETE_ICON}</span>${m.status === "pending" ? `<small>en attente</small>` : ""}<button type="button" class="smallbtn delete" data-leave-box="${m.box_id}" data-role="${m.role}" aria-label="${m.status === "pending" ? "Annuler la demande" : m.role === "manager" ? "Ne plus gérer cette box" : "Quitter la box"}" title="${m.status === "pending" ? "Annuler la demande" : m.role === "manager" ? "Ne plus gérer cette box" : "Quitter la box"}">${BOX_ICONS.del}</button></span>`;
  $("#myboxlist").innerHTML = boxIdsSorted.length
    ? boxIdsSorted
        .map(
          id =>
            `<div class="admin-row"><span>${esc(boxName(id))}</span><span class="box-roles">${["member", "manager"]
              .map(r => boxMemberships.find(m => m.box_id === id && m.role === r))
              .filter(Boolean)
              .map(role)
              .join("")}</span></div>`
        )
        .join("")
    : `<p class="muted">Tu n’as rejoint aucune box.</p>`;
  const select = $("#boxjoinselect"),
    previous = select.value;
  select.innerHTML = boxes.length
    ? boxes.map(b => `<option value="${b.id}">${esc(b.name)}${b.city ? " · " + esc(b.city) : ""}</option>`).join("")
    : `<option value="">Aucune box disponible</option>`;
  if (boxes.some(b => b.id === previous)) select.value = previous;
  select.disabled = $("#boxjoin").disabled = $("#boxmanagerrequest").disabled = !boxes.length;
  $("#myboxlist")
    .querySelectorAll("[data-leave-box]")
    .forEach(
      b =>
        (b.onclick = () => {
          const m = boxMemberships.find(x => x.box_id === b.dataset.leaveBox && x.role === b.dataset.role);
          const question =
            m.status === "pending"
              ? "Annuler cette demande ?"
              : m.role === "manager"
                ? "Ne plus gérer « " + boxName(m.box_id) + " » ?"
                : "Quitter « " + boxName(m.box_id) + " » ? Il faudra refaire une demande pour la rejoindre.";
          if (confirm(question)) boxRequest(m.box_id, m.role, "DELETE");
        })
    );
}
async function boxRequest(boxId, role, method) {
  $("#boxjoinerror").textContent = "";
  try {
    await api("/boxes/" + boxId + "/requests", {method, body: JSON.stringify({role})});
    await loadBoxes();
    toast(method === "DELETE" ? "C’est fait." : "Demande envoyée : elle doit maintenant être validée.");
  } catch (e) {
    $("#boxjoinerror").textContent = e.message;
  }
}
function requestBox(role) {
  const id = $("#boxjoinselect").value;
  if (!id) return;
  if (boxMemberships.some(m => m.box_id === id && m.role === role)) {
    $("#boxjoinerror").textContent =
      role === "manager" ? "Tu as déjà demandé à gérer cette box." : "Tu as déjà demandé à rejoindre cette box.";
    return;
  }
  boxRequest(id, role, "POST");
}
$("#boxjoin").onclick = () => requestBox("member");
$("#boxmanagerrequest").onclick = () => requestBox("manager");

// ----- Rejoindre une box en un toucher : fenêtre d’accueil (1re connexion) et ＋ de la rubrique « WOD de la box » -----
let boxWelcomeShown = false;
function openJoinBox(welcome = false) {
  const f = $("#joinboxform").elements;
  $("#joinboxform").reset();
  f.first_name.value = user?.first_name || "";
  f.last_name.value = user?.last_name || "";
  $("#joinboxtitle").textContent = welcome ? "Bienvenue !" : "Rejoindre une box";
  $("#joinboxintro").textContent = welcome
    ? "Tu t’entraînes dans une box ? Rejoins-la pour enregistrer ses WOD et voir les classements. Ta demande sera validée par un gestionnaire de la box."
    : "Ta demande sera validée par un gestionnaire de la box.";
  $("#joinboxlater").hidden = !welcome;
  $("#joinboxerror").textContent = "";
  renderJoinBoxList();
  $("#joinboxdialog").showModal();
}
function renderJoinBoxList() {
  const q = $("#joinboxform").elements.q.value.trim().toLowerCase(),
    list = boxes.filter(b => !q || (b.name + " " + (b.city || "")).toLowerCase().includes(q));
  $("#joinboxlist").innerHTML =
    list
      .map(b => {
        const m = boxMemberships.find(x => x.box_id === b.id && x.role === "member");
        return `<div class="program-search-result"><div><b>${esc(b.name)}</b>${b.city ? `<small>${esc(b.city)}</small>` : ""}</div>${
          m
            ? `<span class="tracked-tag">${m.status === "approved" ? "Membre" : "En attente"}</span>`
            : `<button type="button" class="smallbtn" data-join-box-id="${b.id}">Rejoindre</button>`
        }</div>`;
      })
      .join("") ||
    `<p class="muted">${boxes.length ? "Aucune box ne correspond à ta recherche." : "Aucune box n’est encore inscrite."}</p>`;
  $("#joinboxlist")
    .querySelectorAll("[data-join-box-id]")
    .forEach(b => (b.onclick = () => joinBox(b.dataset.joinBoxId, b)));
}
$("#joinboxform").elements.q.oninput = renderJoinBoxList;
$("#joinboxform").onsubmit = e => e.preventDefault();
async function joinBox(boxId, button) {
  const f = $("#joinboxform").elements,
    first = f.first_name.value.trim(),
    last = f.last_name.value.trim();
  $("#joinboxerror").textContent = "";
  if (!first || !last) {
    $("#joinboxerror").textContent = "Indique ton prénom et ton nom : ils sont montrés au gestionnaire de la box.";
    (first ? f.last_name : f.first_name).focus();
    return;
  }
  button.disabled = true;
  try {
    // Prénom et nom obligatoires pour une demande : enregistrés d’abord s’ils ont changé.
    await saveJoinBoxNames();
    await api("/boxes/" + boxId + "/requests", {method: "POST", body: JSON.stringify({role: "member"})});
    $("#joinboxdialog").close();
    await loadBoxes();
    renderWeek();
    toast("Demande envoyée à " + boxName(boxId) + " : elle doit maintenant être validée.");
  } catch (e) {
    $("#joinboxerror").textContent = e.message;
    button.disabled = false;
  }
}
// Prénom et nom saisis dans la fenêtre : enregistrés dans le profil dès qu’ils sont complets et modifiés, y compris
// quand on ferme la fenêtre sans choisir de box (« Plus tard », « Je ne suis dans aucune box », ×).
async function saveJoinBoxNames() {
  const f = $("#joinboxform").elements,
    first = f.first_name.value.trim(),
    last = f.last_name.value.trim();
  if (!first || !last || (first === user.first_name && last === user.last_name)) return;
  await api("/profile", {method: "PUT", body: JSON.stringify({first_name: first, last_name: last})});
  user = {...user, first_name: first, last_name: last};
  renderUserbar();
  $("#profileform").elements.first_name.value = first;
  $("#profileform").elements.last_name.value = last;
}
async function closeJoinBox() {
  $("#joinboxdialog").close();
  try {
    await saveJoinBoxNames();
  } catch (e) {
    toast(e.message);
  }
}
$("#closejoinbox").onclick = $("#joinboxskip").onclick = closeJoinBox;
$("#joinboxnone").onclick = async () => {
  await closeJoinBox();
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({box_prompt_dismissed: true})});
    if (preferences) preferences.box_prompt_dismissed = 1;
  } catch (e) {
    toast(e.message);
  }
};
// Fenêtre d’accueil : une fois par ouverture de l’application, tant que l’utilisateur n’a demandé aucune box et
// n’a pas répondu « Je ne suis dans aucune box ».
function maybeWelcomeBox() {
  if (
    boxWelcomeShown ||
    !boxes.length ||
    preferences?.box_prompt_dismissed ||
    boxMemberships.some(m => m.role === "member") ||
    document.querySelector("dialog[open]")
  )
    return;
  boxWelcomeShown = true;
  openJoinBox(true);
}

// ----- Espace gestionnaire (icône en haut) : pages WOD, membres et infos de la box, avec leur menu du bas -----
let boxPage = "wods";
function renderBoxNav() {
  const ids = boxIds("manager");
  if (!ids.length && inManagerSpace()) switchView("sessions");
  if (!ids.includes(managedBoxId)) {
    managedBoxId = ids[0] || "";
    managedBox = null;
  }
  $("#managedboxpicker").hidden = ids.length < 2;
  $("#managedboxselect").innerHTML = ids.map(id => `<option value="${id}">${esc(boxName(id))}</option>`).join("");
  $("#managedboxselect").value = managedBoxId;
  if (inManagerSpace()) loadManagedBox();
  if (user) renderUserbar();
}
document.querySelectorAll("[data-box-page]").forEach(
  b =>
    (b.onclick = () => {
      boxPage = b.dataset.boxPage;
      renderManagedBox();
      scrollTo(0, 0);
    })
);
$("#managedboxselect").onchange = e => {
  managedBoxId = e.target.value;
  boxWodTypeFilter.clear();
  managedBox = null;
  loadManagedBox();
};
async function loadManagedBox() {
  if (!managedBoxId) {
    $("#boxmanager").innerHTML = "";
    return;
  }
  if (!managedWodWeek) managedWodWeek = mondayOf(today());
  const id = managedBoxId,
    week = managedWodWeek;
  try {
    const [d, w] = await Promise.all([
      api("/manage/boxes/" + id),
      api("/manage/boxes/" + id + "/wods?from=" + week + "&to=" + addDays(week, 6)),
    ]);
    if (id !== managedBoxId || week !== managedWodWeek) return;
    managedBox = {...d, wods: w.wods};
    renderManagedBox();
  } catch (e) {
    toast(e.message);
  }
}
// Rubrique vide de l’espace gestionnaire : message au style d’une ligne de rubrique.
const boxEmpty = text => `<div class="admin-row section-empty"><span>${esc(text)}</span></div>`;
// Rubrique repliable au style des rubriques d’administration.
function boxGroup(key, title, actions, body) {
  const folded = boxFolded.has(key);
  return `<section class="admin-group ${folded ? "collapsed" : ""}" data-box-group="${key}"><div class="admin-group-title" role="button" tabindex="0" aria-expanded="${!folded}"><span class="admin-collapse-indicator">${folded ? "＋" : "−"}</span><span>${title}</span>${actions}</div><div class="admin-group-body"><div class="admin-data-list">${body}</div></div></section>`;
}
// Titre d’un WOD dans l’espace gestionnaire : jour, puis son nom entre guillemets s’il en a un (sans « WOD » devant ;
// un autre type, Haltéro par exemple, reste indiqué), sinon le nom par défaut.
function managerWodTitle(w) {
  const custom = w.name && w.name !== defaultWodName(w.wod_date, w.type_name),
    type = w.type_name && w.type_name !== "WOD" ? w.type_name : "";
  return custom
    ? [wodDay(w.wod_date), type, "« " + w.name + " »"].filter(Boolean).join(" · ")
    : wodDay(w.wod_date) + " · " + boxWodLabel(w);
}
// WOD de la box : navigation par semaine (WOD passés et à venir), ajout, modification, suppression.
// Blocs d’un WOD de box (mêmes titres que le serveur) ; le texte complet les reprend avec leur titre, c’est lui que
// voient les membres et qui pré-remplit « Réalisé / notes » de leur séance.
const BOX_WOD_BLOCKS = [
  ["warmup", "Échauffement"],
  ["technique", "Travail technique"],
  ["strength", "Force"],
  ["metcon", "Metcon"],
  ["finisher", "Finisher"],
];
const boxWodContent = blocks =>
  BOX_WOD_BLOCKS.filter(([key]) => String(blocks[key] || "").trim())
    .map(([key, label]) => label + "\n" + String(blocks[key]).replace(/\s+$/, ""))
    .join("\n\n");
// Blocs remplis d’un WOD [titre, texte] ; un WOD saisi sans blocs donne un seul morceau sans titre.
function boxWodBlockParts(w) {
  let blocks = null;
  try {
    blocks = w.blocks ? JSON.parse(w.blocks) : null;
  } catch {}
  if (!blocks) return w.content ? [["", w.content]] : [];
  return BOX_WOD_BLOCKS.filter(([key]) => String(blocks[key] || "").trim()).map(([key, label]) => [
    label,
    String(blocks[key]).replace(/\s+$/, ""),
  ]);
}
// Vue de la page WOD : liste (téléphone) ou planning de la semaine (une colonne par jour, pratique sur PC).
// Choix gardé sur l’appareil.
let boxWodView = (() => {
  try {
    return localStorage.getItem("fitfactory-boxwod-view") === "planning" ? "planning" : "list";
  } catch {
    return "list";
  }
})();
// Filtre par type de WOD (WOD, Hyrox, Haltéro…) sur la liste et le planning ; vide = tous les types.
const boxWodTypeFilter = new Set();
const filteredBoxWods = d => (boxWodTypeFilter.size ? d.wods.filter(w => boxWodTypeFilter.has(w.type_id)) : d.wods);
function boxWodTypeChips(d) {
  const types = (d.types || []).filter(t => d.wods.some(w => w.type_id === t.id) || boxWodTypeFilter.has(t.id));
  if (types.length < 2 && !boxWodTypeFilter.size) return "";
  return `<div class="choice-chips box-wod-types" aria-label="Filtrer par type de WOD"><label><input type="checkbox" data-wod-type-filter="" ${boxWodTypeFilter.size ? "" : "checked"}><span>Tous</span></label>${types
    .map(
      t =>
        `<label><input type="checkbox" data-wod-type-filter="${t.id}" ${boxWodTypeFilter.has(t.id) ? "checked" : ""}><span>${esc(t.name)}</span></label>`
    )
    .join("")}</div>`;
}
// Planning : une colonne par jour (lundi → dimanche), les WOD du jour en blocs colorés selon leur type de WOD.
function boxWodPlanning(d) {
  const types = d.types || [],
    dayName = date =>
      new Intl.DateTimeFormat("fr-FR", {weekday: "long", day: "numeric"})
        .format(new Date(date + "T12:00:00"))
        .replace(/^./, c => c.toUpperCase());
  return `<div class="box-planning">${Array.from({length: 7}, (_, i) => {
    const date = addDays(managedWodWeek, i),
      wods = filteredBoxWods(d).filter(w => w.wod_date === date);
    return `<section class="box-planning-day ${date === today() ? "today" : ""}"><div class="box-planning-head"><b>${esc(dayName(date))}</b><button type="button" class="smallbtn" data-add-boxwod-day="${date}" aria-label="Nouveau WOD le ${esc(fmt(date))}" title="Nouveau WOD ce jour">＋</button></div><div class="box-planning-body">${
      wods
        .map(w => {
          const t = Math.max(
            0,
            types.findIndex(x => x.id === w.type_id)
          );
          return `<button type="button" class="box-planning-wod wod-block-${t % 6}" data-edit-boxwod="${w.id}" title="Modifier"><small>${esc(w.type_name || "WOD")}</small><b>${esc(w.name)}</b>${boxWodBlockParts(
            w
          )
            .map(
              ([label, text]) =>
                `<span class="box-planning-part">${label ? `<em>${esc(label)}</em>` : ""}${esc(text)}</span>`
            )
            .join("")}</button>`;
        })
        .join("") || `<p class="box-planning-empty">Pas de WOD</p>`
    }</div></section>`;
  }).join("")}</div>`;
}
function boxWodsGroup(d) {
  // Comme la page Séances : la semaine en bandeau principal (avec le ＋ « Nouveau WOD »), les WOD dessous.
  const week = managedWodWeek,
    nav = `<div class="weekbar card"><div class="weeknav"><button type="button" class="smallbtn" id="boxwodprev" aria-label="Semaine précédente" title="Semaine précédente">‹</button><div class="weekdate-label"><button type="button" class="week-current" id="boxwodthisweek" title="Revenir à la semaine en cours">Semaine du</button><input id="boxwodweek" type="date" value="${week}" aria-label="Semaine du"></div><button type="button" class="smallbtn" id="boxwodnext" aria-label="Semaine suivante" title="Semaine suivante">›</button><button type="button" class="admin-add" id="addboxwod" aria-label="Nouveau WOD" title="Nouveau WOD">＋</button></div></div>`;
  // Choix d'affichage au style des onglets de « Mon fitness » (Forme / Records / Bilans).
  const views = `<div class="fitness-tabs" role="tablist" aria-label="Affichage des WOD">${[
    ["list", "Liste"],
    ["planning", "Planning"],
  ]
    .map(
      ([v, label]) =>
        `<button type="button" role="tab" class="fitness-tab ${boxWodView === v ? "active" : ""}" aria-selected="${boxWodView === v}" data-boxwod-view="${v}">${label}</button>`
    )
    .join("")}</div>`;
  const filters = boxWodTypeChips(d);
  if (boxWodView === "planning")
    return `<div id="boxwodboard" class="planning">${nav}${views}${filters}${boxWodPlanning(d)}</div>`;
  return `<div id="boxwodboard">${nav}${views}${filters}<div class="admin-data-list">${
    filteredBoxWods(d)
      .map(
        w =>
          `<div class="admin-row box-wod-row"><span class="admin-row-actions"><button class="smallbtn" data-edit-boxwod="${w.id}" aria-label="Modifier" title="Modifier">${BOX_ICONS.edit}</button><button class="smallbtn delete" data-del-boxwod="${w.id}" aria-label="Supprimer" title="Supprimer">${BOX_ICONS.del}</button></span><div class="box-wod-text" role="button" tabindex="0" data-view-boxwod="${w.id}" aria-label="Voir le détail du WOD"><b>${esc(managerWodTitle(w))}</b><span class="box-wod-score"><span class="tracked-tag">${esc(SCORE_LABELS[w.score_type] || "")}</span></span>${w.content ? `<small class="box-wod-content">${esc(w.content)}</small>` : ""}</div></div>`
      )
      .join("") || boxEmpty("Pas de WOD cette semaine")
  }</div></div>`;
}
function openBoxWod(w = null, presetDate = "") {
  const f = $("#boxwodform"),
    now = today(),
    weekEnd = addDays(managedWodWeek, 6);
  f.reset();
  f.elements.id.value = w?.id || "";
  f.elements.wod_date.value =
    w?.wod_date || presetDate || (now >= managedWodWeek && now <= weekEnd ? now : managedWodWeek);
  const types = managedBox?.types || [];
  f.elements.type_id.innerHTML = types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  f.elements.type_id.value = w?.type_id && types.some(t => t.id === w.type_id) ? w.type_id : types[0]?.id || "";
  // Un seul type filtré dans la page WOD : un nouveau WOD prend ce type par défaut.
  if (!w && boxWodTypeFilter.size === 1 && types.some(t => boxWodTypeFilter.has(t.id)))
    f.elements.type_id.value = [...boxWodTypeFilter][0];
  f.elements.name.value = w?.name && w.name !== defaultWodName(w.wod_date, w.type_name) ? w.name : "";
  syncBoxWodPlaceholder();
  f.elements.score_type.value = w?.score_type || "none";
  // Blocs du WOD ; un WOD saisi avant les blocs a tout son contenu dans « Metcon ».
  let blocks = null;
  try {
    blocks = w?.blocks ? JSON.parse(w.blocks) : null;
  } catch {}
  if (!blocks && w?.content) blocks = {metcon: w.content};
  for (const [key] of BOX_WOD_BLOCKS) f.elements["block_" + key].value = blocks?.[key] || "";
  // Mouvements du catalogue travaillés dans ce WOD : cochés par défaut dans la séance des membres.
  const ticked = new Set(w?.movement_ids || []);
  $("#boxwodmovements").innerHTML =
    movementCatalog
      .map(
        m =>
          `<label class="movement-check"><input type="checkbox" name="catalog_movement_ids" value="${esc(m.id)}" ${ticked.has(m.id) ? "checked" : ""}><span>${esc(m.name)}</span></label>`
      )
      .join("") || `<p class="muted">Le catalogue de mouvements est vide.</p>`;
  // Liste repliée à l’ouverture, comme dans le formulaire de séance : le titre indique combien sont cochés.
  $("#boxwodmovementdetails").open = false;
  syncBoxWodMovementCount();
  $("#boxwoddialogtitle").textContent = w ? "Modifier le WOD" : "Ajouter un WOD";
  $("#boxwoderror").textContent = "";
  $("#boxwoddialog").showModal();
}
function syncBoxWodMovementCount() {
  const n = $("#boxwodmovements").querySelectorAll("input:checked").length;
  $("#boxwodmovementcount").textContent = n ? n + (n > 1 ? " cochés" : " coché") : "aucun coché";
}
$("#boxwodmovements").onchange = syncBoxWodMovementCount;
// Nom par défaut affiché : « <type> du JJ/MM/AAAA ».
function syncBoxWodPlaceholder() {
  const f = $("#boxwodform").elements,
    type = (managedBox?.types || []).find(t => t.id === f.type_id.value)?.name;
  f.name.placeholder = defaultWodName(f.wod_date.value || today(), type);
}
$("#boxwodform").elements.wod_date.onchange = syncBoxWodPlaceholder;
$("#boxwodform").elements.type_id.onchange = syncBoxWodPlaceholder;
$("#boxwodform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    id = f.id.value,
    body = {
      wod_date: f.wod_date.value,
      name: f.name.value.trim(),
      score_type: f.score_type.value,
      type_id: f.type_id.value || undefined,
      ...(() => {
        const blocks = Object.fromEntries(BOX_WOD_BLOCKS.map(([key]) => [key, f["block_" + key].value]));
        return {blocks, content: boxWodContent(blocks)};
      })(),
      catalog_movement_ids: [...e.target.querySelectorAll('input[name="catalog_movement_ids"]:checked')].map(
        x => x.value
      ),
    };
  if (!id) body.client_id = crypto.randomUUID?.();
  try {
    await api(id ? "/manage/wods/" + id : "/manage/boxes/" + managedBoxId + "/wods", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#boxwoddialog").close();
    managedWodWeek = mondayOf(body.wod_date);
    await loadManagedBox();
    // Le gestionnaire est aussi membre : sa page Séances reprend le WOD modifié (mouvements, contenu…).
    loadSessions().catch(() => {});
    toast(id ? "WOD modifié." : "WOD ajouté.");
  } catch (x) {
    $("#boxwoderror").textContent = x.message;
  }
};
function changeManagedWodWeek(week) {
  managedWodWeek = week;
  loadManagedBox();
}
function renderManagedBox() {
  document
    .querySelectorAll("[data-box-page]")
    .forEach(b => b.classList.toggle("active", b.dataset.boxPage === boxPage));
  const d = managedBox;
  if (!d) return;
  const pending = d.members.filter(x => x.status === "pending"),
    members = d.members.filter(x => x.status === "approved");
  const person = x => `${esc(personName(x))} <small class="muted">${esc(x.email)}</small>`;
  const membersPage = () =>
    boxGroup(
      "requests",
      `Demandes d’adhésion (${pending.length})`,
      "",
      pending
        .map(
          x =>
            `<div class="admin-row"><span>${person(x)}</span><span class="admin-row-actions"><button class="smallbtn" data-member-decision="1" data-user="${x.user_id}" aria-label="Valider" title="Valider l’adhésion">${BOX_ICONS.ok}</button><button class="smallbtn delete" data-member-decision="0" data-user="${x.user_id}" aria-label="Refuser" title="Refuser la demande">${BOX_ICONS.del}</button></span></div>`
        )
        .join("") || boxEmpty("Pas de demande en attente")
    ) +
    boxGroup(
      "members",
      `Membres (${members.length})`,
      "",
      members
        .map(
          x =>
            `<div class="admin-row"><span>${person(x)}${x.is_manager ? ` <span class="tracked-tag">Gestionnaire</span>` : ""}</span><span class="admin-row-actions"><button class="smallbtn delete" data-remove-member="${x.user_id}" aria-label="Retirer de la box" title="${x.is_manager ? "Un gestionnaire ne peut pas être retiré" : "Retirer de la box"}" ${x.is_manager ? "disabled" : ""}>${BOX_ICONS.del}</button></span></div>`
        )
        .join("") || boxEmpty("Pas de membre")
    );
  const infoPage = () =>
    boxGroup(
      "info",
      "Box",
      "",
      `<form id="boxinfoform" class="profile-card"><label>Nom de la box<input name="name" maxlength="80" required value="${esc(d.box.name)}"></label><label>Ville<input name="city" maxlength="80" value="${esc(d.box.city || "")}"></label><button class="primary">Enregistrer</button></form>`
    ) +
    boxListGroup("wod-types", d.types || []) +
    boxListGroup("categories", d.categories);
  $("#boxmanager").innerHTML =
    boxPage === "members" ? membersPage() : boxPage === "info" ? infoPage() : boxWodsGroup(d);
  bindManagedBox();
}
// Listes paramétrables de la box (types de WOD, catégories de score) : ajout, renommage, ordre (⇅), suppression.
const BOX_LIST_UI = {
  "wod-types": {
    key: "types",
    title: "Types de WOD",
    ask: "Nom du nouveau type de WOD :",
    added: "Type de WOD ajouté.",
    renamed: "Type de WOD renommé.",
    deleted: "Type de WOD supprimé.",
  },
  categories: {
    key: "categories",
    title: "Catégories",
    ask: "Nom de la nouvelle catégorie :",
    added: "Catégorie ajoutée.",
    renamed: "Catégorie renommée.",
    deleted: "Catégorie supprimée.",
  },
};
function boxListGroup(kind, items) {
  const reorder = boxListReorder.has(kind);
  return boxGroup(
    kind,
    BOX_LIST_UI[kind].title,
    `${items.length > 1 ? `<button type="button" class="smallbtn reorder-toggle ${reorder ? "active" : ""}" data-list-reorder="${kind}" aria-pressed="${reorder}" aria-label="Réorganiser" title="Réorganiser">⇅</button>` : ""}<button type="button" class="admin-add" data-list-add="${kind}" aria-label="Ajouter" title="Ajouter">＋</button>`,
    items
      .map(
        (c, i) =>
          `<div class="admin-row"><span>${esc(c.name)}${kind === "wod-types" && i === 0 ? ` <span class="tracked-tag">Par défaut</span>` : ""}</span><span class="admin-row-actions">${reorder ? `<button class="smallbtn admin-reorder" data-list-move="${kind}" data-id="${c.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}>${BOX_ICONS.up}</button><button class="smallbtn admin-reorder" data-list-move="${kind}" data-id="${c.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === items.length - 1 ? "disabled" : ""}>${BOX_ICONS.down}</button>` : ""}<button class="smallbtn" data-list-edit="${kind}" data-id="${c.id}" aria-label="Renommer" title="Renommer">${BOX_ICONS.edit}</button><button class="smallbtn delete" data-list-del="${kind}" data-id="${c.id}" aria-label="Supprimer" title="Supprimer">${BOX_ICONS.del}</button></span></div>`
      )
      .join("") || boxEmpty("Pas d’élément dans cette liste")
  );
}
function bindBoxLists(root, d) {
  const items = kind => d[BOX_LIST_UI[kind].key] || [];
  root.querySelectorAll("[data-list-add]").forEach(
    b =>
      (b.onclick = () => {
        const kind = b.dataset.listAdd,
          name = (prompt(BOX_LIST_UI[kind].ask, "") || "").trim();
        if (name)
          boxAction(
            "/manage/boxes/" + d.box.id + "/" + kind,
            "POST",
            {name, client_id: crypto.randomUUID?.()},
            BOX_LIST_UI[kind].added
          );
      })
  );
  root.querySelectorAll("[data-list-reorder]").forEach(
    b =>
      (b.onclick = () => {
        const kind = b.dataset.listReorder;
        if (boxListReorder.has(kind)) boxListReorder.delete(kind);
        else boxListReorder.add(kind);
        renderManagedBox();
      })
  );
  root.querySelectorAll("[data-list-move]").forEach(
    b =>
      (b.onclick = () => {
        const kind = b.dataset.listMove,
          ids = items(kind).map(c => c.id),
          i = ids.indexOf(b.dataset.id),
          j = i + Number(b.dataset.direction);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        boxAction("/manage/boxes/" + d.box.id + "/" + kind + "/order", "PUT", {ids});
      })
  );
  root.querySelectorAll("[data-list-edit]").forEach(
    b =>
      (b.onclick = () => {
        const kind = b.dataset.listEdit,
          c = items(kind).find(x => x.id === b.dataset.id),
          name = (prompt("Renommer :", c.name) || "").trim();
        if (name && name !== c.name)
          boxAction("/manage/" + kind + "/" + c.id, "PUT", {name}, BOX_LIST_UI[kind].renamed);
      })
  );
  root.querySelectorAll("[data-list-del]").forEach(
    b =>
      (b.onclick = () => {
        const kind = b.dataset.listDel,
          c = items(kind).find(x => x.id === b.dataset.id);
        if (confirm("Supprimer « " + c.name + " » ?"))
          boxAction("/manage/" + kind + "/" + c.id, "DELETE", null, BOX_LIST_UI[kind].deleted);
      })
  );
}
async function boxAction(path, method, body, message) {
  try {
    await api(path, {method, body: body ? JSON.stringify(body) : undefined});
    await loadManagedBox();
    loadBoxes().catch(() => {}); // met à jour l’alerte rouge de l’icône gestionnaire
    loadSessions().catch(() => {}); // WOD supprimé ou modifié : page Séances à jour
    if (message) toast(message);
  } catch (e) {
    toast(e.message);
  }
}
function bindManagedBox() {
  const root = $("#boxmanager"),
    d = managedBox;
  root.querySelectorAll("[data-box-group] > .admin-group-title").forEach(h => {
    const toggle = () => {
      const key = h.parentElement.dataset.boxGroup;
      if (boxFolded.has(key)) boxFolded.delete(key);
      else boxFolded.add(key);
      renderManagedBox();
    };
    h.onclick = e => {
      if (!e.target.closest("button")) toggle();
    };
    h.onkeydown = e => {
      if (e.target === h && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        toggle();
      }
    };
  });
  root.querySelectorAll("[data-member-decision]").forEach(
    b =>
      (b.onclick = () => {
        const approve = b.dataset.memberDecision === "1";
        if (!approve && !confirm("Refuser cette demande d’adhésion ?")) return;
        boxAction(
          "/manage/boxes/" + d.box.id + "/members/" + b.dataset.user,
          "PUT",
          {approve},
          approve ? "Adhésion validée." : "Demande refusée."
        );
      })
  );
  root.querySelectorAll("[data-remove-member]").forEach(
    b =>
      (b.onclick = () => {
        const x = d.members.find(m => m.user_id === b.dataset.removeMember);
        if (confirm("Retirer " + personName(x) + " de la box ?"))
          boxAction("/manage/boxes/" + d.box.id + "/members/" + x.user_id, "DELETE", null, "Membre retiré.");
      })
  );
  if (boxPage === "wods") {
    $("#addboxwod").onclick = () => openBoxWod();
    root.querySelectorAll("[data-boxwod-view]").forEach(
      i =>
        (i.onclick = () => {
          boxWodView = i.dataset.boxwodView;
          try {
            localStorage.setItem("fitfactory-boxwod-view", boxWodView);
          } catch {}
          renderManagedBox();
        })
    );
    root.querySelectorAll("[data-wod-type-filter]").forEach(
      i =>
        (i.onchange = () => {
          const id = i.dataset.wodTypeFilter;
          if (!id) boxWodTypeFilter.clear();
          else if (boxWodTypeFilter.has(id)) boxWodTypeFilter.delete(id);
          else boxWodTypeFilter.add(id);
          renderManagedBox();
        })
    );
    root
      .querySelectorAll("[data-add-boxwod-day]")
      .forEach(b => (b.onclick = () => openBoxWod(null, b.dataset.addBoxwodDay)));
    $("#boxwodprev").onclick = () => changeManagedWodWeek(addDays(managedWodWeek, -7));
    $("#boxwodthisweek").onclick = () => changeManagedWodWeek(mondayOf(today()));
    $("#boxwodnext").onclick = () => changeManagedWodWeek(addDays(managedWodWeek, 7));
    $("#boxwodweek").onchange = e => e.target.value && changeManagedWodWeek(mondayOf(e.target.value));
  }
  const info = $("#boxinfoform");
  if (info)
    info.onsubmit = async e => {
      e.preventDefault();
      const f = e.target.elements;
      await boxAction(
        "/manage/boxes/" + d.box.id,
        "PUT",
        {name: f.name.value, city: f.city.value},
        "Infos de la box enregistrées."
      );
      loadBoxes().catch(() => {});
    };
  root
    .querySelectorAll("[data-edit-boxwod]")
    .forEach(b => (b.onclick = () => openBoxWod(d.wods.find(w => w.id === b.dataset.editBoxwod))));
  // Liste : un toucher sur le texte d’un WOD ouvre son détail en fenêtre (comme dans les autres pages).
  root.querySelectorAll("[data-view-boxwod]").forEach(t => {
    t.onclick = e => {
      blurAfterTap(t, e);
      openManagerWodDetail(d.wods.find(w => w.id === t.dataset.viewBoxwod));
    };
    t.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        t.click();
      }
    };
  });
  root.querySelectorAll("[data-del-boxwod]").forEach(
    b =>
      (b.onclick = () => {
        const w = d.wods.find(x => x.id === b.dataset.delBoxwod);
        if (confirm("Supprimer « " + w.name + " » ?"))
          boxAction("/manage/wods/" + w.id, "DELETE", null, "WOD supprimé.");
      })
  );
  bindBoxLists(root, d);
}

// Détail d’un WOD dans l’espace gestionnaire (même fenêtre que dans la page Séances) : contenu par bloc, bouton
// Modifier.
function openManagerWodDetail(w) {
  if (!w) return;
  $("#dailydetailtitle").textContent = managerWodTitle(w);
  $("#dailydetailmeta").textContent = [w.type_name, SCORE_LABELS[w.score_type]].filter(Boolean).join(" · ");
  fillWodBody(
    $("#dailydetailbody"),
    w.blocks ? boxWodBlockParts(w).map(([label, text]) => ({label, text})) : null,
    w.content || "Pas de contenu écrit pour ce WOD."
  );
  $("#dailydetailactions").innerHTML = `<button type="button" class="smallbtn" data-detail-edit>Modifier</button>`;
  $("#dailydetailactions").querySelector("[data-detail-edit]").onclick = () => {
    $("#dailydetaildialog").close();
    openBoxWod(w);
  };
  $("#dailydetaildialog").showModal();
}
// ----- Classement d’un WOD de box (membres de la box uniquement) -----
async function openLeaderboard(wodId) {
  const known = boxWodsById.get(wodId);
  $("#leaderboardtitle").textContent = known?.name || "Classement";
  $("#leaderboardmeta").textContent = "";
  $("#leaderboardbody").innerHTML = `<p class="muted">Chargement…</p>`;
  $("#leaderboarddialog").showModal();
  try {
    const d = await api("/box-wods/" + wodId + "/leaderboard"),
      w = rememberBoxWods([d.wod])[0];
    $("#leaderboardtitle").textContent = boxWodLabel(w);
    $("#leaderboardmeta").textContent = [w.box_name, fmt(w.wod_date), SCORE_LABELS[w.score_type]].join(" · ");
    $("#leaderboardbody").innerHTML =
      (w.content ? `<p class="leaderboard-content">${esc(w.content)}</p>` : "") +
      (w.score_type === "none"
        ? `<p class="muted">Ce WOD n’a pas de score.</p>`
        : d.categories
            .map(
              c =>
                `<section class="leaderboard-category"><h3>${esc(c.name)}</h3>${
                  c.rows.length
                    ? `<ol class="leaderboard-list">${c.rows
                        .map(
                          (x, i) =>
                            `<li class="${x.is_me ? "me" : ""}"><span class="leaderboard-rank">${i + 1}</span><span class="leaderboard-name">${esc(personName(x))}${x.pending ? ` <small class="muted">(en attente)</small>` : ""}</span><b>${esc(formatScore(w.score_type, x.score))}</b></li>`
                        )
                        .join("")}</ol>`
                    : `<p class="muted">Aucun score.</p>`
                }</section>`
            )
            .join(""));
  } catch (e) {
    $("#leaderboardbody").innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
$("#closeleaderboard").onclick = () => $("#leaderboarddialog").close();
