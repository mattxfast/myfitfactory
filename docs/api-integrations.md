# Intégrations IA et API

Les clés API personnelles permettent à un service externe de lire les données d’un compte myFitFactory. Elles sont rattachées à leur propriétaire et ne donnent accès qu’aux lectures explicitement autorisées. Utilisez une clé distincte pour chaque intégration et transmettez-la avec l’en-tête `Authorization: Bearer <clé>` sur HTTPS.

## Créer, renouveler et révoquer une clé

1. Connectez-vous à myFitFactory et ouvrez **Mon compte → Intégrations IA & API**.
2. Donnez un nom à la clé, cochez les lectures nécessaires et choisissez une date d’expiration. La clé expire au début du jour suivant à 00 h 00 UTC.
3. Cliquez sur **Créer la clé**, puis **Copier la clé**. Sa valeur complète est affichée une seule fois. Enregistrez-la comme secret de l’intégration qui l’utilise.
4. Pour renouveler une clé, créez une nouvelle clé, remplacez le secret dans l’intégration et vérifiez un appel. Révoquez ensuite l’ancienne clé dans la même rubrique. Si une clé a été divulguée, révoquez-la immédiatement.

La liste montre le nom, le préfixe public, les permissions, l’expiration, le dernier usage enregistré et l’état de révocation. Les opérations de gestion exigent une session web active. La création et la révocation exigent aussi un en-tête `Origin` identique à l’origine du site. Le serveur conserve uniquement une empreinte SHA-256 de la clé et ses métadonnées. Une requête Bearer déjà autorisée peut se terminer après la révocation. L’intégration peut conserver les données qu’elle a déjà reçues.

## Routes et permissions

| Méthode et chemin       | Permission      | Paramètres                                                                |
| ----------------------- | --------------- | ------------------------------------------------------------------------- |
| `GET /api/program-data` | `programs:read` | Aucun                                                                     |
| `GET /api/week-data`    | `workouts:read` | `from` et `to`, dates inclusives au format `YYYY-MM-DD`, avec `from ≤ to` |
| `GET /api/prs`          | `prs:read`      | Aucun                                                                     |

Les réponses sont les mêmes qu’avec une session web du propriétaire. Elles incluent aussi les données partagées auxquelles ce compte a accès dans myFitFactory, comme les programmes suivis et les WOD des box dont il est membre validé. La liste ci-dessus couvre toutes les méthodes et routes Bearer. Les écritures, les fonctions d’administration, les paramètres du compte et la gestion des clés restent accessibles via les mécanismes habituels de l’application, selon le rôle de la session.

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

## Erreurs et quotas

Les erreurs renvoient un corps JSON avec un champ `error`.

| Statut | Signification                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------- |
| `400`  | Période manquante ou invalide pour `week-data`                                                 |
| `401`  | Aucune authentification, clé inconnue, invalide, expirée ou révoquée, ou compte désactivé      |
| `403`  | Clé valide sans la permission requise, ou méthode ou route interdite                           |
| `429`  | Quota dépassé. L’en-tête `Retry-After` indique le délai en secondes avant la prochaine fenêtre |
| `500`  | Erreur interne                                                                                 |

Une requête portant un en-tête `Authorization` est traitée comme une requête API, y compris si elle contient aussi un cookie. Le cookie n’est alors pas utilisé. Les requêtes web sans cet en-tête continuent d’utiliser la session.

Le quota est de **60 requêtes par clé** et **120 par compte**, toutes clés confondues, par minute UTC fixe. Les requêtes autorisées comptent dès leur admission, même lorsque le handler renvoie ensuite une erreur de validation. L’indication de dernière utilisation est actualisée au plus une fois par heure pour chaque clé.

## Exemple d’appel

```bash
BASE_URL='https://myfitfactory.mattxfast.workers.dev'
# Jeton fictif, à remplacer par un secret injecté par l’intégration.
MYFITFACTORY_API_KEY='mff_00000000000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/program-data"
curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/week-data?from=2026-11-23&to=2026-11-29"
curl -H "Authorization: Bearer ${MYFITFACTORY_API_KEY}" "${BASE_URL}/api/prs"
```

## Migration D1

Le Worker applique la migration applicative `v47-personal-api-keys` au premier appel API ou à la première exécution planifiée. La migration crée `api_keys`, un index de consultation par propriétaire, `api_user_rates` et un déclencheur SQLite qui associe l’incrément du compteur de clé à celui du compte dans la même écriture atomique. La migration est additive et réexécutable. Elle ne demande ni binding Cloudflare supplémentaire ni migration Wrangler distante distincte.
