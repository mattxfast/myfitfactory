// Score de forme : calcul des piliers (fonctions pures) et route GET /api/fitness-score avec le profil d'athlète.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {computeFitness, levelPoints, ageFactor, epley1RM, athleteProfileInput} from "../src/fitness.js";
import {startWorker, client, ADMIN_EMAIL, today, addDays} from "./helpers.mjs";

const TODAY = "2026-11-20";
const catalog = [
  {name: "Back Squat", measurement_method: "force"},
  {name: "Deadlift", measurement_method: "force"},
  {name: "Snatch", measurement_method: "load"},
  {name: "Pull-up", measurement_method: "reps"},
];
const rec = (name, method, value, date, reps = null, id = name) => ({
  movement_id: id,
  name,
  measurement_method: method,
  value,
  rep_count: reps,
  record_date: date,
  created_at: date,
});

test("forme : repères et ajustements", () => {
  assert.equal(levelPoints(1.0, [1, 1.5, 2, 2.5]), 25);
  assert.equal(levelPoints(1.75, [1, 1.5, 2, 2.5]), 62.5);
  assert.equal(levelPoints(3, [1, 1.5, 2, 2.5]), 100);
  assert.equal(levelPoints(0.5, [1, 1.5, 2, 2.5]), 12.5);
  assert.equal(ageFactor(30), 1);
  assert.equal(ageFactor(45), 1.1);
  assert.equal(ageFactor(80), 1.3);
  assert.equal(Math.round(epley1RM(100, 3)), 110);
});

test("forme : piliers et score global", () => {
  const sessionDates = [];
  for (let w = 0; w < 8; w++) for (let s = 0; s < 3; s++) sessionDates.push(addDays(TODAY, -(w * 7 + s)));
  const r = computeFitness({
    today: TODAY,
    profile: {body_weight_kg: 80, birth_date: "1990-05-01", sex: "M"},
    records: [
      rec("Back Squat", "force", 140, "2026-08-01"),
      rec("Back Squat", "force", 150, "2026-11-01"),
      rec("Snatch", "load", 80, "2026-10-01"),
      rec("Pull-up", "reps", 15, "2026-10-15"),
      {...rec("Rameur", "distance", 432, "2026-11-10"), fixed_kind: "distance", fixed_value: 2000},
    ],
    sessionDates,
    movementNames: ["Back Squat", "Snatch", "Pull-up", "Deadlift"],
    catalog,
    boxResults: [
      {rank: 1, total: 5, categoryIndex: 0},
      {rank: 3, total: 5, categoryIndex: 1},
    ],
  });
  const p = Object.fromEntries(r.pillars.map(x => [x.key, x.score]));
  assert.equal(p.regularite, 80, "3 séances / semaine sur 8 semaines actives");
  assert.equal(p.force, 70, "back squat 150 kg pour 80 kg = 1,875 × PdC, +1 % à 36 ans");
  assert.equal(p.halterophilie, 66, "snatch 1 × PdC : entre intermédiaire (0,85) et avancé (1,1)");
  assert.equal(p.gym, 63, "15 pull-ups");
  assert.equal(p.conditionnement, 71, "1er / 5 en RX, 3e / 5 en 2e catégorie");
  assert.equal(p.polyvalence, 53, "4 mouvements, 3 familles sur 3");
  assert.equal(p.engine, 81, "rameur 2 km en 7:12 : entre avancé (7:15) et élite (6:45)");
  assert.equal(p.progression, 50, "1 PR battu, 3 premiers PR (le squat d'août date de plus de 90 jours)");
  assert.ok(r.score > 0 && r.score <= 100);
  assert.equal(r.complete, true);
  assert.deepEqual(r.profile_missing, []);
});

test("forme : la polyvalence compte les catégories du catalogue même si la mesure est identique", () => {
  const r = computeFitness({
    today: TODAY,
    movementNames: ["Abdos"],
    catalog: [
      {name: "Abdos", category: "core", measurement_method: "reps"},
      {name: "Burpees", category: "functional", measurement_method: "reps"},
    ],
  });
  const pillar = r.pillars.find(p => p.key === "polyvalence");
  assert.equal(pillar.score, 21);
  assert.match(pillar.detail, /1 famille sur 2/);
});

test("forme : piliers à compléter sans poids de corps ni données", () => {
  const r = computeFitness({
    today: TODAY,
    profile: {},
    records: [rec("Back Squat", "force", 100, "2026-11-01")],
    sessionDates: [],
    movementNames: [],
    catalog,
    boxResults: [],
  });
  const p = Object.fromEntries(r.pillars.map(x => [x.key, x]));
  assert.equal(p.force.score, null);
  assert.match(p.force.hint, /poids de corps/);
  assert.equal(p.conditionnement.score, null);
  assert.equal(p.regularite.score, 0);
  assert.deepEqual(r.profile_missing, ["poids de corps", "sexe", "date de naissance"]);
  assert.equal(r.complete, false);
});

test("forme : validation du profil d'athlète", () => {
  assert.deepEqual(athleteProfileInput({body_weight_kg: "72.35", sex: "F", birth_date: "1990-02-28"}), {
    body_weight_kg: 72.4,
    sex: "F",
    birth_date: "1990-02-28",
  });
  assert.ok(athleteProfileInput({body_weight_kg: 10}).error);
  assert.ok(athleteProfileInput({sex: "X"}).error);
  assert.ok(athleteProfileInput({birth_date: "1990-02-30"}).error);
  assert.deepEqual(athleteProfileInput({body_weight_kg: "", birth_date: ""}), {body_weight_kg: null, birth_date: null});
  assert.deepEqual(athleteProfileInput({first_name: "A"}), {}, "champs absents : inchangés");
});

let worker, alice, bob;
before(async () => {
  worker = await startWorker();
  const admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: "MotDePasse-Test-123"});
  await alice.post("/register", {email: "alice@test.local", password: "MotDePasse-Test-123"});
  await bob.post("/register", {email: "bob@test.local", password: "MotDePasse-Test-123"});
  await admin.post("/admin/movements", {name: "Back Squat", measurement_method: "force"});
});
after(() => worker?.stop());

test("forme : profil d'athlète enregistré et score calculé par le serveur", async () => {
  assert.equal((await alice.put("/profile", {first_name: "Alice", last_name: "A", body_weight_kg: 500})).status, 400);
  assert.equal(
    (await alice.put("/profile", {first_name: "Alice", last_name: "A", birth_date: addDays(today(), -30)})).status,
    400,
    "date de naissance trop récente"
  );
  const saved = await alice.put("/profile", {
    first_name: "Alice",
    last_name: "A",
    body_weight_kg: 60,
    birth_date: "1992-03-14",
    sex: "F",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.user.body_weight_kg, 60);
  // Un enregistrement des seuls prénom et nom (fenêtre d'accueil des box) garde le profil d'athlète.
  await alice.put("/profile", {first_name: "Alice", last_name: "B"});
  const me = (await alice.get("/me")).data.user;
  assert.deepEqual([me.body_weight_kg, me.birth_date, me.sex], [60, "1992-03-14", "F"]);

  const squat = (await alice.get("/movement-catalog")).data.movements.find(m => m.name === "Back Squat").id;
  assert.equal(
    (await alice.post("/prs", {movement_id: squat, record_date: today(), value: 90, rep_count: 1})).status,
    200
  );
  const r = await alice.get("/fitness-score");
  assert.equal(r.status, 200);
  const force = r.data.pillars.find(x => x.key === "force");
  assert.ok(force.score > 50, "squat 1,5 × PdC pour une femme : niveau intermédiaire à avancé");
  assert.equal(r.data.pillars.length, 8);
  const other = await bob.get("/fitness-score");
  assert.equal(other.data.pillars.find(x => x.key === "force").score, null, "chacun son score");
});

test("PR Engine : temps sur une distance et distance dans un temps", async () => {
  const admin = client(worker.base);
  await admin.post("/login", {email: ADMIN_EMAIL, password: "MotDePasse-Test-123"});
  await admin.post("/admin/movements", {name: "Rameur", measurement_method: "distance"});
  const row = (await alice.get("/movement-catalog")).data.movements.find(m => m.name === "Rameur").id;
  const pr = extra => alice.post("/prs", {movement_id: row, record_date: today(), ...extra});
  assert.equal((await pr({fixed_kind: "distance", fixed_value: 5, value: 100})).status, 400, "distance trop courte");
  assert.equal((await pr({fixed_kind: "distance", fixed_value: 2000, value: 432.5})).status, 400, "temps en secondes");
  assert.equal((await pr({fixed_kind: "time", fixed_value: 5, value: 1000})).status, 400, "durée trop courte");
  assert.equal((await pr({fixed_kind: "vitesse", fixed_value: 60, value: 300})).status, 400, "format inconnu");
  assert.equal((await pr({fixed_kind: "distance", fixed_value: 2000, value: 450})).status, 200);
  assert.equal((await pr({fixed_kind: "distance", fixed_value: 2000, value: 432})).status, 200);
  assert.equal((await pr({fixed_kind: "time", fixed_value: 720, value: 3000})).status, 200);
  const records = (await alice.get("/prs")).data.records.filter(x => x.movement_id === row);
  assert.deepEqual(
    records.map(x => [x.fixed_kind, x.fixed_value, x.value]),
    [
      ["distance", 2000, 450],
      ["distance", 2000, 432],
      ["time", 720, 3000],
    ]
  );
  const score = await alice.get("/fitness-score");
  const engine = score.data.pillars.find(x => x.key === "engine");
  assert.ok(engine.score > 0, "pilier Engine calculé à partir des PR de rameur");
  assert.equal((await bob.get("/prs")).data.records.length, 0, "chacun ses PR");
});

test("PR chronométrés : deux formats en répétitions et conservation des anciens PR", async () => {
  const admin = client(worker.base);
  await admin.post("/login", {email: ADMIN_EMAIL, password: "MotDePasse-Test-123"});
  const rated = await admin.post("/admin/movements", {name: "Burpees", measurement_method: "reps_time"});
  assert.equal(rated.status, 200);
  const movement = {name: "Pull-up", measurement_method: "reps"};
  const created = await admin.post("/admin/movements", movement);
  assert.equal(created.status, 200);
  const movementId = created.data.id,
    route = "/admin/movements/" + movementId,
    base = {movement_id: movementId, record_date: addDays(today(), -7)};
  const pr = (offset, extra) => bob.post("/prs", {...base, record_date: addDays(today(), offset), ...extra});
  const old = await pr(-7, {value: 15});
  assert.equal(old.status, 200);
  const score = async key => (await bob.get("/fitness-score")).data.pillars.find(p => p.key === key);
  const gymBefore = await score("gym");

  assert.equal((await admin.put(route, {...movement, measurement_method: "reps_time"})).status, 200);
  const catalog = (await bob.get("/movement-catalog")).data.movements.find(m => m.id === movementId);
  assert.equal(catalog.category, "gym");
  for (const extra of [
    {fixed_kind: "distance", fixed_value: 20, value: 50},
    {fixed_kind: "reps", fixed_value: 15.5, value: 60},
    {fixed_kind: "reps", fixed_value: 20, value: 50.5},
    {fixed_kind: "time", fixed_value: 5, value: 22},
    {fixed_kind: "time", fixed_value: 90, value: 22.5},
  ]) {
    assert.equal((await pr(0, extra)).status, 400);
  }
  assert.equal((await pr(-6, {fixed_kind: "reps", fixed_value: 20, value: 60})).status, 200);
  assert.equal((await pr(-5, {fixed_kind: "reps", fixed_value: 20, value: 50})).status, 200);
  assert.equal((await pr(-4, {fixed_kind: "reps", fixed_value: 20, value: 70})).status, 200);
  assert.equal((await pr(-3, {fixed_kind: "time", fixed_value: 90, value: 22})).status, 200);
  const timed = await pr(-2, {fixed_kind: "time", fixed_value: 90, value: 27});
  assert.equal(timed.status, 200);
  assert.equal(
    (
      await bob.put("/prs/" + timed.data.id, {
        ...base,
        record_date: addDays(today(), -2),
        fixed_kind: "time",
        fixed_value: 90,
        value: 28,
      })
    ).status,
    200
  );
  assert.equal((await bob.put("/prs/" + old.data.id, {...base, value: 15})).status, 200);
  assert.equal((await admin.put(route, movement)).status, 409);
  const records = (await bob.get("/prs")).data.records.filter(p => p.movement_id === movementId);
  assert.deepEqual(
    records.map(p => [p.measurement_method, p.fixed_kind, p.fixed_value, p.value, p.rep_count]),
    [
      ["reps_time", null, null, 15, null],
      ["reps_time", "reps", 20, 60, null],
      ["reps_time", "reps", 20, 50, null],
      ["reps_time", "reps", 20, 70, null],
      ["reps_time", "time", 90, 22, null],
      ["reps_time", "time", 90, 28, null],
    ]
  );
  assert.deepEqual(await score("gym"), gymBefore);
  assert.match((await score("progression")).detail, /2 PR battus et 3 nouveaux PR/);
});
