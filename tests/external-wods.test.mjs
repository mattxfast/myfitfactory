import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const date = today(),
  week = mondayOf(date),
  end = addDays(week, 6);
const programFields = {name: "Programme hybride", start: week, end: addDays(end, 7), is_public: true};
const keyAt = (seconds = Math.floor(Date.now() / 1000)) => seconds + "." + randomUUID();
const weekPath = "/week-data?from=" + week + "&to=" + end;
const password = "MotDePasse-Test-123";
let worker,
  mock,
  alice,
  bob,
  outsider,
  guest,
  key,
  readKey,
  bobKey,
  outsiderKey,
  activity,
  squat,
  bike,
  program,
  model,
  model2;
const iaCalls = [];
const out = {
  titre: "WOD intégré",
  duree_estimee_min: 20,
  blocs: [
    {
      type: "metcon",
      duree_min: 20,
      format: "Amrap",
      time_cap_min: null,
      description: "Circuit intégré",
      mouvements: [],
    },
  ],
  objectif_score: null,
  notes_coach: null,
};
const integrated = {duration_minutes: 20, blocks: {metcon: true}};
const ok = async promise => {
  const result = await promise;
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
};
const idOf = async promise => (await ok(promise)).id;
const createKey = async (actor, permissions) => {
  const result = await actor.call(
    "POST",
    "/api-keys",
    {name: "Coaching", expires_on: addDays(date, 7), permissions},
    {Origin: worker.base}
  );
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.token;
};
before(async () => {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", part => (raw += part));
    req.on("end", () => {
      iaCalls.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "gpt-5-mini-2025-08-07",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({...out, chrono: {mode: "amrap", work_s: 1200, rest_s: null, rounds: null}}),
                },
              ],
            },
          ],
        })
      );
    });
  });
  await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
  worker = await startWorker(undefined, {
    OPENAI_API_KEY: "faux-fournisseur",
    OPENAI_API_URL: "http://127.0.0.1:" + mock.address().port,
  });
  const admin = client(worker.base);
  [alice, bob, outsider, guest] = [client(worker.base), client(worker.base), client(worker.base), client(worker.base)];
  for (const [actor, email] of [
    [admin, ADMIN_EMAIL],
    [alice, "alice@test.local"],
    [bob, "bob@test.local"],
    [outsider, "outside@test.local"],
  ])
    await ok(actor.post("/register", {email, password}));
  const scopes = ["coaching:read", "wods:write", "workouts:write", "plans:write"];
  [key, readKey, bobKey, outsiderKey] = await Promise.all([
    createKey(alice, scopes),
    createKey(alice, ["coaching:read"]),
    createKey(bob, scopes),
    createKey(outsider, scopes),
  ]);
  activity = (await ok(alice.get("/activities"))).activities[0].id;
  squat = await idOf(admin.post("/admin/movements", {name: "Squat externe", measurement_method: "force"}));
  bike = await idOf(admin.post("/admin/movements", {name: "Bike externe", measurement_method: "distance"}));
  program = await idOf(
    alice.post("/programs", {
      ...programFields,
      coaching_instructions: "   Priorité technique\nProgression par paliers. ",
      weekly_cardio_target_min: 3,
      weekly_cardio_target_max: 4,
    })
  );
  model = await idOf(
    alice.post(`/programs/${program}/wods`, {
      name: "WOD hybride",
      planned_comment: "Force puis circuit",
      activity_id: activity,
      duration_minutes: 50,
      catalog_movement_ids: [squat],
    })
  );
  model2 = await idOf(
    alice.post(`/programs/${program}/wods`, {
      name: "WOD 2",
      activity_id: activity,
      duration_minutes: 20,
      is_tracked: true,
    })
  );
  await ok(alice.post(`/programs/${program}/movements`, {catalog_movement_id: squat}));
  await ok(alice.post("/prs", {movement_id: squat, record_date: date, value: 90, rep_count: 3}));
});
after(() => {
  worker?.stop();
  mock?.close();
});

const draft = (target, {title = "WOD proposé", move = squat} = {}) => ({
  target,
  wod: {
    titre: title,
    duree_estimee_min: 20,
    blocs: [
      {
        type: "metcon",
        duree_min: 20,
        format: "Circuit par équipes de deux",
        time_cap_min: 25,
        description: "Repos de 1 min après chaque tour.",
        mouvements: [
          {
            movement_id: move,
            nom: "Squat ou vélo",
            reps: "5 séries de 8",
            charge: "60 %",
            scaling: "Variante sans charge",
          },
        ],
      },
    ],
  },
});
const scheduled = (wid = model, monday = week) => ({
  kind: "program",
  program_id: program,
  wod_id: wid,
  week_start: monday,
});
const freeTarget = (day = date) => ({kind: "free", wod_id: randomUUID(), wod_date: day});
const call = (token, method, path, body, headers = {}) =>
  guest.call(method, path, body, {Authorization: "Bearer " + token, ...headers});
const preview = (body, token = key) => call(token, "POST", "/generated-wods/preview", body);
const apply = (body, p, {token = key, id = keyAt(), headers = {}} = {}) =>
  call(token, "PUT", "/generated-wods", body, {
    "Idempotency-Key": id,
    "X-WOD-Confirmation": p.confirmation,
    ...(p.edit_version ? {"If-Match": '"' + p.edit_version + '"'} : {"If-None-Match": "*"}),
    ...headers,
  });
const context = (token = key, query = "") => call(token, "GET", "/coaching-context" + query);
const programRows = async () => (await ok(alice.get("/program-data"))).weeklyWodPrograms;
const weekRows = () => ok(alice.get(weekPath));

function session(extra = {}) {
  return {
    program_id: program,
    wod_id: model,
    session_date: date,
    activity_id: activity,
    duration_minutes: 20,
    actual_comment: "Séance historique",
    ...extra,
  };
}

test("contexte en lecture seule, références, objectifs, PR, historiques et isolation", async () => {
  assert.equal((await guest.get("/coaching-context")).status, 401);
  assert.equal((await guest.post("/generated-wods/preview", draft(scheduled()))).status, 401);
  assert.equal((await alice.post("/generated-wods/preview", draft(scheduled()))).status, 403);
  assert.equal((await preview(draft(scheduled()), readKey)).status, 403);
  for (const query of ["?history_days=0", "?history_days=85", "?date=2026-02-30", "?time_zone=Pas/UneZone"])
    assert.equal((await context(key, query)).status, 400);
  const ref = await ok(
    context(readKey, `?date=${date}&time_zone=Europe%2FParis&program_id=${program}&wod_id=${model}`)
  );
  assert.equal(ref.reference_date, date);
  assert.deepEqual(ref.active_program_ids, [program]);
  assert.equal(ref.selected_wod_id, model);
  assert.equal(ref.programs[0].coaching_instructions, "Priorité technique\nProgression par paliers.");
  assert.deepEqual([ref.programs[0].weekly_cardio_target_min, ref.programs[0].weekly_cardio_target_max], [3, 4]);
  assert.equal(ref.programs[0].weekly_workout_target, 2);
  assert.equal(ref.programs[0].workout_models[0].instructions, "Force puis circuit");
  assert.equal(ref.recent.from, addDays(date, -27));
  assert.equal(ref.references.activities[0].id, activity);
  assert.equal(ref.performance.records[0].movement_id, squat);
  assert.equal(ref.performance.records[0].unit, "kg");
  assert.equal(ref.performance.records[0].rep_count, 3);
  assert.equal(ref.performance.workload_records[0], ref.performance.records[0].id);
  assert.deepEqual(ref.week.completed_sessions, []);
  assert.equal((await context(outsiderKey, "?program_id=" + program)).status, 404);
  assert.equal((await preview(draft(scheduled()), outsiderKey)).status, 404);
  assert.deepEqual((await ok(context(outsiderKey))).performance.records, []);
  await ok(alice.put("/programs/" + program, {...programFields}));
  assert.equal((await ok(context())).programs[0].coaching_instructions, ref.programs[0].coaching_instructions);
  assert.equal((await alice.put("/programs/" + program, {...programFields, coaching_instructions: []})).status, 400);
  await ok(bob.put("/program-follow", {program_id: program, start: addDays(week, 7)}));
  const followed = await ok(context(bobKey, `?date=${addDays(date, 7)}&program_id=${program}`));
  assert.equal(followed.programs[0].read_only, true);
  assert.equal((await preview(draft(scheduled()), bobKey)).status, 404);
});

test("préparation sans écriture, validation stricte puis programmation externe visible et rejouable", async () => {
  const body = draft(scheduled());
  assert.equal((await preview({...body, cardio_intensity: 4})).status, 400);
  assert.equal((await preview(draft(scheduled(), {move: "inconnu"}))).status, 400);
  assert.equal((await preview(draft(scheduled(model, addDays(week, 1))))).status, 400);
  assert.equal((await preview(draft(scheduled(model, addDays(week, 28))))).status, 400);
  const p = await ok(preview(body));
  assert.equal(p.operation, "create");
  assert.deepEqual(await programRows(), []);
  assert.equal((await apply(body, p, {headers: {"X-WOD-Confirmation": "incorrect"}})).status, 428);
  assert.equal((await apply(draft(scheduled(), {title: "Proposition modifiée"}), p)).status, 428);
  const id = keyAt();
  const [a, b] = await Promise.all([apply(body, p, {id}), apply(body, p, {id})]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(b.data, a.data);
  assert.equal(a.headers.get("etag"), '"' + a.data.edit_version + '"');
  const display = (await programRows())[0];
  assert.ok(display.content.includes("5 séries de 8"));
  assert.ok(JSON.parse(display.blocks)[0].text.includes("Variante sans charge"));
  assert.deepEqual(JSON.parse(display.blocks)[0].movement_ids, [squat]);
  const followed = await ok(context(bobKey, `?date=${addDays(date, 7)}&program_id=${program}`));
  assert.equal(followed.programs[0].workout_models[0].programming.content, display.content);
  assert.equal(followed.programs[0].workout_models[0].programming.edit_version, null);
  assert.deepEqual((await weekRows()).sessions, []);
  assert.equal(iaCalls.length, 0);
});

test("régénération dans les deux sens, historique et objectifs indépendants de la programmation", async () => {
  const original = await idOf(
    call(key, "POST", "/sessions", session({cardio_intensity: 3, catalog_movement_ids: [squat]}))
  );
  await idOf(call(key, "POST", "/sessions", session({cardio_intensity: 0, catalog_movement_ids: [squat]})));
  await idOf(call(key, "POST", "/sessions", session({wod_id: "other", cardio_intensity: 4})));
  await idOf(call(key, "POST", "/sessions", session({program_id: "none", wod_id: "other"})));
  await ok(call(key, "POST", "/weekly-plans", {week_start: week, wod_id: model2}, {"Idempotency-Key": keyAt()}));
  const saved = await weekRows();
  const ai = await ok(alice.post("/wods/" + model + "/generate", {...integrated, week_start: week}));
  assert.match(JSON.stringify(iaCalls[0]), /Progression par paliers/);
  assert.equal(iaCalls.length, 1);
  const external = draft(scheduled(), {move: bike});
  const p = await ok(preview(external));
  assert.equal(p.operation, "replace");
  assert.equal(p.previous_content, ai.content);
  await ok(apply(external, p));
  assert.equal(iaCalls.length, 1);
  assert.deepEqual((await weekRows()).sessions, saved.sessions);
  const c = await ok(context());
  assert.equal(c.week.sessions_count, 4);
  assert.equal(c.week.intense_cardio_exposures, 2);
  assert.deepEqual(c.week.completed_sessions.map(s => s.cardio_intensity).sort(), [0, 3, 4, null]);
  assert.equal(c.week.completed_sessions.find(s => s.id === original).actual_comment, "Séance historique");
  const p0 = c.programs[0];
  assert.equal(p0.week.sessions_count, 3);
  assert.equal(p0.week.workouts_count_toward_target, 1);
  assert.equal(p0.week.intense_cardio_exposures, 2);
  assert.deepEqual(p0.week.remaining_wod_ids, [model2]);
  assert.equal(p0.week.movement_coverage.worked, 1);
  assert.equal(p0.week.movement_coverage.movements[0].sessions_count, 2);
  assert.equal(c.recent.movement_frequency[0].sessions_count, 2);
  assert.ok(p0.workout_models.find(w => w.id === model2).plan_version);
  assert.equal(c.performance.records.length, 1);
});

test("préconditions, écritures concurrentes, édition manuelle et idempotence", async () => {
  const a = draft(scheduled(), {title: "Un", move: bike}),
    b = draft(scheduled(), {title: "Deux"});
  const first = await ok(preview(a));
  const second = await ok(preview(b));
  const outcomes = await Promise.all([apply(a, first), apply(b, second)]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), [200, 412]);
  assert.equal(
    (
      await alice.post("/wods/" + model + "/generate", {
        ...integrated,
        week_start: week,
        edit_version: first.edit_version,
      })
    ).status,
    412
  );
  const key = keyAt();
  const current = await ok(preview(b));
  await ok(apply(b, current, {id: key}));
  const latest = await ok(preview(a));
  assert.equal((await apply(a, latest, {id: key})).status, 409);
  await ok(alice.put("/wods/" + model + "/weekly-programming", {week_start: week, content: "Revu à la main"}));
  assert.equal((await apply(a, latest)).status, 412);
  assert.equal((await apply(b, current, {id: key})).status, 200);
  assert.equal((await apply(a, latest, {id: keyAt(Math.floor(Date.now() / 1000) - 86401)})).status, 409);
});

test("plusieurs WOD libres, édition depuis myFitFactory et séance réelle protégée", async () => {
  const first = draft(freeTarget(), {title: "Vélo seul"}),
    second = draft(freeTarget(), {title: "Team de deux"});
  for (const body of [first, second]) {
    body.wod.score_type = "reps";
    await ok(apply(body, await ok(preview(body))));
  }
  const before = await ok(context());
  assert.equal(before.week.sessions_count, 4);
  assert.equal(before.week.intense_cardio_exposures, 2);
  assert.equal(before.programs[0].weekly_workout_target, 2);
  const rows = (await weekRows()).dailyWods;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(w => w.manual && w.score_type === "reps" && w.session_ids.length === 0));
  const free = rows.find(w => w.id === first.target.wod_id);
  await ok(alice.post("/daily-wods", {...integrated, wod_date: date, replace_id: free.id, draft: true}));
  assert.equal(iaCalls.length, 2);
  await ok(
    alice.put("/daily-wods/" + free.id, {
      name: "WOD réécrit",
      wod_date: date,
      blocks: {metcon: "Autre circuit"},
      edit_version: free.edit_version,
    })
  );
  const p = await ok(preview(first));
  assert.match(p.previous_content, /Autre circuit/);
  const done = await idOf(
    alice.post(
      "/sessions",
      session({daily_wod_id: free.id, cardio_intensity: 4, actual_comment: "Séance libre terminée"})
    )
  );
  assert.equal((await apply(first, p)).status, 409);
  assert.equal((await preview(first)).status, 409);
  const after = await ok(context());
  assert.equal(after.week.intense_cardio_exposures, 3);
  assert.equal(after.week.completed_sessions.find(s => s.id === done).actual_comment, "Séance libre terminée");
  assert.equal(after.programs[0].week.workouts_count_toward_target, 1);
  assert.equal((await apply(second, await ok(preview(second)), {token: bobKey})).status, 428);
  const future = draft(freeTarget(addDays(end, 8)));
  await ok(apply(future, await ok(preview(future))));
  const regenerated = await ok(
    alice.post("/daily-wods", {
      ...integrated,
      wod_date: future.target.wod_date,
      replace_id: future.target.wod_id,
      draft: true,
    })
  );
  assert.match(regenerated.draft.blocks.metcon, /Circuit intégré/);
});

test("créer un cycle privé confirmé, avec ou sans WOD, de manière atomique", async () => {
  const token = await createKey(alice, ["programs:create"]);
  for (const [offset, drafts] of [
    [56, []],
    [84, [{week: 1, model: 1, wod: out}]],
  ]) {
    const body = {
      name: "Cycle ChatGPT " + offset,
      objective: "Progression force",
      start: addDays(week, offset),
      weeks: 2,
      models: [{name: "Force", duration_minutes: 40}],
      drafts,
    };
    const route = "/generated-programs";
    assert.equal((await call(key, "POST", route + "/preview", body)).status, 403);
    const prepared = await ok(call(token, "POST", route + "/preview", body));
    const headers = {"If-None-Match": "*", "Idempotency-Key": keyAt(), "X-WOD-Confirmation": prepared.confirmation};
    assert.equal((await call(token, "PUT", route, body, {...headers, "X-WOD-Confirmation": ""})).status, 428);
    assert.equal((await call(token, "PUT", route, {...body, name: "Modifié"}, headers)).status, 428);
    const [first, retry] = await Promise.all([
      ok(call(token, "PUT", route, body, headers)),
      ok(call(token, "PUT", route, body, headers)),
    ]);
    assert.equal(first.id, retry.id);
    assert.equal(first.drafted_count, drafts.length);
    const context = await ok(call(readKey, "GET", "/coaching-context?date=" + body.start + "&program_id=" + first.id));
    const created = context.programs.find(p => p.id === first.id);
    assert.equal(created.workout_models.length, 1);
    assert.equal(Boolean(created.workout_models[0].programming), Boolean(drafts.length));
    assert.equal((await call(token, "POST", route + "/preview", body)).status, 409);
  }
});

test("modifier un programme confirmé avec archivage, mouvements et contrôle de version", async () => {
  const create = await createKey(alice, ["programs:create"]);
  const edit = await createKey(alice, ["programs:edit"]);
  const start = addDays(week, 140);
  const body = {
    name: "Cycle à modifier",
    objective: "Force",
    start,
    weeks: 2,
    models: [
      {name: "A", duration_minutes: 40},
      {name: "B", duration_minutes: 45},
    ],
  };
  const p = await ok(call(create, "POST", "/generated-programs/preview", body));
  const built = await ok(
    call(create, "PUT", "/generated-programs", body, {
      "If-None-Match": "*",
      "Idempotency-Key": keyAt(),
      "X-WOD-Confirmation": p.confirmation,
    })
  );
  const context = async () =>
    (await ok(call(readKey, "GET", "/coaching-context?date=" + start + "&program_id=" + built.id))).programs[0];
  const [a, b] = (await context()).workout_models;
  const change = {
    program_id: built.id,
    fields: {name: "Cycle modifié", objective: "Force et endurance"},
    models: [{id: b.id, name: "B", movement_ids: [bike]}, {name: "Nouveau"}],
    focus: [squat],
    drafts: [{wod_id: b.id, week_start: start, wod: out}],
  };
  const editPath = "/program-edits";
  assert.equal((await call(create, "POST", editPath + "/preview", change)).status, 403);
  const old = await ok(call(edit, "POST", editPath + "/preview", change));
  assert.equal(old.archived_models[0].id, a.id);
  const headers = prep => ({
    "If-Match": '"' + prep.edit_version + '"',
    "Idempotency-Key": keyAt(),
    "X-WOD-Confirmation": prep.confirmation,
  });
  const write = async (value, prep) => call(edit, "PUT", editPath, value, headers(prep));
  assert.equal((await write({...change, fields: {name: "Non confirmé"}}, old)).status, 428);
  const earlier = {program_id: built.id, fields: {coaching_instructions: "Progression"}};
  await ok(write(earlier, await ok(call(edit, "POST", editPath + "/preview", earlier))));
  assert.equal((await write(change, old)).status, 412);
  const fresh = await ok(call(edit, "POST", editPath + "/preview", change));
  const confirmed = headers(fresh);
  await ok(call(edit, "PUT", editPath, change, confirmed));
  await ok(call(edit, "PUT", editPath, change, confirmed));
  const actual = await context();
  assert.equal(actual.name, "Cycle modifié");
  assert.equal(actual.coaching_instructions, "Objectif : Force et endurance\nProgression");
  assert.deepEqual(
    actual.workout_models.map(w => w.name),
    ["B", "Nouveau"]
  );
  assert.deepEqual(actual.workout_models[0].movement_ids, [bike]);
  assert.ok(actual.workout_models[0].programming);
  assert.equal(actual.tracked_movements[0].catalog_movement_id, squat);
});

test("une modification protège les séances réalisées et leurs mouvements cochés", async () => {
  const pid = await idOf(outsider.post("/programs", {name: "Cycle privé", start: week, end}));
  const makeModel = name =>
    idOf(outsider.post("/programs/" + pid + "/wods", {name, activity_id: activity, duration_minutes: 30}));
  const performed = await makeModel("Force réalisée");
  const upcoming = await makeModel("Endurance");
  const movement = await idOf(outsider.post("/programs/" + pid + "/movements", {catalog_movement_id: squat}));
  const sid = await idOf(
    outsider.post("/sessions", {
      program_id: pid,
      wod_id: performed,
      session_date: date,
      activity_id: activity,
      duration_minutes: 30,
      movement_ids: [movement],
    })
  );
  const edit = await createKey(outsider, ["programs:edit"]);
  const foreign = await createKey(alice, ["programs:edit"]);
  const route = "/program-edits";
  const blocked = {program_id: pid, drafts: [{wod_id: performed, week_start: week, wod: out}]};
  assert.equal((await call(foreign, "POST", route + "/preview", blocked)).status, 404);
  assert.equal((await call(edit, "POST", route + "/preview", blocked)).status, 409);
  const change = {program_id: pid, models: [{id: upcoming, name: "Endurance"}], focus: []};
  const preview = await ok(call(edit, "POST", route + "/preview", change));
  await ok(
    call(edit, "PUT", route, change, {
      "If-Match": '"' + preview.edit_version + '"',
      "Idempotency-Key": keyAt(),
      "X-WOD-Confirmation": preview.confirmation,
    })
  );
  const context = await ok(call(outsiderKey, "GET", "/coaching-context?date=" + date + "&program_id=" + pid));
  assert.deepEqual(
    context.programs[0].workout_models.map(w => w.id),
    [upcoming]
  );
  assert.deepEqual(context.programs[0].tracked_movements, []);
  const after = await ok(outsider.get(weekPath));
  assert.ok(after.sessions.some(s => s.id === sid && s.wod_id === performed));
  assert.deepEqual(
    context.week.completed_sessions.find(s => s.id === sid).worked_movements.map(m => m.movement_id),
    [squat]
  );
  assert.equal(await idOf(outsider.post("/programs/" + pid + "/movements", {catalog_movement_id: squat})), movement);
});

test("le formulaire permet de sélectionner la modification de programmes sans la précocher", async () => {
  const response = await fetch(worker.base + "/");
  assert.equal(response.status, 200);
  const html = await response.text();
  const option = html.match(/<input\b[^>]*name="permissions"[^>]*value="programs:edit"[^>]*>/);
  assert.ok(option, "La permission doit être proposée dans le formulaire");
  assert.doesNotMatch(option[0], /\bchecked\b/);
});
