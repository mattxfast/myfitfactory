// myFitFactory — programmes de coach : rôle coach (Mon compte), programmes proposés (rubrique en tête de l’onglet
// Programmes, pastille rouge), proposition d’un programme de coach à des inscrits.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

const weeksLabel = n => n + " semaine" + (n > 1 ? "s" : "");

// Programmes proposés : ✓ pour le suivre (sans dates : choix du lundi de départ), × pour refuser.
function renderCoachInvites() {
  $('.navtab[data-view="programs"]').classList.toggle("has-alert", coachInvites.length > 0);
  if (preferences) applyInterface();
  $("#coachinvites").innerHTML = coachInvites.length
    ? `<section class="session-fold session-invites"><div class="weekheading"><h2>Programmes proposés</h2><span>${coachInvites.length}</span></div><div class="session-fold-body"><div class="weekwodlist">${coachInvites
        .map(
          x =>
            `<article class="weekwod card"><div class="weekcount"><button type="button" class="smallbtn" data-coach-accept="${esc(x.id)}" aria-label="Suivre ce programme" title="Suivre ce programme"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg></button><button type="button" class="smallbtn delete" data-coach-decline="${esc(x.id)}" aria-label="Refuser" title="Refuser"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div><div class="weekwod-text"><b>${esc(partnerName(x))} te propose « ${esc(x.name)} »</b><p class="wod-preview">${esc(
              [
                weeksLabel(x.coach_weeks),
                x.start_monday ? fmt(x.start_monday) + " → " + fmt(x.end_monday) : "date de début au choix",
                x.wods + " WOD",
              ].join(" · ")
            )}</p></div></article>`
        )
        .join("")}</div></div></section>`
    : "";
  $("#coachinvites")
    .querySelectorAll("[data-coach-accept]")
    .forEach(
      b =>
        (b.onclick = () => {
          const x = coachInvites.find(i => i.id === b.dataset.coachAccept),
            current = programs.find(p => p.followed),
            replace = current ? " Il remplacera « " + current.name + " », le programme que tu suis." : "";
          if (!x.start_monday) return openCoachStartDialog(x, x.id);
          if (
            confirm("Suivre « " + x.name + " » du " + fmt(x.start_monday) + " au " + fmt(x.end_monday) + " ?" + replace)
          )
            acceptCoachInvite(x.id);
        })
    );
  $("#coachinvites")
    .querySelectorAll("[data-coach-decline]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (!confirm("Refuser ce programme ?")) return;
          try {
            await sendApi("/coach-invites/" + b.dataset.coachDecline + "/decline", "POST");
            coachInvites = coachInvites.filter(i => i.id !== b.dataset.coachDecline);
            renderCoachInvites();
            toast("Programme refusé.");
          } catch (x) {
            toast(x.offline ? OFFLINE_MESSAGE : x.message);
          }
        })
    );
}
// Date de début d’un programme de coach sans dates : à l’acceptation (inviteId) ou ensuite (« Modifier mes dates »).
// Le programme dure toujours le nombre de semaines fixé par le coach ; la semaine 1 commence le lundi choisi.
function openCoachStartDialog(p, inviteId, currentStart = null) {
  const form = $("#followform"),
    f = form.elements,
    coach = partnerName({
      first_name: p.first_name ?? p.author_first_name,
      last_name: p.last_name ?? p.author_last_name,
    });
  form.reset();
  form.dataset.editing = currentStart ? "1" : "";
  form.dataset.invite = inviteId || "";
  form.dataset.weeks = p.coach_weeks;
  f.program_id.value = p.program_id || p.id;
  $("#followendfield").hidden = true;
  f.end.required = false;
  f.start.value = currentStart || mondayOf(today());
  f.start.onchange = f.end.onchange = null;
  $("#followtitle").textContent = p.name;
  $("#followinfo").textContent =
    "Programme de coach" +
    (coach ? " de " + coach : "") +
    " : " +
    weeksLabel(p.coach_weeks) +
    ". Choisis ta date de début" +
    (inviteId ? " (à partir de cette semaine)" : "") +
    ".";
  $("#followsubmit").textContent = inviteId ? "Suivre ce programme" : "Enregistrer mes dates";
  $("#followerror").textContent = "";
  $("#followdialog").showModal();
}
async function acceptCoachInvite(id, start = null) {
  try {
    await sendApi("/coach-invites/" + id + "/accept", "POST", start ? {start: mondayOf(start)} : {});
    if ($("#followdialog").open) $("#followdialog").close();
    // Interface simplifiée : les WOD du programme ne seraient pas affichés dans la page Séances.
    if (simpleInterface()) {
      preferences.interface = "advanced";
      $("#interfaceselect").value = "advanced";
      await api("/preferences", {method: "PUT", body: JSON.stringify({interface: "advanced"})}).catch(() => {});
    }
    await load();
    switchView("programs");
    toast("Programme suivi : ses WOD sont dans la page Séances.");
  } catch (x) {
    const message = x.offline ? OFFLINE_MESSAGE : x.message;
    if ($("#followdialog").open) $("#followerror").textContent = message;
    else toast(message);
  }
}
// Proposer un programme de coach : personnes déjà taguées (avec leur réponse) et nouvelles personnes à taguer.
let coachInviteSelected = [],
  coachInviteTaken = new Set(),
  coachInviteTimer = null;
const COACH_INVITE_STATUS = {pending: "en attente", accepted: "a accepté", declined: "a refusé"};
function openCoachInvite(pid) {
  const p = programs.find(x => x.id === pid);
  if (!p) return;
  $("#coachinviteform").reset();
  $("#coachinviteform").elements.program_id.value = pid;
  coachInviteSelected = [];
  coachInviteTaken = new Set();
  $("#coachinvitetitle").textContent = p.name;
  $("#coachinviteerror").textContent = "";
  $("#coachinviteresults").innerHTML = "";
  renderCoachInviteChips();
  $("#coachinvitedialog").showModal();
  loadCoachInviteList(pid);
}
async function loadCoachInviteList(pid) {
  const list = $("#coachinvitelist");
  list.innerHTML = `<p class="muted">Chargement…</p>`;
  try {
    const d = await sendApi("/coach-programs/" + pid + "/invites", "GET");
    coachInviteTaken = new Set(d.invites.filter(x => x.status !== "declined").map(x => x.user_id));
    list.innerHTML =
      d.invites
        .map(
          x =>
            `<span class="tracked-tag partner-chip">${esc(partnerName(x))} · ${x.status === "accepted" && !x.following ? "ne le suit plus" : COACH_INVITE_STATUS[x.status] || ""}${x.status === "pending" ? `<button type="button" data-coach-invite-remove="${esc(x.id)}" aria-label="Retirer l’invitation de ${esc(partnerName(x))}" title="Retirer">×</button>` : ""}</span>`
        )
        .join("") || `<p class="muted">Personne pour l’instant.</p>`;
    list.querySelectorAll("[data-coach-invite-remove]").forEach(
      b =>
        (b.onclick = async () => {
          try {
            await sendApi("/coach-invites/" + b.dataset.coachInviteRemove, "DELETE");
            loadCoachInviteList(pid);
          } catch (x) {
            $("#coachinviteerror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
          }
        })
    );
  } catch (x) {
    list.innerHTML = `<p class="muted">${esc(x.offline ? OFFLINE_MESSAGE : x.message)}</p>`;
  }
}
function renderCoachInviteChips() {
  $("#coachinvitechips").innerHTML = coachInviteSelected
    .map(
      p =>
        `<span class="tracked-tag partner-chip">${esc(p.name)}<button type="button" data-coach-invite-unselect="${esc(p.id)}" aria-label="Retirer ${esc(p.name)}" title="Retirer">×</button></span>`
    )
    .join("");
  $("#coachinvitechips")
    .querySelectorAll("[data-coach-invite-unselect]")
    .forEach(
      b =>
        (b.onclick = () => {
          coachInviteSelected = coachInviteSelected.filter(p => p.id !== b.dataset.coachInviteUnselect);
          renderCoachInviteChips();
        })
    );
}
$("#coachinvitesearch").onkeydown = e => {
  if (e.key === "Enter") e.preventDefault(); // pas d’envoi des invitations depuis la recherche
};
$("#coachinvitesearch").oninput = e => {
  clearTimeout(coachInviteTimer);
  const q = e.target.value.trim(),
    results = $("#coachinviteresults");
  if (q.length < 2) {
    results.innerHTML = "";
    return;
  }
  coachInviteTimer = setTimeout(async () => {
    try {
      const d = await sendApi("/users/search?q=" + encodeURIComponent(q), "GET");
      if ($("#coachinvitesearch").value.trim() !== q) return;
      const list = d.users.filter(x => !coachInviteTaken.has(x.id) && !coachInviteSelected.some(p => p.id === x.id));
      results.innerHTML =
        list
          .map(
            x =>
              `<button type="button" class="smallbtn partner-result" data-coach-invite-add="${esc(x.id)}">＋ ${esc(partnerName(x))}</button>`
          )
          .join("") || `<p class="muted">Aucune autre personne trouvée.</p>`;
      results.querySelectorAll("[data-coach-invite-add]").forEach(
        b =>
          (b.onclick = () => {
            if (coachInviteSelected.length >= 20) return toast("20 personnes au plus à la fois.");
            const x = list.find(y => y.id === b.dataset.coachInviteAdd);
            coachInviteSelected.push({id: x.id, name: partnerName(x)});
            $("#coachinvitesearch").value = "";
            results.innerHTML = "";
            renderCoachInviteChips();
          })
      );
    } catch (x) {
      results.innerHTML = `<p class="muted">${esc(x.offline ? OFFLINE_MESSAGE : x.message)}</p>`;
    }
  }, 250);
};
$("#coachinviteform").onsubmit = async e => {
  e.preventDefault();
  const pid = e.target.elements.program_id.value;
  if (!coachInviteSelected.length) {
    $("#coachinviteerror").textContent = "Tague au moins une personne.";
    return;
  }
  try {
    const d = await sendApi("/coach-programs/" + pid + "/invites", "POST", {
      user_ids: coachInviteSelected.map(p => p.id),
    });
    $("#coachinvitedialog").close();
    await load();
    toast("Programme proposé à " + d.invited + " personne" + (d.invited > 1 ? "s" : "") + ".");
  } catch (x) {
    $("#coachinviteerror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
  }
};
// Mon compte → Coach : demande du rôle (validée par un administrateur), annulation, abandon du rôle.
function renderCoachCard() {
  const status = preferences?.coach;
  $("#coachstatus").hidden = !status;
  $("#coachstatus").textContent =
    status === "approved"
      ? "Tu es coach : crée un programme de coach avec « ＋ Nouveau programme » dans l’onglet Programmes."
      : status === "pending"
        ? "Demande envoyée : un administrateur doit la valider."
        : "";
  $("#coachrequest").textContent =
    status === "approved" ? "Quitter le rôle de coach" : status === "pending" ? "Annuler la demande" : "Devenir coach";
}
$("#coachrequest").onclick = async () => {
  const status = preferences?.coach;
  if (status === "approved" && !confirm("Quitter le rôle de coach ? Tes programmes déjà proposés restent suivis."))
    return;
  $("#coacherror").textContent = "";
  try {
    await sendApi("/coach-request", "PUT", {request: !status});
    preferences.coach = status ? null : "pending";
    renderCoachCard();
    toast(status ? (status === "pending" ? "Demande annulée." : "Tu n’es plus coach.") : "Demande envoyée.");
  } catch (x) {
    $("#coacherror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
  }
};
