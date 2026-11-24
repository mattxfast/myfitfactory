// FitFactory — fonctions communes : état global, dates, appels API, messages, connexion.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

(() => {
  const u = new URL(location.href);
  if (u.searchParams.has("password")) {
    u.searchParams.delete("password");
    u.searchParams.delete("email");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }
})();
const $ = s => document.querySelector(s);
let tab = "login",
  user = null,
  selectedWeekStart = null,
  programs = [],
  wodsByProgram = {},
  movementsByProgram = {},
  movementChecks = [],
  catalogChecks = [],
  sessions = [],
  prRecords = [],
  activities = [],
  movementCatalog = [],
  isAdmin = false,
  weekCompetition = false,
  weeklyPlans = [],
  weeklyWodPrograms = [],
  boxWods = [],
  sessionTags = [], // partenaires tagués sur mes séances de la semaine
  sharedPartners = [], // séances ajoutées depuis une invitation : l’auteur et les autres partenaires
  pendingTags = [], // séances où je suis tagué, en attente de ma réponse
  coachInvites = [], // programmes de coach qu’on me propose, en attente de ma réponse
  commonWod = null,
  wodTypes = []; // types de WOD (liste commune gérée par l’administrateur) // WOD aléatoire du jour : {wod, joined_id, participants}
const movementCategoryLabels = {
  lift: "Lift",
  force: "Force",
  gym: "Gym",
  engine: "Engine",
  core: "Core",
  functional: "Fonctionnel",
};
const movementCategoryByMethod = {load: "lift", force: "force", reps: "gym", distance: "engine", reps_time: "gym"};
const movementCategory = movement => movement.category ?? movementCategoryByMethod[movement.measurement_method];
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmt = s =>
  new Intl.DateTimeFormat("fr-FR", {day: "2-digit", month: "2-digit", year: "numeric"}).format(
    new Date(s + "T12:00:00")
  );
const addDays = (s, n) => {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = s => {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const OFFLINE_MESSAGE = "Pas de connexion internet : réessaie quand le réseau revient.";
// Envoi réseau : une coupure ou un délai dépassé donne une erreur marquée « offline » (gérée par offline.js).
// Délai par défaut : 8 s en lecture, 15 s en écriture (plus long pour la génération par IA).
async function sendApi(path, method, body, timeout = method === "GET" ? 8000 : 15000) {
  const ctrl = new AbortController(),
    timer = setTimeout(() => ctrl.abort(), timeout);
  let r;
  try {
    r = await fetch("/api" + path, {
      method,
      body: body == null ? undefined : JSON.stringify(body),
      headers: {"content-type": "application/json"},
      signal: ctrl.signal,
    });
  } catch {
    const e = Error(OFFLINE_MESSAGE);
    e.offline = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let d;
  try {
    d = await r.json();
  } catch {
    d = {};
  }
  if (!r.ok) {
    const e = Error(d.error || "Erreur");
    e.status = r.status;
    throw e;
  }
  return d;
}
async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase(),
    body = opts.body ? JSON.parse(opts.body) : null;
  if (method === "GET") return FFOffline.read(path, () => sendApi(path, "GET"));
  return FFOffline.write(path, method, body, b => sendApi(path, method, b));
}
function renderSyncStatus(st) {
  const el = $("#syncstatus");
  if (!el) return;
  el.hidden = !st.offline && !st.pending;
  el.classList.toggle("offline", st.offline);
  const waiting = st.pending + (st.pending > 1 ? " modifications en attente" : " modification en attente");
  el.textContent = st.offline
    ? "Hors ligne" + (st.pending ? " · " + waiting : " · données enregistrées sur le téléphone")
    : "Synchronisation… " + waiting;
  el.title = st.pending
    ? "Modifications enregistrées sur le téléphone, envoyées dès le retour du réseau."
    : "Données affichées : dernière copie enregistrée sur le téléphone.";
}
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2200);
}
// Attente d’une réponse de l’IA (WOD, repas) : étoiles qui scintillent et message, puis coche brève à l’arrivée
// du résultat, avant de l’afficher. L’élément est un <p class="ai-wait">, masqué par l’appelant à la fin.
const AI_WAIT_ICON =
  '<svg class="ai-wait-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="spark" d="M10 2.5c.5 3.9 2.1 5.5 6 6-3.9.5-5.5 2.1-6 6-.5-3.9-2.1-5.5-6-6 3.9-.5 5.5-2.1 6-6z"/><path class="spark" d="M18.5 13c.3 2 1.1 2.7 3 3-1.9.3-2.7 1-3 3-.3-2-1.1-2.7-3-3 1.9-.3 2.7-1 3-3z"/><path class="spark" d="M5 16.5c.2 1.3.7 1.8 2 2-1.3.2-1.8.7-2 2-.2-1.3-.7-1.8-2-2 1.3-.2 1.8-.7 2-2z"/><path class="check" d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
function aiWaitStart(el, text) {
  if (!el.querySelector(".ai-wait-text")) el.innerHTML = AI_WAIT_ICON + '<span class="ai-wait-text"></span>';
  el.classList.remove("done");
  el.querySelector(".ai-wait-text").textContent = text;
  el.hidden = false;
}
function aiWaitDone(el, text) {
  el.classList.add("done");
  el.querySelector(".ai-wait-text").textContent = text;
  return new Promise(r => setTimeout(r, 700));
}
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]
  );
}
// Détail d’un WOD par rubrique (échauffement, travail technique, force, metcon, finisher…), comme le planning des
// gestionnaires ; texte brut quand le WOD n’a pas de blocs. parts : [{label, text}].
function fillWodBody(el, parts, fallback) {
  const list = (parts || []).filter(x => String(x.text || "").trim());
  el.classList.toggle("wod-detail-blocks", list.length > 0);
  if (list.length)
    el.innerHTML = list
      .map(x => `<span class="box-planning-part">${x.label ? `<em>${esc(x.label)}</em>` : ""}${esc(x.text)}</span>`)
      .join("");
  else el.textContent = fallback;
}
function showAuth() {
  applyTheme();
  $("#dashboard").hidden = true;
  $("#auth").hidden = false;
  $("#userbar").innerHTML = "";
  focusAuthField();
}
// Écran de connexion : curseur dans le premier champ vide du formulaire affiché (l’e-mail, ou le mot de passe si
// l’e-mail est déjà rempli).
function focusAuthField() {
  const form = [...document.querySelectorAll("#auth form")].find(f => !f.hidden);
  const fields = form ? [...form.querySelectorAll("input:not([type=hidden])")] : [];
  (fields.find(i => !i.value) || fields[0])?.focus({preventScroll: true});
}
// Initiales de la pastille du compte : prénom + nom, sinon la première lettre de l’e-mail.
function userInitials() {
  const initial = s => (String(s || "").trim()[0] || "").toUpperCase();
  return initial(user?.first_name) + initial(user?.last_name) || initial(user?.email) || "?";
}
// Icônes des espaces athlète et gestionnaire (barre du haut, et rôles dans « Mon compte → Mes box »).
const ATHLETE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18M5 3v4M19 3v4"/><circle cx="12" cy="9.3" r="1.7"/><path d="M8 5.2l1.8 6.3h4.4L16 5.2M12 11.5v4.5M12 16l-3 5M12 16l3 5"/></svg>';
const MANAGER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20.5h18M5 20.5V9.5l7-5 7 5v11"/><path d="M9.5 20.5v-5h5v5"/></svg>';
// Barre du haut : espaces athlète / gestionnaire / administration, pastille du compte (initiales, sans le nom).
function renderUserbar() {
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email || "";
  // Espace athlète (séances) : raccourci affiché seulement pour les gestionnaires et administrateurs, qui ont
  // d’autres espaces ; mis en évidence dans l’espace d’utilisateur (séances, programmes, PR, chrono).
  const athleteActive = !inManagerSpace() && !inAdminSpace() && $("#view-account").hidden,
    athleteShortcut =
      boxIds("manager").length || isAdmin
        ? `<button class="settings-icon ${athleteActive ? "active" : ""}" id="athleteshortcut" aria-pressed="${athleteActive}" aria-label="Mon espace athlète (séances)" title="Mon espace athlète">${ATHLETE_ICON}</button>`
        : "";
  $("#userbar").innerHTML =
    `${athleteShortcut}${boxIds("manager").length ? `<button class="settings-icon ${inManagerSpace() ? "active" : boxPending.members ? "alert" : ""}" id="boxshortcut" aria-pressed="${inManagerSpace()}" aria-label="${inManagerSpace() ? "Revenir à mon espace" : "Espace gestionnaire de box"}" title="${inManagerSpace() ? "Revenir à mon espace" : "Espace gestionnaire de box"}">${MANAGER_ICON}</button>` : ""}${isAdmin ? `<button class="settings-icon ${inAdminSpace() ? "active" : boxPending.managers || boxPending.coaches ? "alert" : ""}" id="adminshortcut" aria-pressed="${inAdminSpace()}" aria-label="${inAdminSpace() ? "Revenir à mon espace" : "Administration"}" title="${inAdminSpace() ? "Revenir à mon espace" : "Administration"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z"/></svg></button>` : ""}<button class="account-avatar ${$("#view-account").hidden ? "" : "active"}" id="accountshortcut" aria-label="Mon compte (${esc(fullName)})" title="Mon compte">${esc(userInitials())}</button>`;
  $("#accountshortcut").onclick = () => switchView("account");
  // Gestionnaire : bascule entre l’espace gestionnaire (menu du bas dédié) et son espace d’utilisateur.
  const athleteButton = $("#athleteshortcut");
  if (athleteButton) athleteButton.onclick = () => switchView("sessions");
  const boxShortcut = $("#boxshortcut");
  if (boxShortcut) boxShortcut.onclick = () => switchView(inManagerSpace() ? "sessions" : "box");
  const adminShortcut = $("#adminshortcut");
  if (adminShortcut) adminShortcut.onclick = () => switchView(inAdminSpace() ? "sessions" : "admin");
  // Déconnexion : bouton en bas de la page Mon compte.
  $("#logout").onclick = async () => {
    const pending = FFOffline.state().pending;
    if (
      pending &&
      !confirm(pending + " modification(s) pas encore synchronisée(s) seront perdues. Se déconnecter quand même ?")
    )
      return;
    try {
      const d = await api("/logout", {method: "POST"});
      cacheDefaultTheme(d.default_theme);
    } catch (e) {
      toast(e.message);
      return;
    }
    FFOffline.clear();
    user = null;
    showAuth();
  };
}
function showApp() {
  $("#auth").hidden = true;
  applyTheme(themePreference());
  $("#dashboard").hidden = false;
  // Première page pour tous (utilisateur, gestionnaire ou administrateur) : les séances.
  switchView("sessions");
  renderUserbar();
  load();
}
document.querySelectorAll(".tab").forEach(
  b =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === b));
      $("#authsubmit").textContent = tab === "login" ? "Se connecter" : "Créer mon compte";
      $("#forgotlink").hidden = tab !== "login";
      $("#authhint").textContent =
        tab === "login" ? "Connecte-toi pour retrouver tes programmes." : "Mot de passe de 12 caractères minimum.";
      focusAuthField();
    })
);
// Écran de connexion : panneau « connexion / création », « mot de passe oublié » ou « nouveau mot de passe ».
function showAuthPanel(panel) {
  $("#auth .tabs").hidden = panel !== "login";
  $("#authform").hidden = panel !== "login";
  $("#forgotform").hidden = panel !== "forgot";
  $("#resetform").hidden = panel !== "reset";
  $("#forgotlink").hidden = tab !== "login";
  focusAuthField();
}
$("#forgotlink").onclick = () => {
  $("#forgotform").elements.email.value = $("#authform").elements.email.value;
  $("#forgotmessage").textContent = "";
  showAuthPanel("forgot");
};
document.querySelectorAll("[data-auth-back]").forEach(b => (b.onclick = () => showAuthPanel("login")));
$("#forgotform").onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector("button.primary");
  button.disabled = true;
  try {
    await sendApi("/password/forgot", "POST", {email: e.target.elements.email.value});
    $("#forgotmessage").textContent =
      "Si un compte existe pour cette adresse, un lien de réinitialisation (valable 30 minutes) vient d’être envoyé.";
  } catch (x) {
    $("#forgotmessage").textContent = x.message;
  } finally {
    button.disabled = false;
  }
};
let resetToken = "";
$("#resetform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements;
  $("#reseterror").textContent = "";
  if (f.password.value !== f.confirm.value) {
    $("#reseterror").textContent = "Les deux mots de passe ne sont pas identiques.";
    return;
  }
  try {
    const d = await sendApi("/password/reset", "POST", {token: resetToken, password: f.password.value});
    user = d.user;
    isAdmin = !!d.is_admin;
    FFOffline.setOwner(user.id);
    showAuthPanel("login");
    showApp();
    toast("Mot de passe modifié.");
  } catch (x) {
    $("#reseterror").textContent = x.message;
  }
};
$("#authform").onsubmit = async e => {
  e.preventDefault();
  $("#autherror").textContent = "";
  const f = new FormData(e.target);
  try {
    const d = await api(tab === "login" ? "/login" : "/register", {
      method: "POST",
      body: JSON.stringify({email: f.get("email"), password: f.get("password")}),
    });
    user = d.user;
    isAdmin = !!d.is_admin;
    FFOffline.setOwner(user.id);
    showApp();
  } catch (x) {
    $("#autherror").textContent = x.message;
  }
};

// Liste des types de WOD dans un menu ; non précisé, celui par défaut (le premier de la liste).
function fillWodTypeSelect(select, selected = "") {
  select.innerHTML = wodTypes.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  select.value = wodTypes.some(t => t.id === selected) ? selected : wodTypes[0]?.id || "";
}
