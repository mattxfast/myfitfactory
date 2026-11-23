// FitFactory — mon compte : profil et thème clair/sombre.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

// Profil : prénom, nom et profil d’athlète (poids, sexe, date de naissance : score de forme).
function fillProfileForm() {
  const f = $("#profileform").elements;
  f.first_name.value = user.first_name || "";
  f.last_name.value = user.last_name || "";
  f.body_weight_kg.value = user.body_weight_kg ?? "";
  f.birth_date.value = user.birth_date || "";
  f.birth_date.max = addDays(today(), -3650);
  f.sex.value = user.sex || "";
}
$("#profileform").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#profileerror").textContent = "";
  try {
    const d = await api("/profile", {
      method: "PUT",
      body: JSON.stringify({
        first_name: f.get("first_name"),
        last_name: f.get("last_name"),
        body_weight_kg: f.get("body_weight_kg"),
        birth_date: f.get("birth_date"),
        sex: f.get("sex"),
      }),
    });
    if (d?.user) user = d.user;
    renderUserbar();
    loadFitness();
    toast("Profil mis à jour.");
  } catch (x) {
    $("#profileerror").textContent = x.message;
  }
};

// Thème effectif gardé sur l’appareil (copie du thème du compte) ; « Sombre » si rien n’est encore connu.
function themePreference() {
  try {
    const old = localStorage.getItem("cfplanner-theme");
    if (old !== null) {
      if (localStorage.getItem("fitfactory-theme") === null) localStorage.setItem("fitfactory-theme", old);
      localStorage.removeItem("cfplanner-theme");
    }
    const theme = localStorage.getItem("fitfactory-theme");
    return THEME_BAR_COLORS[theme] ? theme : "dark";
  } catch {
    return "dark";
  }
}
// Thèmes appliqués tels quels (data-theme sur <html>).
const THEME_BAR_COLORS = {light: "#f5f5f0", dark: "#121212", massilia: "#f4f4f4", massilia2: "#0d0d0d"};
function applyTheme() {
  const theme = themePreference();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BAR_COLORS[theme]);
}
// Thème du compte (et non de l’appareil) : enregistré sur le serveur ; « Par défaut » suit le thème choisi par
// l’administrateur. Le thème effectif est recopié sur l’appareil pour s’afficher dès l’ouverture (avant connexion).
const THEME_NAMES = {
  light: "Clair",
  dark: "Sombre",
  massilia: "Massilia CrossFit",
  massilia2: "Massilia CrossFit 2",
};
let preferences = null;
function cacheTheme(theme) {
  try {
    localStorage.setItem("fitfactory-theme", theme);
  } catch {}
  applyTheme();
}
function setPreferences(d) {
  preferences = d;
  const select = $("#themeselect");
  select.innerHTML =
    `<option value="default">Par défaut (${esc(THEME_NAMES[d.default_theme] || d.default_theme)})</option>` +
    d.choices.themes.map(t => `<option value="${t}">${esc(THEME_NAMES[t] || t)}</option>`).join("");
  select.value = d.theme || "default";
  cacheTheme(d.theme || d.default_theme);
  $("#interfaceselect").value = simpleInterface() ? "simple" : "advanced";
  $("#commonwodoptin").checked = !!d.common_wod;
  applyInterface();
  renderReminders();
  renderCoachCard();
}
// Interface simplifiée : pas d’onglet Programmes ; la page Séances ne garde que l’historique et les mouvements
// travaillés (sessions.js). Le formulaire de séance propose toujours tous les WOD.
const simpleInterface = () => preferences?.interface === "simple";
function applyInterface() {
  const simple = simpleInterface();
  // Un programme de coach proposé reste visible (pastille rouge) même en interface simplifiée.
  const hidden = simple && !coachInvites.length;
  $('.navtab[data-view="programs"]').hidden = hidden;
  if (hidden && !$("#view-programs").hidden) switchView("sessions");
}
// WOD aléatoire du jour : option du compte, désactivée par défaut (rubrique Séances et notification).
$("#commonwodoptin").onchange = async e => {
  const on = e.target.checked;
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({common_wod: on})});
    if (preferences) preferences.common_wod = on ? 1 : 0;
    commonWod = null;
    await loadCommonWod();
    renderWeek();
    toast(on ? "WOD aléatoire du jour activé." : "WOD aléatoire du jour désactivé.");
  } catch (x) {
    e.target.checked = !on;
    toast(x.offline ? OFFLINE_MESSAGE : x.message);
  }
};
$("#interfaceselect").onchange = async e => {
  const value = e.target.value === "simple" ? "simple" : "advanced";
  if (preferences) preferences.interface = value;
  applyInterface();
  renderWeek();
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({interface: value})});
    toast(value === "simple" ? "Interface simplifiée activée." : "Interface avancée activée.");
  } catch (x) {
    toast(x.offline ? OFFLINE_MESSAGE : x.message);
  }
};
$("#themeselect").onchange = async e => {
  const theme = e.target.value === "default" ? null : e.target.value;
  cacheTheme(theme || preferences?.default_theme || "dark");
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({theme})});
    if (preferences) preferences.theme = theme;
    toast("Thème enregistré pour ton compte.");
  } catch (x) {
    toast(x.message);
  }
};
applyTheme();
