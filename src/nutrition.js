// Suivi de l'alimentation : analyse d'un repas par IA (photo et/ou aliments saisis avec leur quantité), validation des
// repas enregistrés. La photo n'est jamais conservée : elle n'est transmise qu'à l'API OpenAI le temps de l'analyse.
import {openAIJson} from "./ai.js";

export const MEAL_PROMPT_VERSION = "repas-v2";
export const MEAL_DAILY_LIMIT = 50; // analyses par utilisateur et par 24 h (maîtrise du coût)
export const MEAL_MAX_ITEMS = 30;
export const MEAL_PHOTO_MAX = 2_000_000; // longueur maximale de l'image encodée (data URL), après réduction côté front
// Valeurs nutritionnelles d'un aliment et d'un repas (en kcal ou en grammes) : clé de l'API → clé du schéma de l'IA.
export const NUTRIENTS = {
  kcal: "kcal",
  protein_g: "proteines_g",
  carbs_g: "glucides_g",
  sugars_g: "sucres_g",
  fat_g: "lipides_g",
  sat_fat_g: "satures_g",
  fiber_g: "fibres_g",
  salt_g: "sel_g",
};
const CONFIDENCE = ["faible", "moyenne", "bonne"];

const text = (v, max) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const validTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
// Valeur nutritionnelle : nombre positif arrondi au centième (plafonné pour écarter les valeurs aberrantes).
const amount = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(Math.min(n, max) * 100) / 100 : 0;
};

// Demande d'analyse : une photo et/ou des aliments avec leur quantité, et une précision libre facultative.
export function mealAnalysisInput(b) {
  const items = (Array.isArray(b.items) ? b.items : [])
    .map(x => ({name: text(x?.name, 100), quantity: text(x?.quantity, 40)}))
    .filter(x => x.name);
  if (items.length > MEAL_MAX_ITEMS) return {error: MEAL_MAX_ITEMS + " aliments au plus par repas."};
  const photo = b.photo ? String(b.photo) : "";
  if (photo && (photo.length > MEAL_PHOTO_MAX || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)))
    return {error: "Photo invalide ou trop lourde."};
  if (!photo && !items.length) return {error: "Ajoute une photo ou au moins un aliment."};
  // Produits scannés du même repas : déjà comptés (valeurs de l'étiquette), l'IA ne doit pas les reprendre.
  const known = (Array.isArray(b.known) ? b.known : [])
    .slice(0, MEAL_MAX_ITEMS)
    .map(x => ({name: text(x?.name, 100), quantity: text(x?.quantity, 40)}))
    .filter(x => x.name);
  return {items, photo, note: text(b.note, 300), known};
}

const SYSTEM = `Tu es un nutritionniste. Tu estimes la composition nutritionnelle d'un repas à partir d'une photo et/ou d'une liste d'aliments avec leurs quantités.

Règles :
- Détaille le repas aliment par aliment (un ingrédient visible ou cité par ligne ; regroupe un plat composé seulement si ses ingrédients ne sont pas identifiables).
- Quand une quantité est donnée, utilise-la telle quelle. Sinon, estime la portion d'après la photo (taille de l'assiette, des couverts) ou, sans photo, une portion standard d'adulte.
- Donne pour chaque aliment la masse estimée en grammes (ou le volume converti en grammes) et ses valeurs pour cette quantité : énergie (kcal), protéines, glucides, dont sucres, lipides, dont acides gras saturés, fibres, sel (en grammes).
- Appuie-toi sur les tables de composition usuelles (Ciqual) ; tiens compte du mode de cuisson et des matières grasses visibles (huile, beurre, sauce).
- Les aliments cités par l'utilisateur doivent tous apparaître, avec son nom (corrige seulement l'orthographe). Ajoute ceux visibles sur la photo et non cités.
- Les « produits déjà comptés » ont été scannés : ne les inclus jamais dans ta liste, même s'ils sont visibles sur la photo.
- "confiance" : "bonne" si les quantités sont données, "moyenne" pour une photo nette, "faible" si la photo est ambiguë.
- "remarques" : deux phrases au plus sur l'intérêt nutritionnel du repas pour un sportif (apport en protéines, qualité des glucides, fibres, sel…), sans jugement moral.
- Si l'image ne montre pas de nourriture et qu'aucun aliment n'est cité, renvoie une liste d'aliments vide et explique-le dans "remarques".
- Rédige en français.`;

const number = {type: "number"};
export const MEAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titre", "aliments", "confiance", "remarques"],
  properties: {
    titre: {type: "string"},
    aliments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nom", "quantite", "grammes", ...Object.values(NUTRIENTS)],
        properties: {
          nom: {type: "string"},
          quantite: {type: "string"},
          grammes: number,
          ...Object.fromEntries(Object.values(NUTRIENTS).map(k => [k, number])),
        },
      },
    },
    confiance: {type: "string", enum: CONFIDENCE},
    remarques: {type: ["string", "null"]},
  },
};

// Message envoyé à l'IA : aliments saisis, précision, puis la photo (réduite côté front, jamais conservée).
export function buildMealInput(a) {
  const lines = [
    "## Aliments saisis",
    ...(a.items.length ? a.items.map(x => "- " + x.name + (x.quantity ? " : " + x.quantity : "")) : ["Aucun."]),
    "",
    "## Produits déjà comptés (ne pas inclure)",
    ...(a.known?.length ? a.known.map(x => "- " + x.name + (x.quantity ? " : " + x.quantity : "")) : ["Aucun."]),
    "",
    "Précision : " + (a.note || "aucune"),
    "Photo : " + (a.photo ? "jointe" : "aucune"),
  ];
  const content = [{type: "input_text", text: lines.join("\n")}];
  if (a.photo) content.push({type: "input_image", image_url: a.photo, detail: "auto"});
  return [{role: "user", content}];
}

// Aliment au format de l'API (valeurs nettoyées), depuis la réponse de l'IA ou un repas envoyé par le front.
function itemFrom(x, keys) {
  return {
    name: text(x?.[keys.name], 100),
    quantity: text(x?.[keys.quantity], 40),
    grams: amount(x?.[keys.grams], 5000),
    ...Object.fromEntries(
      Object.entries(NUTRIENTS).map(([k, ai]) => [k, amount(x?.[keys.ai ? ai : k], k === "kcal" ? 10000 : 2000)])
    ),
  };
}
// Produit scanné (Open Food Facts) : code-barres, Nutri-Score et groupe NOVA conservés avec l'aliment.
function scannedFrom(x) {
  if (x?.source !== "off" || !/^\d{8,14}$/.test(String(x.barcode || ""))) return {};
  const grade = String(x.nutriscore || "").toLowerCase(),
    nova = Number(x.nova);
  return {
    source: "off",
    barcode: String(x.barcode),
    nutriscore: /^[a-e]$/.test(grade) ? grade : "",
    nova: [1, 2, 3, 4].includes(nova) ? nova : null,
  };
}
// Totaux du repas : somme des aliments (jamais repris tels quels de l'IA ou du front).
export function mealTotals(items) {
  return Object.fromEntries(
    Object.keys(NUTRIENTS).map(k => [k, Math.round(items.reduce((s, x) => s + x[k], 0) * 100) / 100])
  );
}
const analysisFrom = r => {
  const items = (r.aliments || [])
    .slice(0, MEAL_MAX_ITEMS)
    .map(x => itemFrom(x, {name: "nom", quantity: "quantite", grams: "grammes", ai: true}))
    .filter(x => x.name);
  return {
    title: text(r.titre, 100),
    items,
    totals: mealTotals(items),
    confidence: CONFIDENCE.includes(r.confiance) ? r.confiance : "moyenne",
    remarks: text(r.remarques, 400),
  };
};

export async function analyzeMeal(env, a, userId) {
  const out = await openAIJson(env, {
    userId,
    instructions: SYSTEM,
    input: buildMealInput(a),
    name: "repas",
    schema: MEAL_SCHEMA,
    check: r => Array.isArray(r?.aliments),
    refusal: "L'IA a refusé d'analyser ce repas.",
  });
  return out.error ? out : {raw: out.result, analysis: analysisFrom(out.result), model: out.model};
}

// Repas enregistré (création ou modification) : date, heure, titre, précision et aliments avec leurs valeurs.
export function mealInput(b) {
  const date = String(b.meal_date || ""),
    time = String(b.meal_time || "");
  if (!validDate(date)) return {error: "Date invalide."};
  if (!validTime(time)) return {error: "Heure invalide."};
  if (!Array.isArray(b.items)) return {error: "Aliments manquants."};
  const items = b.items
    .map(x => ({...itemFrom(x, {name: "name", quantity: "quantity", grams: "grams"}), ...scannedFrom(x)}))
    .filter(x => x.name);
  if (!items.length) return {error: "Le repas doit contenir au moins un aliment."};
  if (items.length > MEAL_MAX_ITEMS) return {error: MEAL_MAX_ITEMS + " aliments au plus par repas."};
  return {
    meal_date: date,
    meal_time: time,
    title: text(b.title, 100) || "Repas",
    note: text(b.note, 300),
    items,
    totals: mealTotals(items),
    confidence: CONFIDENCE.includes(b.confidence) ? b.confidence : "",
    remarks: text(b.remarks, 400),
  };
}
