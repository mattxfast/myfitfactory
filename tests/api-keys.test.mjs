import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

let worker, admin, alice, bob, guest, programId, sessionId, recordId, sessionBody, catalogId;
const password = "MotDePasse-Test-123";
const date = today();
const weekPath = `/week-data?from=${mondayOf(date)}&to=${addDays(mondayOf(date), 6)}`;
const allPermissions = ["programs:read", "workouts:read", "prs:read"];
const keyBody = (name, permissions = allPermissions) => ({name, permissions, expires_on: addDays(date, 7)});

before(async () => {
  worker = await startWorker();
  admin = client(worker.base, "203.0.113.1");
  alice = client(worker.base, "203.0.113.2");
  bob = client(worker.base, "203.0.113.3");
  guest = client(worker.base, "203.0.113.4");
  for (const [actor, email] of [
    [admin, ADMIN_EMAIL],
    [alice, "alice@test.local"],
    [bob, "bob@test.local"],
  ]) {
    assert.equal((await actor.post("/register", {email, password})).status, 200);
  }
  const program = await alice.post("/programs", {
    name: "Privé Alice",
    start: mondayOf(date),
    end: addDays(mondayOf(date), 7),
  });
  assert.equal(program.status, 200);
  programId = program.data.id;
  const activityId = (await alice.get("/activities")).data.activities[0].id;
  const wod = await alice.post(`/programs/${programId}/wods`, {
    name: "WOD privé",
    activity_id: activityId,
    duration_minutes: 60,
  });
  assert.equal(wod.status, 200);
  sessionBody = {
    program_id: programId,
    wod_id: wod.data.id,
    session_date: date,
    activity_id: activityId,
    duration_minutes: 60,
  };
  const session = await alice.post("/sessions", sessionBody);
  assert.equal(session.status, 200);
  sessionId = session.data.id;
  const movement = await admin.post("/admin/movements", {name: "Squat test", measurement_method: "load"});
  assert.equal(movement.status, 200);
  catalogId = movement.data.id;
  const record = await alice.post("/prs", {
    movement_id: movement.data.id,
    record_date: date,
    value: 100,
    rep_count: 1,
  });
  assert.equal(record.status, 200);
  recordId = record.data.id;
});
after(() => worker?.stop());

const manage = (actor, method, path, body, headers = {}) =>
  actor.call(method, path, body, {Origin: worker.base, ...headers});
const bearer = (token, path, method = "GET", actor = guest, headers = {}) =>
  actor.call(method, path, undefined, {Authorization: "Bearer " + token, ...headers});
async function create(actor, name, scopes) {
  const result = await manage(actor, "POST", "/api-keys", keyBody(name, scopes));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.match(result.data.token, /^mff_[0-9a-f]{32}\.[\w-]{43}$/);
  assert.ok(result.data.token.startsWith(result.data.key.prefix + "."));
  return result.data;
}
function localD1(sql) {
  execFileSync(
    "npx",
    [
      "-y",
      "wrangler@4",
      "d1",
      "execute",
      "myfitfactory",
      "--local",
      "--persist-to",
      worker.persistPath,
      "--command",
      sql,
    ],
    {cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe", env: {...process.env, CI: "1"}}
  );
}

test("clés personnelles : gestion par session et origine, secret affiché une fois, révocation et propriété", async () => {
  assert.equal((await guest.get("/api-keys")).status, 401);
  assert.equal((await manage(guest, "POST", "/api-keys", keyBody("Invité"))).status, 401);
  assert.equal((await alice.post("/api-keys", keyBody("Sans origine"))).status, 403);
  assert.equal(
    (await manage(alice, "POST", "/api-keys", keyBody("CSRF"), {Origin: "https://external.invalid"})).status,
    403
  );
  for (const scopes of [[], ["programs:write"], ["nutrition:read"], ["prs:read", "prs:read"], ["admin"]]) {
    assert.equal((await manage(alice, "POST", "/api-keys", keyBody("Invalide", scopes))).status, 400);
  }
  for (const expires_on of ["2025-02-30", "2000-01-01"]) {
    assert.equal((await manage(alice, "POST", "/api-keys", {...keyBody("Invalide"), expires_on})).status, 400);
  }
  const first = await create(alice, "ChatGPT");
  const second = await create(alice, "Claude");
  assert.notEqual(first.token, second.token);
  const keys = (await alice.get("/api-keys")).data.keys;
  assert.equal(keys.length, 2);
  assert.deepEqual(
    keys.find(k => k.id === first.key.id),
    first.key
  );
  assert.deepEqual((await bob.get("/api-keys")).data.keys, []);
  const path = "/api-keys/" + first.key.id;
  assert.equal((await alice.del(path)).status, 403);
  assert.equal((await manage(bob, "DELETE", path)).status, 404);
  assert.equal((await bearer(first.token, path, "DELETE", alice)).status, 403);
  assert.equal((await bearer(first.token, "/prs")).status, 200);
  const used = (await alice.get("/api-keys")).data.keys.find(k => k.id === first.key.id);
  assert.ok(used.last_used_at >= used.created_at);
  assert.equal((await manage(alice, "DELETE", path)).status, 200);
  const revoked = (await alice.get("/api-keys")).data.keys.find(k => k.id === first.key.id);
  assert.ok(revoked.revoked_at >= used.last_used_at);
  assert.equal((await manage(alice, "DELETE", path)).status, 200);
  assert.deepEqual(
    (await alice.get("/api-keys")).data.keys.find(k => k.id === first.key.id),
    revoked
  );
  assert.equal((await bearer(first.token, "/prs", "GET", alice)).status, 401);
  assert.equal((await bearer(second.token, "/prs")).status, 200);
  assert.equal((await alice.get("/prs")).status, 200);
});

test("Bearer : refus par défaut, y compris pour un administrateur et en présence d’un cookie", async () => {
  const {token} = await create(admin, "Clé administrateur", ["prs:read"]);
  const badToken = token.slice(0, -2) + (token.at(-2) === "A" ? "B" : "A") + token.at(-1);
  for (const invalid of [badToken, "invalide"]) {
    const response = await bearer(invalid, "/prs", "GET", admin);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal((await guest.get("/prs")).status, 401);
  assert.equal((await bearer(token, "/prs")).status, 200);
  for (const [method, path] of [
    ["GET", "/program-data"],
    ["GET", weekPath],
    ["GET", "/export-data"],
    ["GET", "/admin/users"],
    ["GET", "/api-keys"],
    ["GET", "/me"],
    ["POST", "/login"],
    ["POST", "/prs"],
    ["PUT", "/profile"],
    ["HEAD", "/prs"],
  ]) {
    assert.equal((await bearer(token, path, method, admin)).status, 403, method + " " + path);
  }
  assert.equal((await admin.get("/admin/users")).status, 200);
  localD1("UPDATE api_keys SET expires_at=unixepoch()-1 WHERE name='Clé administrateur'");
  assert.equal((await bearer(token, "/prs", "GET", admin)).status, 401);
});

test("les lectures Bearer utilisent les mêmes données et le même périmètre que le cookie", async () => {
  const a = await create(alice, "Iso Alice");
  const b = await create(bob, "Iso Bob");
  for (const [path, readIds, privateId] of [
    ["/program-data", data => data.programs.map(p => p.id), programId],
    [weekPath, data => data.sessions.map(s => s.id), sessionId],
    ["/prs", data => data.records.map(r => r.id), recordId],
  ]) {
    const own = await bearer(a.token, path);
    const other = await bearer(b.token, path, "GET", alice);
    assert.equal(own.status, 200);
    assert.equal(other.status, 200);
    assert.deepEqual(own.data, (await alice.get(path)).data);
    assert.deepEqual(other.data, (await bob.get(path)).data);
    assert.ok(readIds(own.data).includes(privateId));
    assert.ok(!readIds(other.data).includes(privateId));
  }
  assert.equal((await bearer(a.token, "/week-data?from=2026-11-24")).status, 400);
});

const writeScope = ["workouts:write"];
const saveSession = (token, body, actor = guest) =>
  actor.call("POST", "/sessions", body, {Authorization: "Bearer " + token});

test("séances Bearer : permissions explicites, catalogues et cycle de vie des clés", async () => {
  const reader = await create(alice, "Lecture seule");
  const writer = await create(alice, "Écriture seule", writeScope);
  assert.deepEqual(writer.key.permissions, writeScope);
  assert.equal((await saveSession(reader.token, sessionBody, alice)).status, 403);
  for (const path of ["/activities", "/movement-catalog", "/wod-types"]) {
    const response = await bearer(reader.token, path);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, (await alice.get(path)).data);
    assert.equal((await bearer(writer.token, path)).status, 403);
  }
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/sessions", "/sessions/" + sessionId]) {
      if (method === "PUT" && path !== "/sessions") continue;
      assert.equal((await bearer(writer.token, path, method, alice)).status, 403);
    }
  }
  const response = await saveSession(writer.token, sessionBody, bob);
  assert.equal(response.status, 200);
  assert.ok((await alice.get("/sessions")).data.sessions.some(s => s.id === response.data.id));
  assert.ok(!(await bob.get("/sessions")).data.sessions.some(s => s.id === response.data.id));
  assert.equal((await manage(alice, "DELETE", "/api-keys/" + writer.key.id)).status, 200);
  assert.equal((await saveSession(writer.token, sessionBody)).status, 401);
  const expired = await create(alice, "Écriture expirée", writeScope);
  localD1("UPDATE api_keys SET expires_at=unixepoch()-1 WHERE name='Écriture expirée'");
  assert.equal((await saveSession(expired.token, sessionBody, alice)).status, 401);
});

test("séances Bearer : validation des données et des références privées", async () => {
  const aliceKey = await create(alice, "Validation Alice", writeScope);
  const bobKey = await create(bob, "Validation Bob", writeScope);
  assert.equal((await saveSession(bobKey.token, sessionBody, alice)).status, 404);
  const box = await admin.post("/admin/boxes", {name: "Box privée"});
  assert.equal(box.status, 200);
  const boxId = box.data.id;
  assert.equal((await alice.put("/profile", {first_name: "Alice", last_name: "Test"})).status, 200);
  assert.equal((await alice.post(`/boxes/${boxId}/requests`, {role: "manager"})).status, 200);
  const aliceId = (await alice.get("/me")).data.user.id;
  assert.equal((await admin.put(`/admin/boxes/${boxId}/managers/${aliceId}`, {approve: true})).status, 200);
  const boxWod = await alice.post(`/manage/boxes/${boxId}/wods`, {
    wod_date: date,
    content: "Squat",
    score_type: "time",
  });
  assert.equal(boxWod.status, 200, JSON.stringify(boxWod.data));
  assert.equal((await saveSession(bobKey.token, {...sessionBody, box_wod_id: boxWod.data.id})).status, 404);
  assert.equal((await saveSession(aliceKey.token, {...sessionBody, box_wod_id: boxWod.data.id})).status, 200);
  const daily = await alice.post("/daily-wods/manual", {wod_date: date, name: "WOD privé", blocks: {metcon: "Squat"}});
  assert.equal(daily.status, 200);
  assert.equal((await saveSession(bobKey.token, {...sessionBody, daily_wod_id: daily.data.wod.id})).status, 404);
  for (const fields of [
    {session_date: "2024-02-30"},
    {session_date: addDays(date, 1)},
    {session_date: addDays(mondayOf(date), -1)},
    {duration_minutes: 0},
    {duration_minutes: 601},
    {duration_minutes: 1.5},
    {activity_id: crypto.randomUUID()},
    {wod_id: crypto.randomUUID()},
    {client_id: "invalide"},
    {movement_ids: "invalide"},
    {movement_ids: [crypto.randomUUID()]},
    {catalog_movement_ids: [crypto.randomUUID()]},
  ]) {
    const res = await saveSession(aliceKey.token, {...sessionBody, ...fields});
    assert.equal(res.status, 400, JSON.stringify(fields));
  }
  const programMovement = await alice.post(`/programs/${programId}/movements`, {catalog_movement_id: catalogId});
  assert.equal(programMovement.status, 200);
  const movementBody = {...sessionBody, movement_ids: [programMovement.data.id]};
  assert.equal((await saveSession(aliceKey.token, movementBody)).status, 200);
  assert.equal((await saveSession(bobKey.token, {...movementBody, program_id: "none", wod_id: "other"})).status, 400);
  assert.equal((await saveSession(aliceKey.token, [])).status, 400);
  const invalid = await guest.call("POST", "/sessions", sessionBody, {
    Authorization: "Bearer " + aliceKey.token,
    "content-type": "text/plain",
  });
  assert.equal(invalid.status, 415);
});

test("séances Bearer : rejeux concurrents et mouvements atomiques, collision entre comptes", async () => {
  const a = await create(alice, "Rejeu Alice", writeScope);
  const b = await create(bob, "Rejeu Bob", writeScope);
  const body = {
    ...sessionBody,
    program_id: "none",
    wod_id: "other",
    client_id: crypto.randomUUID(),
    catalog_movement_ids: [catalogId],
    actual_comment: "Premier enregistrement",
  };
  const responses = await Promise.all(Array.from({length: 8}, () => saveSession(a.token, body)));
  for (const {status, data} of responses) {
    assert.equal(status, 200, JSON.stringify(data));
    assert.deepEqual(data, {ok: true, id: body.client_id});
  }
  assert.equal((await saveSession(a.token, {...body, actual_comment: "Rejeu", catalog_movement_ids: []})).status, 200);
  const collision = await saveSession(b.token, {...body, actual_comment: "Autre compte"});
  assert.equal(collision.status, 409, JSON.stringify(collision.data));
  const {sessions, catalogChecks} = (await alice.get(weekPath)).data;
  const stored = sessions.filter(s => s.id === body.client_id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].actual_comment, body.actual_comment);
  assert.deepEqual(
    catalogChecks.filter(c => c.session_id === body.client_id),
    [{session_id: body.client_id, catalog_movement_id: catalogId}]
  );
  assert.ok(!(await bob.get("/sessions")).data.sessions.some(s => s.id === body.client_id));
});

const editSession = (token, id, version, body, extraHeaders = {}, actor = guest) =>
  actor.call("PUT", "/sessions/" + id, body, {
    Authorization: "Bearer " + token,
    ...(version === undefined ? {} : {"If-Match": '"' + version + '"'}),
    ...extraHeaders,
  });

const ownedSession = async (id, actor = alice) => (await actor.get("/sessions")).data.sessions.find(s => s.id === id);
const sessionChecks = async id => {
  const data = (await alice.get(weekPath)).data;
  return {
    program: data.checks
      .filter(row => row.session_id === id)
      .map(row => row.movement_id)
      .sort(),
    catalog: data.catalogChecks
      .filter(row => row.session_id === id)
      .map(row => row.catalog_movement_id)
      .sort(),
  };
};

test("V3.1 : propriété, permission, précondition et conservation des champs d’une séance personnelle", async () => {
  const reader = await create(alice, "Lecture V3.1", ["workouts:read"]);
  const writer = await create(alice, "Écriture V3.1", writeScope);
  const other = await create(bob, "Autre compte V3.1", writeScope);
  const original = await ownedSession(sessionId);
  const apiWeek = await bearer(reader.token, weekPath);
  assert.equal(apiWeek.data.sessions.find(s => s.id === sessionId).edit_version, original.edit_version);
  assert.equal(
    (await editSession(other.token, sessionId, original.edit_version, {duration_minutes: 20}, {}, alice)).status,
    404
  );
  assert.equal((await editSession(reader.token, sessionId, original.edit_version, {duration_minutes: 20})).status, 403);
  assert.equal((await editSession(writer.token, sessionId, undefined, {duration_minutes: 20})).status, 428);
  assert.equal(
    (await editSession(writer.token, sessionId, original.edit_version, {duration_minutes: 20}, {"If-Match": "*"}))
      .status,
    400
  );
  assert.equal(
    (
      await editSession(
        writer.token,
        sessionId,
        original.edit_version,
        {duration_minutes: 20},
        {"Content-Type": "text/plain"}
      )
    ).status,
    415
  );
  const response = await editSession(
    writer.token,
    sessionId,
    original.edit_version,
    {duration_minutes: 45, actual_comment: "Technique"},
    {},
    bob
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.headers.get("etag"), '"' + response.data.edit_version + '"');
  const stored = await ownedSession(sessionId);
  assert.deepEqual(
    {...stored, updated_at: original.updated_at},
    {...original, duration_minutes: 45, actual_comment: "Technique", edit_version: response.data.edit_version}
  );
  assert.notEqual(stored.edit_version, original.edit_version);

  for (const invalid of [
    [],
    {},
    {session_date: "2024-02-30"},
    {session_date: addDays(date, 1)},
    {session_date: addDays(mondayOf(date), -1)},
    {duration_minutes: "40"},
    {duration_minutes: 0},
    {duration_minutes: 601},
    {duration_minutes: 1.5},
    {activity_id: crypto.randomUUID()},
    {wod_id: crypto.randomUUID()},
    {started_at: "invalide"},
    {score_value: true},
    {type_id: crypto.randomUUID()},
    {actual_comment: 123},
    {movement_ids: null},
    {movement_ids: [crypto.randomUUID()]},
    {box_wod_id: "autre"},
    {daily_wod_id: null},
    {tagged_user_ids: []},
    {client_id: crypto.randomUUID()},
  ]) {
    const rejected = await editSession(writer.token, sessionId, stored.edit_version, invalid);
    assert.equal(rejected.status, 400, JSON.stringify({invalid, returned: rejected.data}));
  }
  assert.equal(
    (await editSession(writer.token, sessionId, stored.edit_version, {program_id: crypto.randomUUID()})).status,
    404
  );
  assert.deepEqual(await ownedSession(sessionId), stored);
});

test("V3.1 : conservation des scores et des deux listes de mouvements, changements de WOD contrôlés", async () => {
  const writer = await create(alice, "Écriture mouvements V3.1", writeScope);
  const pid = programId;
  const programCatalog = await admin.post("/admin/movements", {
    name: "Front Squat test V3.1",
    measurement_method: "load",
  });
  assert.equal(programCatalog.status, 200);
  const first = await alice.post(`/programs/${pid}/movements`, {catalog_movement_id: programCatalog.data.id});
  assert.equal(first.status, 200);
  const movement = await admin.post("/admin/movements", {name: "Row test V3.1", measurement_method: "load"});
  assert.equal(movement.status, 200);
  const wod = await alice.post(`/programs/${pid}/wods`, {
    name: "Force",
    activity_id: sessionBody.activity_id,
    duration_minutes: 60,
    score_type: "load",
    catalog_movement_ids: [movement.data.id],
  });
  assert.equal(wod.status, 200);
  const anotherWod = await alice.post(`/programs/${pid}/wods`, {
    name: "Tempo",
    activity_id: sessionBody.activity_id,
    duration_minutes: 60,
    score_type: "time",
  });
  assert.equal(anotherWod.status, 200);
  const result = await saveSession(writer.token, {
    ...sessionBody,
    program_id: pid,
    wod_id: wod.data.id,
    movement_ids: [first.data.id],
    catalog_movement_ids: [movement.data.id],
    score_value: 90,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const id = result.data.id;
  const original = await ownedSession(id);
  const removed = await editSession(writer.token, id, original.edit_version, {movement_ids: []});
  assert.equal(removed.status, 200);
  assert.deepEqual(await sessionChecks(id), {program: [], catalog: [movement.data.id]});
  assert.equal((await ownedSession(id)).score_value, 90);
  const added = await editSession(writer.token, id, removed.data.edit_version, {movement_ids: [first.data.id]});
  assert.equal(added.status, 200);
  assert.deepEqual(await sessionChecks(id), {program: [first.data.id], catalog: [movement.data.id]});

  const wrongScore = {wod_id: anotherWod.data.id, catalog_movement_ids: []};
  for (const fields of [wrongScore, {...wrongScore, score_value: null, catalog_movement_ids: [movement.data.id]}]) {
    const rejected = await editSession(writer.token, id, added.data.edit_version, fields);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
  }
  const moved = await editSession(writer.token, id, added.data.edit_version, {...wrongScore, score_value: null});
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.deepEqual(await sessionChecks(id), {program: [first.data.id], catalog: []});
  const stored = await ownedSession(id);
  assert.equal(stored.wod_id, anotherWod.data.id);
  assert.equal(stored.score_value, null);
  assert.equal(stored.program_score_type, null);
});

test("V3.1 : concurrence, perte de réponse, rollback D1 et mise à jour Web", async () => {
  const writer = await create(alice, "Écriture atomique V3.1", writeScope);
  const created = await saveSession(writer.token, {
    ...sessionBody,
    program_id: "none",
    wod_id: "other",
    catalog_movement_ids: [catalogId],
  });
  assert.equal(created.status, 200);
  const id = created.data.id;
  const original = await ownedSession(id);
  localD1(`CREATE TRIGGER test_reject_session_edit BEFORE UPDATE OF actual_comment ON training_sessions
    WHEN NEW.actual_comment='Rollback V3.1' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
  assert.equal(
    (
      await editSession(writer.token, id, original.edit_version, {
        catalog_movement_ids: [],
        actual_comment: "Rollback V3.1",
      })
    ).status,
    500
  );
  assert.deepEqual(await sessionChecks(id), {program: [], catalog: [catalogId]});
  assert.deepEqual(await ownedSession(id), original);

  const bodies = [
    {actual_comment: "A", catalog_movement_ids: []},
    {actual_comment: "B", catalog_movement_ids: [catalogId]},
  ];
  const responses = await Promise.all(bodies.map(body => editSession(writer.token, id, original.edit_version, body)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
  const winner = responses.findIndex(response => response.status === 200);
  // Le client peut rejouer la requête initiale sans avoir reçu sa réponse.
  const replay = await editSession(writer.token, id, original.edit_version, bodies[winner]);
  assert.deepEqual(replay.data, responses[winner].data);
  assert.equal(replay.headers.get("etag"), responses[winner].headers.get("etag"));
  assert.equal((await ownedSession(id)).actual_comment, bodies[winner].actual_comment);
  assert.deepEqual(await sessionChecks(id), {program: [], catalog: bodies[winner].catalog_movement_ids});

  const interrupted = {duration_minutes: 35};
  const connection = new AbortController();
  const unread = await fetch(worker.base + "/api/sessions/" + id, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + writer.token,
      "If-Match": '"' + replay.data.edit_version + '"',
      "Content-Type": "application/json",
    },
    body: JSON.stringify(interrupted),
    signal: connection.signal,
  });
  assert.equal(unread.status, 200);
  connection.abort();
  const afterInterruption = await ownedSession(id);
  assert.equal(afterInterruption.duration_minutes, 35);
  const retried = await editSession(writer.token, id, replay.data.edit_version, interrupted);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.edit_version, afterInterruption.edit_version);
  assert.deepEqual(await ownedSession(id), afterInterruption);

  const cookieEdit = await alice.put("/sessions/" + id, {
    ...sessionBody,
    program_id: "none",
    wod_id: "other",
    actual_comment: "Web",
    catalog_movement_ids: [catalogId],
  });
  assert.equal(cookieEdit.status, 200);
  assert.equal((await ownedSession(id)).actual_comment, "Web");
  assert.deepEqual(await sessionChecks(id), {program: [], catalog: [catalogId]});
  assert.equal(
    (await editSession(writer.token, id, retried.data.edit_version, {actual_comment: "Obsolète"})).status,
    412
  );
  assert.equal((await editSession(writer.token, id, original.edit_version, bodies[winner])).status, 412);
  assert.equal((await bearer(writer.token, "/sessions/" + id, "DELETE", alice)).status, 403);
});

test("V3.1 : séances envoyées, copies partagées et séances box ou WOD du jour hors périmètre", async () => {
  const writer = await create(alice, "Écriture exclusions V3.1", writeScope);
  const recipient = await create(bob, "Écriture invité V3.1", writeScope);
  const bobId = (await bob.get("/me")).data.user.id;
  const tagged = await alice.post("/sessions", {...sessionBody, tagged_user_ids: [bobId]});
  assert.equal(tagged.status, 200);
  const invite = (await bob.get("/session-tags")).data.tags[0];
  assert.equal((await bob.post("/session-tags/" + invite.id + "/accept")).status, 200);
  const daily = await alice.post("/daily-wods/manual", {wod_date: date, name: "V3.1", blocks: {metcon: "Row"}});
  assert.equal(daily.status, 200);
  const dailySession = await saveSession(writer.token, {...sessionBody, daily_wod_id: daily.data.wod.id});
  assert.equal(dailySession.status, 200);
  const boxSession = (await alice.get("/sessions")).data.sessions.find(s => s.box_wod_id);
  assert.ok(boxSession);
  for (const [token, session] of [
    [writer.token, await ownedSession(tagged.data.id)],
    [recipient.token, await ownedSession(invite.id, bob)],
    [writer.token, await ownedSession(dailySession.data.id)],
    [writer.token, boxSession],
  ]) {
    assert.ok(session);
    assert.equal((await editSession(token, session.id, session.edit_version, {actual_comment: "Bloqué"})).status, 409);
  }
});

test("V3.2 : planning personnel et opérations atomiques", async t => {
  const planner = client(worker.base, "203.0.113.5");
  const follower = client(worker.base, "203.0.113.6");
  for (const [actor, email] of [
    [planner, "planner@test.local"],
    [follower, "follower@test.local"],
  ]) {
    assert.equal((await actor.post("/register", {email, password})).status, 200);
  }
  const week = mondayOf(date),
    next = addDays(week, 7),
    later = addDays(week, 14);
  const end = addDays(week, 20);
  const planProgram = await planner.post("/programs", {name: "Planning V3.2", start: week, end, is_public: true});
  assert.equal(planProgram.status, 200);
  const pid = planProgram.data.id;
  const exercises = await Promise.all(
    ["Tractions", "Squat", "Rameur", "Gainage"].map(async name => {
      const res = await planner.post(`/programs/${pid}/wods`, {
        name,
        activity_id: sessionBody.activity_id,
        duration_minutes: 30,
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      return res.data.id;
    })
  );
  const [pull, squat, row, core] = exercises;
  const full = (await create(planner, "Planning complet", ["plans:read", "plans:write"])).token;
  const viewer = (await create(planner, "Planning lecture", ["plans:read"])).token;
  const writer = (await create(planner, "Planning écriture", ["plans:write"])).token;
  const old = (await create(planner, "Permissions V3.1", [...allPermissions, "workouts:write"])).token;
  const other = (await create(follower, "Planning suivi", ["plans:read", "plans:write"])).token;
  const path = "/weekly-plans",
    movePath = path + "/move";
  const range = path + `?from=${week}&to=${end}`;
  const ref = (week_start, wod_id) => ({week_start, wod_id});
  const keyAt = (seconds = Math.floor(Date.now() / 1000)) => seconds + "." + crypto.randomUUID();
  const apply = (token, method, body, {path: route = path, key = keyAt(), actor = guest, headers = {}} = {}) =>
    actor.call(method, route, body, {
      Authorization: "Bearer " + token,
      "Idempotency-Key": key,
      ...headers,
    });
  const read = async (token = full) => {
    const res = await bearer(token, range);
    assert.equal(res.status, 200);
    return res.data.plans;
  };
  const get = async (week_start, wod_id, token = full) =>
    (await read(token)).find(p => p.week_start === week_start && p.wod_id === wod_id);
  const source = ({week_start, wod_id, version}) => ({week_start, wod_id, version});

  await t.test(
    "permissions, dates strictes, accès au programme suivi et isolement en lecture et en écriture",
    async () => {
      assert.equal((await guest.get(range)).status, 401);
      for (const token of [old, writer]) assert.equal((await bearer(token, range)).status, 403);
      for (const token of [old, viewer]) {
        assert.equal((await apply(token, "POST", ref(week, pull), {actor: planner})).status, 403);
        assert.equal((await apply(token, "DELETE", ref(week, pull), {actor: planner})).status, 403);
        assert.equal((await apply(token, "POST", {}, {path: movePath, actor: planner})).status, 403);
      }
      assert.equal((await planner.post(movePath, {})).status, 404);
      assert.equal((await bearer(full, path + "?from=2026-02-30&to=2026-03-15")).status, 400);
      assert.equal((await bearer(full, path + `?from=${next}&to=${week}`)).status, 400);
      assert.equal((await apply(writer, "POST", ref(addDays(week, 1), pull))).status, 400);
      assert.equal((await apply(writer, "POST", ref(addDays(week, -7), pull))).status, 400);
      assert.equal((await apply(writer, "POST", ref(week, pull), {key: ""})).status, 400);
      assert.equal(
        (await apply(writer, "POST", ref(week, pull), {headers: {"Content-Type": "text/plain"}})).status,
        415
      );
      assert.equal((await apply(writer, "POST", {...ref(week, pull), user_id: "autre"})).status, 400);
      assert.equal((await apply(other, "POST", ref(week, pull), {actor: planner})).status, 404);
      assert.equal((await apply(writer, "POST", ref(week, sessionBody.wod_id))).status, 404);

      const internalSession = await planner.post("/sessions", {
        ...sessionBody,
        program_id: "none",
        wod_id: "other",
      });
      assert.equal(internalSession.status, 200);
      const internal = (await planner.get("/sessions")).data.sessions.find(s => s.id === internalSession.data.id);
      assert.equal((await apply(writer, "POST", ref(week, internal.wod_id))).status, 404);

      assert.equal((await apply(writer, "POST", ref(week, pull))).status, 200);
      const origin = await get(week, pull, viewer);
      assert.deepEqual(origin, {
        ...ref(week, pull),
        wod_name: "Tractions",
        program_id: pid,
        version: origin.version,
        completed: false,
      });
      assert.match(origin.version, /^[a-f0-9]{32}$/);
      assert.deepEqual(await read(other), []);
      assert.equal((await follower.put("/program-follow", {program_id: pid, start: next})).status, 200);
      assert.equal((await apply(other, "POST", ref(week, pull))).status, 400);
      assert.equal((await apply(other, "POST", ref(next, pull))).status, 200);
      assert.equal((await apply(writer, "POST", ref(next, pull))).status, 200);
      const otherPlan = await get(next, pull, other);
      const ownerPlan = await get(next, pull);
      assert.notEqual(ownerPlan.version, otherPlan.version);
      assert.equal((await apply(other, "DELETE", source(ownerPlan))).status, 412);
      assert.equal((await apply(other, "DELETE", source(otherPlan))).status, 200);
      assert.deepEqual(await get(next, pull), ownerPlan);
      assert.equal((await apply(other, "POST", ref(next, pull))).status, 200);
      assert.equal((await follower.del("/program-follow")).status, 200);
      assert.deepEqual(await read(other), []);
      assert.equal((await apply(other, "POST", ref(later, pull))).status, 404);
    }
  );

  await t.test("doublons, déplacement, remplacement et rejeux avec intervention concurrente", async () => {
    const versions = await Promise.all(Array.from({length: 4}, () => apply(full, "POST", ref(week, squat))));
    assert.deepEqual(
      versions.map(x => x.status),
      [200, 200, 200, 200]
    );
    assert.equal((await read()).filter(p => p.week_start === week && p.wod_id === squat).length, 1);
    const origin = source(await get(week, squat));
    assert.equal((await apply(full, "POST", ref(week, squat))).status, 200);
    assert.deepEqual(source(await get(week, squat)), origin);
    const moving = {from: origin, to: ref(next, squat)};
    const key = keyAt();
    const repeated = await Promise.all([
      apply(full, "POST", moving, {key, path: movePath}),
      apply(full, "POST", moving, {key, path: movePath}),
    ]);
    assert.deepEqual(
      repeated.map(x => x.status),
      [200, 200]
    );
    assert.equal(await get(week, squat), undefined);
    const moved = await get(next, squat);
    assert.notEqual(moved.version, origin.version);
    assert.equal((await apply(full, "POST", {from: source(moved), to: ref(next, pull)}, {path: movePath})).status, 409);
    assert.equal((await apply(full, "POST", {from: source(moved), to: ref(later, row)}, {path: movePath})).status, 200);
    assert.equal(await get(next, squat), undefined);
    assert.ok(await get(later, row));
    assert.equal((await apply(full, "POST", moving, {key, path: movePath})).status, 200);
    assert.equal(await get(next, squat), undefined);
    assert.equal((await apply(full, "POST", {...moving, to: ref(later, squat)}, {key, path: movePath})).status, 409);

    const addition = keyAt();
    assert.equal((await apply(full, "POST", ref(next, core), {key: addition})).status, 200);
    const initial = await get(next, core);
    const deletion = keyAt();
    assert.equal((await apply(full, "DELETE", source(initial), {key: deletion})).status, 200);
    assert.equal((await apply(full, "POST", ref(next, core), {key: addition})).status, 200);
    assert.equal(await get(next, core), undefined);
    assert.equal((await apply(full, "POST", ref(next, core))).status, 200);
    const recreated = await get(next, core);
    assert.equal((await apply(full, "DELETE", source(initial), {key: deletion})).status, 200);
    assert.equal((await apply(full, "DELETE", source(initial))).status, 412);
    assert.deepEqual(await get(next, core), recreated);
    const expired = keyAt(Math.floor(Date.now() / 1000) - 86400);
    assert.equal((await apply(full, "DELETE", source(recreated), {key: expired})).status, 409);
  });

  await t.test("conflits entre destinations, rollback D1 et rejeu après échec du lot", async () => {
    const original = await get(next, core);
    const moves = [ref(later, core), ref(later, squat)].map(to => ({from: source(original), to}));
    const responses = await Promise.all(moves.map(body => apply(full, "POST", body, {path: movePath})));
    assert.deepEqual(responses.map(x => x.status).sort(), [200, 404]);
    assert.equal(await get(next, core), undefined);
    const result = moves[responses.findIndex(x => x.status === 200)].to;
    const winner = await get(result.week_start, result.wod_id);
    assert.ok(winner);
    const rollback = {from: source(winner), to: ref(next, core)};
    const key = keyAt();
    localD1(`CREATE TRIGGER test_reject_plan_move BEFORE UPDATE OF week_start ON weekly_plans
      BEGIN SELECT RAISE(ABORT, 'test rollback planning'); END;`);
    try {
      assert.equal((await apply(full, "POST", rollback, {key, path: movePath})).status, 500);
      assert.equal(await get(next, core), undefined);
      assert.deepEqual(await get(result.week_start, result.wod_id), winner);
    } finally {
      localD1("DROP TRIGGER test_reject_plan_move;");
    }
    assert.equal((await apply(full, "POST", rollback, {key, path: movePath})).status, 200);
    assert.ok(await get(next, core));
    assert.equal(await get(result.week_start, result.wod_id), undefined);
  });

  await t.test("séance réalisée : protection du planning API et maintien du nettoyage Web", async () => {
    const planned = await get(week, pull);
    const completed = await planner.post("/sessions", {...sessionBody, program_id: pid, wod_id: pull});
    assert.equal(completed.status, 200, JSON.stringify(completed.data));
    const sessionsBefore = (await planner.get("/sessions")).data;
    assert.equal((await get(week, pull)).completed, true);
    assert.equal((await apply(full, "DELETE", source(planned))).status, 409);
    assert.equal(
      (await apply(full, "POST", {from: source(planned), to: ref(later, pull)}, {path: movePath})).status,
      409
    );
    assert.equal((await apply(full, "POST", ref(week, pull))).status, 409);
    const another = await get(next, pull);
    assert.equal(
      (await apply(full, "POST", {from: source(another), to: ref(week, pull)}, {path: movePath})).status,
      409
    );
    assert.equal((await get(week, pull)).version, planned.version);
    assert.equal((await planner.del(path, ref(week, pull))).status, 200);
    assert.equal(await get(week, pull), undefined);
    assert.deepEqual((await planner.get("/sessions")).data, sessionsBefore);
    assert.equal((await planner.post(path, ref(week, core))).status, 200);
    const web = await get(week, core);
    assert.match(web.version, /^[a-f0-9]{32}$/);
    assert.deepEqual(
      (await planner.get(range)).data.plans.find(p => p.wod_id === core && p.week_start === week),
      {
        ...ref(week, core),
        wod_name: "Gainage",
      }
    );
  });
});

test("quotas D1 atomiques par clé et par utilisateur, avec Retry-After", async () => {
  const a = await create(alice, "Quota A", ["prs:read"]);
  const b = await create(alice, "Quota B", ["prs:read"]);
  const c = await create(bob, "Quota C", ["prs:read"]);
  // Partir loin du bord de la minute pour que les compteurs préremplis n'expirent pas pendant les appels.
  const seconds = Math.floor(Date.now() / 1000) % 60;
  if (seconds >= 50) await new Promise(resolve => setTimeout(resolve, (61 - seconds) * 1000));
  localD1(`
    UPDATE api_keys SET rate_window=unixepoch()/60,rate_count=59 WHERE name='Quota A';
    UPDATE api_user_rates SET rate_window=unixepoch()/60,rate_count=118
      WHERE user_id=(SELECT user_id FROM api_keys WHERE name='Quota A');
  `);
  const calls = await Promise.all(Array.from({length: 4}, () => bearer(a.token, "/prs")));
  assert.deepEqual(calls.map(res => res.status).sort(), [200, 429, 429, 429]);
  assert.ok(calls.filter(res => res.status === 429).every(res => Number(res.headers.get("retry-after")) > 0));
  assert.equal((await bearer(b.token, "/prs")).status, 200);
  assert.equal((await bearer(b.token, "/prs")).status, 429);
  assert.equal((await bearer(c.token, "/prs")).status, 200);
});
