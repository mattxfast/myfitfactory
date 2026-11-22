// FitFactory — suivi de l’alimentation : bilan du jour (calories, macronutriments, fibres…, part des produits
// ultra-transformés), repas détaillés, 7 derniers jours, saisie d’un repas : produits scannés (valeurs de l’étiquette,
// Open Food Facts, voir scan.js) et/ou photo et aliments avec quantité, analysés par l’IA.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.
// L’analyse demande le réseau (jamais en file d’attente) ; la photo, réduite sur le téléphone, n’est pas conservée.
// L’enregistrement d’un repas déjà analysé fonctionne hors ligne (client_id).

const MEAL_TIMEOUT = 100000,
  MEAL_PHOTO_SIDE = 1024,
  NUTRIENT_KEYS = ["kcal", "protein_g", "carbs_g", "sugars_g", "fat_g", "sat_fat_g", "fiber_g", "salt_g"],
  MEAL_CONFIDENCE = {faible: "Estimation approximative", moyenne: "Estimation moyenne", bonne: "Estimation fiable"};
let nutritionDay = null,
  meals = [],
  mealExpanded = new Set(),
  // Repas en cours de saisie : identifiant (modification), photo réduite, produits scannés, dernière analyse de l’IA
  // (photo et aliments saisis seulement), analyse périmée ?
  mealDraft = {id: null, photo: "", scanned: [], analysis: null, stale: false},
  mealAnalyzing = false;

const kcalText = v => Math.round(Number(v) || 0).toLocaleString("fr-FR");
const gramText = v => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString("fr-FR") + " g";
const sumNutrients = list =>
  Object.fromEntries(NUTRIENT_KEYS.map(k => [k, list.reduce((s, x) => s + (Number(x[k]) || 0), 0)]));
const dayLabel = d =>
  new Intl.DateTimeFormat("fr-FR", {weekday: "short", day: "2-digit", month: "2-digit"}).format(
    new Date(d + "T12:00:00")
  );
const nowTime = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

async function loadNutrition() {
  if (!nutritionDay) nutritionDay = today();
  const day = nutritionDay;
  try {
    const d = await api("/meals?from=" + addDays(day, -6) + "&to=" + day);
    if (day !== nutritionDay) return;
    meals = d.meals;
  } catch (e) {
    toast(e.message);
  }
  renderNutrition();
}
function changeNutritionDay(day) {
  if (!day) return;
  nutritionDay = day > today() ? today() : day;
  loadNutrition();
}
// Répartition de l’énergie : protéines et glucides 4 kcal/g, lipides 9 kcal/g.
function macroShares(t) {
  const p = t.protein_g * 4,
    c = t.carbs_g * 4,
    f = t.fat_g * 9,
    sum = p + c + f;
  return sum ? {protein: (p / sum) * 100, carbs: (c / sum) * 100, fat: (f / sum) * 100} : null;
}
// Part des calories du jour venant de produits ultra-transformés (NOVA 4), connue seulement pour les produits scannés.
function novaLine(dayMeals, t) {
  const items = dayMeals.flatMap(m => m.items || []).filter(x => x.nova);
  if (!items.length || !t.kcal) return "";
  const share = (items.filter(x => x.nova === 4).reduce((s, x) => s + (Number(x.kcal) || 0), 0) / t.kcal) * 100;
  return `<p class="nutrition-nova"><span class="nova nova-4">NOVA 4</span><span>Ultra-transformés : <b>${Math.round(share)} %</b> des calories du jour<small>calculé sur les produits scannés</small></span></p>`;
}
function nutritionSummary(t, dayMeals) {
  const shares = macroShares(t),
    macro = (key, label, cls) =>
      `<div class="nutrition-macro ${cls}"><strong>${gramText(t[key])}</strong><span>${label}${shares ? " · " + Math.round(shares[cls]) + " %" : ""}</span></div>`;
  return `<div class="nutrition-summary card"><div class="nutrition-energy"><div><strong>${kcalText(t.kcal)}</strong><span>kcal</span></div></div><div class="nutrition-bar" aria-hidden="true">${shares ? `<span class="protein" style="width:${shares.protein}%"></span><span class="carbs" style="width:${shares.carbs}%"></span><span class="fat" style="width:${shares.fat}%"></span>` : ""}</div><div class="nutrition-macros">${macro("protein_g", "Protéines", "protein")}${macro("carbs_g", "Glucides", "carbs")}${macro("fat_g", "Lipides", "fat")}</div><dl class="nutrition-extra"><div><dt>Fibres</dt><dd>${gramText(t.fiber_g)}</dd></div><div><dt>dont sucres</dt><dd>${gramText(t.sugars_g)}</dd></div><div><dt>dont AG saturés</dt><dd>${gramText(t.sat_fat_g)}</dd></div><div><dt>Sel</dt><dd>${gramText(t.salt_g)}</dd></div></dl>${novaLine(dayMeals, t)}</div>`;
}
// Détail d’un repas : valeurs par aliment, puis fibres, sucres, AG saturés et sel du repas.
function mealDetail(m) {
  const rows = (m.items || [])
    .map(
      x =>
        `<tr><th scope="row">${esc(x.name)}${foodBadges(x)}${x.quantity || x.grams ? `<small>${esc(x.quantity || "")}${x.grams && x.source !== "off" && x.quantity !== x.grams + " g" ? (x.quantity ? " · " : "") + "≈ " + gramText(x.grams) : ""}</small>` : ""}</th><td>${kcalText(x.kcal)}</td><td>${gramText(x.protein_g)}</td><td>${gramText(x.carbs_g)}</td><td>${gramText(x.fat_g)}</td></tr>`
    )
    .join("");
  return `<div class="meal-detail"><table class="meal-table"><thead><tr><th scope="col">Aliment</th><th scope="col">kcal</th><th scope="col">Prot.</th><th scope="col">Gluc.</th><th scope="col">Lip.</th></tr></thead><tbody>${rows}</tbody></table><p class="meal-extra">Fibres ${gramText(m.fiber_g)} · sucres ${gramText(m.sugars_g)} · AG saturés ${gramText(m.sat_fat_g)} · sel ${gramText(m.salt_g)}</p>${m.remarks ? `<p class="meal-remarks">${esc(m.remarks)}</p>` : ""}${m.note ? `<p class="meal-extra"><b>Précision :</b> ${esc(m.note)}</p>` : ""}${MEAL_CONFIDENCE[m.confidence] ? `<p class="hint">${MEAL_CONFIDENCE[m.confidence]} (calculée par l’IA).</p>` : ""}${(m.items || []).some(x => x.source === "off") ? `<p class="hint">${OFF_CREDIT}</p>` : ""}</div>`;
}
function renderNutrition() {
  const now = today(),
    day = nutritionDay,
    dayMeals = meals.filter(m => m.meal_date === day),
    nav = `<div class="weekbar card"><div class="weeknav"><button class="smallbtn" id="prevday" aria-label="Jour précédent" title="Jour précédent">‹</button><div class="weekdate-label"><button type="button" class="week-current" id="nutritiontoday" title="Revenir à aujourd’hui">${day === now ? "Aujourd’hui" : "Journée du"}</button><input id="nutritiondate" type="date" value="${day}" max="${now}" aria-label="Journée du"></div><button class="smallbtn" id="nextday" aria-label="Jour suivant" title="Jour suivant" ${day >= now ? "disabled" : ""}>›</button></div></div>`;
  const list = dayMeals.length
    ? dayMeals
        .map(m => {
          const open = mealExpanded.has(m.id);
          return `<article class="entry meal-entry ${open ? "open" : ""}"><div class="meal-head"><button type="button" class="smallbtn section-collapse" data-toggle-meal="${m.id}" aria-expanded="${open}" aria-label="${open ? "Masquer le détail" : "Voir le détail"}">${open ? "−" : "＋"}</button><div class="meal-title" data-toggle-meal="${m.id}"><span class="sessiondate">${esc(m.meal_time)}</span><h3>${esc(m.title)}</h3>${m.pending ? `<span class="tracked-tag">En attente</span>` : ""}<small>${kcalText(m.kcal)} kcal · P ${gramText(m.protein_g)} · G ${gramText(m.carbs_g)} · L ${gramText(m.fat_g)}</small></div><div class="entryactions"><button class="smallbtn" data-edit-meal="${m.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-meal="${m.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div></div>${open ? mealDetail(m) : ""}</article>`;
        })
        .join("")
    : sectionEmpty("Pas de repas enregistré ce jour");
  // 7 derniers jours (jusqu’au jour affiché) : seuls les jours avec des repas ; un toucher affiche la journée.
  const days = Array.from({length: 7}, (_, i) => addDays(day, -i)).filter(d => meals.some(m => m.meal_date === d)),
    history = days
      .map(d => {
        const t = sumNutrients(meals.filter(m => m.meal_date === d)),
          n = meals.filter(m => m.meal_date === d).length;
        return `<button type="button" class="nutrition-day-row ${d === day ? "active" : ""}" data-nutrition-day="${d}"><span>${esc(dayLabel(d))}</span>${n ? `<strong>${kcalText(t.kcal)} kcal</strong><small>P ${gramText(t.protein_g)} · G ${gramText(t.carbs_g)} · L ${gramText(t.fat_g)} · F ${gramText(t.fiber_g)}</small>` : `<small class="muted">Aucun repas</small>`}</button>`;
      })
      .join("");
  $("#nutritionboard").innerHTML =
    `${nav}${nutritionSummary(sumNutrients(dayMeals), dayMeals)}<div class="weekheading"><h2>Repas</h2><button type="button" class="smallbtn weekheading-action" id="addmeal" aria-label="Ajouter un repas" title="Ajouter un repas"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button><span>${dayMeals.length}</span></div><div class="entries">${list}</div><div class="weekheading"><h2>7 derniers jours</h2></div>${history ? `<div class="nutrition-history card">${history}</div>` : sectionEmpty("Aucun repas ces 7 derniers jours")}`;
  $("#prevday").onclick = () => changeNutritionDay(addDays(day, -1));
  $("#nextday").onclick = () => changeNutritionDay(addDays(day, 1));
  $("#nutritiontoday").onclick = () => changeNutritionDay(now);
  $("#nutritiondate").onchange = e => changeNutritionDay(e.target.value);
  $("#addmeal").onclick = () => openMeal(null);
  const board = $("#nutritionboard");
  board.querySelectorAll("[data-toggle-meal]").forEach(
    b =>
      (b.onclick = () => {
        const id = b.dataset.toggleMeal;
        if (mealExpanded.has(id)) mealExpanded.delete(id);
        else mealExpanded.add(id);
        renderNutrition();
      })
  );
  board
    .querySelectorAll("[data-nutrition-day]")
    .forEach(b => (b.onclick = () => changeNutritionDay(b.dataset.nutritionDay)));
  board
    .querySelectorAll("[data-edit-meal]")
    .forEach(b => (b.onclick = () => openMeal(meals.find(m => m.id === b.dataset.editMeal))));
  board.querySelectorAll("[data-del-meal]").forEach(
    b =>
      (b.onclick = async () => {
        if (!confirm("Supprimer ce repas ?")) return;
        try {
          await api("/meals/" + b.dataset.delMeal, {method: "DELETE"});
        } catch (e) {
          toast(e.message);
        }
        loadNutrition();
      })
  );
}

// ----- Saisie d’un repas -----
function mealItemRow(item = {}) {
  return `<div class="meal-item-row"><input name="item_name" maxlength="100" placeholder="Aliment" aria-label="Aliment" value="${esc(item.name || "")}"><input name="item_quantity" maxlength="40" placeholder="Quantité (ex. 150 g)" aria-label="Quantité" value="${esc(item.quantity || "")}"><button type="button" class="smallbtn delete" data-remove-item aria-label="Retirer cet aliment" title="Retirer">×</button></div>`;
}
function renderMealItems(items) {
  $("#mealitems").innerHTML = (items.length ? items : [{}]).map(mealItemRow).join("");
}
function mealItemsInput() {
  return [...$("#mealitems").querySelectorAll(".meal-item-row")]
    .map(r => ({name: r.children[0].value.trim(), quantity: r.children[1].value.trim()}))
    .filter(x => x.name);
}
// Produits scannés du repas : valeurs de l’étiquette, sans analyse.
function renderMealScanned() {
  $("#mealscanned").innerHTML = mealDraft.scanned
    .map(
      (x, i) =>
        `<div class="meal-scanned-row"><div><b>${esc(x.name)}</b>${foodBadges(x)}<small>${esc(x.quantity)} · ${kcalText(x.kcal)} kcal</small></div><button type="button" class="smallbtn delete" data-remove-scanned="${i}" aria-label="Retirer ce produit" title="Retirer">×</button></div>`
    )
    .join("");
}
function renderMealPhoto() {
  $("#mealphoto").hidden = !mealDraft.photo;
  $("#mealphoto img").src = mealDraft.photo || "";
}
// Photo ou aliments saisis : à analyser par l’IA (les produits scannés n’en ont pas besoin).
const mealHasFreeInput = () => !!mealDraft.photo || mealItemsInput().length > 0;
const mealAiItems = () => (mealDraft.analysis && !mealDraft.stale ? mealDraft.analysis.items : []);
const mealNeedsAnalysis = () => mealHasFreeInput() && (!mealDraft.analysis || mealDraft.stale);
// Résultat : produits scannés et aliments analysés (ou valeurs du repas modifié) ; une saisie modifiée depuis
// l’analyse la rend périmée.
function renderMealResult() {
  const a = mealDraft.analysis,
    items = [...mealDraft.scanned, ...mealAiItems()],
    totals = sumNutrients(items);
  $("#mealresult").hidden = !items.length && !a;
  $("#mealsave").hidden = mealNeedsAnalysis() || !items.length;
  $("#mealanalyze").hidden = !mealHasFreeInput() && !a;
  $("#mealanalyze").textContent = a ? "Relancer l’analyse" : "Analyser avec l’IA";
  if ($("#mealresult").hidden) return;
  $("#mealresult").innerHTML =
    (mealDraft.stale ? `<p class="error">Saisie modifiée : relance l’analyse avant d’enregistrer.</p>` : "") +
    (items.length
      ? `<p class="meal-result-total"><strong>${kcalText(totals.kcal)} kcal</strong> · P ${gramText(totals.protein_g)} · G ${gramText(totals.carbs_g)} · L ${gramText(totals.fat_g)}</p>` +
        mealDetail({
          ...totals,
          items,
          remarks: mealAiItems().length || !a?.items.length ? a?.remarks : "",
          confidence: mealAiItems().length ? a.confidence : "",
        })
      : `<p class="meal-remarks">${esc(a?.remarks || "Aucun aliment reconnu.")}</p>`);
}
function mealInputChanged() {
  if (mealDraft.analysis) mealDraft.stale = true;
  renderMealResult();
}
function openMeal(meal) {
  const form = $("#mealform"),
    f = form.elements,
    scanned = (meal?.items || []).filter(x => x.source === "off"),
    others = (meal?.items || []).filter(x => x.source !== "off");
  form.reset();
  mealDraft = {
    id: meal?.id || null,
    photo: "",
    scanned,
    analysis: others.length
      ? {title: meal.title, items: others, confidence: meal.confidence, remarks: meal.remarks}
      : null,
    stale: false,
  };
  $("#mealdialogtitle").textContent = meal ? "Modifier le repas" : "Nouveau repas";
  f.meal_date.max = today();
  f.meal_date.value = meal?.meal_date || nutritionDay || today();
  f.meal_time.value = meal?.meal_time || (f.meal_date.value === today() ? nowTime() : "12:00");
  f.title.value = meal?.title || "";
  f.note.value = meal?.note || "";
  renderMealItems(others.map(x => ({name: x.name, quantity: x.quantity})));
  renderMealScanned();
  renderMealPhoto();
  renderMealResult();
  $("#mealerror").textContent = "";
  $("#mealprogress").hidden = true;
  $("#mealanalyze").disabled = false;
  $("#mealdialog").showModal();
  // Analyse indisponible sans clé OpenAI : on l’indique tout de suite (les produits scannés restent possibles).
  sendApi("/meal-analysis", "GET")
    .then(d => {
      if (d.enabled) return;
      $("#mealerror").textContent =
        "L’analyse par IA n’est pas encore activée (clé OpenAI manquante) : seuls les produits scannés sont comptés.";
      $("#mealanalyze").disabled = true;
    })
    .catch(() => {});
}
// Produit scanné ajouté depuis la fenêtre de scan (scan.js).
function addScannedItem(item) {
  mealDraft.scanned.push(item);
  // L’IA a été prévenue des produits déjà comptés : un nouveau produit rend son analyse périmée.
  if (mealDraft.analysis && mealHasFreeInput()) mealDraft.stale = true;
  renderMealScanned();
  renderMealResult();
}
// Photo réduite sur le téléphone (1024 px au plus, JPEG) avant l’envoi à l’analyse.
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(Error("Image illisible : choisis une photo JPEG ou PNG."));
      i.src = url;
    });
    const scale = Math.min(1, MEAL_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight)),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}
$("#mealform").elements.photo.onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  $("#mealerror").textContent = "";
  try {
    mealDraft.photo = await shrinkPhoto(file);
  } catch (x) {
    $("#mealerror").textContent = x.message;
  }
  renderMealPhoto();
  mealInputChanged();
};
$("#mealphotoremove").onclick = () => {
  mealDraft.photo = "";
  renderMealPhoto();
  mealInputChanged();
};
$("#addmealitem").onclick = () => {
  $("#mealitems").insertAdjacentHTML("beforeend", mealItemRow());
  $("#mealitems").lastElementChild.children[0].focus();
};
$("#scanmealitem").onclick = () => openScan();
$("#mealitems").onclick = e => {
  const button = e.target.closest("[data-remove-item]");
  if (!button) return;
  button.parentElement.remove();
  if (!$("#mealitems").children.length) renderMealItems([]);
  mealInputChanged();
};
$("#mealscanned").onclick = e => {
  const button = e.target.closest("[data-remove-scanned]");
  if (!button) return;
  mealDraft.scanned.splice(Number(button.dataset.removeScanned), 1);
  renderMealScanned();
  renderMealResult();
};
$("#mealitems").oninput = mealInputChanged;
$("#mealform").elements.note.oninput = mealInputChanged;
$("#mealanalyze").onclick = async () => {
  if (mealAnalyzing) return;
  const f = $("#mealform").elements,
    items = mealItemsInput();
  $("#mealerror").textContent = "";
  if (!mealDraft.photo && !items.length) {
    $("#mealerror").textContent = "Ajoute une photo ou au moins un aliment à analyser.";
    return;
  }
  if (!navigator.onLine) {
    $("#mealerror").textContent = OFFLINE_MESSAGE;
    return;
  }
  mealAnalyzing = true;
  $("#mealanalyze").disabled = true;
  $("#mealsave").hidden = true;
  // Le résultat précédent est masqué pendant l’analyse : le nouveau apparaît en fondu.
  $("#mealresult").hidden = true;
  $("#mealphoto").classList.add("scanning");
  aiWaitStart($("#mealprogress"), "Analyse en cours… (jusqu’à une minute)");
  try {
    const d = await sendApi(
      "/meal-analysis",
      "POST",
      {
        photo: mealDraft.photo || null,
        items,
        note: f.note.value.trim(),
        known: mealDraft.scanned.map(x => ({name: x.name, quantity: x.quantity})),
      },
      MEAL_TIMEOUT
    );
    mealDraft.analysis = d.analysis;
    mealDraft.stale = false;
    // Les aliments reconnus remplacent la saisie : on peut les corriger puis relancer l’analyse.
    if (d.analysis.items.length) renderMealItems(d.analysis.items.map(x => ({name: x.name, quantity: x.quantity})));
    if (!f.title.value.trim()) f.title.value = d.analysis.title;
    $("#mealphoto").classList.remove("scanning");
    await aiWaitDone($("#mealprogress"), "Analyse terminée");
  } catch (x) {
    $("#mealerror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
  } finally {
    mealAnalyzing = false;
    $("#mealanalyze").disabled = false;
    $("#mealprogress").hidden = true;
    $("#mealphoto").classList.remove("scanning");
    renderMealResult();
  }
};
$("#mealform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    a = mealDraft.analysis,
    aiItems = mealAiItems(),
    items = [...mealDraft.scanned, ...aiItems];
  if (mealNeedsAnalysis()) return;
  if (!items.length) {
    $("#mealerror").textContent = "Aucun aliment : scanne un produit ou complète la saisie et lance l’analyse.";
    return;
  }
  const body = {
    meal_date: f.meal_date.value,
    meal_time: f.meal_time.value,
    title: f.title.value.trim() || (aiItems.length && a.title) || mealDraft.scanned[0]?.name || "Repas",
    note: f.note.value.trim(),
    items,
    confidence: aiItems.length ? a.confidence : "",
    remarks: aiItems.length ? a.remarks : "",
    // Totaux : recalculés par le serveur ; envoyés pour l’affichage immédiat hors ligne.
    ...sumNutrients(items),
  };
  try {
    if (mealDraft.id) await api("/meals/" + mealDraft.id, {method: "PUT", body: JSON.stringify(body)});
    else await api("/meals", {method: "POST", body: JSON.stringify({...body, client_id: crypto.randomUUID()})});
  } catch (x) {
    $("#mealerror").textContent = x.message;
    return;
  }
  $("#mealdialog").close();
  toast("Repas enregistré.");
  nutritionDay = body.meal_date;
  loadNutrition();
};
$("#closemeal").onclick = () => $("#mealdialog").close();
