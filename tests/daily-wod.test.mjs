// WOD du jour : génération par IA (faux service OpenAI local), contrôles, séance rattachée, remplacement, suppression.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
const FAKE_WOD = {
  titre: "Thrusters et burpees",
  duree_estimee_min: 30,
  blocs: [
    {type: "echauffement", duree_min: 8, format: null, time_cap_min: null, description: "Mobilité", mouvements: []},
    {
      type: "metcon",
      duree_min: 15,
      format: "AMRAP 15 min",
      time_cap_min: null,
      description: "Le plus de tours possible",
      mouvements: [
        {nom: "back squat", reps: "10", charge: "40 kg", scaling: null},
        {nom: "Burpee inconnu", reps: "10", charge: null, scaling: null},
      ],
    },
  ],
  objectif_score: "6 tours",
  notes_coach: "Note de test à omettre",
  chrono: {mode: "amrap", minutes: 15, intervalle_s: null, tours: null, travail_s: null, repos_s: null},
};
let worker,
  openai,
  requests = [],
  alice,
  bob,
  squatId,
  activityId;

before(async () => {
  openai = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const call = JSON.parse(raw);
      requests.push(call);
      const wod = call.input.includes("Force : oui")
        ? {
            ...FAKE_WOD,
            blocs: [
              ...FAKE_WOD.blocs,
              {
                type: "force",
                mouvements: [{nom: "Back squat", reps: "5 x 5", charge: "80 %", scaling: "Plus léger"}],
              },
            ],
          }
        : FAKE_WOD;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "faux-modele",
          status: "completed",
          output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(wod)}]}],
        })
      );
    });
  });
  await new Promise(r => openai.listen(0, "127.0.0.1", r));
  worker = await startWorker(undefined, {
    OPENAI_API_KEY: "cle-de-test",
    OPENAI_API_URL: `http://127.0.0.1:${openai.address().port}/v1/responses`,
  });
  const admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD});
  await alice.post("/register", {email: "alice@test.local", password: PASSWORD});
  await bob.post("/register", {email: "bob@test.local", password: PASSWORD});
  await admin.post("/admin/movements", {name: "Back squat", measurement_method: "load"});
  squatId = (await alice.get("/movement-catalog")).data.movements.find(m => m.name === "Back squat").id;
  activityId = (await alice.get("/activities")).data.activities[0].id;
});
after(() => {
  worker?.stop();
  openai?.close();
});

const request = extra => ({
  wod_date: today(),
  duration_minutes: 30,
  instructions: "Cardio",
  ...extra,
});
const weekData = async who => {
  const week = mondayOf(today());
  return (await who.get(`/week-data?from=${week}&to=${addDays(week, 6)}`)).data;
};

test("WOD du jour : contrôles de saisie", async () => {
  assert.equal((await alice.post("/daily-wods", request({wod_date: addDays(today(), 2)}))).status, 400);
  assert.equal((await alice.post("/daily-wods", request({wod_date: addDays(today(), -1)}))).status, 400);
  assert.equal((await alice.post("/daily-wods", request({duration_minutes: 5}))).status, 400);
  assert.equal((await alice.post("/daily-wods", request({place: "plage"}))).status, 400);
  assert.equal((await alice.post("/daily-wods", request({energy: "excellent"}))).status, 400);
  assert.equal((await alice.post("/daily-wods", request({blocks: {}}))).status, 400);
  assert.equal(requests.length, 0, "aucun appel au service d'IA pour une demande refusée");
});

let dailyId;
test("WOD du jour : génération, chrono et mouvements reconnus", async () => {
  const res = await alice.post("/daily-wods", request({place: "maison", energy: "fatigue"}));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const wod = res.data.wod;
  dailyId = wod.id;
  assert.equal(wod.title, "Thrusters et burpees");
  assert.equal(wod.wod_date, today());
  assert.match(wod.content, /Metcon :\nAMRAP 15 min\n10 back squat @ 40 kg/);
  assert.deepEqual(wod.chrono, {
    mode: "amrap",
    minutes: 15,
    every_seconds: null,
    rounds: null,
    work_seconds: null,
    rest_seconds: null,
  });
  assert.deepEqual(wod.movement_ids, [squatId], "nom du catalogue reconnu sans tenir compte de la casse");
  assert.deepEqual(
    wod.blocks.map(b => b.label).slice(0, 3),
    ["Échauffement", "Metcon", "Objectif"],
    "blocs enregistrés pour le détail par rubrique"
  );
  assert.match(wod.blocks[1].text, /^AMRAP 15 min\nLe plus de tours possible\n• 10 back squat @ 40 kg/);
  const call = requests.at(-1);
  assert.equal(call.text.format.name, "wod_du_jour");
  assert.match(call.input, /Lieu : À la maison/);
  assert.match(call.input, /Forme du jour : Fatigué/);
  assert.match(call.input, /Consigne particulière : Cardio/);
  const data = await weekData(alice);
  assert.equal(data.dailyWods.length, 1);
  assert.equal(data.dailyWods[0].id, dailyId);
  assert.deepEqual(data.dailyWods[0].session_ids, []);
  assert.equal((await weekData(bob)).dailyWods.length, 0, "chacun ne voit que ses WOD du jour");
});

test("WOD du jour : séance rattachée, remplacement et suppression bloqués", async () => {
  // Un autre utilisateur ne peut ni rattacher une séance, ni remplacer, ni supprimer le WOD.
  const session = {
    program_id: "none",
    wod_id: "other",
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 30,
    actual_comment: "",
    movement_ids: [],
    catalog_movement_ids: [squatId],
    daily_wod_id: dailyId,
  };
  assert.equal((await bob.post("/sessions", session)).status, 404);
  assert.equal((await bob.post("/daily-wods", request({replace_id: dailyId}))).status, 404);
  await bob.del("/daily-wods/" + dailyId);
  assert.equal((await weekData(alice)).dailyWods.length, 1, "la suppression par un autre utilisateur est sans effet");

  const saved = await alice.post("/sessions", session);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const data = await weekData(alice),
    s = data.sessions.find(x => x.id === saved.data.id);
  assert.deepEqual(data.dailyWods.find(w => w.id === dailyId).session_ids, [saved.data.id]);
  // Un WOD du jour reste fait si la date de la séance est modifiée vers une autre semaine.
  assert.equal(
    (await alice.put("/sessions/" + saved.data.id, {...session, session_date: addDays(today(), -7)})).status,
    200
  );
  const otherWeek = await weekData(alice);
  assert.ok(!otherWeek.sessions.some(x => x.id === saved.data.id));
  assert.deepEqual(otherWeek.dailyWods.find(w => w.id === dailyId).session_ids, [saved.data.id]);
  assert.equal(s.daily_wod_id, dailyId);
  assert.equal(s.wod_name, "Thrusters et burpees");
  assert.match(s.planned_comment, /Metcon :\nAMRAP 15 min/);
  assert.equal(s.program_name, "Hors programme");

  assert.equal((await alice.post("/daily-wods", request({replace_id: dailyId}))).status, 409);
  assert.equal((await alice.del("/daily-wods/" + dailyId)).status, 409);
  assert.equal((await alice.del("/sessions/" + saved.data.id)).status, 200);
  assert.deepEqual((await weekData(alice)).dailyWods.find(w => w.id === dailyId).session_ids, []);
  const replaced = await alice.post("/daily-wods", request({replace_id: dailyId, wod_date: addDays(today(), 1)}));
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.wod.id, dailyId, "« Autre WOD » remplace le WOD sans en créer un nouveau");
  assert.equal(replaced.data.wod.wod_date, addDays(today(), 1));
  assert.equal((await alice.del("/daily-wods/" + dailyId)).status, 200);
});

test("WOD du jour : utilise les blocs et les mouvements choisis dans le formulaire commun", async () => {
  assert.equal((await alice.put("/ai-profile", {equipment: "Rack et barre"})).status, 200);
  const res = await alice.post(
    "/daily-wods",
    request({duration_minutes: 180, blocks: {force: true}, force_movements: [squatId]})
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(requests.at(-1).input, /Durée totale : 180 min/);
  assert.match(requests.at(-1).input, /Matériel habituel : Rack et barre/);
  assert.doesNotMatch(requests.at(-1).input, /^(Lieu|Forme du jour) :/m);
  assert.match(requests.at(-1).input, /Force : oui — mouvements imposés : Back squat/);
  assert.match(requests.at(-1).input, /Metcon : non/);
  assert.equal(res.data.wod.content, "Thrusters et burpees\n\nForce :\n5 x 5 Back squat @ 80 %");
  assert.equal(res.data.wod.chrono, null);
  const missing = await alice.post("/daily-wods", request({blocks: {technique: true}}));
  assert.equal(missing.status, 502);
  assert.equal((await weekData(alice)).dailyWods.length, 1);
});
