// FitFactory — mode hors ligne.
// - Lectures (GET /api/…) : chaque réponse est gardée sur le téléphone ; sans réseau, la dernière copie est servie.
// - Modifications : sans réseau, elles sont mises en file d'attente (dans l'ordre), appliquées tout de suite aux
//   copies locales pour être visibles, puis rejouées au retour du réseau. Les créations de séance et de PR portent
//   un identifiant généré ici (client_id) : un rejeu ne crée jamais de doublon côté serveur.
// Chargé avant public/js/*.js ; boot.js fournit l'envoi réseau et les noms affichés (FFOffline.init).
const FFOffline = (() => {
  const CACHE = "ff-cache:",
    QUEUE = "ff-queue",
    OWNER = "ff-cache-owner";
  const NEVER_QUEUED = /^\/(login|register|logout|admin\/|admin$|push\/|password\/)/;
  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
    keys(prefix) {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) out.push(k);
        }
      } catch {}
      return out;
    },
  };
  let offline = false,
    flushing = null,
    hooks = {
      send: null,
      describeSession: () => ({}),
      describePr: () => ({}),
      describeBoxWod: () => ({}),
      describeMe: () => ({}),
      onChange: () => {},
      onSynced: () => {},
      onDropped: () => {},
    };
  const queue = () => store.get(QUEUE) || [];
  const state = () => ({offline, pending: queue().length});
  const changed = () => {
    try {
      hooks.onChange(state());
    } catch {}
  };
  const setOffline = value => {
    if (offline !== value) {
      offline = value;
      changed();
    }
  };
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  };
  const isNetworkError = error => !!error?.offline;

  // ----- Application locale d'une modification sur une copie de réponse GET -----
  const weekRange = path => {
    const m = path.match(/^\/week-data\?from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})$/);
    return m ? {from: m[1], to: m[2]} : null;
  };
  const programScorePath = /^\/wods\/([\w-]+)\/scores$/;
  const inRange = (range, date) => date >= range.from && date <= range.to;
  function removeSession(data, id) {
    data.sessions = (data.sessions || []).filter(s => s.id !== id);
    data.checks = (data.checks || []).filter(c => c.session_id !== id);
    data.catalogChecks = (data.catalogChecks || []).filter(c => c.session_id !== id);
  }
  function addSession(data, session, body) {
    data.sessions = [session, ...(data.sessions || [])].sort(
      (a, b) =>
        String(b.session_date).localeCompare(String(a.session_date)) ||
        String(b.logged_at || "").localeCompare(String(a.logged_at || ""))
    );
    data.checks = [
      ...(data.checks || []),
      ...(body.movement_ids || []).map(movement_id => ({session_id: session.id, movement_id})),
    ];
    data.catalogChecks = [
      ...(data.catalogChecks || []),
      ...(body.catalog_movement_ids || []).map(catalog_movement_id => ({session_id: session.id, catalog_movement_id})),
    ];
  }
  // WOD de box (liste du gestionnaire ou WOD des box de l'utilisateur) : création, modification, suppression.
  function patchBoxWods(data, view, op, body) {
    let m;
    const wods = (data.wods || []).filter(w => !(op.method === "POST" && w.id === body.client_id));
    if (op.method === "POST" && (m = op.path.match(/^\/manage\/boxes\/([\w-]+)\/wods$/))) {
      if ((!view.box || view.box === m[1]) && body.wod_date >= view.from && body.wod_date <= view.to)
        wods.push({
          ...body,
          id: body.client_id,
          box_id: m[1],
          pending: 1,
          ...hooks.describeBoxWod({...body, box_id: m[1]}),
        });
    } else if ((m = op.path.match(/^\/manage\/wods\/([\w-]+)$/))) {
      const i = wods.findIndex(w => w.id === m[1]);
      if (i >= 0) {
        if (op.method === "DELETE" || body.wod_date < view.from || body.wod_date > view.to) wods.splice(i, 1);
        else wods[i] = {...wods[i], ...body, pending: 1, ...hooks.describeBoxWod({...wods[i], ...body})};
      }
    }
    data.wods = wods.sort((a, b) => String(a.wod_date).localeCompare(String(b.wod_date)));
  }
  // Espace gestionnaire d'une box : adhésions et catégories.
  function patchManagedBox(data, boxId, op, body) {
    let m;
    if (op.method === "PUT" && op.path === "/manage/boxes/" + boxId)
      data.box = {...data.box, name: body.name, city: body.city};
    else if ((m = op.path.match(/^\/manage\/boxes\/([\w-]+)\/members\/([\w-]+)$/)) && m[1] === boxId) {
      if (op.method === "PUT" && body.approve)
        data.members = (data.members || []).map(x => (x.user_id === m[2] ? {...x, status: "approved"} : x));
      else data.members = (data.members || []).filter(x => x.user_id !== m[2] || x.is_manager);
    } else if ((m = op.path.match(/^\/manage\/boxes\/([\w-]+)\/(categories|wod-types)(\/order)?$/)) && m[1] === boxId) {
      // Listes paramétrables : catégories de score (data.categories) et types de WOD (data.types).
      const key = m[2] === "categories" ? "categories" : "types";
      if (m[3]) {
        const order = body.ids || [];
        data[key] = [...(data[key] || [])].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      } else {
        const id = body.client_id || op.at;
        data[key] = [...(data[key] || []).filter(c => c.id !== id), {id, name: body.name, pending: 1}];
      }
    } else if ((m = op.path.match(/^\/manage\/(categories|wod-types)\/([\w-]+)$/))) {
      const key = m[1] === "categories" ? "categories" : "types";
      if (op.method === "DELETE") data[key] = (data[key] || []).filter(c => c.id !== m[2]);
      else data[key] = (data[key] || []).map(c => (c.id === m[2] ? {...c, name: body.name} : c));
    }
  }
  function patch(path, data, op) {
    if (!data || typeof data !== "object") return data;
    const body = op.body || {},
      range = weekRange(path);
    let m;
    if (range) {
      if (op.method === "POST" && op.path === "/sessions" && inRange(range, body.session_date)) {
        removeSession(data, body.client_id);
        addSession(
          data,
          {...body, id: body.client_id, logged_at: op.at, pending: 1, ...hooks.describeSession(body)},
          body
        );
      } else if (op.method === "PUT" && (m = op.path.match(/^\/sessions\/([\w-]+)$/))) {
        const previous = (data.sessions || []).find(s => s.id === m[1]);
        removeSession(data, m[1]);
        if (inRange(range, body.session_date))
          addSession(data, {...(previous || {}), ...body, id: m[1], pending: 1, ...hooks.describeSession(body)}, body);
      } else if (op.method === "DELETE" && (m = op.path.match(/^\/sessions\/([\w-]+)$/))) {
        removeSession(data, m[1]);
      } else if (op.path === "/weekly-plans" && inRange(range, body.week_start)) {
        data.plans = (data.plans || []).filter(x => !(x.week_start === body.week_start && x.wod_id === body.wod_id));
        if (op.method === "POST")
          data.plans.push({
            week_start: body.week_start,
            wod_id: body.wod_id,
            ...hooks.describeSession({wod_id: body.wod_id}),
          });
      } else if (op.method === "POST" && op.path === "/daily-wods/benchmark" && inRange(range, body.wod_date)) {
        // WOD de référence tiré hors ligne : affiché tout de suite dans la rubrique « WOD du jour ».
        data.dailyWods = [
          ...(data.dailyWods || []).filter(w => w.id !== body.client_id),
          {...hooks.describeBenchmarkWod(body), id: body.client_id, wod_date: body.wod_date, pending: 1},
        ];
      } else if (op.method === "PUT" && op.path === "/weekly-flags" && inRange(range, body.week_start)) {
        data.flags = (data.flags || []).filter(x => x.week_start !== body.week_start);
        data.flags.push({week_start: body.week_start, competition: body.competition ? 1 : 0});
      }
    } else if ((m = path.match(programScorePath))) {
      const wodId = m[1],
        update = op.path.match(/^\/sessions\/([\w-]+)$/),
        id = op.method === "POST" && op.path === "/sessions" ? body.client_id : update?.[1];
      if (id) {
        // Ancien formulaire : sans champ score, le serveur conserve le résultat sur le même WOD.
        if (op.method === "PUT" && body.score_value === undefined && body.wod_id === wodId) return data;
        const previous = data.scores.find(s => s.id === id);
        data.scores = data.scores.filter(s => s.id !== id);
        if (op.method !== "DELETE" && body.wod_id === wodId && body.score_type && body.score_value != null) {
          data.scores.push({
            id,
            session_date: body.session_date,
            score_type: body.score_type,
            score_value: body.score_value,
            created_at: previous?.created_at || op.at,
            pending: op.synced ? 0 : 1,
          });
          data.scores.sort(
            (a, b) => b.session_date.localeCompare(a.session_date) || b.created_at.localeCompare(a.created_at)
          );
        }
      }
    } else if (path === "/benchmark-results" && op.path === "/benchmark-results" && op.method === "POST") {
      // Résultat de benchmark saisi hors ligne (page PR).
      data.results = [
        ...(data.results || []).filter(x => x.id !== body.client_id),
        {...body, id: body.client_id, scaled: body.scaled ? 1 : 0, source: "manual", created_at: op.at, pending: 1},
      ];
    } else if (path === "/benchmark-results" && (m = op.path.match(/^\/benchmark-results\/([\w-]+)$/))) {
      data.results = (data.results || []).filter(x => x.id !== m[1]);
    } else if (path === "/preferences" && op.path === "/preferences" && op.method === "PUT") {
      if (body.theme !== undefined) data.theme = body.theme;
      if (body.interface !== undefined) data.interface = body.interface;
      if (body.reminders) data.reminders = {...data.reminders, ...body.reminders};
    } else if (path === "/program-data" && op.path === "/program-follow" && op.method === "DELETE") {
      data.programs = (data.programs || []).map(p => ({...p, followed: 0}));
    } else if (path === "/program-data" && op.path === "/program-follow" && op.method === "PUT") {
      // Changement de dates du programme déjà suivi (un nouveau suivi s'affiche après synchronisation).
      data.programs = (data.programs || []).map(p =>
        p.id === body.program_id && p.followed ? {...p, start_monday: body.start, end_monday: body.end} : p
      );
    } else if (path === "/boxes" && (m = op.path.match(/^\/boxes\/([\w-]+)\/requests$/))) {
      data.memberships = (data.memberships || []).filter(x => !(x.box_id === m[1] && x.role === body.role));
      if (op.method === "POST") data.memberships.push({box_id: m[1], role: body.role, status: "pending"});
    } else if ((m = path.match(/^\/(?:manage\/boxes\/([\w-]+)\/wods|box-wods)\?from=([\d-]+)&to=([\d-]+)$/))) {
      patchBoxWods(data, {box: m[1], from: m[2], to: m[3]}, op, body);
    } else if ((m = path.match(/^\/box-wods\/([\w-]+)\/leaderboard$/))) {
      // Classement : son propre score saisi hors ligne y est ajouté (les autres scores restent ceux de la dernière copie).
      if ((op.method === "POST" || op.method === "PUT") && /^\/sessions(\/|$)/.test(op.path))
        for (const c of data.categories || []) {
          c.rows = (c.rows || []).filter(x => !(x.is_me && x.pending));
          if (body.box_wod_id === m[1] && body.score_category_id === c.id && body.score_value !== null) {
            const me = hooks.describeMe();
            c.rows = c.rows.filter(x => !x.is_me);
            c.rows.push({...me, score: body.score_value, is_me: 1, pending: 1});
            c.rows.sort((a, b) => (data.wod?.score_type === "time" ? a.score - b.score : b.score - a.score));
          }
        }
    } else if ((m = path.match(/^\/manage\/boxes\/([\w-]+)$/))) {
      patchManagedBox(data, m[1], op, body);
    } else if ((m = path.match(/^\/meals\?from=([\d-]+)&to=([\d-]+)$/))) {
      // Repas (déjà analysés) enregistrés, modifiés ou supprimés hors ligne.
      const range = {from: m[1], to: m[2]};
      let id = null;
      if (op.method === "POST" && op.path === "/meals") id = body.client_id;
      else if ((m = op.path.match(/^\/meals\/([\w-]+)$/))) id = m[1];
      if (id) {
        const previous = (data.meals || []).find(x => x.id === id);
        data.meals = (data.meals || []).filter(x => x.id !== id);
        if (op.method !== "DELETE" && inRange(range, body.meal_date))
          data.meals.push({...(previous || {}), ...body, id, pending: 1});
        data.meals.sort(
          (a, b) =>
            String(a.meal_date).localeCompare(String(b.meal_date)) ||
            String(a.meal_time).localeCompare(String(b.meal_time))
        );
      }
    } else if (path === "/prs") {
      if (op.method === "POST" && op.path === "/prs") {
        data.records = (data.records || []).filter(r => r.id !== body.client_id);
        data.records.push({...body, id: body.client_id, created_at: op.at, pending: 1, ...hooks.describePr(body)});
      } else if (op.method === "PUT" && (m = op.path.match(/^\/prs\/([\w-]+)$/))) {
        data.records = (data.records || []).map(r =>
          r.id === m[1] ? {...r, ...body, pending: 1, ...hooks.describePr(body)} : r
        );
      } else if (op.method === "DELETE" && (m = op.path.match(/^\/prs\/([\w-]+)$/))) {
        data.records = (data.records || []).filter(r => r.id !== m[1]);
      }
      if (data.records)
        data.records.sort(
          (a, b) =>
            String(a.record_date).localeCompare(String(b.record_date)) ||
            String(a.created_at || "").localeCompare(String(b.created_at || ""))
        );
    }
    return data;
  }
  const withPending = (path, data) => queue().reduce((d, op) => patch(path, d, op), data);
  // Conserve aussi l'historique à jour si le réseau repart avant sa prochaine consultation.
  function cacheSyncedScores(op, result) {
    if (!/^\/sessions(?:\/[\w-]+)?$/.test(op.path)) return;
    const synced = {
      ...op,
      synced: true,
      body: op.method === "POST" ? {...op.body, client_id: result?.id ?? op.body?.client_id} : op.body,
    };
    for (const key of store.keys(CACHE + "/wods/")) {
      const path = key.slice(CACHE.length);
      if (programScorePath.test(path)) store.set(key, patch(path, store.get(key), synced));
    }
  }

  // ----- Lecture -----
  async function read(path, fetcher) {
    try {
      const data = await fetcher();
      setOffline(false);
      store.set(CACHE + path, data);
      return withPending(path, JSON.parse(JSON.stringify(data)));
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      setOffline(true);
      const cached = store.get(CACHE + path);
      if (cached) return withPending(path, cached);
      throw error;
    }
  }

  // ----- Écriture -----
  function enqueue(op) {
    const q = queue();
    q.push(op);
    store.set(QUEUE, q);
    setOffline(true);
    changed();
  }
  async function write(path, method, body, send) {
    if (NEVER_QUEUED.test(path)) return send(body);
    if (method === "POST" && (path === "/sessions" || path === "/prs") && body && !body.client_id)
      body = {...body, client_id: uuid()};
    const op = {path, method, body: body ?? null, at: new Date().toISOString()};
    if (queue().length) await flush();
    if (queue().length) {
      enqueue(op);
      return {ok: true, queued: true, id: body?.client_id};
    }
    try {
      const result = await send(body);
      cacheSyncedScores(op, result);
      setOffline(false);
      return result;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      enqueue(op);
      return {ok: true, queued: true, id: body?.client_id};
    }
  }

  // ----- Resynchronisation : rejoue la file dans l'ordre, s'arrête à la première coupure réseau -----
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let done = 0;
      while (queue().length) {
        const op = queue()[0];
        try {
          const result = await hooks.send(op.path, op.method, op.body);
          cacheSyncedScores(op, result);
          done++;
          setOffline(false);
        } catch (error) {
          if (isNetworkError(error)) {
            setOffline(true);
            break;
          }
          if (error.status === 401) break;
          try {
            hooks.onDropped(op, error);
          } catch {}
          done++;
        }
        const q = queue();
        q.shift();
        store.set(QUEUE, q);
        changed();
      }
      if (done)
        try {
          await hooks.onSynced();
        } catch {}
    })().finally(() => {
      flushing = null;
      changed();
    });
    return flushing;
  }

  // ----- Propriétaire des données locales (changement de compte, déconnexion) -----
  function setOwner(userId) {
    const owner = store.get(OWNER);
    if (owner && owner !== userId) {
      clear();
    }
    store.set(OWNER, userId);
  }
  function clear() {
    store.keys(CACHE).forEach(k => store.del(k));
    store.del(QUEUE);
    store.del(OWNER);
    changed();
  }

  function init(options) {
    hooks = {...hooks, ...options};
    addEventListener("online", () => flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && queue().length) flush();
    });
    setInterval(() => {
      if (queue().length) flush();
    }, 20000);
    changed();
  }
  return {init, read, write, flush, clear, setOwner, state};
})();
