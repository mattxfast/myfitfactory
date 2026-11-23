// Types de WOD (liste commune) : choisis pour un WOD de programme ; la séance prend le type du WOD (non modifiable),
// et le choisit librement en séance libre (« Autres »).
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
let worker, alice, activityId, types, programId;
const weekSessions = async () => {
  const week = mondayOf(today());
  return (await alice.get(`/week-data?from=${week}&to=${addDays(week, 6)}`)).data.sessions;
};
before(async () => {
  worker = await startWorker();
  const admin = client(worker.base);
  alice = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD});
  await alice.post("/register", {email: "alice@test.local", password: PASSWORD});
  activityId = (await alice.get("/activities")).data.activities[0].id;
  types = Object.fromEntries((await alice.get("/wod-types")).data.types.map(t => [t.name, t.id]));
  const week = mondayOf(today());
  programId = (await alice.post("/programs", {name: "Prog", start: week, end: addDays(week, 7)})).data.id;
});
after(() => worker?.stop());

const session = extra => ({
  session_date: today(),
  activity_id: activityId,
  duration_minutes: 60,
  actual_comment: "",
  movement_ids: [],
  catalog_movement_ids: [],
  ...extra,
});

test("types de WOD : WOD de programme typé, séance au type imposé", async () => {
  const body = {name: "WOD 1", activity_id: activityId, duration_minutes: 60};
  assert.equal((await alice.post(`/programs/${programId}/wods`, {...body, type_id: "inconnu"})).status, 400);
  const wod = await alice.post(`/programs/${programId}/wods`, {...body, type_id: types["Haltéro"]});
  assert.equal(wod.status, 200, JSON.stringify(wod.data));
  const wodOf = async () => (await alice.get("/program-data")).data.wods[programId].find(w => w.id === wod.data.id);
  assert.equal((await wodOf()).type_id, types["Haltéro"]);
  // Modification sans type envoyé : type gardé ; type vide : retiré ; puis remis.
  assert.equal((await alice.put(`/wods/${wod.data.id}`, body)).status, 200);
  assert.equal((await wodOf()).type_id, types["Haltéro"]);
  await alice.put(`/wods/${wod.data.id}`, {...body, type_id: ""});
  assert.equal((await wodOf()).type_id, null);
  await alice.put(`/wods/${wod.data.id}`, {...body, type_id: types["Haltéro"]});
  // La séance prend le type du WOD, même si un autre est envoyé.
  const saved = await alice.post(
    "/sessions",
    session({program_id: programId, wod_id: wod.data.id, type_id: types["Gym"]})
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const s = (await weekSessions()).find(x => x.id === saved.data.id);
  assert.equal(s.type_id, types["Haltéro"]);
  assert.equal(s.wod_type_name, "Haltéro");
});

test("types de WOD : séance libre, type au choix (ou aucun)", async () => {
  assert.equal(
    (await alice.post("/sessions", session({program_id: "none", wod_id: "other", type_id: "inconnu"}))).status,
    400
  );
  const free = await alice.post("/sessions", session({program_id: "none", wod_id: "other", type_id: types["Hyrox"]}));
  assert.equal(free.status, 200, JSON.stringify(free.data));
  const none = await alice.post("/sessions", session({program_id: "none", wod_id: "other"}));
  const list = await weekSessions();
  assert.equal(list.find(x => x.id === free.data.id).wod_type_name, "Hyrox");
  assert.equal(list.find(x => x.id === none.data.id).type_id, null);
});
