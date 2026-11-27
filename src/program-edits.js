import {externalWodInput, WOD_ID} from "./external-wods.js";

export const PROGRAM_EDIT_PATH = "/api/program-edits";
const own = (obj, keys) =>
  obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).every(key => keys.includes(key));
const text = (value, max, empty = false) =>
  typeof value === "string" && value.trim().length <= max && (empty || value.trim().length > 0);
const id = value => typeof value === "string" && WOD_ID.test(value);
const ids = value =>
  Array.isArray(value) && value.length <= 40 && value.every(id) && new Set(value).size === value.length;
const fields = [
  "name",
  "objective",
  "start_monday",
  "end_monday",
  "coaching_instructions",
  "weekly_cardio_target_min",
  "weekly_cardio_target_max",
];

export function parseProgramEdit(body, isDate, mondayOf) {
  if (!own(body, ["program_id", "fields", "models", "focus", "drafts"]) || !id(body.program_id)) return null;
  if (
    body.fields !== undefined &&
    (!own(body.fields, fields) ||
      Object.entries(body.fields).some(([key, value]) => {
        if (key === "name") return !text(value, 100);
        if (key === "objective") return !text(value, 500);
        if (key === "coaching_instructions") return !text(value, 4000, true);
        if (key.endsWith("_monday")) return !isDate(value);
        return value !== null && (!Number.isSafeInteger(value) || value < 0);
      }))
  )
    return null;
  if (body.focus !== undefined && !ids(body.focus)) return null;
  const models = body.models;
  if (
    models !== undefined &&
    (!Array.isArray(models) ||
      !models.length ||
      models.length > 20 ||
      models.some(
        model =>
          !own(model, ["id", "name", "instructions", "duration_minutes", "movement_ids"]) ||
          (model.id !== undefined && !id(model.id)) ||
          !text(model.name, 100) ||
          model.name.trim() === "__AUTRES__" ||
          (model.instructions !== undefined && !text(model.instructions, 3000, true)) ||
          (model.duration_minutes !== undefined &&
            (!Number.isInteger(model.duration_minutes) ||
              model.duration_minutes < 1 ||
              model.duration_minutes > 600)) ||
          (model.movement_ids !== undefined && !ids(model.movement_ids))
      ) ||
      new Set(models.map(model => model.name.trim())).size !== models.length ||
      new Set(models.filter(model => model.id).map(model => model.id)).size !== models.filter(model => model.id).length)
  )
    return null;
  const drafts = [];
  const slots = new Set();
  if (body.drafts !== undefined && (!Array.isArray(body.drafts) || body.drafts.length > 26)) return null;
  for (const draft of body.drafts ?? []) {
    if (!own(draft, ["wod_id", "week_start", "wod"])) return null;
    const target = {kind: "program", program_id: body.program_id, wod_id: draft.wod_id, week_start: draft.week_start};
    const parsed = externalWodInput({target, wod: draft.wod}, isDate, mondayOf);
    const key = draft.wod_id + ":" + draft.week_start;
    if (!parsed || slots.has(key)) return null;
    slots.add(key);
    drafts.push(parsed);
  }
  if (!Object.keys(body.fields ?? {}).length && models === undefined && body.focus === undefined && !drafts.length)
    return null;
  return {program_id: body.program_id, fields: body.fields ?? {}, models, focus: body.focus, drafts};
}

// Stable snapshot computed in one SQLite statement. The same expression is rechecked inside the write batch.
export const PROGRAM_SNAPSHOT = `json_object(
  'program', json_object('name',p.name,'start_monday',p.start_monday,'end_monday',p.end_monday,
    'coaching_instructions',p.coaching_instructions,'weekly_cardio_target_min',p.weekly_cardio_target_min,
    'weekly_cardio_target_max',p.weekly_cardio_target_max),
  'models', (SELECT json_group_array(json(row)) FROM (
    SELECT json_object('id',w.id,'name',w.name,'instructions',w.planned_comment,'duration_minutes',w.duration_minutes,
      'archived',w.archived,'sort_order',w.sort_order,'movement_ids',
      (SELECT json_group_array(catalog_movement_id) FROM (SELECT catalog_movement_id FROM program_wod_movements WHERE wod_id=w.id ORDER BY 1))) AS row
    FROM program_wods w WHERE w.program_id=p.id AND w.name<>'__AUTRES__' ORDER BY w.sort_order,w.id)),
  'focus', (SELECT json_group_array(json(row)) FROM (
    SELECT json_object('id',id,'name',name,'catalog',catalog_movement_id,'archived',archived) AS row
    FROM program_movements WHERE program_id=p.id ORDER BY sort_order,id)),
  'drafts', (SELECT json_group_array(json(row)) FROM (
    SELECT json_object('wod_id',x.wod_id,'week_start',x.week_start,'edit_version',x.edit_version,'content',x.content,'blocks',x.blocks) AS row
    FROM weekly_wod_programming x JOIN program_wods w ON w.id=x.wod_id
    WHERE w.program_id=p.id ORDER BY x.week_start,x.wod_id)),
  'sessions', (SELECT json_group_array(json(row)) FROM (
    SELECT json_array(id,wod_id,session_date) AS row FROM training_sessions WHERE program_id=p.id ORDER BY id))
)`;
export const editableProgram =
  "p.id=? AND p.user_id=? AND p.is_default=0 AND p.is_public=0 AND p.coach_mode IS NULL AND NOT EXISTS(SELECT 1 FROM program_follows WHERE program_id=p.id)";
