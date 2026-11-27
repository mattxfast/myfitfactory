import {vapidKeys, sendPush, isAllowedEndpoint, localEcdhKeys} from "./push.js";
import {
  AI_DAILY_LIMIT,
  AI_FEATURES,
  AI_PROMPT_VERSION,
  aiCost,
  aiProfileInput,
  aiOptionsInput,
  buildPrompt,
  callOpenAI,
  wodToText,
  wodBlocks,
  DAILY_PROMPT_VERSION,
  DAILY_WOD_LIMIT,
  buildDailyPrompt,
  callOpenAIDaily,
  dailyChrono,
  dailyMovementIds,
  buildCommonPrompt,
  callOpenAICommon,
  dailyOptionsInput,
  dailyWodToText,
} from "./ai.js";
import {
  MEAL_DAILY_LIMIT,
  MEAL_PROMPT_VERSION,
  NUTRIENTS,
  analyzeMeal,
  mealAnalysisInput,
  mealInput,
} from "./nutrition.js";
import {FOOD_CACHE_DAYS, fetchProduct, validBarcode} from "./foodfacts.js";
import {athleteProfileInput, computeFitness} from "./fitness.js";
import {BENCHMARKS, benchmarkById, benchmarkOut, benchmarkMovementIds, benchmarkScore} from "./benchmarks.js";
import {REPORT_PROMPT_VERSION, reportCoachComment} from "./report.js";
import {MOVEMENT_CATEGORIES, movementCategory, validMeasurementMethod} from "./movements.js";
import {
  EXTERNAL_WOD_PATH,
  EXTERNAL_PROGRAM_PATH,
  externalProgramInput,
  WOD_VERSION,
  WOD_ID,
  LEGACY_WOD_VERSION,
  externalWodInput,
  programWodState,
  generatedProgramStatements,
  saveFreeWodStatement,
  insertWodReceipt,
  generatedFreeRow,
} from "./external-wods.js";
const SESSION_DAYS = 30,
  enc = new TextEncoder();
const MOVEMENT_CATALOG_QUERY =
  "SELECT id,name,measurement_method,category FROM movement_catalog ORDER BY sort_order,name COLLATE NOCASE";
const PR_SELECT =
  "SELECT pr.id,pr.movement_id,mc.name AS movement_name,mc.measurement_method,mc.category,pr.record_date,pr.value,pr.rep_count,pr.fixed_kind,pr.fixed_value,pr.created_at,pr.edit_version FROM personal_records pr JOIN movement_catalog mc ON mc.id=pr.movement_id WHERE pr.user_id=?";
const AI_RECORDS_QUERY = `SELECT mc.name,mc.measurement_method,pr.rep_count,pr.fixed_kind,pr.fixed_value,
  CASE WHEN pr.fixed_kind IN ('distance','reps') THEN MIN(pr.value) ELSE MAX(pr.value) END AS value
  FROM personal_records pr JOIN movement_catalog mc ON mc.id=pr.movement_id WHERE pr.user_id=?
  GROUP BY pr.movement_id,pr.rep_count,pr.fixed_kind,pr.fixed_value ORDER BY mc.sort_order,pr.rep_count LIMIT 40`;
const withMovementCategory = movement => ({...movement, category: movementCategory(movement)});
const validMovementCategory = category => typeof category === "string" && Object.hasOwn(MOVEMENT_CATEGORIES, category);
const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h},
  });
const uid = () => crypto.randomUUID();
const b64 = b => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const unb64 = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const sha = async s => b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hashPass(p, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const k = await crypto.subtle.importKey("raw", enc.encode(p), "PBKDF2", false, ["deriveBits"]);
  const b = await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000}, k, 256);
  return `pbkdf2$100000$${b64(salt)}$${b64(b)}`;
}
async function verify(p, stored) {
  try {
    const [kind, n, s, e] = stored.split("$");
    if (kind !== "pbkdf2" || n !== "100000" || !s || !e) return false;
    const actual = unb64((await hashPass(p, unb64(s))).split("$")[3]),
      expected = unb64(e);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}
const cookie = (r, n) => {
  const v = (r.headers.get("Cookie") || "")
    .split(";")
    .map(x => x.trim())
    .find(x => x.startsWith(n + "="));
  return v ? decodeURIComponent(v.slice(n.length + 1)) : null;
};
// Cookie de session : « fitfactory_session » ; l’ancien nom « cfplanner_session » reste accepté et est remplacé à la requête suivante.
const SESSION_COOKIE = "fitfactory_session",
  LEGACY_SESSION_COOKIE = "cfplanner_session";
const setCookie = (v, age, name = SESSION_COOKIE) =>
  `${name}=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const sessionToken = r => cookie(r, SESSION_COOKIE) || cookie(r, LEGACY_SESSION_COOKIE);
async function me(r, e) {
  const t = sessionToken(r);
  if (!t) return null;
  return await e.DB.prepare(
    "SELECT u.id,u.email,u.first_name,u.last_name,u.is_admin,u.body_weight_kg,u.birth_date,u.sex,u.coach_status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.is_active=1"
  )
    .bind(await sha(t), Math.floor(Date.now() / 1000))
    .first();
}
async function session(id, email, e) {
  const t = b64(crypto.getRandomValues(new Uint8Array(32))),
    exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  await e.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha(t), id, exp)
    .run();
  const profile = await e.DB.prepare("SELECT first_name,last_name,is_admin FROM users WHERE id=?").bind(id).first();
  return json(
    {
      ok: true,
      user: {id, email, first_name: profile?.first_name || "", last_name: profile?.last_name || ""},
      is_admin: isAdminUser(e, {email, is_admin: profile?.is_admin}),
    },
    200,
    {"set-cookie": setCookie(t, SESSION_DAYS * 86400)}
  );
}
// Administrateurs : le compte ADMIN_EMAIL (administrateur principal, non modifiable) et les comptes nommés par un admin.
const ownerEmail = e =>
  String(e.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
const isAdminUser = (e, u) => !!u && (u.email === ownerEmail(e) || !!u.is_admin);
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addDays = (s, n) => {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// PR chronométrés : fixed_kind indique la grandeur fixée (distance, répétitions ou durée).
// Sans format, les anciennes valeurs de distance ou de répétitions restent modifiables.
function validatePr(movement, value, repCountInput, b = {}) {
  const method = movement.measurement_method,
    validReps = n => Number.isInteger(n) && n > 0 && n <= 1000,
    repsError = {error: "Le nombre de répétitions doit être un entier compris entre 1 et 1 000."};
  if (!Number.isFinite(value) || value <= 0) return {error: "Valeur de record invalide."};
  if (method === "load" || method === "force") {
    if (value > 10000) return {error: "Valeur de record invalide."};
    const repCount = Number(repCountInput);
    if (!Number.isInteger(repCount) || repCount < 1 || repCount > 20)
      return {error: "Le nombre de RM doit être compris entre 1 et 20."};
    return {repCount};
  }
  if (method === "reps") {
    if (b.fixed_kind) return {error: "Format de PR invalide."};
    return validReps(value) ? {repCount: null} : repsError;
  }
  if (method === "distance" || method === "reps_time") {
    const kind = b.fixed_kind ? String(b.fixed_kind) : "",
      fixed = Number(b.fixed_value),
      distance = method === "distance";
    if (kind === (distance ? "distance" : "reps")) {
      if (distance && (!Number.isFinite(fixed) || fixed < 10 || fixed > 100000))
        return {error: "La distance doit être comprise entre 10 m et 100 km."};
      if (!distance && !validReps(fixed)) return repsError;
      if (!Number.isInteger(value) || value > 360000) return {error: "Temps invalide (100 h au plus)."};
      return {repCount: null, fixedKind: kind, fixedValue: Math.round(fixed * 10) / 10};
    }
    if (kind && kind !== "time") return {error: "Format de PR invalide."};
    if (kind === "time" && (!Number.isInteger(fixed) || fixed < 10 || fixed > 86400))
      return {error: "La durée doit être comprise entre 10 s et 24 h."};
    if (distance && value > 100000) return {error: "La distance doit être inférieure ou égale à 100 000 mètres."};
    if (!distance && !validReps(value)) return repsError;
    return {repCount: null, fixedKind: kind || null, fixedValue: kind ? fixed : null};
  }
  return {error: "Méthode de mesure du mouvement invalide."};
}
const localToday = () => dateInTimeZone("Europe/Paris");
function dateInTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length > 80) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  } catch {
    return null;
  }
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
// Versioned, additive D1 migrations. Existing V2 databases already carry
// the v2 marker; new databases apply it once, then apply later migrations.
let schemaReady;
async function ensureV2Schema(env) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS app_migrations (version TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','running','done')), applied_at TEXT)"
    ).run();

    // Une seule lecture des migrations déjà appliquées (au lieu d'une requête par migration à chaque démarrage).
    const doneVersions = new Set(
      (await env.DB.prepare("SELECT version FROM app_migrations WHERE status='done'").all()).results.map(r => r.version)
    );
    const runMigration = async (version, apply) => {
      if (doneVersions.has(version)) return;
      await env.DB.prepare(
        "INSERT INTO app_migrations(version,status,applied_at) VALUES(?,'running',NULL) ON CONFLICT(version) DO UPDATE SET status='running'"
      )
        .bind(version)
        .run();
      await apply();
      await env.DB.prepare("UPDATE app_migrations SET status='done', applied_at=CURRENT_TIMESTAMP WHERE version=?")
        .bind(version)
        .run();
    };

    await runMigration("v2-schema-20261113", async () => {
      const schemaStatements = [
        "CREATE TABLE IF NOT EXISTS program_wods (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, planned_comment TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(program_id, name))",
        "CREATE INDEX IF NOT EXISTS program_wods_user_program ON program_wods(user_id, program_id, sort_order)",
        "CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 60, is_default INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,name))",
        "CREATE TABLE IF NOT EXISTS weekly_flags (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, competition INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,week_start))",
        "CREATE TABLE IF NOT EXISTS weekly_plans (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,week_start,wod_id))",
        "CREATE TABLE IF NOT EXISTS training_sessions (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_date TEXT NOT NULL, actual_comment TEXT NOT NULL DEFAULT '', session_count INTEGER NOT NULL DEFAULT 1 CHECK(session_count >= 1), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE INDEX IF NOT EXISTS training_sessions_user_date ON training_sessions(user_id, session_date DESC)",
        "CREATE INDEX IF NOT EXISTS training_sessions_wod_date ON training_sessions(wod_id, session_date DESC)",
        "CREATE TABLE IF NOT EXISTS movement_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE IF NOT EXISTS personal_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, movement_id TEXT NOT NULL REFERENCES movement_catalog(id) ON DELETE RESTRICT, record_date TEXT NOT NULL, value REAL NOT NULL CHECK(value>0), rep_count INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(rep_count IS NULL OR rep_count BETWEEN 1 AND 20))",
        "CREATE INDEX IF NOT EXISTS personal_records_user_movement_date ON personal_records(user_id,movement_id,rep_count,record_date)",
        "CREATE TABLE IF NOT EXISTS program_movements (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(program_id,name))",
        "CREATE INDEX IF NOT EXISTS program_movements_program ON program_movements(program_id,sort_order)",
        "CREATE TABLE IF NOT EXISTS session_movement_checks (session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE, movement_id TEXT NOT NULL REFERENCES program_movements(id) ON DELETE CASCADE, PRIMARY KEY(session_id,movement_id))",
      ];
      for (const statement of schemaStatements) await env.DB.prepare(statement).run();

      const addMissingColumns = async (table, columns) => {
        const info = await env.DB.prepare("PRAGMA table_info(" + table + ")").all();
        const existing = new Set(info.results.map(column => column.name));
        for (const [name, definition] of columns) {
          if (!existing.has(name))
            await env.DB.prepare("ALTER TABLE " + table + " ADD COLUMN " + name + " " + definition).run();
        }
      };
      await addMissingColumns("users", [
        ["first_name", "TEXT NOT NULL DEFAULT ''"],
        ["last_name", "TEXT NOT NULL DEFAULT ''"],
        ["is_active", "INTEGER NOT NULL DEFAULT 1"],
      ]);
      await addMissingColumns("program_wods", [
        ["activity_id", "TEXT"],
        ["duration_minutes", "INTEGER NOT NULL DEFAULT 60"],
      ]);
      await addMissingColumns("program_movements", [["catalog_movement_id", "TEXT"]]);
      await addMissingColumns("movement_catalog", [
        ["measurement_method", "TEXT NOT NULL DEFAULT 'load'"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ]);
      await addMissingColumns("activities", [["sort_order", "INTEGER NOT NULL DEFAULT 0"]]);
      await addMissingColumns("training_sessions", [
        ["activity_id", "TEXT"],
        ["duration_minutes", "INTEGER NOT NULL DEFAULT 60"],
        ["started_at", "TEXT"],
        ["logged_at", "TEXT"],
      ]);
    });

    // Kept separate so databases that already applied V2 receive this index.
    await runMigration("v3-session-movement-index", async () => {
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS session_movement_checks_movement ON session_movement_checks(movement_id)"
      ).run();
    });
    await runMigration("v4-weekly-wod-themes", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS weekly_wod_themes (program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, wod1_theme TEXT NOT NULL DEFAULT '', wod2_theme TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(program_id,week_start))"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS weekly_wod_themes_user_week ON weekly_wod_themes(user_id,week_start)"
      ).run();
    });
    await runMigration("v5-tracked-wod-programming", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(program_wods)").all();
      if (!columns.results.some(column => column.name === "is_tracked"))
        await env.DB.prepare("ALTER TABLE program_wods ADD COLUMN is_tracked INTEGER NOT NULL DEFAULT 0").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS weekly_wod_programming (wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(wod_id,week_start))"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS weekly_wod_programming_user_week ON weekly_wod_programming(user_id,week_start)"
      ).run();
    });
    await runMigration("v6-default-program", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(programs)").all();
      if (!columns.results.some(column => column.name === "is_default"))
        await env.DB.prepare("ALTER TABLE programs ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0").run();
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS programs_one_default_per_user ON programs(user_id) WHERE is_default=1"
      ).run();
    });
    await runMigration("v7-session-catalog-movements", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS session_catalog_movement_checks (session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE, catalog_movement_id TEXT NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE, PRIMARY KEY(session_id,catalog_movement_id))"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS session_catalog_movement_checks_movement ON session_catalog_movement_checks(catalog_movement_id)"
      ).run();
    });
    await runMigration("v8-login-attempts", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS login_attempts (attempt_key TEXT NOT NULL, attempted_at INTEGER NOT NULL)"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS login_attempts_key_time ON login_attempts(attempt_key, attempted_at)"
      ).run();
    });
    await runMigration("v9-push-reminders", async () => {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id)").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS reminder_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, days INTEGER NOT NULL DEFAULT 3, hour INTEGER NOT NULL DEFAULT 18, last_sent_on TEXT)"
      ).run();
    });
    await runMigration("v10-password-resets", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used_at INTEGER)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id)").run();
    });
    await runMigration("v11-hors-programme", async () => {
      // Le programme par défaut sans WOD visible ni mouvement devient le programme technique « Hors programme ».
      await env.DB.prepare(
        "UPDATE programs SET name='Hors programme' WHERE is_default=1 AND NOT EXISTS(SELECT 1 FROM program_wods w WHERE w.program_id=programs.id AND w.name<>'__AUTRES__') AND NOT EXISTS(SELECT 1 FROM program_movements m WHERE m.program_id=programs.id)"
      ).run();
    });
    await runMigration("v12-restore-hors-programme", async () => {
      // Répare le programme technique « Hors programme » dont le marqueur avait été retiré par la modification
      // d'un autre programme (bug corrigé) : il redevient caché, s'il n'y a pas déjà un programme par défaut.
      await env.DB.prepare(
        "UPDATE programs SET is_default=1 WHERE name='Hors programme' AND is_default=0 AND start_monday='1970-01-01' AND end_monday='2100-12-31' AND NOT EXISTS(SELECT 1 FROM program_wods w WHERE w.program_id=programs.id AND w.name<>'__AUTRES__') AND NOT EXISTS(SELECT 1 FROM program_movements mv WHERE mv.program_id=programs.id) AND NOT EXISTS(SELECT 1 FROM programs d WHERE d.user_id=programs.user_id AND d.is_default=1)"
      ).run();
    });
    await runMigration("v13-admins", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(users)").all();
      if (!columns.results.some(column => column.name === "is_admin"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
    });
    await runMigration("v14-boxes", async () => {
      for (const statement of [
        "CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE UNIQUE INDEX IF NOT EXISTS boxes_name ON boxes(name COLLATE NOCASE)",
        "CREATE TABLE IF NOT EXISTS box_members (box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('member','manager')), status TEXT NOT NULL CHECK(status IN ('pending','approved')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, PRIMARY KEY(box_id,user_id,role))",
        "CREATE INDEX IF NOT EXISTS box_members_user ON box_members(user_id,role,status)",
        "CREATE INDEX IF NOT EXISTS box_members_box ON box_members(box_id,role,status)",
        "CREATE TABLE IF NOT EXISTS box_categories (id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(box_id,name))",
      ])
        await env.DB.prepare(statement).run();
    });
    await runMigration("v15-box-wods", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS box_wods (id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, wod_date TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', score_type TEXT NOT NULL DEFAULT 'time' CHECK(score_type IN ('time','reps','load','none')), created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS box_wods_box_date ON box_wods(box_id,wod_date)").run();
    });
    await runMigration("v16-session-scores", async () => {
      const columns = new Set(
        (await env.DB.prepare("PRAGMA table_info(training_sessions)").all()).results.map(c => c.name)
      );
      for (const [name, definition] of [
        ["box_wod_id", "TEXT"],
        ["score_value", "REAL"],
        ["score_category_id", "TEXT"],
      ])
        if (!columns.has(name))
          await env.DB.prepare("ALTER TABLE training_sessions ADD COLUMN " + name + " " + definition).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS training_sessions_box_wod ON training_sessions(box_wod_id,score_category_id)"
      ).run();
    });
    await runMigration("v17-program-sharing", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(programs)").all();
      if (!columns.results.some(column => column.name === "is_public"))
        await env.DB.prepare("ALTER TABLE programs ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS program_follows (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS program_follows_program ON program_follows(program_id)").run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS programs_public ON programs(is_public,name)").run();
    });
    await runMigration("v18-follow-dates", async () => {
      // Dates propres à chaque utilisateur qui suit un programme (par défaut, celles de l'auteur).
      const columns = new Set(
        (await env.DB.prepare("PRAGMA table_info(program_follows)").all()).results.map(c => c.name)
      );
      for (const name of ["start_monday", "end_monday"])
        if (!columns.has(name)) await env.DB.prepare("ALTER TABLE program_follows ADD COLUMN " + name + " TEXT").run();
      await env.DB.prepare(
        "UPDATE program_follows SET start_monday=(SELECT start_monday FROM programs p WHERE p.id=program_follows.program_id),end_monday=(SELECT end_monday FROM programs p WHERE p.id=program_follows.program_id) WHERE start_monday IS NULL OR end_monday IS NULL"
      ).run();
    });
    await runMigration("v19-user-preferences", async () => {
      // Thème propre au compte (NULL : thème par défaut défini par l'administrateur) ; rappels activés pour le compte.
      const users = new Set((await env.DB.prepare("PRAGMA table_info(users)").all()).results.map(c => c.name));
      if (!users.has("theme")) await env.DB.prepare("ALTER TABLE users ADD COLUMN theme TEXT").run();
      const reminders = new Set(
        (await env.DB.prepare("PRAGMA table_info(reminder_settings)").all()).results.map(c => c.name)
      );
      if (!reminders.has("enabled"))
        await env.DB.prepare("ALTER TABLE reminder_settings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1").run();
    });
    await runMigration("v20-remove-auto-theme", async () => {
      // Le thème « Automatique (selon le téléphone) » est supprimé : un compte réglé ainsi suit le thème par défaut,
      // et un thème par défaut « auto » devient « Sombre ».
      await env.DB.prepare("UPDATE users SET theme=NULL WHERE theme='auto'").run();
      await env.DB.prepare("UPDATE app_settings SET value='dark' WHERE key='default_theme' AND value='auto'").run();
    });
    await runMigration("v21-reminder-hour-index", async () => {
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS reminder_settings_hour ON reminder_settings(hour, last_sent_on)"
      ).run();
    });
    await runMigration("v22-load-indexes", async () => {
      // Index pour une box de plusieurs centaines de membres : programmes d'un utilisateur, demandes en attente.
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS programs_user ON programs(user_id)").run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS box_members_role_status ON box_members(role,status)").run();
    });
    await runMigration("v20-box-wod-types", async () => {
      // Types de WOD propres à chaque box (WOD, Haltéro, Gym…), paramétrables par ses gestionnaires.
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS box_wod_types (id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(box_id,name))"
      ).run();
      const columns = await env.DB.prepare("PRAGMA table_info(box_wods)").all();
      if (!columns.results.some(column => column.name === "type_id"))
        await env.DB.prepare("ALTER TABLE box_wods ADD COLUMN type_id TEXT").run();
      // Box existantes : types par défaut ; leurs WOD existants deviennent des « WOD ».
      const boxes = (await env.DB.prepare("SELECT id FROM boxes").all()).results;
      for (const box of boxes) await env.DB.batch(defaultWodTypeStatements(env, box.id));
      await env.DB.prepare(
        "UPDATE box_wods SET type_id=(SELECT t.id FROM box_wod_types t WHERE t.box_id=box_wods.box_id ORDER BY t.sort_order LIMIT 1) WHERE type_id IS NULL"
      ).run();
    });
    await runMigration("v23-box-wod-movements", async () => {
      // Mouvements du catalogue travaillés dans un WOD de box (cochés par le gestionnaire, proposés aux membres).
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS box_wod_movements (box_wod_id TEXT NOT NULL REFERENCES box_wods(id) ON DELETE CASCADE, catalog_movement_id TEXT NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE, PRIMARY KEY(box_wod_id,catalog_movement_id))"
      ).run();
    });
    await runMigration("v24-box-prompt", async () => {
      // « Je ne suis dans aucune box » : la fenêtre d'accueil pour rejoindre une box n'est plus proposée.
      const columns = await env.DB.prepare("PRAGMA table_info(users)").all();
      if (!columns.results.some(column => column.name === "box_prompt_dismissed"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN box_prompt_dismissed INTEGER NOT NULL DEFAULT 0").run();
    });
    await runMigration("v25-ai-wod-generation", async () => {
      // Génération de WOD par IA : profil d'entraînement de l'athlète et journal des générations (traçabilité, quota).
      await env.DB.batch([
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS ai_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, level TEXT NOT NULL DEFAULT '', goals TEXT NOT NULL DEFAULT '', equipment TEXT NOT NULL DEFAULT '', constraints TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ),
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS ai_generations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, wod_id TEXT REFERENCES program_wods(id) ON DELETE SET NULL, week_start TEXT NOT NULL, options TEXT NOT NULL, result TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS ai_generations_user_date ON ai_generations(user_id,created_at)"),
      ]);
    });
    await runMigration("v26-meals", async () => {
      // Suivi de l'alimentation : repas (aliments et valeurs en JSON, totaux en colonnes) et journal des analyses par
      // IA (quota, traçabilité ; la photo n'est jamais conservée).
      await env.DB.batch([
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS meals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, meal_date TEXT NOT NULL, meal_time TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '[]', kcal REAL NOT NULL DEFAULT 0, protein_g REAL NOT NULL DEFAULT 0, carbs_g REAL NOT NULL DEFAULT 0, sugars_g REAL NOT NULL DEFAULT 0, fat_g REAL NOT NULL DEFAULT 0, sat_fat_g REAL NOT NULL DEFAULT 0, fiber_g REAL NOT NULL DEFAULT 0, salt_g REAL NOT NULL DEFAULT 0, confidence TEXT NOT NULL DEFAULT '', remarks TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS meals_user_date ON meals(user_id,meal_date,meal_time)"),
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS meal_analyses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request TEXT NOT NULL, result TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS meal_analyses_user_date ON meal_analyses(user_id,created_at)"),
      ]);
    });
    await runMigration("v27-daily-wods", async () => {
      // WOD du jour (page Séances) : entraînement hors programme généré par IA pour aujourd'hui ou demain, gardé pour
      // lancer le chrono et enregistrer la séance plus tard ; la séance enregistrée y est rattachée.
      await env.DB.batch([
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS daily_wods (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, wod_date TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, chrono TEXT, movement_ids TEXT NOT NULL DEFAULT '[]', options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS daily_wods_user_date ON daily_wods(user_id,wod_date)"),
      ]);
      const columns = await env.DB.prepare("PRAGMA table_info(training_sessions)").all();
      if (!columns.results.some(column => column.name === "daily_wod_id"))
        await env.DB.prepare("ALTER TABLE training_sessions ADD COLUMN daily_wod_id TEXT").run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS training_sessions_daily_wod ON training_sessions(daily_wod_id)"
      ).run();
    });
    await runMigration("v28-athlete-profile", async () => {
      // Score de forme : poids de corps, date de naissance et sexe de l'athlète (facultatifs).
      const columns = await env.DB.prepare("PRAGMA table_info(users)").all(),
        has = name => columns.results.some(column => column.name === name);
      if (!has("body_weight_kg")) await env.DB.prepare("ALTER TABLE users ADD COLUMN body_weight_kg REAL").run();
      if (!has("birth_date")) await env.DB.prepare("ALTER TABLE users ADD COLUMN birth_date TEXT").run();
      if (!has("sex")) await env.DB.prepare("ALTER TABLE users ADD COLUMN sex TEXT NOT NULL DEFAULT ''").run();
    });
    await runMigration("v29-engine-prs", async () => {
      // PR ENGINE : format « temps sur une distance » ou « distance dans un temps » et sa valeur fixe.
      const columns = await env.DB.prepare("PRAGMA table_info(personal_records)").all(),
        has = name => columns.results.some(column => column.name === name);
      if (!has("fixed_kind")) await env.DB.prepare("ALTER TABLE personal_records ADD COLUMN fixed_kind TEXT").run();
      if (!has("fixed_value")) await env.DB.prepare("ALTER TABLE personal_records ADD COLUMN fixed_value REAL").run();
    });
    await runMigration("v30-interface-mode", async () => {
      // Interface du compte : « advanced » (complète) ou « simple » (séances sans programmes ni rubriques de WOD).
      const columns = await env.DB.prepare("PRAGMA table_info(users)").all();
      if (!columns.results.some(column => column.name === "interface_mode"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN interface_mode TEXT NOT NULL DEFAULT 'advanced'").run();
    });
    await runMigration("v31-session-tags", async () => {
      // Partenaires tagués sur une séance : invitation en attente, acceptée (copie de la séance dans l'historique du
      // partenaire, qui garde la trace de l'auteur) ou refusée.
      await env.DB.batch(
        [
          "CREATE TABLE IF NOT EXISTS session_tags (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE, from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, responded_at TEXT, UNIQUE(session_id,to_user_id))",
          "CREATE INDEX IF NOT EXISTS session_tags_to ON session_tags(to_user_id,status)",
        ].map(sql => env.DB.prepare(sql))
      );
      const columns = await env.DB.prepare("PRAGMA table_info(training_sessions)").all();
      if (!columns.results.some(column => column.name === "shared_from_user_id"))
        await env.DB.prepare("ALTER TABLE training_sessions ADD COLUMN shared_from_user_id TEXT").run();
    });
    await runMigration("v32-session-tag-push", async () => {
      // Notification push d'une invitation : date d'envoi (une seule notification par invitation).
      const columns = await env.DB.prepare("PRAGMA table_info(session_tags)").all();
      if (!columns.results.some(column => column.name === "notified_at"))
        await env.DB.prepare("ALTER TABLE session_tags ADD COLUMN notified_at TEXT").run();
    });
    await runMigration("v33-program-wod-movements", async () => {
      // Mouvements à travailler d'un WOD de programme (catalogue) : repris par la génération IA et cochés par
      // défaut dans la séance.
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS program_wod_movements (wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, catalog_movement_id TEXT NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE, PRIMARY KEY(wod_id,catalog_movement_id))"
      ).run();
    });
    await runMigration("v34-benchmarks", async () => {
      // WOD de référence (benchmarks) : WOD du jour tiré de la liste (sans IA), score de la séance (Rx ou Scaled) et
      // résultats saisis à la main dans la page PR.
      const dw = await env.DB.prepare("PRAGMA table_info(daily_wods)").all();
      for (const [name, definition] of [
        ["benchmark_id", "TEXT"],
        ["score_type", "TEXT"],
      ])
        if (!dw.results.some(column => column.name === name))
          await env.DB.prepare("ALTER TABLE daily_wods ADD COLUMN " + name + " " + definition).run();
      const ts = await env.DB.prepare("PRAGMA table_info(training_sessions)").all();
      if (!ts.results.some(column => column.name === "score_scaled"))
        await env.DB.prepare("ALTER TABLE training_sessions ADD COLUMN score_scaled INTEGER").run();
      await env.DB.batch([
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS benchmark_results (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, benchmark_id TEXT NOT NULL, result_date TEXT NOT NULL, value REAL NOT NULL, scaled INTEGER NOT NULL DEFAULT 0, comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        ),
        env.DB.prepare(
          "CREATE INDEX IF NOT EXISTS benchmark_results_user ON benchmark_results(user_id,benchmark_id,result_date)"
        ),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS daily_wods_benchmark ON daily_wods(user_id,benchmark_id)"),
      ]);
    });
    await runMigration("v35-monthly-reports", async () => {
      // Bilan mensuel : commentaire du coach (IA, facultatif) et notification du 1er du mois (une par mois).
      await env.DB.batch([
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS monthly_reports (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,month))"
        ),
        env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS monthly_report_notices (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL)"
        ),
      ]);
    });
    await runMigration("v36-box-wod-blocks", async () => {
      // Blocs d'un WOD de box (échauffement, force / skill, metcon, finisher), en JSON ; content garde le texte complet.
      const columns = await env.DB.prepare("PRAGMA table_info(box_wods)").all();
      if (!columns.results.some(column => column.name === "blocks"))
        await env.DB.prepare("ALTER TABLE box_wods ADD COLUMN blocks TEXT").run();
    });
    await runMigration("v37-food-products", async () => {
      // Produits scannés : fiches Open Food Facts gardées 30 jours (données publiques, partagées entre comptes).
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS food_products (barcode TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    });
    await runMigration("v38-program-wod-scores", async () => {
      const [wods, sessions] = await Promise.all([
        env.DB.prepare("PRAGMA table_info(program_wods)").all(),
        env.DB.prepare("PRAGMA table_info(training_sessions)").all(),
      ]);
      const changes = [];
      if (!wods.results.some(column => column.name === "score_type"))
        changes.push(
          env.DB.prepare(
            "ALTER TABLE program_wods ADD COLUMN score_type TEXT NOT NULL DEFAULT 'none' CHECK(score_type IN ('none','time','rounds','load'))"
          )
        );
      if (!sessions.results.some(column => column.name === "program_score_type"))
        changes.push(
          env.DB.prepare(
            "ALTER TABLE training_sessions ADD COLUMN program_score_type TEXT CHECK(program_score_type IN ('time','rounds','load'))"
          )
        );
      changes.push(
        env.DB.prepare(
          "CREATE INDEX IF NOT EXISTS program_wod_scores ON training_sessions(user_id,wod_id,session_date DESC,created_at DESC) WHERE program_score_type IS NOT NULL AND score_value IS NOT NULL"
        )
      );
      await env.DB.batch(changes);
    });
    await runMigration("v39-ai-wod-blocks", async () => {
      // Blocs des WOD générés par l'IA (échauffement, travail technique, force, metcon, finisher), en JSON, pour les
      // afficher par rubrique dans le détail : WOD du jour et contenu semaine par semaine d'un WOD de programme.
      for (const table of ["daily_wods", "weekly_wod_programming"]) {
        const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.results.some(column => column.name === "blocks"))
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN blocks TEXT`).run();
      }
    });
    await runMigration("v40-common-wods", async () => {
      // WOD aléatoire du jour (un seul par jour pour toute l'application), notifications envoyées, réglage de la
      // notification, et lien entre le WOD du jour d'un membre (« Je le fais ») et le WOD aléatoire.
      await env.DB.batch(
        [
          "CREATE TABLE IF NOT EXISTS common_wods (id TEXT PRIMARY KEY, wod_date TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', title TEXT, content TEXT, blocks TEXT, score_type TEXT, movement_ids TEXT NOT NULL DEFAULT '[]', model TEXT, attempt_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
          "CREATE TABLE IF NOT EXISTS common_wod_notices (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, wod_date TEXT NOT NULL)",
        ].map(sql => env.DB.prepare(sql))
      );
      const [users, daily] = await Promise.all([
        env.DB.prepare("PRAGMA table_info(users)").all(),
        env.DB.prepare("PRAGMA table_info(daily_wods)").all(),
      ]);
      if (!users.results.some(column => column.name === "common_wod_push"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN common_wod_push INTEGER NOT NULL DEFAULT 1").run();
      if (!daily.results.some(column => column.name === "common_wod_id"))
        await env.DB.prepare("ALTER TABLE daily_wods ADD COLUMN common_wod_id TEXT").run();
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS daily_wods_common ON daily_wods(common_wod_id,user_id) WHERE common_wod_id IS NOT NULL"
      ).run();
    });
    await runMigration("v41-ai-usage", async () => {
      // Suivi des tokens OpenAI (espace admin) : un enregistrement par appel, toutes fonctionnalités confondues (le
      // WOD aléatoire n'a pas d'utilisateur) ; gardé si le compte est supprimé, pour le total du mois.
      await env.DB.batch(
        [
          "CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, feature TEXT NOT NULL, model TEXT NOT NULL, usage_date TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
          "CREATE INDEX IF NOT EXISTS ai_usage_date ON ai_usage(usage_date)",
        ].map(sql => env.DB.prepare(sql))
      );
    });
    await runMigration("v42-common-wod-optin", async () => {
      // WOD aléatoire du jour : option à activer dans Mon compte (désactivée par défaut, y compris pour les comptes
      // existants) ; elle commande la rubrique de la page Séances et la notification. common_wod_push n'est plus lu.
      const columns = await env.DB.prepare("PRAGMA table_info(users)").all();
      if (!columns.results.some(column => column.name === "common_wod_enabled"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN common_wod_enabled INTEGER NOT NULL DEFAULT 0").run();
    });
    await runMigration("v43-coach-programs", async () => {
      // Programmes de coach : rôle coach (demandé par l'utilisateur, validé par un administrateur), programme de coach
      // (nombre de semaines, avec ou sans dates, date de publication), invitations des utilisateurs tagués, et contenu
      // remplacé après publication (les semaines déjà passées d'un utilisateur gardent le contenu de l'époque).
      const [users, programs] = await Promise.all([
        env.DB.prepare("PRAGMA table_info(users)").all(),
        env.DB.prepare("PRAGMA table_info(programs)").all(),
      ]);
      if (!users.results.some(column => column.name === "coach_status"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN coach_status TEXT").run();
      for (const [name, type] of [
        ["coach_mode", "TEXT"],
        ["coach_weeks", "INTEGER"],
        ["published_at", "TEXT"],
      ])
        if (!programs.results.some(column => column.name === name))
          await env.DB.prepare(`ALTER TABLE programs ADD COLUMN ${name} ${type}`).run();
      await env.DB.batch(
        [
          "CREATE TABLE IF NOT EXISTS coach_invites (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, coach_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, responded_at TEXT, notified_at TEXT, UNIQUE(program_id,user_id))",
          "CREATE INDEX IF NOT EXISTS coach_invites_user ON coach_invites(user_id,status)",
          "CREATE TABLE IF NOT EXISTS coach_wod_history (id INTEGER PRIMARY KEY AUTOINCREMENT, wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, week_start TEXT NOT NULL, content TEXT NOT NULL, blocks TEXT, replaced_on TEXT NOT NULL)",
          "CREATE INDEX IF NOT EXISTS coach_wod_history_wod ON coach_wod_history(wod_id,week_start)",
          "CREATE INDEX IF NOT EXISTS users_coach_status ON users(coach_status)",
        ].map(sql => env.DB.prepare(sql))
      );
    });
    await runMigration("v44-global-wod-types", async () => {
      // Types de WOD : une seule liste pour toute l'application, gérée par l'administrateur (avant : une liste par
      // box). Reprise des noms déjà utilisés par les box (dans leur ordre), puis des types par défaut ; les WOD de box
      // gardent leur type (par son nom). Les WOD de programme et les séances reçoivent aussi un type (facultatif).
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS wod_types (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
      const used = (
          await env.DB.prepare(
            "SELECT name,MIN(sort_order) AS o FROM box_wod_types GROUP BY lower(name) ORDER BY o,name"
          ).all()
        ).results.map(x => x.name),
        names = [...used];
      for (const name of DEFAULT_WOD_TYPES)
        if (!names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
      await env.DB.batch(
        names.map((name, i) =>
          env.DB.prepare("INSERT OR IGNORE INTO wod_types(id,name,sort_order) VALUES(?,?,?)").bind(
            crypto.randomUUID(),
            name,
            i
          )
        )
      );
      for (const [table, column] of [
        ["box_wods", "wod_type_id"],
        ["program_wods", "type_id"],
        ["training_sessions", "type_id"],
      ]) {
        const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.results.some(c => c.name === column))
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
      }
      await env.DB.prepare(
        "UPDATE box_wods SET wod_type_id=(SELECT wt.id FROM wod_types wt JOIN box_wod_types bt ON lower(bt.name)=lower(wt.name) WHERE bt.id=box_wods.type_id) WHERE wod_type_id IS NULL"
      ).run();
    });
    await runMigration("v45-default-wod-type", async () => {
      // Type non précisé = type par défaut (le premier de la liste) : WOD de box, WOD de programme et séances
      // enregistrés sans type le reçoivent.
      const first = await env.DB.prepare("SELECT id FROM wod_types ORDER BY sort_order,name LIMIT 1").first();
      if (!first) return;
      await env.DB.batch(
        [
          "UPDATE box_wods SET wod_type_id=? WHERE wod_type_id IS NULL",
          "UPDATE program_wods SET type_id=? WHERE type_id IS NULL AND name<>'__AUTRES__'",
          "UPDATE training_sessions SET type_id=? WHERE type_id IS NULL",
        ].map(sql => env.DB.prepare(sql).bind(first.id))
      );
    });
    await runMigration("v46-movement-categories", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(movement_catalog)").all();
      if (!columns.results.some(c => c.name === "category"))
        await env.DB.prepare("ALTER TABLE movement_catalog ADD COLUMN category TEXT").run();
    });
    await runMigration("v47-personal-api-keys", async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prefix TEXT NOT NULL UNIQUE,
          key_hash TEXT NOT NULL,
          permissions TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          rate_window INTEGER NOT NULL DEFAULT -1,
          rate_count INTEGER NOT NULL DEFAULT 0
        )`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS api_keys_user_created ON api_keys(user_id,created_at DESC,id)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_user_rates (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          rate_window INTEGER NOT NULL,
          rate_count INTEGER NOT NULL
        )`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS api_keys_count_user_rate
          AFTER UPDATE OF rate_count ON api_keys
          BEGIN
            INSERT INTO api_user_rates(user_id,rate_window,rate_count)
            VALUES(NEW.user_id,NEW.rate_window,1)
            ON CONFLICT(user_id) DO UPDATE SET
              rate_count=CASE WHEN rate_window=NEW.rate_window THEN rate_count+1 ELSE 1 END,
              rate_window=NEW.rate_window;
          END`),
      ]);
    });
    await runMigration("v48-session-edit-version", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(training_sessions)").all();
      if (!columns.results.some(column => column.name === "edit_version")) {
        try {
          await env.DB.prepare("ALTER TABLE training_sessions ADD COLUMN edit_version TEXT NOT NULL DEFAULT ''").run();
        } catch (error) {
          if (!String(error.message).includes("duplicate column name: edit_version")) throw error;
        }
      }
      await env.DB.batch([
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS training_sessions_initial_edit_version
          AFTER INSERT ON training_sessions WHEN NEW.edit_version=''
          BEGIN
            UPDATE training_sessions SET edit_version=lower(hex(randomblob(16))) WHERE id=NEW.id;
          END`),
        env.DB.prepare("UPDATE training_sessions SET edit_version=lower(hex(randomblob(16))) WHERE edit_version=''"),
      ]);
    });
    await runMigration("v49-weekly-plan-versions", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(weekly_plans)").all();
      if (!columns.results.some(column => column.name === "plan_version")) {
        try {
          await env.DB.prepare("ALTER TABLE weekly_plans ADD COLUMN plan_version TEXT NOT NULL DEFAULT ''").run();
        } catch (error) {
          if (!String(error.message).includes("duplicate column name: plan_version")) throw error;
        }
      }
      await env.DB.batch([
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS weekly_plans_initial_version
          AFTER INSERT ON weekly_plans WHEN NEW.plan_version=''
          BEGIN
            UPDATE weekly_plans SET plan_version=lower(hex(randomblob(16)))
            WHERE user_id=NEW.user_id AND week_start=NEW.week_start AND wod_id=NEW.wod_id;
          END`),
        env.DB.prepare("UPDATE weekly_plans SET plan_version=lower(hex(randomblob(16))) WHERE plan_version=''"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS weekly_plan_requests (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          PRIMARY KEY(user_id,request_id)
        )`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS weekly_plan_requests_expiry ON weekly_plan_requests(expires_at)"),
      ]);
    });
    await runMigration("v50-pr-edit-versions", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(personal_records)").all();
      if (!columns.results.some(column => column.name === "edit_version")) {
        try {
          await env.DB.prepare("ALTER TABLE personal_records ADD COLUMN edit_version TEXT NOT NULL DEFAULT ''").run();
        } catch (error) {
          if (!String(error.message).includes("duplicate column name: edit_version")) throw error;
        }
      }
      await env.DB.batch([
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS personal_records_initial_edit_version
          AFTER INSERT ON personal_records WHEN NEW.edit_version=''
          BEGIN
            UPDATE personal_records SET edit_version=lower(hex(randomblob(16))) WHERE id=NEW.id AND user_id=NEW.user_id;
          END`),
        env.DB.prepare("UPDATE personal_records SET edit_version=lower(hex(randomblob(16))) WHERE edit_version=''"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS pr_api_requests (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          detail TEXT,
          pr_id TEXT NOT NULL,
          PRIMARY KEY(user_id,request_id)
        )`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS pr_api_requests_expiry ON pr_api_requests(expires_at)"),
      ]);
    });
    await runMigration("v51-cardio-intensity", async () => {
      const tables = [
        [
          "training_sessions",
          [
            [
              "cardio_intensity",
              "cardio_intensity IS NULL OR (typeof(cardio_intensity)='integer' AND cardio_intensity BETWEEN 0 AND 4)",
            ],
          ],
        ],
        [
          "programs",
          [
            [
              "weekly_cardio_target_min",
              "weekly_cardio_target_min IS NULL OR (typeof(weekly_cardio_target_min)='integer' AND weekly_cardio_target_min>=0)",
            ],
            [
              "weekly_cardio_target_max",
              "weekly_cardio_target_max IS NULL OR (typeof(weekly_cardio_target_max)='integer' AND weekly_cardio_target_max>=0 AND (weekly_cardio_target_min IS NULL OR weekly_cardio_target_min<=weekly_cardio_target_max))",
            ],
          ],
        ],
      ];
      for (const [table, fields] of tables) {
        const {results} = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        for (const [field, check] of fields) {
          if (results.some(column => column.name === field)) continue;
          try {
            await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${field} INTEGER CHECK (${check})`).run();
          } catch (error) {
            if (!String(error.message).includes("duplicate column name: " + field)) throw error;
          }
        }
      }
    });
    await runMigration("v52-external-wod-programming", async () => {
      for (const [table, field, type] of [
        ["programs", "coaching_instructions", "TEXT"],
        ["weekly_wod_programming", "edit_version", "TEXT NOT NULL DEFAULT '" + LEGACY_WOD_VERSION + "'"],
        ["daily_wods", "edit_version", "TEXT NOT NULL DEFAULT '" + LEGACY_WOD_VERSION + "'"],
      ]) {
        const {results} = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        if (results.some(column => column.name === field)) continue;
        try {
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${field} ${type}`).run();
        } catch (error) {
          if (!String(error.message).includes("duplicate column name: " + field)) throw error;
        }
      }
      const triggers = [
        ["weekly_wod_programming", "wod_id=NEW.wod_id AND week_start=NEW.week_start", "content,blocks,week_start"],
        ["daily_wods", "id=NEW.id", "wod_date,title,content,blocks,chrono,movement_ids,options,score_type"],
      ].flatMap(([table, where, fields]) => [
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS ${table}_initial_wod_version AFTER INSERT ON ${table}
          WHEN NEW.edit_version='${LEGACY_WOD_VERSION}'
          BEGIN UPDATE ${table} SET edit_version=lower(hex(randomblob(16))) WHERE ${where}; END`),
        env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS ${table}_changed_wod_version AFTER UPDATE OF ${fields} ON ${table}
          WHEN NEW.edit_version=OLD.edit_version
          BEGIN UPDATE ${table} SET edit_version=lower(hex(randomblob(16))) WHERE ${where}; END`),
      ]);
      await env.DB.batch([
        ...triggers,
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS wod_api_requests (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          version TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY(user_id,request_id)
        )`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS wod_api_requests_expiry ON wod_api_requests(expires_at)"),
        env.DB.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('wod_preview_signing',?)").bind(
          b64(crypto.getRandomValues(new Uint8Array(32)))
        ),
      ]);
    });
  })().catch(err => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}
// Rappels : notification si aucune séance depuis N jours, envoyée à l'heure choisie (heure de Paris).
const REMINDER_DAYS = [2, 3, 4, 5, 7],
  REMINDER_HOURS = [7, 12, 18, 20];
// Réglages par défaut définis par un administrateur (table app_settings) : thème et rappels des comptes qui n'ont
// rien choisi. Le thème et les rappels sont propres à chaque compte, quel que soit l'appareil.
const THEMES = ["light", "dark", "massilia", "massilia2"];
// Interface du compte : complète (« advanced ») ou simplifiée (« simple »).
const INTERFACES = ["advanced", "simple"];
async function appDefaults(e) {
  const rows = (
      await e.DB.prepare(
        "SELECT key,value FROM app_settings WHERE key IN ('default_theme','default_reminder_days','default_reminder_hour','default_reminders_enabled')"
      ).all()
    ).results,
    v = Object.fromEntries(rows.map(x => [x.key, x.value]));
  return {
    theme: THEMES.includes(v.default_theme) ? v.default_theme : "dark",
    reminder_days: REMINDER_DAYS.includes(Number(v.default_reminder_days)) ? Number(v.default_reminder_days) : 3,
    reminder_hour: REMINDER_HOURS.includes(Number(v.default_reminder_hour)) ? Number(v.default_reminder_hour) : 18,
    reminders_enabled: v.default_reminders_enabled === "0" ? 0 : 1,
  };
}
// Réglages des rappels du compte (valeurs absentes : réglage actuel ou valeur par défaut).
async function saveReminderSettings(e, userId, b) {
  const current = await userReminders(e, userId),
    days = b.days === undefined ? current.days : Number(b.days),
    hour = b.hour === undefined ? current.hour : Number(b.hour),
    enabled = b.enabled === undefined ? current.enabled : b.enabled ? 1 : 0;
  if (!REMINDER_DAYS.includes(days) || !REMINDER_HOURS.includes(hour)) return "Réglage de rappel invalide.";
  await e.DB.prepare(
    "INSERT INTO reminder_settings(user_id,days,hour,enabled) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET days=excluded.days,hour=excluded.hour,enabled=excluded.enabled"
  )
    .bind(userId, days, hour, enabled)
    .run();
  return null;
}
async function userReminders(e, userId) {
  const d = await appDefaults(e),
    st = await e.DB.prepare("SELECT days,hour,enabled FROM reminder_settings WHERE user_id=?").bind(userId).first();
  return {
    days: st?.days ?? d.reminder_days,
    hour: st?.hour ?? d.reminder_hour,
    enabled: st ? st.enabled : d.reminders_enabled,
    defaults: d,
  };
}
const parisHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23"})
      .formatToParts(new Date())
      .find(x => x.type === "hour").value
  );
const daysBetween = (from, to) => Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 86400000);
async function pushToUser(e, userId, message) {
  const subs = (
      await e.DB.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?").bind(userId).all()
    ).results,
    keys = await vapidKeys(e.DB),
    subject = "mailto:" + (String(e.ADMIN_EMAIL || "").trim() || "admin@fitfactory.invalid");
  let sent = 0;
  for (const sub of subs) {
    try {
      const status = await sendPush(sub, keys, subject, message);
      if (status === 404 || status === 410)
        await e.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(sub.endpoint).run();
      else if (status >= 200 && status < 300) sent++;
      else console.error("myFitFactory push", {status});
    } catch (err) {
      console.error("myFitFactory push", {message: err?.message});
    }
  }
  return {sent, devices: subs.length};
}
// Notification push aux partenaires tagués pas encore prévenus (une seule par invitation, sur les appareils où ils ont
// activé les notifications). Au plus 10 envois par requête (plan gratuit : temps de calcul) ; au-delà, la pastille
// rouge de l'onglet Séances suffit.
async function notifyTaggedPartners(e, author, sessionId) {
  const rows = (
    await e.DB.prepare(
      "SELECT t.id,t.to_user_id,s.session_date FROM session_tags t JOIN training_sessions s ON s.id=t.session_id WHERE t.session_id=? AND t.from_user_id=? AND t.status='pending' AND t.notified_at IS NULL"
    )
      .bind(sessionId, author.id)
      .all()
  ).results;
  if (!rows.length) return;
  const list = items => items.map(() => "?").join(",");
  await e.DB.prepare(`UPDATE session_tags SET notified_at=? WHERE id IN (${list(rows)})`)
    .bind(new Date().toISOString(), ...rows.map(x => x.id))
    .run();
  const subs = (
    await e.DB.prepare(
      `SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id IN (${list(rows)}) ORDER BY user_id LIMIT 10`
    )
      .bind(...rows.map(x => x.to_user_id))
      .all()
  ).results;
  if (!subs.length) return;
  const keys = await vapidKeys(e.DB),
    subject = "mailto:" + (String(e.ADMIN_EMAIL || "").trim() || "admin@fitfactory.invalid"),
    name = [author.first_name, author.last_name].filter(Boolean).join(" ") || "Un partenaire",
    date = rows[0].session_date.split("-").reverse().join("/"),
    message = {
      title: "myFitFactory",
      body: `${name} t’a tagué sur sa séance du ${date} : ajoute-la à ton historique en un toucher.`,
      tag: "session-tag",
      url: "/",
    };
  for (const sub of subs) {
    try {
      const status = await sendPush(sub, keys, subject, message);
      if (status === 404 || status === 410)
        await e.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(sub.endpoint).run();
      else if (status < 200 || status >= 300) console.error("myFitFactory push tag", {status});
    } catch (err) {
      console.error("myFitFactory push tag", {message: err?.message});
    }
  }
}
// Envoi après la réponse quand c'est possible (ctx.waitUntil), sans jamais faire échouer l'enregistrement.
function afterTagging(ctx, e, author, sessionId) {
  const job = notifyTaggedPartners(e, author, sessionId).catch(err =>
    console.error("myFitFactory push tag", {message: err?.message})
  );
  return ctx?.waitUntil ? ctx.waitUntil(job) : job;
}
// Envoi des rappels compatible avec le plan gratuit de Cloudflare (10 ms de calcul, 50 appels sortants et 50 requêtes
// D1 par exécution) : la tâche tourne chaque minute et envoie au plus REMINDER_BATCH notifications par passage (environ
// 0,7 ms de calcul chacune) ; les suivantes partent aux passages suivants de la même heure (60 passages, soit jusqu'à
// 600 notifications par créneau). Requêtes D1 par passage : environ 4, quel que soit le nombre de membres.
const REMINDER_BATCH = 10;
async function sendReminders(e) {
  // TEST_PARIS_HOUR : uniquement pour les tests locaux (simule l'heure de Paris) ; jamais défini en production.
  const hour = e.TEST_PARIS_HOUR ? Number(e.TEST_PARIS_HOUR) : parisHour();
  if (!REMINDER_HOURS.includes(hour)) return {sent: 0};
  const today = localToday(),
    rows = (
      await e.DB.prepare(
        "SELECT rs.user_id,rs.days,(SELECT MAX(session_date) FROM training_sessions s WHERE s.user_id=rs.user_id) AS last_date FROM reminder_settings rs WHERE rs.hour=? AND rs.enabled=1 AND (rs.last_sent_on IS NULL OR rs.last_sent_on<>?) AND EXISTS(SELECT 1 FROM push_subscriptions p WHERE p.user_id=rs.user_id) ORDER BY rs.user_id LIMIT 300"
      )
        .bind(hour, today)
        .all()
    ).results;
  if (!rows.length) return {sent: 0};
  // Séance récente : rien à envoyer aujourd'hui, marqué comme traité pour ne plus être relu.
  const done = [],
    due = [];
  for (const row of rows) {
    const since = row.last_date ? daysBetween(row.last_date, today) : null;
    if (since !== null && since < row.days) done.push(row.user_id);
    else due.push({...row, since});
  }
  const batchUsers = due.slice(0, REMINDER_BATCH),
    subs = batchUsers.length
      ? (
          await e.DB.prepare(
            `SELECT user_id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id IN (${batchUsers.map(() => "?").join(",")})`
          )
            .bind(...batchUsers.map(x => x.user_id))
            .all()
        ).results
      : [];
  // Respect du plafond : un membre n'est traité que si toutes ses notifications tiennent dans le paquet.
  const sending = [];
  for (const user of batchUsers) {
    const own = subs.filter(x => x.user_id === user.user_id);
    if (sending.length && sending.length + own.length > REMINDER_BATCH) break;
    own.forEach(sub => sending.push({sub, user}));
    done.push(user.user_id);
  }
  const gone = [];
  let sent = 0;
  if (sending.length) {
    const keys = await vapidKeys(e.DB),
      subject = "mailto:" + (String(e.ADMIN_EMAIL || "").trim() || "admin@fitfactory.invalid"),
      batch = {localKeys: await localEcdhKeys(), jwts: new Map()};
    await Promise.all(
      sending.map(async ({sub, user}) => {
        const body =
          user.since === null
            ? "Aucune séance enregistrée pour l’instant : on commence aujourd’hui ?"
            : `Aucune séance depuis ${user.since} jours. On s’y remet aujourd’hui ?`;
        try {
          const status = await sendPush(
            sub,
            keys,
            subject,
            {title: "myFitFactory", body, tag: "reminder", url: "/"},
            fetch,
            batch
          );
          if (status === 404 || status === 410) gone.push(sub.endpoint);
          else if (status >= 200 && status < 300) sent++;
          else console.error("myFitFactory push", {status});
        } catch (err) {
          console.error("myFitFactory push", {message: err?.message});
        }
      })
    );
  }
  const statements = [];
  if (done.length)
    statements.push(
      e.DB.prepare(
        `UPDATE reminder_settings SET last_sent_on=? WHERE user_id IN (${done.map(() => "?").join(",")})`
      ).bind(today, ...done)
    );
  if (gone.length)
    statements.push(
      e.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint IN (${gone.map(() => "?").join(",")})`).bind(...gone)
    );
  if (statements.length) await e.DB.batch(statements);
  return {
    sent,
    processed: done.length,
    remaining: due.length - batchUsers.filter(u => done.includes(u.user_id)).length,
  };
}
// Séances « hors programme » : rattachées à un programme technique caché (is_default=1, 1970 → 2100), créé à la demande.
// Le front envoie program_id = "none" ; aucun programme par défaut n'est à créer par l'utilisateur.
async function fallbackProgramId(e, userId) {
  const find = () => e.DB.prepare("SELECT id FROM programs WHERE user_id=? AND is_default=1").bind(userId).first();
  let program = await find();
  if (!program) {
    await e.DB.prepare(
      "INSERT OR IGNORE INTO programs(id,user_id,name,start_monday,end_monday,is_default) VALUES(?,?,'Hors programme','1970-01-01','2100-12-31',1)"
    )
      .bind(uid(), userId)
      .run();
    program = await find();
  }
  return program.id;
}
// Programmes accessibles : les siens, celui qu'on suit (programme public d'un autre utilisateur, en lecture seule)
// et ceux où l'on a déjà des séances (programme suivi auparavant). Trois paramètres : l'utilisateur, trois fois.
const PROGRAM_ACCESS =
  "(p.user_id=? OR p.id IN (SELECT program_id FROM program_follows WHERE user_id=?) OR p.id IN (SELECT program_id FROM training_sessions WHERE user_id=?))";
const ownProgram = (e, userId, id) =>
  e.DB.prepare("SELECT 1 FROM programs WHERE id=? AND user_id=?")
    .bind(String(id || ""), userId)
    .first();
// Dates d'un programme pour l'utilisateur : celles du programme s'il en est l'auteur, celles qu'il a choisies s'il le
// suit ; pour un programme suivi auparavant (séances restées dans l'historique), aucune contrainte de dates.
const FOLLOW_JOIN = " LEFT JOIN program_follows f ON f.program_id=p.id AND f.user_id=? ";
function userProgramDates(program, userId) {
  if (program.user_id === userId) return {start: program.start_monday, end: program.end_monday};
  if (program.follow_start) return {start: program.follow_start, end: program.follow_end};
  return {start: "0000-01-01", end: "9999-12-31"};
}
// Programmation hebdomadaire d'un programme suivi : la semaine N de l'auteur devient la semaine N de l'utilisateur.
const weekShift = (authorStart, followStart) => daysBetween(mondayOfDate(authorStart), mondayOfDate(followStart));
const mondayOfDate = d => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));
// Statistiques d'entraînement sur une période (progression, bilan mensuel) : séances par semaine, par origine
// (programmation, box, WOD du jour, séance libre) et mouvements les plus travaillés (une fois par séance).
async function trainingStats(e, userId, from, to) {
  const lowerBound = from ?? "0000-01-01";
  const [rows, moves] = await e.DB.batch([
    e.DB.prepare(
      "SELECT s.session_date,s.cardio_intensity,CASE WHEN s.box_wod_id IS NOT NULL THEN 'box' WHEN s.daily_wod_id IS NOT NULL THEN 'daily' WHEN w.name='__AUTRES__' THEN 'libre' ELSE 'prog' END AS source,COUNT(*) AS n FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ? GROUP BY s.session_date,source,s.cardio_intensity ORDER BY s.session_date"
    ).bind(userId, lowerBound, to),
    e.DB.prepare(
      "SELECT name,COUNT(*) AS n FROM (SELECT DISTINCT s.id AS sid,LOWER(TRIM(COALESCE(mc.name,pm.name))) AS k,COALESCE(mc.name,pm.name) AS name FROM training_sessions s JOIN session_movement_checks c ON c.session_id=s.id JOIN program_movements pm ON pm.id=c.movement_id LEFT JOIN movement_catalog mc ON mc.id=pm.catalog_movement_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ? UNION SELECT DISTINCT s.id,LOWER(TRIM(mc.name)),mc.name FROM training_sessions s JOIN session_catalog_movement_checks c ON c.session_id=s.id JOIN movement_catalog mc ON mc.id=c.catalog_movement_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ?) GROUP BY k ORDER BY n DESC,name LIMIT 10"
    ).bind(userId, lowerBound, to, userId, lowerBound, to),
  ]);
  const first = from ?? rows.results[0]?.session_date,
    days = new Set(),
    byWeek = new Map(),
    intenseByWeek = new Map(),
    intensityCounts = {unreported: 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0},
    bySource = {prog: 0, box: 0, daily: 0, libre: 0},
    weeks = [];
  let total = 0;
  for (const {session_date, source, n, cardio_intensity: intensity} of rows.results) {
    const week = mondayOfDate(session_date);
    byWeek.set(week, (byWeek.get(week) || 0) + n);
    intensityCounts[intensity ?? "unreported"] += n;
    if (intensity >= 3) intenseByWeek.set(week, (intenseByWeek.get(week) || 0) + n);
    bySource[source] += n;
    days.add(session_date);
    total += n;
  }
  if (first) {
    for (let w = mondayOfDate(first); w <= to; w = addDays(w, 7))
      weeks.push({week_start: w, count: byWeek.get(w) || 0});
  }
  return {
    total,
    days: days.size,
    weeks,
    active_weeks: byWeek.size,
    by_source: bySource,
    movements: moves.results.map(x => ({name: x.name, count: x.n})),
    cardio: {
      total: intensityCounts[3] + intensityCounts[4],
      by_intensity: intensityCounts,
      weeks: weeks.map(({week_start}) => ({week_start, count: intenseByWeek.get(week_start) || 0})),
    },
  };
}
// La semaine en cours ne coupe la série qu’une fois terminée.
function activeWeekStreak(weeks) {
  let i = weeks.length - 1,
    streak = 0;
  if (!weeks[i]?.count) i--;
  for (; i >= 0 && weeks[i].count; i--) streak++;
  return streak;
}
// Bilan mensuel : mois « AAAA-MM » (jusqu'au mois en cours), premier et dernier jour, mois voisins.
const monthStart = month => month + "-01";
const monthEnd = month => addDays(monthStart(shiftMonth(month, 1)), -1);
function shiftMonth(month, n) {
  const [y, m] = month.split("-").map(Number),
    d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const validMonth = (month, now) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= now.slice(0, 7);
// Bilan d'un mois : séances (comparées au mois précédent), régularité, répartition, mouvements travaillés et à
// reprendre (travaillés les deux mois précédents mais pas celui-ci), PR, benchmarks, scores de box, commentaire.
async function monthlyReport(e, userId, month) {
  const now = localToday(),
    from = monthStart(month),
    to = month === now.slice(0, 7) ? now : monthEnd(month),
    prevMonth = shiftMonth(month, -1);
  const [stats, prev, before, prs, manualBench, sessionBench, boxScores, saved] = await Promise.all([
    trainingStats(e, userId, from, to),
    trainingStats(e, userId, monthStart(prevMonth), monthEnd(prevMonth)),
    trainingStats(e, userId, monthStart(shiftMonth(month, -2)), monthEnd(prevMonth)),
    e.DB.prepare(
      "SELECT pr.record_date,mc.name,mc.measurement_method,pr.value,pr.rep_count,pr.fixed_kind,pr.fixed_value FROM personal_records pr JOIN movement_catalog mc ON mc.id=pr.movement_id WHERE pr.user_id=? AND pr.record_date BETWEEN ? AND ? ORDER BY pr.record_date"
    )
      .bind(userId, from, to)
      .all(),
    e.DB.prepare(
      "SELECT benchmark_id,result_date,value,scaled FROM benchmark_results WHERE user_id=? AND result_date BETWEEN ? AND ?"
    )
      .bind(userId, from, to)
      .all(),
    e.DB.prepare(
      "SELECT dw.benchmark_id,s.session_date AS result_date,s.score_value AS value,COALESCE(s.score_scaled,0) AS scaled FROM training_sessions s JOIN daily_wods dw ON dw.id=s.daily_wod_id AND dw.user_id=s.user_id WHERE s.user_id=? AND dw.benchmark_id IS NOT NULL AND s.score_value IS NOT NULL AND s.session_date BETWEEN ? AND ?"
    )
      .bind(userId, from, to)
      .all(),
    e.DB.prepare(
      "SELECT COUNT(*) AS n FROM training_sessions WHERE user_id=? AND box_wod_id IS NOT NULL AND score_value IS NOT NULL AND session_date BETWEEN ? AND ?"
    )
      .bind(userId, from, to)
      .first(),
    e.DB.prepare("SELECT comment FROM monthly_reports WHERE user_id=? AND month=?").bind(userId, month).first(),
  ]);
  const worked = new Set(stats.movements.map(x => x.name.toLowerCase()));
  return {
    month,
    from,
    to,
    complete: to === monthEnd(month),
    total: stats.total,
    days: stats.days,
    prev_total: prev.total,
    active_weeks: stats.active_weeks,
    weeks: stats.weeks.length,
    by_source: stats.by_source,
    cardio: stats.cardio,
    movements: stats.movements,
    to_resume: before.movements.filter(x => !worked.has(x.name.toLowerCase())).slice(0, 4),
    prs: prs.results,
    benchmarks: [...manualBench.results, ...sessionBench.results]
      .map(x => ({...x, name: benchmarkById(x.benchmark_id)?.name || x.benchmark_id}))
      .sort((a, b) => a.result_date.localeCompare(b.result_date)),
    box_scores: boxScores?.n || 0,
    comment: saved?.comment || "",
  };
}
// WOD aléatoire du jour : une seule génération par jour pour toute l'application, à partir de 5 h (heure de Paris), par
// la tâche planifiée (ou par l'administrateur). La ligne est réservée (« pending ») avant l'appel à l'IA ; nouvel
// essai 15 minutes après un échec.
async function ensureCommonWod(e, date, force = false) {
  const find = () => e.DB.prepare("SELECT * FROM common_wods WHERE wod_date=?").bind(date).first();
  let row = await find();
  if (row?.status === "ready") return {wod: row};
  if (!e.OPENAI_API_KEY) return {error: "La génération par IA n'est pas configurée (clé OpenAI manquante)."};
  const now = new Date().toISOString(),
    stale = new Date(Date.now() - 15 * 60000).toISOString();
  if (!row) {
    await e.DB.prepare("INSERT OR IGNORE INTO common_wods(id,wod_date,status,attempt_at) VALUES(?,?,'pending',?)")
      .bind(uid(), date, now)
      .run();
    row = await find();
    if (row.attempt_at !== now) return {pending: true};
  } else {
    if (!force && row.attempt_at > stale) return {pending: true};
    const claim = await e.DB.prepare("UPDATE common_wods SET attempt_at=? WHERE id=? AND attempt_at IS ?")
      .bind(now, row.id, row.attempt_at)
      .run();
    if (!claim.meta?.changes) return {pending: true};
  }
  const [catalog, recent] = await Promise.all([
    e.DB.prepare("SELECT id,name FROM movement_catalog ORDER BY sort_order,name COLLATE NOCASE").all(),
    e.DB.prepare(
      "SELECT wod_date,title FROM common_wods WHERE status='ready' AND wod_date<? ORDER BY wod_date DESC LIMIT 10"
    )
      .bind(date)
      .all(),
  ]);
  const out = await callOpenAICommon(
    e,
    buildCommonPrompt({
      dateLabel: frenchDate(date),
      catalog: catalog.results,
      recent: recent.results.map(x => ({date: frenchDate(x.wod_date), title: x.title})),
    })
  );
  if (out.error) return out;
  const title =
      String(out.wod.titre || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || "WOD aléatoire",
    values = [
      title,
      (title + "\n\n" + wodToText(out.wod, 2000, false)).slice(0, 4000),
      JSON.stringify(wodBlocks(out.wod)),
      out.wod.score_type === "none" ? null : out.wod.score_type,
      JSON.stringify(dailyMovementIds(out.wod, catalog.results)),
      out.model,
    ];
  await e.DB.prepare(
    "UPDATE common_wods SET status='ready',title=?,content=?,blocks=?,score_type=?,movement_ids=?,model=? WHERE id=?"
  )
    .bind(...values, row.id)
    .run();
  return {wod: await find()};
}
async function commonWodEnabled(e, userId) {
  const row = await e.DB.prepare("SELECT common_wod_enabled FROM users WHERE id=?").bind(userId).first();
  return !!row?.common_wod_enabled;
}
const commonWodOut = x =>
  x && {
    id: x.id,
    wod_date: x.wod_date,
    title: x.title,
    content: x.content,
    blocks: x.blocks ? JSON.parse(x.blocks) : null,
    score_type: x.score_type || null,
    movement_ids: JSON.parse(x.movement_ids || "[]"),
  };
// Tâche planifiée (chaque minute) : génération à partir de 5 h, puis notification à partir de 6 h aux membres qui ont
// activé le WOD aléatoire dans Mon compte et les notifications, 5 par passage (plan gratuit), une fois par jour.
async function sendCommonWod(e) {
  const hour = e.TEST_PARIS_HOUR ? Number(e.TEST_PARIS_HOUR) : parisHour(),
    today = e.TEST_PARIS_DATE || localToday();
  if (hour < 5) return {sent: 0};
  // Personne n'a activé l'option : pas de génération (pas d'appel à l'IA pour rien).
  if (!(await e.DB.prepare("SELECT 1 FROM users WHERE common_wod_enabled=1 AND is_active=1 LIMIT 1").first()))
    return {sent: 0};
  const ready = await ensureCommonWod(e, today);
  if (!ready.wod || hour < 6 || hour >= 12) return {sent: 0};
  const users = (
    await e.DB.prepare(
      "SELECT u.id FROM users u WHERE u.is_active=1 AND u.common_wod_enabled=1 AND EXISTS(SELECT 1 FROM push_subscriptions p WHERE p.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM common_wod_notices n WHERE n.user_id=u.id AND n.wod_date=?) LIMIT 5"
    )
      .bind(today)
      .all()
  ).results.map(x => x.id);
  let sent = 0;
  for (const userId of users) {
    await e.DB.prepare(
      "INSERT INTO common_wod_notices(user_id,wod_date) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET wod_date=excluded.wod_date"
    )
      .bind(userId, today)
      .run();
    sent += (
      await pushToUser(e, userId, {
        title: "myFitFactory",
        body: `WOD aléatoire du jour : « ${ready.wod.title} ». Tu le fais avec les autres ?`,
        tag: "common-wod",
        url: "/",
      })
    ).sent;
  }
  return {sent};
}
// Notification du 1er du mois, à 10 h (heure de Paris) : « ton bilan est prêt », une fois par mois, aux membres qui
// ont des séances le mois écoulé ; par paquets (limites du plan gratuit), comme les rappels.
async function sendMonthlyReportPushes(e) {
  const hour = e.TEST_PARIS_HOUR ? Number(e.TEST_PARIS_HOUR) : parisHour(),
    today = e.TEST_PARIS_DATE || localToday();
  if (hour !== 10 || today.slice(8, 10) !== "01") return {sent: 0};
  const month = shiftMonth(today.slice(0, 7), -1),
    users = (
      await e.DB.prepare(
        "SELECT DISTINCT s.user_id FROM training_sessions s WHERE s.session_date BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM push_subscriptions p WHERE p.user_id=s.user_id) AND NOT EXISTS(SELECT 1 FROM monthly_report_notices n WHERE n.user_id=s.user_id AND n.month=?) LIMIT ?"
      )
        .bind(monthStart(month), monthEnd(month), month, 5)
        .all()
    ).results.map(x => x.user_id);
  if (!users.length) return {sent: 0};
  const label = new Intl.DateTimeFormat("fr-FR", {month: "long", timeZone: "UTC"}).format(
    new Date(monthStart(month) + "T12:00:00Z")
  );
  let sent = 0;
  for (const userId of users) {
    sent += (
      await pushToUser(e, userId, {
        title: "myFitFactory",
        body: `Ton bilan ${/^[aeiou]/i.test(label) ? "d’" : "de "}${label} est prêt : séances, régularité, PR…`,
        tag: "monthly-report",
        url: "/?bilan=" + month,
      })
    ).sent;
    await e.DB.prepare(
      "INSERT INTO monthly_report_notices(user_id,month) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET month=excluded.month"
    )
      .bind(userId, month)
      .run();
  }
  return {sent};
}
// Un seul programme à la fois : un programme suivi ne chevauche aucun programme personnel en cours ou à venir.
// Les programmes de coach écrits par l'utilisateur (pour d'autres) ne comptent pas.
async function followOverlap(e, userId, start, end) {
  return await e.DB.prepare(
    "SELECT name FROM programs WHERE user_id=? AND is_default=0 AND coach_mode IS NULL AND end_monday>=? AND NOT(end_monday<? OR start_monday>?)"
  )
    .bind(userId, localToday(), start, end)
    .first();
}
// Programme personnel : il ne doit pas chevaucher le programme suivi (aux dates choisies par l'utilisateur).
async function followedOverlap(e, userId, start, end) {
  return await e.DB.prepare(
    "SELECT p.name FROM program_follows f JOIN programs p ON p.id=f.program_id WHERE f.user_id=? AND NOT(f.end_monday<? OR f.start_monday>?)"
  )
    .bind(userId, start, end)
    .first();
}
async function hasTrainingProgram(e, userId) {
  const date = localToday();
  return !!(await e.DB.prepare(
    `SELECT 1 FROM programs p WHERE p.user_id=? AND p.is_default=0 AND p.coach_mode IS NULL
      AND p.end_monday>=? AND NOT(p.start_monday='1970-01-01' AND p.end_monday='2100-12-31')
     UNION ALL
     SELECT 1 FROM program_follows f JOIN programs p ON p.id=f.program_id
      WHERE f.user_id=? AND p.user_id<>? AND p.is_default=0 AND COALESCE(f.end_monday,p.end_monday)>=?
      AND NOT(COALESCE(f.start_monday,p.start_monday)='1970-01-01' AND COALESCE(f.end_monday,p.end_monday)='2100-12-31')
     LIMIT 1`
  )
    .bind(userId, date, userId, userId, date)
    .first());
}
// Programmes de coach : un coach écrit un programme (nombre de semaines obligatoire, dates facultatives) et tague des
// utilisateurs, qui l'acceptent (il devient leur programme suivi) ou le refusent. Sans dates, la semaine 1 est rangée
// au lundi COACH_FREE_START et chacun choisit sa date de début en acceptant.
const COACH_FREE_START = "2001-01-01",
  COACH_MAX_WEEKS = 52,
  COACH_INVITE_MAX = 20;
const coachEnd = (start, weeks) => addDays(start, weeks * 7 - 1);
const isMonday = d => validDate(d) && new Date(d + "T12:00:00Z").getUTCDay() === 1;
// Avant de taguer : tous les WOD écrits sur toutes les semaines (WOD suivi : contenu de chaque semaine ; WOD non
// suivi : sa description, la même chaque semaine). Renvoie le message d'erreur, ou null.
async function coachProgramMissing(e, program) {
  const wods = (
    await e.DB.prepare(
      "SELECT w.name,w.is_tracked,w.planned_comment,(SELECT COUNT(*) FROM weekly_wod_programming x WHERE x.wod_id=w.id AND x.week_start>=? AND x.week_start<=? AND TRIM(x.content)<>'') AS written FROM program_wods w WHERE w.program_id=? AND w.name<>'__AUTRES__' ORDER BY w.sort_order,w.created_at"
    )
      .bind(program.start_monday, program.end_monday, program.id)
      .all()
  ).results;
  if (!wods.length) return "Ajoute au moins un WOD au programme avant de taguer des utilisateurs.";
  const missing = wods.find(w =>
    w.is_tracked ? w.written < program.coach_weeks : !String(w.planned_comment || "").trim()
  );
  return missing
    ? "Le WOD « " +
        missing.name +
        " » n’est pas écrit pour toutes les semaines : écris-le (ou génère-le avec l’IA) avant de taguer des utilisateurs."
    : null;
}
// Programme de coach publié : le contenu d'une semaine qui va être remplacé est gardé avec la date du remplacement.
// Les semaines déjà passées de ceux qui le suivent continuent d'afficher le contenu de l'époque (voir program-data).
const coachHistoryStatement = (e, wodId, week, content) =>
  e.DB.prepare(
    "INSERT INTO coach_wod_history(wod_id,week_start,content,blocks,replaced_on) SELECT x.wod_id,x.week_start,x.content,x.blocks,? FROM weekly_wod_programming x JOIN program_wods w ON w.id=x.wod_id JOIN programs p ON p.id=w.program_id WHERE x.wod_id=? AND x.week_start=? AND p.published_at IS NOT NULL AND x.content<>?"
  ).bind(localToday(), wodId, week, content);
// Programme de coach déjà publié : WOD et semaines figés (on ne peut plus qu'en modifier le contenu).
const publishedCoachProgram = (e, programId) =>
  e.DB.prepare("SELECT 1 FROM programs WHERE id=? AND coach_mode IS NOT NULL AND published_at IS NOT NULL")
    .bind(programId)
    .first();
// Formulaire d'un programme de coach : nom, nombre de semaines (obligatoire) et, s'il est daté, son premier lundi.
function coachProgramInput(b) {
  const name = String(b.name || "")
      .trim()
      .slice(0, 100),
    weeks = Number(b.coach?.weeks),
    dated = !!b.coach?.dated;
  if (!name) return {error: "Nom du programme requis."};
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > COACH_MAX_WEEKS)
    return {error: "Nombre de semaines : de 1 à " + COACH_MAX_WEEKS + "."};
  if (dated && !validDate(b.start)) return {error: "Choisis la date de début du programme."};
  const start = dated ? mondayOfDate(b.start) : COACH_FREE_START;
  return {name, weeks, start, end: coachEnd(start, weeks), mode: dated ? "dated" : "free"};
}
const coachingInstructions = value =>
  value == null ? null : typeof value === "string" && value.trim().length <= 4000 ? value.trim() || null : undefined;
const CARDIO_TARGET_FIELDS = ["weekly_cardio_target_min", "weekly_cardio_target_max"];
// Une valeur absente garde l’objectif enregistré, tandis que null efface la borne.
function programCardioTargets(body, previous = {}) {
  const values = CARDIO_TARGET_FIELDS.map(
    field => (Object.hasOwn(body, field) ? body[field] : previous[field]) ?? null
  );
  const [min, max] = values;
  if (values.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0)))
    return {error: "Les objectifs cardio doivent être des nombres entiers positifs ou nuls."};
  if (min !== null && max !== null && min > max)
    return {error: "Le minimum cardio doit être inférieur ou égal au maximum cible."};
  const changed = CARDIO_TARGET_FIELDS.filter(field => Object.hasOwn(body, field)),
    instructions = coachingInstructions(body.coaching_instructions);
  if (instructions === undefined) return {error: "Les consignes de coaching doivent faire au plus 4 000 caractères."};
  return {
    values,
    instructions,
    sql:
      changed.map(field => "," + field + "=?").join("") +
      (Object.hasOwn(body, "coaching_instructions") ? ",coaching_instructions=?" : ""),
    args: [
      ...changed.map(field => body[field]),
      ...(Object.hasOwn(body, "coaching_instructions") ? [instructions] : []),
    ],
  };
}
async function saveProgramChanges(db, statements) {
  try {
    await db.batch(statements);
  } catch (error) {
    if (/CHECK constraint failed:.*weekly_cardio_target/.test(String(error.message)))
      return json({error: "L’objectif cardio a changé. Actualise le programme avant de le modifier."}, 409);
    throw error;
  }
  return json({ok: true});
}
// Notification push des invitations pas encore annoncées (une seule par invitation), 10 envois au plus.
async function notifyCoachInvites(e, coach, programId) {
  const rows = (
    await e.DB.prepare(
      "SELECT i.id,i.user_id,p.name FROM coach_invites i JOIN programs p ON p.id=i.program_id WHERE i.program_id=? AND i.coach_id=? AND i.status='pending' AND i.notified_at IS NULL"
    )
      .bind(programId, coach.id)
      .all()
  ).results;
  if (!rows.length) return;
  const list = rows.map(() => "?").join(",");
  await e.DB.prepare(`UPDATE coach_invites SET notified_at=? WHERE id IN (${list})`)
    .bind(new Date().toISOString(), ...rows.map(x => x.id))
    .run();
  const name = [coach.first_name, coach.last_name].filter(Boolean).join(" ") || "Un coach",
    message = {
      title: "myFitFactory",
      body: `${name} te propose son programme « ${rows[0].name} » : accepte-le dans l’onglet Programmes.`,
      tag: "coach-invite",
      url: "/",
    };
  let sent = 0;
  for (const row of rows) {
    if (sent >= 10) break;
    sent += (await pushToUser(e, row.user_id, message)).devices;
  }
}
// Mot de passe oublié : lien à usage unique valable 30 minutes (seule l'empreinte du jeton est gardée en base).
// Envoi par e-mail via Resend si RESEND_API_KEY et MAIL_FROM sont configurés ; sinon le lien est écrit dans les logs
// du Worker (visibles du seul propriétaire du compte Cloudflare) et l'administrateur peut aussi le générer.
const RESET_MINUTES = 30;
async function createResetLink(e, userId, origin) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  await e.DB.prepare("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha(token), userId, Math.floor(Date.now() / 1000) + RESET_MINUTES * 60)
    .run();
  return origin + "/?reset=" + encodeURIComponent(token);
}
async function sendResetEmail(e, to, link) {
  if (!e.RESEND_API_KEY || !e.MAIL_FROM) {
    console.log("myFitFactory réinitialisation (aucun service d’e-mail configuré)", {email: to, lien: link});
    return false;
  }
  const text = `Bonjour,\n\nPour choisir un nouveau mot de passe myFitFactory, ouvre ce lien (valable ${RESET_MINUTES} minutes, utilisable une seule fois) :\n${link}\n\nSi tu n’es pas à l’origine de cette demande, ignore simplement ce message.`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {Authorization: "Bearer " + e.RESEND_API_KEY, "content-type": "application/json"},
    body: JSON.stringify({from: e.MAIL_FROM, to, subject: "Réinitialiser ton mot de passe myFitFactory", text}),
  });
  if (!res.ok) console.error("myFitFactory e-mail", {status: res.status});
  return res.ok;
}
// Identifiant généré par le téléphone (mode hors ligne) : rend la création rejouable sans doublon.
const clientId = v =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""))
    ? String(v).toLowerCase()
    : null;
// Box : un utilisateur est membre et/ou gestionnaire d'une box (demande « pending » puis validation « approved »).
// Les adhésions sont validées par un gestionnaire de la box, les gestionnaires par un administrateur.
const DEFAULT_BOX_CATEGORIES = ["RX", "Inter", "Scaled"];
// Listes paramétrables d'une box (noms de tables fixes, jamais issus de la requête).
const BOX_LISTS = {
  categories: {
    table: "box_categories",
    used: "SELECT 1 FROM training_sessions WHERE score_category_id=? LIMIT 1",
    usedError: "Des scores utilisent cette catégorie : elle ne peut plus être supprimée.",
    missing: "Catégorie introuvable.",
    exists: "Cette catégorie existe déjà.",
    required: "Nom de la catégorie requis.",
    last: "La box doit garder au moins une catégorie.",
  },
  "wod-types": {
    table: "box_wod_types",
    used: "SELECT 1 FROM box_wods WHERE type_id=? LIMIT 1",
    usedError: "Des WOD utilisent ce type : il ne peut plus être supprimé.",
    missing: "Type de WOD introuvable.",
    exists: "Ce type de WOD existe déjà.",
    required: "Nom du type de WOD requis.",
    last: "La box doit garder au moins un type de WOD.",
  },
};
// Types de WOD par défaut d'une box ; le premier (« WOD ») est proposé par défaut à la saisie.
const DEFAULT_WOD_TYPES = ["WOD", "Haltéro", "Gym", "FBB", "Hyrox", "Endurance"];
// Type de WOD d'une séance : celui du WOD quand il en a un (WOD de box, WOD de programme), non modifiable ; sinon
// (séance libre, « Autres », WOD du jour) celui choisi dans le formulaire.
async function sessionTypeId(e, b, boxWod, programWod) {
  const fixed = boxWod ? boxWod.wod_type_id : programWod?.name !== "__AUTRES__" ? programWod?.type_id : null;
  if (fixed) return {id: fixed};
  return await wodTypeOf(e, b.type_id);
}
// Type de WOD (liste commune gérée par l'administrateur) : celui envoyé s'il existe ; non précisé, celui par défaut
// (le premier de la liste).
async function wodTypeOf(e, raw) {
  if (raw === undefined || raw === null || raw === "")
    return (
      (await e.DB.prepare("SELECT id,name FROM wod_types ORDER BY sort_order,name LIMIT 1").first()) || {
        id: null,
        name: null,
      }
    );
  const t = await e.DB.prepare("SELECT id,name FROM wod_types WHERE id=?").bind(String(raw)).first();
  return t || {error: "Type de WOD invalide."};
}
const defaultWodTypeStatements = (e, boxId) =>
  DEFAULT_WOD_TYPES.map((name, i) =>
    e.DB.prepare("INSERT OR IGNORE INTO box_wod_types(id,box_id,name,sort_order) VALUES(?,?,?,?)").bind(
      crypto.randomUUID(),
      boxId,
      name,
      i
    )
  );
const boxRole = (e, userId, boxId, role) =>
  e.DB.prepare("SELECT 1 FROM box_members WHERE box_id=? AND user_id=? AND role=? AND status='approved'")
    .bind(boxId, userId, role)
    .first();
// Séances : WOD du programme, « Autres » ou WOD d'une box (avec score et catégorie).
const SESSION_SELECT =
  "SELECT s.*,a.name AS activity_name,COALESCE(bw.name,dw.title,CASE WHEN w.name='__AUTRES__' THEN 'Autres' ELSE w.name END) AS wod_name,COALESCE(bw.content,dw.content,w.planned_comment) AS planned_comment,p.name AS program_name,bw.box_id,bw.wod_date AS box_wod_date,COALESCE(bw.score_type,dw.score_type,s.program_score_type) AS score_type,dw.benchmark_id,dw.common_wod_id,bx.name AS box_name,bc.name AS score_category_name,dw.wod_date AS daily_wod_date,wt.name AS wod_type_name,su.first_name AS shared_from_first_name,su.last_name AS shared_from_last_name FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id JOIN programs p ON p.id=s.program_id LEFT JOIN activities a ON a.id=s.activity_id LEFT JOIN box_wods bw ON bw.id=s.box_wod_id LEFT JOIN boxes bx ON bx.id=bw.box_id LEFT JOIN box_categories bc ON bc.id=s.score_category_id LEFT JOIN daily_wods dw ON dw.id=s.daily_wod_id AND dw.user_id=s.user_id LEFT JOIN users su ON su.id=s.shared_from_user_id LEFT JOIN wod_types wt ON wt.id=s.type_id WHERE s.user_id=?";
// Partenaires tagués sur une séance (10 au plus, sans l'auteur) ; null si la requête n'en parle pas (inchangés).
function sessionTagIds(b, userId) {
  if (!Array.isArray(b.tagged_user_ids)) return null;
  return [...new Set(b.tagged_user_ids.map(String))]
    .filter(id => /^[\w-]{1,64}$/.test(id) && id !== userId)
    .slice(0, 10);
}
// Invitations à créer : seulement pour des comptes actifs, une seule par partenaire et par séance.
function sessionTagStatements(e, userId, sessionId, ids, version = null) {
  const guard = version ? " AND " + SESSION_AT_VERSION : "";
  const args = version ? [sessionId, userId, version] : [];
  return ids.map(id =>
    e.DB.prepare(
      "INSERT OR IGNORE INTO session_tags(id,session_id,from_user_id,to_user_id) SELECT ?,?,?,id FROM users WHERE id=? AND is_active=1" +
        guard
    ).bind(uid(), sessionId, userId, id, ...args)
  );
}
// Séance sur un WOD de box : l'utilisateur doit être membre validé de la box (sauf s'il modifie une séance
// déjà enregistrée sur ce WOD). Le score dépend du type choisi par le gestionnaire.
async function sessionBoxWod(e, userId, b, sessionId = null) {
  if (!b.box_wod_id) return {wod: null};
  const id = String(b.box_wod_id),
    kept =
      sessionId &&
      (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE id=? AND user_id=? AND box_wod_id=?")
        .bind(sessionId, userId, id)
        .first()),
    wod = await e.DB.prepare(
      "SELECT w.id,w.box_id,w.score_type,w.wod_type_id FROM box_wods w WHERE w.id=? AND (? OR (w.wod_date<=? AND EXISTS(SELECT 1 FROM box_members m WHERE m.box_id=w.box_id AND m.user_id=? AND m.role='member' AND m.status='approved')))"
    )
      .bind(id, kept ? 1 : 0, localToday(), userId)
      .first();
  if (!wod) return {error: "WOD de box introuvable.", status: 404};
  const raw = b.score_value;
  if (wod.score_type === "none" || raw === null || raw === undefined || raw === "")
    return {wod, value: null, category: null};
  const {value, error} = wodScoreValue(wod.score_type, raw);
  if (error) return {error, status: 400};
  const category = await e.DB.prepare("SELECT id FROM box_categories WHERE id=? AND box_id=?")
    .bind(String(b.score_category_id || ""), wod.box_id)
    .first();
  if (!category) return {error: "Choisis une catégorie (RX, Scaled…).", status: 400};
  return {wod, value, category: category.id};
}
const PROGRAM_SCORE_TYPES = ["none", "time", "rounds", "load"];
function wodScoreValue(type, raw) {
  const value = Number(raw);
  if (type === "time" && (!Number.isInteger(value) || value < 1 || value > 86400)) return {error: "Temps invalide."};
  if (type === "reps" && (!Number.isInteger(value) || value < 1 || value > 100000))
    return {error: "Le nombre de répétitions doit être un entier positif."};
  if (type === "rounds" && (!Number.isInteger(value) || value < 1 || value > 100000))
    return {error: "Le nombre de tours doit être un entier de 1 à 100 000."};
  if (type === "load" && (!Number.isFinite(value) || value <= 0 || value > 1000)) return {error: "Charge invalide."};
  return {value};
}
// La séance garde l’unité de sa saisie, même si le WOD change de type de score ensuite.
function sessionProgramScore(wod, body, previous = null) {
  if (body.box_wod_id || body.daily_wod_id || wod.name === "__AUTRES__") return {type: null, value: null};
  const savedType = previous?.wod_id === wod.id ? previous.program_score_type : null;
  const raw = body.score_value;
  if (raw === undefined && savedType) return {type: savedType, value: previous.score_value};
  if (raw === null || raw === undefined || raw === "") return {type: null, value: null};
  const type = body.score_type ?? savedType ?? wod.score_type;
  if (!PROGRAM_SCORE_TYPES.includes(type) || type === "none" || (type !== wod.score_type && type !== savedType))
    return {error: "Le type de score de ce WOD a changé ou n’est pas disponible."};
  if (typeof raw !== "number" && typeof raw !== "string") return {error: "Score invalide."};
  return {type, ...wodScoreValue(type, raw)};
}
// Séance sur un WOD du jour : il doit appartenir à l'utilisateur (séance « hors programme », WOD « Autres »). WOD de
// référence (benchmark) : score facultatif (temps ou répétitions) et Rx / Scaled.
async function sessionDailyWod(e, userId, b) {
  if (!b.daily_wod_id || b.box_wod_id) return {id: null, value: null, scaled: null};
  const row = await e.DB.prepare("SELECT id,wod_date,benchmark_id,score_type FROM daily_wods WHERE id=? AND user_id=?")
    .bind(String(b.daily_wod_id), userId)
    .first();
  if (!row) return {error: "WOD du jour introuvable.", status: 404};
  const bench = row.benchmark_id ? benchmarkById(row.benchmark_id) : null,
    raw = b.score_value;
  if (raw === null || raw === undefined || raw === "") return {id: row.id, value: null, scaled: null};
  // WOD saisi à la main avec un type de score : temps, répétitions ou charge.
  if (!bench && SCORE_TYPES.includes(row.score_type) && row.score_type !== "none") {
    if (typeof raw !== "number" && typeof raw !== "string") return {error: "Score invalide.", status: 400};
    const score = wodScoreValue(row.score_type, raw);
    return score.error ? {error: score.error, status: 400} : {id: row.id, value: score.value, scaled: null};
  }
  if (!bench) return {id: row.id, value: null, scaled: null};
  const score = benchmarkScore(bench, raw);
  if (score.error) return {error: score.error, status: 400};
  return {id: row.id, value: score.value, scaled: b.score_scaled ? 1 : 0};
}
// Mouvements du catalogue d'un WOD saisi à la main (proposés par l'IA quand elle a pré-rempli les blocs) : seuls
// les identifiants existants sont gardés, 40 au plus ; JSON pour la colonne movement_ids.
async function catalogMovementIds(e, input) {
  const ids = [...new Set((Array.isArray(input) ? input : []).map(String))]
    .filter(id => /^[\w-]{1,64}$/.test(id))
    .slice(0, 40);
  if (!ids.length) return "[]";
  const x = await e.DB.prepare(`SELECT id FROM movement_catalog WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all();
  const known = new Set(x.results.map(r => r.id));
  return JSON.stringify(ids.filter(id => known.has(id)));
}
function manualOf(x) {
  try {
    const o = x.options ? JSON.parse(x.options) : null;
    return o?.manual ? {name: o.name || "", blocks: o.blocks || {}} : null;
  } catch {
    return null;
  }
}
// WOD saisi à la main (page Séances, « Nouveau WOD » → Saisie manuelle) : nom facultatif, aujourd'hui ou demain (la
// veille reste acceptée pour une saisie hors ligne envoyée plus tard, et une date déjà enregistrée peut être gardée),
// mêmes blocs que les WOD de box, type de score. Le texte complet commence par le titre, comme les WOD générés.
function manualDailyInput(b, keptDate = null) {
  const date = String(b.wod_date || ""),
    now = localToday();
  if (!validDate(date) || (date !== keptDate && (date < addDays(now, -1) || date > addDays(now, 1))))
    return {error: "Le WOD du jour se choisit pour aujourd'hui ou demain."};
  const scoreType = String(b.score_type || "none");
  if (!SCORE_TYPES.includes(scoreType)) return {error: "Type de score invalide."};
  const parsed = boxWodBlocks(b.blocks);
  if (!parsed || !parsed.content.trim()) return {error: "Écris au moins un bloc du WOD."};
  const name = String(b.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100),
    title = name || "Mon WOD";
  return {
    wod_date: date,
    title,
    content: (title + "\n\n" + parsed.content).slice(0, 8000),
    blocks: JSON.stringify(
      BOX_WOD_BLOCKS.filter(([key]) => parsed.blocks[key].trim()).map(([type, label]) => ({
        type,
        label,
        text: parsed.blocks[type],
      }))
    ),
    score_type: scoreType === "none" ? null : scoreType,
    options: JSON.stringify({manual: true, name, blocks: parsed.blocks}),
  };
}
const dailyWodOut = x => ({
  id: x.id,
  wod_date: x.wod_date,
  title: x.title,
  content: x.content,
  chrono: x.chrono ? JSON.parse(x.chrono) : null,
  movement_ids: JSON.parse(x.movement_ids || "[]"),
  blocks: x.blocks ? JSON.parse(x.blocks) : null,
  benchmark_id: x.benchmark_id || null,
  score_type: x.score_type || null,
  // WOD saisi à la main : nom et blocs tels que saisis, pour le formulaire de modification.
  manual: manualOf(x),
  common_wod_id: x.common_wod_id || null,
  ...(x.session_ids !== undefined ? {session_ids: x.session_ids?.split(",") || []} : {}),
  ...(x.edit_version !== undefined ? {edit_version: x.edit_version} : {}),
});
// WOD de box : nom facultatif (« WOD du JJ/MM/AAAA » par défaut), date, contenu et type de score.
const SCORE_TYPES = ["time", "reps", "load", "none"];
const frenchDate = d => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
// Blocs d'un WOD de box, dans l'ordre de la séance. Le texte complet (content) les reprend avec leur titre :
// c'est lui qui est montré aux membres et repris dans « Réalisé / notes ».
const BOX_WOD_BLOCKS = [
  ["warmup", "Échauffement"],
  ["technique", "Travail technique"],
  ["strength", "Force"],
  ["metcon", "Metcon"],
  ["finisher", "Finisher"],
];
function boxWodBlocks(input) {
  if (!input || typeof input !== "object") return null;
  const blocks = Object.fromEntries(
    BOX_WOD_BLOCKS.map(([key]) => [
      key,
      String(input[key] || "")
        .slice(0, 2000)
        .replace(/\s+$/, ""),
    ])
  );
  return {
    blocks,
    content: BOX_WOD_BLOCKS.filter(([key]) => blocks[key].trim())
      .map(([key, label]) => label + "\n" + blocks[key])
      .join("\n\n")
      .slice(0, 8000),
  };
}
// Type de WOD : celui choisi (s'il appartient à la box), sinon le premier de la liste (« WOD » par défaut).
// Nom par défaut : « <type> du JJ/MM/AAAA ».
async function boxWodInput(e, boxId, b) {
  const date = String(b.wod_date || ""),
    type = String(b.score_type || "");
  if (!validDate(date)) return {error: "Date du WOD invalide."};
  if (!SCORE_TYPES.includes(type)) return {error: "Type de score invalide."};
  // Type choisi dans la liste commune (administrateur), sinon celui par défaut (le premier de la liste).
  const wodType = await wodTypeOf(e, b.type_id);
  if (wodType.error) return {error: wodType.error};
  return {
    date,
    type,
    typeId: wodType?.id || null,
    name: boxText(b.name, 100) || (wodType?.name || "WOD") + " du " + frenchDate(date),
    ...(boxWodBlocks(b.blocks)
      ? (({blocks, content}) => ({blocks: JSON.stringify(blocks), content}))(boxWodBlocks(b.blocks))
      : {blocks: null, content: String(b.content || "").slice(0, 3000)}),
  };
}
// Mouvements d'un WOD de box : remplace la liste par les mouvements du catalogue envoyés (inconnus ignorés).
async function boxWodMovementStatements(e, wodId, ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, 100),
    valid = unique.length
      ? (
          await e.DB.prepare("SELECT id FROM movement_catalog WHERE id IN (" + unique.map(() => "?").join(",") + ")")
            .bind(...unique)
            .all()
        ).results.map(x => x.id)
      : [];
  return [
    e.DB.prepare("DELETE FROM box_wod_movements WHERE box_wod_id=?").bind(wodId),
    ...valid.map(id =>
      e.DB.prepare("INSERT INTO box_wod_movements(box_wod_id,catalog_movement_id) VALUES(?,?)").bind(wodId, id)
    ),
  ];
}
// Mouvements à travailler d'un WOD de programme : remplacés en entier (identifiants du catalogue valides seulement).
async function programWodMovementStatements(e, wodId, ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, 50),
    valid = unique.length
      ? (
          await e.DB.prepare("SELECT id FROM movement_catalog WHERE id IN (" + unique.map(() => "?").join(",") + ")")
            .bind(...unique)
            .all()
        ).results.map(x => x.id)
      : [];
  return [
    e.DB.prepare("DELETE FROM program_wod_movements WHERE wod_id=?").bind(wodId),
    ...valid.map(id =>
      e.DB.prepare("INSERT INTO program_wod_movements(wod_id,catalog_movement_id) VALUES(?,?)").bind(wodId, id)
    ),
  ];
}
const PROGRAM_WOD_MOVEMENTS =
  "(SELECT group_concat(x.catalog_movement_id) FROM program_wod_movements x WHERE x.wod_id=w.id) AS movement_ids";
// Liste des WOD avec leurs mouvements (identifiants du catalogue, séparés par des virgules en base).
const WOD_MOVEMENTS =
  "(SELECT group_concat(x.catalog_movement_id) FROM box_wod_movements x WHERE x.box_wod_id=w.id) AS movement_ids";
const withMovementIds = rows => rows.map(r => ({...r, movement_ids: r.movement_ids ? r.movement_ids.split(",") : []}));
// WOD des box dont l'utilisateur est membre validé, entre deux dates : jamais ceux de demain et après (seuls les
// gestionnaires voient les WOD à venir, dans leur espace).
async function memberBoxWods(e, userId, from, to) {
  const x = await e.DB.prepare(
    "SELECT w.id,w.box_id,b.name AS box_name,w.wod_date,w.name,w.content,w.blocks,w.score_type,w.wod_type_id AS type_id,t.name AS type_name,(SELECT group_concat(s.id) FROM training_sessions s WHERE s.box_wod_id=w.id AND s.user_id=m.user_id) AS session_ids," +
      WOD_MOVEMENTS +
      " FROM box_wods w JOIN boxes b ON b.id=w.box_id LEFT JOIN wod_types t ON t.id=w.wod_type_id JOIN box_members m ON m.box_id=w.box_id AND m.user_id=? AND m.role='member' AND m.status='approved' WHERE w.wod_date>=? AND w.wod_date<=? AND w.wod_date<=? ORDER BY w.wod_date,t.sort_order,w.created_at"
  )
    .bind(userId, from, to, localToday())
    .all();
  return withMovementIds(x.results).map(w => ({...w, session_ids: w.session_ids?.split(",") || []}));
}
// Période de lecture des WOD de box (au plus 93 jours).
function wodRange(r) {
  const q = new URL(r.url).searchParams,
    from = q.get("from"),
    to = q.get("to");
  if (!validDate(from) || !validDate(to) || from > to || daysBetween(from, to) > 92) return null;
  return {from, to};
}
const boxText = (v, max) =>
  String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
// Limitation des tentatives de connexion : 5 échecs par e-mail ou 60 par adresse IP sur 15 minutes (une box entière
// partage souvent la même adresse IP via son Wi-Fi).
const LOGIN_WINDOW = 15 * 60,
  LOGIN_LIMITS = {email: 5, ip: 60};
const loginKeys = (r, email) => ({
  email: "email:" + email,
  ip: "ip:" + (r.headers.get("CF-Connecting-IP") || "inconnue"),
});
async function loginWaitMinutes(e, keys) {
  const since = Math.floor(Date.now() / 1000) - LOGIN_WINDOW;
  let wait = 0;
  for (const [kind, key] of Object.entries(keys)) {
    const x = await e.DB.prepare(
      "SELECT COUNT(*) AS n,MIN(attempted_at) AS first FROM login_attempts WHERE attempt_key=? AND attempted_at>?"
    )
      .bind(key, since)
      .first();
    if (x.n >= LOGIN_LIMITS[kind])
      wait = Math.max(wait, Math.ceil((x.first + LOGIN_WINDOW - Math.floor(Date.now() / 1000)) / 60));
  }
  return wait;
}
async function movementCheckStatements(
  env,
  userId,
  sessionId,
  programId,
  ids = [],
  catalogIds = [],
  anyMovement = false,
  wodId = null,
  requireValid = false,
  {version, apiEditable = false, replaceProgram = true, replaceCatalog = true} = {}
) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
  const validIds = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 99) {
    const chunk = uniqueIds.slice(offset, offset + 99);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      "SELECT id FROM program_movements WHERE program_id=? AND id IN (" + placeholders + ")"
    )
      .bind(programId, ...chunk)
      .all();
    validIds.push(...rows.results.map(row => row.id));
  }
  // Sans mouvement à travailler dans le programme, ou pour un WOD « Autres » (anyMovement), la séance peut cocher
  // n'importe quel mouvement du catalogue.
  const validCatalogIds = [];
  const hasProgramMovements =
    !anyMovement &&
    (await env.DB.prepare("SELECT 1 FROM program_movements WHERE program_id=? LIMIT 1").bind(programId).first());
  // Programme avec mouvements à travailler : seuls les mouvements du catalogue propres au WOD sont acceptés en plus.
  const wodCatalogIds =
    hasProgramMovements && wodId
      ? new Set(
          (
            await env.DB.prepare("SELECT catalog_movement_id FROM program_wod_movements WHERE wod_id=?")
              .bind(wodId)
              .all()
          ).results.map(x => x.catalog_movement_id)
        )
      : null;
  if (wodCatalogIds?.size)
    validCatalogIds.push(...[...new Set(catalogIds.map(String))].filter(id => wodCatalogIds.has(id)));
  if (!hasProgramMovements) {
    const uniqueCatalogIds = [...new Set(catalogIds.map(String).filter(Boolean))].slice(0, 200);
    for (let offset = 0; offset < uniqueCatalogIds.length; offset += 100) {
      const chunk = uniqueCatalogIds.slice(offset, offset + 100);
      const rows = await env.DB.prepare(
        "SELECT id FROM movement_catalog WHERE id IN (" + chunk.map(() => "?").join(",") + ")"
      )
        .bind(...chunk)
        .all();
      validCatalogIds.push(...rows.results.map(row => row.id));
    }
  }
  if (requireValid && (validIds.length !== new Set(ids).size || validCatalogIds.length !== new Set(catalogIds).size))
    return null;
  const owned = version
    ? apiEditable
      ? "EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND user_id=? AND edit_version=? AND " +
        SESSION_API_EDITABLE +
        ")"
      : SESSION_AT_VERSION
    : "EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND user_id=?)";
  const owner = version ? [sessionId, userId, version] : [sessionId, userId];
  return [
    ...(replaceProgram
      ? [
          env.DB.prepare("DELETE FROM session_movement_checks WHERE session_id=? AND " + owned).bind(
            sessionId,
            ...owner
          ),
          ...validIds.map(id =>
            env.DB.prepare(
              "INSERT OR IGNORE INTO session_movement_checks(session_id,movement_id) SELECT ?,? WHERE " + owned
            ).bind(sessionId, id, ...owner)
          ),
        ]
      : []),
    ...(replaceCatalog
      ? [
          env.DB.prepare("DELETE FROM session_catalog_movement_checks WHERE session_id=? AND " + owned).bind(
            sessionId,
            ...owner
          ),
          ...validCatalogIds.map(id =>
            env.DB.prepare(
              "INSERT OR IGNORE INTO session_catalog_movement_checks(session_id,catalog_movement_id) SELECT ?,? WHERE " +
                owned
            ).bind(sessionId, id, ...owner)
          ),
        ]
      : []),
  ];
}
const SESSION_ID_PATH = /^\/api\/sessions\/([\w-]+)$/;
const SESSION_AT_VERSION = "EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND user_id=? AND edit_version=?)";
const SESSION_API_EDITABLE =
  "box_wod_id IS NULL AND daily_wod_id IS NULL AND shared_from_user_id IS NULL AND " +
  "NOT EXISTS(SELECT 1 FROM session_tags WHERE session_id=training_sessions.id OR id=training_sessions.id)";
const validCardioIntensity = value => value == null || (Number.isInteger(value) && value >= 0 && value <= 4);
const invalidCardioIntensity = () =>
  json({error: "L’intensité cardiovasculaire doit aller de 0 à 4 ou rester non renseignée."}, 400);

const activeSessionActivity = (e, activityId, adminEmail) =>
  e.DB.prepare("SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1")
    .bind(activityId, adminEmail)
    .first();

async function sessionProgram(e, userId, programId) {
  const row = await e.DB.prepare(
    "SELECT p.id,p.user_id,p.start_monday,p.end_monday,f.start_monday AS follow_start,f.end_monday AS follow_end FROM programs p" +
      FOLLOW_JOIN +
      "WHERE p.id=? AND " +
      PROGRAM_ACCESS
  )
    .bind(userId, programId, userId, userId, userId)
    .first();
  return row && {...row, ...userProgramDates(row, userId)};
}

const SESSION_EDIT_FIELDS = new Set([
  "program_id",
  "wod_id",
  "session_date",
  "activity_id",
  "duration_minutes",
  "cardio_intensity",
  "actual_comment",
  "started_at",
  "type_id",
  "score_value",
  "score_type",
  "movement_ids",
  "catalog_movement_ids",
]);

async function editApiSession(r, e, userId, id, adminEmail) {
  const load = () =>
    e.DB.prepare("SELECT *,(" + SESSION_API_EDITABLE + ") AS editable FROM training_sessions WHERE id=? AND user_id=?")
      .bind(id, userId)
      .first();
  const previous = await load();
  if (!previous) return json({error: "Séance introuvable."}, 404);
  const unsupported = () =>
    json(
      {error: "Les séances partagées, de box ou liées à un WOD du jour ne sont pas modifiables avec une clé API."},
      409
    );
  if (!previous.editable) return unsupported();
  const match = r.headers.get("If-Match");
  if (match === null) return json({error: "L’en-tête If-Match est requis."}, 428);
  const version = /^"([\w-]{32}|[\w-]{43})"$/.exec(match)?.[1];
  if (!version) return json({error: "Version de séance invalide."}, 400);
  if (r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({error: "Un corps JSON est requis."}, 415);
  const raw = await r.text();
  const nextVersion = await sha(JSON.stringify([userId, id, version, raw]));
  const success = () => json({ok: true, id, edit_version: nextVersion}, 200, {ETag: '"' + nextVersion + '"'});
  const conflict = () => json({error: "La séance a changé. Relis-la avant de la modifier."}, 412);
  if (previous.edit_version === nextVersion) return success();
  if (previous.edit_version !== version) return conflict();

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({error: "Un objet JSON est requis."}, 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Object.keys(body).length ||
    Object.keys(body).some(field => !SESSION_EDIT_FIELDS.has(field))
  )
    return json({error: "Indique au moins un champ modifiable dans un objet JSON."}, 400);

  for (const field of ["program_id", "wod_id", "activity_id", "type_id"]) {
    if (Object.hasOwn(body, field) && (typeof body[field] !== "string" || !body[field]))
      return json({error: "Identifiant invalide."}, 400);
  }
  if (
    Object.hasOwn(body, "duration_minutes") &&
    (!Number.isInteger(body.duration_minutes) || body.duration_minutes < 1 || body.duration_minutes > 600)
  )
    return json({error: "Sport ou durée invalide."}, 400);
  if (!validCardioIntensity(body.cardio_intensity)) return invalidCardioIntensity();
  if (Object.hasOwn(body, "actual_comment") && typeof body.actual_comment !== "string")
    return json({error: "Commentaire invalide."}, 400);
  if (
    Object.hasOwn(body, "started_at") &&
    (typeof body.started_at !== "string" || Number.isNaN(Date.parse(body.started_at)))
  )
    return json({error: "Heure de début invalide."}, 400);
  if (body.score_value != null && typeof body.score_value !== "number" && typeof body.score_value !== "string")
    return json({error: "Score invalide."}, 400);
  if (
    Object.hasOwn(body, "score_type") &&
    (body.score_value == null ||
      body.score_value === "" ||
      !PROGRAM_SCORE_TYPES.includes(body.score_type) ||
      body.score_type === "none")
  )
    return json({error: "Indique un score et un type valides."}, 400);

  const programId = body.program_id ?? previous.program_id,
    wodId = body.wod_id ?? previous.wod_id,
    date = body.session_date ?? previous.session_date,
    associationChanged = programId !== previous.program_id || wodId !== previous.wod_id;
  if (
    Object.hasOwn(body, "session_date") &&
    (typeof body.session_date !== "string" || !validDate(date) || new Date(date).toISOString().slice(0, 10) !== date)
  )
    return json({error: "Date invalide."}, 400);
  if (associationChanged || Object.hasOwn(body, "session_date")) {
    if (date > localToday()) return json({error: "Impossible d’enregistrer une séance à une date future."}, 400);
    const program = await sessionProgram(e, userId, programId);
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (date < program.start || date > program.end)
      return json({error: "La date de la séance doit être comprise dans la période du programme."}, 400);
  }
  if (body.activity_id !== undefined && !(await activeSessionActivity(e, body.activity_id, adminEmail)))
    return json({error: "Sport ou durée invalide."}, 400);

  const replaceProgram = Object.hasOwn(body, "movement_ids"),
    replaceCatalog = Object.hasOwn(body, "catalog_movement_ids");
  if (
    [body.movement_ids, body.catalog_movement_ids].some(
      ids =>
        ids !== undefined && (!Array.isArray(ids) || ids.length > 200 || !ids.every(x => typeof x === "string" && x))
    )
  )
    return json({error: "Liste de mouvements invalide."}, 400);
  const w = await e.DB.prepare("SELECT id,name,score_type,type_id FROM program_wods WHERE id=? AND program_id=?")
    .bind(wodId, programId)
    .first();
  if (!w) return json({error: "WOD ou programme invalide."}, 400);

  let score = {value: previous.score_value, type: previous.program_score_type};
  if (associationChanged || Object.hasOwn(body, "score_value")) {
    const scoreInput = Object.hasOwn(body, "score_value") ? body : {score_value: score.value, score_type: score.type};
    if (w.name === "__AUTRES__" && scoreInput.score_value != null && scoreInput.score_value !== "")
      return json({error: "Ce WOD n’accepte pas de score."}, 400);
    score = sessionProgramScore(w, scoreInput, previous);
    if (score.error) return json({error: score.error}, 400);
  }
  let typeId = previous.type_id;
  if (associationChanged || body.type_id !== undefined) {
    const type = await sessionTypeId(e, {type_id: body.type_id ?? typeId}, null, w);
    if (type.error || (body.type_id !== undefined && body.type_id !== type.id))
      return json({error: type.error || "Le type de WOD est imposé par le programme."}, 400);
    typeId = type.id;
  }

  let checks = [];
  if (associationChanged || replaceProgram || replaceCatalog) {
    const [storedProgram, storedCatalog] = await Promise.all([
      associationChanged && !replaceProgram
        ? e.DB.prepare(
            "SELECT movement_id FROM session_movement_checks WHERE session_id=? AND EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND user_id=?)"
          )
            .bind(id, id, userId)
            .all()
        : null,
      associationChanged && !replaceCatalog
        ? e.DB.prepare(
            "SELECT catalog_movement_id FROM session_catalog_movement_checks WHERE session_id=? AND EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND user_id=?)"
          )
            .bind(id, id, userId)
            .all()
        : null,
    ]);
    checks = await movementCheckStatements(
      e,
      userId,
      id,
      programId,
      body.movement_ids ?? storedProgram?.results.map(row => row.movement_id) ?? [],
      body.catalog_movement_ids ?? storedCatalog?.results.map(row => row.catalog_movement_id) ?? [],
      w.name === "__AUTRES__",
      wodId,
      true,
      {version, apiEditable: true, replaceProgram, replaceCatalog}
    );
    if (!checks) return json({error: "Mouvement inconnu ou non autorisé pour ce WOD."}, 400);
  }
  // Toutes les écritures utilisent la même précondition. Changer la version en dernier garde
  // les écritures des mouvements conditionnelles et permet à D1 de les annuler si le lot échoue.
  const results = await e.DB.batch([
    ...checks,
    e.DB.prepare(
      "UPDATE training_sessions SET program_id=?,wod_id=?,session_date=?,activity_id=?,duration_minutes=?," +
        "actual_comment=?,started_at=?,type_id=?,score_value=?,program_score_type=?,cardio_intensity=?,updated_at=CURRENT_TIMESTAMP,edit_version=? " +
        "WHERE id=? AND user_id=? AND edit_version=? AND " +
        SESSION_API_EDITABLE
    ).bind(
      programId,
      wodId,
      date,
      body.activity_id ?? previous.activity_id,
      body.duration_minutes ?? previous.duration_minutes,
      body.actual_comment === undefined ? previous.actual_comment : body.actual_comment.slice(0, 3000),
      body.started_at === undefined ? previous.started_at : new Date(body.started_at).toISOString(),
      typeId,
      score.value,
      score.type,
      body.cardio_intensity === undefined ? previous.cardio_intensity : body.cardio_intensity,
      nextVersion,
      id,
      userId,
      version
    ),
  ]);
  if (results.at(-1).meta.changes) return success();
  const current = await load();
  if (!current) return json({error: "Séance introuvable."}, 404);
  if (!current.editable) return unsupported();
  return current.edit_version === nextVersion ? success() : conflict();
}

const WEEKLY_PLAN_PATH = "/api/weekly-plans";
const WEEKLY_PLAN_MOVE_PATH = WEEKLY_PLAN_PATH + "/move";
const IDEMPOTENCY_WINDOW_SECONDS = 86400;
const expiredIdempotencyKey = () => json({error: "Clé d’idempotence expirée."}, 409);
function readIdempotencyKey(r) {
  const requestId = r.headers.get("Idempotency-Key") || "",
    issuedAt = /^(\d{10})\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(requestId),
    now = Math.floor(Date.now() / 1000);
  if (!issuedAt || Number(issuedAt[1]) > now + 300)
    return {error: json({error: "Clé d’idempotence absente ou invalide."}, 400)};
  const expiresAt = Number(issuedAt[1]) + IDEMPOTENCY_WINDOW_SECONDS;
  if (expiresAt <= now) return {error: expiredIdempotencyKey()};
  return {requestId, expiresAt};
}
const PLAN_WOD_JOIN = `
  JOIN program_wods w ON w.id=wp.wod_id
  JOIN programs p ON p.id=w.program_id
  LEFT JOIN program_follows f ON f.program_id=p.id AND f.user_id=wp.user_id`;
const PLAN_ACCESS = "w.name<>'__AUTRES__' AND p.is_default=0 AND (p.user_id=wp.user_id OR f.user_id IS NOT NULL)";
const PLAN_COMPLETED = `EXISTS(
  SELECT 1 FROM training_sessions s WHERE s.user_id=wp.user_id AND s.wod_id=wp.wod_id
    AND s.session_date BETWEEN wp.week_start AND COALESCE(date(wp.week_start,'+6 days'),'9999-12-31')
)`;
const PLAN_STATE = `SELECT
    wp.week_start BETWEEN CASE WHEN p.user_id=wp.user_id THEN p.start_monday ELSE f.start_monday END
                      AND CASE WHEN p.user_id=wp.user_id THEN p.end_monday ELSE f.end_monday END AS in_period,
    ${PLAN_COMPLETED} AS completed,
    existing.plan_version AS version
  FROM (SELECT ? AS user_id, ? AS week_start, ? AS wod_id) wp
  ${PLAN_WOD_JOIN}
  LEFT JOIN weekly_plans existing
    ON existing.user_id=wp.user_id AND existing.week_start=wp.week_start AND existing.wod_id=wp.wod_id
  WHERE ${PLAN_ACCESS}`;

const PLAN_ERRORS = {
  period: [400, "Ce WOD ne fait pas partie du programme de cette semaine."],
  wod: [404, "WOD introuvable."],
  missing: [404, "Planification introuvable."],
  completed: [409, "Un WOD a déjà été réalisé pour cette semaine."],
  occupied: [409, "Le WOD de destination est déjà planifié."],
  stale: [412, "La planification a changé. Relis-la avant de réessayer."],
};

function exactCalendarDate(value) {
  return typeof value === "string" && validDate(value) && new Date(value).toISOString().slice(0, 10) === value;
}

function planReference(value, withVersion = false) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== (withVersion ? 3 : 2) ||
    !exactCalendarDate(value.week_start) ||
    mondayOfDate(value.week_start) !== value.week_start ||
    typeof value.wod_id !== "string" ||
    !/^[\w-]{1,64}$/.test(value.wod_id) ||
    (withVersion && (typeof value.version !== "string" || !/^[a-f0-9]{32}$/.test(value.version)))
  )
    return null;
  const {week_start, wod_id, version} = value;
  return withVersion ? {week_start, wod_id, version} : {week_start, wod_id};
}

async function weeklyPlansForApi(r, e, userId, path) {
  if (r.method === "GET") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!exactCalendarDate(from) || !exactCalendarDate(to) || from > to) return json({error: "Période invalide."}, 400);
    const {results} = await e.DB.prepare(
      `SELECT wp.week_start, wp.wod_id, w.name AS wod_name, p.id AS program_id,
              wp.plan_version AS version, ${PLAN_COMPLETED} AS completed
       FROM weekly_plans wp ${PLAN_WOD_JOIN}
       WHERE wp.user_id=? AND wp.week_start BETWEEN ? AND ? AND ${PLAN_ACCESS}
       ORDER BY wp.week_start, wp.wod_id`
    )
      .bind(userId, from, to)
      .all();
    return json({plans: results.map(plan => ({...plan, completed: Boolean(plan.completed)}))});
  }

  if (r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({error: "Un corps JSON est requis."}, 415);
  const {requestId, expiresAt, error: keyError} = readIdempotencyKey(r);
  if (keyError) return keyError;

  const body = await r.json().catch(() => null),
    move = path === WEEKLY_PLAN_MOVE_PATH,
    remove = r.method === "DELETE",
    source = move ? planReference(body?.from, true) : remove ? planReference(body, true) : null,
    target = move ? planReference(body?.to) : remove ? null : planReference(body);
  if (
    (move && (!source || !target || Object.keys(body).length !== 2)) ||
    (remove && !source) ||
    (!move && !remove && !target) ||
    (move && source.week_start === target.week_start && source.wod_id === target.wod_id)
  )
    return json({error: "Planification invalide."}, 400);

  const sourceChecks =
    source &&
    `
    WHEN NOT EXISTS(SELECT 1 FROM original) THEN 'wod'
    WHEN NOT (SELECT in_period IS TRUE FROM original) THEN 'period'
    WHEN (SELECT version FROM original) IS NULL THEN 'missing'
    WHEN (SELECT completed FROM original) THEN 'completed'
    WHEN (SELECT version FROM original)<>? THEN 'stale'`;
  const targetChecks =
    target &&
    `
    WHEN NOT EXISTS(SELECT 1 FROM destination) THEN 'wod'
    WHEN NOT (SELECT in_period IS TRUE FROM destination) THEN 'period'
    WHEN (SELECT completed FROM destination) THEN 'completed'`;
  const ctes = [
    ...(source ? ["original AS (" + PLAN_STATE + ")"] : []),
    ...(target ? ["destination AS (" + PLAN_STATE + ")"] : []),
  ];
  const values = [
    ...(source ? [userId, source.week_start, source.wod_id] : []),
    ...(target ? [userId, target.week_start, target.wod_id] : []),
  ];
  const attempt = uid().replaceAll("-", ""),
    fingerprint = await sha(JSON.stringify([r.method, path, source, target])),
    admitted =
      "EXISTS(SELECT 1 FROM weekly_plan_requests WHERE user_id=? AND request_id=? AND attempt_id=? AND outcome='ok')",
    gate = [userId, requestId, attempt];
  const record = e.DB.prepare(
    `WITH ${ctes.join(", ")}, decision AS (
       SELECT CASE ${sourceChecks || ""} ${targetChecks || ""}
       ${move ? "WHEN (SELECT version FROM destination) IS NOT NULL THEN 'occupied'" : ""} ELSE 'ok' END AS outcome
     )
     INSERT INTO weekly_plan_requests(user_id,request_id,request_hash,attempt_id,expires_at,outcome)
     SELECT ?,?,?,?,?,outcome FROM decision WHERE unixepoch()<?
     ON CONFLICT(user_id,request_id) DO NOTHING`
  ).bind(...values, ...(source ? [source.version] : []), userId, requestId, fingerprint, attempt, expiresAt, expiresAt);

  let change;
  if (move) {
    change = e.DB.prepare(
      "UPDATE weekly_plans SET week_start=?,wod_id=?,plan_version=? WHERE user_id=? AND week_start=? AND wod_id=? AND " +
        admitted
    ).bind(target.week_start, target.wod_id, attempt, userId, source.week_start, source.wod_id, ...gate);
  } else if (remove) {
    change = e.DB.prepare(
      "DELETE FROM weekly_plans WHERE user_id=? AND week_start=? AND wod_id=? AND " + admitted
    ).bind(userId, source.week_start, source.wod_id, ...gate);
  } else {
    change = e.DB.prepare(
      "INSERT INTO weekly_plans(user_id,week_start,wod_id) SELECT ?,?,? WHERE " +
        admitted +
        " ON CONFLICT(user_id,week_start,wod_id) DO NOTHING"
    ).bind(userId, target.week_start, target.wod_id, ...gate);
  }
  // La décision et son effet utilisent le même instantané et sont validés ensemble.
  const [, , receipt] = await e.DB.batch([
    record,
    change,
    e.DB.prepare("SELECT request_hash,outcome FROM weekly_plan_requests WHERE user_id=? AND request_id=?").bind(
      userId,
      requestId
    ),
  ]);
  const outcome = receipt.results[0];
  if (!outcome) return expiredIdempotencyKey();
  if (outcome.request_hash !== fingerprint)
    return json({error: "Cette clé d’idempotence est déjà associée à une autre opération."}, 409);
  if (outcome.outcome === "ok") return json({ok: true});
  const [status, error] = PLAN_ERRORS[outcome.outcome];
  return json({error}, status);
}

const PR_ID_PATH = /^\/api\/prs\/([\w-]+)$/;
const PR_FIELDS = new Set(["movement_id", "record_date", "value", "rep_count", "fixed_kind", "fixed_value"]);
const PR_ERRORS = {
  missing: [404, "PR introuvable."],
  stale: [412, "Le PR a changé. Relis-le avant de le modifier."],
  movement: [404, "Mouvement introuvable dans le catalogue."],
  measurement: [409, "La mesure du mouvement a changé. Relis le catalogue avant de réessayer."],
};
const movementForPr = (e, id) =>
  e.DB.prepare("SELECT id,measurement_method FROM movement_catalog WHERE id=?").bind(id).first();

function prApiBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !PR_FIELDS.has(k)))
    return null;
  const {movement_id, record_date, value: result, rep_count = null, fixed_kind = null, fixed_value = null} = value;
  if (
    typeof movement_id !== "string" ||
    !/^[\w-]{1,64}$/.test(movement_id) ||
    !exactCalendarDate(record_date) ||
    record_date > localToday() ||
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    (rep_count !== null && !Number.isInteger(rep_count)) ||
    (fixed_kind !== null && !["distance", "reps", "time"].includes(fixed_kind)) ||
    (fixed_value !== null && (typeof fixed_value !== "number" || !Number.isFinite(fixed_value))) ||
    (fixed_kind === null) !== (fixed_value === null)
  )
    return null;
  return {movement_id, record_date, value: result, rep_count, fixed_kind, fixed_value};
}

async function writePrByApi(r, e, userId, id) {
  const remove = r.method === "DELETE";
  let version = null;
  if (id) {
    const match = r.headers.get("If-Match");
    if (match === null) return json({error: "L’en-tête If-Match est requis."}, 428);
    version = /^"([a-f0-9]{32})"$/.exec(match)?.[1];
    if (!version) return json({error: "Version de PR invalide."}, 400);
  }
  const {requestId, expiresAt, error} = readIdempotencyKey(r);
  if (error) return error;
  let body = null;
  if (remove) {
    if (await r.text()) return json({error: "La suppression ne prend aucun corps."}, 400);
  } else {
    if (r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      return json({error: "Un corps JSON est requis."}, 415);
    body = prApiBody(await r.json().catch(() => null));
    if (!body) return json({error: "Champs, types ou date de PR invalides."}, 400);
  }
  const recordId = id ?? uid(),
    attempt = uid().replaceAll("-", ""),
    fingerprint = await sha(JSON.stringify([r.method, id, version, body])),
    movement = body && (await movementForPr(e, body.movement_id));
  let validation = null;
  if (movement) {
    const usesRm = ["load", "force"].includes(movement.measurement_method);
    validation =
      (usesRm && body.fixed_kind !== null) || (!usesRm && body.rep_count !== null)
        ? {error: "Champs incompatibles avec la méthode de mesure."}
        : validatePr(movement, body.value, body.rep_count, body);
  }

  const checks = [
    ...(id
      ? [
          "WHEN NOT EXISTS(SELECT 1 FROM personal_records WHERE id=? AND user_id=?) THEN 'missing'",
          "WHEN NOT EXISTS(SELECT 1 FROM personal_records WHERE id=? AND user_id=? AND edit_version=?) THEN 'stale'",
        ]
      : []),
    ...(body
      ? [
          "WHEN NOT EXISTS(SELECT 1 FROM movement_catalog WHERE id=?) THEN 'movement'",
          "WHEN NOT EXISTS(SELECT 1 FROM movement_catalog WHERE id=? AND measurement_method=?) THEN 'measurement'",
        ]
      : []),
  ];
  const review = e.DB.prepare(
    `WITH decision AS (SELECT CASE ${checks.join(" ")} ELSE ? END AS outcome)
     INSERT INTO pr_api_requests(user_id,request_id,request_hash,attempt_id,expires_at,outcome,detail,pr_id)
     SELECT ?,?,?,?,?,outcome,?,? FROM decision WHERE unixepoch()<?
     ON CONFLICT(user_id,request_id) DO NOTHING`
  ).bind(
    ...(id ? [id, userId, id, userId, version] : []),
    ...(body ? [body.movement_id, body.movement_id, movement?.measurement_method ?? null] : []),
    validation?.error ? "invalid" : "ok",
    userId,
    requestId,
    fingerprint,
    attempt,
    expiresAt,
    validation?.error ?? null,
    recordId,
    expiresAt
  );
  const gate =
    "EXISTS(SELECT 1 FROM pr_api_requests WHERE user_id=? AND request_id=? AND attempt_id=? AND outcome='ok')";
  const guard = [userId, requestId, attempt];
  const fields = body
    ? [
        body.movement_id,
        body.record_date,
        body.value,
        validation?.repCount ?? null,
        validation?.fixedKind ?? null,
        validation?.fixedValue ?? null,
        attempt,
      ]
    : [];
  let change;
  if (remove) {
    change = e.DB.prepare("DELETE FROM personal_records WHERE id=? AND user_id=? AND edit_version=? AND " + gate).bind(
      recordId,
      userId,
      version,
      ...guard
    );
  } else if (id) {
    change = e.DB.prepare(
      "UPDATE personal_records SET movement_id=?,record_date=?,value=?,rep_count=?,fixed_kind=?,fixed_value=?,edit_version=? WHERE id=? AND user_id=? AND edit_version=? AND " +
        gate
    ).bind(...fields, recordId, userId, version, ...guard);
  } else {
    change = e.DB.prepare(
      "INSERT INTO personal_records(id,user_id,movement_id,record_date,value,rep_count,fixed_kind,fixed_value,edit_version) SELECT ?,?,?,?,?,?,?,?,? WHERE " +
        gate
    ).bind(recordId, userId, ...fields, ...guard);
  }
  // Le reçu et sa mutation sont validés ensemble. Un rejeu lit le résultat de la première tentative.
  const [, , receipt] = await e.DB.batch([
    review,
    change,
    e.DB.prepare(
      "SELECT request_hash,outcome,detail,pr_id,attempt_id FROM pr_api_requests WHERE user_id=? AND request_id=?"
    ).bind(userId, requestId),
  ]);
  const result = receipt.results[0];
  if (!result) return expiredIdempotencyKey();
  if (result.request_hash !== fingerprint)
    return json({error: "Cette clé d’idempotence est déjà associée à une autre opération."}, 409);
  if (result.outcome === "ok") {
    const response = {ok: true, id: result.pr_id};
    return remove
      ? json(response)
      : json({...response, edit_version: result.attempt_id}, id ? 200 : 201, {ETag: '"' + result.attempt_id + '"'});
  }
  if (result.outcome === "invalid") return json({error: result.detail}, 400);
  const [status, message] = PR_ERRORS[result.outcome];
  return json({error: message}, status);
}

const API_KEY_PERMISSIONS = new Map([
  ["GET /api/program-data", "programs:read"],
  ["GET /api/coaching-context", "coaching:read"],
  ["POST " + EXTERNAL_WOD_PATH + "/preview", "wods:write"],
  ["PUT " + EXTERNAL_WOD_PATH, "wods:write"],
  ["POST " + EXTERNAL_PROGRAM_PATH + "/preview", "programs:create"],
  ["PUT " + EXTERNAL_PROGRAM_PATH, "programs:create"],
  ["GET /api/week-data", "workouts:read"],
  ["GET /api/activities", "workouts:read"],
  ["GET /api/movement-catalog", ["workouts:read", "prs:read"]],
  ["GET /api/wod-types", "workouts:read"],
  ["POST /api/sessions", "workouts:write"],
  ["GET " + WEEKLY_PLAN_PATH, "plans:read"],
  ["POST " + WEEKLY_PLAN_PATH, "plans:write"],
  ["DELETE " + WEEKLY_PLAN_PATH, "plans:write"],
  ["POST " + WEEKLY_PLAN_MOVE_PATH, "plans:write"],
  ["GET /api/prs", "prs:read"],
  ["POST /api/prs", "prs:write"],
]);
const API_KEY_SCOPES = new Set([...API_KEY_PERMISSIONS.values()].flat());
const API_KEY_LIMIT = 60,
  API_USER_LIMIT = 120;
const API_KEY_METADATA = "id,name,prefix,permissions,created_at,last_used_at,expires_at,revoked_at";
const apiKeyOut = row => ({...row, permissions: JSON.parse(row.permissions)});
const apiKeyUnauthorized = () =>
  json({error: "Clé API invalide, expirée ou révoquée."}, 401, {"WWW-Authenticate": "Bearer"});

async function authenticateApiKey(r, e, p, authorization) {
  const match = /^Bearer (mff_([a-f0-9]{32})\.[A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) return apiKeyUnauthorized();
  const now = Math.floor(Date.now() / 1000),
    key = await e.DB.prepare(
      "SELECT k.id,k.user_id,k.key_hash,k.permissions,u.first_name,u.last_name FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.prefix=? AND k.revoked_at IS NULL AND k.expires_at>? AND u.is_active=1"
    )
      .bind("mff_" + match[2], now)
      .first();
  if (!key || !crypto.subtle.timingSafeEqual(unb64(key.key_hash), unb64(await sha(match[1]))))
    return apiKeyUnauthorized();

  const scope =
    (r.method === "PUT" && SESSION_ID_PATH.test(p) && "workouts:write") ||
    (["PUT", "DELETE"].includes(r.method) && PR_ID_PATH.test(p) && "prs:write") ||
    API_KEY_PERMISSIONS.get(r.method + " " + p);
  const permissions = JSON.parse(key.permissions);
  if (!scope || ![scope].flat().some(permission => permissions.includes(permission)))
    return json({error: "Accès interdit avec cette clé API."}, 403);

  // Une écriture atomique, contrôlée par D1 : le trigger incrémente aussi le compteur du compte.
  const admitted = await e.DB.prepare(
    `UPDATE api_keys
       SET rate_count=CASE WHEN rate_window=unixepoch()/60 THEN rate_count+1 ELSE 1 END,
           rate_window=unixepoch()/60,
           last_used_at=CASE WHEN last_used_at IS NULL OR last_used_at<=unixepoch()-3600 THEN unixepoch() ELSE last_used_at END
       WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>unixepoch()
         AND EXISTS(SELECT 1 FROM users WHERE id=api_keys.user_id AND is_active=1)
         AND (rate_window<>unixepoch()/60 OR rate_count<?)
         AND NOT EXISTS(SELECT 1 FROM api_user_rates WHERE user_id=api_keys.user_id AND rate_window=unixepoch()/60 AND rate_count>=?)`
  )
    .bind(key.id, key.user_id, API_KEY_LIMIT, API_USER_LIMIT)
    .run();
  if (!admitted.meta.changes) {
    const stillValid = await e.DB.prepare(
      "SELECT 1 FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.id=? AND k.user_id=? AND k.revoked_at IS NULL AND k.expires_at>? AND u.is_active=1"
    )
      .bind(key.id, key.user_id, Math.floor(Date.now() / 1000))
      .first();
    if (!stillValid) return apiKeyUnauthorized();
    return json({error: "Limite de requêtes API atteinte. Réessaie dans un instant."}, 429, {
      "Retry-After": String(60 - (Math.floor(Date.now() / 1000) % 60)),
    });
  }
  return {id: key.user_id, first_name: key.first_name, last_name: key.last_name};
}

async function manageApiKeys(r, e, p, userId) {
  const base = "/api/api-keys",
    isList = p === base && r.method === "GET",
    isCreate = p === base && r.method === "POST",
    revoke = r.method === "DELETE" && /^\/api\/api-keys\/([a-f0-9-]{36})$/.exec(p);
  if (isList) {
    const {results} = await e.DB.prepare(
      `SELECT ${API_KEY_METADATA} FROM api_keys WHERE user_id=? ORDER BY created_at DESC,id`
    )
      .bind(userId)
      .all();
    return json({keys: results.map(apiKeyOut)});
  }
  if (!isCreate && !revoke) return json({error: "Route inconnue."}, 404);
  if (r.headers.get("Origin") !== new URL(r.url).origin)
    return json({error: "Origine de la requête non autorisée."}, 403);

  const now = Math.floor(Date.now() / 1000);
  if (revoke) {
    const result = await e.DB.prepare("UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?")
      .bind(now, revoke[1], userId)
      .run();
    return result.meta.changes ? json({ok: true}) : json({error: "Clé API introuvable."}, 404);
  }

  if (r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({error: "Un corps JSON est requis."}, 415);
  const body = await r.json().catch(() => null),
    name = typeof body?.name === "string" ? body.name.trim() : "",
    permissions = body?.permissions,
    date = body?.expires_on,
    midnight = typeof date === "string" && validDate(date) ? new Date(date + "T00:00:00Z") : null;
  if (!name || name.length > 80) return json({error: "Choisis un nom de 1 à 80 caractères."}, 400);
  if (
    !Array.isArray(permissions) ||
    !permissions.length ||
    permissions.length > API_KEY_SCOPES.size ||
    !permissions.every(scope => API_KEY_SCOPES.has(scope)) ||
    new Set(permissions).size !== permissions.length
  )
    return json({error: "Sélectionne des permissions valides."}, 400);
  if (!midnight || midnight.toISOString().slice(0, 10) !== date)
    return json({error: "Date d’expiration invalide."}, 400);
  const expiresAt = midnight.getTime() / 1000 + 86400;
  if (expiresAt <= now) return json({error: "La date d’expiration est passée."}, 400);

  const id = uid(),
    prefix = "mff_" + uid().replaceAll("-", ""),
    token = prefix + "." + b64(crypto.getRandomValues(new Uint8Array(32)));
  await e.DB.prepare(
    "INSERT INTO api_keys(id,user_id,name,prefix,key_hash,permissions,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)"
  )
    .bind(id, userId, name, prefix, await sha(token), JSON.stringify(permissions), now, expiresAt)
    .run();
  return json(
    {
      key: {
        id,
        name,
        prefix,
        permissions,
        created_at: now,
        expires_at: expiresAt,
        last_used_at: null,
        revoked_at: null,
      },
      token,
    },
    201
  );
}

const AUTHOR_WEEK =
  "date(?,printf('%+d days',CAST(COALESCE(julianday(date(p.start_monday,'-6 days','weekday 1'))-julianday(date(f.start_monday,'-6 days','weekday 1')),0) AS INTEGER)))";

async function programData(e, userId, context = null) {
  // Programmes accessibles calculés une seule fois (au lieu de répéter le filtre d'accès, qui relit tout l'historique
  // des séances, dans chacune des 4 requêtes) ; seuls ces identifiants sont ensuite utilisés.
  const accessIds = (
      await e.DB.prepare(
        context
          ? `SELECT p.id FROM programs p LEFT JOIN program_follows f ON f.program_id=p.id AND f.user_id=?
             WHERE p.is_default=0 AND (p.user_id=? OR f.user_id IS NOT NULL)
               AND ((COALESCE(f.start_monday,p.start_monday)<=? AND COALESCE(f.end_monday,p.end_monday)>=?) OR p.id=?
                 OR EXISTS(SELECT 1 FROM program_wods w WHERE w.id=? AND w.program_id=p.id))`
          : "SELECT id FROM programs WHERE user_id=? UNION SELECT program_id FROM program_follows WHERE user_id=? UNION SELECT program_id FROM training_sessions WHERE user_id=?"
      )
        .bind(
          ...(context
            ? [userId, userId, context.end, context.week, context.programId, context.wodId]
            : [userId, userId, userId])
        )
        .all()
    ).results.map(r => r.id),
    ACCESS = accessIds.length ? "p.id IN (" + accessIds.map(() => "?").join(",") + ")" : "0";
  const [p, w, mv, wp] = await Promise.all([
    e.DB.prepare(
      // followed : programme suivi ; read_only : programme d'un autre auteur (suivi, ou suivi auparavant).
      "SELECT p.*,EXISTS(SELECT 1 FROM training_sessions s WHERE s.program_id=p.id) AS has_sessions,(SELECT COUNT(*) FROM program_follows x WHERE x.program_id=p.id) AS followers,CASE WHEN p.user_id<>? AND f.user_id IS NOT NULL THEN 1 ELSE 0 END AS followed,CASE WHEN p.user_id=? THEN 0 ELSE 1 END AS read_only,a.first_name AS author_first_name,a.last_name AS author_last_name,f.start_monday AS follow_start,f.end_monday AS follow_end FROM programs p JOIN users a ON a.id=p.user_id" +
        FOLLOW_JOIN +
        "WHERE " +
        ACCESS +
        " ORDER BY p.is_default ASC,p.start_monday DESC"
    )
      .bind(userId, userId, userId, ...accessIds)
      .all(),
    e.DB.prepare(
      "SELECT w.*,EXISTS(SELECT 1 FROM training_sessions s WHERE s.wod_id=w.id) AS has_sessions," +
        PROGRAM_WOD_MOVEMENTS +
        " FROM program_wods w JOIN programs p ON p.id=w.program_id WHERE " +
        ACCESS +
        " AND (w.name<>'__AUTRES__' OR p.user_id=?) ORDER BY w.program_id,w.sort_order,w.created_at"
    )
      .bind(...accessIds, userId)
      .all(),
    e.DB.prepare(
      "SELECT pm.* FROM program_movements pm JOIN programs p ON p.id=pm.program_id WHERE " +
        ACCESS +
        " ORDER BY pm.program_id,pm.sort_order,pm.created_at"
    )
      .bind(...accessIds)
      .all(),
    e.DB.prepare(
      "SELECT x.wod_id,x.week_start,x.content,x.blocks,x.edit_version FROM weekly_wod_programming x JOIN program_wods w ON w.id=x.wod_id JOIN programs p ON p.id=w.program_id " +
        (context ? FOLLOW_JOIN : "") +
        " WHERE " +
        ACCESS +
        (context ? " AND x.week_start=" + AUTHOR_WEEK : "") +
        " ORDER BY x.week_start"
    )
      .bind(...(context ? [userId, ...accessIds, context.week] : accessIds))
      .all(),
  ]);
  const wods = {},
    movements = {},
    shifts = new Map();
  // Programme suivi : affiché aux dates de l'utilisateur, programmation hebdomadaire décalée d'autant.
  for (const x of p.results)
    if (x.followed && x.follow_start) {
      shifts.set(x.id, weekShift(x.start_monday, x.follow_start));
      Object.assign(x, {
        author_start_monday: x.start_monday,
        author_end_monday: x.end_monday,
        start_monday: x.follow_start,
        end_monday: x.follow_end,
      });
    }
  const programOfWod = new Map();
  for (const row of withMovementIds(w.results)) {
    (wods[row.program_id] ??= []).push(row);
    programOfWod.set(row.id, row.program_id);
  }
  for (const row of mv.results) (movements[row.program_id] ??= []).push(row);
  // Programme de coach suivi : une semaine déjà passée (pour l'utilisateur) garde le contenu qu'elle avait à sa fin,
  // même si le coach l'a modifié depuis (contenu remplacé gardé dans coach_wod_history, du plus ancien au plus récent).
  const coachFollowed = p.results.filter(x => x.followed && x.coach_mode && x.published_at).map(x => x.id),
    history = new Map(),
    todayLocal = localToday();
  const replaced = coachFollowed.length
    ? (
        await e.DB.prepare(
          "SELECT h.wod_id,h.week_start,h.content,h.blocks,h.replaced_on FROM coach_wod_history h JOIN program_wods w ON w.id=h.wod_id " +
            (context ? "JOIN programs p ON p.id=w.program_id " + FOLLOW_JOIN : "") +
            " WHERE w.program_id IN (" +
            coachFollowed.map(() => "?").join(",") +
            ")" +
            (context ? " AND h.week_start=" + AUTHOR_WEEK : "") +
            " ORDER BY h.id"
        )
          .bind(...(context ? [userId, ...coachFollowed, context.week] : coachFollowed))
          .all()
      ).results
    : [];
  for (const h of replaced) {
    const key = h.wod_id + "|" + h.week_start;
    if (!history.has(key)) history.set(key, []);
    history.get(key).push(h);
  }
  const weekly = wp.results.map(x => {
    const shift = shifts.get(programOfWod.get(x.wod_id));
    if (shift === undefined) return x;
    const week = addDays(x.week_start, shift),
      end = addDays(week, 6),
      old = end < todayLocal && history.get(x.wod_id + "|" + x.week_start)?.find(h => h.replaced_on > end);
    return {...x, week_start: week, edit_version: null, ...(old ? {content: old.content, blocks: old.blocks} : {})};
  });
  return {programs: p.results, wods, movements, weeklyWodPrograms: weekly};
}

const COACHING_CONTEXT_PATH = "/api/coaching-context";
const WOD_PREVIEW_PATH = EXTERNAL_WOD_PATH + "/preview";
const MOVEMENT_KEY = m => m.name.trim().toLowerCase();
const intensityCount = sessions => sessions.filter(s => s.cardio_intensity >= 3).length;
const WOD_CONFLICT = "Le WOD a changé. Relis son contenu et confirme de nouveau.";

async function coachingContext(r, e, userId) {
  const q = new URL(r.url).searchParams,
    timeZone = q.get("time_zone") ?? "Europe/Paris",
    date = q.get("date") ?? dateInTimeZone(timeZone),
    historyDays =
      q.has("history_days") && /^\d{1,2}$/.test(q.get("history_days"))
        ? Number(q.get("history_days"))
        : q.has("history_days")
          ? 0
          : 28,
    programId = q.get("program_id"),
    wodId = q.get("wod_id");
  if (
    !dateInTimeZone(timeZone) ||
    !exactCalendarDate(date) ||
    historyDays < 1 ||
    historyDays > 84 ||
    [programId, wodId].some(id => id !== null && !WOD_ID.test(id))
  )
    return json({error: "Filtres de contexte invalides."}, 400);

  const week = mondayOfDate(date),
    end = addDays(week, 6),
    from = addDays(date, 1 - historyDays),
    first = from < week ? from : week,
    {programs, wods, movements, weeklyWodPrograms} = await programData(e, userId, {date, end, week, programId, wodId});
  const accessible = programs.filter(p => !p.is_default && (!p.read_only || p.followed)),
    active = accessible.filter(
      p => p.start_monday <= date && p.end_monday >= date && !(p.coach_mode === "free" && !p.followed)
    ),
    chosen = programId
      ? accessible.find(p => p.id === programId)
      : wodId
        ? accessible.find(p => wods[p.id]?.some(w => w.id === wodId && w.name !== "__AUTRES__"))
        : null;
  if (
    ((programId || wodId) && !chosen) ||
    (wodId && !wods[chosen.id]?.some(w => w.id === wodId && w.name !== "__AUTRES__"))
  )
    return json({error: "Programme ou modèle de WOD introuvable."}, 404);

  const [sessionsResult, checks, plans, free, box, pr, catalog, sports, types, profile] = await Promise.all([
    e.DB.prepare(
      SESSION_SELECT.replace("SELECT s.*,", "SELECT s.*,w.name='__AUTRES__' AS is_other,") +
        " AND s.session_date BETWEEN ? AND ? ORDER BY s.session_date DESC,s.created_at DESC,s.id"
    )
      .bind(userId, first, end)
      .all(),
    e.DB.prepare(
      `SELECT c.session_id,pm.catalog_movement_id AS movement_id,COALESCE(mc.name,pm.name) AS name
      FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id
      JOIN program_movements pm ON pm.id=c.movement_id LEFT JOIN movement_catalog mc ON mc.id=pm.catalog_movement_id
      WHERE s.user_id=? AND s.session_date BETWEEN ? AND ?
      UNION SELECT c.session_id,mc.id,mc.name FROM session_catalog_movement_checks c
      JOIN training_sessions s ON s.id=c.session_id JOIN movement_catalog mc ON mc.id=c.catalog_movement_id
      WHERE s.user_id=? AND s.session_date BETWEEN ? AND ?`
    )
      .bind(userId, first, end, userId, first, end)
      .all(),
    e.DB.prepare(
      `SELECT wp.wod_id,wp.plan_version AS version FROM weekly_plans wp ${PLAN_WOD_JOIN}
      WHERE wp.user_id=? AND wp.week_start=? AND ${PLAN_ACCESS}`
    )
      .bind(userId, week)
      .all(),
    e.DB.prepare(
      `SELECT w.*,(SELECT group_concat(s.id) FROM training_sessions s WHERE s.daily_wod_id=w.id AND s.user_id=w.user_id) AS session_ids
      FROM daily_wods w WHERE w.user_id=? AND w.wod_date BETWEEN ? AND ? ORDER BY w.wod_date,w.created_at,w.id`
    )
      .bind(userId, week, end)
      .all(),
    memberBoxWods(e, userId, week, end),
    e.DB.prepare(PR_SELECT + " AND pr.record_date<=? ORDER BY pr.record_date DESC,pr.created_at DESC,pr.id")
      .bind(userId, date)
      .all(),
    e.DB.prepare(MOVEMENT_CATALOG_QUERY).all(),
    e.DB.prepare(
      "SELECT id,name,duration_minutes,is_default,is_active FROM activities WHERE user_id=(SELECT id FROM users WHERE email=?) AND is_active=1 ORDER BY sort_order,name"
    )
      .bind(ownerEmail(e))
      .all(),
    e.DB.prepare("SELECT id,name FROM wod_types ORDER BY sort_order,name").all(),
    e.DB.prepare("SELECT level,goals,equipment,constraints FROM ai_profiles WHERE user_id=?").bind(userId).first(),
  ]);
  const checked = new Map();
  for (const {session_id, movement_id, name} of checks.results) {
    if (!checked.has(session_id)) checked.set(session_id, new Map());
    const key = MOVEMENT_KEY({name}),
      list = checked.get(session_id);
    if (movement_id || !list.has(key)) list.set(key, {movement_id, name});
  }
  const actual = sessionsResult.results.map(s => ({
    id: s.id,
    session_date: s.session_date,
    duration_minutes: s.duration_minutes,
    program_id: s.program_id,
    wod_id: s.wod_id,
    wod_name: s.wod_name,
    activity_id: s.activity_id,
    activity_name: s.activity_name,
    type_id: s.type_id,
    wod_type_name: s.wod_type_name,
    source: s.common_wod_id
      ? "common"
      : s.daily_wod_id
        ? "free"
        : s.box_wod_id
          ? "box"
          : s.is_other
            ? "other"
            : "program",
    daily_wod_id: s.daily_wod_id ?? null,
    box_wod_id: s.box_wod_id ?? null,
    actual_comment: s.actual_comment,
    cardio_intensity: s.cardio_intensity ?? null,
    worked_movements: [...(checked.get(s.id)?.values() || [])],
  }));
  const during = actual.filter(s => s.session_date >= week),
    history = actual.filter(s => s.session_date >= from && s.session_date <= date),
    frequency = new Map(),
    plansById = new Map(plans.results.map(x => [x.wod_id, x.version])),
    programming = new Map(weeklyWodPrograms.map(x => [x.wod_id, x])),
    selected = chosen ? [chosen] : accessible.filter(p => p.start_monday <= end && p.end_monday >= week);
  const movementFrequency = (sessions, counts) => {
    for (const s of sessions) {
      for (const movement of s.worked_movements) {
        const key = MOVEMENT_KEY(movement);
        if (!counts.has(key)) counts.set(key, {...movement, last_worked_on: s.session_date, sessions_count: 0});
        counts.get(key).sessions_count++;
      }
    }
    return [...counts.values()];
  };
  const recentFrequency = movementFrequency(history, frequency);
  const visible = p => {
    const models = (wods[p.id] || []).filter(w => w.name !== "__AUTRES__"),
      worked = new Set(during.filter(s => s.program_id === p.id && s.source === "program").map(s => s.wod_id)),
      programActual = during.filter(s => s.program_id === p.id && (s.source === "program" || s.source === "other")),
      focus = (movements[p.id] || []).map(({id, catalog_movement_id, name}) => ({id, catalog_movement_id, name})),
      counts = new Map();
    for (const s of programActual) {
      for (const movement of s.worked_movements) {
        const key = MOVEMENT_KEY(movement);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const coverage = focus.map(m => ({...m, sessions_count: counts.get(MOVEMENT_KEY(m)) || 0}));
    return {
      id: p.id,
      name: p.name,
      start_monday: p.start_monday,
      end_monday: p.end_monday,
      active: active.some(x => x.id === p.id),
      read_only: Boolean(p.read_only),
      coach_mode: p.coach_mode ?? null,
      coaching_instructions: p.coaching_instructions ?? null,
      tracked_movements: focus,
      weekly_workout_target: p.start_monday <= end && p.end_monday >= week ? models.length : null,
      weekly_cardio_target_min: p.weekly_cardio_target_min ?? null,
      weekly_cardio_target_max: p.weekly_cardio_target_max ?? null,
      workout_models: models.map(w => {
        const plan = programming.get(w.id);
        return {
          id: w.id,
          name: w.name,
          instructions: w.planned_comment,
          activity_id: w.activity_id ?? null,
          type_id: w.type_id ?? null,
          duration_minutes: w.duration_minutes ?? null,
          movement_ids: w.movement_ids,
          is_tracked: Boolean(w.is_tracked),
          score_type: w.score_type,
          plan_version: plansById.get(w.id) ?? null,
          completed: worked.has(w.id),
          programming: plan
            ? {
                content: plan.content,
                blocks: plan.blocks ? JSON.parse(plan.blocks) : null,
                edit_version: plan.edit_version,
              }
            : null,
        };
      }),
      week: {
        sessions_count: programActual.length,
        workouts_count_toward_target: models.filter(w => worked.has(w.id)).length,
        intense_cardio_exposures: intensityCount(programActual),
        movement_coverage: {
          worked: coverage.filter(m => m.sessions_count > 0).length,
          total: coverage.length,
          movements: coverage,
        },
        remaining_wod_ids: models.filter(w => !worked.has(w.id)).map(w => w.id),
      },
    };
  };
  const records = pr.results.map(row => {
    const x = withMovementCategory(row);
    return {
      ...x,
      unit:
        x.fixed_kind === "distance" || x.fixed_kind === "reps"
          ? "s"
          : ["load", "force"].includes(x.measurement_method)
            ? "kg"
            : x.measurement_method === "distance"
              ? "m"
              : "reps",
      fixed_unit: {distance: "m", reps: "reps", time: "s"}[x.fixed_kind] ?? null,
    };
  });
  return json({
    reference_date: date,
    time_zone: timeZone,
    active_program_ids: active.map(p => p.id),
    selected_program_id: chosen?.id ?? (active.length === 1 ? active[0].id : null),
    selected_wod_id: wodId,
    athlete_profile: profile,
    programs: selected.map(visible),
    week: {
      week_start: week,
      week_end: end,
      completed_sessions: during,
      worked_movements: movementFrequency(during, new Map()),
      sessions_count: during.length,
      intense_cardio_exposures: intensityCount(during),
      free_wods: free.results.map(w => ({
        ...dailyWodOut(w),
        edit_version: w.edit_version,
        can_replace: !w.benchmark_id && !w.common_wod_id && !w.session_ids,
      })),
      box_wods: box.map(w => ({...w, blocks: typeof w.blocks === "string" ? JSON.parse(w.blocks) : w.blocks})),
    },
    recent: {from, to: date, sessions: history, movement_frequency: recentFrequency},
    performance: {records, workload_records: records.filter(x => x.unit === "kg").map(x => x.id)},
    references: {
      activities: sports.results,
      wod_types: types.results,
      movements: catalog.results.map(withMovementCategory),
    },
  });
}

async function readGeneratedWodBody(r, maxBytes = 65536) {
  if (!r.body) return null;
  const reader = r.body.getReader(),
    decoder = new TextDecoder("utf-8", {fatal: true});
  let size = 0,
    source = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return JSON.parse(source + decoder.decode());
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      source += decoder.decode(value, {stream: true});
    }
  } catch {
    return null;
  }
}

async function generatedWodState(e, userId, target) {
  if (target.kind === "program") {
    const old = await programWodState(e.DB, userId, target.wod_id, target.week_start);
    if (!old || old.program_id !== target.program_id) return {error: "WOD introuvable.", status: 404};
    if (old.start_monday > addDays(target.week_start, 6) || old.end_monday < target.week_start)
      return {error: "Cette semaine est hors période du programme.", status: 400};
    return {version: old.edit_version, previous_content: old.content};
  }
  const old = await e.DB.prepare(
    `SELECT edit_version,content,wod_date,common_wod_id,benchmark_id,
    EXISTS(SELECT 1 FROM training_sessions s WHERE s.daily_wod_id=w.id) AS completed
    FROM daily_wods w WHERE w.id=? AND w.user_id=?`
  )
    .bind(target.wod_id, userId)
    .first();
  if (old && (old.common_wod_id || old.benchmark_id || old.completed))
    return {error: "Ce WOD personnel ne peut plus être remplacé.", status: 409};
  const now = localToday();
  if (old ? old.wod_date !== target.wod_date : target.wod_date < now || target.wod_date > addDays(now, 365))
    return {error: "Date du WOD personnel non autorisée.", status: 400};
  return {version: old?.edit_version ?? null, previous_content: old?.content ?? null};
}

async function wodConfirmationKey(e) {
  const {value} = await e.DB.prepare("SELECT value FROM app_settings WHERE key='wod_preview_signing'").first();
  return crypto.subtle.importKey("raw", unb64(value), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);
}

async function externalGeneratedWods(r, e, userId, preview) {
  if (r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({error: "Un corps JSON est requis."}, 415);
  const body = await readGeneratedWodBody(r),
    input = externalWodInput(body, exactCalendarDate, mondayOfDate);
  if (!input) return json({error: "Contenu ou destination du WOD invalide."}, 400);
  const {target} = input;
  if (preview) {
    const state = await generatedWodState(e, userId, target);
    if (state.error) return json({error: state.error}, state.status);
    if (JSON.parse(await catalogMovementIds(e, input.movement_ids)).length !== input.movement_ids.length)
      return json({error: "Mouvement inconnu dans le catalogue."}, 400);
    const expires = Math.floor(Date.now() / 1000) + 900,
      fingerprint = await sha(JSON.stringify([userId, state.version, input])),
      signature = b64(
        await crypto.subtle.sign("HMAC", await wodConfirmationKey(e), enc.encode(expires + "." + fingerprint))
      );
    return json({
      target,
      operation: state.version ? "replace" : "create",
      edit_version: state.version,
      previous_content: state.previous_content,
      title: input.title,
      duration_minutes: input.duration_minutes,
      content: input.content,
      blocks: input.blocks,
      confirmation: expires + "." + signature,
      expires_at: new Date(expires * 1000).toISOString(),
    });
  }
  const match = r.headers.get("If-Match"),
    none = r.headers.get("If-None-Match"),
    expected = match?.slice(1, -1) ?? null;
  if (!match && none !== "*") return json({error: "Une précondition de version est requise."}, 428);
  if (match && (none !== null || !WOD_VERSION.test(expected) || match !== '"' + expected + '"'))
    return json({error: "Précondition de version invalide."}, 400);
  const {requestId, expiresAt, error} = readIdempotencyKey(r);
  if (error) return error;
  const fingerprint = await sha(JSON.stringify([userId, expected, input]));
  const proof = /^(\d{10})\.([a-zA-Z0-9_-]{43})$/.exec(r.headers.get("X-WOD-Confirmation") || "");
  if (
    !proof ||
    !(await crypto.subtle.verify(
      "HMAC",
      await wodConfirmationKey(e),
      unb64(proof[2]),
      enc.encode(proof[1] + "." + fingerprint)
    ))
  )
    return json({error: "Confirme une préparation correspondant à ce contenu et à cette version."}, 428);
  const receiptSelect = e.DB.prepare(
    "SELECT request_hash,version FROM wod_api_requests WHERE user_id=? AND request_id=?"
  ).bind(userId, requestId);
  const answer = receipt =>
    receipt.request_hash === fingerprint
      ? json({ok: true, target, edit_version: receipt.version}, 200, {ETag: '"' + receipt.version + '"'})
      : json({error: "Cette clé d’idempotence est déjà associée à une autre opération."}, 409);
  const already = await receiptSelect.first();
  if (already) return answer(already);
  if (Number(proof[1]) <= Date.now() / 1000)
    return json({error: "Préparation expirée. Relis et confirme de nouveau."}, 428);
  const state = await generatedWodState(e, userId, target);
  if (state.error || state.version !== expected) {
    const raced = await receiptSelect.first();
    if (raced) return answer(raced);
    return state.error ? json({error: state.error}, state.status) : json({error: WOD_CONFLICT}, 412);
  }
  if (JSON.parse(await catalogMovementIds(e, input.movement_ids)).length !== input.movement_ids.length)
    return json({error: "Mouvement inconnu dans le catalogue."}, 400);
  const version = uid().replaceAll("-", ""),
    statements =
      target.kind === "program"
        ? generatedProgramStatements(e.DB, {
            userId,
            wodId: target.wod_id,
            programId: target.program_id,
            week: target.week_start,
            end: addDays(target.week_start, 6),
            today: localToday(),
            content: input.content,
            blocks: JSON.stringify(input.blocks),
            expected,
            version,
            requestId,
          })
        : [saveFreeWodStatement(e.DB, generatedFreeRow(input), userId, version, expected, requestId)];
  const result = await e.DB.batch([
    ...statements,
    insertWodReceipt(e.DB, {userId, requestId, expiresAt, fingerprint, version, target}),
    receiptSelect,
  ]);
  const receipt = result.at(-1).results[0];
  if (receipt) return answer(receipt);
  const latest = await generatedWodState(e, userId, target);
  if (latest.error) return json({error: latest.error}, latest.status);
  if (latest.version !== expected) return json({error: WOD_CONFLICT}, 412);
  return json({error: "Destination du WOD indisponible."}, 409);
}

async function externalGeneratedProgram(r, e, userId, preview) {
  if (r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({error: "Un corps JSON est requis."}, 415);
  const body = await readGeneratedWodBody(r, 512 * 1024);
  const input = externalProgramInput(body, exactCalendarDate, mondayOfDate, addDays);
  if (!input) return json({error: "Programme ou WOD détaillés invalides."}, 400);
  const cardio = programCardioTargets(body);
  if (cardio.error) return json({error: cardio.error}, 400);
  const instructions =
    "Objectif : " + input.objective + (input.coaching_instructions ? "\n" + input.coaching_instructions : "");
  if (instructions.length > 4000) return json({error: "Objectif et consignes trop longs."}, 400);
  const fingerprint = await sha(JSON.stringify(["new-program", userId, input, cardio.values]));
  const db = e.DB;
  const overlap = `NOT EXISTS(SELECT 1 FROM programs WHERE user_id=? AND is_default=0 AND coach_mode IS NULL
      AND NOT(end_monday<? OR start_monday>?))
    AND NOT EXISTS(SELECT 1 FROM program_follows WHERE user_id=? AND NOT(end_monday<? OR start_monday>?))`;
  const overlapArgs = [userId, input.start, input.end, userId, input.start, input.end];
  const conflict = () => json({error: "Les dates chevauchent un programme personnel ou suivi."}, 409);
  if (preview) {
    if (
      !(
        await db
          .prepare("SELECT " + overlap + " AS available")
          .bind(...overlapArgs)
          .first()
      ).available
    )
      return conflict();
    const ids = [...new Set(input.drafts.flatMap(d => d.movement_ids))];
    const {results} = await db
      .prepare("SELECT id FROM movement_catalog WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids))
      .all();
    if (results.length !== ids.length) return json({error: "Mouvement inconnu dans le catalogue."}, 400);
    const expires = Math.floor(Date.now() / 1000) + 900;
    const signature = b64(
      await crypto.subtle.sign("HMAC", await wodConfirmationKey(e), enc.encode(expires + "." + fingerprint))
    );
    return json({
      ...input,
      weekly_cardio_target_min: cardio.values[0],
      weekly_cardio_target_max: cardio.values[1],
      confirmation: expires + "." + signature,
      expires_at: new Date(expires * 1000).toISOString(),
    });
  }
  if (r.headers.get("If-None-Match") !== "*") return json({error: "Précondition de création requise."}, 428);
  const {requestId, expiresAt, error} = readIdempotencyKey(r);
  if (error) return error;
  const receiptKey = "program:" + requestId;
  const proof = /^(\d{10})\.([a-zA-Z0-9_-]{43})$/.exec(r.headers.get("X-WOD-Confirmation") || "");
  if (
    !proof ||
    !(await crypto.subtle.verify(
      "HMAC",
      await wodConfirmationKey(e),
      unb64(proof[2]),
      enc.encode(proof[1] + "." + fingerprint)
    ))
  )
    return json({error: "Confirme un aperçu correspondant à ce programme."}, 428);
  const receipt = db
    .prepare("SELECT request_hash,version FROM wod_api_requests WHERE user_id=? AND request_id=?")
    .bind(userId, receiptKey);
  const respond = row =>
    row.request_hash === fingerprint
      ? json({ok: true, id: row.version, models_count: input.models.length, drafted_count: input.drafts.length})
      : json({error: "Cette clé d’idempotence est déjà utilisée."}, 409);
  const prior = await receipt.first();
  if (prior) return respond(prior);
  if (Number(proof[1]) <= Date.now() / 1000) return json({error: "Aperçu expiré."}, 428);

  const id = uid();
  const models = input.models.map(model => ({...model, id: uid()}));
  const drafts = input.drafts.map(draft => ({
    ...draft,
    id: models[draft.model - 1].id,
    version: uid().replaceAll("-", ""),
  }));
  const ids = [...new Set(input.drafts.flatMap(d => d.movement_ids))];
  try {
    const output = await db.batch([
      db
        .prepare(
          `INSERT INTO programs(id,user_id,name,start_monday,end_monday,is_default,is_public,
          weekly_cardio_target_min,weekly_cardio_target_max,coaching_instructions)
        SELECT ?,?,?,?,?,0,0,?,?,? WHERE ${overlap}
          AND NOT EXISTS(SELECT 1 FROM wod_api_requests WHERE user_id=? AND request_id=?)
          AND NOT EXISTS(SELECT 1 FROM json_each(?) AS requested
            WHERE NOT EXISTS(SELECT 1 FROM movement_catalog m WHERE m.id=requested.value))`
        )
        .bind(
          id,
          userId,
          input.name,
          input.start,
          input.end,
          ...cardio.values,
          instructions,
          ...overlapArgs,
          userId,
          receiptKey,
          JSON.stringify(ids)
        ),
      db
        .prepare(
          `INSERT INTO program_wods(id,program_id,user_id,name,planned_comment,duration_minutes,is_tracked,sort_order)
        SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.name'),json_extract(value,'$.instructions'),
          json_extract(value,'$.duration_minutes'),1,CAST(key AS INTEGER)
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM programs WHERE id=? AND user_id=?)`
        )
        .bind(id, userId, JSON.stringify(models), id, userId),
      db
        .prepare(
          `INSERT INTO weekly_wod_programming(wod_id,user_id,week_start,content,blocks,edit_version)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.week_start'),json_extract(value,'$.content'),
          json_extract(value,'$.blocks'),json_extract(value,'$.version')
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM programs WHERE id=? AND user_id=?)`
        )
        .bind(userId, JSON.stringify(drafts), id, userId),
      db
        .prepare(
          `INSERT INTO wod_api_requests(user_id,request_id,request_hash,version,expires_at)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM programs WHERE id=? AND user_id=?)`
        )
        .bind(userId, receiptKey, fingerprint, id, expiresAt, id, userId),
      receipt,
    ]);
    const saved = output.at(-1).results[0];
    return saved ? respond(saved) : conflict();
  } catch (failure) {
    const raced = await receipt.first();
    if (raced) return respond(raced);
    throw failure;
  }
}

async function api(r, e, p, ctx = null, apiUser = null) {
  const adminEmail = ownerEmail(e);
  if (r.method === "POST" && p === "/api/register") {
    const b = await r.json(),
      email = String(b.email || "")
        .trim()
        .toLowerCase(),
      pw = String(b.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({error: "Adresse e-mail invalide."}, 400);
    if (pw.length < 12) return json({error: "Mot de passe : 12 caractères minimum."}, 400);
    if (await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first())
      return json({error: "Ce compte existe déjà."}, 409);
    const id = uid();
    await e.DB.prepare("INSERT INTO users(id,email,password_hash,interface_mode) VALUES(?,?,?,'simple')")
      .bind(id, email, await hashPass(pw))
      .run();
    return session(id, email, e);
  }
  if (r.method === "POST" && p === "/api/password/forgot") {
    // Réponse identique que le compte existe ou non (pas de divulgation des adresses inscrites).
    const b = await r.json(),
      email = String(b.email || "")
        .trim()
        .toLowerCase()
        .slice(0, 200),
      ip = r.headers.get("CF-Connecting-IP") || "inconnue",
      since = Math.floor(Date.now() / 1000) - 3600,
      count = async key =>
        (
          await e.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE attempt_key=? AND attempted_at>?")
            .bind(key, since)
            .first()
        ).n,
      allowed =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
        (await count("reset:" + email)) < 3 &&
        (await count("reset-ip:" + ip)) < 30;
    if (allowed) {
      const now = Math.floor(Date.now() / 1000);
      await e.DB.batch([
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind("reset:" + email, now),
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind("reset-ip:" + ip, now),
      ]);
      const account = await e.DB.prepare("SELECT id FROM users WHERE email=? AND is_active=1").bind(email).first();
      if (account) await sendResetEmail(e, email, await createResetLink(e, account.id, new URL(r.url).origin));
    }
    return json({ok: true});
  }
  if (r.method === "POST" && p === "/api/password/reset") {
    const b = await r.json(),
      pw = String(b.password || ""),
      token = String(b.token || "").slice(0, 200),
      now = Math.floor(Date.now() / 1000);
    if (pw.length < 12) return json({error: "Mot de passe : 12 caractères minimum."}, 400);
    const hash = await sha(token),
      reset = await e.DB.prepare(
        "SELECT pr.user_id,u.email FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token_hash=? AND pr.used_at IS NULL AND pr.expires_at>? AND u.is_active=1"
      )
        .bind(hash, now)
        .first();
    if (!reset) return json({error: "Lien invalide ou expiré : demande un nouveau lien."}, 400);
    await e.DB.batch([
      e.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPass(pw), reset.user_id),
      e.DB.prepare("UPDATE password_resets SET used_at=? WHERE token_hash=?").bind(now, hash),
      e.DB.prepare("DELETE FROM password_resets WHERE user_id=? AND token_hash<>?").bind(reset.user_id, hash),
      e.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(reset.user_id),
      e.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind("email:" + reset.email),
    ]);
    return session(reset.user_id, reset.email, e);
  }
  if (r.method === "POST" && p === "/api/login") {
    const b = await r.json(),
      email = String(b.email || "")
        .trim()
        .toLowerCase()
        .slice(0, 200),
      keys = loginKeys(r, email),
      wait = await loginWaitMinutes(e, keys);
    if (wait > 0)
      return json({error: `Trop de tentatives de connexion. Réessaie dans ${wait} minute${wait > 1 ? "s" : ""}.`}, 429);
    const u = await e.DB.prepare("SELECT id,email,password_hash,is_active FROM users WHERE email=?")
      .bind(email)
      .first();
    if (!u || !u.is_active || !(await verify(String(b.password || ""), u.password_hash))) {
      const now = Math.floor(Date.now() / 1000);
      await e.DB.batch([
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind(keys.email, now),
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind(keys.ip, now),
      ]);
      return json({error: "Identifiants incorrects."}, 401);
    }
    await e.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind(keys.email).run();
    return session(u.id, u.email, e);
  }
  if (r.method === "POST" && p === "/api/logout") {
    const t = sessionToken(r),
      defaults = await appDefaults(e);
    if (t)
      await e.DB.prepare("DELETE FROM sessions WHERE id_hash=?")
        .bind(await sha(t))
        .run();
    return json({ok: true, default_theme: defaults.theme}, 200, {"set-cookie": setCookie("", 0)});
  }
  if (r.method === "GET" && p === "/api/me") {
    const [u, defaults] = await Promise.all([me(r, e), appDefaults(e)]);
    return json({
      user: u
        ? {
            id: u.id,
            email: u.email,
            first_name: u.first_name,
            last_name: u.last_name,
            body_weight_kg: u.body_weight_kg ?? null,
            birth_date: u.birth_date ?? null,
            sex: u.sex || "",
          }
        : null,
      is_admin: isAdminUser(e, u),
      default_theme: defaults.theme,
    });
  }
  const u = apiUser || (await me(r, e));
  if (!u) return json({error: "Connexion requise."}, 401);
  if (p === "/api/api-keys" || p.startsWith("/api/api-keys/")) {
    if (apiUser) return json({error: "Connexion par session requise."}, 403);
    return manageApiKeys(r, e, p, u.id);
  }
  if (r.method === "GET" && p === COACHING_CONTEXT_PATH) return coachingContext(r, e, u.id);
  if ((r.method === "POST" && p === WOD_PREVIEW_PATH) || (r.method === "PUT" && p === EXTERNAL_WOD_PATH)) {
    if (!apiUser) return json({error: "Une clé API est requise."}, 403);
    return externalGeneratedWods(r, e, u.id, p === WOD_PREVIEW_PATH);
  }
  if (
    (r.method === "POST" && p === EXTERNAL_PROGRAM_PATH + "/preview") ||
    (r.method === "PUT" && p === EXTERNAL_PROGRAM_PATH)
  ) {
    if (!apiUser) return json({error: "Une clé API est requise."}, 403);
    return externalGeneratedProgram(r, e, u.id, r.method === "POST");
  }
  const admin = !apiUser && isAdminUser(e, u);
  let m;
  if (p.startsWith("/api/push/")) {
    if (r.method === "GET" && p === "/api/push/config") {
      const keys = await vapidKeys(e.DB),
        st = await userReminders(e, u.id),
        n = await e.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?").bind(u.id).first();
      return json({
        publicKey: keys.publicKey,
        days: st.days,
        hour: st.hour,
        enabled: st.enabled,
        devices: n.n,
        choices: {days: REMINDER_DAYS, hours: REMINDER_HOURS},
      });
    }
    if (r.method === "POST" && p === "/api/push/subscribe") {
      const defaults = await userReminders(e, u.id),
        b = await r.json(),
        endpoint = String(b.endpoint || ""),
        p256dh = String(b.keys?.p256dh || ""),
        auth = String(b.keys?.auth || "");
      if (!isAllowedEndpoint(endpoint) || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth))
        return json({error: "Abonnement aux notifications invalide."}, 400);
      await e.DB.batch([
        e.DB.prepare(
          "INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth"
        ).bind(endpoint, u.id, p256dh, auth),
        e.DB.prepare("INSERT OR IGNORE INTO reminder_settings(user_id,days,hour,enabled) SELECT ?,?,?,?").bind(
          u.id,
          defaults.days,
          defaults.hour,
          defaults.enabled
        ),
      ]);
      return json({ok: true});
    }
    if (r.method === "POST" && p === "/api/push/unsubscribe") {
      const b = await r.json();
      await e.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?")
        .bind(String(b.endpoint || ""), u.id)
        .run();
      return json({ok: true});
    }
    if (r.method === "PUT" && p === "/api/push/settings") {
      const error = await saveReminderSettings(e, u.id, await r.json());
      return error ? json({error}, 400) : json({ok: true});
    }
    if (r.method === "POST" && p === "/api/push/test") {
      const x = await pushToUser(e, u.id, {
        title: "myFitFactory",
        body: "Les rappels fonctionnent sur cet appareil.",
        tag: "test",
        url: "/",
      });
      return json({ok: true, ...x});
    }
    return json({error: "Route inconnue."}, 404);
  }
  if (r.method === "GET" && p === "/api/activities") {
    const owner = await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(adminEmail).first();
    if (owner) {
      const seed = await e.DB.prepare("SELECT id FROM activities WHERE user_id=? LIMIT 1").bind(owner.id).first();
      if (!seed) {
        await e.DB.prepare(
          "INSERT INTO activities(id,user_id,name,duration_minutes,is_default,is_active) SELECT ?,?,?,?,1,1 WHERE NOT EXISTS(SELECT 1 FROM activities WHERE user_id=?)"
        )
          .bind(uid(), owner.id, "CrossFit", 60, owner.id)
          .run();
      }
    }
    const x = owner
      ? await e.DB.prepare(
          "SELECT id,name,duration_minutes,is_default,is_active FROM activities WHERE user_id=? AND is_active=1 ORDER BY is_default DESC,name"
        )
          .bind(owner.id)
          .all()
      : {results: []};
    return json({activities: x.results});
  }
  if (r.method === "GET" && p === "/api/movement-catalog") {
    const x = await e.DB.prepare(MOVEMENT_CATALOG_QUERY).all();
    return json({movements: x.results.map(withMovementCategory)});
  }
  // Liste commune des types de WOD (choix dans les formulaires de WOD et de séance).
  if (r.method === "GET" && p === "/api/wod-types")
    return json({types: (await e.DB.prepare("SELECT id,name FROM wod_types ORDER BY sort_order,name").all()).results});
  if (p.startsWith("/api/admin/")) {
    if (!admin) return json({error: "Accès administrateur requis."}, 403);
    // Les activités appartiennent au compte administrateur principal (ADMIN_EMAIL), quel que soit l'admin connecté.
    const ownerId = (await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(adminEmail).first())?.id;
    if (p.startsWith("/api/admin/activities") && !ownerId)
      return json({error: "Le compte administrateur principal n’existe pas encore."}, 409);
    if (r.method === "GET" && p === "/api/admin/movements") {
      const x = await e.DB.prepare(MOVEMENT_CATALOG_QUERY).all();
      return json({movements: x.results.map(withMovementCategory)});
    }
    if (r.method === "POST" && p === "/api/admin/movements") {
      const b = await r.json(),
        name = String(b.name || "")
          .trim()
          .slice(0, 80),
        method = String(b.measurement_method || "load");
      if (!name) return json({error: "Nom du mouvement requis."}, 400);
      if (!validMeasurementMethod(method)) return json({error: "Méthode de calcul invalide."}, 400);
      if (b.category !== undefined && !validMovementCategory(b.category))
        return json({error: "Catégorie de mouvement invalide."}, 400);
      const id = uid();
      try {
        await e.DB.prepare(
          "INSERT INTO movement_catalog(id,name,measurement_method,category,sort_order) VALUES(?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM movement_catalog),0))"
        )
          .bind(id, name, method, b.category ?? null)
          .run();
      } catch {
        return json({error: "Ce mouvement existe déjà dans le catalogue."}, 409);
      }
      return json({ok: true, id});
    }
    if (r.method === "PUT" && p === "/api/admin/movements/order") {
      const b = await r.json(),
        id = String(b.id || ""),
        d = Number(b.direction);
      if (![-1, 1].includes(d)) return json({error: "Déplacement invalide."}, 400);
      const rows = (await e.DB.prepare("SELECT id FROM movement_catalog ORDER BY sort_order,name COLLATE NOCASE").all())
          .results,
        i = rows.findIndex(x => x.id === id),
        j = i + d;
      if (i < 0 || j < 0 || j >= rows.length) return json({error: "Déplacement impossible."}, 400);
      [rows[i], rows[j]] = [rows[j], rows[i]];
      await e.DB.batch(
        rows.map((x, n) => e.DB.prepare("UPDATE movement_catalog SET sort_order=? WHERE id=?").bind(n, x.id))
      );
      return json({ok: true});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/movements\/([\w-]+)$/))) {
      const b = await r.json(),
        name = String(b.name || "")
          .trim()
          .slice(0, 80),
        method = String(b.measurement_method || "load");
      if (!name) return json({error: "Nom du mouvement requis."}, 400);
      if (!validMeasurementMethod(method)) return json({error: "Méthode de calcul invalide."}, 400);
      if (b.category !== undefined && !validMovementCategory(b.category))
        return json({error: "Catégorie de mouvement invalide."}, 400);
      const current = await e.DB.prepare("SELECT measurement_method,category FROM movement_catalog WHERE id=?")
        .bind(m[1])
        .first();
      if (!current) return json({error: "Mouvement introuvable."}, 404);
      const existingPr = await e.DB.prepare("SELECT id FROM personal_records WHERE movement_id=? LIMIT 1")
        .bind(m[1])
        .first();
      if (existingPr) {
        const loadFamily = ["load", "force"];
        if (
          current.measurement_method !== method &&
          !(loadFamily.includes(current.measurement_method) && loadFamily.includes(method)) &&
          !(current.measurement_method === "reps" && method === "reps_time")
        )
          return json(
            {
              error: "Cette mesure est incompatible avec les records déjà enregistrés pour ce mouvement.",
            },
            409
          );
      }
      try {
        const result = await e.DB.prepare(
          "UPDATE movement_catalog SET name=?,measurement_method=?,category=? WHERE id=?"
        )
          .bind(name, method, b.category ?? current.category, m[1])
          .run();
        if (!result.meta?.changes) return json({error: "Mouvement introuvable."}, 404);
      } catch {
        return json({error: "Ce mouvement existe déjà dans le catalogue."}, 409);
      }
      return json({ok: true});
    }
    if (r.method === "DELETE" && (m = p.match(/^\/api\/admin\/movements\/([\w-]+)$/))) {
      const used = await e.DB.prepare(
        "SELECT 1 FROM program_movements WHERE catalog_movement_id=? UNION ALL SELECT 1 FROM session_catalog_movement_checks WHERE catalog_movement_id=? LIMIT 1"
      )
        .bind(m[1], m[1])
        .first();
      if (used)
        return json(
          {error: "Suppression impossible : ce mouvement est utilisé dans au moins un programme ou une séance."},
          409
        );
      const usedInPr = await e.DB.prepare("SELECT id FROM personal_records WHERE movement_id=? LIMIT 1")
        .bind(m[1])
        .first();
      if (usedInPr) return json({error: "Suppression impossible : ce mouvement possède des PR enregistrés."}, 409);
      await e.DB.prepare("DELETE FROM movement_catalog WHERE id=?").bind(m[1]).run();
      return json({ok: true});
    }
    if (r.method === "GET" && p === "/api/admin/users") {
      const x = await e.DB.prepare(
        "SELECT id,email,first_name,last_name,is_active,is_admin,coach_status,email=? AS is_owner FROM users ORDER BY email"
      )
        .bind(adminEmail)
        .all();
      return json({users: x.results});
    }
    if (r.method === "POST" && (m = p.match(/^\/api\/admin\/users\/([\w-]+)\/reset-link$/))) {
      const target = await e.DB.prepare("SELECT id FROM users WHERE id=? AND is_active=1").bind(m[1]).first();
      if (!target) return json({error: "Utilisateur introuvable ou inactif."}, 404);
      return json({ok: true, link: await createResetLink(e, target.id, new URL(r.url).origin), minutes: RESET_MINUTES});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/users\/([\w-]+)$/))) {
      const b = await r.json(),
        target = await e.DB.prepare("SELECT id,email FROM users WHERE id=?").bind(m[1]).first();
      if (!target) return json({error: "Utilisateur introuvable."}, 404);
      if (b.is_active !== undefined) {
        if (target.id === u.id || target.email === adminEmail)
          return json({error: "Impossible de désactiver ce compte administrateur."}, 400);
        await e.DB.prepare("UPDATE users SET is_active=? WHERE id=?")
          .bind(b.is_active ? 1 : 0, m[1])
          .run();
      }
      if (b.is_admin !== undefined) {
        if (target.email === adminEmail)
          return json({error: "Le compte administrateur principal reste toujours administrateur."}, 400);
        if (target.id === u.id && !b.is_admin)
          return json({error: "Tu ne peux pas retirer tes propres droits d’administration."}, 400);
        await e.DB.prepare("UPDATE users SET is_admin=? WHERE id=?")
          .bind(b.is_admin ? 1 : 0, m[1])
          .run();
      }
      // Rôle coach : demande validée (ou rôle donné directement), ou rôle retiré (demande refusée).
      if (b.coach !== undefined)
        await e.DB.prepare("UPDATE users SET coach_status=? WHERE id=?")
          .bind(b.coach ? "approved" : null, m[1])
          .run();
      return json({ok: true});
    }
    // Types de WOD (liste commune : WOD de box, WOD de programme, séances) : ajout, renommage, ordre, suppression
    // (refusée si un WOD ou une séance l'utilise).
    if (r.method === "GET" && p === "/api/admin/wod-types")
      return json({
        types: (
          await e.DB.prepare(
            "SELECT t.id,t.name,t.sort_order,(SELECT COUNT(*) FROM box_wods w WHERE w.wod_type_id=t.id)+(SELECT COUNT(*) FROM program_wods w WHERE w.type_id=t.id)+(SELECT COUNT(*) FROM training_sessions s WHERE s.type_id=t.id) AS uses FROM wod_types t ORDER BY t.sort_order,t.name"
          ).all()
        ).results,
      });
    if (r.method === "POST" && p === "/api/admin/wod-types") {
      const name = String((await r.json()).name || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      if (!name) return json({error: "Nom du type de WOD requis."}, 400);
      try {
        await e.DB.prepare(
          "INSERT INTO wod_types(id,name,sort_order) VALUES(?,?,COALESCE((SELECT MAX(sort_order)+1 FROM wod_types),0))"
        )
          .bind(uid(), name)
          .run();
      } catch {
        return json({error: "Ce type de WOD existe déjà."}, 409);
      }
      return json({ok: true});
    }
    if (r.method === "PUT" && p === "/api/admin/wod-types/order") {
      const b = await r.json(),
        d = Number(b.direction),
        rows = (await e.DB.prepare("SELECT id FROM wod_types ORDER BY sort_order,name").all()).results,
        i = rows.findIndex(x => x.id === String(b.id || "")),
        j = i + d;
      if (![-1, 1].includes(d) || i < 0 || j < 0 || j >= rows.length)
        return json({error: "Déplacement impossible."}, 400);
      [rows[i], rows[j]] = [rows[j], rows[i]];
      await e.DB.batch(rows.map((x, n) => e.DB.prepare("UPDATE wod_types SET sort_order=? WHERE id=?").bind(n, x.id)));
      return json({ok: true});
    }
    if ((m = p.match(/^\/api\/admin\/wod-types\/([\w-]+)$/)) && (r.method === "PUT" || r.method === "DELETE")) {
      if (!(await e.DB.prepare("SELECT 1 FROM wod_types WHERE id=?").bind(m[1]).first()))
        return json({error: "Type de WOD introuvable."}, 404);
      if (r.method === "PUT") {
        const name = String((await r.json()).name || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        if (!name) return json({error: "Nom du type de WOD requis."}, 400);
        try {
          await e.DB.prepare("UPDATE wod_types SET name=? WHERE id=?").bind(name, m[1]).run();
        } catch {
          return json({error: "Ce type de WOD existe déjà."}, 409);
        }
        return json({ok: true});
      }
      if (
        await e.DB.prepare(
          "SELECT 1 FROM box_wods WHERE wod_type_id=? UNION ALL SELECT 1 FROM program_wods WHERE type_id=? UNION ALL SELECT 1 FROM training_sessions WHERE type_id=? LIMIT 1"
        )
          .bind(m[1], m[1], m[1])
          .first()
      )
        return json({error: "Des WOD ou des séances utilisent ce type : il ne peut plus être supprimé."}, 409);
      if ((await e.DB.prepare("SELECT COUNT(*) AS n FROM wod_types").first()).n <= 1)
        return json({error: "Il faut garder au moins un type de WOD."}, 400);
      await e.DB.prepare("DELETE FROM wod_types WHERE id=?").bind(m[1]).run();
      return json({ok: true});
    }
    if (r.method === "PUT" && p === "/api/admin/activities/order") {
      const b = await r.json(),
        id = String(b.id || ""),
        d = Number(b.direction);
      if (![-1, 1].includes(d)) return json({error: "Déplacement invalide."}, 400);
      const rows = (
          await e.DB.prepare("SELECT id FROM activities WHERE user_id=? ORDER BY sort_order,is_default DESC,name")
            .bind(ownerId)
            .all()
        ).results,
        i = rows.findIndex(x => x.id === id),
        j = i + d;
      if (i < 0 || j < 0 || j >= rows.length) return json({error: "Déplacement impossible."}, 400);
      [rows[i], rows[j]] = [rows[j], rows[i]];
      await e.DB.batch(
        rows.map((x, n) =>
          e.DB.prepare("UPDATE activities SET sort_order=? WHERE id=? AND user_id=?").bind(n, x.id, ownerId)
        )
      );
      return json({ok: true});
    }
    if (r.method === "DELETE" && (m = p.match(/^\/api\/admin\/activities\/([\w-]+)$/))) {
      const activity = await e.DB.prepare("SELECT id,is_default FROM activities WHERE id=? AND user_id=?")
        .bind(m[1], ownerId)
        .first();
      if (!activity) return json({error: "Sport introuvable."}, 404);
      const used =
        (await e.DB.prepare("SELECT id FROM program_wods WHERE activity_id=? LIMIT 1").bind(m[1]).first()) ||
        (await e.DB.prepare("SELECT id FROM training_sessions WHERE activity_id=? LIMIT 1").bind(m[1]).first());
      if (used) {
        if (activity.is_default)
          return json(
            {
              error:
                "Cette activité est utilisée. Définis d’abord une autre activité par défaut pour pouvoir la désactiver.",
            },
            400
          );
        await e.DB.prepare("UPDATE activities SET is_active=0 WHERE id=? AND user_id=?").bind(m[1], ownerId).run();
        return json({ok: true, action: "deactivated"});
      }
      const result = await e.DB.prepare("DELETE FROM activities WHERE id=? AND user_id=?").bind(m[1], ownerId).run();
      if (!result.meta?.changes) return json({error: "Sport introuvable."}, 404);
      return json({ok: true, action: "deleted"});
    }
    if (r.method === "GET" && p === "/api/admin/activities") {
      const x = await e.DB.prepare("SELECT * FROM activities WHERE user_id=? ORDER BY sort_order,is_default DESC,name")
        .bind(ownerId)
        .all();
      return json({activities: x.results});
    }
    if (r.method === "POST" && p === "/api/admin/activities") {
      const b = await r.json(),
        name = String(b.name || "")
          .trim()
          .slice(0, 80),
        duration = Number(b.duration_minutes);
      if (!name || !Number.isInteger(duration) || duration < 1 || duration > 600)
        return json({error: "Nom et durée valides requis."}, 400);
      const id = uid();
      if (b.is_default) await e.DB.prepare("UPDATE activities SET is_default=0 WHERE user_id=?").bind(ownerId).run();
      await e.DB.prepare(
        "INSERT INTO activities(id,user_id,name,duration_minutes,is_default,sort_order) VALUES(?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM activities WHERE user_id=?),0))"
      )
        .bind(id, ownerId, name, duration, b.is_default ? 1 : 0, ownerId)
        .run();
      return json({ok: true, id});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/activities\/([\w-]+)$/))) {
      const b = await r.json(),
        a = await e.DB.prepare("SELECT id FROM activities WHERE id=? AND user_id=?").bind(m[1], ownerId).first();
      if (!a) return json({error: "Sport introuvable."}, 404);
      if (b.is_active === false && a.is_default)
        return json({error: "Définis une autre activité par défaut avant de désactiver celle-ci."}, 400);
      if (b.is_default) await e.DB.prepare("UPDATE activities SET is_default=0 WHERE user_id=?").bind(ownerId).run();
      const sets = [],
        args = [];
      if (b.name !== undefined) {
        sets.push("name=?");
        args.push(String(b.name).trim().slice(0, 80));
      }
      if (b.duration_minutes !== undefined) {
        const d = Number(b.duration_minutes);
        if (!Number.isInteger(d) || d < 1 || d > 600) return json({error: "Durée invalide."}, 400);
        sets.push("duration_minutes=?");
        args.push(d);
      }
      if (b.is_active !== undefined) {
        sets.push("is_active=?");
        args.push(b.is_active ? 1 : 0);
      }
      if (b.is_default !== undefined) {
        sets.push("is_default=?");
        args.push(b.is_default ? 1 : 0);
      }
      if (sets.length)
        await e.DB.prepare("UPDATE activities SET " + sets.join(",") + " WHERE id=? AND user_id=?")
          .bind(...args, m[1], ownerId)
          .run();
      return json({ok: true});
    }
    if (r.method === "GET" && p === "/api/admin/settings")
      return json({...(await appDefaults(e)), choices: {themes: THEMES, days: REMINDER_DAYS, hours: REMINDER_HOURS}});
    if (r.method === "PUT" && p === "/api/admin/settings") {
      const b = await r.json(),
        values = {
          default_theme: String(b.theme),
          default_reminder_days: String(Number(b.reminder_days)),
          default_reminder_hour: String(Number(b.reminder_hour)),
          default_reminders_enabled: b.reminders_enabled ? "1" : "0",
        };
      if (
        !THEMES.includes(values.default_theme) ||
        !REMINDER_DAYS.includes(Number(b.reminder_days)) ||
        !REMINDER_HOURS.includes(Number(b.reminder_hour))
      )
        return json({error: "Réglages invalides."}, 400);
      await e.DB.batch(
        Object.entries(values).map(([key, value]) =>
          e.DB.prepare(
            "INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
          ).bind(key, value)
        )
      );
      return json({ok: true});
    }
    if (r.method === "GET" && p === "/api/admin/boxes") {
      const [boxes, people] = await Promise.all([
        e.DB.prepare(
          "SELECT b.id,b.name,b.city,(SELECT COUNT(*) FROM box_members m WHERE m.box_id=b.id AND m.role='member' AND m.status='approved') AS members FROM boxes b ORDER BY b.name COLLATE NOCASE"
        ).all(),
        e.DB.prepare(
          "SELECT m.box_id,m.user_id,m.status,m.created_at,u.email,u.first_name,u.last_name FROM box_members m JOIN users u ON u.id=m.user_id WHERE m.role='manager' ORDER BY m.created_at"
        ).all(),
      ]);
      return json({boxes: boxes.results, managers: people.results});
    }
    if (r.method === "POST" && p === "/api/admin/boxes") {
      const b = await r.json(),
        name = boxText(b.name, 80),
        city = boxText(b.city, 80),
        id = uid();
      if (!name) return json({error: "Nom de la box requis."}, 400);
      try {
        await e.DB.batch([
          e.DB.prepare("INSERT INTO boxes(id,name,city) VALUES(?,?,?)").bind(id, name, city),
          ...DEFAULT_BOX_CATEGORIES.map((c, i) =>
            e.DB.prepare("INSERT INTO box_categories(id,box_id,name,sort_order) VALUES(?,?,?,?)").bind(uid(), id, c, i)
          ),
        ]);
      } catch {
        return json({error: "Une box porte déjà ce nom."}, 409);
      }
      return json({ok: true, id});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/boxes\/([\w-]+)$/))) {
      const b = await r.json(),
        name = boxText(b.name, 80),
        city = boxText(b.city, 80);
      if (!name) return json({error: "Nom de la box requis."}, 400);
      try {
        const result = await e.DB.prepare("UPDATE boxes SET name=?,city=? WHERE id=?").bind(name, city, m[1]).run();
        if (!result.meta?.changes) return json({error: "Box introuvable."}, 404);
      } catch {
        return json({error: "Une box porte déjà ce nom."}, 409);
      }
      return json({ok: true});
    }
    if (r.method === "DELETE" && (m = p.match(/^\/api\/admin\/boxes\/([\w-]+)$/))) {
      const used = await e.DB.prepare(
        "SELECT 1 FROM training_sessions s JOIN box_wods w ON w.id=s.box_wod_id WHERE w.box_id=? LIMIT 1"
      )
        .bind(m[1])
        .first();
      if (used)
        return json({error: "Des séances sont enregistrées sur les WOD de cette box : suppression impossible."}, 409);
      await e.DB.prepare("DELETE FROM boxes WHERE id=?").bind(m[1]).run();
      return json({ok: true});
    }
    // Demande de gestionnaire : validation (approve=true, le gestionnaire devient aussi membre) ou refus/retrait.
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/boxes\/([\w-]+)\/managers\/([\w-]+)$/))) {
      const b = await r.json(),
        row = await e.DB.prepare("SELECT status FROM box_members WHERE box_id=? AND user_id=? AND role='manager'")
          .bind(m[1], m[2])
          .first();
      if (!row) return json({error: "Demande introuvable."}, 404);
      if (b.approve)
        await e.DB.batch([
          e.DB.prepare(
            "UPDATE box_members SET status='approved',decided_at=CURRENT_TIMESTAMP WHERE box_id=? AND user_id=? AND role='manager'"
          ).bind(m[1], m[2]),
          e.DB.prepare(
            "INSERT INTO box_members(box_id,user_id,role,status,decided_at) VALUES(?,?,'member','approved',CURRENT_TIMESTAMP) ON CONFLICT(box_id,user_id,role) DO UPDATE SET status='approved',decided_at=CURRENT_TIMESTAMP"
          ).bind(m[1], m[2]),
        ]);
      else
        await e.DB.prepare("DELETE FROM box_members WHERE box_id=? AND user_id=? AND role='manager'")
          .bind(m[1], m[2])
          .run();
      return json({ok: true});
    }
    // WOD aléatoire du jour généré tout de suite (sans attendre la tâche planifiée), ou regénéré avec regenerate.
    if (r.method === "POST" && p === "/api/admin/common-wod") {
      const b = await r.json().catch(() => ({})),
        date = localToday();
      if (b.regenerate)
        await e.DB.prepare("UPDATE common_wods SET status='pending' WHERE wod_date=? AND status='ready'")
          .bind(date)
          .run();
      const out = await ensureCommonWod(e, date, true);
      if (out.error) return json({error: out.error}, 502);
      if (out.pending) return json({error: "Génération déjà en cours."}, 409);
      return json({ok: true, wod: commonWodOut(out.wod)});
    }
    // Consommation de l'IA : tokens et coût estimé du jour et du mois (heure de Paris), par fonctionnalité.
    if (r.method === "GET" && p === "/api/admin/ai-usage") {
      const day = localToday(),
        month = day.slice(0, 7),
        rows = await e.DB.prepare(
          "SELECT feature,model,usage_date=? AS today,COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(cached_tokens) AS cached_tokens,SUM(output_tokens) AS output_tokens,SUM(reasoning_tokens) AS reasoning_tokens FROM ai_usage WHERE usage_date>=? AND usage_date<=? GROUP BY feature,model,usage_date=?"
        )
          .bind(day, month + "-01", day, day)
          .all();
      const KEYS = ["calls", "input_tokens", "cached_tokens", "output_tokens", "reasoning_tokens"],
        empty = () => ({...Object.fromEntries(KEYS.map(k => [k, 0])), cost: 0, unpriced: 0}),
        totals = {day: empty(), month: empty()},
        features = {};
      for (const x of rows.results) {
        const cost = aiCost(x.model, x),
          f = (features[x.feature] ??= {feature: x.feature, day: empty(), month: empty()});
        for (const t of x.today ? [totals.day, totals.month, f.day, f.month] : [totals.month, f.month]) {
          for (const k of KEYS) t[k] += x[k] || 0;
          if (cost === null) t.unpriced += x.calls;
          else t.cost += cost;
        }
      }
      return json({
        date: day,
        month,
        ...totals,
        features: AI_FEATURES.map(feature => features[feature] || {feature, day: empty(), month: empty()}).concat(
          Object.values(features).filter(f => !AI_FEATURES.includes(f.feature))
        ),
      });
    }
    return json({error: "Route admin inconnue."}, 404);
  }
  // Préférences du compte : thème (null = thème par défaut de l'administrateur), interface (avancée ou simplifiée) et rappels.
  if (r.method === "GET" && p === "/api/preferences") {
    const st = await userReminders(e, u.id),
      row = await e.DB.prepare(
        "SELECT theme,box_prompt_dismissed,interface_mode,common_wod_enabled FROM users WHERE id=?"
      )
        .bind(u.id)
        .first();
    const simple = row?.interface_mode === "simple" && !(await hasTrainingProgram(e, u.id));
    return json({
      theme: THEMES.includes(row?.theme) ? row.theme : null,
      interface: simple ? "simple" : "advanced",
      common_wod: row?.common_wod_enabled ? 1 : 0,
      box_prompt_dismissed: row?.box_prompt_dismissed ? 1 : 0,
      coach: u.coach_status === "approved" || u.coach_status === "pending" ? u.coach_status : null,
      default_theme: st.defaults.theme,
      reminders: {enabled: st.enabled, days: st.days, hour: st.hour},
      choices: {themes: THEMES, days: REMINDER_DAYS, hours: REMINDER_HOURS},
    });
  }
  if (r.method === "PUT" && p === "/api/preferences") {
    const b = await r.json();
    if (b.interface !== undefined && !INTERFACES.includes(b.interface))
      return json({error: "Interface invalide."}, 400);
    if (b.interface === "simple" && (await hasTrainingProgram(e, u.id)))
      return json({error: "L’interface avancée est requise tant qu’un programme est en cours ou planifié."}, 409);
    if (b.theme !== undefined) {
      if (b.theme !== null && !THEMES.includes(b.theme)) return json({error: "Thème invalide."}, 400);
      await e.DB.prepare("UPDATE users SET theme=? WHERE id=?").bind(b.theme, u.id).run();
    }
    if (b.interface !== undefined)
      await e.DB.prepare("UPDATE users SET interface_mode=? WHERE id=?").bind(b.interface, u.id).run();
    if (b.common_wod !== undefined)
      await e.DB.prepare("UPDATE users SET common_wod_enabled=? WHERE id=?")
        .bind(b.common_wod ? 1 : 0, u.id)
        .run();
    if (b.reminders) {
      const error = await saveReminderSettings(e, u.id, b.reminders);
      if (error) return json({error}, 400);
    }
    if (b.box_prompt_dismissed !== undefined)
      await e.DB.prepare("UPDATE users SET box_prompt_dismissed=? WHERE id=?")
        .bind(b.box_prompt_dismissed ? 1 : 0, u.id)
        .run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/boxes") {
    const [boxes, mine, categories] = await Promise.all([
      e.DB.prepare("SELECT id,name,city FROM boxes ORDER BY name COLLATE NOCASE").all(),
      e.DB.prepare("SELECT box_id,role,status FROM box_members WHERE user_id=?").bind(u.id).all(),
      e.DB.prepare(
        "SELECT c.id,c.box_id,c.name FROM box_categories c JOIN box_members m ON m.box_id=c.box_id AND m.user_id=? AND m.role='member' AND m.status='approved' ORDER BY c.box_id,c.sort_order,c.name"
      )
        .bind(u.id)
        .all(),
    ]);
    // Tâches à valider (icônes rouges en haut) : adhésions des box gérées, demandes de gestionnaire pour un admin.
    const pending = await e.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM box_members r JOIN box_members g ON g.box_id=r.box_id AND g.user_id=? AND g.role='manager' AND g.status='approved' WHERE r.role='member' AND r.status='pending') AS members,(SELECT COUNT(*) FROM box_members WHERE role='manager' AND status='pending') AS managers,(SELECT COUNT(*) FROM users WHERE coach_status='pending' AND is_active=1) AS coaches"
    )
      .bind(u.id)
      .first();
    return json({
      boxes: boxes.results,
      memberships: mine.results,
      categories: categories.results,
      pending: {members: pending.members, managers: admin ? pending.managers : 0, coaches: admin ? pending.coaches : 0},
    });
  }
  // Demande d'adhésion (role=member) ou de gestion (role=manager) : rejouable sans effet (mode hors ligne).
  if ((m = p.match(/^\/api\/boxes\/([\w-]+)\/requests$/)) && (r.method === "POST" || r.method === "DELETE")) {
    const b = await r.json(),
      role = b.role === "manager" ? "manager" : b.role === "member" ? "member" : null;
    if (!role) return json({error: "Type de demande invalide."}, 400);
    if (!(await e.DB.prepare("SELECT 1 FROM boxes WHERE id=?").bind(m[1]).first()))
      return json({error: "Box introuvable."}, 404);
    if (r.method === "DELETE") {
      await e.DB.prepare("DELETE FROM box_members WHERE box_id=? AND user_id=? AND role=?")
        .bind(m[1], u.id, role)
        .run();
      return json({ok: true});
    }
    if (!String(u.first_name || "").trim() || !String(u.last_name || "").trim())
      return json({error: "Renseigne ton prénom et ton nom dans Mon compte avant de rejoindre une box."}, 400);
    await e.DB.prepare("INSERT OR IGNORE INTO box_members(box_id,user_id,role,status) VALUES(?,?,?,'pending')")
      .bind(m[1], u.id, role)
      .run();
    return json({ok: true});
  }
  // WOD des box dont l'utilisateur est membre validé, sur une période.
  if (r.method === "GET" && p === "/api/box-wods") {
    const range = wodRange(r);
    if (!range) return json({error: "Période invalide."}, 400);
    return json({wods: await memberBoxWods(e, u.id, range.from, range.to)});
  }
  // Classement d'un WOD de box : meilleur score de chaque membre actuel de la box, par catégorie.
  if (r.method === "GET" && (m = p.match(/^\/api\/box-wods\/([\w-]+)\/leaderboard$/))) {
    const wod = await e.DB.prepare(
      "SELECT w.id,w.box_id,b.name AS box_name,w.wod_date,w.name,w.content,w.score_type,t.name AS type_name FROM box_wods w JOIN boxes b ON b.id=w.box_id LEFT JOIN wod_types t ON t.id=w.wod_type_id WHERE w.id=? AND w.wod_date<=? AND EXISTS(SELECT 1 FROM box_members m WHERE m.box_id=w.box_id AND m.user_id=? AND m.role='member' AND m.status='approved')"
    )
      .bind(m[1], localToday(), u.id)
      .first();
    if (!wod) return json({error: "WOD de box introuvable."}, 404);
    const [categories, rows] = await Promise.all([
      e.DB.prepare("SELECT id,name FROM box_categories WHERE box_id=? ORDER BY sort_order,name").bind(wod.box_id).all(),
      e.DB.prepare(
        "SELECT s.user_id,u.first_name,u.last_name,s.score_category_id AS category_id," +
          (wod.score_type === "time" ? "MIN" : "MAX") +
          "(s.score_value) AS score FROM training_sessions s JOIN users u ON u.id=s.user_id JOIN box_members m ON m.box_id=? AND m.user_id=s.user_id AND m.role='member' AND m.status='approved' WHERE s.box_wod_id=? AND s.score_value IS NOT NULL AND s.score_category_id IS NOT NULL GROUP BY s.user_id,s.score_category_id"
      )
        .bind(wod.box_id, wod.id)
        .all(),
    ]);
    const better = wod.score_type === "time" ? (a, b) => a.score - b.score : (a, b) => b.score - a.score;
    return json({
      wod,
      categories: categories.results.map(c => ({
        ...c,
        rows: rows.results
          .filter(x => x.category_id === c.id)
          .sort(better)
          .map(x => ({
            first_name: x.first_name,
            last_name: x.last_name,
            score: x.score,
            is_me: x.user_id === u.id ? 1 : 0,
          })),
      })),
    });
  }
  if (p.startsWith("/api/manage/")) {
    // Espace gestionnaire : chaque route vérifie que l'utilisateur gère la box concernée.
    const managed = async boxId => !!boxId && !!(await boxRole(e, u.id, boxId, "manager"));
    const deny = () => json({error: "Box introuvable."}, 404);
    if (r.method === "GET" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)$/))) {
      if (!(await managed(m[1]))) return deny();
      const [box, members, categories, types] = await Promise.all([
        e.DB.prepare("SELECT id,name,city FROM boxes WHERE id=?").bind(m[1]).first(),
        e.DB.prepare(
          "SELECT m.user_id,m.status,m.created_at,u.first_name,u.last_name,u.email,EXISTS(SELECT 1 FROM box_members g WHERE g.box_id=m.box_id AND g.user_id=m.user_id AND g.role='manager' AND g.status='approved') AS is_manager FROM box_members m JOIN users u ON u.id=m.user_id WHERE m.box_id=? AND m.role='member' ORDER BY u.last_name COLLATE NOCASE,u.first_name COLLATE NOCASE"
        )
          .bind(m[1])
          .all(),
        e.DB.prepare("SELECT id,name,sort_order FROM box_categories WHERE box_id=? ORDER BY sort_order,name")
          .bind(m[1])
          .all(),
        e.DB.prepare("SELECT id,name,sort_order FROM wod_types ORDER BY sort_order,name").all(),
      ]);
      return json({box, members: members.results, categories: categories.results, types: types.results});
    }
    // Infos de la box (nom, ville), modifiables par ses gestionnaires.
    if (r.method === "PUT" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)$/))) {
      if (!(await managed(m[1]))) return deny();
      const b = await r.json(),
        name = boxText(b.name, 80),
        city = boxText(b.city, 80);
      if (!name) return json({error: "Nom de la box requis."}, 400);
      try {
        await e.DB.prepare("UPDATE boxes SET name=?,city=? WHERE id=?").bind(name, city, m[1]).run();
      } catch {
        return json({error: "Une box porte déjà ce nom."}, 409);
      }
      return json({ok: true});
    }
    if ((m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/members\/([\w-]+)$/))) {
      if (!(await managed(m[1]))) return deny();
      if (r.method === "PUT") {
        const b = await r.json();
        if (b.approve) {
          const result = await e.DB.prepare(
            "UPDATE box_members SET status='approved',decided_at=CURRENT_TIMESTAMP WHERE box_id=? AND user_id=? AND role='member'"
          )
            .bind(m[1], m[2])
            .run();
          if (!result.meta?.changes) return json({error: "Demande introuvable."}, 404);
          return json({ok: true});
        }
      }
      if (r.method === "PUT" || r.method === "DELETE") {
        if (await boxRole(e, m[2], m[1], "manager"))
          return json({error: "Un gestionnaire de la box ne peut pas être retiré des membres."}, 400);
        await e.DB.prepare("DELETE FROM box_members WHERE box_id=? AND user_id=? AND role='member'")
          .bind(m[1], m[2])
          .run();
        return json({ok: true});
      }
    }
    if ((m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/wods$/)) && (r.method === "GET" || r.method === "POST")) {
      if (!(await managed(m[1]))) return deny();
      if (r.method === "GET") {
        const range = wodRange(r);
        if (!range) return json({error: "Période invalide."}, 400);
        const x = await e.DB.prepare(
          "SELECT w.id,w.box_id,w.wod_date,w.name,w.content,w.blocks,w.score_type,w.wod_type_id AS type_id,t.name AS type_name," +
            WOD_MOVEMENTS +
            " FROM box_wods w LEFT JOIN wod_types t ON t.id=w.wod_type_id WHERE w.box_id=? AND w.wod_date>=? AND w.wod_date<=? ORDER BY w.wod_date,t.sort_order,w.created_at"
        )
          .bind(m[1], range.from, range.to)
          .all();
        return json({wods: withMovementIds(x.results)});
      }
      const b = await r.json(),
        id = clientId(b.client_id) || uid();
      if (await e.DB.prepare("SELECT 1 FROM box_wods WHERE id=?").bind(id).first()) return json({ok: true, id});
      const input = await boxWodInput(e, m[1], b);
      if (input.error) return json({error: input.error}, 400);
      await e.DB.batch([
        e.DB.prepare(
          "INSERT INTO box_wods(id,box_id,wod_date,name,content,blocks,score_type,wod_type_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)"
        ).bind(id, m[1], input.date, input.name, input.content, input.blocks, input.type, input.typeId, u.id),
        ...(await boxWodMovementStatements(e, id, b.catalog_movement_ids)),
      ]);
      return json({ok: true, id});
    }
    if ((m = p.match(/^\/api\/manage\/wods\/([\w-]+)$/)) && (r.method === "PUT" || r.method === "DELETE")) {
      const wod = await e.DB.prepare("SELECT id,box_id FROM box_wods WHERE id=?").bind(m[1]).first();
      if (!wod || !(await managed(wod.box_id))) return json({error: "WOD introuvable."}, 404);
      if (r.method === "DELETE") {
        if (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE box_wod_id=? LIMIT 1").bind(m[1]).first())
          return json({error: "Ce WOD a déjà été réalisé par des membres et ne peut plus être supprimé."}, 409);
        await e.DB.batch([
          e.DB.prepare("DELETE FROM box_wod_movements WHERE box_wod_id=?").bind(m[1]),
          e.DB.prepare("DELETE FROM box_wods WHERE id=?").bind(m[1]),
        ]);
        return json({ok: true});
      }
      const b = await r.json(),
        input = await boxWodInput(e, wod.box_id, b);
      if (input.error) return json({error: input.error}, 400);
      await e.DB.batch([
        e.DB.prepare(
          "UPDATE box_wods SET wod_date=?,name=?,content=?,blocks=?,score_type=?,wod_type_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(input.date, input.name, input.content, input.blocks, input.type, input.typeId, m[1]),
        ...(b.catalog_movement_ids === undefined
          ? []
          : await boxWodMovementStatements(e, m[1], b.catalog_movement_ids)),
      ]);
      return json({ok: true});
    }
    // Listes paramétrables de la box : catégories de score et types de WOD (ajout, ordre, renommage, suppression).
    if (r.method === "POST" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/(categories)$/))) {
      if (!(await managed(m[1]))) return deny();
      const list = BOX_LISTS[m[2]],
        b = await r.json(),
        name = boxText(b.name, 40),
        id = clientId(b.client_id) || uid();
      if (!name) return json({error: list.required}, 400);
      if (
        await e.DB.prepare("SELECT 1 FROM " + list.table + " WHERE id=? AND box_id=?")
          .bind(id, m[1])
          .first()
      )
        return json({ok: true, id});
      try {
        await e.DB.prepare(
          "INSERT INTO " +
            list.table +
            "(id,box_id,name,sort_order) VALUES(?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM " +
            list.table +
            " WHERE box_id=?),0))"
        )
          .bind(id, m[1], name, m[1])
          .run();
      } catch {
        return json({error: list.exists}, 409);
      }
      return json({ok: true, id});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/(categories)\/order$/))) {
      if (!(await managed(m[1]))) return deny();
      const list = BOX_LISTS[m[2]],
        b = await r.json(),
        ids = Array.isArray(b.ids) ? b.ids.map(String) : [],
        current = (
          await e.DB.prepare("SELECT id FROM " + list.table + " WHERE box_id=?")
            .bind(m[1])
            .all()
        ).results;
      if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        current.length !== ids.length ||
        current.some(x => !ids.includes(x.id))
      )
        return json({error: "La liste a changé. Actualise la page."}, 409);
      await e.DB.batch(
        ids.map((id, i) =>
          e.DB.prepare("UPDATE " + list.table + " SET sort_order=? WHERE id=? AND box_id=?").bind(i, id, m[1])
        )
      );
      return json({ok: true});
    }
    if ((m = p.match(/^\/api\/manage\/(categories)\/([\w-]+)$/)) && (r.method === "PUT" || r.method === "DELETE")) {
      const list = BOX_LISTS[m[1]],
        item = await e.DB.prepare("SELECT id,box_id FROM " + list.table + " WHERE id=?")
          .bind(m[2])
          .first();
      if (!item || !(await managed(item.box_id))) return json({error: list.missing}, 404);
      if (r.method === "PUT") {
        const name = boxText((await r.json()).name, 40);
        if (!name) return json({error: list.required}, 400);
        try {
          await e.DB.prepare("UPDATE " + list.table + " SET name=? WHERE id=?")
            .bind(name, m[2])
            .run();
        } catch {
          return json({error: list.exists}, 409);
        }
        return json({ok: true});
      }
      if (
        (
          await e.DB.prepare("SELECT COUNT(*) AS n FROM " + list.table + " WHERE box_id=?")
            .bind(item.box_id)
            .first()
        ).n <= 1
      )
        return json({error: list.last}, 400);
      if (await e.DB.prepare(list.used).bind(m[2]).first()) return json({error: list.usedError}, 409);
      await e.DB.prepare("DELETE FROM " + list.table + " WHERE id=?")
        .bind(m[2])
        .run();
      return json({ok: true});
    }
    return json({error: "Route inconnue."}, 404);
  }
  // Suivi de l'alimentation : analyse d'un repas par IA (jamais enregistrée seule), puis repas enregistrés.
  if (r.method === "GET" && p === "/api/meal-analysis") {
    const used = await e.DB.prepare(
      "SELECT COUNT(*) AS n FROM meal_analyses WHERE user_id=? AND created_at>datetime('now','-1 day')"
    )
      .bind(u.id)
      .first();
    return json({enabled: !!e.OPENAI_API_KEY, remaining: Math.max(0, MEAL_DAILY_LIMIT - (used?.n || 0))});
  }
  if (r.method === "POST" && p === "/api/meal-analysis") {
    if (!e.OPENAI_API_KEY)
      return json({error: "L'analyse par IA n'est pas encore configurée (clé OpenAI manquante)."}, 503);
    const a = mealAnalysisInput(await r.json());
    if (a.error) return json({error: a.error}, 400);
    const used = await e.DB.prepare(
      "SELECT COUNT(*) AS n FROM meal_analyses WHERE user_id=? AND created_at>datetime('now','-1 day')"
    )
      .bind(u.id)
      .first();
    if ((used?.n || 0) >= MEAL_DAILY_LIMIT)
      return json({error: "Limite de " + MEAL_DAILY_LIMIT + " analyses par 24 h atteinte. Réessaie demain."}, 429);
    const out = await analyzeMeal(e, a, u.id);
    if (out.error) return json({error: out.error}, 502);
    // Journal : aliments et précision saisis, sans la photo.
    await e.DB.prepare("INSERT INTO meal_analyses(id,user_id,request,result,prompt_version,model) VALUES(?,?,?,?,?,?)")
      .bind(
        uid(),
        u.id,
        JSON.stringify({items: a.items, known: a.known, note: a.note, photo: !!a.photo}),
        JSON.stringify(out.raw),
        MEAL_PROMPT_VERSION,
        out.model
      )
      .run();
    return json({analysis: out.analysis});
  }
  // Produit emballé par code-barres : fiche Open Food Facts, gardée 30 jours en base.
  if (r.method === "GET" && (m = p.match(/^\/api\/food-products\/([^/]+)$/))) {
    const code = m[1];
    if (!validBarcode(code)) return json({error: "Code-barres invalide (8 à 14 chiffres)."}, 400);
    const cached = await e.DB.prepare("SELECT data FROM food_products WHERE barcode=? AND fetched_at>datetime('now',?)")
      .bind(code, "-" + FOOD_CACHE_DAYS + " days")
      .first();
    if (cached) return json({product: JSON.parse(cached.data)});
    const out = await fetchProduct(e, code);
    if (out.missing) return json({error: "Produit introuvable dans Open Food Facts."}, 404);
    if (out.error) return json({error: out.error}, 502);
    await e.DB.prepare(
      "INSERT INTO food_products(barcode,data,fetched_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(barcode) DO UPDATE SET data=excluded.data,fetched_at=CURRENT_TIMESTAMP"
    )
      .bind(code, JSON.stringify(out.product))
      .run();
    return json({product: out.product});
  }
  if (r.method === "GET" && p === "/api/meals") {
    const q = new URL(r.url).searchParams,
      from = q.get("from") || "",
      to = q.get("to") || "";
    if (!validDate(from) || !validDate(to) || from > to || daysBetween(from, to) > 92)
      return json({error: "Période invalide (93 jours au plus)."}, 400);
    const x = await e.DB.prepare(
      "SELECT id,meal_date,meal_time,title,note,items," +
        Object.keys(NUTRIENTS).join(",") +
        ",confidence,remarks FROM meals WHERE user_id=? AND meal_date BETWEEN ? AND ? ORDER BY meal_date,meal_time,created_at"
    )
      .bind(u.id, from, to)
      .all();
    return json({meals: x.results.map(row => ({...row, items: JSON.parse(row.items || "[]")}))});
  }
  if (
    (r.method === "POST" && p === "/api/meals") ||
    (r.method === "PUT" && (m = p.match(/^\/api\/meals\/([\w-]+)$/)))
  ) {
    const b = await r.json(),
      v = mealInput(b);
    if (v.error) return json({error: v.error}, 400);
    if (v.meal_date > addDays(localToday(), 1)) return json({error: "La date du repas est dans le futur."}, 400);
    const values = [
      v.meal_date,
      v.meal_time,
      v.title,
      v.note,
      JSON.stringify(v.items),
      ...Object.keys(NUTRIENTS).map(k => v.totals[k]),
      v.confidence,
      v.remarks,
    ];
    if (r.method === "POST") {
      // Création rejouable hors ligne : un identifiant déjà enregistré ne crée pas de doublon.
      // Un identifiant déjà pris par un autre compte n'est pas réutilisé.
      const cid = clientId(b.client_id),
        taken = cid ? await e.DB.prepare("SELECT user_id FROM meals WHERE id=?").bind(cid).first() : null;
      if (taken?.user_id === u.id) return json({ok: true, id: cid});
      const id = cid && !taken ? cid : uid();
      await e.DB.prepare(
        "INSERT INTO meals(id,user_id,meal_date,meal_time,title,note,items," +
          Object.keys(NUTRIENTS).join(",") +
          ",confidence,remarks) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
        .bind(id, u.id, ...values)
        .run();
      return json({ok: true, id});
    }
    const res = await e.DB.prepare(
      "UPDATE meals SET meal_date=?,meal_time=?,title=?,note=?,items=?," +
        Object.keys(NUTRIENTS)
          .map(k => k + "=?")
          .join(",") +
        ",confidence=?,remarks=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?"
    )
      .bind(...values, m[1], u.id)
      .run();
    if (!res.meta.changes) return json({error: "Repas introuvable."}, 404);
    return json({ok: true});
  }
  if (r.method === "DELETE" && (m = p.match(/^\/api\/meals\/([\w-]+)$/))) {
    await e.DB.prepare("DELETE FROM meals WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/prs") {
    const x = await e.DB.prepare(PR_SELECT + " ORDER BY pr.record_date,pr.created_at")
      .bind(u.id)
      .all();
    return json({records: x.results.map(withMovementCategory)});
  }
  if (apiUser && r.method !== "GET" && (p === "/api/prs" || PR_ID_PATH.test(p)))
    return writePrByApi(r, e, u.id, PR_ID_PATH.exec(p)?.[1] ?? null);
  if (r.method === "POST" && p === "/api/prs") {
    const b = await r.json(),
      cid = clientId(b.client_id);
    if (cid && (await e.DB.prepare("SELECT 1 FROM personal_records WHERE id=? AND user_id=?").bind(cid, u.id).first()))
      return json({ok: true, id: cid});
    const movementId = String(b.movement_id || ""),
      date = b.record_date,
      value = Number(b.value),
      movement = await movementForPr(e, movementId);
    if (!movement) return json({error: "Mouvement introuvable dans le catalogue."}, 404);
    if (!validDate(date) || date > localToday()) return json({error: "Date de PR invalide."}, 400);
    const validation = validatePr(movement, value, b.rep_count, b);
    if (validation.error) return json({error: validation.error}, 400);
    const id = cid || uid();
    await e.DB.prepare(
      "INSERT INTO personal_records(id,user_id,movement_id,record_date,value,rep_count,fixed_kind,fixed_value) VALUES(?,?,?,?,?,?,?,?)"
    )
      .bind(
        id,
        u.id,
        movementId,
        date,
        value,
        validation.repCount,
        validation.fixedKind ?? null,
        validation.fixedValue ?? null
      )
      .run();
    return json({ok: true, id});
  }
  if (r.method === "PUT" && (m = p.match(PR_ID_PATH))) {
    const b = await r.json(),
      date = b.record_date,
      value = Number(b.value),
      movementId = String(b.movement_id || ""),
      movement = await movementForPr(e, movementId);
    if (!movement) return json({error: "Mouvement introuvable dans le catalogue."}, 404);
    const owned = await e.DB.prepare("SELECT id FROM personal_records WHERE id=? AND user_id=?")
      .bind(m[1], u.id)
      .first();
    if (!owned) return json({error: "PR introuvable."}, 404);
    if (!validDate(date) || date > localToday()) return json({error: "Date de PR invalide."}, 400);
    const validation = validatePr(movement, value, b.rep_count, b);
    if (validation.error) return json({error: validation.error}, 400);
    await e.DB.prepare(
      "UPDATE personal_records SET movement_id=?,record_date=?,value=?,rep_count=?,fixed_kind=?,fixed_value=?,edit_version=lower(hex(randomblob(16))) WHERE id=? AND user_id=?"
    )
      .bind(
        movementId,
        date,
        value,
        validation.repCount,
        validation.fixedKind ?? null,
        validation.fixedValue ?? null,
        m[1],
        u.id
      )
      .run();
    return json({ok: true});
  }
  if (r.method === "DELETE" && (m = p.match(PR_ID_PATH))) {
    const result = await e.DB.prepare("DELETE FROM personal_records WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    if (!result.meta?.changes) return json({error: "PR introuvable."}, 404);
    return json({ok: true});
  }
  if (r.method === "PUT" && p === "/api/profile") {
    const b = await r.json(),
      first = String(b.first_name || "")
        .trim()
        .slice(0, 80),
      last = String(b.last_name || "")
        .trim()
        .slice(0, 80);
    if (!first || !last) return json({error: "Prénom et nom sont obligatoires."}, 400);
    // Profil d'athlète (score de forme) : seulement les champs envoyés, chacun validé.
    const athlete = athleteProfileInput(b);
    if (athlete.error) return json({error: athlete.error}, 400);
    if (athlete.birth_date && athlete.birth_date > addDays(localToday(), -365 * 10))
      return json({error: "Date de naissance invalide."}, 400);
    const next = {
      body_weight_kg: "body_weight_kg" in athlete ? athlete.body_weight_kg : (u.body_weight_kg ?? null),
      birth_date: "birth_date" in athlete ? athlete.birth_date : (u.birth_date ?? null),
      sex: "sex" in athlete ? athlete.sex : u.sex || "",
    };
    await e.DB.prepare("UPDATE users SET first_name=?,last_name=?,body_weight_kg=?,birth_date=?,sex=? WHERE id=?")
      .bind(first, last, next.body_weight_kg, next.birth_date, next.sex, u.id)
      .run();
    return json({
      ok: true,
      user: {id: u.id, email: u.email, first_name: first, last_name: last, ...next},
    });
  }
  // Score de forme (page PR) : 7 piliers calculés à partir du profil, des PR, des séances et des classements de box.
  // Bilan mensuel : mois disponibles (ceux qui ont des séances, 12 au plus), bilan d'un mois, commentaire du coach.
  if (r.method === "GET" && p === "/api/monthly-reports") {
    const x = await e.DB.prepare(
      "SELECT substr(session_date,1,7) AS month,COUNT(*) AS sessions FROM training_sessions WHERE user_id=? GROUP BY month ORDER BY month DESC LIMIT 12"
    )
      .bind(u.id)
      .all();
    return json({months: x.results, current: localToday().slice(0, 7), ai: !!e.OPENAI_API_KEY});
  }
  if (r.method === "GET" && p === "/api/monthly-report") {
    const month = new URL(r.url).searchParams.get("month") || "";
    if (!validMonth(month, localToday())) return json({error: "Mois invalide."}, 400);
    return json(await monthlyReport(e, u.id, month));
  }
  if (r.method === "POST" && p === "/api/monthly-report/comment") {
    if (!e.OPENAI_API_KEY)
      return json({error: "La génération par IA n'est pas encore configurée (clé OpenAI manquante)."}, 503);
    const month = String((await r.json()).month || "");
    if (!validMonth(month, localToday())) return json({error: "Mois invalide."}, 400);
    const used = await e.DB.prepare(
      "SELECT COUNT(*) AS n FROM ai_generations WHERE user_id=? AND created_at>datetime('now','-1 day')"
    )
      .bind(u.id)
      .first();
    if ((used?.n || 0) >= AI_DAILY_LIMIT)
      return json({error: "Limite de " + AI_DAILY_LIMIT + " générations par 24 h atteinte. Réessaie demain."}, 429);
    const report = await monthlyReport(e, u.id, month);
    if (!report.total) return json({error: "Aucune séance ce mois-ci : rien à commenter."}, 400);
    const profile = await e.DB.prepare("SELECT level,goals FROM ai_profiles WHERE user_id=?").bind(u.id).first(),
      out = await reportCoachComment(e, report, profile, u.id);
    if (out.error) return json({error: out.error}, 502);
    await e.DB.batch([
      e.DB.prepare(
        "INSERT INTO monthly_reports(user_id,month,comment) VALUES(?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET comment=excluded.comment,created_at=CURRENT_TIMESTAMP"
      ).bind(u.id, month, out.comment),
      e.DB.prepare(
        "INSERT INTO ai_generations(id,user_id,wod_id,week_start,options,result,prompt_version,model) VALUES(?,?,NULL,?,?,?,?,?)"
      ).bind(
        uid(),
        u.id,
        monthStart(month),
        JSON.stringify({month}),
        JSON.stringify({comment: out.comment}),
        REPORT_PROMPT_VERSION,
        out.model
      ),
    ]);
    return json({ok: true, comment: out.comment});
  }
  // Progression : du lundi de la première séance à aujourd’hui.
  if (r.method === "GET" && p === "/api/progress") {
    const to = localToday(),
      stats = await trainingStats(e, u.id, null, to);
    return json({
      from: stats.weeks[0]?.week_start ?? null,
      to,
      ...stats,
      streak_weeks: activeWeekStreak(stats.weeks),
    });
  }
  if (r.method === "GET" && p === "/api/fitness-score") {
    const today = localToday(),
      from = addDays(today, -55);
    const [records, sessionsRows, names, catalog, boxRows] = await Promise.all([
      e.DB.prepare(
        "SELECT pr.movement_id,pr.value,pr.rep_count,pr.fixed_kind,pr.fixed_value,pr.record_date,pr.created_at,mc.name,mc.measurement_method FROM personal_records pr JOIN movement_catalog mc ON mc.id=pr.movement_id WHERE pr.user_id=? ORDER BY pr.record_date LIMIT 2000"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare("SELECT session_date FROM training_sessions WHERE user_id=? AND session_date BETWEEN ? AND ?")
        .bind(u.id, from, today)
        .all(),
      e.DB.prepare(
        "SELECT mc.name FROM session_catalog_movement_checks c JOIN training_sessions s ON s.id=c.session_id JOIN movement_catalog mc ON mc.id=c.catalog_movement_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ? UNION ALL SELECT pm.name FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id JOIN program_movements pm ON pm.id=c.movement_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ?"
      )
        .bind(u.id, from, today, u.id, from, today)
        .all(),
      e.DB.prepare("SELECT name,measurement_method,category FROM movement_catalog").all(),
      // Mes scores de box des 8 dernières semaines (20 WOD au plus) et ceux des autres membres sur ces WOD.
      e.DB.prepare(
        "SELECT s.box_wod_id,s.user_id,s.score_category_id,s.score_value,w.score_type,w.box_id,(SELECT COUNT(*) FROM box_categories c2 WHERE c2.box_id=w.box_id AND (c2.sort_order<c.sort_order OR (c2.sort_order=c.sort_order AND c2.name<c.name))) AS category_index FROM training_sessions s JOIN box_wods w ON w.id=s.box_wod_id JOIN box_categories c ON c.id=s.score_category_id JOIN box_members m ON m.box_id=w.box_id AND m.user_id=s.user_id AND m.role='member' AND m.status='approved' WHERE s.score_value IS NOT NULL AND s.box_wod_id IN (SELECT box_wod_id FROM training_sessions WHERE user_id=? AND box_wod_id IS NOT NULL AND score_value IS NOT NULL AND session_date BETWEEN ? AND ? ORDER BY session_date DESC LIMIT 20) LIMIT 5000"
      )
        .bind(u.id, from, today)
        .all(),
    ]);
    // Classement : meilleur score de chacun par WOD et par catégorie, puis ma place dans ma catégorie.
    const best = new Map();
    for (const x of boxRows.results) {
      const k = x.box_wod_id + "|" + x.score_category_id + "|" + x.user_id,
        prev = best.get(k),
        better = x.score_type === "time" ? (a, b) => a < b : (a, b) => a > b;
      if (!prev || better(x.score_value, prev.score_value)) best.set(k, x);
    }
    const boxResults = [];
    for (const mine of [...best.values()].filter(x => x.user_id === u.id)) {
      const group = [...best.values()].filter(
          x => x.box_wod_id === mine.box_wod_id && x.score_category_id === mine.score_category_id
        ),
        isBetter = x =>
          mine.score_type === "time" ? x.score_value < mine.score_value : x.score_value > mine.score_value;
      boxResults.push({
        rank: 1 + group.filter(isBetter).length,
        total: group.length,
        categoryIndex: mine.category_index,
      });
    }
    return json(
      computeFitness({
        today,
        profile: {body_weight_kg: u.body_weight_kg, birth_date: u.birth_date, sex: u.sex},
        records: records.results,
        sessionDates: sessionsRows.results.map(x => x.session_date),
        movementNames: names.results.map(x => x.name),
        catalog: catalog.results,
        boxResults,
      })
    );
  }
  if (r.method === "GET" && p === "/api/weekly-flags") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to)) return json({error: "Période invalide."}, 400);
    const x = await e.DB.prepare(
      "SELECT week_start,competition FROM weekly_flags WHERE user_id=? AND week_start>=? AND week_start<=?"
    )
      .bind(u.id, from, to)
      .all();
    return json({flags: x.results});
  }
  if (r.method === "PUT" && p === "/api/weekly-flags") {
    const b = await r.json(),
      week = b.week_start;
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    await e.DB.prepare(
      "INSERT INTO weekly_flags(user_id,week_start,competition,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,week_start) DO UPDATE SET competition=excluded.competition,updated_at=CURRENT_TIMESTAMP"
    )
      .bind(u.id, week, b.competition ? 1 : 0)
      .run();
    return json({ok: true});
  }
  if (apiUser && (p === WEEKLY_PLAN_PATH || p === WEEKLY_PLAN_MOVE_PATH)) return weeklyPlansForApi(r, e, u.id, p);
  if (r.method === "GET" && p === "/api/weekly-plans") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to)) return json({error: "Période invalide."}, 400);
    const x = await e.DB.prepare(
      "SELECT wp.week_start,wp.wod_id,w.name AS wod_name FROM weekly_plans wp JOIN program_wods w ON w.id=wp.wod_id WHERE wp.user_id=? AND wp.week_start>=? AND wp.week_start<=?"
    )
      .bind(u.id, from, to)
      .all();
    return json({plans: x.results});
  }
  if (r.method === "POST" && p === "/api/weekly-plans") {
    const b = await r.json(),
      week = b.week_start,
      wodId = String(b.wod_id || "");
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const row = await e.DB.prepare(
      "SELECT p.user_id,p.start_monday,p.end_monday,f.start_monday AS follow_start,f.end_monday AS follow_end FROM program_wods w JOIN programs p ON p.id=w.program_id" +
        FOLLOW_JOIN +
        "WHERE w.id=? AND w.name<>'__AUTRES__' AND " +
        PROGRAM_ACCESS
    )
      .bind(u.id, wodId, u.id, u.id, u.id)
      .first();
    if (!row) return json({error: "WOD introuvable."}, 404);
    const program = userProgramDates(row, u.id);
    if (week > program.end || week < program.start)
      return json({error: "Ce WOD ne fait pas partie du programme de cette semaine."}, 400);
    await e.DB.prepare("INSERT OR IGNORE INTO weekly_plans(user_id,week_start,wod_id) VALUES(?,?,?)")
      .bind(u.id, week, wodId)
      .run();
    return json({ok: true});
  }
  if (r.method === "DELETE" && p === "/api/weekly-plans") {
    const b = await r.json();
    if (!validDate(b.week_start) || !b.wod_id) return json({error: "Planification invalide."}, 400);
    await e.DB.prepare("DELETE FROM weekly_plans WHERE user_id=? AND week_start=? AND wod_id=?")
      .bind(u.id, b.week_start, String(b.wod_id))
      .run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/program-data") return json(await programData(e, u.id));
  // Programmes publics des autres utilisateurs : recherche par nom du programme ou de l'auteur.
  if (r.method === "GET" && p === "/api/public-programs") {
    const q = boxText(new URL(r.url).searchParams.get("q"), 60).replace(/[\\%_]/g, c => "\\" + c),
      like = "%" + q + "%";
    const x = await e.DB.prepare(
      "SELECT p.id,p.name,p.start_monday,p.end_monday,p.weekly_cardio_target_min,p.weekly_cardio_target_max,a.first_name AS author_first_name,a.last_name AS author_last_name,(SELECT COUNT(*) FROM program_wods w WHERE w.program_id=p.id AND w.name<>'__AUTRES__') AS wods,(SELECT COUNT(*) FROM program_follows f WHERE f.program_id=p.id) AS followers FROM programs p JOIN users a ON a.id=p.user_id WHERE p.is_public=1 AND p.is_default=0 AND p.user_id<>? AND a.is_active=1 AND (p.name LIKE ? ESCAPE '\\' OR (a.first_name || ' ' || a.last_name) LIKE ? ESCAPE '\\') ORDER BY p.end_monday<? ,p.start_monday DESC,p.name LIMIT 50"
    )
      .bind(u.id, like, like, localToday())
      .all();
    return json({programs: x.results});
  }
  // Suivre un programme public (un seul à la fois : remplace le programme suivi) ou arrêter de le suivre. Un programme
  // de coach sans dates déjà suivi (invitation acceptée) peut aussi changer de date de début, pour le même nombre de
  // semaines ; un programme de coach daté garde les dates du coach.
  if (p === "/api/program-follow" && r.method === "PUT") {
    const b = await r.json(),
      program = await e.DB.prepare(
        "SELECT id,name,start_monday,end_monday,coach_mode,coach_weeks FROM programs WHERE id=? AND is_default=0 AND user_id<>? AND (is_public=1 OR (coach_mode='free' AND id IN (SELECT program_id FROM program_follows WHERE user_id=?)))"
      )
        .bind(String(b.program_id || ""), u.id, u.id)
        .first();
    if (!program) return json({error: "Programme introuvable ou privé."}, 404);
    if (program.coach_mode && !isMonday(b.start)) return json({error: "Choisis un lundi pour commencer."}, 400);
    // Dates choisies par l'utilisateur (par défaut : début choisi, ou celui de l'auteur, et même durée).
    const length = daysBetween(program.start_monday, program.end_monday),
      start = b.start === undefined ? program.start_monday : b.start,
      end = program.coach_mode
        ? coachEnd(start, program.coach_weeks)
        : b.end === undefined
          ? validDate(start)
            ? addDays(start, length)
            : ""
          : b.end;
    if (!validDate(start) || !validDate(end) || start > end)
      return json({error: "Vérifie les dates du programme."}, 400);
    if (daysBetween(start, end) > 3 * 366) return json({error: "Un programme dure au plus trois ans."}, 400);
    const overlap = await followOverlap(e, u.id, start, end);
    if (overlap)
      return json(
        {
          error:
            "Un seul programme à la fois : ce programme chevauche ton programme « " +
            overlap.name +
            " ». Modifie ses dates ou supprime-le d’abord.",
        },
        409
      );
    await e.DB.prepare(
      "INSERT INTO program_follows(user_id,program_id,start_monday,end_monday) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET program_id=excluded.program_id,start_monday=excluded.start_monday,end_monday=excluded.end_monday,created_at=CURRENT_TIMESTAMP"
    )
      .bind(u.id, program.id, start, end)
      .run();
    return json({ok: true});
  }
  if (p === "/api/program-follow" && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM program_follows WHERE user_id=?").bind(u.id).run();
    return json({ok: true});
  }
  // Rôle coach : demande (validée par un administrateur), annulation de la demande ou abandon du rôle. Les programmes
  // déjà proposés restent suivis.
  if (p === "/api/coach-request" && r.method === "PUT") {
    const b = await r.json();
    if (b.request) {
      if (!String(u.first_name || "").trim() || !String(u.last_name || "").trim())
        return json(
          {error: "Renseigne ton prénom et ton nom dans ton profil avant de demander le rôle de coach."},
          400
        );
      await e.DB.prepare("UPDATE users SET coach_status='pending' WHERE id=? AND coach_status IS NULL")
        .bind(u.id)
        .run();
    } else await e.DB.prepare("UPDATE users SET coach_status=NULL WHERE id=?").bind(u.id).run();
    return json({ok: true});
  }
  // Invitations d'un programme de coach (vues par le coach) : personnes taguées et réponse.
  m = p.match(/^\/api\/coach-programs\/([\w-]+)\/invites$/);
  if (m && (r.method === "GET" || r.method === "POST")) {
    const program = await e.DB.prepare(
      "SELECT id,name,start_monday,end_monday,coach_mode,coach_weeks FROM programs WHERE id=? AND user_id=? AND coach_mode IS NOT NULL"
    )
      .bind(m[1], u.id)
      .first();
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (r.method === "GET") {
      const x = await e.DB.prepare(
        "SELECT i.id,i.user_id,i.status,us.first_name,us.last_name,EXISTS(SELECT 1 FROM program_follows f WHERE f.user_id=i.user_id AND f.program_id=i.program_id) AS following FROM coach_invites i JOIN users us ON us.id=i.user_id WHERE i.program_id=? AND i.coach_id=? ORDER BY i.created_at,us.first_name COLLATE NOCASE"
      )
        .bind(program.id, u.id)
        .all();
      return json({invites: x.results});
    }
    if (u.coach_status !== "approved") return json({error: "Réservé aux coachs validés par un administrateur."}, 403);
    const b = await r.json(),
      wanted = [...new Set((Array.isArray(b.user_ids) ? b.user_ids : []).map(String))].filter(id => id !== u.id);
    if (!wanted.length) return json({error: "Tague au moins une personne."}, 400);
    if (wanted.length > COACH_INVITE_MAX)
      return json({error: "Au plus " + COACH_INVITE_MAX + " personnes à la fois."}, 400);
    if (program.coach_mode === "dated" && program.end_monday < localToday())
      return json({error: "Ce programme est terminé : change ses dates ou crée-en un autre."}, 400);
    const missing = await coachProgramMissing(e, program);
    if (missing) return json({error: missing}, 400);
    const found = (
      await e.DB.prepare(`SELECT id FROM users WHERE is_active=1 AND id IN (${wanted.map(() => "?").join(",")})`)
        .bind(...wanted)
        .all()
    ).results.map(x => x.id);
    if (!found.length) return json({error: "Personne introuvable."}, 404);
    const now = new Date().toISOString();
    // Une invitation refusée peut être renouvelée ; une invitation en attente ou acceptée ne change pas.
    await e.DB.batch([
      e.DB.prepare("UPDATE programs SET published_at=COALESCE(published_at,?) WHERE id=?").bind(now, program.id),
      ...found.map(id =>
        e.DB.prepare(
          "INSERT INTO coach_invites(id,program_id,coach_id,user_id,status,created_at) VALUES(?,?,?,?,'pending',?) ON CONFLICT(program_id,user_id) DO UPDATE SET status='pending',created_at=excluded.created_at,responded_at=NULL,notified_at=NULL WHERE coach_invites.status='declined'"
        ).bind(uid(), program.id, u.id, id, now)
      ),
    ]);
    const job = notifyCoachInvites(e, u, program.id).catch(err =>
      console.error("myFitFactory push coach", {message: err?.message})
    );
    if (ctx?.waitUntil) ctx.waitUntil(job);
    else await job;
    return json({ok: true, invited: found.length});
  }
  // Le coach retire une invitation encore sans réponse.
  m = p.match(/^\/api\/coach-invites\/([\w-]+)$/);
  if (m && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM coach_invites WHERE id=? AND coach_id=? AND status='pending'")
      .bind(m[1], u.id)
      .run();
    return json({ok: true});
  }
  // Programmes de coach proposés à l'utilisateur, en attente de sa réponse (pastille rouge de l'onglet Programmes).
  if (r.method === "GET" && p === "/api/coach-invites") {
    const x = await e.DB.prepare(
      "SELECT i.id,i.program_id,p.name,p.coach_mode,p.coach_weeks,p.weekly_cardio_target_min,p.weekly_cardio_target_max,CASE WHEN p.coach_mode='dated' THEN p.start_monday END AS start_monday,CASE WHEN p.coach_mode='dated' THEN p.end_monday END AS end_monday,c.first_name,c.last_name,(SELECT COUNT(*) FROM program_wods w WHERE w.program_id=p.id AND w.name<>'__AUTRES__') AS wods FROM coach_invites i JOIN programs p ON p.id=i.program_id JOIN users c ON c.id=i.coach_id WHERE i.user_id=? AND i.status='pending' ORDER BY i.created_at DESC LIMIT 20"
    )
      .bind(u.id)
      .all();
    return json({invites: x.results});
  }
  // Réponse à une invitation : refus, ou acceptation (le programme devient le programme suivi, comme un programme
  // public choisi, et remplace le programme suivi jusque-là ; sans dates, l'utilisateur choisit son lundi de départ).
  m = p.match(/^\/api\/coach-invites\/([\w-]+)\/(accept|decline)$/);
  if (m && r.method === "POST") {
    const invite = await e.DB.prepare(
      "SELECT i.id,p.id AS program_id,p.start_monday,p.end_monday,p.coach_mode,p.coach_weeks FROM coach_invites i JOIN programs p ON p.id=i.program_id WHERE i.id=? AND i.user_id=? AND i.status='pending'"
    )
      .bind(m[1], u.id)
      .first();
    if (!invite) return json({error: "Invitation introuvable ou déjà traitée."}, 404);
    const now = new Date().toISOString();
    if (m[2] === "decline") {
      await e.DB.prepare("UPDATE coach_invites SET status='declined',responded_at=? WHERE id=? AND status='pending'")
        .bind(now, invite.id)
        .run();
      return json({ok: true});
    }
    const b = await r.json().catch(() => ({})),
      dated = invite.coach_mode === "dated",
      start = dated ? invite.start_monday : String(b.start || ""),
      end = dated ? invite.end_monday : isMonday(start) ? coachEnd(start, invite.coach_weeks) : "";
    if (!dated && (!isMonday(start) || start < mondayOfDate(localToday())))
      return json({error: "Choisis un lundi, à partir de cette semaine, pour commencer le programme."}, 400);
    if (end < localToday()) return json({error: "Ce programme est déjà terminé."}, 400);
    const overlap = await followOverlap(e, u.id, start, end);
    if (overlap)
      return json(
        {
          error:
            "Un seul programme à la fois : ce programme chevauche ton programme « " +
            overlap.name +
            " ». Modifie ses dates ou supprime-le d’abord.",
        },
        409
      );
    await e.DB.batch([
      e.DB.prepare(
        "INSERT INTO program_follows(user_id,program_id,start_monday,end_monday) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET program_id=excluded.program_id,start_monday=excluded.start_monday,end_monday=excluded.end_monday,created_at=CURRENT_TIMESTAMP"
      ).bind(u.id, invite.program_id, start, end),
      e.DB.prepare("UPDATE coach_invites SET status='accepted',responded_at=? WHERE id=? AND status='pending'").bind(
        now,
        invite.id
      ),
    ]);
    return json({ok: true, start, end});
  }
  if (r.method === "GET" && p === "/api/programs") {
    const x = await e.DB.prepare("SELECT * FROM programs WHERE user_id=? ORDER BY is_default ASC,start_monday DESC")
      .bind(u.id)
      .all();
    return json({programs: x.results});
  }
  if (r.method === "POST" && p === "/api/programs") {
    const b = await r.json();
    const cardio = programCardioTargets(b);
    if (cardio.error) return json({error: cardio.error}, 400);
    if (b.coach) {
      if (u.coach_status !== "approved") return json({error: "Réservé aux coachs validés par un administrateur."}, 403);
      const v = coachProgramInput(b);
      if (v.error) return json({error: v.error}, 400);
      const id = uid();
      await e.DB.prepare(
        "INSERT INTO programs(id,user_id,name,start_monday,end_monday,is_default,is_public,coach_mode,coach_weeks,weekly_cardio_target_min,weekly_cardio_target_max,coaching_instructions) VALUES(?,?,?,?,?,0,0,?,?,?,?,?)"
      )
        .bind(id, u.id, v.name, v.start, v.end, v.mode, v.weeks, ...cardio.values, cardio.instructions)
        .run();
      return json({ok: true, id});
    }
    const name = String(b.name || "")
        .trim()
        .slice(0, 100),
      isDefault = !!b.is_default,
      start = isDefault ? "1970-01-01" : b.start,
      end = isDefault ? "2100-12-31" : b.end;
    if (!name || !validDate(start) || !validDate(end) || start > end)
      return json({error: "Vérifie le nom et les dates."}, 400);
    if (!isDefault) {
      const overlap = await e.DB.prepare(
        "SELECT id FROM programs WHERE user_id=? AND is_default=0 AND coach_mode IS NULL AND NOT(end_monday<? OR start_monday>?)"
      )
        .bind(u.id, start, end)
        .first();
      if (overlap) return json({error: "Les dates chevauchent un autre programme."}, 409);
      const followed = await followedOverlap(e, u.id, start, end);
      if (followed) return json({error: "Les dates chevauchent le programme suivi « " + followed.name + " »."}, 409);
    }
    const id = uid();
    if (isDefault)
      await e.DB.batch([
        e.DB.prepare("UPDATE programs SET is_default=0 WHERE user_id=? AND is_default=1").bind(u.id),
        e.DB.prepare(
          "INSERT INTO programs(id,user_id,name,start_monday,end_monday,is_default,weekly_cardio_target_min,weekly_cardio_target_max,coaching_instructions) VALUES(?,?,?,?,?,1,?,?,?)"
        ).bind(id, u.id, name, start, end, ...cardio.values, cardio.instructions),
      ]);
    else
      await e.DB.prepare(
        "INSERT INTO programs(id,user_id,name,start_monday,end_monday,is_default,is_public,weekly_cardio_target_min,weekly_cardio_target_max,coaching_instructions) VALUES(?,?,?,?,?,0,?,?,?,?)"
      )
        .bind(id, u.id, name, start, end, b.is_public ? 1 : 0, ...cardio.values, cardio.instructions)
        .run();
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/movements$/);
  if (m && r.method === "GET") {
    const x = await e.DB.prepare(
      "SELECT * FROM program_movements WHERE program_id=? AND user_id=? ORDER BY sort_order,created_at"
    )
      .bind(m[1], u.id)
      .all();
    return json({movements: x.results});
  }
  if (m && r.method === "POST") {
    const b = await r.json(),
      pid = m[1],
      ok = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!ok) return json({error: "Programme introuvable."}, 404);
    const item = await e.DB.prepare("SELECT id,name FROM movement_catalog WHERE id=?")
      .bind(String(b.catalog_movement_id || ""))
      .first();
    if (!item) return json({error: "Sélectionne un mouvement du catalogue."}, 400);
    const catalogId = item.id,
      name = item.name;
    const id = uid();
    try {
      await e.DB.prepare(
        "INSERT INTO program_movements(id,program_id,user_id,name,sort_order,catalog_movement_id) VALUES(?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM program_movements WHERE program_id=?),0),?)"
      )
        .bind(id, pid, u.id, name, pid, catalogId)
        .run();
    } catch {
      return json({error: "Ce mouvement existe déjà dans le programme."}, 409);
    }
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/movements\/([\w-]+)$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 80);
    if (!name) return json({error: "Libellé du mouvement requis."}, 400);
    try {
      const result = await e.DB.prepare("UPDATE program_movements SET name=? WHERE id=? AND user_id=?")
        .bind(name, m[1], u.id)
        .run();
      if (!result.meta?.changes) return json({error: "Mouvement introuvable."}, 404);
    } catch {
      return json({error: "Ce mouvement existe déjà dans le programme."}, 409);
    }
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM program_movements WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/movement-checks") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to) || from > to)
      return json({error: "Une période de dates est obligatoire."}, 400);
    const x = await e.DB.prepare(
      "SELECT c.session_id,c.movement_id FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
    )
      .bind(u.id, from, to)
      .all();
    return json({checks: x.results});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/order$/);
  if (m && r.method === "PUT") {
    const pid = m[1],
      b = await r.json(),
      kind = b.kind,
      ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!["wod", "movement"].includes(kind) || !ids.length || new Set(ids).size !== ids.length)
      return json({error: "Ordre invalide."}, 400);
    const table = kind === "wod" ? "program_wods" : "program_movements";
    const owned = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!owned) return json({error: "Programme introuvable."}, 404);
    const current = await e.DB.prepare(
      "SELECT id FROM " + table + " WHERE program_id=? AND user_id=? ORDER BY sort_order,created_at"
    )
      .bind(pid, u.id)
      .all();
    if (current.results.length !== ids.length || current.results.some(x => !ids.includes(x.id)))
      return json({error: "La liste a changé. Actualise la page."}, 409);
    await e.DB.batch(
      ids.map((id, i) =>
        e.DB.prepare("UPDATE " + table + " SET sort_order=? WHERE id=? AND program_id=? AND user_id=?").bind(
          i,
          id,
          pid,
          u.id
        )
      )
    );
    return json({ok: true});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)$/);
  // Après la publication d’un programme de coach, sa durée et ses dates sont figées.
  const coachRow =
    m && r.method !== "GET"
      ? await e.DB.prepare(
          "SELECT id,coach_mode,coach_weeks,published_at,weekly_cardio_target_min,weekly_cardio_target_max,(SELECT COUNT(*) FROM program_follows f WHERE f.program_id=programs.id) AS followers FROM programs WHERE id=? AND user_id=? AND coach_mode IS NOT NULL"
        )
          .bind(m[1], u.id)
          .first()
      : null;
  if (coachRow && r.method === "PUT") {
    const b = await r.json(),
      cardio = programCardioTargets(b, coachRow);
    if (cardio.error) return json({error: cardio.error}, 400);
    if (coachRow.published_at) {
      const name = String(b.name || "")
        .trim()
        .slice(0, 100);
      if (!name) return json({error: "Nom du programme requis."}, 400);
      return saveProgramChanges(e.DB, [
        e.DB.prepare("UPDATE programs SET name=?" + cardio.sql + " WHERE id=? AND user_id=?").bind(
          name,
          ...cardio.args,
          m[1],
          u.id
        ),
      ]);
    }
    const v = coachProgramInput(b);
    if (v.error) return json({error: v.error}, 400);
    // Changer de semaine 1 (dates ajoutées, retirées ou déplacées) décale tout le contenu déjà écrit : les semaines
    // sont réécrites (supprimées puis recréées) pour ne jamais heurter la clé (WOD, semaine) pendant le décalage.
    const old = await e.DB.prepare("SELECT start_monday FROM programs WHERE id=?").bind(m[1]).first(),
      shift = daysBetween(old.start_monday, v.start),
      written = shift
        ? (
            await e.DB.prepare(
              "SELECT x.* FROM weekly_wod_programming x JOIN program_wods w ON w.id=x.wod_id WHERE w.program_id=?"
            )
              .bind(m[1])
              .all()
          ).results
        : [];
    return saveProgramChanges(e.DB, [
      e.DB.prepare(
        "UPDATE programs SET name=?,start_monday=?,end_monday=?,coach_mode=?,coach_weeks=?" +
          cardio.sql +
          " WHERE id=? AND user_id=?"
      ).bind(v.name, v.start, v.end, v.mode, v.weeks, ...cardio.args, m[1], u.id),
      ...(written.length
        ? [
            e.DB.prepare(
              "DELETE FROM weekly_wod_programming WHERE wod_id IN (SELECT id FROM program_wods WHERE program_id=?)"
            ).bind(m[1]),
            ...written.map(x =>
              e.DB.prepare(
                "INSERT INTO weekly_wod_programming(wod_id,user_id,week_start,content,blocks,updated_at) VALUES(?,?,?,?,?,?)"
              ).bind(x.wod_id, x.user_id, addDays(x.week_start, shift), x.content, x.blocks ?? null, x.updated_at)
            ),
          ]
        : []),
    ]);
  }
  if (coachRow && r.method === "DELETE" && coachRow.followers)
    return json({error: "Ce programme est suivi : il ne peut plus être supprimé."}, 409);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      isDefault = !!b.is_default,
      start = isDefault ? "1970-01-01" : b.start,
      end = isDefault ? "2100-12-31" : b.end;
    if (!name || !validDate(start) || !validDate(end) || start > end)
      return json({error: "Vérifie le nom et les dates."}, 400);
    const exists = await e.DB.prepare(
      "SELECT weekly_cardio_target_min,weekly_cardio_target_max FROM programs WHERE id=? AND user_id=?"
    )
      .bind(m[1], u.id)
      .first();
    if (!exists) return json({error: "Programme introuvable."}, 404);
    const cardio = programCardioTargets(b, exists);
    if (cardio.error) return json({error: cardio.error}, 400);
    if (!isDefault) {
      const overlap = await e.DB.prepare(
        "SELECT id FROM programs WHERE user_id=? AND id<>? AND is_default=0 AND coach_mode IS NULL AND NOT(end_monday<? OR start_monday>?)"
      )
        .bind(u.id, m[1], start, end)
        .first();
      if (overlap) return json({error: "Les dates chevauchent un autre programme."}, 409);
      const followed = await followedOverlap(e, u.id, start, end);
      if (followed) return json({error: "Les dates chevauchent le programme suivi « " + followed.name + " »."}, 409);
    }
    // Le marqueur « par défaut » (programme technique « Hors programme ») n'est déplacé que si ce programme le demande :
    // modifier un programme ordinaire ne doit jamais retirer le marqueur du programme technique.
    return saveProgramChanges(e.DB, [
      ...(isDefault
        ? [e.DB.prepare("UPDATE programs SET is_default=0 WHERE user_id=? AND is_default=1 AND id<>?").bind(u.id, m[1])]
        : []),
      e.DB.prepare(
        "UPDATE programs SET name=?,start_monday=?,end_monday=?,is_default=?,is_public=?" +
          cardio.sql +
          " WHERE id=? AND user_id=?"
      ).bind(name, start, end, isDefault ? 1 : 0, !isDefault && b.is_public ? 1 : 0, ...cardio.args, m[1], u.id),
    ]);
  }
  if (m && r.method === "DELETE") {
    // Toutes les séances comptent, y compris celles des utilisateurs qui suivent ce programme.
    const completed = await e.DB.prepare(
      "SELECT 1 FROM training_sessions s JOIN programs p ON p.id=s.program_id WHERE s.program_id=? AND p.user_id=? LIMIT 1"
    )
      .bind(m[1], u.id)
      .first();
    if (completed) return json({error: "Ce programme a déjà une séance réalisée et ne peut plus être supprimé."}, 409);
    await e.DB.prepare("DELETE FROM programs WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/weekly-themes$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      week = b.week_start,
      wod1 = String(b.wod1_theme || "").slice(0, 2000),
      wod2 = String(b.wod2_theme || "").slice(0, 2000);
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const program = await e.DB.prepare("SELECT id,start_monday,end_monday FROM programs WHERE id=? AND user_id=?")
      .bind(m[1], u.id)
      .first();
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (addDays(week, 6) < program.start_monday || week > program.end_monday)
      return json({error: "Cette semaine est hors période du programme."}, 400);
    await e.DB.prepare(
      "INSERT INTO weekly_wod_themes(program_id,user_id,week_start,wod1_theme,wod2_theme,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(program_id,week_start) DO UPDATE SET wod1_theme=excluded.wod1_theme,wod2_theme=excluded.wod2_theme,updated_at=CURRENT_TIMESTAMP"
    )
      .bind(m[1], u.id, week, wod1, wod2)
      .run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/wods$/);
  if (m && r.method === "GET") {
    const x = await e.DB.prepare(
      "SELECT w.*," +
        PROGRAM_WOD_MOVEMENTS +
        " FROM program_wods w WHERE w.program_id=? AND w.user_id=? ORDER BY w.sort_order,w.created_at"
    )
      .bind(m[1], u.id)
      .all();
    return json({wods: withMovementIds(x.results)});
  }
  if (m && r.method === "POST") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      comment = String(b.planned_comment || "").slice(0, 3000),
      activity = await e.DB.prepare(
        "SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1"
      )
        .bind(b.activity_id, adminEmail)
        .first(),
      duration = Number(b.duration_minutes),
      scoreType = b.score_type ?? "none";
    if (!PROGRAM_SCORE_TYPES.includes(scoreType)) return json({error: "Type de score invalide."}, 400);
    if (!activity || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Sport ou durée invalide."}, 400);
    if (!name) return json({error: "Nom du WOD requis."}, 400);
    const wodType = await wodTypeOf(e, b.type_id);
    if (wodType.error) return json({error: wodType.error}, 400);
    const pid = m[1],
      ok = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!ok) return json({error: "Programme introuvable."}, 404);
    if (await publishedCoachProgram(e, pid))
      return json({error: "Programme déjà proposé à des utilisateurs : on ne peut plus y ajouter de WOD."}, 409);
    const id = uid();
    try {
      await e.DB.prepare(
        "INSERT INTO program_wods(id,program_id,user_id,name,planned_comment,activity_id,duration_minutes,is_tracked,score_type,type_id,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM program_wods WHERE program_id=?),0))"
      )
        .bind(id, pid, u.id, name, comment, b.activity_id, duration, b.is_tracked ? 1 : 0, scoreType, wodType.id, pid)
        .run();
    } catch {
      return json({error: "Un WOD porte déjà ce nom dans ce programme."}, 409);
    }
    if (Array.isArray(b.catalog_movement_ids))
      await e.DB.batch(await programWodMovementStatements(e, id, b.catalog_movement_ids));
    return json({ok: true, id});
  }
  // Génération de WOD par IA : profil d'entraînement et génération du contenu d'un WOD pour une semaine.
  if (p === "/api/ai-profile" && r.method === "GET") {
    const [profile, used] = await Promise.all([
      e.DB.prepare("SELECT level,goals,equipment,constraints FROM ai_profiles WHERE user_id=?").bind(u.id).first(),
      e.DB.prepare("SELECT COUNT(*) AS n FROM ai_generations WHERE user_id=? AND created_at>datetime('now','-1 day')")
        .bind(u.id)
        .first(),
    ]);
    return json({
      enabled: !!e.OPENAI_API_KEY,
      profile: profile || {level: "", goals: "", equipment: "", constraints: ""},
      remaining: Math.max(0, AI_DAILY_LIMIT - (used?.n || 0)),
    });
  }
  if (p === "/api/ai-profile" && r.method === "PUT") {
    const v = aiProfileInput(await r.json());
    if (v.error) return json({error: v.error}, 400);
    await e.DB.prepare(
      "INSERT INTO ai_profiles(user_id,level,goals,equipment,constraints,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET level=excluded.level,goals=excluded.goals,equipment=excluded.equipment,constraints=excluded.constraints,updated_at=CURRENT_TIMESTAMP"
    )
      .bind(u.id, v.level, v.goals, v.equipment, v.constraints)
      .run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/wods\/([\w-]+)\/generate$/);
  if (m && r.method === "POST") {
    if (!e.OPENAI_API_KEY)
      return json({error: "La génération par IA n'est pas encore configurée (clé OpenAI manquante)."}, 503);
    const b = await r.json(),
      week = String(b.week_start || ""),
      options = aiOptionsInput(b);
    if (options.error) return json({error: options.error}, 400);
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const wod = await programWodState(e.DB, u.id, m[1], week);
    if (!wod) return json({error: "WOD introuvable."}, 404);
    if (addDays(week, 6) < wod.start_monday || week > wod.end_monday)
      return json({error: "Cette semaine est hors période du programme."}, 400);
    if (b.edit_version !== undefined && b.edit_version !== wod.edit_version) return json({error: WOD_CONFLICT}, 412);
    const used = await e.DB.prepare(
      "SELECT COUNT(*) AS n FROM ai_generations WHERE user_id=? AND created_at>datetime('now','-1 day')"
    )
      .bind(u.id)
      .first();
    if ((used?.n || 0) >= AI_DAILY_LIMIT)
      return json({error: "Limite de " + AI_DAILY_LIMIT + " générations par 24 h atteinte. Réessaie demain."}, 429);
    const [profile, records, catalog, focus, planned, done] = await Promise.all([
      e.DB.prepare("SELECT level,goals,equipment,constraints FROM ai_profiles WHERE user_id=?").bind(u.id).first(),
      e.DB.prepare(AI_RECORDS_QUERY).bind(u.id).all(),
      e.DB.prepare(MOVEMENT_CATALOG_QUERY).all(),
      e.DB.prepare("SELECT name FROM program_movements WHERE program_id=? AND user_id=? ORDER BY sort_order")
        .bind(wod.program_id, u.id)
        .all(),
      e.DB.prepare(
        "SELECT x.week_start,w.name,x.content FROM weekly_wod_programming x JOIN program_wods w ON w.id=x.wod_id WHERE w.program_id=? AND w.user_id=? AND x.week_start BETWEEN ? AND ? AND x.content<>'' AND NOT (x.wod_id=? AND x.week_start=?) ORDER BY x.week_start,w.sort_order LIMIT 20"
      )
        .bind(wod.program_id, u.id, addDays(week, -14), week, wod.id, week)
        .all(),
      e.DB.prepare(
        "SELECT s.session_date,COALESCE(bw.name,CASE WHEN w.name='__AUTRES__' THEN 'Autres' ELSE w.name END) AS name,COALESCE(NULLIF(s.actual_comment,''),bw.content,'') AS comment FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id LEFT JOIN box_wods bw ON bw.id=s.box_wod_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ? ORDER BY s.session_date LIMIT 20"
      )
        .bind(u.id, addDays(week, -14), addDays(week, 6))
        .all(),
    ]);
    const first = mondayOfDate(wod.start_monday);
    const prompt = buildPrompt({
      profile,
      options,
      records: records.results,
      catalog: catalog.results,
      focus: focus.results.map(x => x.name),
      program: {name: wod.program_name, coaching_instructions: wod.coaching_instructions},
      wod,
      weekIndex: daysBetween(first, week) / 7 + 1,
      weekCount: daysBetween(first, mondayOfDate(wod.end_monday)) / 7 + 1,
      weekLabel: frenchDate(week) + " au " + frenchDate(addDays(week, 6)),
      planned: planned.results.map(x => ({week: frenchDate(x.week_start), name: x.name, content: x.content})),
      sessions: done.results.map(x => ({date: frenchDate(x.session_date), name: x.name, comment: x.comment})),
    });
    const out = await callOpenAI(e, prompt, u.id);
    if (out.error) return json({error: out.error}, 502);
    const content = wodToText(out.wod, 2000, false),
      blocks = JSON.stringify(wodBlocks(out.wod));
    const version = uid().replaceAll("-", ""),
      statements = generatedProgramStatements(e.DB, {
        userId: u.id,
        wodId: wod.id,
        programId: wod.program_id,
        week,
        end: addDays(week, 6),
        today: localToday(),
        content,
        blocks,
        expected: wod.edit_version,
        version,
      }),
      [, saved] = await e.DB.batch([
        ...statements,
        e.DB.prepare(
          "INSERT INTO ai_generations(id,user_id,wod_id,week_start,options,result,prompt_version,model) VALUES(?,?,(SELECT id FROM program_wods WHERE id=? AND user_id=?),?,?,?,?,?)"
        ).bind(
          uid(),
          u.id,
          wod.id,
          u.id,
          week,
          JSON.stringify(options),
          JSON.stringify(out.wod),
          AI_PROMPT_VERSION,
          out.model
        ),
      ]);
    if (!saved.meta.changes)
      return json({error: "La programmation a changé. Actualise le WOD avant de le régénérer."}, 412);
    return json({ok: true, content, wod: out.wod});
  }
  // WOD du jour : génération par IA (aujourd'hui ou demain, heure de Paris), remplacement (« Autre WOD ») tant
  // qu'aucune séance n'y est rattachée, suppression.
  if (p === "/api/daily-wods" && r.method === "POST") {
    if (!e.OPENAI_API_KEY)
      return json({error: "La génération par IA n'est pas encore configurée (clé OpenAI manquante)."}, 503);
    const b = await r.json(),
      date = String(b.wod_date || ""),
      options = dailyOptionsInput(b),
      now = localToday();
    if (options.error) return json({error: options.error}, 400);
    const replaceId = b.replace_id ? String(b.replace_id) : null;
    if (!exactCalendarDate(date) || ((!b.draft || !replaceId) && (date < now || date > addDays(now, 1))))
      return json({error: "Le WOD du jour se génère pour aujourd'hui ou demain."}, 400);
    let replaceVersion = null,
      replaceScore = null;
    if (replaceId) {
      const old = await e.DB.prepare(
        "SELECT id,edit_version,score_type,wod_date FROM daily_wods WHERE id=? AND user_id=? AND common_wod_id IS NULL AND benchmark_id IS NULL"
      )
        .bind(replaceId, u.id)
        .first();
      if (!old) return json({error: "WOD du jour introuvable."}, 404);
      if (b.draft && old.wod_date !== date && (date < now || date > addDays(now, 1)))
        return json({error: "Date du WOD personnel non autorisée."}, 400);
      replaceVersion = old.edit_version;
      replaceScore = old.score_type;
      if (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE daily_wod_id=? LIMIT 1").bind(replaceId).first())
        return json({error: "Une séance est déjà enregistrée sur ce WOD."}, 409);
    }
    const used = await e.DB.prepare(
      "SELECT COUNT(*) AS n,SUM(prompt_version GLOB 'wod-du-jour-v*') AS daily FROM ai_generations WHERE user_id=? AND created_at>datetime('now','-1 day')"
    )
      .bind(u.id)
      .first();
    if ((used?.n || 0) >= AI_DAILY_LIMIT)
      return json({error: "Limite de " + AI_DAILY_LIMIT + " générations par 24 h atteinte. Réessaie demain."}, 429);
    if ((used?.daily || 0) >= DAILY_WOD_LIMIT)
      return json({error: "Limite de " + DAILY_WOD_LIMIT + " WOD du jour par 24 h atteinte. Réessaie demain."}, 429);
    const [profile, records, catalog, done, recent] = await Promise.all([
      e.DB.prepare("SELECT level,goals,equipment,constraints FROM ai_profiles WHERE user_id=?").bind(u.id).first(),
      e.DB.prepare(AI_RECORDS_QUERY).bind(u.id).all(),
      e.DB.prepare(MOVEMENT_CATALOG_QUERY).all(),
      e.DB.prepare(
        "SELECT s.session_date,COALESCE(bw.name,dw.title,CASE WHEN w.name='__AUTRES__' THEN 'Autres' ELSE w.name END) AS name,COALESCE(NULLIF(s.actual_comment,''),bw.content,dw.content,'') AS comment FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id LEFT JOIN box_wods bw ON bw.id=s.box_wod_id LEFT JOIN daily_wods dw ON dw.id=s.daily_wod_id AND dw.user_id=s.user_id WHERE s.user_id=? AND s.session_date BETWEEN ? AND ? ORDER BY s.session_date LIMIT 20"
      )
        .bind(u.id, addDays(date, -14), date)
        .all(),
      e.DB.prepare(
        "SELECT wod_date,title FROM daily_wods WHERE user_id=? AND wod_date BETWEEN ? AND ? ORDER BY wod_date LIMIT 14"
      )
        .bind(u.id, addDays(date, -14), date)
        .all(),
    ]);
    const prompt = buildDailyPrompt({
      profile,
      options,
      records: records.results,
      catalog: catalog.results,
      dateLabel: frenchDate(date),
      sessions: done.results.map(x => ({date: frenchDate(x.session_date), name: x.name, comment: x.comment})),
      recent: recent.results.map(x => ({date: frenchDate(x.wod_date), title: x.title})),
    });
    const out = await callOpenAIDaily(e, prompt, u.id);
    if (out.error) return json({error: out.error}, 502);
    const blocs = options.blocks
      ? Object.keys(options.blocks)
          .filter(k => options.blocks[k])
          .map(k => out.wod.blocs.find(b => b.type === k))
      : out.wod.blocs;
    if (blocs.some(b => !b)) return json({error: "L’IA n’a pas généré tous les blocs demandés. Réessaie."}, 502);
    const wod = {...out.wod, blocs},
      title =
        String(wod.titre || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120) || "WOD du jour";
    // Brouillon : l'IA pré-remplit le formulaire de saisie manuelle (rien n'est enregistré, sauf le suivi de la
    // génération) ; chaque bloc va dans la case correspondante, l'objectif à la fin du Metcon.
    if (b.draft) {
      const keys = {
          echauffement: "warmup",
          technique: "technique",
          force: "strength",
          metcon: "metcon",
          retour_au_calme: "finisher",
        },
        parts = wodBlocks(wod),
        blocks = {};
      for (const part of parts) if (keys[part.type]) blocks[keys[part.type]] = part.text;
      const goal = parts.find(x => x.type === "objectif")?.text;
      if (goal) blocks.metcon = [blocks.metcon, "🏁 Objectif : " + goal].filter(Boolean).join("\n");
      await e.DB.prepare(
        "INSERT INTO ai_generations(id,user_id,wod_id,week_start,options,result,prompt_version,model) VALUES(?,?,NULL,?,?,?,?,?)"
      )
        .bind(
          uid(),
          u.id,
          mondayOfDate(date),
          JSON.stringify(options),
          JSON.stringify(out.wod),
          DAILY_PROMPT_VERSION,
          out.model
        )
        .run();
      return json({ok: true, draft: {name: title, blocks, movement_ids: dailyMovementIds(wod, catalog.results)}});
    }
    const row = {
      id: replaceId || uid(),
      wod_date: date,
      title,
      content: dailyWodToText(wod, title),
      chrono: JSON.stringify(blocs.some(b => b.type === "metcon") ? dailyChrono(wod.chrono) : null),
      movement_ids: JSON.stringify(dailyMovementIds(wod, catalog.results)),
      blocks: JSON.stringify(wodBlocks(wod)),
    };
    const [saved] = await e.DB.batch([
      saveFreeWodStatement(
        e.DB,
        {...row, options: JSON.stringify(options), score_type: replaceScore},
        u.id,
        uid().replaceAll("-", ""),
        replaceVersion
      ),
      e.DB.prepare(
        "INSERT INTO ai_generations(id,user_id,wod_id,week_start,options,result,prompt_version,model) VALUES(?,?,NULL,?,?,?,?,?)"
      ).bind(
        uid(),
        u.id,
        mondayOfDate(date),
        JSON.stringify(options),
        JSON.stringify(out.wod),
        DAILY_PROMPT_VERSION,
        out.model
      ),
    ]);
    if (!saved.meta.changes) return json({error: WOD_CONFLICT}, 412);
    return json({ok: true, wod: dailyWodOut(row)});
  }
  // WOD de référence (benchmarks) : liste (gardée sur le téléphone pour le tirage hors ligne), WOD du jour tiré de
  // la liste (sans IA), résultats suivis dans la page PR.
  if (p === "/api/benchmarks" && r.method === "GET") return json({benchmarks: BENCHMARKS.map(benchmarkOut)});
  // WOD aléatoire du jour : le WOD (s'il est prêt), mon WOD du jour qui le reprend (« Je le fais ») et le nombre de
  // participants (séances enregistrées).
  if (p === "/api/common-wod" && r.method === "GET") {
    // Option désactivée (par défaut) : ni rubrique, ni notification.
    if (!(await commonWodEnabled(e, u.id))) return json({wod: null, enabled: false});
    const wod = await e.DB.prepare("SELECT * FROM common_wods WHERE wod_date=? AND status='ready'")
      .bind(localToday())
      .first();
    if (!wod) return json({wod: null});
    const [mine, count] = await Promise.all([
      e.DB.prepare("SELECT id FROM daily_wods WHERE user_id=? AND common_wod_id=?").bind(u.id, wod.id).first(),
      e.DB.prepare(
        "SELECT COUNT(DISTINCT s.user_id) AS n FROM training_sessions s JOIN daily_wods d ON d.id=s.daily_wod_id AND d.user_id=s.user_id WHERE d.common_wod_id=?"
      )
        .bind(wod.id)
        .first(),
    ]);
    return json({wod: commonWodOut(wod), joined_id: mine?.id || null, participants: count?.n || 0});
  }
  // « Je le fais » : copie du WOD aléatoire dans mes WOD du jour (une seule fois), pour enregistrer ma séance et mon score.
  m = p.match(/^\/api\/common-wod\/([\w-]+)\/join$/);
  if (m && r.method === "POST") {
    if (!(await commonWodEnabled(e, u.id)))
      return json({error: "Abonne-toi au WOD aléatoire du jour pour participer."}, 403);
    const wod = await e.DB.prepare("SELECT * FROM common_wods WHERE id=? AND status='ready'").bind(m[1]).first();
    if (!wod) return json({error: "WOD aléatoire introuvable."}, 404);
    if (wod.wod_date < addDays(localToday(), -1))
      return json({error: "Ce WOD aléatoire est passé : il ne peut plus être ajouté."}, 400);
    await e.DB.prepare(
      "INSERT OR IGNORE INTO daily_wods(id,user_id,wod_date,title,content,chrono,movement_ids,options,score_type,blocks,common_wod_id) VALUES(?,?,?,?,?,NULL,?,'{}',?,?,?)"
    )
      .bind(uid(), u.id, wod.wod_date, wod.title, wod.content, wod.movement_ids, wod.score_type, wod.blocks, wod.id)
      .run();
    const row = await e.DB.prepare("SELECT * FROM daily_wods WHERE user_id=? AND common_wod_id=?")
      .bind(u.id, wod.id)
      .first();
    return json({ok: true, wod: dailyWodOut(row)});
  }
  // Classement du WOD aléatoire : meilleur score de chaque participant, prénom et initiale du nom seulement.
  m = p.match(/^\/api\/common-wod\/([\w-]+)\/leaderboard$/);
  if (m && r.method === "GET") {
    const wod = await e.DB.prepare("SELECT * FROM common_wods WHERE id=? AND status='ready'").bind(m[1]).first();
    if (!wod) return json({error: "WOD aléatoire introuvable."}, 404);
    const rows = (
      await e.DB.prepare(
        "SELECT s.user_id,s.score_value,u.first_name,u.last_name FROM training_sessions s JOIN daily_wods d ON d.id=s.daily_wod_id AND d.user_id=s.user_id JOIN users u ON u.id=s.user_id WHERE d.common_wod_id=? AND s.score_value IS NOT NULL"
      )
        .bind(wod.id)
        .all()
    ).results;
    const lower = wod.score_type === "time",
      best = new Map();
    for (const x of rows) {
      const prev = best.get(x.user_id);
      if (!prev || (lower ? x.score_value < prev.score_value : x.score_value > prev.score_value))
        best.set(x.user_id, x);
    }
    const ranking = [...best.values()]
      .sort((a, b) => (lower ? a.score_value - b.score_value : b.score_value - a.score_value))
      .map((x, i) => ({
        rank: i + 1,
        name:
          [
            String(x.first_name || "").trim(),
            String(x.last_name || "")
              .trim()
              .slice(0, 1) + ".",
          ]
            .filter(v => v && v !== ".")
            .join(" ") || "Athlète",
        value: x.score_value,
        me: x.user_id === u.id,
      }));
    return json({wod: commonWodOut(wod), ranking});
  }
  // WOD saisi à la main (rejouable : client_id).
  if (p === "/api/daily-wods/manual" && r.method === "POST") {
    const b = await r.json(),
      cid = clientId(b.client_id);
    const existing =
      cid && (await e.DB.prepare("SELECT * FROM daily_wods WHERE id=? AND user_id=?").bind(cid, u.id).first());
    if (existing) return json({ok: true, wod: dailyWodOut(existing)});
    if (cid && (await e.DB.prepare("SELECT 1 FROM daily_wods WHERE id=?").bind(cid).first()))
      return json({error: "Identifiant déjà utilisé."}, 409);
    const x = manualDailyInput(b);
    if (x.error) return json({error: x.error}, 400);
    const row = {id: cid || uid(), chrono: null, movement_ids: await catalogMovementIds(e, b.movement_ids), ...x};
    await e.DB.prepare(
      "INSERT INTO daily_wods(id,user_id,wod_date,title,content,chrono,movement_ids,options,score_type,blocks) VALUES(?,?,?,?,?,NULL,?,?,?,?)"
    )
      .bind(
        row.id,
        u.id,
        row.wod_date,
        row.title,
        row.content,
        row.movement_ids,
        row.options,
        row.score_type,
        row.blocks
      )
      .run();
    return json({ok: true, wod: dailyWodOut(row)});
  }
  if (p === "/api/daily-wods/benchmark" && r.method === "POST") {
    const b = await r.json(),
      cid = clientId(b.client_id),
      bench = benchmarkById(String(b.benchmark_id || "")),
      date = String(b.wod_date || ""),
      now = localToday();
    if (!bench) return json({error: "WOD de référence inconnu."}, 400);
    // Aujourd'hui ou demain ; la veille reste acceptée pour un tirage fait hors ligne et envoyé plus tard.
    if (!validDate(date) || date < addDays(now, -1) || date > addDays(now, 1))
      return json({error: "Le WOD du jour se choisit pour aujourd'hui ou demain."}, 400);
    const existing =
      cid && (await e.DB.prepare("SELECT * FROM daily_wods WHERE id=? AND user_id=?").bind(cid, u.id).first());
    if (existing) return json({ok: true, wod: dailyWodOut(existing)});
    if (cid && (await e.DB.prepare("SELECT 1 FROM daily_wods WHERE id=?").bind(cid).first()))
      return json({error: "Identifiant déjà utilisé."}, 409);
    const catalog = await e.DB.prepare("SELECT id,name FROM movement_catalog").all(),
      out = benchmarkOut(bench),
      row = {
        id: cid || uid(),
        wod_date: date,
        title: bench.name,
        content: out.content,
        chrono: JSON.stringify(out.chrono),
        movement_ids: JSON.stringify(benchmarkMovementIds(bench, catalog.results)),
        benchmark_id: bench.id,
        score_type: bench.score,
      };
    await e.DB.prepare(
      "INSERT INTO daily_wods(id,user_id,wod_date,title,content,chrono,movement_ids,options,benchmark_id,score_type) VALUES(?,?,?,?,?,?,?,'{}',?,?)"
    )
      .bind(
        row.id,
        u.id,
        row.wod_date,
        row.title,
        row.content,
        row.chrono,
        row.movement_ids,
        row.benchmark_id,
        row.score_type
      )
      .run();
    return json({ok: true, wod: dailyWodOut(row)});
  }
  if (p === "/api/benchmark-results" && r.method === "GET") {
    // Résultats saisis à la main et scores des séances faites sur un WOD de référence.
    const [manual, sessions] = await Promise.all([
      e.DB.prepare(
        "SELECT id,benchmark_id,result_date,value,scaled,comment,created_at FROM benchmark_results WHERE user_id=? ORDER BY result_date,created_at"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT s.id,dw.benchmark_id,s.session_date AS result_date,s.score_value AS value,COALESCE(s.score_scaled,0) AS scaled,s.actual_comment AS comment,s.created_at FROM training_sessions s JOIN daily_wods dw ON dw.id=s.daily_wod_id AND dw.user_id=s.user_id WHERE s.user_id=? AND dw.benchmark_id IS NOT NULL AND s.score_value IS NOT NULL ORDER BY s.session_date,s.created_at"
      )
        .bind(u.id)
        .all(),
    ]);
    return json({
      results: [
        ...manual.results.map(x => ({...x, source: "manual"})),
        ...sessions.results.map(x => ({...x, source: "session"})),
      ],
    });
  }
  if (p === "/api/benchmark-results" && r.method === "POST") {
    const b = await r.json(),
      cid = clientId(b.client_id),
      bench = benchmarkById(String(b.benchmark_id || "")),
      date = String(b.result_date || "");
    if (cid && (await e.DB.prepare("SELECT 1 FROM benchmark_results WHERE id=? AND user_id=?").bind(cid, u.id).first()))
      return json({ok: true, id: cid});
    if (!bench) return json({error: "WOD de référence inconnu."}, 400);
    if (!validDate(date) || date > localToday()) return json({error: "Date invalide."}, 400);
    const score = benchmarkScore(bench, b.value);
    if (score.error) return json({error: score.error}, 400);
    const id = cid || uid();
    await e.DB.prepare(
      "INSERT INTO benchmark_results(id,user_id,benchmark_id,result_date,value,scaled,comment) VALUES(?,?,?,?,?,?,?)"
    )
      .bind(id, u.id, bench.id, date, score.value, b.scaled ? 1 : 0, String(b.comment || "").slice(0, 300))
      .run();
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/benchmark-results\/([\w-]+)$/);
  if (m && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM benchmark_results WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/daily-wods\/([\w-]+)$/);
  // Modification d'un WOD saisi à la main, tant qu'aucune séance n'y est rattachée.
  if (m && r.method === "PUT") {
    const row = await e.DB.prepare("SELECT id,wod_date,options,edit_version FROM daily_wods WHERE id=? AND user_id=?")
      .bind(m[1], u.id)
      .first();
    if (!row) return json({error: "WOD introuvable."}, 404);
    if (!manualOf(row)) return json({error: "Seul un WOD saisi à la main peut être modifié."}, 400);
    if (
      await e.DB.prepare("SELECT 1 FROM training_sessions WHERE daily_wod_id=? AND user_id=? LIMIT 1")
        .bind(m[1], u.id)
        .first()
    )
      return json({error: "Une séance est enregistrée sur ce WOD : il ne peut plus être modifié."}, 409);
    const b = await r.json(),
      x = manualDailyInput(b, row.wod_date);
    if (b.edit_version !== undefined && b.edit_version !== row.edit_version) return json({error: WOD_CONFLICT}, 412);
    if (x.error) return json({error: x.error}, 400);
    const movementIds = await catalogMovementIds(e, b.movement_ids);
    const version = uid().replaceAll("-", ""),
      updated = {id: m[1], chrono: null, movement_ids: movementIds, ...x, edit_version: version},
      saved = await saveFreeWodStatement(e.DB, updated, u.id, version, row.edit_version).run();
    if (!saved.meta.changes) return json({error: WOD_CONFLICT}, 412);
    return json({ok: true, wod: dailyWodOut(updated)});
  }
  if (m && r.method === "DELETE") {
    if (
      await e.DB.prepare("SELECT 1 FROM training_sessions WHERE daily_wod_id=? AND user_id=? LIMIT 1")
        .bind(m[1], u.id)
        .first()
    )
      return json({error: "Une séance est enregistrée sur ce WOD : supprime-la d'abord."}, 409);
    await e.DB.prepare("DELETE FROM daily_wods WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/wods\/([\w-]+)\/weekly-programming$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      week = b.week_start,
      content = String(b.content || "").slice(0, 2000);
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const wod = await e.DB.prepare(
      "SELECT w.id,w.is_tracked,p.start_monday,p.end_monday FROM program_wods w JOIN programs p ON p.id=w.program_id WHERE w.id=? AND w.user_id=? AND p.user_id=?"
    )
      .bind(m[1], u.id, u.id)
      .first();
    if (!wod) return json({error: "WOD introuvable."}, 404);
    if (!wod.is_tracked) return json({error: "Ce WOD n'est pas marqué comme suivi."}, 400);
    if (addDays(week, 6) < wod.start_monday || week > wod.end_monday)
      return json({error: "Cette semaine est hors période du programme."}, 400);
    // Texte modifié à la main : les blocs générés par l'IA ne correspondent plus, ils sont oubliés.
    const version = uid().replaceAll("-", "");
    await e.DB.batch([
      coachHistoryStatement(e, m[1], week, content),
      e.DB.prepare(
        "INSERT INTO weekly_wod_programming(wod_id,user_id,week_start,content,edit_version,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(wod_id,week_start) DO UPDATE SET blocks=CASE WHEN weekly_wod_programming.content=excluded.content THEN weekly_wod_programming.blocks ELSE NULL END,content=excluded.content,edit_version=excluded.edit_version,updated_at=CURRENT_TIMESTAMP"
      ).bind(m[1], u.id, week, content, version),
    ]);
    return json({ok: true, edit_version: version});
  }
  m = p.match(/^\/api\/wods\/([\w-]+)$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      activity = await e.DB.prepare(
        "SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1"
      )
        .bind(b.activity_id, adminEmail)
        .first(),
      duration = Number(b.duration_minutes);
    if (b.score_type !== undefined && !PROGRAM_SCORE_TYPES.includes(b.score_type))
      return json({error: "Type de score invalide."}, 400);
    if (!name) return json({error: "Nom requis."}, 400);
    if (!activity || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Sport ou durée invalide."}, 400);
    // Type de WOD : changé seulement s'il est envoyé (vide = type par défaut).
    const wodType = await wodTypeOf(e, b.type_id);
    if (wodType.error) return json({error: wodType.error}, 400);
    try {
      const result = await e.DB.prepare(
        // Programme de coach publié : un WOD suivi le reste (son contenu semaine par semaine est déjà proposé).
        "UPDATE program_wods SET name=?,planned_comment=?,activity_id=?,duration_minutes=?,is_tracked=CASE WHEN program_id IN (SELECT id FROM programs WHERE coach_mode IS NOT NULL AND published_at IS NOT NULL) THEN is_tracked ELSE ? END,score_type=COALESCE(?,score_type),type_id=CASE WHEN ? THEN ? ELSE type_id END WHERE id=? AND user_id=?"
      )
        .bind(
          name,
          String(b.planned_comment || "").slice(0, 3000),
          b.activity_id,
          duration,
          b.is_tracked ? 1 : 0,
          b.score_type ?? null,
          b.type_id !== undefined ? 1 : 0,
          wodType.id,
          m[1],
          u.id
        )
        .run();
      if (!result.meta?.changes) return json({error: "WOD introuvable."}, 404);
    } catch {
      return json({error: "Ce nom de WOD existe déjà dans le programme."}, 409);
    }
    // Mouvements à travailler : remplacés seulement si la liste est envoyée (WOD vérifié ci-dessus : le sien).
    if (Array.isArray(b.catalog_movement_ids))
      await e.DB.batch(await programWodMovementStatements(e, m[1], b.catalog_movement_ids));
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    const completed = await e.DB.prepare(
      "SELECT 1 FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id WHERE s.wod_id=? AND w.user_id=? LIMIT 1"
    )
      .bind(m[1], u.id)
      .first();
    if (completed) return json({error: "Ce WOD a déjà été réalisé et ne peut plus être supprimé."}, 409);
    const owner = await e.DB.prepare("SELECT program_id FROM program_wods WHERE id=? AND user_id=?")
      .bind(m[1], u.id)
      .first();
    if (owner && (await publishedCoachProgram(e, owner.program_id)))
      return json({error: "Programme déjà proposé à des utilisateurs : ce WOD ne peut plus être supprimé."}, 409);
    await e.DB.prepare("DELETE FROM program_wods WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/export-data") {
    const [programs, wods, movements, sessions, checks, catalogChecks] = await Promise.all([
      e.DB.prepare(
        "SELECT p.id,p.name,COALESCE(f.start_monday,p.start_monday) AS start_monday,COALESCE(f.end_monday,p.end_monday) AS end_monday,p.weekly_cardio_target_min,p.weekly_cardio_target_max FROM programs p" +
          FOLLOW_JOIN +
          "WHERE " +
          PROGRAM_ACCESS +
          " ORDER BY 3,p.name"
      )
        .bind(u.id, u.id, u.id, u.id)
        .all(),
      e.DB.prepare(
        "SELECT w.id,w.program_id,w.name,w.sort_order FROM program_wods w JOIN programs p ON p.id=w.program_id WHERE " +
          PROGRAM_ACCESS +
          " AND w.name<>'__AUTRES__' ORDER BY w.program_id,w.sort_order,w.created_at"
      )
        .bind(u.id, u.id, u.id)
        .all(),
      e.DB.prepare(
        "SELECT pm.id,pm.program_id,pm.name,pm.sort_order FROM program_movements pm JOIN programs p ON p.id=pm.program_id WHERE " +
          PROGRAM_ACCESS +
          " ORDER BY pm.program_id,pm.sort_order,pm.created_at"
      )
        .bind(u.id, u.id, u.id)
        .all(),
      e.DB.prepare(
        "SELECT s.id,s.program_id,s.wod_id,s.session_date,s.cardio_intensity FROM training_sessions s WHERE s.user_id=? ORDER BY s.session_date,s.id"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.movement_id,pm.name AS movement_name FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id JOIN program_movements pm ON pm.id=c.movement_id WHERE s.user_id=? ORDER BY pm.sort_order,pm.name"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.catalog_movement_id,mc.name AS movement_name FROM session_catalog_movement_checks c JOIN training_sessions s ON s.id=c.session_id JOIN movement_catalog mc ON mc.id=c.catalog_movement_id WHERE s.user_id=? ORDER BY mc.sort_order,mc.name"
      )
        .bind(u.id)
        .all(),
    ]);
    return json({
      programs: programs.results,
      wods: wods.results,
      movements: movements.results,
      sessions: sessions.results,
      checks: checks.results,
      catalogChecks: catalogChecks.results,
    });
  }
  if (r.method === "GET" && p === "/api/week-data") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to) || from > to) return json({error: "Période invalide."}, 400);
    const [s, f, pl, c, cc, bw, dw, tg, sp] = await Promise.all([
      e.DB.prepare(
        SESSION_SELECT + " AND s.session_date>=? AND s.session_date<=? ORDER BY s.session_date DESC,s.created_at DESC"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT week_start,competition FROM weekly_flags WHERE user_id=? AND week_start>=? AND week_start<=?"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT wp.week_start,wp.wod_id,w.name AS wod_name FROM weekly_plans wp JOIN program_wods w ON w.id=wp.wod_id WHERE wp.user_id=? AND wp.week_start>=? AND wp.week_start<=?"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.movement_id FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.catalog_movement_id FROM session_catalog_movement_checks c JOIN training_sessions s ON s.id=c.session_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
      )
        .bind(u.id, from, to)
        .all(),
      daysBetween(from, to) <= 92 ? memberBoxWods(e, u.id, from, to) : [],
      e.DB.prepare(
        "SELECT w.id,w.wod_date,w.title,w.content,w.chrono,w.movement_ids,w.benchmark_id,w.score_type,w.blocks,w.options,w.common_wod_id,w.edit_version,(SELECT group_concat(s.id) FROM training_sessions s WHERE s.daily_wod_id=w.id AND s.user_id=w.user_id) AS session_ids FROM daily_wods w WHERE w.user_id=? AND w.wod_date>=? AND w.wod_date<=? ORDER BY w.wod_date,w.created_at LIMIT 60"
      )
        .bind(u.id, from, to)
        .all(),
      // Partenaires tagués sur mes séances de la période (nom et état de l'invitation).
      e.DB.prepare(
        "SELECT t.session_id,t.to_user_id,t.status,tu.first_name,tu.last_name FROM session_tags t JOIN training_sessions s ON s.id=t.session_id JOIN users tu ON tu.id=t.to_user_id WHERE t.from_user_id=? AND s.user_id=? AND s.session_date>=? AND s.session_date<=?"
      )
        .bind(u.id, u.id, from, to)
        .all(),
      // Séances ajoutées depuis une invitation (même identifiant que l'invitation) : l'auteur et les autres
      // partenaires tagués sur la séance d'origine (sauf refus), pour savoir avec qui on s'est entraîné.
      e.DB.prepare(
        "SELECT s.id AS session_id,fu.first_name,fu.last_name FROM training_sessions s JOIN session_tags t ON t.id=s.id AND t.to_user_id=s.user_id JOIN users fu ON fu.id=t.from_user_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=? UNION ALL SELECT s.id,ou.first_name,ou.last_name FROM training_sessions s JOIN session_tags t ON t.id=s.id AND t.to_user_id=s.user_id JOIN session_tags o ON o.session_id=t.session_id AND o.id<>t.id AND o.status<>'declined' JOIN users ou ON ou.id=o.to_user_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
      )
        .bind(u.id, from, to, u.id, from, to)
        .all(),
    ]);
    return json({
      sessions: s.results,
      flags: f.results,
      plans: pl.results,
      checks: c.results,
      catalogChecks: cc.results,
      boxWods: bw,
      dailyWods: dw.results.map(dailyWodOut),
      tags: tg.results,
      sharedPartners: sp.results,
    });
  }
  if (r.method === "GET" && p === "/api/sessions") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    let sql = SESSION_SELECT;
    const args = [u.id];
    if (validDate(from)) {
      sql += " AND s.session_date>=?";
      args.push(from);
    }
    if (validDate(to)) {
      sql += " AND s.session_date<=?";
      args.push(to);
    }
    sql += " ORDER BY s.session_date DESC,s.created_at DESC";
    const x = await e.DB.prepare(sql)
      .bind(...args)
      .all();
    return json({sessions: x.results});
  }
  m = p.match(/^\/api\/wods\/([\w-]+)\/scores$/);
  if (m && r.method === "GET") {
    const scores = await e.DB.prepare(
      "SELECT id,session_date,program_score_type AS score_type,score_value,created_at FROM training_sessions WHERE user_id=? AND wod_id=? AND program_score_type IS NOT NULL AND score_value IS NOT NULL ORDER BY session_date DESC,created_at DESC"
    )
      .bind(u.id, m[1])
      .all();
    return json({scores: scores.results});
  }
  if (r.method === "POST" && p === "/api/sessions") {
    if (apiUser && r.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      return json({error: "Un corps JSON est requis."}, 415);
    const b = await r.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) return json({error: "Un objet JSON est requis."}, 400);
    const cid = apiUser && typeof b.client_id !== "string" ? null : clientId(b.client_id),
      existingSession = () =>
        e.DB.prepare("SELECT 1 FROM training_sessions WHERE id=? AND user_id=?").bind(cid, u.id).first();
    if (cid && (await existingSession())) return json({ok: true, id: cid});
    if (!validCardioIntensity(b.cardio_intensity)) return invalidCardioIntensity();
    if (apiUser) {
      if (b.client_id != null && !cid) return json({error: "L’identifiant client doit être un UUID v4."}, 400);
      if (typeof b.activity_id !== "string" || !Number.isInteger(b.duration_minutes))
        return json({error: "Sport ou durée invalide."}, 400);
      if ([b.box_wod_id, b.daily_wod_id, b.type_id].some(id => id != null && typeof id !== "string"))
        return json({error: "Identifiant de WOD ou de type invalide."}, 400);
      if (
        !(b.box_wod_id || b.daily_wod_id) &&
        (typeof b.program_id !== "string" || !b.program_id || typeof b.wod_id !== "string" || !b.wod_id)
      )
        return json({error: "Le programme et le WOD sont requis."}, 400);
      if (
        [b.movement_ids, b.catalog_movement_ids].some(
          ids => ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && id))
        )
      )
        return json({error: "Liste de mouvements invalide."}, 400);
      if (b.score_value != null && typeof b.score_value !== "number" && typeof b.score_value !== "string")
        return json({error: "Score invalide."}, 400);
      if (b.score_category_id != null && typeof b.score_category_id !== "string")
        return json({error: "Identifiant de catégorie invalide."}, 400);
      if (b.actual_comment != null && typeof b.actual_comment !== "string")
        return json({error: "Commentaire invalide."}, 400);
      if (
        b.tagged_user_ids != null &&
        (!Array.isArray(b.tagged_user_ids) || !b.tagged_user_ids.every(id => typeof id === "string"))
      )
        return json({error: "Liste de partenaires invalide."}, 400);
    }
    // WOD de box : la séance est rattachée au programme technique « Hors programme » (WOD « Autres »).
    const box = await sessionBoxWod(e, u.id, b);
    if (box.error) return json({error: box.error}, box.status);
    const daily = await sessionDailyWod(e, u.id, b);
    if (daily.error) return json({error: daily.error}, daily.status);
    if (box.wod || daily.id) {
      b.program_id = "none";
      b.wod_id = "other";
    }
    // « Autres » sur le programme d'un autre auteur (programme suivi) : séance rattachée à « Hors programme ».
    if (b.wod_id === "other" && b.program_id !== "none" && !(await ownProgram(e, u.id, b.program_id)))
      b.program_id = "none";
    const date = b.session_date;
    if (
      (apiUser && typeof date !== "string") ||
      !validDate(date) ||
      (apiUser && new Date(date).toISOString().slice(0, 10) !== date)
    )
      return json({error: "Date invalide."}, 400);
    if (date > localToday()) return json({error: "Impossible d’enregistrer une séance à une date future."}, 400);
    const pid = b.program_id === "none" ? await fallbackProgramId(e, u.id) : b.program_id;
    let wid = b.wod_id;
    const isOther = wid === "other"; // WOD « Autres » : tous les mouvements du catalogue
    const act = await activeSessionActivity(e, b.activity_id, adminEmail),
      duration = Number(b.duration_minutes);
    if (!act || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Sport ou durée invalide."}, 400);
    const program = await sessionProgram(e, u.id, pid);
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (date < program.start || date > program.end)
      return json({error: "La date de la séance doit être comprise dans la période du programme."}, 400);
    if (wid === "other") {
      let w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
        .bind(pid, u.id)
        .first();
      if (!w) {
        const id = uid();
        await e.DB.prepare(
          "INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)"
        )
          .bind(id, pid, u.id)
          .run();
        w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
          .bind(pid, u.id)
          .first();
      }
      wid = w.id;
    }
    const w = await e.DB.prepare(
      "SELECT id,program_id,name,score_type,type_id FROM program_wods WHERE id=? AND program_id=?"
    )
      .bind(wid, pid)
      .first();
    if (!w || w.program_id !== pid) return json({error: "WOD ou programme invalide."}, 400);
    const score = sessionProgramScore(w, b);
    if (score.error) return json({error: score.error}, 400);
    const sessionType = await sessionTypeId(e, b, box.wod, w);
    if (sessionType.error) return json({error: sessionType.error}, 400);
    const id = cid || uid(),
      checks = await movementCheckStatements(
        e,
        u.id,
        id,
        pid,
        Array.isArray(b.movement_ids) ? b.movement_ids : [],
        Array.isArray(b.catalog_movement_ids) ? b.catalog_movement_ids : [],
        isOther,
        w.id,
        Boolean(apiUser)
      );
    if (!checks) return json({error: "Mouvement inconnu ou non autorisé pour ce WOD."}, 400);
    try {
      await e.DB.batch([
        e.DB.prepare(
          "INSERT INTO training_sessions(id,program_id,wod_id,user_id,session_date,actual_comment,activity_id,duration_minutes,started_at,logged_at,box_wod_id,score_value,score_category_id,daily_wod_id,score_scaled,program_score_type,type_id,cardio_intensity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(
          id,
          pid,
          wid,
          u.id,
          date,
          String(b.actual_comment || "").slice(0, 3000),
          b.activity_id,
          duration,
          typeof b.started_at === "string" && !Number.isNaN(Date.parse(b.started_at))
            ? new Date(b.started_at).toISOString()
            : new Date(Date.now() - duration * 60000).toISOString(),
          new Date().toISOString(),
          box.wod?.id || null,
          box.value ?? daily.value ?? score.value,
          box.category ?? null,
          daily.id,
          daily.scaled,
          score.type,
          sessionType.id,
          b.cardio_intensity ?? null
        ),
        ...checks,
        ...sessionTagStatements(e, u.id, id, sessionTagIds(b, u.id) || []),
      ]);
    } catch (err) {
      // La contrainte sur l’identifiant arbitre les créations concurrentes. Le lot perdant est annulé.
      if (!cid || !String(err?.message).includes("UNIQUE constraint failed: training_sessions.id")) throw err;
      if (await existingSession()) return json({ok: true, id: cid});
      return json({error: "Identifiant de séance indisponible."}, 409);
    }
    await afterTagging(ctx, e, u, id);
    return json({ok: true, id});
  }
  m = p.match(SESSION_ID_PATH);
  if (m && r.method === "PUT") {
    if (apiUser) return editApiSession(r, e, u.id, m[1], adminEmail);
    const previous = await e.DB.prepare(
      "SELECT wod_id,program_score_type,score_value,edit_version,cardio_intensity FROM training_sessions WHERE id=? AND user_id=?"
    )
      .bind(m[1], u.id)
      .first();
    if (!previous) return json({error: "Séance introuvable."}, 404);
    const b = await r.json();
    if (!validCardioIntensity(b.cardio_intensity)) return invalidCardioIntensity();
    const box = await sessionBoxWod(e, u.id, b, m[1]);
    if (box.error) return json({error: box.error}, box.status);
    const daily = await sessionDailyWod(e, u.id, b);
    if (daily.error) return json({error: daily.error}, daily.status);
    if (box.wod || daily.id) {
      b.program_id = "none";
      b.wod_id = "other";
    }
    // « Autres » sur le programme d'un autre auteur (programme suivi) : séance rattachée à « Hors programme ».
    if (b.wod_id === "other" && b.program_id !== "none" && !(await ownProgram(e, u.id, b.program_id)))
      b.program_id = "none";
    if (b.program_id === "none") b.program_id = await fallbackProgramId(e, u.id);
    if (!validDate(b.session_date)) return json({error: "Date invalide."}, 400);
    const act = await activeSessionActivity(e, b.activity_id, adminEmail),
      duration = Number(b.duration_minutes);
    if (!act || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Sport ou durée invalide."}, 400);
    if (b.session_date > localToday())
      return json({error: "Impossible d’enregistrer une séance à une date future."}, 400);
    const program = await sessionProgram(e, u.id, b.program_id);
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (b.session_date < program.start || b.session_date > program.end)
      return json({error: "La date de la séance doit être comprise dans la période du programme."}, 400);
    let wid = b.wod_id;
    const isOther = wid === "other"; // WOD « Autres » : tous les mouvements du catalogue
    if (wid === "other") {
      let w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
        .bind(b.program_id, u.id)
        .first();
      if (!w) {
        const id = uid();
        await e.DB.prepare(
          "INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)"
        )
          .bind(id, b.program_id, u.id)
          .run();
        w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
          .bind(b.program_id, u.id)
          .first();
      }
      wid = w.id;
    }
    const w = await e.DB.prepare(
      "SELECT id,program_id,name,score_type,type_id FROM program_wods WHERE id=? AND program_id=?"
    )
      .bind(wid, b.program_id)
      .first();
    if (!w || w.program_id !== b.program_id) return json({error: "WOD ou programme invalide."}, 400);
    const score = sessionProgramScore(w, b, previous);
    if (score.error) return json({error: score.error}, 400);
    const sessionType = await sessionTypeId(e, b, box.wod, w);
    if (sessionType.error) return json({error: sessionType.error}, 400);
    const nextVersion = uid().replaceAll("-", "");
    const checks = await movementCheckStatements(
      e,
      u.id,
      m[1],
      b.program_id,
      Array.isArray(b.movement_ids) ? b.movement_ids : [],
      Array.isArray(b.catalog_movement_ids) ? b.catalog_movement_ids : [],
      isOther,
      w.id,
      false,
      {version: nextVersion}
    );
    const tagIds = sessionTagIds(b, u.id);
    const [updated] = await e.DB.batch([
      e.DB.prepare(
        "UPDATE training_sessions SET program_id=?,wod_id=?,session_date=?,actual_comment=?,activity_id=?,duration_minutes=?,started_at=?,logged_at=?,box_wod_id=?,score_value=?,score_category_id=?,daily_wod_id=?,score_scaled=?,program_score_type=?,type_id=?,cardio_intensity=?,updated_at=CURRENT_TIMESTAMP,edit_version=? WHERE id=? AND user_id=? AND edit_version=?"
      ).bind(
        b.program_id,
        wid,
        b.session_date,
        String(b.actual_comment || "").slice(0, 3000),
        b.activity_id,
        duration,
        typeof b.started_at === "string" && !Number.isNaN(Date.parse(b.started_at))
          ? new Date(b.started_at).toISOString()
          : new Date(Date.now() - duration * 60000).toISOString(),
        new Date().toISOString(),
        box.wod?.id || null,
        box.value ?? daily.value ?? score.value,
        box.category ?? null,
        daily.id,
        daily.scaled,
        score.type,
        sessionType.id,
        b.cardio_intensity === undefined ? previous.cardio_intensity : b.cardio_intensity,
        nextVersion,
        m[1],
        u.id,
        previous.edit_version
      ),
      ...checks,
      // Partenaires : les invitations encore en attente qui ne sont plus dans la liste sont retirées ; celles déjà
      // acceptées ou refusées restent (la séance du partenaire est la sienne).
      ...(tagIds
        ? [
            e.DB.prepare(
              "DELETE FROM session_tags WHERE session_id=? AND from_user_id=? AND status='pending'" +
                (tagIds.length ? " AND to_user_id NOT IN (" + tagIds.map(() => "?").join(",") + ")" : "") +
                " AND " +
                SESSION_AT_VERSION
            ).bind(m[1], u.id, ...tagIds, m[1], u.id, nextVersion),
            ...sessionTagStatements(e, u.id, m[1], tagIds, nextVersion),
          ]
        : []),
    ]);
    if (!updated.meta.changes) return json({error: "La séance a changé. Relis-la avant de la modifier."}, 409);
    if (tagIds?.length) await afterTagging(ctx, e, u, m[1]);
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM training_sessions WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  // Recherche d'un partenaire à taguer : comptes actifs avec prénom et nom, sans l'adresse e-mail (10 au plus).
  if (r.method === "GET" && p === "/api/users/search") {
    const q = String(new URL(r.url).searchParams.get("q") || "")
      .trim()
      .slice(0, 60);
    if (q.length < 2) return json({users: []});
    const x = await e.DB.prepare(
      "SELECT id,first_name,last_name FROM users WHERE is_active=1 AND id<>? AND COALESCE(first_name,'')<>'' AND COALESCE(last_name,'')<>'' AND (first_name||' '||last_name LIKE ? ESCAPE '\\' OR last_name||' '||first_name LIKE ? ESCAPE '\\') ORDER BY first_name COLLATE NOCASE,last_name COLLATE NOCASE LIMIT 10"
    )
      .bind(u.id, ...Array(2).fill("%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%"))
      .all();
    return json({users: x.results});
  }
  // Séances où l'on est tagué, en attente de réponse.
  if (r.method === "GET" && p === "/api/session-tags") {
    const x = await e.DB.prepare(
      "SELECT t.id,s.session_date,s.actual_comment,COALESCE(bw.name,dw.title,CASE WHEN w.name='__AUTRES__' THEN 'Séance libre' ELSE w.name END) AS wod_name,fu.first_name,fu.last_name FROM session_tags t JOIN training_sessions s ON s.id=t.session_id JOIN program_wods w ON w.id=s.wod_id LEFT JOIN box_wods bw ON bw.id=s.box_wod_id LEFT JOIN daily_wods dw ON dw.id=s.daily_wod_id JOIN users fu ON fu.id=t.from_user_id WHERE t.to_user_id=? AND t.status='pending' ORDER BY s.session_date DESC,t.created_at DESC LIMIT 50"
    )
      .bind(u.id)
      .all();
    return json({tags: x.results});
  }
  // Réponse à une invitation : refus, ou acceptation qui copie la séance dans son propre historique (sur le WOD de
  // la box si on en est membre, sinon en séance libre avec le nom du WOD en tête du contenu ; mouvements du catalogue
  // repris). La copie est indépendante : la modifier ou la supprimer ne touche pas la séance de l'auteur.
  m = p.match(/^\/api\/session-tags\/([\w-]+)\/(accept|decline)$/);
  if (m && r.method === "POST") {
    const tag = await e.DB.prepare(
      "SELECT id,session_id,from_user_id FROM session_tags WHERE id=? AND to_user_id=? AND status='pending'"
    )
      .bind(m[1], u.id)
      .first();
    if (!tag) return json({error: "Invitation introuvable ou déjà traitée."}, 404);
    const now = new Date().toISOString();
    if (m[2] === "decline") {
      await e.DB.prepare("UPDATE session_tags SET status='declined',responded_at=? WHERE id=? AND status='pending'")
        .bind(now, tag.id)
        .run();
      return json({ok: true});
    }
    const src = await e.DB.prepare(
      "SELECT s.session_date,s.actual_comment,s.activity_id,s.duration_minutes,s.started_at,s.box_wod_id,COALESCE(bw.name,dw.title,CASE WHEN w.name='__AUTRES__' THEN '' ELSE w.name END) AS wod_name,(SELECT 1 FROM box_members bm WHERE bm.box_id=bw.box_id AND bm.user_id=? AND bm.role='member' AND bm.status='approved') AS member FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id LEFT JOIN box_wods bw ON bw.id=s.box_wod_id LEFT JOIN daily_wods dw ON dw.id=s.daily_wod_id WHERE s.id=? AND s.user_id=?"
    )
      .bind(u.id, tag.session_id, tag.from_user_id)
      .first();
    if (!src) return json({error: "Séance introuvable."}, 404);
    const pid = await fallbackProgramId(e, u.id);
    let other = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
      .bind(pid, u.id)
      .first();
    if (!other) {
      await e.DB.prepare(
        "INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)"
      )
        .bind(uid(), pid, u.id)
        .run();
      other = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
        .bind(pid, u.id)
        .first();
    }
    const box = src.box_wod_id && src.member ? src.box_wod_id : null,
      comment = (box || !src.wod_name ? "" : src.wod_name + "\n") + (src.actual_comment || ""),
      catalog = await e.DB.prepare(
        "SELECT catalog_movement_id AS id FROM session_catalog_movement_checks WHERE session_id=? UNION SELECT pm.catalog_movement_id FROM session_movement_checks c JOIN program_movements pm ON pm.id=c.movement_id WHERE c.session_id=? AND pm.catalog_movement_id IS NOT NULL"
      )
        .bind(tag.session_id, tag.session_id)
        .all(),
      id = tag.id; // une seule copie par invitation, même si la réponse est envoyée deux fois
    await e.DB.batch([
      e.DB.prepare("UPDATE session_tags SET status='accepted',responded_at=? WHERE id=? AND status='pending'").bind(
        now,
        tag.id
      ),
      e.DB.prepare(
        "INSERT OR IGNORE INTO training_sessions(id,program_id,wod_id,user_id,session_date,actual_comment,activity_id,duration_minutes,started_at,logged_at,box_wod_id,shared_from_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        id,
        pid,
        other.id,
        u.id,
        src.session_date,
        comment.slice(0, 3000),
        src.activity_id,
        src.duration_minutes,
        src.started_at,
        now,
        box,
        tag.from_user_id
      ),
      ...catalog.results.map(c =>
        e.DB.prepare(
          "INSERT OR IGNORE INTO session_catalog_movement_checks(session_id,catalog_movement_id) VALUES(?,?)"
        ).bind(id, c.id)
      ),
    ]);
    return json({ok: true, id, session_date: src.session_date});
  }
  if (r.method === "GET" && p === "/api/stats") {
    const x = await e.DB.prepare(
      "SELECT w.id,w.name,w.planned_comment,COUNT(s.id) AS sessions_count,COALESCE(SUM(s.session_count),0) AS total_sessions FROM program_wods w LEFT JOIN training_sessions s ON s.wod_id=w.id AND s.user_id=w.user_id WHERE w.user_id=? AND w.name<>'__AUTRES__' GROUP BY w.id ORDER BY total_sessions DESC,w.name"
    )
      .bind(u.id)
      .all();
    return json({stats: x.results});
  }
  return json({error: "Route inconnue."}, 404);
}
export default {
  async scheduled(controller, e, ctx) {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      ensureV2Schema(e).then(() =>
        controller.cron === "17 3 * * *"
          ? e.DB.batch([
              e.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
              e.DB.prepare("DELETE FROM login_attempts WHERE attempted_at<=?").bind(now - 86400),
              e.DB.prepare("DELETE FROM password_resets WHERE expires_at<=?").bind(now - 86400),
              e.DB.prepare("DELETE FROM weekly_plan_requests WHERE expires_at<=?").bind(now),
              e.DB.prepare("DELETE FROM pr_api_requests WHERE expires_at<=?").bind(now),
              e.DB.prepare("DELETE FROM wod_api_requests WHERE expires_at<=?").bind(now),
            ])
          : Promise.all([sendReminders(e), sendMonthlyReportPushes(e), sendCommonWod(e)])
      )
    );
  },
  async fetch(r, e, ctx) {
    const u = new URL(r.url);
    if (!u.pathname.startsWith("/api/")) return e.ASSETS.fetch(r);
    const authorization = r.headers.get("Authorization");
    try {
      await ensureV2Schema(e);
      if (authorization !== null) {
        const principal = await authenticateApiKey(r, e, u.pathname, authorization);
        if (principal instanceof Response) return principal;
        return await api(r, e, u.pathname, ctx, principal);
      }
      const res = await api(r, e, u.pathname, ctx),
        legacy = cookie(r, LEGACY_SESSION_COOKIE);
      if (legacy) {
        if (!cookie(r, SESSION_COOKIE) && !res.headers.has("set-cookie"))
          res.headers.append("set-cookie", setCookie(legacy, SESSION_DAYS * 86400));
        res.headers.append("set-cookie", setCookie("", 0, LEGACY_SESSION_COOKIE));
      }
      return res;
    } catch (err) {
      if (authorization !== null || /^\/api\/api-keys(?:\/|$)/.test(u.pathname)) {
        console.error("myFitFactory : erreur de traitement des clés API");
      } else {
        console.error("myFitFactory", {name: err?.name, message: err?.message, stack: err?.stack, cause: err?.cause});
      }
      return json({error: "Erreur serveur. Réessaie."}, 500);
    }
  },
};
