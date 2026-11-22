// Tests d'intégration : administrateurs multiples, box, gestionnaires, adhésions, WOD de box, scores, programmes publics.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

let worker, admin, alice, bob, carol;
const PASSWORD = "MotDePasse-Test-123";
const idOf = async email => (await admin.get("/admin/users")).data.users.find(u => u.email === email).id;

before(async () => {
  worker = await startWorker();
  admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  carol = client(worker.base);
  assert.equal((await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD})).status, 200);
  for (const [c, email, first] of [
    [alice, "alice@test.local", "Alice"],
    [bob, "bob@test.local", "Bob"],
    [carol, "carol@test.local", "Carol"],
  ]) {
    assert.equal((await c.post("/register", {email, password: PASSWORD})).status, 200);
    assert.equal((await c.put("/profile", {first_name: first, last_name: "Test"})).status, 200);
  }
});
after(() => worker?.stop());

test("administrateurs : un admin en nomme un autre, l'admin principal reste protégé", async () => {
  const aliceId = await idOf("alice@test.local"),
    ownerId = await idOf(ADMIN_EMAIL);
  assert.equal((await alice.get("/admin/users")).status, 403);
  assert.equal((await bob.put(`/admin/users/${aliceId}`, {is_admin: true})).status, 403);
  assert.equal((await admin.put(`/admin/users/${aliceId}`, {is_admin: true})).status, 200);
  assert.equal((await alice.get("/me")).data.is_admin, true);
  assert.equal((await alice.get("/admin/users")).status, 200);
  // l'admin principal ne peut être ni rétrogradé ni désactivé
  assert.equal((await alice.put(`/admin/users/${ownerId}`, {is_admin: false})).status, 400);
  assert.equal((await alice.put(`/admin/users/${ownerId}`, {is_active: false})).status, 400);
  // un admin ne retire pas ses propres droits
  assert.equal((await alice.put(`/admin/users/${aliceId}`, {is_admin: false})).status, 400);
  // les activités gérées par un admin secondaire sont celles du référentiel commun
  const created = await alice.post("/admin/activities", {name: "Haltéro", duration_minutes: 45});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.ok((await bob.get("/activities")).data.activities.some(a => a.name === "Haltéro"));
  // l'admin principal retire les droits
  assert.equal((await admin.put(`/admin/users/${aliceId}`, {is_admin: false})).status, 200);
  assert.equal((await alice.get("/admin/users")).status, 403);
  assert.equal((await alice.get("/me")).data.is_admin, false);
});

let boxId;
test("box : création par un admin, demande de gestionnaire validée par un admin", async () => {
  assert.equal((await alice.post("/admin/boxes", {name: "Box intruse"})).status, 403);
  const created = await admin.post("/admin/boxes", {name: "CrossFit Test", city: "Marseille"});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  boxId = created.data.id;
  assert.equal((await admin.post("/admin/boxes", {name: "crossfit test"})).status, 409);
  assert.ok((await bob.get("/boxes")).data.boxes.some(b => b.id === boxId));
  // sans prénom ni nom, pas de demande
  const nameless = client(worker.base);
  await nameless.post("/register", {email: "anonyme@test.local", password: PASSWORD});
  assert.equal((await nameless.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 400);
  // Alice demande à gérer la box : rejouable sans doublon
  assert.equal((await alice.post(`/boxes/${boxId}/requests`, {role: "manager"})).status, 200);
  assert.equal((await alice.post(`/boxes/${boxId}/requests`, {role: "manager"})).status, 200);
  assert.equal((await alice.get(`/manage/boxes/${boxId}`)).status, 404, "pas encore validée");
  const pending = (await admin.get("/admin/boxes")).data.managers.filter(x => x.box_id === boxId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  const aliceId = await idOf("alice@test.local");
  assert.equal((await bob.put(`/admin/boxes/${boxId}/managers/${aliceId}`, {approve: true})).status, 403);
  assert.equal((await admin.put(`/admin/boxes/${boxId}/managers/${aliceId}`, {approve: true})).status, 200);
  const box = await alice.get(`/manage/boxes/${boxId}`);
  assert.equal(box.status, 200);
  // la box est créée avec les catégories RX, Inter, Scaled ; le gestionnaire est aussi membre
  assert.deepEqual(
    box.data.categories.map(c => c.name),
    ["RX", "Inter", "Scaled"]
  );
  assert.ok(box.data.members.some(m => m.user_id === aliceId && m.status === "approved" && m.is_manager));
});

test("box : adhésion validée par un gestionnaire de la box, catégories paramétrables", async () => {
  const bobId = await idOf("bob@test.local"),
    carolId = await idOf("carol@test.local");
  assert.equal((await bob.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 200);
  assert.equal((await carol.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 200);
  assert.deepEqual((await bob.get("/boxes")).data.memberships, [{box_id: boxId, role: "member", status: "pending"}]);
  // un simple membre (ou l'admin) ne gère pas la box
  assert.equal((await bob.get(`/manage/boxes/${boxId}`)).status, 404);
  assert.equal((await carol.put(`/manage/boxes/${boxId}/members/${bobId}`, {approve: true})).status, 404);
  assert.equal((await admin.get(`/manage/boxes/${boxId}`)).status, 404);
  assert.equal((await alice.put(`/manage/boxes/${boxId}/members/${bobId}`, {approve: true})).status, 200);
  assert.equal((await alice.put(`/manage/boxes/${boxId}/members/${carolId}`, {approve: true})).status, 200);
  assert.equal((await bob.get("/boxes")).data.memberships[0].status, "approved");
  // le gestionnaire ne peut pas être retiré des membres
  const aliceId = await idOf("alice@test.local");
  assert.equal((await alice.del(`/manage/boxes/${boxId}/members/${aliceId}`)).status, 400);
  // catégories : ajout rejouable, renommage, ordre, suppression
  const cid = "6f1c2c1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f";
  assert.equal((await alice.post(`/manage/boxes/${boxId}/categories`, {name: "Masters", client_id: cid})).data.id, cid);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/categories`, {name: "Masters", client_id: cid})).status, 200);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/categories`, {name: "RX"})).status, 409);
  assert.equal((await bob.put(`/manage/categories/${cid}`, {name: "Pirate"})).status, 404);
  assert.equal((await alice.put(`/manage/categories/${cid}`, {name: "Masters 40+"})).status, 200);
  let cats = (await alice.get(`/manage/boxes/${boxId}`)).data.categories;
  assert.deepEqual(
    cats.map(c => c.name),
    ["RX", "Inter", "Scaled", "Masters 40+"]
  );
  const ids = cats.map(c => c.id).reverse();
  assert.equal((await alice.put(`/manage/boxes/${boxId}/categories/order`, {ids})).status, 200);
  cats = (await alice.get(`/manage/boxes/${boxId}`)).data.categories;
  assert.equal(cats[0].name, "Masters 40+");
  assert.equal((await alice.del(`/manage/categories/${cid}`)).status, 200);
});

let boxWodId;
test("WOD de box : saisis par le gestionnaire (passés et à venir), visibles des seuls membres", async () => {
  const day = today(),
    from = mondayOf(day),
    to = addDays(from, 6),
    cid = "0b7e5a9c-3f1d-4e2a-9c8b-7a6d5e4f3c2b";
  // nom par défaut « WOD du JJ/MM/AAAA », création rejouable sans doublon
  const created = await alice.post(`/manage/boxes/${boxId}/wods`, {
    client_id: cid,
    wod_date: day,
    content: "21-15-9 Thrusters / Pull-ups",
    score_type: "time",
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  boxWodId = created.data.id;
  assert.equal(boxWodId, cid);
  await alice.post(`/manage/boxes/${boxId}/wods`, {client_id: cid, wod_date: day, score_type: "time"});
  const upcoming = await alice.post(`/manage/boxes/${boxId}/wods`, {
    wod_date: addDays(day, 30),
    name: "Murph",
    score_type: "time",
  });
  assert.equal(upcoming.status, 200);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "x"})).status, 400);
  assert.equal((await bob.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "time"})).status, 404);
  const list = (await alice.get(`/manage/boxes/${boxId}/wods?from=${from}&to=${to}`)).data.wods;
  assert.equal(list.length, 1);
  const [d, mo, y] = [day.slice(8, 10), day.slice(5, 7), day.slice(0, 4)];
  assert.equal(list[0].name, `WOD du ${d}/${mo}/${y}`);
  // un membre validé voit les WOD de sa box ; un non-membre ne voit rien
  assert.equal((await bob.get(`/box-wods?from=${from}&to=${to}`)).data.wods.length, 1);
  const outsider = client(worker.base);
  await outsider.post("/register", {email: "dehors@test.local", password: PASSWORD});
  assert.equal((await outsider.get(`/box-wods?from=${from}&to=${to}`)).data.wods.length, 0);
  assert.equal((await bob.get(`/box-wods?from=${from}&to=${addDays(from, 200)}`)).status, 400);
  // modification par le gestionnaire seulement, puis suppression
  assert.equal((await bob.put(`/manage/wods/${upcoming.data.id}`, {wod_date: day, score_type: "reps"})).status, 404);
  const edit = await alice.put(`/manage/wods/${upcoming.data.id}`, {
    wod_date: addDays(day, 31),
    name: "Murph",
    content: "1 mile run…",
    score_type: "time",
  });
  assert.equal(edit.status, 200);
  assert.equal((await alice.del(`/manage/wods/${upcoming.data.id}`)).status, 200);
});

test("séance sur un WOD de box : score, catégorie et classement entre membres", async () => {
  const activityId = (await bob.get("/activities")).data.activities[0].id,
    cats = (await bob.get("/boxes")).data.categories.filter(c => c.box_id === boxId),
    rx = cats.find(c => c.name === "RX").id,
    scaled = cats.find(c => c.name === "Scaled").id,
    session = extra => ({
      program_id: "none",
      wod_id: "other",
      session_date: today(),
      activity_id: activityId,
      duration_minutes: 60,
      movement_ids: [],
      catalog_movement_ids: [],
      box_wod_id: boxWodId,
      ...extra,
    });
  // temps en secondes, catégorie obligatoire et propre à la box
  assert.equal((await bob.post("/sessions", session({score_value: 300}))).status, 400);
  assert.equal((await bob.post("/sessions", session({score_value: 12.5, score_category_id: rx}))).status, 400);
  const bobSession = await bob.post("/sessions", session({score_value: 420, score_category_id: rx}));
  assert.equal(bobSession.status, 200, JSON.stringify(bobSession.data));
  assert.equal((await carol.post("/sessions", session({score_value: 380, score_category_id: rx}))).status, 200);
  assert.equal((await alice.post("/sessions", session({score_value: 500, score_category_id: scaled}))).status, 200);
  // un non-membre ne peut ni enregistrer ce WOD ni voir le classement
  const outsider = client(worker.base);
  await outsider.post("/register", {email: "dehors2@test.local", password: PASSWORD});
  assert.equal((await outsider.post("/sessions", session({score_value: 100, score_category_id: rx}))).status, 404);
  assert.equal((await outsider.get(`/box-wods/${boxWodId}/leaderboard`)).status, 404);
  // classement : For Time, le plus petit temps d'abord, par catégorie ; prénom et nom affichés
  const board = (await bob.get(`/box-wods/${boxWodId}/leaderboard`)).data;
  const rxRows = board.categories.find(c => c.id === rx).rows;
  assert.deepEqual(
    rxRows.map(x => [x.first_name, x.score, x.is_me]),
    [
      ["Carol", 380, 0],
      ["Bob", 420, 1],
    ]
  );
  assert.equal(board.categories.find(c => c.id === scaled).rows[0].first_name, "Alice");
  // la séance apparaît dans l'historique avec le nom du WOD, la box et le score
  const week = (await bob.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`)).data;
  const logged = week.sessions.find(x => x.id === bobSession.data.id);
  assert.match(logged.wod_name, /^WOD du /);
  assert.equal(logged.box_name, "CrossFit Test");
  assert.equal(logged.score_category_name, "RX");
  assert.deepEqual(week.boxWods.find(w => w.id === boxWodId).session_ids, [bobSession.data.id]);
  // modification du score
  assert.equal(
    (await bob.put(`/sessions/${bobSession.data.id}`, session({score_value: 360, score_category_id: rx}))).status,
    200
  );
  const after = (await bob.get(`/box-wods/${boxWodId}/leaderboard`)).data.categories.find(c => c.id === rx).rows;
  assert.equal(after[0].first_name, "Bob");
  // un WOD ou une catégorie déjà utilisés ne se suppriment plus ; la box non plus
  assert.equal((await alice.del(`/manage/wods/${boxWodId}`)).status, 409);
  assert.equal((await alice.del(`/manage/categories/${rx}`)).status, 409);
  assert.equal((await admin.del(`/admin/boxes/${boxId}`)).status, 409);
  // un membre qui quitte la box disparaît du classement
  assert.equal((await carol.del(`/boxes/${boxId}/requests`, {role: "member"})).status, 200);
  const left = (await bob.get(`/box-wods/${boxWodId}/leaderboard`)).data.categories.find(c => c.id === rx).rows;
  assert.ok(!left.some(x => x.first_name === "Carol"));
});

test("programmes publics : recherche, suivi d'un seul programme à la fois, lecture seule", async () => {
  const activityId = (await bob.get("/activities")).data.activities[0].id,
    start = mondayOf(today()),
    end = addDays(start, 27);
  // Alice publie un programme, en garde un autre privé
  const pub = await alice.post("/programs", {name: "Bloc Engine public", start, end, is_public: true});
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  await alice.post("/programs", {name: "Bloc secret", start: addDays(start, 70), end: addDays(start, 90)});
  const wod = await alice.post(`/programs/${pub.data.id}/wods`, {
    name: "Intervalles",
    score_type: "rounds",
    activity_id: activityId,
    duration_minutes: 45,
  });
  assert.equal(wod.status, 200);
  // recherche : par nom ou par auteur, jamais les programmes privés ni les siens
  assert.equal((await bob.get("/public-programs?q=engine")).data.programs.length, 1);
  assert.equal((await bob.get("/public-programs?q=Alice")).data.programs.length, 1);
  assert.equal((await bob.get("/public-programs?q=secret")).data.programs.length, 0);
  assert.equal((await alice.get("/public-programs?q=engine")).data.programs.length, 0);
  assert.equal((await bob.get("/public-programs?q=%25")).data.programs.length, 0, "le joker % est échappé");
  const secret = (await alice.get("/programs")).data.programs.find(x => x.name === "Bloc secret");
  assert.equal((await bob.put("/program-follow", {program_id: secret.id})).status, 404);
  // un seul programme à la fois : refus si Bob a déjà un programme sur ces dates
  const own = await bob.post("/programs", {name: "Perso", start, end: addDays(start, 6)});
  assert.equal(own.status, 200);
  assert.equal((await bob.put("/program-follow", {program_id: pub.data.id})).status, 409);
  assert.equal((await bob.del(`/programs/${own.data.id}`)).status, 200);
  assert.equal((await bob.put("/program-follow", {program_id: pub.data.id})).status, 200);
  // ni l'inverse : pas de programme personnel sur les dates du programme suivi
  assert.equal((await bob.post("/programs", {name: "Perso 2", start, end: addDays(start, 6)})).status, 409);
  // le programme suivi apparaît en lecture seule, avec son auteur
  const data = (await bob.get("/program-data")).data,
    followed = data.programs.find(x => x.id === pub.data.id);
  assert.equal(followed.followed, 1);
  assert.equal(followed.read_only, 1);
  assert.equal(followed.author_first_name, "Alice");
  assert.equal(data.wods[pub.data.id].length, 1);
  // Bob ne peut pas modifier le programme suivi
  assert.equal(
    (await bob.post(`/programs/${pub.data.id}/wods`, {name: "intrus", activity_id: activityId, duration_minutes: 30}))
      .status,
    404
  );
  assert.equal((await bob.put(`/programs/${pub.data.id}`, {name: "pirate", start, end})).status, 404);
  // séance sur un WOD du programme suivi ; « Autres » part dans « Hors programme »
  const base = {
    program_id: pub.data.id,
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 45,
    movement_ids: [],
    catalog_movement_ids: [],
  };
  const logged = await bob.post("/sessions", {...base, wod_id: wod.data.id, score_type: "rounds", score_value: 7});
  assert.equal(logged.status, 200, JSON.stringify(logged.data));
  const other = await bob.post("/sessions", {...base, wod_id: "other"});
  assert.equal(other.status, 200, JSON.stringify(other.data));
  const week = (await bob.get(`/week-data?from=${start}&to=${addDays(start, 6)}`)).data.sessions;
  assert.equal(week.find(x => x.id === logged.data.id).program_name, "Bloc Engine public");
  const path = `/wods/${wod.data.id}/scores`;
  assert.equal((await bob.get(path)).data.scores[0].score_value, 7);
  assert.deepEqual((await alice.get(path)).data.scores, []);
  assert.equal(week.find(x => x.id === other.data.id).program_name, "Hors programme");
  // l'auteur ne peut plus supprimer le WOD ni le programme réalisés par un suiveur
  assert.equal((await alice.del(`/wods/${wod.data.id}`)).status, 409);
  assert.equal((await alice.del(`/programs/${pub.data.id}`)).status, 409);
  // arrêter de suivre : la séance reste dans l'historique
  assert.equal((await bob.del("/program-follow")).status, 200);
  assert.equal((await bob.get(path)).data.scores[0].score_value, 7);
  const after = (await bob.get("/program-data")).data.programs.find(x => x.id === pub.data.id);
  assert.equal(after.followed, 0);
  assert.ok(
    (await bob.get(`/week-data?from=${start}&to=${addDays(start, 6)}`)).data.sessions.some(x => x.id === logged.data.id)
  );
  // un utilisateur sans lien avec le programme n'y a pas accès
  assert.equal((await carol.post("/sessions", {...base, wod_id: wod.data.id})).status, 404);
});

test("programme suivi : dates propres à l'utilisateur, programmation hebdomadaire décalée", async () => {
  const dan = client(worker.base);
  await dan.post("/register", {email: "dan@test.local", password: PASSWORD});
  const activityId = (await dan.get("/activities")).data.activities[0].id,
    authorStart = addDays(mondayOf(today()), 140),
    authorEnd = addDays(authorStart, 27);
  // l'auteur a programmé son WOD suivi en semaine 2
  const prog = await alice.post("/programs", {name: "Gym futur", start: authorStart, end: authorEnd, is_public: true});
  assert.equal(prog.status, 200, JSON.stringify(prog.data));
  const wod = await alice.post(`/programs/${prog.data.id}/wods`, {
    name: "Muscle-ups",
    activity_id: activityId,
    duration_minutes: 30,
    is_tracked: true,
  });
  assert.equal(
    (
      await alice.put(`/wods/${wod.data.id}/weekly-programming`, {
        week_start: addDays(authorStart, 7),
        content: "S2 : 5x3",
      })
    ).status,
    200
  );
  // Dan le suit à partir de la semaine dernière (dates invalides refusées)
  const start = addDays(mondayOf(today()), -7);
  assert.equal(
    (await dan.put("/program-follow", {program_id: prog.data.id, start, end: addDays(start, -1)})).status,
    400
  );
  assert.equal((await dan.put("/program-follow", {program_id: prog.data.id, start})).status, 200);
  const data = (await dan.get("/program-data")).data,
    followed = data.programs.find(x => x.id === prog.data.id);
  assert.equal(followed.start_monday, start);
  assert.equal(followed.end_monday, addDays(start, 27), "même durée que l'auteur par défaut");
  assert.equal(followed.author_start_monday, authorStart);
  // la semaine 2 de l'auteur devient la semaine 2 de Dan
  assert.deepEqual(
    data.weeklyWodPrograms.filter(x => x.wod_id === wod.data.id).map(x => [x.week_start, x.content]),
    [[addDays(start, 7), "S2 : 5x3"]]
  );
  // séance aujourd'hui : dans les dates de Dan, hors de celles de l'auteur
  const session = await dan.post("/sessions", {
    program_id: prog.data.id,
    wod_id: wod.data.id,
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 30,
    movement_ids: [],
    catalog_movement_ids: [],
  });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  // un programme personnel sur ces dates est refusé, après les dates c'est possible
  assert.equal((await dan.post("/programs", {name: "Perso", start, end: addDays(start, 6)})).status, 409);
  assert.equal(
    (await dan.post("/programs", {name: "Après", start: addDays(start, 28), end: addDays(start, 40)})).status,
    200
  );
  // changer ses dates (même programme)
  const later = addDays(start, 7);
  assert.equal(
    (await dan.put("/program-follow", {program_id: prog.data.id, start: later, end: addDays(later, 13)})).status,
    200
  );
  assert.equal((await dan.get("/program-data")).data.programs.find(x => x.id === prog.data.id).start_monday, later);
});

test("préférences : thème et rappels propres au compte, valeurs par défaut fixées par un admin", async () => {
  const erin = client(worker.base);
  await erin.post("/register", {email: "erin@test.local", password: PASSWORD});
  let prefs = (await erin.get("/preferences")).data;
  assert.equal(prefs.theme, null);
  assert.equal(prefs.default_theme, "dark");
  assert.equal(prefs.choices.themes.includes("auto"), false, "plus de thème « Automatique »");
  assert.equal((await erin.put("/preferences", {theme: "auto"})).status, 400);
  assert.deepEqual(prefs.reminders, {enabled: 1, days: 3, hour: 18});
  // seul un admin fixe les valeurs par défaut
  const defaults = {theme: "dark", reminder_days: 5, reminder_hour: 7, reminders_enabled: false};
  assert.equal((await erin.put("/admin/settings", defaults)).status, 403);
  assert.equal((await admin.put("/admin/settings", {...defaults, theme: "rose"})).status, 400);
  assert.equal((await admin.put("/admin/settings", defaults)).status, 200);
  prefs = (await erin.get("/preferences")).data;
  assert.equal(prefs.default_theme, "dark");
  assert.deepEqual(prefs.reminders, {enabled: 0, days: 5, hour: 7});
  // le choix du compte l'emporte, sur tous ses appareils (nouvelle connexion)
  assert.equal((await erin.put("/preferences", {theme: "massilia", reminders: {enabled: 1, days: 2}})).status, 200);
  assert.equal((await erin.put("/preferences", {theme: "rose"})).status, 400);
  assert.equal((await erin.put("/preferences", {reminders: {hour: 3}})).status, 400);
  const other = client(worker.base);
  await other.post("/login", {email: "erin@test.local", password: PASSWORD});
  prefs = (await other.get("/preferences")).data;
  assert.equal(prefs.theme, "massilia");
  assert.deepEqual(prefs.reminders, {enabled: 1, days: 2, hour: 7});
  // revenir au thème par défaut
  assert.equal((await other.put("/preferences", {theme: null})).status, 200);
  assert.equal((await erin.get("/preferences")).data.theme, null);
});

test("espace gestionnaire : infos de la box modifiables par ses seuls gestionnaires", async () => {
  assert.equal((await bob.put(`/manage/boxes/${boxId}`, {name: "Pirate", city: ""})).status, 404);
  assert.equal((await alice.put(`/manage/boxes/${boxId}`, {name: "", city: "Aix"})).status, 400);
  assert.equal((await alice.put(`/manage/boxes/${boxId}`, {name: "CrossFit Test", city: "Aix"})).status, 200);
  assert.equal((await alice.get(`/manage/boxes/${boxId}`)).data.box.city, "Aix");
});

test("WOD de box à venir : visibles du seul gestionnaire, ni listés ni enregistrables par les membres", async () => {
  const tomorrow = addDays(today(), 1),
    created = await alice.post(`/manage/boxes/${boxId}/wods`, {wod_date: tomorrow, name: "Demain", score_type: "reps"});
  assert.equal(created.status, 200);
  const range = `from=${mondayOf(tomorrow)}&to=${addDays(mondayOf(tomorrow), 6)}`;
  assert.ok((await alice.get(`/manage/boxes/${boxId}/wods?${range}`)).data.wods.some(w => w.id === created.data.id));
  assert.ok(!(await bob.get(`/box-wods?${range}`)).data.wods.some(w => w.id === created.data.id));
  assert.ok(!(await bob.get(`/week-data?${range}`)).data.boxWods.some(w => w.id === created.data.id));
  assert.equal((await bob.get(`/box-wods/${created.data.id}/leaderboard`)).status, 404);
  const activityId = (await bob.get("/activities")).data.activities[0].id;
  const logged = await bob.post("/sessions", {
    program_id: "none",
    wod_id: "other",
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 60,
    movement_ids: [],
    catalog_movement_ids: [],
    box_wod_id: created.data.id,
  });
  assert.equal(logged.status, 404);
  assert.equal((await alice.del(`/manage/wods/${created.data.id}`)).status, 200);
});

test("tâches à valider : adhésions pour le gestionnaire, demandes de gestionnaire pour l'admin", async () => {
  const fred = client(worker.base);
  await fred.post("/register", {email: "fred@test.local", password: PASSWORD});
  await fred.put("/profile", {first_name: "Fred", last_name: "Test"});
  const before = (await alice.get("/boxes")).data.pending.members;
  assert.equal((await fred.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 200);
  assert.equal((await fred.post(`/boxes/${boxId}/requests`, {role: "manager"})).status, 200);
  assert.equal((await alice.get("/boxes")).data.pending.members, before + 1);
  assert.equal((await bob.get("/boxes")).data.pending.members, 0, "un simple membre n'a rien à valider");
  assert.ok((await admin.get("/boxes")).data.pending.managers >= 1);
  assert.equal((await alice.get("/boxes")).data.pending.managers, 0, "seul un admin voit les demandes de gestionnaire");
  const fredId = await idOf("fred@test.local");
  await alice.put(`/manage/boxes/${boxId}/members/${fredId}`, {approve: true});
  await admin.put(`/admin/boxes/${boxId}/managers/${fredId}`, {approve: false});
  assert.equal((await alice.get("/boxes")).data.pending.members, before);
});

test("types de WOD : liste par box pré-remplie, WOD par défaut, paramétrable par le gestionnaire", async () => {
  let types = (await alice.get(`/manage/boxes/${boxId}`)).data.types;
  assert.deepEqual(
    types.map(t => t.name),
    ["WOD", "Haltéro", "Gym", "FBB", "Hyrox", "Endurance"]
  );
  const day = today(),
    halt = types.find(t => t.name === "Haltéro").id;
  // sans type : « WOD » ; avec type : nom par défaut « Haltéro du JJ/MM/AAAA »
  const plain = await alice.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "none"});
  const lift = await alice.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "load", type_id: halt});
  assert.equal(lift.status, 200, JSON.stringify(lift.data));
  const list = (await alice.get(`/manage/boxes/${boxId}/wods?from=${day}&to=${day}`)).data.wods;
  assert.equal(list.find(w => w.id === plain.data.id).type_name, "WOD");
  const l = list.find(w => w.id === lift.data.id);
  assert.equal(l.type_name, "Haltéro");
  assert.match(l.name, /^Haltéro du /);
  assert.equal(
    (await bob.get(`/box-wods?from=${day}&to=${day}`)).data.wods.find(w => w.id === lift.data.id).type_name,
    "Haltéro"
  );
  // un type d'une autre box est refusé
  assert.equal(
    (await alice.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "none", type_id: "inconnu"})).status,
    400
  );
  // ajout, renommage, ordre ; suppression refusée si utilisé ; réservé au gestionnaire
  assert.equal((await bob.post(`/manage/boxes/${boxId}/wod-types`, {name: "Pirate"})).status, 404);
  const added = await alice.post(`/manage/boxes/${boxId}/wod-types`, {name: "Mobilité"});
  assert.equal(added.status, 200);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/wod-types`, {name: "Gym"})).status, 409);
  assert.equal((await alice.put(`/manage/wod-types/${added.data.id}`, {name: "Mobilité & souplesse"})).status, 200);
  types = (await alice.get(`/manage/boxes/${boxId}`)).data.types;
  assert.equal(
    (await alice.put(`/manage/boxes/${boxId}/wod-types/order`, {ids: types.map(t => t.id).reverse()})).status,
    200
  );
  assert.equal((await alice.get(`/manage/boxes/${boxId}`)).data.types[0].name, "Mobilité & souplesse");
  assert.equal((await alice.del(`/manage/wod-types/${halt}`)).status, 409);
  assert.equal((await alice.del(`/manage/wod-types/${added.data.id}`)).status, 200);
  await alice.del(`/manage/wods/${plain.data.id}`);
  await alice.del(`/manage/wods/${lift.data.id}`);
});

test("mouvements d'un WOD de box : cochés par le gestionnaire, transmis aux membres", async () => {
  await admin.post("/admin/movements", {name: "Thruster test", measurement_method: "load"});
  await admin.post("/admin/movements", {name: "Pull-up test", measurement_method: "reps"});
  const catalog = (await alice.get("/movement-catalog")).data.movements,
    thruster = catalog.find(m => m.name === "Thruster test").id,
    pullup = catalog.find(m => m.name === "Pull-up test").id,
    day = today();
  const created = await alice.post(`/manage/boxes/${boxId}/wods`, {
    wod_date: day,
    score_type: "time",
    catalog_movement_ids: [thruster, pullup, "inconnu"],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const mine = (await alice.get(`/manage/boxes/${boxId}/wods?from=${day}&to=${day}`)).data.wods.find(
    w => w.id === created.data.id
  );
  assert.deepEqual([...mine.movement_ids].sort(), [thruster, pullup].sort());
  const seen = (await bob.get(`/box-wods?from=${day}&to=${day}`)).data.wods.find(w => w.id === created.data.id);
  assert.deepEqual([...seen.movement_ids].sort(), [thruster, pullup].sort());
  // modification : la liste est remplacée ; sans le champ, elle est gardée
  await alice.put(`/manage/wods/${created.data.id}`, {
    wod_date: day,
    score_type: "time",
    catalog_movement_ids: [pullup],
  });
  await alice.put(`/manage/wods/${created.data.id}`, {wod_date: day, score_type: "time", content: "x"});
  const after = (await bob.get(`/box-wods?from=${day}&to=${day}`)).data.wods.find(w => w.id === created.data.id);
  assert.deepEqual(after.movement_ids, [pullup]);
  assert.equal((await alice.del(`/manage/wods/${created.data.id}`)).status, 200);
});

test("séance « Autres » dans un programme avec mouvements : tous les mouvements du catalogue acceptés", async () => {
  const gina = client(worker.base);
  await gina.post("/register", {email: "gina@test.local", password: PASSWORD});
  const activityId = (await gina.get("/activities")).data.activities[0].id,
    catalog = (await gina.get("/movement-catalog")).data.movements,
    start = mondayOf(today()),
    prog = await gina.post("/programs", {name: "Avec mouvements", start, end: addDays(start, 27)});
  await gina.post(`/programs/${prog.data.id}/movements`, {catalog_movement_id: catalog[0].id});
  const other = catalog[1].id,
    created = await gina.post("/sessions", {
      program_id: prog.data.id,
      wod_id: "other",
      session_date: today(),
      activity_id: activityId,
      duration_minutes: 60,
      movement_ids: [],
      catalog_movement_ids: [other],
    });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const week = (await gina.get(`/week-data?from=${start}&to=${addDays(start, 6)}`)).data;
  assert.ok(week.catalogChecks.some(c => c.session_id === created.data.id && c.catalog_movement_id === other));
});

test("fenêtre d'accueil des box : « Je ne suis dans aucune box » enregistré sur le compte", async () => {
  const hugo = client(worker.base);
  await hugo.post("/register", {email: "hugo@test.local", password: PASSWORD});
  assert.equal((await hugo.get("/preferences")).data.box_prompt_dismissed, 0);
  assert.equal((await hugo.put("/preferences", {box_prompt_dismissed: true})).status, 200);
  const other = client(worker.base);
  await other.post("/login", {email: "hugo@test.local", password: PASSWORD});
  assert.equal((await other.get("/preferences")).data.box_prompt_dismissed, 1);
});

test("WOD de box en blocs : échauffement, force / skill, metcon, finisher, texte complet pour les membres", async () => {
  const day = today(),
    created = await alice.post(`/manage/boxes/${boxId}/wods`, {
      wod_date: day,
      score_type: "time",
      blocks: {warmup: "3 rounds : 200 m run", strength: "", metcon: "21-15-9 Thrusters", finisher: "Gainage 3 × 1'"},
    });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const mine = (await alice.get(`/manage/boxes/${boxId}/wods?from=${day}&to=${day}`)).data.wods.find(
    w => w.id === created.data.id
  );
  assert.equal(JSON.parse(mine.blocks).metcon, "21-15-9 Thrusters");
  const seen = (await bob.get(`/box-wods?from=${day}&to=${day}`)).data.wods.find(w => w.id === created.data.id);
  assert.equal(
    seen.content,
    "Échauffement\n3 rounds : 200 m run\n\nMetcon\n21-15-9 Thrusters\n\nFinisher\nGainage 3 × 1'"
  );
  // sans blocs (ancien format), le contenu libre reste accepté
  await alice.put(`/manage/wods/${created.data.id}`, {wod_date: day, score_type: "time", content: "Libre"});
  const after = (await bob.get(`/box-wods?from=${day}&to=${day}`)).data.wods.find(w => w.id === created.data.id);
  assert.equal(after.content, "Libre");
  assert.equal((await alice.del(`/manage/wods/${created.data.id}`)).status, 200);
});
