// FitFactory — programmes, WOD, mouvements et fenêtres de programme/WOD.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

function programWeeks(program) {
  const weeks = [];
  for (let start = mondayOf(program.start_monday); start <= program.end_monday; start = addDays(start, 7))
    weeks.push(start);
  return weeks;
}
// Nom d’une semaine : « semaine du JJ/MM/AAAA », ou « semaine N » pour un programme de coach sans dates.
function weekName(program, week) {
  return program?.coach_mode === "free"
    ? "semaine " + (programWeeks(program).indexOf(week) + 1)
    : "semaine du " + fmt(week);
}
// Le WOD technique « __AUTRES__ » (séances « Autres ») n’est jamais affiché dans les listes de WOD.
function visibleWods(pid) {
  return (wodsByProgram[pid] || []).filter(w => w.name !== "__AUTRES__");
}
function weeklyWodContent(wodId, weekStart) {
  return weeklyWodPrograms.find(x => x.wod_id === wodId && x.week_start === weekStart)?.content || "";
}
function renderWodWeeklyProgramming(program, wod) {
  // Programme de coach sans dates : semaines numérotées seulement (chacun choisit sa date de début en l’acceptant).
  const weeks = programWeeks(program),
    expanded = window.cfExpandedWodProgramming || (window.cfExpandedWodProgramming = new Set()),
    open = expanded.has(wod.id);
  return `<div class="wod-weekly-program ${open ? "" : "collapsed"}"><button type="button" class="wod-weekly-toggle" data-toggle-wod-programming="${wod.id}" aria-expanded="${open}"><span>Programmation hebdomadaire</span><small>${weeksLabel(weeks.length)}</small><b aria-hidden="true">${open ? "−" : "＋"}</b></button><div class="wod-weekly-body">${weeks
    .map((week, index) => {
      const number = index + 1,
        date = program.coach_mode === "free" ? "" : fmt(week),
        content = weeklyWodContent(wod.id, week),
        heading = `<b>S${number}</b><small>${date}</small>`;
      if (program.read_only)
        return `<div class="wod-week-row"><div class="wod-week-head">${heading}</div><div class="wod-week-content${content ? "" : " muted"}">${esc(content || "Pas de contenu écrit pour cette semaine.")}</div></div>`;
      // Hauteur adaptée au contenu, 12 lignes au plus.
      const rows = Math.min(12, Math.max(2, content.split("\n").length));
      return `<div class="wod-week-row"><div class="wod-week-head">${heading}<button type="button" class="smallbtn" data-ai-wod-week="${wod.id}" data-program="${program.id}" data-week="${week}" aria-label="Regénérer cette semaine avec l’IA" title="Regénérer cette semaine avec l’IA">${AI_ICON}</button><button type="button" class="smallbtn save-wod-week" data-wod="${wod.id}" data-week="${week}">Enregistrer</button></div><textarea rows="${rows}" maxlength="2000" aria-label="Contenu prévu, semaine ${number}${date ? " du " + date : ""}" data-wod-week-content="${wod.id}" data-week="${week}" placeholder="Contenu prévu pour ce WOD…">${esc(content)}</textarea></div>`;
    })
    .join("")}</div></div>`;
}
// Programmes repliés par défaut : seuls ceux que l’utilisateur a dépliés (pendant la session) sont ouverts.
function programFolds() {
  const open = window.cfOpenPrograms || (window.cfOpenPrograms = new Set());
  return {has: id => !open.has(id), add: id => open.delete(id), delete: id => open.add(id)};
}
// Icône « étincelles » des boutons de génération par IA.
const AI_ICON =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5l-1.7-4.3L5 9.5l4.3-1.7z"/><path d="M18 14l.9 2.1 2.1.9-2.1.9L18 20l-.9-2.1-2.1-.9 2.1-.9z"/></svg>';
const PROGRAM_EDIT_ICON =
    '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  PROGRAM_DELETE_ICON =
    '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
// Rubrique vide d'un programme : même message et même style de ligne que dans la page Séances.
const programEmpty = text => `<div class="movement-row section-empty"><span>${esc(text)}</span></div>`;
function renderPrograms() {
  const collapsed = programFolds();
  const folded = window.cfProgramSections || (window.cfProgramSections = new Set());
  const reordering = window.cfReorderSections || (window.cfReorderSections = new Set());
  const reorderToggle = (key, count, label) =>
    count > 1
      ? `<button type="button" class="smallbtn reorder-toggle ${reordering.has(key) ? "active" : ""}" data-toggle-reorder="${key}" aria-pressed="${reordering.has(key)}" aria-label="${label}" title="${label}">⇅</button>`
      : "";
  // Le programme technique « Hors programme » n'est pas affiché (voir isFallbackProgram), ni un programme d'un autre
  // auteur qu'on ne suit plus (il ne sert qu'à l'historique). Le programme suivi est affiché en lecture seule.
  const shown = programs.filter(p => !isFallbackProgram(p) && !p.read_only),
    followed = programs.filter(p => p.followed);
  $("#programlist").innerHTML =
    followed.map(followedProgramCard).join("") +
    (shown.length
      ? shown
          .map(
            p =>
              `<article class="program card ${collapsed.has(p.id) ? "collapsed" : ""}"><div class="programhead"><div class="program-title"><button class="smallbtn collapse-program" data-toggle-program="${p.id}" aria-expanded="${!collapsed.has(p.id)}">${collapsed.has(p.id) ? "＋" : "−"}</button><div><h3>${esc(p.name)}${p.coach_mode ? ` <span class="tracked-tag">Coach</span>` : ""}</h3><small>${programSubtitle(p)}</small></div></div><div class="entryactions">${p.coach_mode ? `<button class="smallbtn" data-coach-invite="${p.id}" aria-label="Proposer à des inscrits" title="Proposer à des inscrits"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6"/><path d="M16 11h6"/></svg></button>` : ""}<button class="smallbtn" data-edit-program="${p.id}" aria-label="Modifier" title="Modifier">${PROGRAM_EDIT_ICON}</button><button class="smallbtn delete ${p.has_sessions ? "is-disabled" : ""}" data-del-program="${p.id}" aria-label="Supprimer le programme" title="${p.has_sessions ? "Ce programme a déjà une séance réalisée et ne peut pas être supprimé" : "Supprimer le programme"}" ${p.has_sessions ? 'aria-disabled="true"' : ""}>${PROGRAM_DELETE_ICON}</button></div></div><div class="programbody"><div class="program-section program-subsection ${folded.has(p.id + ":wods") ? "collapsed" : ""}"><div class="program-section-heading program-section-toolbar"><button class="smallbtn section-collapse program-section-toggle" data-toggle-program-section="${p.id}:wods" aria-label="Replier les WOD" aria-expanded="${!folded.has(p.id + ":wods")}">${folded.has(p.id + ":wods") ? "＋" : "−"}</button><span>WOD</span>${reorderToggle(p.id + ":wods", visibleWods(p.id).length, "Réorganiser les WOD")}<button type="button" class="smallbtn" data-ai-program="${p.id}" aria-label="Générer le programme avec l’IA" title="Générer le programme avec l’IA">${AI_ICON}</button>${p.published_at ? "" : `<button class="primary addsession-compact addwod" data-add-wod="${p.id}" aria-label="Ajouter un WOD" title="Ajouter un WOD">＋</button>`}</div><div class="program-subsection-body"><div class="wodlist">${
                visibleWods(p.id)
                  .map(
                    (w, i) =>
                      `<div class="wod-entry"><div class="wodrow"><div class="wod-title"><b>${esc(w.name)}</b>${w.is_tracked ? `<span class="tracked-tag">Suivi</span>` : ""}</div><div class="entryactions reorder-actions">${reordering.has(p.id + ":wods") ? `<button class="smallbtn reorder-btn" data-move-wod="${w.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg></button><button class="smallbtn reorder-btn" data-move-wod="${w.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === visibleWods(p.id).length - 1 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg></button>` : ""}<button type="button" class="smallbtn" data-ai-wod="${w.id}" data-program="${p.id}" aria-label="Générer ce WOD sur toutes les semaines avec l’IA" title="Générer ce WOD sur toutes les semaines avec l’IA">${AI_ICON}</button><button class="smallbtn" data-edit-wod="${w.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button>${p.published_at ? "" : `<button class="smallbtn delete ${w.has_sessions ? "is-disabled" : ""}" data-del-wod="${w.id}" aria-label="Supprimer le WOD" title="${w.has_sessions ? "Ce WOD a déjà été réalisé et ne peut pas être supprimé" : "Supprimer le WOD"}" ${w.has_sessions ? 'disabled aria-disabled="true"' : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>`}</div>${w.planned_comment ? `<p>${esc(w.planned_comment)}</p>` : ""}${w.is_tracked ? renderWodWeeklyProgramming(p, w) : ""}</div></div>`
                  )
                  .join("") || programEmpty("Pas de WOD pour cette programmation")
              }</div></div></div><div class="movement-editor compact program-section program-subsection ${folded.has(p.id + ":movements") ? "collapsed" : ""}"><div class="program-section-heading program-section-toolbar"><button class="smallbtn section-collapse program-section-toggle" data-toggle-program-section="${p.id}:movements" aria-label="Replier les mouvements" aria-expanded="${!folded.has(p.id + ":movements")}">${folded.has(p.id + ":movements") ? "＋" : "−"}</button><span>Focus mouvement</span>${reorderToggle(p.id + ":movements", (movementsByProgram[p.id] || []).length, "Réorganiser les mouvements")}<button class="primary addsession-compact addwod" data-pick-movements="${p.id}" aria-label="Ajouter un mouvement depuis le catalogue" title="Ajouter un mouvement depuis le catalogue">＋</button></div><div class="program-subsection-body"><div class="program-movement-list">${(movementsByProgram[p.id] || []).map((m, i) => `<div class="movement-row"><span>${esc(m.name)}</span><div class="entryactions reorder-actions">${reordering.has(p.id + ":movements") ? `<button class="smallbtn reorder-btn" data-move-movement="${m.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg></button><button class="smallbtn reorder-btn" data-move-movement="${m.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === (movementsByProgram[p.id] || []).length - 1 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg></button>` : ""}${m.catalog_movement_id ? "" : `<button class="smallbtn" data-edit-movement="${m.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button>`}<button class="smallbtn delete" data-del-movement="${m.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div></div>`).join("") || programEmpty("Pas de mouvement pour cette programmation")}</div></div></div></div></div></article>`
          )
          .join("")
      : followed.length
        ? ""
        : // Sans programme, aucune carte ne sert de bandeau : le titre de la page reste affiché.
          "<div class='page-banner'><h2>Mes programmes</h2></div><div class='card empty'>Aucun programme. Crée ton premier programme ou trouve un programme public à suivre.</div>");
  $("#programlist")
    .querySelectorAll("[data-follow-dates]")
    .forEach(b => {
      const p = programs.find(x => x.id === b.dataset.followDates);
      b.onclick = () =>
        p.coach_mode
          ? openCoachStartDialog(p, null, p.start_monday)
          : openFollowDialog(
              {
                ...p,
                start_monday: p.author_start_monday || p.start_monday,
                end_monday: p.author_end_monday || p.end_monday,
              },
              {start: p.start_monday, end: p.end_monday}
            );
    });
  $("#programlist")
    .querySelectorAll("[data-unfollow-program]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (!confirm("Arrêter de suivre ce programme ? Tes séances déjà enregistrées restent dans l’historique."))
            return;
          try {
            await api("/program-follow", {method: "DELETE"});
            await load();
            toast("Tu ne suis plus ce programme.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#programlist")
    .querySelectorAll("[data-toggle-wod-programming]")
    .forEach(
      b =>
        (b.onclick = () => {
          const key = b.dataset.toggleWodProgramming,
            set = window.cfExpandedWodProgramming || (window.cfExpandedWodProgramming = new Set());
          if (set.has(key)) set.delete(key);
          else set.add(key);
          renderPrograms();
        })
    );
  // ✨ d’une semaine : régénère ce WOD pour cette semaine seulement (on reste sur la page Programmes).
  $("#programlist")
    .querySelectorAll("[data-ai-wod-week]")
    .forEach(
      b => (b.onclick = () => openAiDialog("week", b.dataset.program, b.dataset.aiWodWeek, b.dataset.week, "programs"))
    );
  $("#programlist")
    .querySelectorAll(".save-wod-week")
    .forEach(
      b =>
        (b.onclick = async () => {
          const wod = b.dataset.wod,
            week = b.dataset.week,
            field = $("#programlist").querySelector('[data-wod-week-content="' + wod + '"][data-week="' + week + '"]'),
            content = field?.value || "";
          b.disabled = true;
          try {
            await api("/wods/" + wod + "/weekly-programming", {
              method: "PUT",
              body: JSON.stringify({week_start: week, content}),
            });
            const old = weeklyWodPrograms.find(x => x.wod_id === wod && x.week_start === week);
            if (old) old.content = content;
            else weeklyWodPrograms.push({wod_id: wod, week_start: week, content});
            toast("Programmation hebdomadaire enregistrée.");
          } catch (e) {
            toast(e.message);
          } finally {
            b.disabled = false;
          }
        })
    );
  $("#programlist")
    .querySelectorAll("[data-toggle-program-section]")
    .forEach(
      b =>
        (b.onclick = () => {
          const key = b.dataset.toggleProgramSection;
          if (folded.has(key)) folded.delete(key);
          else folded.add(key);
          renderPrograms();
        })
    );
  $("#programlist")
    .querySelectorAll("[data-toggle-reorder]")
    .forEach(
      b =>
        (b.onclick = () => {
          const key = b.dataset.toggleReorder;
          if (reordering.has(key)) reordering.delete(key);
          else reordering.add(key);
          renderPrograms();
        })
    );
  $("#programlist")
    .querySelectorAll("[data-toggle-program]")
    .forEach(
      b =>
        (b.onclick = () => {
          const id = b.dataset.toggleProgram;
          if (collapsed.has(id)) collapsed.delete(id);
          else collapsed.add(id);
          renderPrograms();
        })
    );
  $("#programlist")
    .querySelectorAll("[data-move-wod]")
    .forEach(b => (b.onclick = () => moveProgramItem(b.dataset.moveWod, b.dataset.direction, "wod")));
  $("#programlist")
    .querySelectorAll("[data-move-movement]")
    .forEach(b => (b.onclick = () => moveProgramItem(b.dataset.moveMovement, b.dataset.direction, "movement")));
  $("#programlist")
    .querySelectorAll("[data-edit-program]")
    .forEach(b => (b.onclick = () => openProgram(programs.find(p => p.id === b.dataset.editProgram))));
  $("#programlist")
    .querySelectorAll("[data-del-program]")
    .forEach(
      b =>
        (b.onclick = async () => {
          // Bouton grisé mais cliquable : sur téléphone, l’info-bulle n’est pas visible, on explique pourquoi.
          if (programs.find(x => x.id === b.dataset.delProgram)?.has_sessions) {
            toast("Ce programme contient des séances (y compris « Autres ») : supprime-les d’abord.");
            return;
          }
          if (confirm("Supprimer ce programme et ses WOD ?")) {
            try {
              await api("/programs/" + b.dataset.delProgram, {method: "DELETE"});
              load();
            } catch (e) {
              toast(e.message);
            }
          }
        })
    );
  $("#programlist")
    .querySelectorAll("[data-pick-movements]")
    .forEach(b => (b.onclick = () => openMovementPicker(b.dataset.pickMovements)));
  $("#programlist")
    .querySelectorAll("[data-edit-movement]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const id = b.dataset.editMovement;
          let current = "";
          for (const pid of Object.keys(movementsByProgram)) {
            const m = movementsByProgram[pid].find(x => x.id === id);
            if (m) {
              current = m.name;
              break;
            }
          }
          const name = prompt("Modifier le mouvement :", current);
          if (name === null || !name.trim() || name.trim() === current) return;
          try {
            await api("/movements/" + id, {method: "PUT", body: JSON.stringify({name: name.trim()})});
            await load();
            toast("Mouvement modifié.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#programlist")
    .querySelectorAll("[data-del-movement]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (confirm("Supprimer ce mouvement et ses validations ?")) {
            await api("/movements/" + b.dataset.delMovement, {method: "DELETE"});
            await load();
          }
        })
    );
  $("#programlist")
    .querySelectorAll("[data-coach-invite]")
    .forEach(b => (b.onclick = () => openCoachInvite(b.dataset.coachInvite)));
  renderCoachInvites();
  $("#programlist")
    .querySelectorAll("[data-ai-program]")
    .forEach(b => (b.onclick = () => openAiDialog("program", b.dataset.aiProgram)));
  $("#programlist")
    .querySelectorAll("[data-ai-wod]")
    .forEach(b => (b.onclick = () => openAiDialog("wod", b.dataset.program, b.dataset.aiWod)));
  $("#programlist")
    .querySelectorAll("[data-add-wod]")
    .forEach(b => (b.onclick = () => openWod(b.dataset.addWod)));
  $("#programlist")
    .querySelectorAll("[data-edit-wod]")
    .forEach(
      b =>
        (b.onclick = () => {
          const id = b.dataset.editWod;
          for (const pid of Object.keys(wodsByProgram)) {
            const w = wodsByProgram[pid].find(x => x.id === id);
            if (w) {
              openWod(pid, w);
              break;
            }
          }
        })
    );
  $("#programlist")
    .querySelectorAll("[data-del-wod]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (confirm("Supprimer ce WOD et les séances associées ?")) {
            await api("/wods/" + b.dataset.delWod, {method: "DELETE"});
            load();
          }
        })
    );
}
// Sous-titre d’un programme : dates (ou nombre de semaines d’un programme de coach sans dates), partage.
function programSubtitle(p) {
  const people = n => n + " personne" + (n > 1 ? "s" : "");
  if (p.is_default) return "Programme par défaut · 01/01/1970 → 31/12/2100";
  if (p.coach_mode)
    return (
      p.coach_weeks +
      " semaine" +
      (p.coach_weeks > 1 ? "s" : "") +
      " · " +
      (p.coach_mode === "free" ? "sans dates" : fmt(p.start_monday) + " → " + fmt(p.end_monday)) +
      (p.published_at ? " · proposé" + (p.followers ? ", suivi par " + people(p.followers) : "") : "")
    );
  return (
    fmt(p.start_monday) +
    " → " +
    fmt(p.end_monday) +
    (p.is_public ? " · public" + (p.followers ? ", suivi par " + people(p.followers) : "") : "")
  );
}
// Programme suivi (programme public d’un autre utilisateur, ou programme de coach accepté), en lecture seule et mis à
// jour en direct par son auteur.
function followedProgramCard(p) {
  // Lecture seule, mais le programme et ses rubriques se plient et se déplient comme ceux de l’utilisateur.
  const author = [p.author_first_name, p.author_last_name].filter(Boolean).join(" "),
    week = mondayOf(today()),
    movements = movementsByProgram[p.id] || [],
    collapsed = programFolds(),
    folded = window.cfProgramSections || (window.cfProgramSections = new Set()),
    fold = (key, label) =>
      `<button class="smallbtn section-collapse program-section-toggle" data-toggle-program-section="${p.id}:${key}" aria-label="${label}" aria-expanded="${!folded.has(p.id + ":" + key)}">${folded.has(p.id + ":" + key) ? "＋" : "−"}</button>`;
  return `<article class="program card program-followed ${collapsed.has(p.id) ? "collapsed" : ""}"><div class="programhead"><div class="program-title"><button class="smallbtn collapse-program" data-toggle-program="${p.id}" aria-expanded="${!collapsed.has(p.id)}">${collapsed.has(p.id) ? "＋" : "−"}</button><div><h3>${esc(p.name)} <span class="tracked-tag">${p.coach_mode ? "Coach" : "Suivi"}</span></h3><small>${author ? (p.coach_mode ? "coach : " : "par ") + esc(author) + " · " : ""}mes dates : ${fmt(p.start_monday)} → ${fmt(p.end_monday)}</small></div></div><div class="entryactions">${p.coach_mode === "dated" ? "" : `<button type="button" class="smallbtn" data-follow-dates="${p.id}" aria-label="Modifier mes dates" title="Modifier mes dates">${PROGRAM_EDIT_ICON}</button>`}<button type="button" class="smallbtn delete" data-unfollow-program="${p.id}" aria-label="Arrêter de suivre" title="Arrêter de suivre">${PROGRAM_DELETE_ICON}</button></div></div><div class="programbody"><div class="program-section program-subsection ${folded.has(p.id + ":wods") ? "collapsed" : ""}"><div class="program-section-heading program-section-toolbar">${fold("wods", "Replier les WOD")}<span>WOD</span></div><div class="program-subsection-body"><div class="wodlist">${
    visibleWods(p.id)
      .map(w => {
        const description = w.is_tracked ? w.planned_comment : weeklyWodContent(w.id, week) || w.planned_comment;
        return `<div class="wod-entry"><div class="wodrow"><div class="wod-title"><b>${esc(w.name)}</b></div>${description ? `<p>${esc(description)}</p>` : ""}${w.is_tracked ? renderWodWeeklyProgramming(p, w) : ""}</div></div>`;
      })
      .join("") || programEmpty("Pas de WOD pour cette programmation")
  }</div></div></div>${
    movements.length
      ? `<div class="movement-editor compact program-section program-subsection ${folded.has(p.id + ":movements") ? "collapsed" : ""}"><div class="program-section-heading program-section-toolbar">${fold("movements", "Replier les mouvements")}<span>Focus mouvement</span></div><div class="program-subsection-body"><div class="program-movement-list">${movements.map(m => `<div class="movement-row"><span>${esc(m.name)}</span></div>`).join("")}</div></div></div>`
      : ""
  }</div></article>`;
}
// Recherche de programmes publics et suivi (un seul programme à la fois).
let programSearchTimer = null;
async function searchPrograms() {
  const q = $("#programsearchform").elements.q.value.trim();
  $("#programsearcherror").textContent = "";
  try {
    const d = await api("/public-programs?q=" + encodeURIComponent(q)),
      current = programs.find(p => p.followed);
    $("#programsearchresults").innerHTML =
      d.programs
        .map(
          p =>
            `<div class="program-search-result"><div><b>${esc(p.name)}</b><small>par ${esc([p.author_first_name, p.author_last_name].filter(Boolean).join(" ") || "—")} · ${fmt(p.start_monday)} → ${fmt(p.end_monday)} · ${p.wods} WOD${p.wods > 1 ? "s" : ""}${p.followers ? " · " + p.followers + " suiveur" + (p.followers > 1 ? "s" : "") : ""}</small></div>${current?.id === p.id ? `<span class="tracked-tag">Suivi</span>` : `<button type="button" class="smallbtn" data-follow-program="${p.id}">Suivre</button>`}</div>`
        )
        .join("") || `<p class="muted">Aucun programme public${q ? " pour « " + esc(q) + " »" : ""}.</p>`;
    $("#programsearchresults")
      .querySelectorAll("[data-follow-program]")
      .forEach(
        b =>
          (b.onclick = () => {
            if (current && !confirm("Tu suis déjà « " + current.name + " ». Le remplacer par ce programme ?")) return;
            $("#programsearchdialog").close();
            openFollowDialog(d.programs.find(p => p.id === b.dataset.followProgram));
          })
      );
  } catch (e) {
    $("#programsearcherror").textContent = e.message;
  }
}
// Suivre un programme à ses propres dates : par défaut à partir de cette semaine, pour la même durée que l'auteur.
function openFollowDialog(program, current = null) {
  const f = $("#followform").elements,
    length = Math.round((new Date(program.end_monday) - new Date(program.start_monday)) / 86400000),
    weeks = Math.ceil((length + 1) / 7),
    author = [program.author_first_name, program.author_last_name].filter(Boolean).join(" ");
  $("#followform").reset();
  $("#followform").dataset.editing = current ? "1" : "";
  $("#followform").dataset.invite = $("#followform").dataset.weeks = "";
  $("#followendfield").hidden = false;
  f.end.required = true;
  f.program_id.value = program.id;
  f.start.value = current?.start || mondayOf(today());
  f.end.value = current?.end || addDays(f.start.value, length);
  f.end.dataset.manual = current ? "1" : "";
  f.start.onchange = () => {
    if (!f.end.dataset.manual && f.start.value) f.end.value = addDays(f.start.value, length);
  };
  f.end.onchange = () => (f.end.dataset.manual = "1");
  $("#followtitle").textContent = program.name;
  $("#followinfo").textContent =
    (author ? "Programme de " + author + " : " : "Durée : ") +
    weeks +
    " semaine" +
    (weeks > 1 ? "s" : "") +
    " (chez l’auteur du " +
    fmt(program.start_monday) +
    " au " +
    fmt(program.end_monday) +
    "). Choisis tes propres dates.";
  $("#followsubmit").textContent = current ? "Enregistrer mes dates" : "Suivre ce programme";
  $("#followerror").textContent = "";
  $("#followdialog").showModal();
}
async function showSavedProgram(message, isNew) {
  if (isNew && simpleInterface()) {
    try {
      await api("/preferences", {method: "PUT", body: JSON.stringify({interface: "advanced"})});
      preferences.interface = "advanced";
      $("#interfaceselect").value = "advanced";
      applyInterface();
    } catch {
      await load();
      toast(message + " L’interface avancée n’a pas pu être activée.");
      return;
    }
  }
  await load();
  switchView("programs");
  toast(message);
}
$("#followform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    editing = !!e.target.dataset.editing;
  if (e.target.dataset.invite) return acceptCoachInvite(e.target.dataset.invite, f.start.value);
  // Programme de coach sans dates : la semaine 1 commence le lundi choisi, pour le nombre de semaines du coach.
  const weeks = Number(e.target.dataset.weeks),
    start = weeks ? mondayOf(f.start.value) : f.start.value,
    end = weeks ? addDays(start, weeks * 7 - 1) : f.end.value;
  try {
    await api("/program-follow", {
      method: "PUT",
      body: JSON.stringify({program_id: f.program_id.value, start, end}),
    });
    $("#followdialog").close();
    await showSavedProgram(editing ? "Dates du programme modifiées." : "Programme suivi.", !editing);
  } catch (x) {
    $("#followerror").textContent = x.message;
  }
};
function openProgramSearch() {
  $("#programsearchform").reset();
  $("#programsearchresults").innerHTML = "";
  $("#programsearchdialog").showModal();
  searchPrograms();
}
$("#findprogram").onclick = openProgramSearch;
$("#programsearchform").onsubmit = e => {
  e.preventDefault();
  searchPrograms();
};
$("#programsearchform").elements.q.oninput = () => {
  clearTimeout(programSearchTimer);
  programSearchTimer = setTimeout(searchPrograms, 300);
};
async function moveProgramItem(itemId, direction, kind) {
  const source = kind === "wod" ? wodsByProgram : movementsByProgram;
  let pid = null;
  for (const id of Object.keys(source)) {
    if (source[id].some(x => x.id === itemId)) {
      pid = id;
      break;
    }
  }
  if (!pid) return;
  const previous = source[pid],
    list = kind === "wod" ? visibleWods(pid) : [...previous],
    index = list.findIndex(x => x.id === itemId),
    target = index + Number(direction);
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  source[pid] = [...list, ...previous.filter(x => !list.includes(x))];
  renderPrograms();
  renderWeek();
  try {
    await api("/programs/" + pid + "/order", {
      method: "PUT",
      body: JSON.stringify({kind, ids: source[pid].map(x => x.id)}),
    });
  } catch (e) {
    source[pid] = previous;
    renderPrograms();
    renderWeek();
    toast(e.message);
  }
}
function openMovementPicker(pid) {
  const current = movementsByProgram[pid] || [],
    used = new Set(current.map(m => m.catalog_movement_id).filter(Boolean));
  $("#movementpickerform").elements.program_id.value = pid;
  $("#movementpickerlist").innerHTML = movementCatalog.length
    ? movementCatalog
        .map(
          m =>
            `<label class="movement-check"><input type="checkbox" name="catalog_movement_ids" value="${m.id}" ${used.has(m.id) ? "checked" : ""}><span>${esc(m.name)}</span></label>`
        )
        .join("")
    : `<p class="muted">Le catalogue est vide. L’administrateur doit d’abord ajouter des mouvements.</p>`;
  $("#movementpickererror").textContent = "";
  $("#movementpickerdialog").showModal();
}
$("#closemovementpicker").onclick = () => $("#movementpickerdialog").close();
$("#movementpickerform").onsubmit = async e => {
  e.preventDefault();
  const pid = e.target.elements.program_id.value,
    selected = [...e.target.querySelectorAll('input[name="catalog_movement_ids"]:checked')].map(x => x.value),
    existing = movementsByProgram[pid] || [],
    wanted = new Set(selected);
  try {
    for (const m of existing.filter(x => x.catalog_movement_id && !wanted.has(x.catalog_movement_id)))
      await api("/movements/" + m.id, {method: "DELETE"});
    for (const id of selected.filter(x => !existing.some(m => m.catalog_movement_id === x)))
      await api("/programs/" + pid + "/movements", {method: "POST", body: JSON.stringify({catalog_movement_id: id})});
    $("#movementpickerdialog").close();
    await load();
    switchView("programs");
    toast("Mouvements du programme mis à jour.");
  } catch (x) {
    $("#movementpickererror").textContent = x.message;
  }
};

function syncProgramDateFields() {
  const f = $("#programform"),
    isDefault = f.elements.is_default.checked,
    coach = f.elements.coach.checked,
    dated = f.elements.coach_dated.checked;
  // Programme de coach : nombre de semaines obligatoire, date de début facultative (la fin s’en déduit), pas public.
  $("#programcoachoptions").hidden = !coach;
  $("#programsharefield").hidden = coach;
  $("#programendfield").hidden = coach;
  $("#programstartfield").hidden = coach && !dated;
  f.elements.coach_weeks.required = coach;
  $("#programcoachhint").textContent = !coach
    ? ""
    : f.elements.coach.disabled && f.elements.coach_weeks.disabled
      ? "Programme déjà proposé : seul son nom se modifie."
      : dated
        ? "Le programme commence la semaine de la date de début, pour tous ceux qui l’acceptent."
        : "Sans dates, chacun choisit sa date de début en acceptant le programme.";
  f.elements.start.disabled = isDefault || (coach && !dated);
  f.elements.end.disabled = isDefault || coach;
  f.elements.start.required = !isDefault && (!coach || dated);
  f.elements.end.required = !isDefault && !coach;
  if (isDefault) {
    f.elements.start.value = "1970-01-01";
    f.elements.end.value = "2100-12-31";
  } else {
    if (f.elements.start.value === "1970-01-01") f.elements.start.value = "";
    if (f.elements.end.value === "2100-12-31") f.elements.end.value = "";
  }
}
$("#programform").elements.is_default.onchange = syncProgramDateFields;
$("#programform").elements.coach.onchange = syncProgramDateFields;
$("#programform").elements.coach_dated.onchange = syncProgramDateFields;
function openProgram(p = null) {
  const f = $("#programform");
  f.reset();
  f.elements.program_id.value = p?.id || "";
  f.elements.name.value = p?.name || "";
  f.elements.is_default.checked = !!p?.is_default;
  f.elements.is_public.checked = !!p?.is_public;
  // L'option « programme par défaut » n'est plus proposée : elle n'apparaît que pour un ancien programme par défaut.
  $("#programdefaultfield").hidden = !p?.is_default;
  f.elements.start.value = p && !p.is_default && p.coach_mode !== "free" ? p.start_monday : "";
  f.elements.end.value = p && !p.is_default ? p.end_monday : "";
  // Programme de coach : réservé aux coachs validés ; un programme existant ne change pas de nature, et une fois
  // proposé à des inscrits, seul son nom se modifie.
  $("#programcoachfield").hidden = p ? !p.coach_mode : preferences?.coach !== "approved";
  f.elements.coach.checked = !!p?.coach_mode;
  f.elements.coach.disabled = !!p;
  f.elements.coach_weeks.value = p?.coach_weeks || "";
  f.elements.coach_dated.checked = p ? p.coach_mode === "dated" : false;
  f.elements.coach_weeks.disabled = f.elements.coach_dated.disabled = !!p?.published_at;
  syncProgramDateFields();
  if (p?.published_at) f.elements.start.disabled = true;
  $("#programtitle").textContent = p ? "Modifier le programme" : "Nouveau programme";
  $("#programsubmit").textContent = p ? "Enregistrer les modifications" : "Créer le programme";
  $("#programerror").textContent = "";
  $("#programdialog").showModal();
}
$("#newprogram").onclick = () => openProgram();
$("#closeprogram").onclick = () => $("#programdialog").close();
$("#programform").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target),
    id = f.get("program_id"),
    body = {
      name: f.get("name"),
      start: f.get("start"),
      end: f.get("end"),
      is_default: $("#programform").elements.is_default.checked,
      is_public: $("#programform").elements.is_public.checked,
    },
    form = $("#programform").elements;
  if (form.coach.checked) {
    body.coach = {weeks: Number(form.coach_weeks.value), dated: form.coach_dated.checked};
    body.start = form.start.value;
    delete body.end;
  }
  try {
    const saved = await api(id ? "/programs/" + id : "/programs", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    // Un programme qui vient d’être créé s’affiche déplié pour y ajouter ses WOD.
    if (!id && saved?.id) programFolds().delete(saved.id);
    $("#programdialog").close();
    e.target.reset();
    await showSavedProgram(id ? "Programme modifié." : "Programme créé.", !id);
  } catch (x) {
    $("#programerror").textContent = x.message;
  }
};
function openWod(pid, w = null) {
  const f = $("#wodform");
  f.reset();
  f.elements.program_id.value = pid;
  f.elements.wod_id.value = w?.id || "";
  f.elements.name.value = w?.name || "";
  f.elements.planned_comment.value = w?.planned_comment || "";
  f.elements.is_tracked.checked = !!w?.is_tracked;
  f.elements.score_type.value = w?.score_type || "none";
  fillWodTypeSelect(f.elements.type_id, w?.type_id || "");
  fillActivitySelect(f.elements.activity_id, w?.activity_id || defaultActivity()?.id);
  f.elements.duration_minutes.value = w?.duration_minutes || defaultActivity()?.duration_minutes || 60;
  // Mouvements à travailler (catalogue) : repris par la génération IA et cochés par défaut dans la séance.
  const ticked = new Set(w?.movement_ids || []);
  $("#wodmovements").innerHTML =
    movementCatalog
      .map(
        m =>
          `<label class="movement-check"><input type="checkbox" name="catalog_movement_ids" value="${esc(m.id)}" ${ticked.has(m.id) ? "checked" : ""}><span>${esc(m.name)}</span></label>`
      )
      .join("") || `<p class="muted">Le catalogue de mouvements est vide.</p>`;
  $("#wodmovementdetails").open = false;
  syncWodMovementCount();
  $("#wodtitle").textContent = w ? "Modifier le WOD" : "Ajouter un WOD au programme";
  $("#woddialog").showModal();
}
function syncWodMovementCount() {
  const n = $("#wodmovements").querySelectorAll("input:checked").length;
  $("#wodmovementcount").textContent = n ? n + (n > 1 ? " cochés" : " coché") : "aucun coché";
}
$("#wodmovements").onchange = syncWodMovementCount;
$("#closewod").onclick = () => $("#woddialog").close();
$("#wodform").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target),
    id = f.get("wod_id"),
    body = {
      name: f.get("name"),
      planned_comment: f.get("planned_comment"),
      activity_id: f.get("activity_id"),
      duration_minutes: Number(f.get("duration_minutes")),
      is_tracked: $("#wodform").elements.is_tracked.checked,
      score_type: f.get("score_type"),
      type_id: f.get("type_id") || "",
      catalog_movement_ids: [...$("#wodmovements").querySelectorAll("input:checked")].map(i => i.value),
    };
  try {
    await api(id ? "/wods/" + id : "/programs/" + f.get("program_id") + "/wods", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#woddialog").close();
    await load();
    toast(id ? "WOD modifié." : "WOD ajouté au programme.");
  } catch (x) {
    $("#woderror").textContent = x.message;
  }
};
