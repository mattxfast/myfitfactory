// FitFactory — administration : utilisateurs, catalogue de mouvements, activités.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

// Espace d’administration : une page à la fois (utilisateurs ; box, gestionnaires et mouvements ; autres paramétrages).
let adminPage = "users";
function showAdminPage() {
  document
    .querySelectorAll("#view-admin [data-admin-page]")
    .forEach(g => (g.hidden = g.dataset.adminPage !== adminPage));
  document
    .querySelectorAll("#adminnav [data-admin-page]")
    .forEach(b => b.classList.toggle("active", b.dataset.adminPage === adminPage));
}
document.querySelectorAll("#adminnav [data-admin-page]").forEach(
  b =>
    (b.onclick = () => {
      adminPage = b.dataset.adminPage;
      showAdminPage();
      scrollTo(0, 0);
    })
);
async function loadAdmin() {
  if (!isAdmin) return;
  const [a, u, m, b, st] = await Promise.all([
    api("/admin/activities"),
    api("/admin/users"),
    api("/admin/movements"),
    api("/admin/boxes"),
    api("/admin/settings"),
  ]);
  activities = a.activities;
  renderAdminDefaults(st);
  renderAdmin(u.users, m.movements);
  renderAdminBoxes(b.boxes, b.managers);
}
// Réglages par défaut des comptes : thème et rappels (chaque utilisateur peut ensuite faire son propre choix).
function renderAdminDefaults(st) {
  const f = $("#defaultsform").elements;
  f.theme.innerHTML = st.choices.themes.map(t => `<option value="${t}">${esc(THEME_NAMES[t] || t)}</option>`).join("");
  f.theme.value = st.theme;
  f.reminder_days.innerHTML = st.choices.days.map(d => `<option value="${d}">${d} jours sans séance</option>`).join("");
  f.reminder_days.value = st.reminder_days;
  f.reminder_hour.innerHTML = st.choices.hours.map(h => `<option value="${h}">${h} h</option>`).join("");
  f.reminder_hour.value = st.reminder_hour;
  f.reminders_enabled.checked = !!st.reminders_enabled;
}
$("#defaultsform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api("/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        theme: f.theme.value,
        reminder_days: Number(f.reminder_days.value),
        reminder_hour: Number(f.reminder_hour.value),
        reminders_enabled: f.reminders_enabled.checked,
      }),
    });
    setPreferences(await api("/preferences"));
    toast("Réglages par défaut enregistrés.");
  } catch (x) {
    toast(x.message);
  }
};
// Box : création, modification, suppression ; gestionnaires (demandes à valider, retrait).
function renderAdminBoxes(list, managers) {
  const person = x =>
    esc([x.first_name, x.last_name].filter(Boolean).join(" ") || x.email) +
    ` <small class="muted">${esc(x.email)}</small>`;
  $("#adminboxlist").innerHTML =
    list
      .map(
        b =>
          `<div class="admin-row"><span>${esc(b.name)}${b.city ? ` <small class="muted">· ${esc(b.city)}</small>` : ""} <small class="muted">· ${b.members} membre${b.members > 1 ? "s" : ""}</small></span><span class="admin-row-actions"><button class="smallbtn" data-edit-box="${b.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-box="${b.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></span></div>`
      )
      .join("") || `<p class="muted">Aucune box. Touche ＋ pour en créer une.</p>`;
  const sorted = [...managers].sort((x, y) => (x.status === y.status ? 0 : x.status === "pending" ? -1 : 1));
  $("#managerrequestlist").innerHTML =
    sorted
      .map(
        x =>
          `<div class="admin-row"><span>${person(x)} <small class="muted">· ${esc(list.find(b => b.id === x.box_id)?.name || "")} · ${x.status === "pending" ? "demande en attente" : "gestionnaire"}</small></span><span class="admin-row-actions">${x.status === "pending" ? `<button class="smallbtn" data-manager-decision="1" data-box="${x.box_id}" data-user="${x.user_id}" aria-label="Valider" title="Valider"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>` : ""}<button class="smallbtn delete" data-manager-decision="0" data-box="${x.box_id}" data-user="${x.user_id}" aria-label="${x.status === "pending" ? "Refuser" : "Retirer"}" title="${x.status === "pending" ? "Refuser" : "Retirer le rôle de gestionnaire"}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></span></div>`
      )
      .join("") || `<p class="muted">Aucun gestionnaire ni demande en attente.</p>`;
  $("#adminboxlist")
    .querySelectorAll("[data-edit-box]")
    .forEach(b => (b.onclick = () => openBoxDialog(list.find(x => x.id === b.dataset.editBox))));
  $("#adminboxlist")
    .querySelectorAll("[data-del-box]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const box = list.find(x => x.id === b.dataset.delBox);
          if (!confirm("Supprimer la box « " + box.name + " » ? Ses adhésions et ses catégories seront supprimées."))
            return;
          try {
            await api("/admin/boxes/" + box.id, {method: "DELETE"});
            await loadAdmin();
            await loadBoxes();
            toast("Box supprimée.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#managerrequestlist")
    .querySelectorAll("[data-manager-decision]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const approve = b.dataset.managerDecision === "1";
          if (!approve && !confirm("Refuser la demande ou retirer ce gestionnaire ?")) return;
          try {
            await api("/admin/boxes/" + b.dataset.box + "/managers/" + b.dataset.user, {
              method: "PUT",
              body: JSON.stringify({approve}),
            });
            await loadAdmin();
            await loadBoxes();
            toast(approve ? "Gestionnaire validé." : "Demande refusée ou rôle retiré.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
}
function openBoxDialog(box = null) {
  const f = $("#boxform");
  f.reset();
  f.elements.id.value = box?.id || "";
  f.elements.name.value = box?.name || "";
  f.elements.city.value = box?.city || "";
  $("#boxdialogtitle").textContent = box ? "Modifier la box" : "Ajouter une box";
  $("#boxformerror").textContent = "";
  $("#boxdialog").showModal();
}
$("#addbox").onclick = () => openBoxDialog();
$("#boxform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    id = f.id.value;
  try {
    await api(id ? "/admin/boxes/" + id : "/admin/boxes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({name: f.name.value, city: f.city.value}),
    });
    $("#boxdialog").close();
    await loadAdmin();
    await loadBoxes();
    toast(id ? "Box modifiée." : "Box créée.");
  } catch (x) {
    $("#boxformerror").textContent = x.message;
  }
};
document.querySelectorAll("[data-admin-add]").forEach(
  b =>
    (b.onclick = () => {
      const form = $("#" + b.dataset.adminAdd),
        dialog = $(b.dataset.adminAdd === "movementcatalogform" ? "#movementcatalogdialog" : "#activitydialog");
      form.reset();
      delete form.dataset.editId;
      if (form.elements.id) form.elements.id.value = "";
      if (b.dataset.adminAdd === "movementcatalogform")
        $("#movementcatalogdialogtitle").textContent = "Ajouter un mouvement";
      if (b.dataset.adminAdd === "activityform") $("#activitydialogtitle").textContent = "Ajouter une activité";
      if (b.dataset.adminAdd === "movementcatalogform") $("#movementcatalogerror").textContent = "";
      dialog.showModal();
      dialog.querySelector("input:not([type=hidden])")?.focus();
    })
);
document
  .querySelectorAll("[data-close-dialog]")
  .forEach(b => (b.onclick = () => $("#" + b.dataset.closeDialog).close()));
// Rubriques repliables de l’administration et de « Mon compte ».
document.querySelectorAll("#view-admin .admin-group-title, #view-account .admin-group-title").forEach(h => {
  const toggle = () => {
    const group = h.closest(".admin-group");
    group.classList.toggle("collapsed");
    h.setAttribute("aria-expanded", String(!group.classList.contains("collapsed")));
    const mark = h.querySelector(".admin-collapse-indicator");
    if (mark) mark.textContent = group.classList.contains("collapsed") ? "＋" : "−";
  };
  h.addEventListener("click", e => {
    if (e.target.closest(".admin-add,.reorder-toggle")) return;
    toggle();
  });
  h.addEventListener("keydown", e => {
    if (e.target !== h) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
});
function renderAdmin(users, movements = []) {
  renderAdmin.last = [users, movements];
  const reorderCatalog = !!window.cfCatalogReorder,
    catalogToggle = $("#toggle-catalog-reorder");
  catalogToggle.hidden = movements.length < 2;
  catalogToggle.classList.toggle("active", reorderCatalog);
  catalogToggle.setAttribute("aria-pressed", String(reorderCatalog));
  $("#movementcataloglist").innerHTML =
    movements
      .map(
        (m, i) =>
          `<div class="admin-row"><span>${esc(m.name)} <small class="muted">· ${m.measurement_method === "force" ? "Force" : m.measurement_method === "reps" ? "Gym" : m.measurement_method === "distance" ? "Engine" : "Lift"}</small></span><span class="admin-row-actions">${reorderCatalog ? `<button class="smallbtn admin-reorder" data-move-admin="movement" data-id="${m.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg></button><button class="smallbtn admin-reorder" data-move-admin="movement" data-id="${m.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === movements.length - 1 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg></button>` : ""}<button class="smallbtn" data-edit-catalog-movement="${m.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-catalog-movement="${m.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></span></div>`
      )
      .join("") || `<p class="muted">Aucun mouvement dans le catalogue.</p>`;
  $("#view-admin")
    .querySelectorAll("[data-move-admin]")
    .forEach(
      b =>
        (b.onclick = async () => {
          try {
            await api("/admin/" + (b.dataset.moveAdmin === "movement" ? "movements" : "activities") + "/order", {
              method: "PUT",
              body: JSON.stringify({id: b.dataset.id, direction: Number(b.dataset.direction)}),
            });
            await loadAdmin();
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#movementcataloglist")
    .querySelectorAll("[data-edit-catalog-movement]")
    .forEach(
      b =>
        (b.onclick = () => {
          const m = movements.find(x => x.id === b.dataset.editCatalogMovement),
            f = $("#movementcatalogform");
          f.elements.name.value = m.name;
          f.elements.measurement_method.value = m.measurement_method || "load";
          f.dataset.editId = m.id;
          $("#movementcatalogdialogtitle").textContent = "Modifier un mouvement";
          $("#movementcatalogdialog").showModal();
        })
    );
  $("#movementcataloglist")
    .querySelectorAll("[data-del-catalog-movement]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (confirm("Supprimer ce mouvement du catalogue ? Les programmes qui l’utilisent le conserveront.")) {
            await api("/admin/movements/" + b.dataset.delCatalogMovement, {method: "DELETE"});
            const d = await api("/movement-catalog");
            movementCatalog = d.movements;
            await loadAdmin();
          }
        })
    );
  $("#activitylist").innerHTML =
    activities
      .map(
        (a, i) =>
          `<div class="admin-row"><span>${esc(a.name)} · ${a.duration_minutes} min ${a.is_default ? "(par défaut)" : ""} ${a.is_active ? "" : "· inactive"}</span><span class="admin-row-actions"><button class="smallbtn admin-reorder" data-move-admin="activity" data-id="${a.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg></button><button class="smallbtn admin-reorder" data-move-admin="activity" data-id="${a.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === activities.length - 1 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg></button><button class="smallbtn" data-edit-activity="${a.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-activity="${a.id}" aria-label="Désactiver ou supprimer" title="Désactiver si utilisée, supprimer sinon"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button><button class="smallbtn" data-default-activity="${a.id}" aria-label="Définir par défaut" title="Définir par défaut" ${a.is_default ? "disabled" : ""}>★</button></span></div>`
      )
      .join("") || `<p class="muted">Aucune activité.</p>`;
  // Demandes de rôle coach à valider en tête de liste.
  $("#userlist").innerHTML =
    [...users]
      .sort((a, b) => (b.coach_status === "pending") - (a.coach_status === "pending"))
      .map(
        u =>
          `<div class="admin-row"><span>${esc([u.first_name, u.last_name].filter(Boolean).join(" ") || u.email)}${u.first_name || u.last_name ? ` <small class="muted">${esc(u.email)}</small>` : ""} <small class="muted">· ${u.is_owner ? "admin principal" : u.is_admin ? "admin" : "utilisateur"}${u.coach_status === "approved" ? " · coach" : u.coach_status === "pending" ? " · demande de coach à valider" : ""}${u.is_active ? "" : " · inactif"}</small></span><span class="admin-row-actions"><button class="smallbtn reorder-toggle ${u.coach_status === "approved" ? "active" : ""}" data-coach-user="${u.id}" aria-pressed="${u.coach_status === "approved"}" aria-label="${u.coach_status === "approved" ? "Retirer le rôle de coach" : u.coach_status === "pending" ? "Valider ou refuser la demande de coach" : "Nommer coach"}" title="${u.coach_status === "approved" ? "Retirer le rôle de coach" : u.coach_status === "pending" ? "Valider ou refuser la demande de coach" : "Nommer coach"}" ${u.is_active ? "" : "disabled"}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6v3H9z"/><path d="M9 5H6v16h12V5h-3"/><path d="M9 12h6"/><path d="M9 16h4"/></svg></button><button class="smallbtn reorder-toggle ${u.is_admin || u.is_owner ? "active" : ""}" data-admin-user="${u.id}" aria-pressed="${!!(u.is_admin || u.is_owner)}" aria-label="${u.is_admin ? "Retirer les droits d’administration" : "Nommer administrateur"}" title="${u.is_owner ? "Administrateur principal (ADMIN_EMAIL)" : u.is_admin ? "Retirer les droits d’administration" : "Nommer administrateur"}" ${u.is_owner || u.id === user.id || !u.is_active ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z"/></svg></button><button class="smallbtn" data-reset-user="${u.id}" aria-label="Lien de réinitialisation du mot de passe" title="Lien de réinitialisation du mot de passe" ${u.is_active ? "" : "disabled"}>🔑</button><button class="smallbtn delete" data-toggle-user="${u.id}" aria-label="${u.is_active ? "Désactiver" : "Réactiver"}" title="${u.is_active ? "Désactiver" : "Réactiver"}" ${u.id === user.id || u.is_owner ? "disabled" : ""}>${u.is_active ? "×" : "↻"}</button></span></div>`
      )
      .join("") || `<p class="muted">Aucun utilisateur.</p>`;
  $("#activitylist")
    .querySelectorAll("[data-del-activity]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const activity = activities.find(a => a.id === b.dataset.delActivity);
          if (
            confirm(
              "Si cette activité est utilisée dans un programme ou une séance, elle sera désactivée et conservée. Sinon, elle sera définitivement supprimée. Continuer ?"
            )
          ) {
            try {
              const result = await api("/admin/activities/" + b.dataset.delActivity, {method: "DELETE"});
              await loadAdmin();
              toast(result.action === "deactivated" ? "Activité désactivée." : "Activité supprimée.");
            } catch (e) {
              toast(e.message);
            }
          }
        })
    );
  $("#activitylist")
    .querySelectorAll("[data-edit-activity]")
    .forEach(
      b =>
        (b.onclick = () => {
          const a = activities.find(x => x.id === b.dataset.editActivity),
            f = $("#activityform");
          f.elements.id.value = a.id;
          f.elements.name.value = a.name;
          f.elements.duration_minutes.value = a.duration_minutes;
          f.elements.is_default.checked = !!a.is_default;
          $("#activitydialogtitle").textContent = "Modifier une activité";
          $("#activitydialog").showModal();
        })
    );
  $("#activitylist")
    .querySelectorAll("[data-default-activity]")
    .forEach(
      b =>
        (b.onclick = async () => {
          await api("/admin/activities/" + b.dataset.defaultActivity, {
            method: "PUT",
            body: JSON.stringify({is_default: true}),
          });
          await loadAdmin();
        })
    );

  // Lien de réinitialisation à transmettre à l’utilisateur (copié dans le presse-papiers si possible).
  $("#userlist")
    .querySelectorAll("[data-reset-user]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const u = users.find(x => x.id === b.dataset.resetUser);
          if (!confirm("Créer un lien de réinitialisation du mot de passe pour " + u.email + " ?")) return;
          try {
            const r = await sendApi("/admin/users/" + u.id + "/reset-link", "POST", {});
            try {
              await navigator.clipboard.writeText(r.link);
              toast("Lien copié : à transmettre à " + u.email + " (valable " + r.minutes + " min).");
            } catch {
              prompt("Lien à transmettre (valable " + r.minutes + " min) :", r.link);
            }
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#userlist")
    .querySelectorAll("[data-admin-user]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const u = users.find(x => x.id === b.dataset.adminUser),
            label = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
          if (
            !confirm(
              u.is_admin
                ? "Retirer les droits d’administration de " + label + " ?"
                : "Nommer " + label + " administrateur ?"
            )
          )
            return;
          try {
            await api("/admin/users/" + u.id, {method: "PUT", body: JSON.stringify({is_admin: !u.is_admin})});
            await loadAdmin();
            toast(u.is_admin ? "Droits d’administration retirés." : "Administrateur ajouté.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#userlist")
    .querySelectorAll("[data-coach-user]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const u = users.find(x => x.id === b.dataset.coachUser),
            label = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
          let coach;
          if (u.coach_status === "approved") {
            if (!confirm("Retirer le rôle de coach de " + label + " ? Ses programmes déjà proposés restent suivis."))
              return;
            coach = false;
          } else if (u.coach_status === "pending") {
            if (confirm("Valider la demande de coach de " + label + " ?")) coach = true;
            else if (confirm("Refuser la demande de coach de " + label + " ?")) coach = false;
            else return;
          } else if (confirm("Nommer " + label + " coach ?")) coach = true;
          else return;
          try {
            await api("/admin/users/" + u.id, {method: "PUT", body: JSON.stringify({coach})});
            await loadAdmin();
            await loadBoxes();
            toast(coach ? "Rôle de coach donné." : "Rôle de coach retiré ou demande refusée.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#userlist")
    .querySelectorAll("[data-toggle-user]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const u = users.find(x => x.id === b.dataset.toggleUser);
          if (confirm(u.is_active ? "Désactiver cet utilisateur ?" : "Réactiver cet utilisateur ?")) {
            await api("/admin/users/" + u.id, {method: "PUT", body: JSON.stringify({is_active: !u.is_active})});
            await loadAdmin();
          }
        })
    );
}
$("#movementcatalogform").onsubmit = async e => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim(),
    method = e.target.elements.measurement_method.value,
    editing = e.target.dataset.editId;
  try {
    await api(editing ? "/admin/movements/" + editing : "/admin/movements", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify({name, measurement_method: method}),
    });
    e.target.reset();
    delete e.target.dataset.editId;
    $("#movementcatalogdialog").close();
    const d = await api("/movement-catalog");
    movementCatalog = d.movements;
    await loadAdmin();
    toast(editing ? "Mouvement modifié." : "Mouvement ajouté au catalogue.");
  } catch (x) {
    $("#movementcatalogerror").textContent = x.message;
  }
};
$("#activityform").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target),
    id = f.get("id");
  try {
    await api(id ? "/admin/activities/" + id : "/admin/activities", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({
        name: f.get("name"),
        duration_minutes: Number(f.get("duration_minutes")),
        is_default: f.get("is_default") === "on",
      }),
    });
    e.target.reset();
    $("#activitydialog").close();
    await loadAdmin();
    toast("Activité enregistrée.");
  } catch (x) {
    toast(x.message);
  }
};
