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
