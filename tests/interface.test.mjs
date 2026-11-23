// Interface du compte (avancée ou simplifiée) : préférence enregistrée par utilisateur, valeur contrôlée.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, today, addDays} from "./helpers.mjs";

let worker, alice, bob;
before(async () => {
  worker = await startWorker();
  alice = client(worker.base);
  bob = client(worker.base);
  await alice.post("/register", {email: "alice@test.local", password: "MotDePasse-Test-123"});
  await bob.post("/register", {email: "bob@test.local", password: "MotDePasse-Test-123"});
});
after(() => worker?.stop());

test("interface : simplifiée à l’inscription, avancée au choix, valeur inconnue refusée", async () => {
  assert.equal((await alice.get("/preferences")).data.interface, "simple");
  assert.equal((await alice.put("/preferences", {interface: "expert"})).status, 400);
  assert.equal((await alice.get("/preferences")).data.interface, "simple");
  assert.equal((await alice.put("/preferences", {interface: "advanced", theme: "light"})).status, 200);
  const prefs = (await alice.get("/preferences")).data;
  assert.equal(prefs.interface, "advanced");
  assert.equal(prefs.theme, "light");
  assert.equal((await bob.get("/preferences")).data.interface, "simple", "chacun son interface");
  assert.equal((await alice.put("/preferences", {interface: "simple"})).status, 200);
  assert.equal((await alice.get("/preferences")).data.interface, "simple");
});

test("interface : un programme personnel en cours ou planifié rend l’interface avancée obligatoire", async () => {
  const date = today();
  const created = await alice.post("/programs", {
    name: "Cycle personnel",
    start: addDays(date, 7),
    end: addDays(date, 20),
  });
  assert.equal(created.status, 200);
  const path = "/programs/" + created.data.id;
  assert.equal((await alice.get("/preferences")).data.interface, "advanced");
  assert.equal((await alice.put("/preferences", {interface: "simple"})).status, 409);
  assert.equal((await bob.get("/preferences")).data.interface, "simple");

  assert.equal((await alice.put(path, {name: "Cycle personnel", start: addDays(date, -13), end: date})).status, 200);
  assert.equal((await alice.put("/preferences", {interface: "simple"})).status, 409);

  assert.equal(
    (await alice.put(path, {name: "Cycle personnel", start: addDays(date, -14), end: addDays(date, -1)})).status,
    200
  );
  assert.equal((await alice.put("/preferences", {interface: "simple"})).status, 200);
  assert.equal((await alice.get("/preferences")).data.interface, "simple");
});

test("interface : le verrou d’un programme suivi utilise les dates de l’abonné", async () => {
  const date = today();
  const source = await bob.post("/programs", {
    name: "Cycle public",
    start: addDays(date, -30),
    end: addDays(date, -17),
    is_public: true,
  });
  assert.equal(source.status, 200);
  assert.equal(
    (await alice.put("/program-follow", {program_id: source.data.id, start: date, end: addDays(date, 13)})).status,
    200
  );
  assert.equal((await alice.get("/preferences")).data.interface, "advanced");
  assert.equal((await alice.put("/preferences", {interface: "simple"})).status, 409);
  assert.equal((await alice.put("/preferences", {theme: "dark"})).status, 200);
  assert.equal((await alice.del("/program-follow")).status, 200);
  assert.equal((await alice.put("/preferences", {interface: "simple"})).status, 200);
  assert.equal((await alice.get("/preferences")).data.interface, "simple");
});
