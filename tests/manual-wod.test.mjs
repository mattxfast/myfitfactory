// WOD saisi à la main (page Séances) : création rejouable, contrôles, modification tant qu'aucune séance n'y est
// rattachée, score de la séance selon le type choisi.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
let worker, alice, bob, activityId;
const weekData = async who => {
  const week = mondayOf(today());
  return (await who.get(`/week-data?from=${week}&to=${addDays(week, 6)}`)).data;
};
before(async () => {
  worker = await startWorker();
  const admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD});
  await alice.post("/register", {email: "alice@test.local", password: PASSWORD});
  await bob.post("/register", {email: "bob@test.local", password: PASSWORD});
  activityId = (await alice.get("/activities")).data.activities[0].id;
});
after(() => worker?.stop());

const wod = extra => ({
  client_id: crypto.randomUUID(),
  wod_date: today(),
  name: "Mon chipper",
  blocks: {warmup: "3 tours : 10 air squats", metcon: "For Time\n50 wall balls\n50 burpees"},
  score_type: "time",
  ...extra,
});

let wodId;
test("WOD manuel : création rejouable et contrôles", async () => {
  assert.equal((await alice.post("/daily-wods/manual", wod({blocks: {metcon: "  "}}))).status, 400, "au moins un bloc");
  assert.equal((await alice.post("/daily-wods/manual", wod({wod_date: addDays(today(), 3)}))).status, 400);
  assert.equal((await alice.post("/daily-wods/manual", wod({score_type: "points"}))).status, 400);
  const body = wod();
  const res = await alice.post("/daily-wods/manual", body);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  wodId = res.data.wod.id;
  assert.equal(wodId, body.client_id);
  assert.equal((await alice.post("/daily-wods/manual", body)).data.wod.id, wodId, "rejeu sans doublon");
  const w = (await weekData(alice)).dailyWods.find(x => x.id === wodId);
  assert.equal(w.title, "Mon chipper");
  assert.equal(w.score_type, "time");
  assert.deepEqual(
    w.blocks.map(b => b.label),
    ["Échauffement", "Metcon"]
  );
  assert.deepEqual(w.manual.blocks.metcon, "For Time\n50 wall balls\n50 burpees");
  assert.match(w.content, /^Mon chipper\n\nÉchauffement\n3 tours/);
  assert.equal((await weekData(bob)).dailyWods.length, 0, "chacun ses WOD");
});

test("WOD manuel : modification, séance avec score, puis modification bloquée", async () => {
  assert.equal((await bob.put("/daily-wods/" + wodId, wod({name: "Pirate"}))).status, 404);
  const edited = await alice.put("/daily-wods/" + wodId, wod({name: "", score_type: "reps"}));
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.wod.title, "Mon WOD", "nom par défaut");
  const session = {
    program_id: "none",
    wod_id: "other",
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 30,
    actual_comment: "",
    movement_ids: [],
    catalog_movement_ids: [],
    daily_wod_id: wodId,
  };
  assert.equal((await alice.post("/sessions", {...session, score_value: 0})).status, 400, "répétitions positives");
  const saved = await alice.post("/sessions", {...session, score_value: 120, score_type: "reps"});
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const s = (await weekData(alice)).sessions.find(x => x.id === saved.data.id);
  assert.equal(s.score_value, 120);
  assert.equal(s.score_type, "reps");
  assert.equal((await alice.put("/daily-wods/" + wodId, wod())).status, 409, "séance rattachée");
  // Un WOD généré (ou de référence) ne se modifie pas.
  const bench = await alice.post("/daily-wods/benchmark", {
    client_id: crypto.randomUUID(),
    benchmark_id: (await alice.get("/benchmarks")).data.benchmarks[0].id,
    wod_date: today(),
  });
  assert.equal((await alice.put("/daily-wods/" + bench.data.wod.id, wod())).status, 400);
});
