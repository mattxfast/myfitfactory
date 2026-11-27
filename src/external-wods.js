import {AI_BLOCKS, wodBlocks, wodToText} from "./ai.js";

export const EXTERNAL_WOD_PATH = "/api/generated-wods";
export const WOD_VERSION = /^[a-f0-9]{32}$/;
export const LEGACY_WOD_VERSION = "00000000000000000000000000000000";
export const WOD_ID = /^[\w-]{1,64}$/;
export const WOD_SCORE_TYPES = ["none", "time", "reps", "load"];

const ownKeys = (x, fields) =>
  x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).every(key => fields.includes(key));
const readText = (x, max) => (typeof x === "string" && x.trim().length <= max ? x.trim() : null);
const readOptionalText = (x, max) => (x == null ? "" : readText(x, max));
const minutes = x => Number.isInteger(x) && x >= 1 && x <= 600;

// Même représentation que la sortie IA existante. Les détails d'un exercice restent dans les champs affichés.
export function externalWodInput(body, isDate, mondayOf) {
  if (!ownKeys(body, ["target", "wod"])) return null;
  const {target, wod} = body;
  const program = target?.kind === "program";
  if (
    program
      ? !ownKeys(target, ["kind", "program_id", "wod_id", "week_start"]) ||
        ![target.program_id, target.wod_id].every(id => typeof id === "string" && WOD_ID.test(id)) ||
        !isDate(target.week_start) ||
        mondayOf(target.week_start) !== target.week_start
      : target?.kind !== "free" ||
        !ownKeys(target, ["kind", "wod_id", "wod_date"]) ||
        typeof target.wod_id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(target.wod_id) ||
        !isDate(target.wod_date)
  )
    return null;
  if (
    !ownKeys(wod, ["titre", "duree_estimee_min", "blocs", "objectif_score", "notes_coach", "score_type"]) ||
    !readText(wod.titre, 100) ||
    !minutes(wod.duree_estimee_min) ||
    !Array.isArray(wod.blocs) ||
    wod.blocs.length < 1 ||
    wod.blocs.length > 10 ||
    (wod.score_type !== undefined && (program || !WOD_SCORE_TYPES.includes(wod.score_type)))
  )
    return null;
  const goal = readOptionalText(wod.objectif_score, 200),
    notes = readOptionalText(wod.notes_coach, 300);
  if (goal === null || notes === null) return null;
  const blocs = [],
    ids = new Set(),
    idsByBlock = [];
  for (const b of wod.blocs) {
    if (
      !ownKeys(b, ["type", "duree_min", "format", "time_cap_min", "description", "mouvements"]) ||
      !AI_BLOCKS.includes(b.type) ||
      !minutes(b.duree_min) ||
      (b.time_cap_min != null && !minutes(b.time_cap_min)) ||
      !Array.isArray(b.mouvements) ||
      b.mouvements.length > 12
    )
      return null;
    const format = readOptionalText(b.format, 60),
      description = readOptionalText(b.description, 400),
      mouvements = [],
      blockIds = new Set();
    if (format === null || description === null || (!description && !b.mouvements.length)) return null;
    for (const m of b.mouvements) {
      if (
        !ownKeys(m, ["movement_id", "nom", "reps", "charge", "scaling"]) ||
        !readText(m.nom, 100) ||
        (m.movement_id != null && (typeof m.movement_id !== "string" || !WOD_ID.test(m.movement_id)))
      )
        return null;
      const reps = readOptionalText(m.reps, 120),
        charge = readOptionalText(m.charge, 120),
        scaling = readOptionalText(m.scaling, 120);
      if ([reps, charge, scaling].includes(null)) return null;
      if (m.movement_id) {
        ids.add(m.movement_id);
        blockIds.add(m.movement_id);
      }
      mouvements.push({nom: readText(m.nom, 100), reps, charge, scaling});
    }
    idsByBlock.push([...blockIds].sort());
    blocs.push({
      type: b.type,
      duree_min: b.duree_min,
      time_cap_min: b.time_cap_min ?? null,
      format,
      description,
      mouvements,
    });
  }
  if (ids.size > 40) return null;
  const title = readText(wod.titre, 100).replace(/\s+/g, " "),
    normalized = {
      titre: title,
      duree_estimee_min: wod.duree_estimee_min,
      blocs,
      objectif_score: goal,
      notes_coach: notes,
    },
    parts = wodBlocks(normalized),
    // Ne pas enregistrer silencieusement un résultat que les formats historiques tronqueraient.
    availableLength = program ? 2000 : 8000,
    content = wodToText(normalized, 100000, !program);
  if (
    content.length > availableLength ||
    parts.some(part => part.text.length >= 1500) ||
    parts.filter(part => part.type !== "objectif" && part.type !== "notes").length !== blocs.length
  )
    return null;
  const manualTypes = {
      echauffement: "warmup",
      technique: "technique",
      force: "strength",
      metcon: "metcon",
      retour_au_calme: "finisher",
      objectif: "metcon",
      notes: "metcon",
    },
    manual = {};
  for (const part of parts) {
    const key = manualTypes[part.type];
    manual[key] = [manual[key], part.text].filter(Boolean).join("\n\n");
    if (!program && manual[key].length > 2000) return null;
  }
  return {
    target: program
      ? {kind: "program", program_id: target.program_id, wod_id: target.wod_id, week_start: target.week_start}
      : {kind: "free", wod_id: target.wod_id.toLowerCase(), wod_date: target.wod_date},
    title,
    content,
    duration_minutes: normalized.duree_estimee_min,
    blocks: parts.map((part, i) => (idsByBlock[i]?.length ? {...part, movement_ids: idsByBlock[i]} : part)),
    movement_ids: [...ids].sort(),
    score_type: !program && wod.score_type && wod.score_type !== "none" ? wod.score_type : null,
    options: program ? null : JSON.stringify({manual: true, name: title, blocks: manual}),
  };
}

// Lire la version et les droits sans modifier le contenu. Une version de migration fixe couvre les anciennes lignes.
export const EXTERNAL_PROGRAM_PATH = "/api/generated-programs";

export function externalProgramInput(body, isDate, mondayOf, addDays) {
  if (
    !ownKeys(body, [
      "name",
      "start",
      "weeks",
      "objective",
      "coaching_instructions",
      "weekly_cardio_target_min",
      "weekly_cardio_target_max",
      "models",
      "drafts",
    ])
  )
    return null;
  const {start, weeks, models, drafts = []} = body;
  const name = readText(body.name, 100);
  const objective = readText(body.objective, 500);
  const instructions = readOptionalText(body.coaching_instructions, 3500);
  if (
    !name ||
    !objective ||
    instructions === null ||
    !isDate(start) ||
    mondayOf(start) !== start ||
    !Number.isInteger(weeks) ||
    weeks < 1 ||
    weeks > 26 ||
    !Array.isArray(models) ||
    models.length < 1 ||
    models.length > 7 ||
    !Array.isArray(drafts) ||
    drafts.length > weeks * models.length
  )
    return null;
  const templates = [];
  const names = new Set();
  for (const model of models) {
    if (!ownKeys(model, ["name", "instructions", "duration_minutes"])) return null;
    const label = readText(model.name, 100),
      notes = readOptionalText(model.instructions, 3000);
    if (
      !label ||
      label === "__AUTRES__" ||
      names.has(label.toLowerCase()) ||
      notes === null ||
      !minutes(model.duration_minutes)
    )
      return null;
    names.add(label.toLowerCase());
    templates.push({name: label, instructions: notes, duration_minutes: model.duration_minutes});
  }
  const entries = [],
    slots = new Set();
  for (const draft of drafts) {
    if (
      !ownKeys(draft, ["week", "model", "wod"]) ||
      !Number.isInteger(draft.week) ||
      draft.week < 1 ||
      draft.week > weeks ||
      !Number.isInteger(draft.model) ||
      draft.model < 1 ||
      draft.model > templates.length
    )
      return null;
    const slot = draft.week + ":" + draft.model;
    if (slots.has(slot)) return null;
    slots.add(slot);
    const weekStart = addDays(start, (draft.week - 1) * 7);
    const input = externalWodInput(
      {target: {kind: "program", program_id: "new", wod_id: "new", week_start: weekStart}, wod: draft.wod},
      isDate,
      mondayOf
    );
    if (!input) return null;
    entries.push({
      week: draft.week,
      model: draft.model,
      week_start: weekStart,
      title: input.title,
      duration_minutes: input.duration_minutes,
      content: input.content,
      blocks: input.blocks,
      movement_ids: input.movement_ids,
    });
  }
  entries.sort((a, b) => a.week - b.week || a.model - b.model);
  const end = addDays(start, weeks * 7 - 1);
  if (!isDate(end)) return null;
  return {name, start, end, weeks, objective, coaching_instructions: instructions, models: templates, drafts: entries};
}

export async function programWodState(db, userId, wodId, week) {
  return db
    .prepare(
      `SELECT w.id,w.name,w.is_tracked,w.planned_comment,w.program_id,p.name AS program_name,
            p.start_monday,p.end_monday,p.coaching_instructions,
            (SELECT group_concat(mc.name,', ') FROM program_wod_movements x JOIN movement_catalog mc ON mc.id=x.catalog_movement_id WHERE x.wod_id=w.id) AS movement_names,
            x.content,x.blocks,x.edit_version
     FROM program_wods w JOIN programs p ON p.id=w.program_id
     LEFT JOIN weekly_wod_programming x ON x.wod_id=w.id AND x.week_start=? AND x.user_id=w.user_id
     WHERE w.id=? AND w.user_id=? AND p.user_id=? AND p.is_default=0 AND w.name<>'__AUTRES__'`
    )
    .bind(week, wodId, userId, userId)
    .first();
}

const receiptGuard = "NOT EXISTS (SELECT 1 FROM wod_api_requests WHERE user_id=? AND request_id=?)";
const eligibleVersion =
  "COALESCE((SELECT edit_version FROM weekly_wod_programming x WHERE x.wod_id=w.id AND x.week_start=? AND x.user_id=w.user_id),'')=?";
const byVersion =
  "EXISTS (SELECT 1 FROM weekly_wod_programming WHERE wod_id=? AND week_start=? AND user_id=? AND edit_version=?)";

// Mêmes écritures pour la génération intégrée et la génération externe. La condition de version est testée dans D1.
export function generatedProgramStatements(
  db,
  {userId, wodId, programId, week, end, today, content, blocks, expected, version, requestId}
) {
  const eligible = `FROM program_wods w JOIN programs p ON p.id=w.program_id
       WHERE w.id=? AND w.user_id=? AND p.id=? AND p.user_id=? AND p.is_default=0
         AND w.name<>'__AUTRES__' AND p.start_monday<=? AND p.end_monday>=?
         AND ${eligibleVersion} ${requestId ? "AND " + receiptGuard : ""}`,
    values = [
      wodId,
      userId,
      programId,
      userId,
      end,
      week,
      week,
      expected || "",
      ...(requestId ? [userId, requestId] : []),
    ];
  return [
    db
      .prepare(
        `INSERT INTO coach_wod_history(wod_id,week_start,content,blocks,replaced_on)
       SELECT x.wod_id,x.week_start,x.content,x.blocks,?
       FROM weekly_wod_programming x WHERE x.wod_id=? AND x.week_start=? AND x.user_id=?
         AND (x.content<>? OR x.blocks IS NOT ?)
         AND EXISTS (SELECT 1 ${eligible} AND p.published_at IS NOT NULL)`
      )
      .bind(today, wodId, week, userId, content, blocks, ...values),
    db
      .prepare(
        `INSERT INTO weekly_wod_programming(wod_id,user_id,week_start,content,blocks,edit_version)
       SELECT w.id,w.user_id,?,?,?,? ${eligible}
       ON CONFLICT(wod_id,week_start) DO UPDATE SET content=excluded.content,blocks=excluded.blocks,
           edit_version=excluded.edit_version,updated_at=CURRENT_TIMESTAMP WHERE user_id=excluded.user_id`
      )
      .bind(week, content, blocks, version, ...values),
    db
      .prepare(`UPDATE program_wods SET is_tracked=1 WHERE id=? AND user_id=? AND is_tracked=0 AND ${byVersion}`)
      .bind(wodId, userId, wodId, week, userId, version),
  ];
}

export function saveFreeWodStatement(db, row, userId, version, expected, requestId = null) {
  const args = [
      row.wod_date,
      row.title,
      row.content,
      row.chrono,
      row.movement_ids,
      row.options,
      row.score_type,
      row.blocks,
      version,
    ],
    gate = requestId ? " AND " + receiptGuard : "",
    guardValues = requestId ? [userId, requestId] : [];
  if (expected) {
    return db
      .prepare(
        `UPDATE daily_wods SET wod_date=?,title=?,content=?,chrono=?,movement_ids=?,options=?,score_type=?,blocks=?,edit_version=?
       WHERE id=? AND user_id=? AND edit_version=? AND common_wod_id IS NULL AND benchmark_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM training_sessions WHERE daily_wod_id=daily_wods.id)${gate}`
      )
      .bind(...args, row.id, userId, expected, ...guardValues);
  }
  return db
    .prepare(
      `INSERT INTO daily_wods(id,user_id,wod_date,title,content,chrono,movement_ids,options,score_type,blocks,edit_version)
     SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE 1${gate} ON CONFLICT(id) DO NOTHING`
    )
    .bind(row.id, userId, ...args, ...guardValues);
}

export function insertWodReceipt(db, {userId, requestId, expiresAt, fingerprint, version, target}) {
  const table = target.kind === "program" ? "weekly_wod_programming" : "daily_wods",
    id = target.kind === "program" ? "wod_id" : "id",
    week = target.kind === "program" ? " AND week_start=?" : "";
  return db
    .prepare(
      `INSERT INTO wod_api_requests(user_id,request_id,request_hash,version,expires_at)
     SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM ${table} WHERE user_id=? AND ${id}=? AND edit_version=?${week})
     ON CONFLICT(user_id,request_id) DO NOTHING`
    )
    .bind(
      userId,
      requestId,
      fingerprint,
      version,
      expiresAt,
      userId,
      target.wod_id,
      version,
      ...(week ? [target.week_start] : [])
    );
}

export function generatedFreeRow(input) {
  return {
    id: input.target.wod_id,
    wod_date: input.target.wod_date,
    title: input.title,
    content: input.content,
    chrono: JSON.stringify(null),
    movement_ids: JSON.stringify(input.movement_ids),
    options: input.options,
    score_type: input.score_type,
    blocks: JSON.stringify(input.blocks),
  };
}
