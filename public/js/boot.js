// FitFactory — démarrage : mode hors ligne, session en cours, synchronisation.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

FFOffline.init({
  send: sendApi,
  // WOD de référence tiré hors ligne : titre, texte et chrono repris de la liste gardée sur le téléphone.
  // WOD saisi à la main hors ligne : titre, texte et blocs construits sur le téléphone.
  describeManualWod: b => describeManualWod(b),
  describeBenchmarkWod: b => {
    const bench = benchmarkFor(b.benchmark_id);
    return {
      title: bench?.name || "WOD de référence",
      content: bench?.content || "",
      chrono: bench?.chrono || null,
      movement_ids: [],
      benchmark_id: b.benchmark_id,
      score_type: bench?.score || null,
    };
  },
  describeSession: b => {
    // WOD de box : nom, contenu, box, type de score et catégorie, pour l’affichage hors ligne.
    const boxWod = b.box_wod_id ? boxWodsById.get(b.box_wod_id) : null,
      dailyWod = b.daily_wod_id ? dailyWodsById.get(b.daily_wod_id) : null;
    // WOD du jour : nom et contenu, pour l’affichage hors ligne.
    if (dailyWod && !boxWod)
      return {
        program_name: "Hors programme",
        wod_name: dailyWod.title,
        planned_comment: dailyWod.content || "",
        daily_wod_date: dailyWod.wod_date,
        score_type: dailyWod.score_type,
        benchmark_id: dailyWod.benchmark_id,
        program_score_type: null,
        box_name: null,
        score_category_name: null,
        ...(activities.find(x => x.id === b.activity_id)
          ? {activity_name: activities.find(x => x.id === b.activity_id).name}
          : {}),
      };
    if (boxWod)
      return {
        program_name: "Hors programme",
        wod_name: boxWod.name,
        planned_comment: boxWod.content || "",
        box_id: boxWod.box_id,
        box_name: boxWod.box_name,
        box_wod_date: boxWod.wod_date,
        score_type: boxWod.score_type,
        benchmark_id: null,
        program_score_type: null,
        score_category_name: boxCategories.find(c => c.id === b.score_category_id)?.name || null,
        ...(activities.find(x => x.id === b.activity_id)
          ? {activity_name: activities.find(x => x.id === b.activity_id).name}
          : {}),
      };
    const p = programs.find(x => x.id === b.program_id),
      w =
        b.wod_id === "other"
          ? {name: "Autres"}
          : programs.flatMap(x => wodsByProgram[x.id] || []).find(x => x.id === b.wod_id),
      a = activities.find(x => x.id === b.activity_id);
    return {
      program_score_type: b.score_type ?? null,
      benchmark_id: null,
      box_name: null,
      score_category_name: null,
      ...(p ? {program_name: p.name} : b.program_id === "none" ? {program_name: "Hors programme"} : {}),
      ...(w ? {wod_name: w.name === "__AUTRES__" ? "Autres" : w.name, planned_comment: w.planned_comment || ""} : {}),
      ...(a ? {activity_name: a.name} : {}),
    };
  },
  describePr: b => {
    const m = movementCatalog.find(x => x.id === b.movement_id);
    return m ? {movement_name: m.name, measurement_method: m.measurement_method} : {};
  },
  // WOD de box créé ou modifié hors ligne : nom par défaut et nom de la box.
  describeBoxWod: b => {
    const type = (managedBox?.types || []).find(t => t.id === b.type_id) || (managedBox?.types || [])[0];
    return {
      ...(b.catalog_movement_ids ? {movement_ids: b.catalog_movement_ids} : {}),
      name: b.name || defaultWodName(b.wod_date, type?.name),
      type_name: type?.name,
      box_name: boxName(b.box_id),
    };
  },
  describeMe: () => ({first_name: user?.first_name || "", last_name: user?.last_name || ""}),
  onChange: renderSyncStatus,
  onSynced: async () => {
    if (user) {
      await load();
      toast("Modifications hors ligne synchronisées.");
    }
  },
  onDropped: (op, e) => toast("Une modification hors ligne a été refusée : " + e.message),
});
$("#syncstatus").onclick = () => FFOffline.flush();
(async () => {
  // Lien « mot de passe oublié » : ?reset=<jeton> ouvre directement le formulaire de nouveau mot de passe.
  const params = new URLSearchParams(location.search),
    reset = params.has("reset");
  if (reset) {
    resetToken = params.get("reset");
    history.replaceState(null, "", location.pathname);
    showAuthPanel("reset");
  }
  try {
    const d = await api("/me");
    if (!FFOffline.state().offline) cacheDefaultTheme(d.default_theme);
    if (!reset && d.user) {
      user = d.user;
      isAdmin = !!d.is_admin;
      FFOffline.setOwner(user.id);
      showApp();
      FFOffline.flush();
      return;
    }
    if (!reset) FFOffline.clear();
  } catch (e) {
    if (!reset && e.message === OFFLINE_MESSAGE)
      $("#autherror").textContent =
        "Pas de connexion internet et aucune donnée enregistrée sur ce téléphone : connecte-toi une première fois avec du réseau.";
  }
  showAuth();
})();
