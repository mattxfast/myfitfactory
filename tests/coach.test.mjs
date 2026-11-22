// Programmes de coach (idée 55) : rôle coach validé par un administrateur, programme écrit en entier avant de taguer,
// invitation, acceptation (programme suivi), refus, semaines passées figées après une modification du coach.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
let worker, admin, coach, bob, carol, dave, ids, activityId;

before(async () => {
  worker = await startWorker();
  admin = client(worker.base);
  coach = client(worker.base);
  bob = client(worker.base);
  carol = client(worker.base);
  dave = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD});
  ids = {};
  for (const [who, email, first, last] of [
    [coach, "coach@test.local", "Chloé", "Coach"],
    [bob, "bob@test.local", "Bob", "Durand"],
    [carol, "carol@test.local", "Carol", "Petit"],
    [dave, "dave@test.local", "Dave", "Roux"],
  ]) {
    await who.post("/register", {email, password: PASSWORD});
    ids[first] = (await who.put("/profile", {first_name: first, last_name: last})).data.user.id;
  }
  activityId = (await coach.get("/activities")).data.activities[0].id;
});
after(() => worker?.stop());

const wod = name => ({name, planned_comment: "", activity_id: activityId, duration_minutes: 60, is_tracked: true});
const followed = async who => {
  const d = (await who.get("/program-data")).data;
  return {program: d.programs.find(p => p.followed), weekly: d.weeklyWodPrograms};
};

test("coach : rôle demandé par l'utilisateur et validé par un administrateur", async () => {
  const early = await coach.post("/programs", {name: "Trop tôt", coach: {weeks: 2}});
  assert.equal(early.status, 403, "pas encore coach");
  assert.equal((await coach.put("/coach-request", {request: true})).status, 200);
  assert.equal((await coach.get("/preferences")).data.coach, "pending");
  assert.equal((await admin.get("/boxes")).data.pending.coaches, 1, "demande à valider pour l'administrateur");
  assert.equal((await coach.get("/boxes")).data.pending.coaches, 0);
  const row = (await admin.get("/admin/users")).data.users.find(x => x.id === ids.Chloé);
  assert.equal(row.coach_status, "pending");
  assert.equal((await coach.put(`/admin/users/${ids.Chloé}`, {coach: true})).status, 403);
  assert.equal((await admin.put(`/admin/users/${ids.Chloé}`, {coach: true})).status, 200);
  assert.equal((await coach.get("/preferences")).data.coach, "approved");
  assert.equal((await admin.get("/boxes")).data.pending.coaches, 0);
});

let freeId, freeWod, inviteBob;
test("coach : programme sans dates écrit en entier avant de taguer", async () => {
  assert.equal((await coach.post("/programs", {name: "Sans semaines", coach: {weeks: 0}})).status, 400);
  const created = await coach.post("/programs", {name: "Prépa été", coach: {weeks: 2, dated: false}});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  freeId = created.data.id;
  freeWod = (await coach.post(`/programs/${freeId}/wods`, wod("Force"))).data.id;
  await coach.put(`/wods/${freeWod}/weekly-programming`, {week_start: "2001-01-01", content: "5x5 back squat"});
  const incomplete = await coach.post(`/coach-programs/${freeId}/invites`, {user_ids: [ids.Bob]});
  assert.equal(incomplete.status, 400, "semaine 2 pas écrite");
  assert.match(incomplete.data.error, /Force/);
  await coach.put(`/wods/${freeWod}/weekly-programming`, {week_start: "2001-01-08", content: "3x3 back squat"});
  assert.equal((await bob.post(`/coach-programs/${freeId}/invites`, {user_ids: [ids.Carol]})).status, 404);
  const sent = await coach.post(`/coach-programs/${freeId}/invites`, {user_ids: [ids.Bob, ids.Carol, ids.Chloé]});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.invited, 2, "pas soi-même");
  // Publié : plus d'ajout ni de suppression de WOD, ni de changement du nombre de semaines.
  assert.equal((await coach.post(`/programs/${freeId}/wods`, wod("Engine"))).status, 409);
  assert.equal((await coach.del(`/wods/${freeWod}`)).status, 409);
  await coach.put(`/programs/${freeId}`, {name: "Prépa été 2", coach: {weeks: 5}});
  const mine = (await coach.get("/program-data")).data.programs.find(p => p.id === freeId);
  assert.equal(mine.name, "Prépa été 2");
  assert.equal(mine.coach_weeks, 2);
  const list = (await coach.get(`/coach-programs/${freeId}/invites`)).data.invites;
  assert.deepEqual(list.map(x => [x.first_name, x.status]).sort(), [
    ["Bob", "pending"],
    ["Carol", "pending"],
  ]);
  assert.equal(list[0].email, undefined, "pas d'adresse e-mail");
});

test("coach : invitation acceptée (date de début choisie) ou refusée", async () => {
  const pending = (await bob.get("/coach-invites")).data.invites;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].first_name, "Chloé");
  assert.equal(pending[0].start_monday, null, "sans dates");
  inviteBob = pending[0].id;
  assert.equal((await carol.post(`/coach-invites/${inviteBob}/accept`, {start: mondayOf(today())})).status, 404);
  assert.equal(
    (await bob.post(`/coach-invites/${inviteBob}/accept`, {start: addDays(mondayOf(today()), -7)})).status,
    400,
    "pas dans le passé"
  );
  assert.equal(
    (await bob.post(`/coach-invites/${inviteBob}/accept`, {start: addDays(mondayOf(today()), 1)})).status,
    400
  );
  const start = mondayOf(today());
  const ok = await bob.post(`/coach-invites/${inviteBob}/accept`, {start});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await bob.post(`/coach-invites/${inviteBob}/accept`, {start})).status, 404, "déjà traitée");
  const {program, weekly} = await followed(bob);
  assert.equal(program.id, freeId);
  assert.equal(program.start_monday, start);
  assert.equal(program.end_monday, addDays(start, 13));
  assert.equal(program.read_only, 1, "non modifiable par l'utilisateur");
  assert.deepEqual(
    weekly.filter(x => x.wod_id === freeWod).map(x => [x.week_start, x.content]),
    [
      [start, "5x5 back squat"],
      [addDays(start, 7), "3x3 back squat"],
    ]
  );
  // Nouvelle date de début : même nombre de semaines.
  const moved = await bob.put("/program-follow", {program_id: freeId, start: addDays(start, 7), end: "2099-01-01"});
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal((await followed(bob)).program.end_monday, addDays(start, 20));
  const carolInvite = (await carol.get("/coach-invites")).data.invites[0].id;
  assert.equal((await carol.post(`/coach-invites/${carolInvite}/decline`)).status, 200);
  assert.equal((await carol.get("/coach-invites")).data.invites.length, 0);
  assert.equal((await followed(carol)).program, undefined);
  // Une invitation refusée peut être renouvelée ; le programme suivi ne peut plus être supprimé.
  await coach.post(`/coach-programs/${freeId}/invites`, {user_ids: [ids.Carol]});
  assert.equal((await carol.get("/coach-invites")).data.invites.length, 1);
  assert.equal((await coach.del(`/programs/${freeId}`)).status, 409);
});

test("coach : programme daté, chevauchement et semaines passées figées", async () => {
  const start = addDays(mondayOf(today()), -14),
    created = await coach.post("/programs", {
      name: "Bloc force",
      start: addDays(start, 2),
      coach: {weeks: 3, dated: true},
    });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id,
    w = (await coach.post(`/programs/${id}/wods`, wod("Metcon"))).data.id;
  for (let i = 0; i < 3; i++)
    await coach.put(`/wods/${w}/weekly-programming`, {
      week_start: addDays(start, 7 * i),
      content: "Semaine " + (i + 1),
    });
  // Dave a son propre programme sur la période : il doit d'abord le modifier.
  await dave.post("/programs", {name: "Mon programme", start: mondayOf(today()), end: addDays(mondayOf(today()), 27)});
  assert.equal((await coach.post(`/coach-programs/${id}/invites`, {user_ids: [ids.Bob, ids.Dave]})).status, 200);
  const daveInvite = (await dave.get("/coach-invites")).data.invites[0];
  assert.equal(daveInvite.start_monday, start, "dates du coach");
  assert.equal((await dave.post(`/coach-invites/${daveInvite.id}/accept`)).status, 409);
  // Bob suivait le programme sans dates : celui-ci le remplace, aux dates du coach.
  const bobInvite = (await bob.get("/coach-invites")).data.invites[0];
  assert.equal((await bob.post(`/coach-invites/${bobInvite.id}/accept`)).status, 200);
  const before = await followed(bob);
  assert.equal(before.program.id, id);
  assert.equal(before.program.start_monday, start);
  assert.equal(
    (await bob.put("/program-follow", {program_id: id, start: mondayOf(today())})).status,
    404,
    "dates du coach imposées"
  );
  // Le coach réécrit les trois semaines : seule la semaine en cours (et les suivantes) change pour Bob.
  for (let i = 0; i < 3; i++)
    await coach.put(`/wods/${w}/weekly-programming`, {
      week_start: addDays(start, 7 * i),
      content: "Nouveau " + (i + 1),
    });
  const after = (await followed(bob)).weekly.filter(x => x.wod_id === w).map(x => x.content);
  assert.deepEqual(after, ["Semaine 1", "Semaine 2", "Nouveau 3"]);
  const coachView = (await coach.get("/program-data")).data.weeklyWodPrograms.filter(x => x.wod_id === w);
  assert.deepEqual(
    coachView.map(x => x.content),
    ["Nouveau 1", "Nouveau 2", "Nouveau 3"],
    "le coach voit son contenu actuel"
  );
});

test("coach : programmes de coach hors des contrôles de chevauchement du coach", async () => {
  const own = await coach.post("/programs", {
    name: "Mon entraînement",
    start: mondayOf(today()),
    end: addDays(mondayOf(today()), 27),
  });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal((await coach.put("/coach-request", {request: false})).status, 200);
  assert.equal((await coach.get("/preferences")).data.coach, null);
  assert.equal((await coach.post("/programs", {name: "Plus coach", coach: {weeks: 2}})).status, 403);
});
