// FitFactory — chargement des données, semaine en cours, historique des séances.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

let loadedSessionWeek = "";
async function load() {
  try {
    const from = selectedWeekStart || mondayOf(today()),
      to = addDays(from, 6);
    const [a, mc, p, w, pr, bx, prefs, tg] = await Promise.all([
      api("/activities"),
      api("/movement-catalog"),
      api("/program-data"),
      api("/week-data?from=" + from + "&to=" + to),
      api("/prs"),
      api("/boxes"),
      api("/preferences"),
      api("/session-tags"),
    ]);
    loadCommonWod();
    sessionTags = w.tags || [];
    sharedPartners = w.sharedPartners || [];
    pendingTags = tg.tags || [];
    activities = a.activities;
    movementCatalog = mc.movements;
    programs = p.programs;
    wodsByProgram = p.wods;
    movementsByProgram = p.movements;
    weeklyWodPrograms = p.weeklyWodPrograms || [];
    loadedSessionWeek = from;
    sessions = w.sessions;
    movementChecks = w.checks;
    catalogChecks = w.catalogChecks || [];
    weeklyPlans = w.plans;
    boxWods = rememberBoxWods(w.boxWods);
    dailyWods = rememberDailyWods(w.dailyWods, from);
    weekCompetition = !!w.flags.find(x => x.week_start === from)?.competition;
    prRecords = pr.records;
    setBoxes(bx);
    setPreferences(prefs);
    maybeWelcomeBox();
    renderUserbar();
    fillProfileForm();
    $("#profileemail").value = user.email || "";
    renderSessions();
    renderPrs();
    loadFitness();
    renderPrograms();
    renderWeek();
    if (!$("#view-nutrition").hidden) loadNutrition();
    loadBenchmarks();
    loadReportMonths();
    if (isAdmin) loadAdmin();
  } catch (e) {
    toast(e.message);
  }
}
async function loadSessions() {
  const from = selectedWeekStart || mondayOf(today()),
    to = addDays(from, 6),
    [w, tg] = await Promise.all([api("/week-data?from=" + from + "&to=" + to), api("/session-tags")]);
  if (selectedWeekStart && selectedWeekStart !== from) return;
  loadedSessionWeek = from;
  sessions = w.sessions;
  sessionTags = w.tags || [];
  sharedPartners = w.sharedPartners || [];
  pendingTags = tg.tags || [];
  loadCommonWod();
  movementChecks = w.checks;
  catalogChecks = w.catalogChecks || [];
  weeklyPlans = w.plans;
  boxWods = rememberBoxWods(w.boxWods);
  dailyWods = rememberDailyWods(w.dailyWods, from);
  weekCompetition = !!w.flags.find(x => x.week_start === from)?.competition;
  renderSessions();
  renderWeek();
}
async function loadPrs() {
  prRecords = (await api("/prs")).records;
  renderPrs();
  loadFitness();
}
const inManagerSpace = () => !$("#view-box").hidden,
  inAdminSpace = () => !$("#view-admin").hidden;
function switchView(v) {
  document.querySelectorAll(".navtab[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  ["sessions", "programs", "prs", "nutrition", "timer", "account", "admin", "box"].forEach(
    x => ($("#view-" + x).hidden = x !== v)
  );
  // Espace gestionnaire : menu du bas propre (WOD, membres, infos de la box) à la place de celui de l’utilisateur.
  // Espace d’administration : menu du bas propre (utilisateurs, box et mouvements, autres paramétrages).
  $("#managernav").hidden = v !== "box";
  $("#adminnav").hidden = v !== "admin";
  $("#usernav").hidden = v === "box" || v === "admin";
  if (v === "admin") showAdminPage();
  if (user) renderUserbar();
  if (v === "box") loadManagedBox();
  if (v === "prs") {
    loadProgress();
    loadReportMonths();
  }
  if (v === "nutrition") loadNutrition();
}
document.querySelectorAll(".navtab[data-view]").forEach(b => (b.onclick = () => switchView(b.dataset.view)));
// Origine du WOD d’une séance, affichée dans l’historique : nom de la box, WOD du jour, programmation, ou séance libre
// (« Autres »).
function sessionSource(s) {
  if (s.box_wod_id) return s.box_name || "WOD de la box";
  if (s.wod_name === "Autres" && !s.daily_wod_id) return "Séance libre";
  return "WOD Perso"; // WOD de la programmation ou WOD généré (rubrique « WOD Perso »)
}
function renderSessions() {
  $("#sessionlist").classList.toggle("session-list-collapsed", !!window.cfSessionHistoryCollapsed);
  const historyToggle = $("#toggle-session-history");
  if (historyToggle) {
    historyToggle.textContent = window.cfSessionHistoryCollapsed ? "＋" : "−";
    historyToggle.setAttribute("aria-expanded", String(!window.cfSessionHistoryCollapsed));
    historyToggle.onclick = () => {
      window.cfSessionHistoryCollapsed = !window.cfSessionHistoryCollapsed;
      renderSessions();
    };
  }
  $("#sessionhistorycount").textContent = sessions.length;
  $("#sessionlist").innerHTML = sessions.length
    ? sessions
        .map(
          s =>
            `<article class="entry session-entry"><div class="session-history-content"><div class="session-history-heading"><button type="button" class="session-title-line session-open" data-session-open="${s.id}" aria-label="Voir le détail de la séance"><h3>${esc(s.wod_name)}</h3><span class="session-meta"><span class="sessiondate">${fmt(s.session_date)}</span><span class="tracked-tag">${esc(sessionSource(s))}</span></span></button><div class="entryactions">${s.box_wod_id && s.score_type && s.score_type !== "none" ? `<button class="smallbtn" data-leaderboard="${s.box_wod_id}" aria-label="Classement" title="Classement du WOD">${TROPHY_ICON}</button>` : ""}<button class="smallbtn" data-edit-session="${s.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-session="${s.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div></div></div></article>`
        )
        .join("")
    : sectionEmpty("Pas de séance enregistrée cette semaine");
  $("#sessionlist")
    .querySelectorAll("[data-session-open]")
    .forEach(b => (b.onclick = () => openSessionDetail(b.dataset.sessionOpen)));
  $("#sessionlist")
    .querySelectorAll("[data-leaderboard]")
    .forEach(b => (b.onclick = () => openLeaderboard(b.dataset.leaderboard)));
  $("#sessionlist")
    .querySelectorAll("[data-edit-session]")
    .forEach(b => (b.onclick = () => openSession(sessions.find(s => s.id === b.dataset.editSession))));
  $("#sessionlist")
    .querySelectorAll("[data-del-session]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (confirm("Supprimer cette séance ?")) {
            await api("/sessions/" + b.dataset.delSession, {method: "DELETE"});
            await load(); // recharge aussi les programmes (un programme sans séance redevient supprimable)
          }
        })
    );
}
// Détail d’une séance de l’historique, en fenêtre : réalisé, score et mouvements travaillés (pas le contenu prévu :
// la séance peut être tout autre chose que ce qui était prévu).
function openSessionDetail(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const movements = [
      ...movementChecks
        .filter(c => c.session_id === s.id)
        .map(
          c =>
            Object.values(movementsByProgram)
              .flat()
              .find(m => m.id === c.movement_id)?.name
        ),
      ...catalogChecks
        .filter(c => c.session_id === s.id)
        .map(c => movementCatalog.find(m => m.id === c.catalog_movement_id)?.name),
    ].filter(Boolean),
    hasScore = s.score_value !== null && s.score_value !== undefined && s.score_type,
    // Avec qui on s’est entraîné : l’auteur et les autres partenaires (séance partagée), puis ceux qu’on a tagués.
    partners = [
      ...sharedPartners.filter(x => x.session_id === s.id).map(partnerName),
      ...sessionTags
        .filter(t => t.session_id === s.id)
        .map(t => partnerName(t) + (t.status === "accepted" ? "" : " (" + PARTNER_STATUS[t.status] + ")")),
    ],
    part = (label, text) => `<p><b>${label}</b> ${esc(text)}</p>`;
  $("#sessiondetailtitle").textContent = s.wod_name;
  $("#sessiondetailmeta").textContent = [
    fmt(s.session_date),
    sessionSource(s),
    s.program_name && !s.box_name && !s.daily_wod_id ? s.program_name : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("#sessiondetailbody").innerHTML =
    // Contenu réalisé, puis score et mouvements, chacun avec son libellé.
    (s.actual_comment ? part("Contenu de la séance :", s.actual_comment) : "") +
      (hasScore
        ? part(
            "Score :",
            // WOD de référence : temps ou tours + répétitions, Rx ou Scaled.
            (s.benchmark_id && benchmarkFor(s.benchmark_id)
              ? benchmarkScoreLabel(benchmarkFor(s.benchmark_id), s.score_value) +
                (Number(s.score_scaled) ? " · Scaled" : " · Rx")
              : formatScore(s.score_type, s.score_value)) + (s.score_category_name ? " · " + s.score_category_name : "")
          )
        : "") +
      (movements.length ? part("Mouvements travaillés :", [...new Set(movements)].join(", ")) : "") +
      (partners.length ? part("Partenaires :", partners.join(", ")) : "") ||
    `<p class="muted">Pas de détail pour cette séance.</p>`;
  const history = $("#sessiondetailscores");
  history.hidden = !s.program_score_type;
  history.onclick = () => {
    $("#sessiondetaildialog").close();
    openProgramScoreHistory(s.wod_id, s.wod_name);
  };
  $("#sessiondetailedit").onclick = () => {
    $("#sessiondetaildialog").close();
    openSession(s);
  };
  $("#sessiondetaildialog").showModal();
}
// Programme technique « Hors programme » (programme par défaut sans WOD visible ni mouvement) : jamais affiché comme un programme.
function isFallbackProgram(p) {
  return !!p?.is_default && !visibleWods(p.id).length && !(movementsByProgram[p.id] || []).length;
}
function programForDate(date) {
  return (
    programs.find(
      x =>
        !x.is_default &&
        (!x.read_only || x.followed) &&
        !(x.start_monday === "1970-01-01" && x.end_monday === "2100-12-31") &&
        x.start_monday <= date &&
        x.end_monday >= date
    ) ||
    programs.find(x => !!x.is_default) ||
    null
  );
}
// Rubrique « Focus mouvement » de la semaine : mouvements du programme, ou à défaut (programme sans mouvement,
// séances hors programme) les mouvements du catalogue cochés dans les séances de la semaine.
function weekMovementsSection(week, programMovements, folded) {
  // Avec un programme : ses mouvements (y compris à 0×), plus tout autre mouvement coché dans les séances de la semaine.
  // Sans programme (ou programme sans mouvement) : uniquement les mouvements cochés dans les séances de la semaine.
  // Les mouvements sont regroupés par nom ; chaque séance compte une fois par mouvement.
  const key = name =>
      String(name || "")
        .trim()
        .toLowerCase(),
    allProgramMovements = Object.values(movementsByProgram).flat(),
    items = new Map();
  for (const m of programMovements)
    if (!items.has(key(m.name))) items.set(key(m.name), {movement: {name: m.name}, count: 0, base: true});
  for (const s of week) {
    const names = new Set(
      [
        ...movementChecks
          .filter(c => c.session_id === s.id)
          .map(c => allProgramMovements.find(m => m.id === c.movement_id)?.name),
        ...catalogChecks
          .filter(c => c.session_id === s.id)
          .map(c => movementCatalog.find(m => m.id === c.catalog_movement_id)?.name),
      ]
        .filter(Boolean)
        .map(key)
    );
    for (const k of names) {
      if (!items.has(k)) {
        const name =
          allProgramMovements.find(m => key(m.name) === k)?.name || movementCatalog.find(m => key(m.name) === k)?.name;
        items.set(k, {movement: {name}, count: 0, base: false});
      }
      items.get(k).count++;
    }
  }
  const movementCounts = [...items.values()],
    baseItems = movementCounts.filter(x => x.base);
  return `<section class="weekother session-fold ${folded.has("movements") ? "collapsed" : ""}" data-session-fold="movements"><div class="weekheading"><button class="smallbtn section-collapse" aria-label="Replier les mouvements" aria-expanded="${!folded.has("movements")}">${folded.has("movements") ? "＋" : "−"}</button><h2>Focus mouvement</h2><span>${programMovements.length ? baseItems.filter(x => x.count > 0).length + "/" + baseItems.length : movementCounts.length}</span></div><div class="session-fold-body"><div class="weekwodlist">${movementCounts.length ? movementCounts.map(x => `<article class="weekwod card ${x.count ? "done" : ""}"><b>${esc(x.movement.name)}</b><div class="weekcount"><strong>${x.count}×</strong></div></article>`).join("") : sectionEmpty("Pas de mouvement travaillé cette semaine")}</div></div></section>`;
}
// Rubrique « WOD Perso » (WOD de la programmation, puis WOD générés) : toujours affichée en interface avancée, jamais en simplifiée (« Pas de programmation en cours » sans programme).
function weekProgramSection(p, week, folded, from) {
  const ws = p ? visibleWods(p.id) : [],
    countFor = w => week.filter(x => x.wod_id === w.id).length,
    done = ws.filter(w => countFor(w) > 0),
    // Génération par IA : seulement dans ses propres programmes (pas un programme suivi).
    own = p && !p.followed && !p.read_only && !p.is_default,
    // WOD du jour (IA ou WOD de référence) : en fin de liste, comptés dans le compteur de la rubrique (3 WOD faits sur
    // 4 + 1 WOD généré : « 3/5 », puis « 4/5 » une fois ce WOD fait).
    extras = dailyWodCards(),
    doneCount = done.length + persoDailyWods().filter(dailyWodDone).length,
    totalCount = ws.length + persoDailyWods().length;
  return `<section class="session-fold ${folded.has("wods") ? "collapsed" : ""}" data-session-fold="wods"><div class="weekheading"><button class="smallbtn section-collapse" aria-label="Replier les WOD" aria-expanded="${!folded.has("wods")}">${folded.has("wods") ? "＋" : "−"}</button><h2>WOD Perso</h2><span>${doneCount}/${totalCount}</span></div><div class="session-fold-body"><div class="weekwodlist">${
    !p
      ? extras || sectionEmpty("Pas de programmation en cours")
      : ws.length
        ? ws
            .map(w => {
              const n = countFor(w);
              const planned = weeklyPlans.some(x => x.wod_id === w.id);
              // Aperçu de 2 lignes de la description générique du WOD ; un toucher sur la ligne ouvre en fenêtre le
              // contenu de la semaine.
              const display = w.planned_comment;
              return `<article class="weekwod card ${n ? "done" : planned ? "planned" : ""}"><div class="weekcount">${!n && own ? `<button type="button" class="smallbtn" data-ai-week="${w.id}" aria-label="Générer le contenu de cette semaine avec l’IA" title="Générer le contenu de cette semaine avec l’IA">${AI_ICON}</button>` : ""}${n ? "" : `<button class="smallbtn" data-log-wod="${w.id}" aria-label="Ajouter une séance" title="Ajouter une séance"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>`}${planned && !n ? `<button class="smallbtn delete" data-unplan-wod="${w.id}" aria-label="Supprimer la planification" title="Supprimer la planification"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>` : ""}</div><div class="weekwod-text" role="button" tabindex="0" data-wod-open="${w.id}" aria-label="Voir le WOD ${esc(w.name)}"><b>${esc(w.name)}</b>${display ? `<p class="wod-preview">${esc(display)}</p>` : ""}</div></article>`;
            })
            .join("") + extras
        : extras || sectionEmpty("Pas de WOD pour cette programmation")
  }</div></div></section>`;
}
// Rubrique vide : un message au style d’un contenu de rubrique (toutes les rubriques restent affichées).
const sectionEmpty = text => `<article class="weekwod card section-empty"><span>${esc(text)}</span></article>`;
// Un WOD daté peut avoir été enregistré dans une autre semaine.
function datedWodDone(wod, field, week = sessions) {
  return wod.session_ids ? wod.session_ids.length > 0 : week.some(s => s[field] === wod.id);
}
// Rubrique « WOD de la box » de la semaine (membres d’une box) : WOD du gestionnaire, séances, classement.
function weekBoxSection(week, folded) {
  // Rubrique toujours affichée. Sans box : bulle « Rejoindre une box » (ou demande en attente) ; membre sans WOD cette
  // semaine : « Pas de WOD de la box cette semaine ». Les autres box se rejoignent depuis Mon compte → Mes box.
  const pending = boxMemberships.filter(m => m.role === "member" && m.status === "pending"),
    empty = memberBoxIds().length
      ? sectionEmpty("Pas de WOD de la box cette semaine")
      : pending.length
        ? sectionEmpty(
            "Demande envoyée à " + pending.map(m => boxName(m.box_id)).join(", ") + ", en attente de validation"
          )
        : `<button type="button" class="weekwod card section-empty join-box-empty" data-join-box>Rejoindre une box</button>`;
  const severalBoxes = memberBoxIds().length > 1,
    done = boxWods.filter(w => datedWodDone(w, "box_wod_id", week));
  return `<section class="weekother session-fold ${folded.has("box") ? "collapsed" : ""}" data-session-fold="box"><div class="weekheading"><button class="smallbtn section-collapse" aria-label="Replier les WOD de la box" aria-expanded="${!folded.has("box")}">${folded.has("box") ? "＋" : "−"}</button><h2>WOD de la box</h2><span>${done.length}/${boxWods.length}</span></div><div class="session-fold-body"><div class="weekwodlist">${
    boxWods.length
      ? boxWods
          .map(w => {
            const n = datedWodDone(w, "box_wod_id", week);
            return `<article class="weekwod card ${n ? "done" : ""}"><div class="weekcount">${w.wod_date <= today() && !n ? `<button class="smallbtn" data-log-boxwod="${w.id}" aria-label="Enregistrer une séance" title="Enregistrer une séance"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>` : ""}${w.score_type !== "none" ? `<button class="smallbtn" data-leaderboard="${w.id}" aria-label="Classement" title="Classement du WOD">${TROPHY_ICON}</button>` : ""}</div><div class="weekwod-text" role="button" tabindex="0" data-boxwod-open="${w.id}" aria-label="Voir le détail du WOD"><b>${esc(managerWodTitle(w))}</b>${severalBoxes ? `<small class="muted box-wod-meta">${esc(w.box_name)}</small>` : ""}</div></article>`;
          })
          .join("")
      : empty
  }</div></div></section>`;
}
function renderWeek() {
  const now = today();
  if (!selectedWeekStart) selectedWeekStart = mondayOf(now);
  const from = selectedWeekStart,
    to = addDays(from, 6),
    future = from > mondayOf(now),
    dateInput = addDays(from, 0);
  // Interface simplifiée : ni programme, ni rubriques de WOD (WOD Perso, WOD de la box) ; les mouvements
  // travaillés passent sous l’historique (#weekafter).
  const simple = simpleInterface(),
    p = simple ? null : programForDate(from);
  const week = sessions.filter(x => x.session_date >= from && x.session_date <= to);
  const folded = window.cfSessionFolded || (window.cfSessionFolded = new Set());
  const nav = `<div class="weeknav"><button class="smallbtn" id="prevweek" aria-label="Semaine précédente" title="Semaine précédente">‹</button><div class="weekdate-label"><button type="button" class="week-current" id="thisweek" title="Revenir à la semaine en cours">Semaine du</button><input id="weekdate" type="date" value="${dateInput}" max="${now}" aria-label="Semaine du"></div><button class="smallbtn" id="nextweek" aria-label="Semaine suivante" title="Semaine suivante">›</button></div>`;
  if (future && (!p || isFallbackProgram(p))) {
    $("#weekboard").innerHTML =
      `<div class="weekbar card">${nav}</div><div class="card empty">Cette semaine est dans le futur. La saisie d’entraînements n’est pas autorisée.</div>${simple ? "" : weekProgramSection(null, week, folded, from) + weekBoxSection(week, folded) + weekMovementsSection(week, [], folded)}`;
  } else if (!p || isFallbackProgram(p)) {
    // Semaine sans programme : les séances sont enregistrées « hors programme ».
    $("#weekboard").innerHTML =
      `<div class="weekbar card">${nav}</div><div class="weekstats card">${dailyGenerateRow(from)}<div class="weekstat weekstat-sessions"><strong>${week.length}</strong><span>Nombre de séances</span></div><button id="addsession" class="primary addsession-compact" aria-label="Ajouter une séance" title="Ajouter une séance">＋</button><label class="competition-toggle" title="Semaine de compétition : coche-la si tu as une compétition cette semaine"><span>Compét.</span><input type="checkbox" id="weekcompetition" aria-label="Semaine de compétition" ${weekCompetition ? "checked" : ""}></label></div>${simple ? "" : weekProgramSection(null, week, folded, from) + weekBoxSection(week, folded) + weekMovementsSection(week, [], folded)}`;
  } else {
    const ws = visibleWods(p.id),
      countFor = w => week.filter(x => x.wod_id === w.id).length,
      done = ws.filter(w => countFor(w) > 0);
    const programMovements = movementsByProgram[p.id] || [];
    $("#weekboard").innerHTML =
      `<div class="weekbar card">${nav}</div><div class="weekstats card">${dailyGenerateRow(from)}<div class="weekstat weekstat-sessions"><strong>${week.length}</strong><span>Nombre de séances</span></div><div class="weekstat weekstat-program"><strong>${done.length}/${ws.length}</strong><span>Nombre de séances de la programmation</span></div><button id="addsession" class="primary addsession-compact" aria-label="Ajouter une séance" title="Ajouter une séance" ${future ? "disabled" : ""}>＋</button><label class="competition-toggle" title="Semaine de compétition : coche-la si tu as une compétition cette semaine"><span>Compét.</span><input type="checkbox" id="weekcompetition" aria-label="Semaine de compétition" ${weekCompetition ? "checked" : ""}></label></div>${weekProgramSection(p, week, folded, from)}${weekBoxSection(week, folded)}${weekMovementsSection(week, programMovements, folded)}`;
  }
  $("#weekafter").innerHTML = simple ? weekMovementsSection(week, [], folded) : "";
  // Séances où l’on est tagué : rubrique en tête de page et pastille rouge sur l’onglet Séances.
  // WOD commun du jour : juste après la carte « Nombre de séances ».
  $("#weekboard .weekbar").insertAdjacentHTML("afterend", weekInvitesSection());
  ($("#weekboard .weekstats") || $("#weekboard .weekbar")).insertAdjacentHTML("afterend", weekCommonSection(from));
  bindCommonWod($("#weekboard"));
  $('.navtab[data-view="sessions"]').classList.toggle("has-alert", pendingTags.length > 0);
  bindInvites();
  $("#view-sessions")
    .querySelectorAll("[data-session-fold]")
    .forEach(section => {
      const button = section.querySelector(".section-collapse");
      button.onclick = () => {
        const key = section.dataset.sessionFold;
        if (folded.has(key)) folded.delete(key);
        else folded.add(key);
        section.classList.toggle("collapsed", folded.has(key));
        button.textContent = folded.has(key) ? "＋" : "−";
        button.setAttribute("aria-expanded", String(!folded.has(key)));
      };
    });
  $("#prevweek").onclick = () => changeWeek(addDays(from, -7));
  $("#thisweek").onclick = () => changeWeek(mondayOf(now));
  $("#nextweek").onclick = () => changeWeek(addDays(from, 7));
  $("#weekdate").onchange = e => changeWeek(mondayOf(e.target.value));
  // Texte d’une ligne de WOD (rôle bouton) : ouvert aussi au clavier (Entrée, Espace).
  $("#weekboard")
    .querySelectorAll('.weekwod-text[role="button"]')
    .forEach(
      t =>
        (t.onkeydown = e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            t.click();
          }
        })
    );
  $("#weekboard")
    .querySelectorAll("[data-wod-open]")
    .forEach(b => (b.onclick = e => (blurAfterTap(b, e), openProgramWodDetail(b.dataset.wodOpen, from))));
  $("#weekboard")
    .querySelectorAll("[data-log-wod]")
    .forEach(b => (b.onclick = () => openWodChoice(b.dataset.logWod)));
  $("#weekboard")
    .querySelectorAll("[data-ai-week]")
    .forEach(b => (b.onclick = () => openAiDialog("week", p.id, b.dataset.aiWeek, from)));
  bindDailySection($("#weekboard"));
  $("#weekboard")
    .querySelectorAll("[data-log-boxwod]")
    .forEach(b => (b.onclick = () => openSession(null, "box:" + b.dataset.logBoxwod)));
  $("#weekboard")
    .querySelectorAll("[data-boxwod-open]")
    .forEach(b => (b.onclick = e => (blurAfterTap(b, e), openBoxWodDetail(b.dataset.boxwodOpen))));
  $("#weekboard")
    .querySelectorAll("[data-join-box]")
    .forEach(b => (b.onclick = () => openJoinBox()));
  $("#weekboard")
    .querySelectorAll("[data-leaderboard]")
    .forEach(b => (b.onclick = () => openLeaderboard(b.dataset.leaderboard)));
  $("#weekboard")
    .querySelectorAll("[data-unplan-wod]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const id = b.dataset.unplanWod;
          try {
            await api("/weekly-plans", {method: "DELETE", body: JSON.stringify({week_start: from, wod_id: id})});
            await changeWeek(from);
            toast("Planification supprimée.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  const addButton = $("#addsession");
  if (addButton) addButton.onclick = addSessionFromWeek;
  const competition = $("#weekcompetition");
  if (competition)
    competition.onchange = async e => {
      try {
        await api("/weekly-flags", {
          method: "PUT",
          body: JSON.stringify({week_start: from, competition: e.target.checked}),
        });
        weekCompetition = e.target.checked;
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message);
      }
    };
}
// Ligne touchée (ou cliquée) : on lui retire le focus avant d’ouvrir la fenêtre, sinon le navigateur le lui rend à la
// fermeture et un cadre de focus reste affiché. Ouverte au clavier (Entrée, Espace : e.detail = 0), elle le garde.
function blurAfterTap(el, e) {
  if (e.detail) el.blur();
}
// Invitations : un partenaire m’a tagué sur sa séance ; ✓ l’ajoute à mon historique (copie indépendante), × la refuse.
function weekInvitesSection() {
  if (!pendingTags.length) return "";
  return `<section class="session-fold session-invites"><div class="weekheading"><h2>Séances partagées</h2><span>${pendingTags.length}</span></div><div class="session-fold-body"><div class="weekwodlist">${pendingTags
    .map(
      t =>
        `<article class="weekwod card"><div class="weekcount"><button type="button" class="smallbtn" data-invite-accept="${esc(t.id)}" aria-label="Ajouter à mon historique" title="Ajouter à mon historique"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg></button><button type="button" class="smallbtn delete" data-invite-decline="${esc(t.id)}" aria-label="Refuser" title="Refuser"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div><div class="weekwod-text"><b>${esc(partnerName(t))} t’a tagué</b><p class="wod-preview">${esc(fmt(t.session_date) + " · " + t.wod_name + (t.actual_comment ? "\n" + t.actual_comment : ""))}</p></div></article>`
    )
    .join("")}</div></div></section>`;
}
function bindInvites() {
  const answer = async (id, action) => {
    try {
      const d = await sendApi("/session-tags/" + id + "/" + action, "POST");
      if (action === "accept") selectedWeekStart = mondayOf(d.session_date);
      await loadSessions();
      toast(action === "accept" ? "Séance ajoutée à ton historique." : "Invitation refusée.");
    } catch (x) {
      toast(x.offline ? OFFLINE_MESSAGE : x.message);
    }
  };
  $("#weekboard")
    .querySelectorAll("[data-invite-accept]")
    .forEach(b => (b.onclick = () => answer(b.dataset.inviteAccept, "accept")));
  $("#weekboard")
    .querySelectorAll("[data-invite-decline]")
    .forEach(
      b =>
        (b.onclick = () => {
          if (confirm("Refuser cette séance partagée ?")) answer(b.dataset.inviteDecline, "decline");
        })
    );
}
// WOD de la programmation en fenêtre (même fenêtre que le WOD du jour) : contenu complet de la semaine.
function openProgramWodDetail(wodId, week) {
  const p = programs.find(x => (wodsByProgram[x.id] || []).some(y => y.id === wodId)),
    w = p && wodsByProgram[p.id].find(x => x.id === wodId);
  if (!w) return;
  const done = sessions.some(s => s.wod_id === w.id),
    content = weeklyWodContent(w.id, week) || w.planned_comment || "";
  $("#dailydetailtitle").textContent = w.name;
  $("#dailydetailmeta").textContent = [p?.name, "Semaine du " + fmt(week), done ? "séance enregistrée" : ""]
    .filter(Boolean)
    .join(" · ");
  // Contenu de la semaine généré par l’IA : par bloc ; écrit (ou modifié) à la main : texte brut.
  let parts = null;
  try {
    const entry = weeklyWodPrograms.find(x => x.wod_id === w.id && x.week_start === week);
    parts = entry?.blocks ? JSON.parse(entry.blocks) : null;
  } catch {}
  fillWodBody($("#dailydetailbody"), parts, content || "Pas de contenu écrit pour cette semaine.");
  $("#dailydetailactions").innerHTML = done
    ? ""
    : `<button type="button" class="primary" data-detail-log><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg><span>Ajouter une séance</span></button>`;
  $("#dailydetailactions").insertAdjacentHTML(
    "beforeend",
    '<button type="button" class="smallbtn" data-program-scores>Historique des scores</button>'
  );
  $("#dailydetailactions").querySelector("[data-program-scores]").onclick = () => {
    $("#dailydetaildialog").close();
    openProgramScoreHistory(w.id, w.name);
  };
  const log = $("#dailydetailactions").querySelector("[data-detail-log]");
  if (log)
    log.onclick = () => {
      $("#dailydetaildialog").close();
      openWodChoice(w.id);
    };
  $("#dailydetaildialog").showModal();
}
async function openProgramScoreHistory(id, name) {
  const dialog = $("#programscoresdialog"),
    body = $("#programscoresbody");
  $("#programscoresname").textContent = name;
  body.innerHTML = '<p class="muted">Chargement…</p>';
  const loading = body.firstElementChild;
  dialog.showModal();
  try {
    const {scores} = await api("/wods/" + id + "/scores");
    if (!dialog.open || body.firstElementChild !== loading) return;
    body.innerHTML = scores.length
      ? `<ul class="leaderboard-list">${scores
          .map(
            s =>
              `<li><span class="leaderboard-name">${fmt(s.session_date)}${s.pending ? ' <small class="muted">(en attente)</small>' : ""}</span><b>${esc(formatScore(s.score_type, s.score_value))}</b></li>`
          )
          .join("")}</ul>`
      : '<p class="muted">Aucun score enregistré pour ce WOD.</p>';
  } catch (e) {
    if (dialog.open && body.firstElementChild === loading)
      body.innerHTML = `<p class="error">${esc(e.offline ? "Consulte cet historique une première fois en ligne pour le retrouver hors connexion." : e.message)}</p>`;
  }
}
// WOD de la box en fenêtre (même fenêtre que le WOD du jour) : contenu complet et séance (le classement reste sur la
// ligne).
function openBoxWodDetail(id) {
  const w = boxWods.find(x => x.id === id);
  if (!w) return;
  const done = datedWodDone(w, "box_wod_id");
  $("#dailydetailtitle").textContent = managerWodTitle(w);
  $("#dailydetailmeta").textContent = [w.box_name, done ? "séance enregistrée" : ""].filter(Boolean).join(" · ");
  fillWodBody(
    $("#dailydetailbody"),
    w.blocks ? boxWodBlockParts(w).map(([label, text]) => ({label, text})) : null,
    w.content || "Pas de contenu écrit pour ce WOD."
  );
  $("#dailydetailactions").innerHTML =
    w.wod_date <= today() && !done
      ? `<button type="button" class="primary" data-detail-log><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg><span>Enregistrer la séance</span></button>`
      : "";
  const log = $("#dailydetailactions").querySelector("[data-detail-log]");
  if (log)
    log.onclick = () => {
      $("#dailydetaildialog").close();
      openSession(null, "box:" + w.id);
    };
  $("#dailydetaildialog").showModal();
}
async function changeWeek(start) {
  selectedWeekStart = start;
  await loadSessions();
}
