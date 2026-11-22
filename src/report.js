// Bilan mensuel : commentaire du coach écrit par l'IA (facultatif), à partir des chiffres du bilan calculés par le Worker.
import {openAIJson} from "./ai.js";

export const REPORT_PROMPT_VERSION = "bilan-mensuel-v1";
const SYSTEM = `Tu es un coach CrossFit bienveillant et précis. Tu écris le commentaire du bilan mensuel d'un athlète.

Règles :
- 3 à 5 phrases courtes, en français, en tutoyant l'athlète.
- Appuie-toi uniquement sur les chiffres fournis : régularité (séances, semaines actives, comparaison au mois précédent), répartition, mouvements travaillés, PR et benchmarks.
- Souligne un point fort concret, puis donne une ou deux pistes concrètes pour le mois suivant (par exemple un mouvement à reprendre ou un rythme de séances).
- Pas de conseil médical, pas de liste à puces, pas de titre.`;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["commentaire"],
  properties: {commentaire: {type: "string"}},
};
const LEVELS = {debutant: "débutant", intermediaire: "intermédiaire", avance: "avancé", competiteur: "compétiteur"};

export async function reportCoachComment(env, r, profile, userId) {
  const sources = {
    prog: "WOD de la programmation",
    box: "WOD de la box",
    daily: "WOD du jour",
    libre: "séances libres",
  };
  const input = [
    `Mois : ${r.month}${r.complete ? "" : " (en cours)"}`,
    `Niveau : ${LEVELS[profile?.level] || "non précisé"} ; objectifs : ${profile?.goals || "non précisés"}`,
    `Séances : ${r.total} (mois précédent : ${r.prev_total}), jours d'entraînement : ${r.days}, semaines actives : ${r.active_weeks} sur ${r.weeks}`,
    "Répartition : " +
      Object.entries(r.by_source)
        .map(([k, v]) => `${sources[k]} ${v}`)
        .join(", "),
    "Mouvements les plus travaillés : " + (r.movements.map(m => `${m.name} (${m.count})`).join(", ") || "aucun coché"),
    "Mouvements travaillés les mois précédents mais pas ce mois-ci : " +
      (r.to_resume.map(m => m.name).join(", ") || "aucun"),
    "PR du mois : " + (r.prs.map(p => p.name).join(", ") || "aucun"),
    "Benchmarks du mois : " +
      (r.benchmarks.map(b => b.name + (b.scaled ? " (Scaled)" : " (Rx)")).join(", ") || "aucun"),
    `Scores saisis sur des WOD de box : ${r.box_scores}`,
  ].join("\n");
  const out = await openAIJson(env, {
    userId,
    instructions: SYSTEM,
    input,
    name: "bilan_mensuel",
    schema: SCHEMA,
    check: x => typeof x?.commentaire === "string" && x.commentaire.trim().length > 0,
    refusal: "L'IA a refusé d'écrire ce commentaire.",
  });
  return out.error
    ? out
    : {
        comment: out.result.commentaire.replace(/\s+/g, " ").trim().slice(0, 1200),
        model: out.model,
      };
}
