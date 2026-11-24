// Tests d'intégration des routes critiques. Lancer : node --test tests/
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID, createECDH, randomBytes} from "node:crypto";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

let worker, admin, alice, bob, activityId, programId, wodId;
const PASSWORD = "MotDePasse-Test-123";

before(async () => {
  worker = await startWorker();
  admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  assert.equal((await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD})).status, 200);
  assert.equal((await alice.post("/register", {email: "alice@test.local", password: PASSWORD})).status, 200);
  assert.equal((await bob.post("/register", {email: "bob@test.local", password: PASSWORD})).status, 200);
  activityId = (await alice.get("/activities")).data.activities[0].id;
  const start = mondayOf(addDays(today(), -14)),
    end = addDays(mondayOf(today()), 7);
  const program = await alice.post("/programs", {name: "Programme test", start, end});
  assert.equal(program.status, 200, JSON.stringify(program.data));
  programId = program.data.id || (await alice.get("/programs")).data.programs.find(p => p.name === "Programme test").id;
  const wod = await alice.post(`/programs/${programId}/wods`, {
    name: "WOD 1 : test",
    activity_id: activityId,
    duration_minutes: 60,
  });
  assert.equal(wod.status, 200, JSON.stringify(wod.data));
  wodId = wod.data.id || (await alice.get(`/programs/${programId}/wods`)).data.wods[0].id;
});
after(() => worker?.stop());

const sessionBody = extra => ({
  program_id: programId,
  wod_id: wodId,
  session_date: today(),
  activity_id: activityId,
  duration_minutes: 60,
  actual_comment: "",
  movement_ids: [],
  catalog_movement_ids: [],
  ...extra,
});

test("connexion : compte, cookie fitfactory_session, déconnexion", async () => {
  const c = client(worker.base);
  assert.equal((await c.post("/login", {email: "alice@test.local", password: PASSWORD})).status, 200);
  assert.match(c.cookie, /^fitfactory_session=/);
  assert.equal((await c.get("/me")).data.user.email, "alice@test.local");
  assert.equal((await c.post("/logout")).status, 200);
  assert.equal((await c.get("/me")).data.user, null);
});

test("ancien cookie cfplanner_session accepté puis remplacé", async () => {
  const c = client(worker.base);
  await c.post("/login", {email: "alice@test.local", password: PASSWORD});
  const token = c.cookie.split("=")[1];
  const res = await fetch(worker.base + "/api/me", {headers: {cookie: "cfplanner_session=" + token}});
  assert.equal((await res.json()).user.email, "alice@test.local");
  const set = res.headers.getSetCookie().join("\n");
  assert.match(set, /fitfactory_session=/);
  assert.match(set, /cfplanner_session=;.*Max-Age=0/);
});

test("trop de tentatives de connexion : blocage après 5 échecs", async () => {
  const c = client(worker.base);
  for (let i = 0; i < 5; i++)
    assert.equal((await c.post("/login", {email: "bob@test.local", password: "faux"})).status, 401);
  const blocked = await c.post("/login", {email: "bob@test.local", password: PASSWORD});
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /Trop de tentatives/);
  // un autre compte depuis une autre adresse n'est pas bloqué
  assert.equal((await client(worker.base).post("/login", {email: "alice@test.local", password: PASSWORD})).status, 200);
});

test("route protégée sans connexion : 401", async () => {
  assert.equal((await client(worker.base).get("/program-data")).status, 401);
});

test("séance : création rejouable sans doublon (client_id)", async () => {
  const id = randomUUID();
  const first = await alice.post("/sessions", sessionBody({client_id: id, actual_comment: "hors ligne"}));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.id, id);
  const replay = await alice.post("/sessions", sessionBody({client_id: id, actual_comment: "rejeu"}));
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, id);
  const week = await alice.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`);
  const same = week.data.sessions.filter(s => s.id === id);
  assert.equal(same.length, 1);
  assert.equal(same[0].actual_comment, "hors ligne");
});

test("séance : date future refusée", async () => {
  const res = await alice.post("/sessions", sessionBody({session_date: addDays(today(), 1)}));
  assert.equal(res.status, 400);
});

test("isolation : un utilisateur ne voit ni ne modifie les données d'un autre", async () => {
  const created = await alice.post("/sessions", sessionBody({client_id: randomUUID()}));
  const sid = created.data.id;
  const week = await bob.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`);
  assert.equal(week.data.sessions.length, 0);
  const edit = await bob.put(`/sessions/${sid}`, sessionBody({actual_comment: "piraté"}));
  assert.notEqual(edit.status, 200);
  await bob.del(`/sessions/${sid}`);
  const still = await alice.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`);
  assert.ok(still.data.sessions.some(s => s.id === sid && s.actual_comment !== "piraté"));
  assert.equal(
    (await bob.post(`/programs/${programId}/wods`, {name: "intrus", activity_id: activityId, duration_minutes: 30}))
      .status,
    404
  );
});

test("PR : création rejouable sans doublon (client_id)", async () => {
  const mv = await admin.post("/admin/movements", {name: "Back Squat test", measurement_method: "load"});
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  const movement = (await alice.get("/movement-catalog")).data.movements.find(m => m.id === mv.data.id);
  assert.equal(movement.category, "lift");
  const movementId = movement.id;
  const id = randomUUID(),
    body = {client_id: id, movement_id: movementId, record_date: today(), value: 100, rep_count: 1};
  assert.equal((await alice.post("/prs", body)).data.id, id);
  assert.equal((await alice.post("/prs", {...body, value: 200})).data.id, id);
  const records = (await alice.get("/prs")).data.records.filter(r => r.id === id);
  assert.equal(records.length, 1);
  assert.equal(records[0].value, 100);
});

test("catalogue : Core et Fonctionnel sont indépendants de la mesure du record", async () => {
  const body = {name: "Abdos test", category: "core", measurement_method: "reps"};
  assert.equal((await alice.post("/admin/movements", body)).status, 403);
  assert.equal((await admin.post("/admin/movements", {...body, category: "inconnue"})).status, 400);
  const created = await admin.post("/admin/movements", body);
  assert.equal(created.status, 200);
  const movementId = created.data.id,
    route = `/admin/movements/${movementId}`;
  const catalogEntry = (await admin.get("/admin/movements")).data.movements.find(m => m.id === movementId);
  assert.equal(catalogEntry.category, "core");
  const pr = await alice.post("/prs", {movement_id: movementId, record_date: today(), value: 25});
  assert.equal(pr.status, 200);
  const edited = {...body, category: "functional"};
  assert.equal((await admin.put(route, edited)).status, 200);
  assert.equal((await admin.put(route, {...edited, category: "inconnue"})).status, 400);
  assert.equal((await admin.put(route, {...edited, measurement_method: "load"})).status, 409);
  assert.equal((await admin.put(route, {name: body.name, measurement_method: body.measurement_method})).status, 200);
  const movement = (await alice.get("/movement-catalog")).data.movements.find(m => m.id === movementId);
  assert.deepEqual(movement, {id: movementId, ...edited});
  const record = (await alice.get("/prs")).data.records.find(r => r.id === pr.data.id);
  assert.equal(record.category, "functional");
  assert.equal(record.measurement_method, "reps");
  assert.equal(record.value, 25);
});

test("administration réservée au compte ADMIN_EMAIL", async () => {
  assert.equal((await alice.get("/admin/users")).status, 403);
  assert.equal((await admin.get("/admin/users")).status, 200);
});

test("rappels : configuration, validation de l'abonnement et des réglages", async () => {
  const config = await alice.get("/push/config");
  assert.equal(config.status, 200);
  assert.match(config.data.publicKey, /^[\w-]{80,100}$/);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {p256dh: ecdh.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url")};
  assert.equal((await alice.post("/push/subscribe", {endpoint: "https://evil.example.com/x", keys})).status, 400);
  assert.equal((await alice.post("/push/subscribe", {endpoint: "https://web.push.apple.com/abc", keys})).status, 200);
  assert.equal((await alice.get("/push/config")).data.devices, 1);
  assert.equal((await alice.put("/push/settings", {days: 9, hour: 3})).status, 400);
  assert.equal((await alice.put("/push/settings", {days: 5, hour: 7})).status, 200);
  const after = (await alice.get("/push/config")).data;
  assert.equal(after.days, 5);
  assert.equal(after.hour, 7);
  assert.equal((await alice.post("/push/unsubscribe", {endpoint: "https://web.push.apple.com/abc"})).status, 200);
  assert.equal((await alice.get("/push/config")).data.devices, 0);
});

test("mot de passe oublié : réponse identique, lien unique, ancien mot de passe refusé", async () => {
  const unknown = await client(worker.base).post("/password/forgot", {email: "personne@test.local"});
  const known = await client(worker.base).post("/password/forgot", {email: "alice@test.local"});
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.data, known.data);
  // lien généré par l'administrateur (pas d'e-mail en test)
  const users = (await admin.get("/admin/users")).data.users;
  const carol = client(worker.base);
  await carol.post("/register", {email: "carol@test.local", password: PASSWORD});
  const id = (await admin.get("/admin/users")).data.users.find(u => u.email === "carol@test.local").id;
  assert.ok(users.length > 0);
  assert.equal((await alice.post(`/admin/users/${id}/reset-link`)).status, 403);
  const link = (await admin.post(`/admin/users/${id}/reset-link`)).data.link;
  const token = decodeURIComponent(new URL(link).searchParams.get("reset"));
  const c = client(worker.base);
  assert.equal((await c.post("/password/reset", {token, password: "court"})).status, 400);
  const ok = await c.post("/password/reset", {token, password: "NouveauMotDePasse-1"});
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.email, "carol@test.local");
  assert.equal((await carol.get("/me")).data.user, null, "les autres sessions sont fermées");
  assert.equal(
    (await c.post("/password/reset", {token, password: "EncoreAutre-1234"})).status,
    400,
    "lien à usage unique"
  );
  assert.equal((await client(worker.base).post("/login", {email: "carol@test.local", password: PASSWORD})).status, 401);
  assert.equal(
    (await client(worker.base).post("/login", {email: "carol@test.local", password: "NouveauMotDePasse-1"})).status,
    200
  );
});

test("séance hors programme : programme technique créé à la demande, sans conflit de dates", async () => {
  const dave = client(worker.base);
  await dave.post("/register", {email: "dave@test.local", password: PASSWORD});
  assert.equal((await dave.get("/programs")).data.programs.length, 0);
  const res = await dave.post("/sessions", {
    program_id: "none",
    wod_id: "other",
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 45,
    movement_ids: [],
    catalog_movement_ids: [],
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const programs = (await dave.get("/programs")).data.programs;
  assert.equal(programs.length, 1);
  assert.equal(programs[0].name, "Hors programme");
  assert.equal(programs[0].is_default, 1);
  // un second envoi réutilise le même programme technique
  await dave.post("/sessions", {
    program_id: "none",
    wod_id: "other",
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 30,
    movement_ids: [],
    catalog_movement_ids: [],
  });
  assert.equal((await dave.get("/programs")).data.programs.length, 1);
  // un vrai programme sur la même période reste possible
  const created = await dave.post("/programs", {
    name: "Bloc force",
    start: mondayOf(today()),
    end: addDays(mondayOf(today()), 27),
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
});

test("modifier un programme ne rend pas visible le programme technique « Hors programme »", async () => {
  const erin = client(worker.base);
  await erin.post("/register", {email: "erin@test.local", password: PASSWORD});
  await erin.post("/sessions", {
    program_id: "none",
    wod_id: "other",
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 45,
    movement_ids: [],
    catalog_movement_ids: [],
  });
  const start = mondayOf(today());
  await erin.post("/programs", {name: "Bloc", start, end: addDays(start, 27)});
  const bloc = (await erin.get("/programs")).data.programs.find(x => x.name === "Bloc");
  const edit = await erin.put(`/programs/${bloc.id}`, {
    name: "Bloc",
    start: addDays(start, 7),
    end: addDays(start, 27),
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const fallback = (await erin.get("/programs")).data.programs.find(x => x.name === "Hors programme");
  assert.equal(fallback.is_default, 1, "le programme technique reste marqué (donc caché)");
  // un second programme sur d'autres dates reste possible (pas de chevauchement avec 1970 → 2100)
  assert.equal(
    (await erin.post("/programs", {name: "Bloc 2", start: addDays(start, 35), end: addDays(start, 55)})).status,
    200
  );
});

test("scores des WOD de programmation : saisie facultative et historique personnel par WOD", async () => {
  const fields = {name: "Score programmation", activity_id: activityId, duration_minutes: 60};
  const wods = `/programs/${programId}/wods`;
  assert.equal((await alice.post(wods, {...fields, score_type: "reps"})).status, 400);
  const created = await alice.post(wods, {...fields, score_type: "rounds"});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const wid = created.data.id,
    path = `/wods/${wid}/scores`,
    body = sessionBody({wod_id: wid});
  assert.equal((await alice.get(wods)).data.wods.find(w => w.id === wid).score_type, "rounds");
  assert.equal((await client(worker.base).get(path)).status, 401);
  assert.equal((await alice.post("/sessions", {...body, score_value: 2.5})).status, 400);
  assert.equal((await alice.post("/sessions", {...body, score_value: true})).status, 400);
  assert.equal((await alice.post("/sessions", {...body, score_type: "load", score_value: 100})).status, 400);
  assert.equal((await alice.post("/sessions", body)).status, 200);
  const first = {
    ...body,
    session_date: addDays(today(), -7),
    score_type: "rounds",
    score_value: 4,
    client_id: randomUUID(),
  };
  assert.equal((await alice.post("/sessions", first)).status, 200);
  assert.equal((await alice.post("/sessions", first)).data.id, first.client_id);
  assert.deepEqual((await bob.get(path)).data.scores, []);

  // Les WOD changent de configuration sans changer l’unité des scores précédents.
  assert.equal((await alice.put(`/wods/${wid}`, {...fields, score_type: "time"})).status, 200);
  assert.equal((await alice.put(`/sessions/${first.client_id}`, {...first, score_value: 5})).status, 200);
  assert.equal((await alice.post("/sessions", {...body, score_value: 86401})).status, 400);
  const second = await alice.post("/sessions", {...body, score_value: 125});
  assert.equal(second.status, 200);
  assert.equal((await alice.put(`/wods/${wid}`, {...fields, score_type: "load"})).status, 200);
  assert.equal((await alice.put(`/wods/${wid}`, fields)).status, 200);
  assert.equal((await alice.post("/sessions", {...body, score_value: 0})).status, 400);
  const third = await alice.post("/sessions", {...body, session_date: addDays(today(), -1), score_value: 82.5});
  assert.equal(third.status, 200);
  const scores = (await alice.get(path)).data.scores;
  assert.deepEqual(
    scores.map(s => [s.score_type, s.score_value]),
    [
      ["time", 125],
      ["load", 82.5],
      ["rounds", 5],
    ]
  );
  const week = (await alice.get(`/week-data?from=${today()}&to=${today()}`)).data.sessions;
  assert.equal(week.find(s => s.id === second.data.id).score_type, "time");
  assert.equal((await alice.put(`/sessions/${second.data.id}`, body)).status, 200);
  assert.equal((await alice.get(path)).data.scores[0].score_value, 125, "une ancienne saisie préserve le score");
  assert.equal((await alice.put(`/sessions/${second.data.id}`, {...body, score_value: null})).status, 200);
  assert.equal((await alice.del(`/sessions/${third.data.id}`)).status, 200);
  assert.deepEqual(
    (await alice.get(path)).data.scores.map(s => s.id),
    [first.client_id]
  );
  assert.deepEqual((await alice.get(`/wods/${wodId}/scores`)).data.scores, []);
});
