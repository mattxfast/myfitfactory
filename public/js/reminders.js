// FitFactory — rappels par notification (réglages du compte, abonnement de l’appareil).
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

// Les réglages (activés, jours sans séance, heure) appartiennent au compte : ils sont les mêmes sur tous les appareils
// et modifiables hors ligne. Chaque appareil où les notifications sont autorisées est abonné pour recevoir les rappels.
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const urlKey = k => {
  const s = k.replace(/-/g, "+").replace(/_/g, "/"),
    b = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
function reminderChips(id, values, current, label) {
  $(id).innerHTML = values
    .map(
      v =>
        `<label><input type="radio" name="${id.slice(1)}" value="${v}" ${v === current ? "checked" : ""}><span>${label(v)}</span></label>`
    )
    .join("");
  $(id)
    .querySelectorAll("input")
    .forEach(
      i =>
        (i.onchange = () =>
          saveReminders({days: reminderChoice("#reminderdays"), hour: reminderChoice("#reminderhours")}))
    );
}
const reminderChoice = id => Number($(id).querySelector("input:checked")?.value);
async function saveReminders(values) {
  $("#reminderstatus").textContent = "";
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({reminders: values})});
    Object.assign(preferences.reminders, values);
    toast("Rappels enregistrés pour ton compte.");
    return true;
  } catch (e) {
    $("#reminderstatus").textContent = e.message;
    return false;
  }
}
// État de cet appareil : notifications non prises en charge, bloquées, à autoriser, ou abonnement actif.
async function deviceSubscription() {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}
async function subscribeDevice(askPermission) {
  if (!pushSupported()) return false;
  if (Notification.permission !== "granted") {
    if (!askPermission || (await Notification.requestPermission()) !== "granted") return false;
  }
  const reg = await navigator.serviceWorker.ready,
    config = await sendApi("/push/config", "GET");
  let sub = await reg.pushManager.getSubscription();
  if (!sub)
    sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: urlKey(config.publicKey)});
  await sendApi("/push/subscribe", "POST", sub.toJSON());
  return true;
}
async function renderReminderDevice() {
  const hint = $("#reminderhint"),
    allow = $("#reminderallow"),
    enabled = !!preferences?.reminders.enabled;
  allow.hidden = true;
  hint.hidden = !enabled;
  if (!enabled) return;
  if (!pushSupported()) {
    hint.textContent = isIos()
      ? "Sur iPhone, ajoute d’abord myFitFactory à l’écran d’accueil (iOS 16.4 minimum), puis ouvre l’app depuis son icône pour recevoir les rappels sur cet appareil."
      : "Ce navigateur ne permet pas les notifications : les rappels arriveront sur tes autres appareils.";
    return;
  }
  if (Notification.permission === "denied") {
    hint.textContent =
      "Les notifications sont bloquées sur cet appareil : autorise-les dans ses réglages (Notifications → myFitFactory).";
    return;
  }
  if (Notification.permission !== "granted") {
    hint.textContent = "Cet appareil ne reçoit pas encore les rappels.";
    allow.hidden = false;
    return;
  }
  // Autorisation déjà donnée : l’appareil est abonné automatiquement (rappels activés depuis un autre appareil).
  try {
    if (!(await deviceSubscription())) await subscribeDevice(false);
    hint.textContent = "Cet appareil reçoit les rappels.";
  } catch {
    hint.textContent = "Cet appareil sera abonné aux rappels au retour du réseau.";
  }
}
function renderReminders() {
  if (!preferences) return;
  const r = preferences.reminders;
  $("#reminderenabled").checked = !!r.enabled;
  $("#reminderoptions").hidden = !r.enabled;
  reminderChips("#reminderdays", preferences.choices.days, r.days, v => v + " jours");
  reminderChips("#reminderhours", preferences.choices.hours, r.hour, v => v + " h");
  renderReminderDevice();
}
$("#reminderenabled").onchange = async e => {
  const enabled = e.target.checked;
  if (!(await saveReminders({enabled: enabled ? 1 : 0}))) {
    e.target.checked = !enabled;
    return;
  }
  $("#reminderoptions").hidden = !enabled;
  if (enabled)
    try {
      await subscribeDevice(true);
    } catch {}
  renderReminderDevice();
};
$("#reminderallow").onclick = async () => {
  try {
    if (!(await subscribeDevice(true)))
      $("#reminderstatus").textContent = "Notifications refusées : autorise-les dans les réglages de l’appareil.";
  } catch (e) {
    $("#reminderstatus").textContent = e.offline ? "Il faut du réseau pour abonner cet appareil." : e.message;
  }
  renderReminderDevice();
};
$("#remindertest").onclick = async () => {
  try {
    const r = await sendApi("/push/test", "POST", {});
    $("#reminderstatus").textContent = r.sent
      ? "Notification envoyée."
      : "Aucun appareil n’a pu être joint : autorise les notifications sur cet appareil.";
  } catch (e) {
    $("#reminderstatus").textContent = e.message;
  }
};
