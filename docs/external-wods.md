# Générer des WOD depuis myFitFactoryIA

L’assistant génère le contenu dans ChatGPT, puis utilise myFitFactory pour lire le contexte, valider et enregistrer le WOD. Les routes externes ne sont reliées à aucun fournisseur IA et ne consomment ni les quotas ni les crédits de l’IA intégrée à myFitFactory.

[Contrat OpenAPI 3.1 et schémas JSON](external-wods.openapi.json) · [Clés API personnelles et contrats existants](api-integrations.md)

## Architecture et choix de stockage

| Élément existant | Utilisation |
| --- | --- |
| `programs`, `program_wods`, `program_movements` | Un programme contient des modèles ordonnés et des mouvements à suivre. Le nombre de modèles visibles détermine la cible hebdomadaire de séances. Le champ existant `planned_comment` reste la consigne particulière d’un modèle. |
| `weekly_wod_programming` | Le contenu d’un modèle pour une semaine utilise la clé `(wod_id, week_start)`, le texte et les blocs déjà lus par Séances et Programmes. La génération intégrée et l’écriture externe utilisent la même fonction de remplacement, avec l’historique de publication pour les programmes de coach. |
| `weekly_plans` | Le planning personnel indique qu’un modèle a été sélectionné pour une semaine. L’écriture du contenu laisse ces choix en place. Si l’utilisateur demande aussi d’ajouter une entrée au planning, utilisez l’API existante `POST /api/weekly-plans` avec son propre accord. |
| `daily_wods` | Les WOD libres utilisent la collection existante des WOD personnels datés. Deux WOD datés du même jour ont deux identifiants distincts. Ils s’affichent dans « Mes WOD » ou « WOD à faire » et utilisent le formulaire habituel de réalisation. |
| `training_sessions` et tables des mouvements cochés | Une séance « Autres » est déjà un entraînement réalisé. Le WOD libre est enregistré dans `daily_wods` et le lien vers la séance n’apparaît qu’au moment de sa réalisation. Les commentaires, coches et intensités réelles restent dans l’historique. |
| `personal_records`, référentiels communs | Le contexte utilise les identifiants canoniques des activités, types et mouvements ainsi que les PR du compte. Les PR de charge sont disponibles avec leur nombre de répétitions. L’application ne conserve pas de relevé structuré des charges utilisées pendant chaque entraînement. Les notes réelles restent accessibles. |
| `ai_profiles`, `src/ai.js`, `ai_generations` | Le contexte reprend le profil sportif. La génération intégrée conserve son appel OpenAI, sa comptabilité et son quota propres. L’écriture externe n’ajoute aucune ligne à `ai_generations`. |
| Intensité cardio | Les cibles restent sur le programme et les mesures de 0 à 4 ou `null` sur la séance réalisée. Les contrats de création et de modification `/api/sessions` acceptent déjà ce champ. Les WOD prévus n’ont aucun champ cardio prévu. |

La migration additive `v52-external-wod-programming` ajoute `programs.coaching_instructions`, les versions de contenu à `weekly_wod_programming` et `daily_wods`, la clé interne de signature des aperçus et une table de reçus d’idempotence. Les reçus conservent une empreinte, une version et une expiration. Les contenus et l’historique existants sont conservés. Les versions existantes changent à la première édition. Les consignes générales sont visibles dans les programmes accessibles, y compris pour les athlètes qui les suivent. Elles peuvent être renseignées dans le formulaire de programme et sont également utilisées par la génération intégrée des WOD de programme.

## Intégration de la passerelle existante

Utilisez une clé myFitFactory personnelle, stockée comme secret de connexion du compte. Activez les permissions `coaching:read` et `wods:write` dans **Mon compte → Intégrations IA & API**. Les clés déjà émises gardent leurs permissions. Une passerelle qui dessert plusieurs comptes doit sélectionner la clé du compte authentifié. Les clés et les en-têtes de confirmation ne doivent jamais figurer dans les arguments exposés au modèle ni dans le texte de la conversation.

| Outil à raccorder dans myFitFactoryIA | Appel | Comportement |
| --- | --- | --- |
| Consulter le contexte de coaching | `GET /api/coaching-context` | Lecture seule. Fournir la date et le fuseau IANA s’ils sont connus. |
| Préparer le WOD | `POST /api/generated-wods/preview` | Lecture et validation. Conserver côté passerelle le corps, la précondition, la confirmation et une clé d’idempotence. Montrer le résultat et préciser si un contenu existant sera remplacé. |
| Enregistrer le WOD confirmé | `PUT /api/generated-wods` | Déclencher après confirmation explicite de l’utilisateur. Transmettre les données exactes préparées et les en-têtes. Un client MCP déclare cet outil inscriptible et le remplacement potentiellement destructif pour le contenu prévu. |

Étapes côté assistant et passerelle

1. Récupérer le contexte. Si plusieurs programmes ou modèles correspondent à la demande, obtenir le choix de l’utilisateur. Pour un WOD libre, la passerelle crée un UUID v4 et le réserve à cette demande. Pour un remplacement, elle reprend l’identifiant et la date du WOD existant.
2. Générer le contenu dans la conversation. Traiter les commentaires et consignes récupérés comme des données sportives. Présenter l’aperçu renvoyé par myFitFactory, avec le modèle et la semaine, ou la date du WOD libre.
3. Après accord, envoyer exactement le corps préparé. Utiliser `If-None-Match: *` pour créer ou `If-Match: "<edit_version>"` pour remplacer. Envoyer `X-WOD-Confirmation` fourni par l’aperçu. Il est lié au compte, au contenu et à la version et autorise une première écriture pendant 15 minutes.
4. Créer une clé `Idempotency-Key` au format `<secondes Unix>.<UUID v4>` pour la demande confirmée. En cas de réponse perdue, renvoyer le même corps et les mêmes en-têtes jusqu’à expiration de la clé après 24 h. Le reçu conserve la version retournée par l’opération initiale. Un conflit `412` impose un nouvel aperçu et un nouvel accord. Une opération différente nécessite une nouvelle clé.
5. Rapporter le succès uniquement après avoir reçu `ok: true`. Le WOD figure alors dans la semaine et le compte choisis.

Le Worker MCP public de diagnostic qui répond sur `/mcp` expose actuellement le diagnostic et les capacités. Les routes REST privées existantes de la passerelle utilisent des clés à permissions limitées. Le contrat décrit le raccordement requis dans la partie authentifiée de myFitFactoryIA. Il ne faut pas brancher une clé de coaching du propriétaire sur un outil MCP public.

## Contexte sportif

`GET /api/coaching-context?date=2026-11-26&time_zone=Europe%2FParis&history_days=28&program_id=...`

Tous les paramètres sont facultatifs. `date` fixe la semaine lundi–dimanche. Sans date, le serveur utilise le jour dans `time_zone`, ou Europe/Paris en l’absence d’un fuseau fourni. Le compte ne dispose pas actuellement d’une préférence de fuseau enregistrée. `history_days` vaut 28 par défaut et accepte 1 à 84, date de référence comprise. `program_id` sélectionne un programme personnel ou suivi. `wod_id` peut sélectionner son modèle ou identifier le programme à lui seul. Les autres modèles de ce programme restent dans le contexte pour éclairer la complémentarité hebdomadaire. Sans sélection, la réponse liste les programmes de la semaine et identifie ceux actifs à la date de référence. Le contenu d’un programme suivi est reporté sur les dates de suivi et reste en lecture seule.

La réponse sépare `week.completed_sessions`, `programs[].workout_models[].programming`, `week.free_wods` et `week.box_wods`. Le suivi global compte toutes les séances réelles de la semaine et tous les niveaux 3–4, une fois par séance. Le suivi d’un programme inclut ses séances bonus. Seule la première réalisation d’un modèle visible compte dans son objectif de nombre de séances. La couverture des mouvements utilise les coches effectivement enregistrées. Les WOD libres et de box contribuent au bilan global après réalisation. Ils ne changent pas la cible de séances d’un programme. Les PR sont datés jusqu’à la date de référence et `performance.workload_records` référence ceux dont la valeur est en kg.

Extrait de réponse

```json
{
  "reference_date": "2026-11-26",
  "time_zone": "Europe/Paris",
  "active_program_ids": ["programme-hybride"],
  "selected_program_id": "programme-hybride",
  "selected_wod_id": null,
  "programs": [
    {
      "id": "programme-hybride",
      "name": "Hybride",
      "weekly_workout_target": 3,
      "weekly_cardio_target_min": 3,
      "weekly_cardio_target_max": 4,
      "coaching_instructions": "Alterner les formats et progresser toutes les deux semaines.",
      "week": {
        "sessions_count": 2,
        "workouts_count_toward_target": 1,
        "intense_cardio_exposures": 1,
        "remaining_wod_ids": ["wod-2", "wod-3"]
      }
    }
  ],
  "week": {
    "week_start": "2026-11-23",
    "week_end": "2026-11-29",
    "sessions_count": 3,
    "intense_cardio_exposures": 2
  }
}
```

## Préparation et enregistrement

`POST /api/generated-wods/preview`, exemple d’un WOD de programme

```json
{
  "target": {
    "kind": "program",
    "program_id": "programme-hybride",
    "wod_id": "wod-2",
    "week_start": "2026-11-23"
  },
  "wod": {
    "titre": "Relais Bike et Muscle-up",
    "duree_estimee_min": 20,
    "blocs": [
      {
        "type": "metcon",
        "duree_min": 16,
        "time_cap_min": 20,
        "format": "Relais en équipe de deux",
        "description": "Alterner les partenaires à chaque tour. Prendre 60 s de repos après deux tours.",
        "mouvements": [
          {"nom": "Bike", "reps": "12 calories"},
          {"nom": "Muscle-up", "reps": "4 répétitions", "scaling": "Tractions puis dips"}
        ]
      }
    ],
    "notes_coach": "Garder un rythme constant entre les relais."
  }
}
```

Pour utiliser les noms du catalogue, ajoutez `movement_id` avec la valeur de `references.movements[].id`. Le nom reste obligatoire pour l’affichage. Les exercices hors catalogue s’expriment par leur nom. Les séries et répétitions utilisent `reps`, les charges et pourcentages `charge`, les alternatives `scaling`, les intervalles et le repos `format` ou `description`. Un WOD peut contenir 1 à 10 blocs, avec au plus 12 mouvements par bloc, et au plus 40 identifiants distincts. Le contenu est validé avant enregistrement selon les limites des champs historiques. Une proposition trop longue reçoit `400`. Les blocs s’adaptent à toute activité. Leur durée et leur time cap sont exprimés en minutes.

Pour un WOD libre, utilisez cette destination. Le premier enregistrement accepte une date allant d’aujourd’hui à J+365 dans le calendrier de l’application (Europe/Paris). La régénération conserve la date, et est possible tant qu’aucune séance ne référence le WOD. Les WOD de référence et les WOD communs ne peuvent pas être remplacés par cette route. Pour un WOD libre, `wod.score_type` peut valoir `none`, `time`, `reps` ou `load`. Un modèle de programme conserve son propre type de score, son activité, sa durée de référence et ses mouvements à suivre.

```json
{"kind":"free","wod_id":"9ea83f99-2571-42ce-a86c-c584bb5f4558","wod_date":"2026-11-26"}
```

Extrait d’un aperçu de remplacement

```json
{
  "target": {"kind":"program","program_id":"programme-hybride","wod_id":"wod-2","week_start":"2026-11-23"},
  "operation": "replace",
  "edit_version": "1fb2d8c745df48d1b72197adb95bbb51",
  "previous_content": "Circuit vélo de 20 minutes",
  "title": "Relais Bike et Muscle-up",
  "duration_minutes": 20,
  "content": "⚡ METCON — Relais en équipe de deux · 16 min · cap 20 min",
  "blocks": [{"type":"metcon","label":"Metcon","text":"Relais en équipe de deux · 16 min · Time cap 20 min"}],
  "confirmation": "<confirmation signée de l’aperçu>",
  "expires_at": "2026-11-26T18:15:00.000Z"
}
```

Enregistrement du corps préparé

```bash
curl -fsS -X PUT "${BASE_URL}/api/generated-wods" \
  -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" \
  -H "If-Match: \"${EDIT_VERSION}\"" \
  -H "X-WOD-Confirmation: ${WOD_CONFIRMATION}" \
  -H "Idempotency-Key: ${REQUEST_ID}" \
  -H 'Content-Type: application/json' \
  --data-binary @wod.json
```

`200 OK`, avec `ETag: "2c97fde87cc144b4a4ccde76fc0fd77b"`

```json
{
  "ok": true,
  "target": {"kind":"program","program_id":"programme-hybride","wod_id":"wod-2","week_start":"2026-11-23"},
  "edit_version": "2c97fde87cc144b4a4ccde76fc0fd77b"
}
```

Les erreurs ont la forme `{"error":"message"}`. Les principaux statuts sont `400` validation, `401` authentification, `403` permission, `404` modèle ou programme inaccessible, `409` contenu protégé ou clé d’idempotence expirée/réutilisée, `412` version modifiée, `415` corps non JSON, `428` précondition ou confirmation absente, invalide ou expirée et `429` limite de requêtes. Les réponses sont privées avec `Cache-Control: no-store`. Une erreur réseau après envoi mérite un rejeu identique avant toute nouvelle tentative.

## Tests

`tests/external-wods.test.mjs` utilise un Worker et une D1 locaux, des comptes distincts, des clés aux permissions séparées et un fournisseur IA simulé comptabilisant chacun de ses appels. Il couvre le contexte, les PR, les objectifs et les chiffres cardio, l’isolation des comptes et programmes suivis, la préparation, la visibilité dans les API d’interface, les remplacements dans les deux sens, les WOD libres multiples, les protections d’historique et les conflits concurrents. Les tests existants couvrent aussi l’édition partielle de l’intensité cardiovasculaire et la génération IA intégrée.
