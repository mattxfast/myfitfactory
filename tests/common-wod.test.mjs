// WOD commun du jour : une seule génération par jour (faux service OpenAI local), « Je le fais », séance avec score,
// classement (prénom et initiale), réglage de la notification.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {startWorker, client, ADMIN_EMAIL, today} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
const FAKE = {
  titre: "Chipper du jour",
  duree_estimee_min: 60,
  blocs: [
    {type: "echauffement", duree_min: 10, format: null, time_cap_min: null, description: "Mobilité", mouvements: []},
    {
      type: "metcon",
      duree_min: 20,
      format: "For Time",
      time_cap_min: 20,
      description: "Le plus vite possible",
      mouvements: [{nom: "Thruster", reps: "50", charge: "43/30 kg", scaling: "Goblet squat 16 kg"}],
    },
  ],
  objectif_score: "Moins de 12 min",
  notes_coach: null,
  score_type: "time",
};
let worker,
  openai,
  calls = 0,
  admin,
  alice,
  bob,
  activityId;
before(async () => {
  openai = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "faux-modele",
          status: "completed",
          output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(FAKE)}]}],
        })
      );
    });
  });
  await new Promise(r => openai.listen(0, "127.0.0.1", r));
  worker = await startWorker(undefined, {
    OPENAI_API_KEY: "cle-de-test",
    OPENAI_API_URL: `http://127.0.0.1:${openai.address().port}/v1/responses`,
  });
  admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD});
  await alice.post("/register", {email: "alice@test.local", password: PASSWORD});
  await bob.post("/register", {email: "bob@test.local", password: PASSWORD});
  await alice.put("/profile", {first_name: "Alice", last_name: "Martin"});
  await bob.put("/profile", {first_name: "Bob", last_name: "Durand"});
  activityId = (await alice.get("/activities")).data.activities[0].id;
});
after(() => {
  worker?.stop();
  openai?.close();
});

let wodId;
test("WOD commun : une seule génération par jour, réservée à l'administrateur hors tâche planifiée", async () => {
  assert.equal((await alice.get("/preferences")).data.common_wod, 0, "option désactivée par défaut");
  for (const who of [alice, bob]) assert.equal((await who.put("/preferences", {common_wod: true})).status, 200);
  assert.equal((await alice.get("/common-wod")).data.wod, null, "pas encore généré");
  assert.equal((await alice.post("/admin/common-wod")).status, 403);
  const res = await admin.post("/admin/common-wod");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.wod.title, "Chipper du jour");
  assert.equal(res.data.wod.score_type, "time");
  assert.match(res.data.wod.content, /↳ adapté : Goblet squat 16 kg/, "version adaptée");
  assert.equal((await admin.post("/admin/common-wod")).data.wod.id, res.data.wod.id);
  assert.equal(calls, 1, "le WOD déjà prêt n'est pas regénéré");
  const d = (await alice.get("/common-wod")).data;
  wodId = d.wod.id;
  assert.equal(d.joined_id, null);
  assert.deepEqual(
    d.wod.blocks.map(b => b.label),
    ["Échauffement", "Metcon", "Objectif"]
  );
});

test("WOD commun : « Je le fais », séance avec score et classement", async () => {
  const joined = await alice.post(`/common-wod/${wodId}/join`);
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  assert.equal(joined.data.wod.common_wod_id, wodId);
  assert.equal((await alice.post(`/common-wod/${wodId}/join`)).data.wod.id, joined.data.wod.id, "une seule copie");
  assert.equal((await alice.get("/common-wod")).data.joined_id, joined.data.wod.id);
  const bobWod = (await bob.post(`/common-wod/${wodId}/join`)).data.wod;
  const session = (who, dailyId, score) =>
    who.post("/sessions", {
      program_id: "none",
      wod_id: "other",
      session_date: today(),
      activity_id: activityId,
      duration_minutes: 60,
      actual_comment: "",
      movement_ids: [],
      catalog_movement_ids: [],
      daily_wod_id: dailyId,
      score_value: score,
      score_type: "time",
    });
  assert.equal((await session(alice, joined.data.wod.id, 700)).status, 200);
  assert.equal((await session(bob, bobWod.id, 640)).status, 200);
  assert.equal((await session(bob, joined.data.wod.id, 1)).status, 404, "pas le WOD d'un autre");
  const board = (await alice.get(`/common-wod/${wodId}/leaderboard`)).data.ranking;
  assert.deepEqual(
    board.map(x => [x.rank, x.name, x.value, x.me]),
    [
      [1, "Bob D.", 640, false],
      [2, "Alice M.", 700, true],
    ]
  );
  assert.equal((await alice.get("/common-wod")).data.participants, 2);
});

test("WOD commun : option désactivée, plus de WOD commun proposé", async () => {
  await alice.put("/preferences", {common_wod: false});
  assert.equal((await alice.get("/preferences")).data.common_wod, 0);
  assert.equal((await alice.get("/common-wod")).data.wod, null);
  assert.ok((await bob.get("/common-wod")).data.wod, "chacun son réglage");
});
