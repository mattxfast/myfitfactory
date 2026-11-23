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

// Le thème par défaut est partagé par l’écran de connexion et les comptes qui le choisissent.
const THEME_BAR_COLORS = {light: "#f5f5f0", dark: "#121212", massilia: "#f4f4f4", massilia2: "#0d0d0d"};
let defaultTheme = document.documentElement.dataset.theme || "dark";
function cacheDefaultTheme(theme) {
  if (!Object.hasOwn(THEME_BAR_COLORS, theme)) return;
  defaultTheme = theme;
  try {
    localStorage.setItem("fitfactory-default-theme", theme);
  } catch {}
}
function applyTheme(theme = defaultTheme) {
  if (!Object.hasOwn(THEME_BAR_COLORS, theme)) theme = defaultTheme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BAR_COLORS[theme]);
}
// Copie du thème du compte, utilisée après l’ouverture de la session.
function themePreference() {
  try {
    const old = localStorage.getItem("cfplanner-theme");
    if (old !== null) {
      if (localStorage.getItem("fitfactory-theme") === null) localStorage.setItem("fitfactory-theme", old);
      localStorage.removeItem("cfplanner-theme");
    }
    return localStorage.getItem("fitfactory-theme");
  } catch {
    return null;
  }
}
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
  applyTheme(theme);
}
function setPreferences(d) {
  if (!user) return;
  preferences = d;
  const select = $("#themeselect");
  select.innerHTML =
    `<option value="default">Par défaut (${esc(THEME_NAMES[d.default_theme] || d.default_theme)})</option>` +
    d.choices.themes.map(t => `<option value="${t}">${esc(THEME_NAMES[t] || t)}</option>`).join("");
  select.value = d.theme || "default";
  cacheDefaultTheme(d.default_theme);
  cacheTheme(d.theme || defaultTheme);
  $("#commonwodoptin").checked = !!d.common_wod;
  applyInterface();
  renderReminders();
  renderCoachCard();
}
function requiresAdvancedInterface() {
  const date = today();
  return programs.some(p => isTrainingProgram(p) && p.end_monday >= date);
}
const simpleInterface = () => preferences?.interface === "simple" && !requiresAdvancedInterface();
function applyInterface() {
  const locked = requiresAdvancedInterface(),
    simple = !locked && preferences?.interface === "simple",
    select = $("#interfaceselect");
  select.value = simple ? "simple" : "advanced";
  select.disabled = locked;
  select.setAttribute("aria-describedby", locked ? "interfacelock" : "interfacehint");
  $("#interfacelock").hidden = !locked;
  // Un programme de coach proposé reste visible (pastille rouge) même en interface simplifiée.
  const hidden = simple && !coachInvites.length;
  $('.navtab[data-view="programs"]').hidden = hidden;
  if (hidden && !$("#view-programs").hidden) switchView("sessions");
}
// WOD aléatoire du jour : option du compte, désactivée par défaut (rubrique Séances et notification).
async function setCommonWodOptIn(on) {
  const option = $("#commonwodoptin");
  if (option.disabled) return;
  const setDisabled = value => {
    option.disabled = value;
    const subscribe = $('[data-week-action="subscribe"]');
    if (subscribe) subscribe.disabled = value;
  };
  setDisabled(true);
  try {
    const result = await api("/preferences", {method: "PUT", body: JSON.stringify({common_wod: on})});
    if (preferences) preferences.common_wod = on ? 1 : 0;
    option.checked = on;
    commonWod = null;
    await loadCommonWod();
    renderWeek();
    toast(
      result.queued
        ? "Préférence enregistrée hors ligne, en attente de synchronisation."
        : on
          ? "WOD aléatoire du jour activé."
          : "WOD aléatoire du jour désactivé."
    );
  } catch (x) {
    option.checked = !!preferences?.common_wod;
    toast(x.offline ? OFFLINE_MESSAGE : x.message);
  } finally {
    setDisabled(false);
  }
}
$("#commonwodoptin").onchange = e => setCommonWodOptIn(e.currentTarget.checked);
$("#interfaceselect").onchange = async e => {
  if (requiresAdvancedInterface()) return applyInterface();
  const select = e.currentTarget,
    value = select.value === "simple" ? "simple" : "advanced";
  select.disabled = true;
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({interface: value})});
    if (preferences) preferences.interface = value;
    renderWeek();
    toast(value === "simple" ? "Interface simplifiée activée." : "Interface avancée activée.");
  } catch (x) {
    if (x.status === 409) await load();
    toast(x.offline ? OFFLINE_MESSAGE : x.message);
  } finally {
    applyInterface();
  }
};
$("#themeselect").onchange = async e => {
  const theme = e.target.value === "default" ? null : e.target.value;
  cacheTheme(theme || defaultTheme);
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({theme})});
    if (preferences) preferences.theme = theme;
    toast("Thème enregistré pour ton compte.");
  } catch (x) {
    toast(x.message);
  }
};
