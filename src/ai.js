// Génération de WOD par IA (API OpenAI, sans dépendance) : options de séance, prompt modèle, appel et mise en texte.
// Le Worker (src/worker.js) lit le contexte en base (profil, records, programme, séances) et enregistre le résultat.

export const AI_PROMPT_VERSION = "wod-seance-v4";
export const AI_DAILY_LIMIT = 100; // générations par utilisateur et par 24 h (maîtrise du coût)
export const AI_DEFAULT_MODEL = "gpt-5-mini";
export const AI_LEVELS = {
  debutant: "Débutant",
  intermediaire: "Intermédiaire",
  avance: "Avancé",
  competiteur: "Compétiteur",
};
export const AI_BLOCKS = ["echauffement", "technique", "force", "metcon", "retour_au_calme"];
export const AI_MAX_MOVEMENTS = 5;
const BLOCK_LABELS = {
  echauffement: "Échauffement",
  technique: "Technique",
  force: "Force",
  metcon: "Metcon",
  retour_au_calme: "Finisher",
};
// Icône de chaque rubrique dans le texte du WOD, pour la repérer d’un coup d’œil (le texte reste modifiable à la main).
const BLOCK_ICONS = {echauffement: "🔥", technique: "🎯", force: "🏋️", metcon: "⚡", retour_au_calme: "💥"};
// Consignes de rédaction communes : le texte est mis en forme par l’application (rubriques, puces) à partir du JSON.
const WRITING_RULES = `- Rédaction : dans chaque bloc, "description" tient en une ou deux phrases courtes (intention, consignes d'exécution, repos). Ne répète ni le nom du bloc, ni le format, ni la durée, et ne liste pas les mouvements dans la description : ils vont dans "mouvements", un par ligne.
- "format" est court : « AMRAP 12 min », « EMOM 10 min », « For Time », « 5 x 3 », « 21-15-9 »… ou null.
- Pour chaque mouvement : "reps" (ex. « 5 », « 3 x 5 », « 200 m ») et "charge" (ex. « 75 % 1RM », « 43/30 kg ») courts ; "scaling" seulement si utile, en quelques mots.`;
const FAMILY = {load: "Lift", force: "Force", reps: "Gym", distance: "Engine"};

const text = (v, max) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// Profil d'entraînement (champs libres courts ; pas de données médicales).
export function aiProfileInput(b) {
  const level = String(b.level || "");
  if (level && !AI_LEVELS[level]) return {error: "Niveau invalide."};
  return {
    level,
    goals: text(b.goals, 300),
    equipment: text(b.equipment, 300),
    constraints: text(b.constraints, 300),
  };
}

// Options de la séance demandée. Les mouvements imposés sont des identifiants du catalogue (5 au plus par bloc).
export function aiOptionsInput(b) {
  const duration = Number(b.duration_minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 180)
    return {error: "La durée doit être comprise entre 15 et 180 minutes."};
  const blocks = {};
  for (const k of AI_BLOCKS) blocks[k] = !!b.blocks?.[k];
  if (!AI_BLOCKS.some(k => blocks[k])) return {error: "Choisis au moins un bloc."};
  const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x)).filter(x => /^[\w-]{1,64}$/.test(x)))];
  const technique = blocks.technique ? ids(b.technique_movements) : [],
    force = blocks.force ? ids(b.force_movements) : [];
  if (technique.length > AI_MAX_MOVEMENTS || force.length > AI_MAX_MOVEMENTS)
    return {error: "5 mouvements au plus pour la technique et pour la force."};
  return {
    duration_minutes: duration,
    blocks,
    technique_movements: technique,
    force_movements: force,
    instructions: text(b.instructions, 600),
  };
}

const SYSTEM = `Tu es un coach CrossFit expérimenté. Tu écris des séances sûres, progressives et adaptées à l'athlète.

Règles :
- Respecte strictement les blocs demandés : ne génère que les blocs activés, dans l'ordre échauffement, technique, force, metcon, finisher (bloc court en fin de séance, après le metcon : finisher intense ou retour au calme selon la séance).
- Respecte la durée totale (tolérance ±5 min) en incluant les transitions.
- Les blocs technique et force comportent de 1 à 5 mouvements. Si des mouvements sont imposés, utilise exactement ceux-là ; sinon choisis-en 1 à 3 selon la durée disponible.
- Choisis toi-même le format du metcon (AMRAP, EMOM, For Time, intervalles, chipper…) en variant par rapport à la programmation récente.
- Utilise de préférence les noms de mouvements du catalogue fourni, à l'identique.
- Intègre dans la séance tous les « mouvements à travailler dans ce WOD », sous leur nom exact, dans le ou les blocs qui leur conviennent (sauf contrainte de l'athlète : alternative proposée).
- Adapte mouvements et charges au niveau, aux records et au matériel disponible. Exprime les charges en kg (ou en % du 1RM quand un record est connu), les distances en mètres.
- Respecte les contraintes de l'athlète ; propose une alternative pour tout mouvement qui ne convient pas.
- Assure la progression et la variété avec le programme et les séances récentes : évite de solliciter lourdement le même groupe musculaire deux jours de suite.
- Sois concis : le texte final doit tenir sur un écran de téléphone.
${WRITING_RULES}
- Rédige en français.
- Si la demande est incompatible (trop de blocs pour la durée, par exemple), adapte au mieux et explique-le dans "notes_coach".`;

function aiBlockLines(o, catalog) {
  const names = ids => ids.map(id => catalog.find(m => m.id === id)?.name).filter(Boolean),
    yes = (k, extra = "") => (o.blocks[k] ? "oui" + extra : "non"),
    imposed = ids => {
      const picked = names(ids);
      return picked.length ? " — mouvements imposés : " + picked.join(", ") : " — mouvements au choix du coach";
    };
  return [
    "Échauffement : " + yes("echauffement"),
    "Travail technique : " + yes("technique", imposed(o.technique_movements)),
    "Force : " + yes("force", imposed(o.force_movements)),
    "Metcon : " + yes("metcon", " — format au choix du coach"),
    "Finisher : " + yes("retour_au_calme"),
  ];
}

// Message utilisateur : contexte de l'athlète, du programme et de la séance demandée.
export function buildPrompt(c) {
  const p = c.profile || {},
    o = c.options;
  const prs = c.records.map(r => {
    const unit = r.measurement_method === "reps" ? " rép." : r.measurement_method === "distance" ? " m" : " kg";
    return `${r.name} : ${r.value}${unit}${r.rep_count ? " (" + r.rep_count + " RM)" : ""}`;
  });
  const lines = [
    "## Athlète",
    "Niveau : " + (AI_LEVELS[p.level] || "non précisé"),
    "Objectifs : " + (p.goals || "non précisés"),
    "Matériel disponible : " + (p.equipment || "box CrossFit complète"),
    "Contraintes : " + (p.constraints || "aucune"),
    "Records : " + (prs.length ? prs.join(" ; ") : "aucun enregistré"),
    "",
    "## Programme",
    `${c.program.name} — semaine ${c.weekIndex}/${c.weekCount} (du ${c.weekLabel})`,
    // La thématique / structure du WOD arrive par la consigne particulière (pré-remplie et modifiable dans la fenêtre).
    "WOD à écrire : " + c.wod.name,
    "Mouvements à travailler dans ce WOD : " + (c.wod.movement_names || "aucun en particulier"),
    "Mouvements à travailler dans le programme : " + (c.focus.length ? c.focus.join(", ") : "aucun en particulier"),
    "",
    "## Programmation déjà écrite (semaines récentes et cette semaine)",
    ...(c.planned.length ? c.planned.map(x => `- ${x.week} · ${x.name} : ${text(x.content, 300)}`) : ["Aucune."]),
    "",
    "## Séances réalisées récemment",
    ...(c.sessions.length
      ? c.sessions.map(s => `- ${s.date} · ${s.name}${s.comment ? " : " + text(s.comment, 150) : ""}`)
      : ["Aucune."]),
    "",
    "## Séance demandée",
    "Durée totale : " + o.duration_minutes + " min",
    ...aiBlockLines(o, c.catalog),
    "Consigne particulière : " + (o.instructions || "aucune"),
    "",
    "## Catalogue des mouvements",
    c.catalog
      .map(m => m.name + (FAMILY[m.measurement_method] ? " (" + FAMILY[m.measurement_method] + ")" : ""))
      .join(", ") || "vide",
  ];
  return lines.join("\n");
}

const nullable = type => ({type: [type, "null"]});
export const WOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titre", "duree_estimee_min", "blocs", "objectif_score", "notes_coach"],
  properties: {
    titre: {type: "string"},
    duree_estimee_min: {type: "integer"},
    blocs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "duree_min", "format", "time_cap_min", "description", "mouvements"],
        properties: {
          type: {type: "string", enum: AI_BLOCKS},
          duree_min: {type: "integer"},
          format: nullable("string"),
          time_cap_min: nullable("integer"),
          description: {type: "string"},
          mouvements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["nom", "reps", "charge", "scaling"],
              properties: {
                nom: {type: "string"},
                reps: nullable("string"),
                charge: nullable("string"),
                scaling: nullable("string"),
              },
            },
          },
        },
      },
    },
    objectif_score: nullable("string"),
    notes_coach: nullable("string"),
  },
};

// Appel de l'API Responses d'OpenAI avec un format JSON imposé (structured outputs). Partagé avec l'analyse des
// repas (src/nutrition.js) : input est un texte ou une liste de messages (texte et image).
// Suivi de consommation (espace admin) : tarifs OpenAI en dollars par million de tokens (entrée, entrée en cache,
// sortie ; la sortie comprend les tokens de réflexion). Estimation à mettre à jour si les tarifs changent ; un modèle
// absent de la liste est compté sans coût.
export const AI_PRICES = [
  [/^gpt-5(\.\d+)?-nano/, 0.05, 0.005, 0.4],
  [/^gpt-5(\.\d+)?-mini/, 0.25, 0.025, 2],
  [/^gpt-5/, 1.25, 0.125, 10],
  [/^gpt-4\.1-nano/, 0.1, 0.025, 0.4],
  [/^gpt-4\.1-mini/, 0.4, 0.1, 1.6],
  [/^gpt-4\.1/, 2, 0.5, 8],
  [/^gpt-4o-mini/, 0.15, 0.075, 0.6],
  [/^gpt-4o/, 2.5, 1.25, 10],
  [/^o4-mini/, 1.1, 0.275, 4.4],
  [/^o3/, 2, 0.5, 8],
];
// Fonctionnalités suivies (nom du schéma JSON envoyé à l'API), dans l'ordre d'affichage.
export const AI_FEATURES = ["wod", "wod_du_jour", "wod_commun", "repas", "bilan_mensuel"];
// Coût estimé en dollars, ou null si le tarif du modèle est inconnu.
export function aiCost(model, {input_tokens = 0, cached_tokens = 0, output_tokens = 0}) {
  const price = AI_PRICES.find(([re]) => re.test(String(model)));
  if (!price) return null;
  const [, input, cached, output] = price;
  return ((input_tokens - cached_tokens) * input + cached_tokens * cached + output_tokens * output) / 1e6;
}
// Tokens renvoyés par l'API pour chaque appel (réussi ou non), datés du jour de Paris ; le suivi ne bloque jamais l'appel.
async function recordUsage(env, feature, userId, model, usage) {
  if (!usage || !env.DB) return;
  const n = v => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0),
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date()),
    v = Object.fromEntries(parts.map(p => [p.type, p.value])),
    day = `${v.year}-${v.month}-${v.day}`;
  try {
    await env.DB.prepare(
      "INSERT INTO ai_usage(id,user_id,feature,model,usage_date,input_tokens,cached_tokens,output_tokens,reasoning_tokens) VALUES(?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        crypto.randomUUID(),
        userId || null,
        feature,
        String(model).slice(0, 100),
        day,
        n(usage.input_tokens),
        n(usage.input_tokens_details?.cached_tokens),
        n(usage.output_tokens),
        n(usage.output_tokens_details?.reasoning_tokens)
      )
      .run();
  } catch (err) {
    console.error("Suivi des tokens", err?.message);
  }
}

export async function openAIJson(env, {instructions, input, name, schema, check, refusal, userId = null}) {
  const model = String(env.OPENAI_MODEL || AI_DEFAULT_MODEL),
    body = {
      model,
      instructions,
      input,
      store: false,
      max_output_tokens: 6000,
      text: {format: {type: "json_schema", name, strict: true, schema}},
    };
  // Modèles « à raisonnement » : effort réduit pour une réponse plus rapide et moins chère.
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning = {effort: "low"};
  let res;
  try {
    res = await fetch(String(env.OPENAI_API_URL || "https://api.openai.com/v1/responses"), {
      method: "POST",
      headers: {"content-type": "application/json", authorization: "Bearer " + env.OPENAI_API_KEY},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    return {error: "Le service d'IA ne répond pas. Réessaie dans un instant."};
  }
  const data = await res.json().catch(() => null);
  await recordUsage(env, name, userId, data?.model || model, data?.usage);
  if (!res.ok) {
    console.error("OpenAI", res.status, JSON.stringify(data?.error || data).slice(0, 500));
    if (res.status === 429) return {error: "Le service d'IA est saturé ou le crédit est épuisé. Réessaie plus tard."};
    return {error: "Le service d'IA a renvoyé une erreur (" + res.status + ")."};
  }
  const parts = (data?.output || []).filter(x => x.type === "message").flatMap(x => x.content || []);
  if (parts.some(x => x.type === "refusal")) return {error: refusal};
  const out = parts.find(x => x.type === "output_text")?.text;
  try {
    const result = JSON.parse(out);
    if (!check(result)) throw Error();
    return {result, model: String(data.model || model)};
  } catch {
    console.error("OpenAI réponse illisible", data?.status, JSON.stringify(data?.incomplete_details || ""));
    return {error: "La réponse de l'IA est incomplète. Réessaie."};
  }
}
export async function callOpenAI(env, prompt, userId) {
  const out = await openAIJson(env, {
    userId,
    instructions: SYSTEM,
    input: prompt,
    name: "wod",
    schema: WOD_SCHEMA,
    check: wod => Array.isArray(wod?.blocs) && wod.blocs.length > 0,
    refusal: "L'IA a refusé de générer cette séance.",
  });
  return out.error ? out : {wod: out.result, model: out.model};
}

// ----- WOD du jour (page Séances) : un entraînement hors programme, généré pour aujourd'hui ou demain -----
export const DAILY_PROMPT_VERSION = "wod-du-jour-v4";
export const DAILY_WOD_LIMIT = 10; // WOD du jour par utilisateur et par 24 h (en plus de la limite générale)
export const DAILY_PLACES = {
  box: "En box (matériel CrossFit complet)",
  maison: "À la maison",
  exterieur: "En extérieur",
  sans_materiel: "Sans matériel (poids du corps)",
};
export const DAILY_ENERGY = {en_forme: "En forme", normal: "Normale", fatigue: "Fatigué"};
export const DAILY_CHRONO_MODES = ["fortime", "amrap", "emom", "tabata"];

export function dailyOptionsInput(b) {
  let options;
  if (b.blocks === undefined) {
    // Anciens formulaires : les blocs sont encore choisis par l’IA.
    const duration = Number(b.duration_minutes);
    if (!Number.isInteger(duration) || duration < 15 || duration > 120)
      return {error: "La durée doit être comprise entre 15 et 120 minutes."};
    options = {duration_minutes: duration, instructions: text(b.instructions, 300)};
  } else {
    options = aiOptionsInput(b);
    if (options.error) return options;
  }
  // Des versions précédentes du formulaire peuvent encore transmettre ces deux champs.
  const {place, energy} = b;
  if (place !== undefined && (typeof place !== "string" || !Object.hasOwn(DAILY_PLACES, place)))
    return {error: "Lieu invalide."};
  if (energy !== undefined && (typeof energy !== "string" || !Object.hasOwn(DAILY_ENERGY, energy)))
    return {error: "Forme du jour invalide."};
  return {...options, place, energy};
}

const DAILY_SYSTEM = `Écris le WOD du jour au format tableau blanc pour un athlète qui s'entraîne hors programme.

Règles :
- Respecte la durée totale (tolérance ±5 min) en incluant les transitions.
- Si des blocs sont indiqués, génère exactement un bloc par type activé, dans l'ordre indiqué. Utilise les mouvements imposés pour la force et la technique s'ils sont compatibles avec le matériel et les contraintes.
- Si aucun choix de blocs n'est indiqué, commence par un échauffement court, programme un metcon et ajoute de la force, de la technique ou un finisher si la durée le permet.
- Choisis le format du metcon (AMRAP, EMOM, For Time, Tabata, intervalles…) en variant par rapport aux séances récentes.
- Si la forme du jour est indiquée, adapte le volume et l'intensité : séance plus légère et plus technique si l'athlète est fatigué.
- Respecte le matériel du profil et toute précision sur le lieu ou le matériel dans la demande. Utilise de préférence les noms de mouvements du catalogue fourni, à l'identique.
- Adapte mouvements et charges au niveau et aux records. Exprime les charges en kg (ou en % du 1RM quand un record est connu), les distances en mètres.
- Choisis directement des mouvements et des charges qui respectent les contraintes de l'athlète.
- Assure la variété avec les séances récentes : évite de solliciter lourdement le même groupe musculaire que la veille.
- Le champ "chrono" décrit le minuteur du metcon : mode "fortime" (minutes = time cap, ou null sans cap), "amrap" (minutes = durée), "emom" (intervalle_s = durée d'un intervalle en secondes, tours = nombre d'intervalles), "tabata" (travail_s, repos_s, tours). Mets null dans les champs qui ne concernent pas le mode, et mode "aucun" si le metcon ne se chronomètre pas ainsi.
- Pour chaque bloc, indique le format s'il apporte une information (par exemple « AMRAP 15 min »). Mets toutes les prescriptions dans les mouvements : nom, séries et répétitions ou durée/distance, charge si pertinente. Évite de répéter le format dans chaque mouvement.
- Laisse "description" vide et mets "scaling", "objectif_score" et "notes_coach" à null.
- Rédige en français.`;

export function buildDailyPrompt(c) {
  const p = c.profile || {},
    o = c.options;
  const prs = c.records.map(r => {
    const unit = r.measurement_method === "reps" ? " rép." : r.measurement_method === "distance" ? " m" : " kg";
    return `${r.name} : ${r.value}${unit}${r.rep_count ? " (" + r.rep_count + " RM)" : ""}`;
  });
  return [
    "## Athlète",
    "Niveau : " + (AI_LEVELS[p.level] || "non précisé"),
    "Objectifs : " + (p.goals || "non précisés"),
    "Matériel habituel : " + (p.equipment || "box CrossFit complète"),
    "Contraintes : " + (p.constraints || "aucune"),
    "Records : " + (prs.length ? prs.join(" ; ") : "aucun enregistré"),
    "",
    "## Séances réalisées ces deux dernières semaines",
    ...(c.sessions.length
      ? c.sessions.map(s => `- ${s.date} · ${s.name}${s.comment ? " : " + text(s.comment, 150) : ""}`)
      : ["Aucune."]),
    "",
    "## WOD du jour déjà proposés récemment",
    ...(c.recent.length ? c.recent.map(x => `- ${x.date} · ${x.title}`) : ["Aucun."]),
    "",
    "## WOD demandé",
    "Date : " + c.dateLabel,
    "Durée totale : " + o.duration_minutes + " min",
    ...(o.place ? ["Lieu : " + DAILY_PLACES[o.place]] : []),
    ...(o.energy ? ["Forme du jour : " + DAILY_ENERGY[o.energy]] : []),
    ...(o.blocks ? aiBlockLines(o, c.catalog) : []),
    "Consigne particulière : " + (o.instructions || "aucune"),
    "",
    "## Catalogue des mouvements",
    c.catalog
      .map(m => m.name + (FAMILY[m.measurement_method] ? " (" + FAMILY[m.measurement_method] + ")" : ""))
      .join(", ") || "vide",
  ].join("\n");
}

export const DAILY_WOD_SCHEMA = {
  ...WOD_SCHEMA,
  required: [...WOD_SCHEMA.required, "chrono"],
  properties: {
    ...WOD_SCHEMA.properties,
    chrono: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "minutes", "intervalle_s", "tours", "travail_s", "repos_s"],
      properties: {
        mode: {type: "string", enum: [...DAILY_CHRONO_MODES, "aucun"]},
        minutes: nullable("integer"),
        intervalle_s: nullable("integer"),
        tours: nullable("integer"),
        travail_s: nullable("integer"),
        repos_s: nullable("integer"),
      },
    },
  },
};

export async function callOpenAIDaily(env, prompt, userId) {
  const out = await openAIJson(env, {
    userId,
    instructions: DAILY_SYSTEM,
    input: prompt,
    name: "wod_du_jour",
    schema: DAILY_WOD_SCHEMA,
    check: wod => Array.isArray(wod?.blocs) && wod.blocs.length > 0,
    refusal: "L'IA a refusé de générer cette séance.",
  });
  return out.error ? out : {wod: out.result, model: out.model};
}

// Réglages du chrono proposés par l'IA, bornés (le téléphone les ramène ensuite aux valeurs de ses listes).
export function dailyChrono(c) {
  if (!c || !DAILY_CHRONO_MODES.includes(c.mode)) return null;
  const n = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
  return {
    mode: c.mode,
    minutes: n(c.minutes, 1, 90),
    every_seconds: n(c.intervalle_s, 10, 600),
    rounds: n(c.tours, 1, 99),
    work_seconds: n(c.travail_s, 1, 900),
    rest_seconds: n(c.repos_s, 0, 900),
  };
}

// Mouvements du catalogue cités dans le WOD : cochés par défaut dans la séance enregistrée ensuite. Les noms sont
// comparés sans accents, casse, ponctuation ni pluriel (« Wall balls » = « Wall ball », « Pull-ups » = « Pull up »),
// avec les abréviations courantes (T2B, HSPU, DU, C&J…), et un nom du catalogue d’au moins deux mots cité dans un nom
// plus long est reconnu (« Kettlebell swing russe » → « Kettlebell swing »).
const MOVEMENT_ALIASES = {
  t2b: "toes to bar",
  ttb: "toes to bar",
  c2b: "chest to bar",
  ctb: "chest to bar",
  hspu: "handstand push up",
  hsw: "handstand walk",
  du: "double under",
  dus: "double under",
  mu: "muscle up",
  bmu: "bar muscle up",
  rmu: "ring muscle up",
  ohs: "overhead squat",
  kb: "kettlebell",
  kbs: "kettlebell swing",
  db: "dumbbell",
  wb: "wall ball",
  bjo: "box jump over",
  bbjo: "burpee box jump over",
  sdhp: "sumo deadlift high pull",
  cj: "clean jerk",
  "c j": "clean jerk",
  pc: "power clean",
  ps: "power snatch",
  rdl: "romanian deadlift",
  ghd: "ghd sit up",
};
export function movementKey(v) {
  let k = String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (MOVEMENT_ALIASES[k]) k = MOVEMENT_ALIASES[k];
  return k
    .split(" ")
    .map(w => MOVEMENT_ALIASES[w] || w)
    .join(" ")
    .split(" ")
    .filter(w => w !== "and" && w !== "et")
    .map(w => (w.length >= 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join(" ");
}
export function dailyMovementIds(wod, catalog) {
  const entries = catalog.map(m => ({id: m.id, key: movementKey(m.name)})).filter(m => m.key),
    byKey = new Map(entries.map(m => [m.key, m.id])),
    // Noms du catalogue du plus long au plus court : « Bar muscle up » avant « Muscle up ».
    byLength = [...entries].sort((a, b) => b.key.length - a.key.length);
  const ids = new Set();
  for (const b of wod.blocs || [])
    for (const m of b.mouvements || []) {
      const k = movementKey(m.nom);
      if (!k) continue;
      // Nom plus long que celui du catalogue : seulement pour un nom du catalogue d’au moins deux mots (« Deadlift »
      // ne doit pas reconnaître « Sumo deadlift high pull »).
      const id =
        byKey.get(k) || byLength.find(c => c.key.includes(" ") && (" " + k + " ").includes(" " + c.key + " "))?.id;
      if (id) ids.add(id);
    }
  return [...ids].slice(0, 40);
}

// Blocs d’un WOD généré, pour l’afficher par rubrique dans le détail (comme le planning des gestionnaires) : type,
// titre et texte de chaque bloc (format, durée, consignes, un mouvement par ligne), puis objectif et note du coach.
const BLOCK_TITLES = {
  echauffement: "Échauffement",
  technique: "Travail technique",
  force: "Force",
  metcon: "Metcon",
  retour_au_calme: "Finisher",
};
export function wodBlocks(wod) {
  const parts = (wod.blocs || []).map(b => {
    const format = text(b.format, 60),
      details = [
        format,
        b.duree_min && !new RegExp("\\b" + b.duree_min + "\\s*min", "i").test(format) ? b.duree_min + " min" : "",
        b.time_cap_min ? "Time cap " + b.time_cap_min + " min" : "",
      ].filter(Boolean),
      lines = [details.join(" · "), b.description ? text(b.description, 400) : ""];
    for (const m of b.mouvements || []) {
      lines.push("• " + [m.reps, m.nom].filter(Boolean).join(" ") + (m.charge ? " @ " + m.charge : ""));
      if (m.scaling) lines.push("   ↳ adapté : " + text(m.scaling, 120));
    }
    return {type: b.type, label: BLOCK_TITLES[b.type] || b.type, text: lines.filter(Boolean).join("\n").slice(0, 1500)};
  });
  if (wod.objectif_score) parts.push({type: "objectif", label: "Objectif", text: text(wod.objectif_score, 200)});
  if (wod.notes_coach) parts.push({type: "notes", label: "Note du coach", text: text(wod.notes_coach, 300)});
  return parts.filter(x => x.text);
}

// Le détail du WOD du jour retire la première ligne, car son titre est déjà affiché au-dessus.
export function dailyWodToText(wod, title) {
  const blocks = wod.blocs.map(b =>
    [
      (BLOCK_LABELS[b.type] || b.type) + " :",
      text(b.format, 60),
      b.time_cap_min ? "Time cap " + b.time_cap_min + " min" : "",
      ...(b.mouvements || []).map(m => [m.reps, m.nom, m.charge && "@ " + m.charge].filter(Boolean).join(" ")),
    ]
      .filter(Boolean)
      .join("\n")
  );
  return [title, ...blocks].join("\n\n").slice(0, 2000);
}

// Mise en texte du WOD (2 000 caractères au plus). withTitle : première ligne « titre (~durée) ».
export function wodToText(wod, max = 2000, withTitle = true) {
  // Une rubrique par bloc : « ⚡ METCON — AMRAP 12 min · 15 min », consignes, puis un mouvement par ligne.
  const render = withScaling => {
    const out = withTitle
      ? [text(wod.titre, 120) + (wod.duree_estimee_min ? " (~" + wod.duree_estimee_min + " min)" : "")]
      : [];
    for (const b of wod.blocs) {
      const format = text(b.format, 60),
        details = [
          format,
          b.duree_min && !new RegExp("\\b" + b.duree_min + "\\s*min", "i").test(format) ? b.duree_min + " min" : "",
          b.time_cap_min ? "cap " + b.time_cap_min + " min" : "",
        ].filter(Boolean);
      if (out.length) out.push("");
      out.push(
        [BLOCK_ICONS[b.type], (BLOCK_LABELS[b.type] || b.type).toUpperCase()].filter(Boolean).join(" ") +
          (details.length ? " — " + details.join(" · ") : "")
      );
      if (b.description) out.push(text(b.description, 400));
      for (const m of b.mouvements || []) {
        let line = "• " + [m.reps, m.nom].filter(Boolean).join(" ");
        if (m.charge) line += " @ " + m.charge;
        out.push(line);
        if (withScaling && m.scaling) out.push("   ↳ adapté : " + text(m.scaling, 120));
      }
    }
    if (wod.objectif_score) out.push("", "🏁 Objectif : " + text(wod.objectif_score, 200));
    if (wod.notes_coach) out.push("", "💬 Note du coach : " + text(wod.notes_coach, 300));
    return out.join("\n");
  };
  const full = render(true);
  return (full.length <= max ? full : render(false)).slice(0, max);
}

// ----- WOD commun du jour : un seul WOD par jour pour toute l'application, généré par la tâche planifiée -----
// Aucune donnée personnelle dans la demande : un athlète « type » en box, avec une version adaptée (débutant ou peu de
// matériel) dans le champ "scaling" de chaque mouvement, et le type de score du metcon pour le classement.
export const COMMON_PROMPT_VERSION = "wod-commun-v1";
export const COMMON_SCORE_TYPES = ["time", "reps", "load", "none"];
const COMMON_SYSTEM = `Tu es un coach CrossFit. Tu écris le WOD commun du jour : le même entraînement pour tous les inscrits d'une application, qui pourront comparer leur score.

Règles :
- Séance d'environ 60 minutes : échauffement, éventuellement travail technique ou force, un metcon qui donne un score clair, éventuellement un finisher court.
- Version de référence pour un athlète intermédiaire en box (barre, kettlebells, rameur, barre de traction, box…). Pour chaque mouvement, "scaling" donne la version adaptée aux débutants ou à peu de matériel (mouvement de remplacement et charge allégée), en quelques mots.
- "score_type" : "time" pour un For Time, "reps" pour un AMRAP (tours et répétitions comptés en répétitions), "load" pour une charge maximale, "none" s'il n'y a pas de score.
- Varie les formats et les mouvements par rapport aux WOD communs récents.
- Utilise de préférence les noms de mouvements du catalogue fourni, à l'identique. Charges en kg (homme/femme, ex. « 43/30 kg »), distances en mètres.
- Laisse "description" court (une phrase) ; mets "notes_coach" à null.
- Rédige en français.

${WRITING_RULES}`;
export const COMMON_WOD_SCHEMA = {
  ...WOD_SCHEMA,
  required: [...WOD_SCHEMA.required, "score_type"],
  properties: {...WOD_SCHEMA.properties, score_type: {type: "string", enum: COMMON_SCORE_TYPES}},
};
export function buildCommonPrompt({dateLabel, catalog, recent}) {
  return [
    "Date : " + dateLabel,
    "Mouvements du catalogue : " + catalog.map(m => m.name).join(", "),
    recent.length ? "WOD communs récents : " + recent.map(x => x.date + " — " + x.title).join(" ; ") : "",
  ]
    .filter(Boolean)
    .join("\n");
}
export async function callOpenAICommon(env, prompt) {
  const out = await openAIJson(env, {
    instructions: COMMON_SYSTEM,
    input: prompt,
    name: "wod_commun",
    schema: COMMON_WOD_SCHEMA,
    check: wod => Array.isArray(wod?.blocs) && wod.blocs.length > 0 && COMMON_SCORE_TYPES.includes(wod.score_type),
    refusal: "L'IA a refusé de générer le WOD commun.",
  });
  return out.error ? out : {wod: out.result, model: out.model};
}
