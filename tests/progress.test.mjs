// Progression (page PR) et bilan mensuel : statistiques calculées par le serveur à partir des séances.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
let worker,
  openai,
  prompts = [],
  admin,
  alice,
  bob,
  activityId,
  catalog;

before(async () => {
  // Faux service OpenAI : commentaire du coach du bilan mensuel.
  openai = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      prompts.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "faux-modele",
          output: [
            {type: "message", content: [{type: "output_text", text: JSON.stringify({commentaire: "Beau mois !"})}]},
          ],
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
  for (const name of ["Back squat", "Pull-up"])
    await admin.post("/admin/movements", {name, measurement_method: "load"});
  catalog = (await alice.get("/movement-catalog")).data.movements;
  activityId = (await alice.get("/activities")).data.activities[0].id;
});
after(() => {
  worker?.stop();
  openai?.close();
});

const session = (date, movements) =>
  alice.post("/sessions", {
    program_id: "none",
    wod_id: "other",
    session_date: date,
    activity_id: activityId,
    duration_minutes: 60,
    actual_comment: "",
    movement_ids: [],
    catalog_movement_ids: movements,
  });

test("progression : depuis la première séance, régularité, répartition et mouvements", async () => {
  const monday = mondayOf(today()),
    squat = catalog.find(m => m.name === "Back squat").id,
    pull = catalog.find(m => m.name === "Pull-up").id;
  // Première séance datée d’un mercredi, puis deux semaines vides dans l’historique.
  for (const [date, moves] of [
    [monday, [squat, pull]],
    [addDays(monday, -7), [squat]],
    [addDays(monday, -6), []],
    [addDays(monday, -26), [squat]],
  ])
    assert.equal((await session(date, moves)).status, 200);
  const d = (await alice.get("/progress")).data;
  assert.equal(d.from, addDays(monday, -28));
  assert.equal(d.to, today());
  assert.deepEqual(
    d.weeks.map(w => w.count),
    [1, 0, 0, 2, 1]
  );
  assert.equal(d.weeks.at(-1).week_start, monday);
  assert.equal(d.total, 4);
  assert.equal(d.active_weeks, 3);
  assert.equal(d.streak_weeks, 2, "la semaine vide arrête la série");
  assert.deepEqual(d.by_source, {prog: 0, box: 0, daily: 0, libre: 4});
  assert.deepEqual(d.movements, [
    {name: "Back squat", count: 3},
    {name: "Pull-up", count: 1},
  ]);
  const other = (await bob.get("/progress")).data;
  assert.equal(other.total, 0, "les séances d'un autre compte ne comptent pas");
  assert.equal(other.from, null);
  assert.deepEqual(other.weeks, []);
  assert.equal(other.streak_weeks, 0);

  const older = await session(addDays(monday, -18 * 7 + 2), [pull]);
  assert.equal(older.status, 200);
  const extended = (await alice.get("/progress")).data;
  assert.equal(extended.from, addDays(monday, -18 * 7));
  assert.equal(extended.weeks.length, 19);
  assert.equal(extended.total, 5);
  assert.equal(extended.streak_weeks, 2);
  assert.equal((await alice.del("/sessions/" + older.data.id)).status, 200);
  assert.equal((await alice.get("/progress")).data.from, d.from);
});

test("bilan mensuel : mois disponibles, bilan d'un mois, commentaire du coach", async () => {
  const month = today().slice(0, 7),
    list = (await alice.get("/monthly-reports")).data;
  assert.equal(list.current, month);
  assert.ok(list.months.some(m => m.month === month && m.sessions >= 1));
  assert.equal((await alice.get("/monthly-report?month=2026-13")).status, 400);
  assert.equal((await alice.get("/monthly-report?month=2999-01")).status, 400);
  const report = (await alice.get("/monthly-report?month=" + month)).data;
  assert.equal(report.month, month);
  assert.equal(report.complete, false, "mois en cours");
  assert.ok(report.total >= 1);
  assert.equal(typeof report.prev_total, "number");
  assert.ok(Array.isArray(report.to_resume) && Array.isArray(report.prs) && Array.isArray(report.benchmarks));
  // commentaire du coach : écrit par l'IA à partir des chiffres, gardé avec le bilan
  const comment = await alice.post("/monthly-report/comment", {month});
  assert.equal(comment.status, 200, JSON.stringify(comment.data));
  assert.equal(comment.data.comment, "Beau mois !");
  assert.match(prompts.at(-1).input, /Séances : \d+ \(mois précédent : \d+\)/);
  assert.equal(prompts.at(-1).text.format.name, "bilan_mensuel");
  assert.equal((await alice.get("/monthly-report?month=" + month)).data.comment, "Beau mois !");
  assert.equal((await bob.get("/monthly-report?month=" + month)).data.comment, "", "bilan propre à chaque compte");
  assert.equal((await bob.post("/monthly-report/comment", {month})).status, 400, "rien à commenter sans séance");
});
