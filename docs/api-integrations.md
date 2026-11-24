# Intégrations IA et API

Les clés API personnelles permettent à un service externe de lire les données d’un compte myFitFactory et d’y enregistrer ou modifier des entraînements selon les permissions accordées. Chaque clé est rattachée à son propriétaire. Utilisez une clé distincte pour chaque intégration et transmettez-la avec l’en-tête `Authorization: Bearer <clé>` sur HTTPS.

## Créer, renouveler et révoquer une clé

1. Connectez-vous à myFitFactory et ouvrez **Mon compte → Intégrations IA & API**.
2. Donnez un nom à la clé, cochez les permissions nécessaires et choisissez une date d’expiration. La clé expire au début du jour suivant à 00 h 00 UTC.
3. Cliquez sur **Créer la clé**, puis **Copier la clé**. Sa valeur complète est affichée une seule fois. Enregistrez-la comme secret de l’intégration qui l’utilise.
4. Pour renouveler une clé, créez une nouvelle clé, remplacez le secret dans l’intégration et vérifiez un appel. Révoquez ensuite l’ancienne clé dans la même rubrique. Si une clé a été divulguée, révoquez-la immédiatement.

La liste montre le nom, le préfixe public, les permissions, l’expiration, le dernier usage enregistré et l’état de révocation. Les opérations de gestion exigent une session web active. La création et la révocation exigent aussi un en-tête `Origin` identique à l’origine du site. Le serveur conserve uniquement une empreinte SHA-256 de la clé et ses métadonnées. Une requête Bearer déjà autorisée peut se terminer après la révocation. L’intégration peut conserver les données qu’elle a déjà reçues.

## Routes et permissions

| Méthode et chemin           | Permission       | Paramètres                                                                |
| --------------------------- | ---------------- | ------------------------------------------------------------------------- |
| `GET /api/program-data`     | `programs:read`  | Aucun                                                                     |
| `GET /api/week-data`        | `workouts:read`  | `from` et `to`, dates inclusives au format `YYYY-MM-DD`, avec `from ≤ to` |
| `GET /api/activities`       | `workouts:read`  | Aucun                                                                     |
| `GET /api/movement-catalog` | `workouts:read`  | Aucun                                                                     |
| `GET /api/wod-types`        | `workouts:read`  | Aucun                                                                     |
| `POST /api/sessions`        | `workouts:write` | Objet JSON, voir ci-dessous                                               |
| `PUT /api/sessions/{id}`    | `workouts:write` | Objet JSON partiel et en-tête `If-Match`, voir ci-dessous |
| `GET /api/prs`              | `prs:read`       | Aucun                                                                     |

Les réponses de lecture sont les mêmes qu’avec une session web du propriétaire. Elles incluent aussi les données partagées auxquelles ce compte a accès dans myFitFactory, comme les programmes suivis et les WOD des box dont il est membre validé. La liste ci-dessus couvre toutes les méthodes et routes Bearer. Les clés existantes gardent leurs permissions. Celles disposant déjà de `workouts:write` peuvent aussi modifier des séances avec la V3.1. Les clés avec `workouts:read` peuvent également consulter les trois référentiels communs ci-dessus. La permission `workouts:write` s’accorde explicitement à la création d’une clé. Les méthodes `PATCH` et `DELETE` sont interdites avec une clé API.

### Programmes

```json
{
  "programs": [
    {
      "id": "programme-1",
      "name": "Force",
      "start_monday": "2026-11-23",
      "end_monday": "2026-12-14",
      "followed": 0,
      "read_only": 0
    }
  ],
  "wods": {
    "programme-1": [{"id": "wod-1", "program_id": "programme-1", "name": "Squat", "movement_ids": ["mouvement-1"]}]
  },
  "movements": {"programme-1": [{"id": "mouvement-programme-1", "program_id": "programme-1", "name": "Squat"}]},
  "weeklyWodPrograms": [{"wod_id": "wod-1", "week_start": "2026-11-23", "content": "Squat 5 × 5", "blocks": null}]
}
```

Exemple abrégé. Les objets `wods` et `movements` indexent les listes par identifiant de programme. La programmation hebdomadaire référence un identifiant de WOD. Les dates des programmes suivis tiennent compte du décalage choisi par le propriétaire de la clé.

### Entraînements et planification

```json
{
  "sessions": [
    {"id": "seance-1", "session_date": "2026-11-24", "wod_id": "wod-1", "wod_name": "Squat", "duration_minutes": 60}
  ],
  "flags": [{"week_start": "2026-11-23", "competition": 0}],
  "plans": [{"week_start": "2026-11-23", "wod_id": "wod-1", "wod_name": "Squat"}],
  "checks": [{"session_id": "seance-1", "movement_id": "mouvement-programme-1"}],
  "catalogChecks": [{"session_id": "seance-1", "catalog_movement_id": "mouvement-1"}],
  "boxWods": [],
  "dailyWods": [],
  "tags": [],
  "sharedPartners": []
}
```

Exemple abrégé. `boxWods` inclut les WOD visibles des box sur une période d’au plus 93 jours inclusifs. `dailyWods` contient au plus 60 WOD du jour du compte sur la période. `tags` et `sharedPartners` décrivent les partenaires associés aux séances accessibles.

### Référentiels pour enregistrer un entraînement

| Identifiant                            | Où le trouver                                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity_id`                          | `GET /api/activities` → `activities[].id`. Le référentiel contient les activités actives. Chaque entrée inclut `name`, `duration_minutes`, `is_default` et `is_active`.                                                                  |
| `catalog_movement_ids`                 | `GET /api/movement-catalog` → `movements[].id`. Chaque entrée inclut `name`, `measurement_method` et `category`.                                                                                                                         |
| `type_id`                              | `GET /api/wod-types` → `types[].id`. Chaque entrée inclut `name`.                                                                                                                                                                        |
| `program_id`, `wod_id`, `movement_ids` | `GET /api/program-data` → `programs[].id`, `wods[program_id][].id`, `movements[program_id][].id`. Le champ `movement_ids` d’un WOD de programme contient des identifiants **du catalogue**. Envoyez ceux-ci dans `catalog_movement_ids`. |
| `daily_wod_id`, `box_wod_id`           | `GET /api/week-data` → `dailyWods[].id`, `boxWods[].id`.                                                                                                                                                                                 |
| `score_category_id`                    | Pour un WOD de box avec un score, utilisez une catégorie de sa box. Avec une session web, `GET /api/boxes` fournit `categories[].id` et `categories[].box_id` pour les adhésions validées.                                               |
| `tagged_user_ids`                      | Les identifiants de partenaires proviennent de l’application web.                                                                                                                                                                        |

### Enregistrer une séance

Envoyez `POST /api/sessions` avec `Content-Type: application/json` et une clé ayant `workouts:write`. La séance est enregistrée pour le propriétaire de la clé. L’utilisateur ne se choisit pas dans le corps de la requête.

| Champ                        | Règles                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_date`               | Obligatoire. Date civile au format `YYYY-MM-DD`. Au plus aujourd’hui, heure de Paris, et dans la période applicable du programme.                                                                                                                                                                                                                          |
| `activity_id`                | Obligatoire. Identifiant d’une activité active.                                                                                                                                                                                                                                                                                                            |
| `duration_minutes`           | Obligatoire. Entier JSON de 1 à 600.                                                                                                                                                                                                                                                                                                                       |
| `program_id`, `wod_id`       | Obligatoires pour une séance libre ou de programme. Envoyez les identifiants d’un programme accessible et d’un de ses WOD, ou `"none"` et `"other"` pour une séance libre. Avec `wod_id: "other"`, une séance peut être rattachée à un programme personnel. Si le programme n’appartient pas au compte, la séance est enregistrée dans « Hors programme ». |
| `box_wod_id`, `daily_wod_id` | Facultatifs. Pour un WOD de box ou un WOD du jour, envoyez son identifiant à la place de `program_id` et `wod_id`. Le WOD de box doit être disponible et l’adhésion validée. Le WOD du jour doit appartenir au compte. Si les deux sont fournis, le WOD de box prime.                                                                                      |
| `client_id`                  | Facultatif, recommandé. UUID v4 généré une fois par séance et réutilisé pour chaque tentative. Il devient l’identifiant de la séance, en minuscules. Omettez-le pour laisser le serveur générer un identifiant.                                                                                                                                            |
| `actual_comment`             | Facultatif. Texte libre, tronqué à 3 000 caractères.                                                                                                                                                                                                                                                                                                       |
| `started_at`                 | Facultatif. Horodatage ISO 8601. Si absent ou non reconnu, l’heure de début est estimée à partir de l’heure de réception et de la durée.                                                                                                                                                                                                                   |
| `movement_ids`               | Facultatif. Tableau des identifiants de mouvements du programme sélectionné.                                                                                                                                                                                                                                                                               |
| `catalog_movement_ids`       | Facultatif. Tableau des identifiants du catalogue. Pour « Autres » ou un programme sans mouvements à travailler, tous les mouvements du catalogue sont admissibles, avec un maximum de 200 identifiants distincts. Sinon, seuls les mouvements du catalogue associés au WOD sont admis.                                                                    |
| `type_id`                    | Facultatif. Le WOD l’impose s’il a un type. Pour les autres séances, choisissez un type du référentiel ou omettez-le pour prendre le premier type.                                                                                                                                                                                                         |
| `score_value`                | Facultatif. Utilise le format du WOD. Temps en secondes entières de 1 à 86 400, tours ou répétitions de 1 à 100 000 selon le WOD, ou charge en kg au-dessus de 0 et jusqu’à 1 000. Pour un WOD de référence, le format et les limites dépendent de ce WOD.                                                                                                 |
| `score_type`                 | Facultatif pour un WOD de programme. S’il est fourni avec un score, doit correspondre au type du WOD (`time`, `rounds` ou `load`).                                                                                                                                                                                                                         |
| `score_category_id`          | Obligatoire avec un score pour un WOD de box qui accepte les scores. Utilisez une catégorie de cette box.                                                                                                                                                                                                                                                  |
| `score_scaled`               | Facultatif. Booléen pour un score de WOD de référence. Par défaut, le score est enregistré en Rx.                                                                                                                                                                                                                                                          |
| `tagged_user_ids`            | Facultatif. Tableau contenant jusqu’à 10 identifiants distincts d’autres comptes actifs à qui proposer la séance, selon le fonctionnement habituel de l’application.                                                                                                                                                                                       |

Les doublons dans les listes de mouvements sont ignorés. Un identifiant de mouvement inconnu ou non admissible fait échouer l’enregistrement.

La création et le rejeu réussi renvoient `200 OK` et le même objet. Un rejeu avec le même `client_id` pour le même compte retrouve la séance existante, même lorsque deux requêtes valides sont concurrentes. Il n’applique aucune modification à la séance ou aux mouvements. Un identifiant indisponible renvoie `409`. Sans `client_id`, chaque requête valide crée une séance.

```json
{"ok": true, "id": "c85effbf-6071-4829-82eb-caac7d5720b7"}
```

### Records personnels

```json
{
  "records": [
    {
      "id": "record-1",
      "movement_id": "mouvement-1",
      "movement_name": "Back Squat",
      "measurement_method": "load",
      "category": "lift",
      "record_date": "2026-11-24",
      "value": 100,
      "rep_count": 1,
      "fixed_kind": null,
      "fixed_value": null,
      "created_at": "2026-11-24 18:00:00"
    }
  ]
}
```

`measurement_method` détermine l’unité de `value`. Les formats chronométrés peuvent aussi utiliser `fixed_kind` et `fixed_value` pour indiquer la distance, le nombre de répétitions ou la durée fixée.

## Modifier une séance existante (V3.1)

Envoyez `PUT /api/sessions/{id}` avec une clé `workouts:write`, `Content-Type: application/json` et un en-tête `If-Match` contenant la version de la séance entre guillemets doubles. Lisez `sessions[].id` et `sessions[].edit_version` dans `GET /api/week-data` avec `workouts:read`. Une intégration qui utilise une seule clé pour les deux opérations doit lui accorder les deux permissions.

Le corps contient au moins un des champs ci-dessous. Les champs omis gardent leur valeur, notamment l’heure de début et le score lors d’un changement de durée ou de commentaire. Les champs inconnus sont refusés.

| Champ | Valeur et validation |
| --- | --- |
| `session_date` | Date réelle `YYYY-MM-DD`, sans jour futur et dans la période du programme. |
| `activity_id`, `duration_minutes` | Identifiant d’une activité active et durée entière de 1 à 600 minutes. |
| `actual_comment` | Chaîne tronquée à 3 000 caractères. Une chaîne vide efface le commentaire. |
| `started_at` | Chaîne de date et heure interprétable, telle que `2026-11-24T17:30:00Z`, normalisée en UTC. |
| `program_id`, `wod_id` | Identifiants réels du programme accessible et de son WOD. Pour une séance libre, conservez les identifiants existants ou utilisez des identifiants lus dans l’API. Les raccourcis `none` et `other` du POST ne sont pas acceptés ici. |
| `type_id` | Identifiant du type de WOD. En cas de changement de WOD, son type imposé s’applique automatiquement. |
| `score_value`, `score_type` | Score numérique ou chaîne conforme aux formats de création. Pour retirer le score, envoyez `score_value: null` ou une chaîne vide, sans `score_type`. Avec un score, le type facultatif est `time`, `rounds` ou `load`. Un changement de WOD exige un score compatible, ou un retrait explicite du score existant. |
| `movement_ids`, `catalog_movement_ids` | Chaque tableau fourni remplace uniquement sa propre liste, avec au plus 200 identifiants. Un tableau vide retire tous les mouvements de cette liste. Lors d’un changement de WOD ou de programme, les mouvements conservés doivent être compatibles avec la nouvelle association. |

Seules les séances du propriétaire de la clé sont modifiables. Les séances liées à un WOD de box ou du jour, les séances avec des invitations encore enregistrées et les copies reçues via un partage sont refusées avec `409`. La modification par clé API refuse les champs de partage, de liaison box ou WOD du jour ainsi que `client_id`. La suppression par clé API est interdite.

Une modification réussie renvoie `200`, l’en-tête `ETag` avec la nouvelle version entre guillemets et le corps suivant.

```json
{"ok": true, "id": "seance-1", "edit_version": "nouvelle-version-opaque"}
```

Après une perte de réponse, renvoyez le même corps JSON à l’identique avec le même `If-Match`. Tant qu’aucune modification ultérieure n’est intervenue, un rejeu déjà appliqué renvoie le même succès sans réécrire la séance. Une version devenue obsolète renvoie `412`. Relisez alors la séance avant de décider si la modification doit être réappliquée. Une version manquante renvoie `428`. La séance et les mouvements changent dans une seule transaction D1.

```bash
# SEANCE_ID et EDIT_VERSION proviennent de GET /api/week-data.
curl -X PUT "${BASE_URL}/api/sessions/${SEANCE_ID}" \
  -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" \
  -H "If-Match: \"${EDIT_VERSION}\"" \
  -H 'Content-Type: application/json' \
  --data '{"duration_minutes": 45, "actual_comment": "Séance technique"}'
```

## Erreurs et quotas

Les erreurs renvoient un corps JSON avec un champ `error`.

| Statut | Signification                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------- |
| `400`  | Période invalide pour `week-data` ou corps de séance mal formé, incomplet ou invalide          |
| `401`  | Aucune authentification, clé inconnue, invalide, expirée ou révoquée, ou compte désactivé      |
| `403`  | Clé valide sans la permission requise, ou méthode ou route interdite                           |
| `404`  | Séance, programme, WOD de box ou WOD du jour introuvable ou inaccessible                               |
| `409`  | Identifiant de séance indisponible à la création, ou séance exclue de la modification                                                             |
| `412`  | Version de séance obsolète |
| `415`  | Type de contenu autre que `application/json` pour la création ou la modification |
| `428`  | En-tête `If-Match` absent lors de la modification |
| `429`  | Quota dépassé. L’en-tête `Retry-After` indique le délai en secondes avant la prochaine fenêtre |
| `500`  | Erreur interne                                                                                 |

Une requête portant un en-tête `Authorization` est traitée comme une requête API, y compris si elle contient aussi un cookie. Le cookie n’est alors pas utilisé. Les requêtes web sans cet en-tête continuent d’utiliser la session.

Le quota est de **60 requêtes par clé** et **120 par compte**, toutes clés confondues, par minute UTC fixe. Les requêtes autorisées comptent dès leur admission, même lorsque le handler renvoie ensuite une erreur de validation. L’indication de dernière utilisation est actualisée au plus une fois par heure pour chaque clé.

## Exemples d’appels

```bash
BASE_URL='https://myfitfactory.mattxfast.workers.dev'
# Jeton fictif, à remplacer par un secret injecté par l’intégration.
MYFITFACTORY_API_KEY='mff_00000000000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/program-data"
curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/week-data?from=2026-11-23&to=2026-11-29"
curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/prs"
curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/activities"
curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/movement-catalog"

# Remplacer les identifiants et la date par ceux de la séance à enregistrer.
curl -X POST "${BASE_URL}/api/sessions" \
  -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{
    "client_id": "c85effbf-6071-4829-82eb-caac7d5720b7",
    "session_date": "2026-11-24",
    "activity_id": "activite-1",
    "duration_minutes": 50,
    "program_id": "none",
    "wod_id": "other",
    "catalog_movement_ids": ["mouvement-1"],
    "actual_comment": "Squat, 5 séries de 5 répétitions"
  }'
```

## Migration D1

Le Worker applique la migration applicative `v47-personal-api-keys` au premier appel API ou à la première exécution planifiée. La migration crée `api_keys`, un index de consultation par propriétaire, `api_user_rates` et un déclencheur SQLite qui associe l’incrément du compteur de clé à celui du compte dans la même écriture atomique. La migration est additive et réexécutable. Elle ne demande ni binding Cloudflare supplémentaire ni migration Wrangler distante distincte.

L’enregistrement des entraînements réutilise la table des séances et sa clé primaire. La V3.1 ajoute la migration applicative `v48-session-edit-version`. Elle initialise la version des séances existantes et installe un déclencheur qui attribue une version aux nouvelles séances. Elle s’applique automatiquement et ne requiert ni binding ni commande Wrangler supplémentaire.
