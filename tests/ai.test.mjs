// Génération de WOD par IA : profil, contrôles d'accès et de saisie, appel à un faux service OpenAI local.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";
import {aiCost} from "../src/ai.js";

const PASSWORD = "MotDePasse-Test-123";
const FAKE_WOD = {
  titre: "Squat et sprint",
  duree_estimee_min: 60,
  blocs: [
    {type: "echauffement", duree_min: 10, format: null, time_cap_min: null, description: "Mobilité", mouvements: []},
    {
      type: "force",
      duree_min: 20,
      format: "5x5",
      time_cap_min: null,
      description: "Monter progressivement",
      mouvements: [{nom: "Back squat", reps: "5", charge: "75% 1RM", scaling: null}],
    },
  ],
  objectif_score: null,
  notes_coach: "Bonne séance",
};
let worker,
  openai,
  requests = [],
  admin,
  alice,
  bob,
  programId,
  wodId,
  squatId,
  week;

before(async () => {
  openai = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      requests.push({auth: req.headers.authorization, body: JSON.parse(raw)});
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "gpt-5-mini-2025-08-07",
          status: "completed",
          usage: {
            input_tokens: 1000,
            input_tokens_details: {cached_tokens: 200},
            output_tokens: 500,
            output_tokens_details: {reasoning_tokens: 300},
          },
          output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(FAKE_WOD)}]}],
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
  await admin.post("/admin/movements", {name: "Back squat", measurement_method: "load"});
  squatId = (await alice.get("/movement-catalog")).data.movements.find(m => m.name === "Back squat").id;
  const activityId = (await alice.get("/activities")).data.activities[0].id;
  week = mondayOf(today());
  const program = await alice.post("/programs", {name: "Force IA", start: week, end: addDays(week, 7)});
  programId = program.data.id;
  const wod = await alice.post(`/programs/${programId}/wods`, {
    name: "WOD 1",
    activity_id: activityId,
    duration_minutes: 60,
  });
  wodId = wod.data.id;
});
after(() => {
  worker?.stop();
  openai?.close();
});

const options = extra => ({
  week_start: week,
  duration_minutes: 60,
  blocks: {echauffement: true, technique: false, force: true, metcon: false, retour_au_calme: false},
  force_movements: [squatId],
  ...extra,
});

test("IA : profil d'entraînement", async () => {
  const empty = await alice.get("/ai-profile");
  assert.equal(empty.status, 200);
  assert.equal(empty.data.enabled, true);
  assert.equal(empty.data.remaining, 100);
  assert.equal((await alice.put("/ai-profile", {level: "expert"})).status, 400);
  assert.equal(
    (
      await alice.put("/ai-profile", {
        level: "intermediaire",
        goals: "Force",
        equipment: "",
        constraints: "Pas de course",
      })
    ).status,
    200
  );
  assert.equal((await alice.get("/ai-profile")).data.profile.constraints, "Pas de course");
  assert.equal((await bob.get("/ai-profile")).data.profile.level, "");
});

test("IA : contrôles d'accès et de saisie", async () => {
  assert.equal((await bob.post(`/wods/${wodId}/generate`, options())).status, 404);
  assert.equal(
    (await alice.post(`/wods/${wodId}/generate`, options({blocks: {echauffement: false}}))).status,
    400,
    "au moins un bloc"
  );
  assert.equal(
    (await alice.post(`/wods/${wodId}/generate`, options({force_movements: ["a", "b", "c", "d", "e", "f"]}))).status,
    400,
    "5 mouvements au plus"
  );
  assert.equal((await alice.post(`/wods/${wodId}/generate`, options({duration_minutes: 5}))).status, 400);
  assert.equal((await alice.post(`/wods/${wodId}/generate`, options({week_start: addDays(week, 28)}))).status, 400);
  assert.equal(requests.length, 0, "aucun appel au service d'IA pour une demande refusée");
});

test("IA : génération d'un WOD pour une semaine", async () => {
  const res = await alice.post(`/wods/${wodId}/generate`, options({instructions: "Focus jambes"}));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  // pas de titre en tête : le contenu commence par le premier bloc
  assert.match(res.data.content, /^🔥 ÉCHAUFFEMENT — 10 min\n/);
  assert.match(res.data.content, /\n\n🏋️ FORCE — 5x5 · 20 min\n/);
  assert.doesNotMatch(res.data.content, /Squat et sprint/);
  assert.match(res.data.content, /• 5 Back squat @ 75% 1RM/);
  const call = requests.at(-1);
  assert.equal(call.auth, "Bearer cle-de-test");
  assert.equal(call.body.text.format.type, "json_schema");
  assert.equal(call.body.text.format.strict, true);
  assert.match(call.body.input, /Niveau : Intermédiaire/);
  assert.match(call.body.input, /Contraintes : Pas de course/);
  assert.match(call.body.input, /Force : oui — mouvements imposés : Back squat/);
  assert.match(call.body.input, /Metcon : non/);
  assert.match(call.body.input, /Consigne particulière : Focus jambes/);
  const data = (await alice.get("/program-data")).data;
  assert.equal(
    data.weeklyWodPrograms.find(x => x.wod_id === wodId && x.week_start === week)?.content,
    res.data.content
  );
  assert.equal(data.wods[programId].find(w => w.id === wodId)?.is_tracked, 1, "le WOD devient suivi");
  // Blocs enregistrés pour le détail (un par rubrique), oubliés si le texte est modifié à la main.
  const entry = () => data.weeklyWodPrograms.find(x => x.wod_id === wodId && x.week_start === week);
  const blocks = JSON.parse(entry().blocks);
  assert.deepEqual(
    blocks.slice(0, 2).map(b => b.label),
    ["Échauffement", "Force"]
  );
  assert.match(blocks[1].text, /^5x5 · 20 min\n/);
  assert.match(blocks[1].text, /• 5 Back squat @ 75% 1RM/);
  await alice.put(`/wods/${wodId}/weekly-programming`, {week_start: week, content: res.data.content});
  const kept = (await alice.get("/program-data")).data.weeklyWodPrograms;
  assert.ok(kept.find(x => x.wod_id === wodId && x.week_start === week).blocks, "texte inchangé : blocs gardés");
  await alice.put(`/wods/${wodId}/weekly-programming`, {week_start: week, content: "Modifié à la main"});
  const edited = (await alice.get("/program-data")).data.weeklyWodPrograms;
  assert.equal(
    edited.find(x => x.wod_id === wodId && x.week_start === week).blocks,
    null,
    "texte modifié : blocs oubliés"
  );
  assert.equal((await alice.get("/ai-profile")).data.remaining, 99);
});

test("WOD de programme : mouvements à travailler, repris par l'IA et acceptés dans la séance", async () => {
  await admin.post("/admin/movements", {name: "Deadlift", measurement_method: "load"});
  const catalog = (await alice.get("/movement-catalog")).data.movements,
    deadliftId = catalog.find(m => m.name === "Deadlift").id,
    activityId = (await alice.get("/activities")).data.activities[0].id,
    body = extra => ({name: "WOD 1", activity_id: activityId, duration_minutes: 60, is_tracked: true, ...extra});
  // enregistrés avec le WOD (identifiants inconnus ignorés), remplacés seulement si la liste est envoyée
  assert.equal((await alice.put(`/wods/${wodId}`, body({catalog_movement_ids: [squatId, "inconnu"]}))).status, 200);
  assert.equal((await bob.put(`/wods/${wodId}`, body({catalog_movement_ids: []}))).status, 404);
  assert.equal((await alice.put(`/wods/${wodId}`, body())).status, 200);
  const wodOf = async () => (await alice.get("/program-data")).data.wods[programId].find(w => w.id === wodId);
  assert.deepEqual((await wodOf()).movement_ids, [squatId]);
  // repris dans le prompt de génération
  const res = await alice.post(`/wods/${wodId}/generate`, options());
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(requests.at(-1).body.input, /Mouvements à travailler dans ce WOD : Back squat/);
  // programme avec une liste « Focus mouvement » sans le squat : le squat du WOD est quand même accepté dans la
  // séance, pas un autre mouvement du catalogue
  assert.equal((await alice.post(`/programs/${programId}/movements`, {catalog_movement_id: deadliftId})).status, 200);
  const session = await alice.post("/sessions", {
    program_id: programId,
    wod_id: wodId,
    session_date: today(),
    activity_id: activityId,
    duration_minutes: 60,
    actual_comment: "",
    movement_ids: [],
    catalog_movement_ids: [squatId, deadliftId],
  });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const week = (await alice.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`)).data;
  assert.deepEqual(
    week.catalogChecks.filter(c => c.session_id === session.data.id).map(c => c.catalog_movement_id),
    [squatId]
  );
});

test("IA : suivi des tokens et du coût, réservé à l'administrateur", async () => {
  assert.equal((await alice.get("/admin/ai-usage")).status, 403);
  const before = (await admin.get("/admin/ai-usage")).data;
  assert.equal((await alice.post(`/wods/${wodId}/generate`, options())).status, 200);
  const res = await admin.get("/admin/ai-usage");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const wod = res.data.features.find(f => f.feature === "wod"),
    prev = before.features.find(f => f.feature === "wod");
  assert.equal(wod.day.calls, prev.day.calls + 1);
  assert.equal(wod.month.input_tokens - prev.month.input_tokens, 1000);
  assert.equal(wod.day.cached_tokens - prev.day.cached_tokens, 200);
  assert.equal(wod.day.output_tokens - prev.day.output_tokens, 500);
  assert.equal(wod.day.reasoning_tokens - prev.day.reasoning_tokens, 300);
  assert.ok(
    Math.abs(
      wod.day.cost -
        prev.day.cost -
        aiCost("gpt-5-mini-2025-08-07", {input_tokens: 1000, cached_tokens: 200, output_tokens: 500})
    ) < 1e-9
  );
  assert.equal(
    res.data.day.calls,
    res.data.features.reduce((n, f) => n + f.day.calls, 0)
  );
  assert.deepEqual(
    res.data.features.map(f => f.feature),
    ["wod", "wod_du_jour", "wod_commun", "repas", "bilan_mensuel"]
  );
  // 800 entrée à 0,25 $ + 200 en cache à 0,025 $ + 500 sortie à 2 $ (par million) ; modèle inconnu : pas de coût
  assert.ok(
    Math.abs(aiCost("gpt-5-mini", {input_tokens: 1000, cached_tokens: 200, output_tokens: 500}) - 0.001205) < 1e-12
  );
  assert.equal(aiCost("modele-inconnu", {input_tokens: 10}), null);
});
