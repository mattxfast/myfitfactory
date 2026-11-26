import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const date = today(),
  monday = mondayOf(date),
  end = addDays(monday, 6),
  week = `/week-data?from=${monday}&to=${end}`,
  programBody = {name: "Programme cardio", start: monday, end, is_public: true};
let worker, admin, alice, bob, guest, programId, wodId, activityId;

before(async () => {
  worker = await startWorker();
  [admin, alice, bob, guest] = ["1", "2", "3", "4"].map(n => client(worker.base, "203.0.113." + n));
  for (const [actor, email] of [
    [admin, ADMIN_EMAIL],
    [alice, "alice@test.local"],
    [bob, "bob@test.local"],
  ])
    assert.equal((await actor.post("/register", {email, password: "MotDePasse-Test-123"})).status, 200);
  activityId = (await alice.get("/activities")).data.activities[0].id;
  const p = await alice.post("/programs", {...programBody, weekly_cardio_target_min: 3, weekly_cardio_target_max: 4});
  assert.equal(p.status, 200, JSON.stringify(p.data));
  programId = p.data.id;
  const w = await alice.post(`/programs/${programId}/wods`, {
    name: "Séance prévue",
    activity_id: activityId,
    duration_minutes: 40,
  });
  assert.equal(w.status, 200);
  wodId = w.data.id;
});
after(() => worker?.stop());

const session = extra => ({
  program_id: programId,
  wod_id: wodId,
  session_date: date,
  activity_id: activityId,
  duration_minutes: 40,
  ...extra,
});
const targets = p => [p.weekly_cardio_target_min, p.weekly_cardio_target_max];
const findProgram = async (actor, route = "/program-data") =>
  (await actor.get(route)).data.programs.find(p => p.id === programId);
const readSession = async (actor, id) => (await actor.get(week)).data.sessions.find(s => s.id === id);

test("objectif cardio : indépendant, nullable et visible dans le programme suivi", async () => {
  const route = "/programs/" + programId;
  assert.deepEqual(targets(await findProgram(alice, "/programs")), [3, 4]);
  assert.deepEqual(targets(await findProgram(alice, "/export-data")), [3, 4]);
  for (const fields of [
    {weekly_cardio_target_min: -1},
    {weekly_cardio_target_max: false},
    {weekly_cardio_target_min: "3"},
    {weekly_cardio_target_max: 3.5},
    {weekly_cardio_target_min: 5, weekly_cardio_target_max: 4},
  ])
    assert.equal((await alice.post("/programs", {...programBody, ...fields})).status, 400);
  assert.equal((await bob.put(route, {...programBody, weekly_cardio_target_min: 5})).status, 404);
  assert.equal((await alice.put(route, {...programBody, weekly_cardio_target_min: 5})).status, 400);
  assert.equal((await alice.put(route, {...programBody, weekly_cardio_target_min: 0})).status, 200);
  assert.equal(
    (await alice.put(route, programBody)).status,
    200,
    "un ancien client peut toujours modifier le programme"
  );
  assert.deepEqual(targets(await findProgram(alice)), [0, 4]);
  assert.equal((await alice.put(route, {...programBody, weekly_cardio_target_min: null})).status, 200);
  assert.deepEqual(targets(await findProgram(bob, "/public-programs")), [null, 4]);
  assert.equal((await bob.put("/program-follow", {program_id: programId})).status, 200);
  assert.deepEqual(targets(await findProgram(bob)), [null, 4]);
  assert.equal((await alice.put(route, {...programBody, weekly_cardio_target_max: null})).status, 200);
  assert.deepEqual(targets(await findProgram(bob)), [null, null]);
});

test("séances web : les cinq niveaux, l’absence de mesure, l’édition et l’isolation", async () => {
  for (const invalid of [-1, 5, 3.5, "4", true, {}, []])
    assert.equal((await alice.post("/sessions", session({cardio_intensity: invalid}))).status, 400);
  for (const value of [0, 1, 2, 3, 4, null, undefined]) {
    const result = await alice.post("/sessions", session(value === undefined ? {} : {cardio_intensity: value}));
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal((await readSession(alice, result.data.id)).cardio_intensity, value ?? null);
  }
  const created = await alice.post("/sessions", session());
  assert.equal(created.status, 200);
  const id = created.data.id,
    route = "/sessions/" + id;
  for (const value of [0, 1, 2, 3, 4, null]) {
    assert.equal((await alice.put(route, session({cardio_intensity: value}))).status, 200);
    assert.equal((await readSession(alice, id)).cardio_intensity, value);
  }
  assert.equal((await alice.put(route, session({cardio_intensity: 4}))).status, 200);
  assert.equal((await alice.put(route, session({actual_comment: "Ancien client"}))).status, 200);
  assert.equal((await alice.put(route, session({cardio_intensity: 7}))).status, 400);
  assert.equal((await bob.put(route, session({cardio_intensity: 0}))).status, 404);
  assert.equal(await readSession(bob, id), undefined);
  assert.equal((await alice.get("/sessions")).data.sessions.find(s => s.id === id).cardio_intensity, 4);
  assert.equal((await alice.get("/export-data")).data.sessions.find(s => s.id === id).cardio_intensity, 4);
});

test("statistiques : séances bonus et hors programme, semaines vides et aucun doublon", async () => {
  const oldDate = addDays(monday, -14),
    old = session({program_id: "none", wod_id: "other", session_date: oldDate, cardio_intensity: 4});
  assert.equal((await bob.post("/sessions", old)).status, 200);
  const moves = [];
  for (const name of ["Squat", "Traction"]) {
    const movement = await admin.post("/admin/movements", {name, measurement_method: "reps"});
    assert.equal(movement.status, 200);
    moves.push(movement.data.id);
  }
  const bonus = session({
    wod_id: "other",
    cardio_intensity: 3,
    catalog_movement_ids: moves,
    client_id: randomUUID(),
  });
  assert.equal((await alice.post("/sessions", bonus)).status, 200);
  assert.equal((await alice.post("/sessions", {...bonus, cardio_intensity: 0})).data.id, bonus.client_id);
  assert.equal(
    (await alice.post("/sessions", session({program_id: "none", wod_id: "other", cardio_intensity: 4}))).status,
    200
  );
  const current = (await alice.get(week)).data;
  assert.equal(current.catalogChecks.filter(x => x.session_id === bonus.client_id).length, 2);
  assert.equal(current.sessions.filter(s => s.id === bonus.client_id).length, 1);
  assert.equal(current.sessions.find(s => s.id === bonus.client_id).program_id, programId);
  assert.equal(current.sessions.filter(s => s.cardio_intensity >= 3 && s.program_id === programId).length, 4);
  const {total, cardio} = (await alice.get("/progress")).data;
  assert.equal(total, 10);
  assert.equal(cardio.total, 5);
  assert.deepEqual(cardio.by_intensity, {unreported: 2, 0: 1, 1: 1, 2: 1, 3: 2, 4: 3});
  const month = (await alice.get("/monthly-report?month=" + date.slice(0, 7))).data;
  assert.deepEqual(month.cardio.by_intensity, cardio.by_intensity);
  assert.equal(month.cardio.weeks.at(-1).count, 5);
  const other = (await bob.get("/progress")).data;
  assert.equal(other.total, 1);
  assert.deepEqual(
    other.cardio.weeks.map(w => w.count),
    [1, 0, 0]
  );
});

test("séances Bearer : contrôle de version et conservation du champ omis", async () => {
  const issue = await alice.call(
    "POST",
    "/api-keys",
    {
      name: "Cardio",
      permissions: ["workouts:read", "workouts:write"],
      expires_on: addDays(date, 7),
    },
    {Origin: worker.base}
  );
  assert.equal(issue.status, 201);
  const headers = {Authorization: "Bearer " + issue.data.token};
  const created = await guest.call("POST", "/sessions", session({cardio_intensity: 4}), headers);
  assert.equal(created.status, 200);
  const id = created.data.id,
    route = "/sessions/" + id;
  const read = async () => (await guest.call("GET", week, undefined, headers)).data.sessions.find(s => s.id === id);
  const write = (body, version) => guest.call("PUT", route, body, {...headers, "If-Match": '"' + version + '"'});
  const first = await read();
  assert.equal(first.cardio_intensity, 4);
  assert.equal((await write({cardio_intensity: "3"}, first.edit_version)).status, 400);
  const changed = await write({actual_comment: "Commentaire modifié"}, first.edit_version);
  assert.equal(changed.status, 200);
  assert.equal((await read()).cardio_intensity, 4);
  assert.equal((await write({cardio_intensity: 0}, first.edit_version)).status, 412);
  const zero = await write({cardio_intensity: 0}, changed.data.edit_version);
  assert.equal(zero.status, 200);
  assert.equal((await read()).cardio_intensity, 0);
  const cleared = await write({cardio_intensity: null}, zero.data.edit_version);
  assert.equal(cleared.status, 200);
  assert.equal((await read()).cardio_intensity, null);
  assert.equal(
    (await write({cardio_intensity: null}, zero.data.edit_version)).data.edit_version,
    cleared.data.edit_version
  );
});
