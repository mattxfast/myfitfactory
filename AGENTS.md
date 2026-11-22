# AGENTS.md — myFitFactory

Instructions communes à tous les agents IA qui travaillent sur ce dépôt (Claude Code, Codex ou autre).
Plusieurs agents interviennent **à tour de rôle** : ce fichier est la référence partagée. Lis-le en entier avant toute modification.

## Le projet

myFitFactory (anciennement FitFactory puis CFPlanner ; dépôt GitHub `mattxfast/myfitfactory`, Worker Cloudflare et base D1 : `myfitfactory`, adresse `myfitfactory.mattxfast.workers.dev` ; cookie de session et préférence de thème : `fitfactory_session` et `fitfactory-theme` ; les anciens noms `cfplanner_session` et `cfplanner-theme` restent acceptés pour la transition) est une application web personnelle de planification et de suivi CrossFit : programmes, WOD, séances réalisées, mouvements travaillés et records personnels (PR). L'interface et les messages d'erreur sont en **français**.

## Architecture

- `public/offline.js` : mode hors ligne (cache des lectures, file d'attente des modifications, resynchronisation). Toute nouvelle route d'écriture utilisée hors ligne doit être idempotente au rejeu (`client_id` pour les créations) et, si elle doit s'afficher immédiatement, avoir son application locale dans `patch()`.
- `src/worker.js` : backend Cloudflare Worker (toutes les routes `/api/*`, authentification, migrations applicatives, tâches planifiées).
- `src/ai.js` : génération de WOD par IA (options, prompt modèle, appel de l'API OpenAI en JSON imposé, mise en texte ; WOD du jour avec réglages du chrono), sans dépendance. Clé en secret `OPENAI_API_KEY`.
- `src/nutrition.js` : analyse d'un repas par IA (photo et/ou aliments avec quantité, via `openAIJson` de `src/ai.js`) et validation des repas. La photo n'est jamais conservée.
- `src/foodfacts.js` : fiche produit Open Food Facts par code-barres (lecture, réduction aux champs utiles) ; le Worker la garde 30 jours (`food_products`).
- `src/push.js` : envoi des notifications Web Push (chiffrement RFC 8291, signature VAPID), sans dépendance.
- `public/` : frontend statique servi par le binding `ASSETS` (`index.html`, `style.css`, `manifest.webmanifest`, `sw.js`). Pas de framework, pas d'étape de build.
- `public/js/` : le code de l'interface, en scripts classiques chargés dans l'ordre par `index.html` (portée globale partagée) : `core.js` (état, dates, API, connexion), `sessions.js` (semaine, historique), `programs.js` (programmes, WOD, mouvements), `ai.js` (génération de WOD par IA), `export.js` (Excel), `session-form.js` (saisie de séance), `reminders.js` (rappels), `admin.js`, `prs.js`, `nutrition.js` (alimentation), `scan.js` (produits scannés), `timer.js` (chrono), `daily-wod.js` (WOD du jour), `account.js` (profil, thème), `ui.js` (défilement, service worker), puis `boot.js` (démarrage) **en dernier**. Un nouveau fichier doit être ajouté à `index.html` et à la liste `SHELL` de `sw.js` (en changeant la version du cache). Polices dans `public/fonts/` (DM Sans, Manrope, Saira pour le nom de l'app, OFL) et bibliothèques dans `public/vendor/` (SheetJS 0.18.5, Apache-2.0 ; lecteur de codes-barres zxing-wasm 3.1.7, MIT, chargé au premier scan) : aucune ressource externe chargée par l'application.
- Base de données : Cloudflare D1, binding `DB`.
- `wrangler.toml` : bindings, variable `ADMIN_EMAIL` (compte administrateur), tâches planifiées : 03:17 UTC purge des sessions et tentatives de connexion expirées ; chaque minute, rappels de séance envoyés par paquets de 10, génération du WOD commun du jour (à partir de 5 h) et sa notification (à partir de 6 h, par paquets de 5) (plan gratuit Cloudflare : 10 ms de calcul et 50 requêtes D1 par exécution ; heure de Paris).
- `migrations/0001_init.sql` : socle initial appliqué par Wrangler.

## Méthode de travail (obligatoire)

Les agents poussent **directement sur `main`**. Il n'y a pas de relecture de pull request : ces règles sont la seule protection.

1. **Toujours partir de la dernière version** : `git pull --rebase origin main` avant toute modification. Un autre agent a pu pousser depuis ta dernière intervention.
2. **Ne jamais forcer un push** (`git push --force` et `--force-with-lease` interdits). En cas de conflit, récupère, fusionne proprement, puis pousse.
3. **Le code est formaté avec Prettier** (configuration `.prettierrc`) : lance `npx -y prettier@3.3.3 --write <fichiers modifiés>` avant de committer, et ne reformate pas autrement. Ne modifie que les lignes nécessaires.
4. **Vérifier avant de pousser** :
   - `for f in public/js/*.js public/offline.js public/sw.js; do node --check $f; done`
   - `npx -y prettier@3.3.3 --check src public tests`
   - `cp src/worker.js /tmp/worker.mjs && node --check /tmp/worker.mjs`
   - `node --test tests/*.test.mjs` (tests d'intégration ; ajouter un test pour toute nouvelle route sensible)
   - relire le diff complet (`git diff`) avant de committer.
5. **Un commit par fonctionnalité ou correctif**, avec un message clair en français décrivant le changement. Un retour arrière doit pouvoir se faire par un simple `git revert`.
6. **Mettre à jour le `README.md`** dès qu'une fonctionnalité, une route ou une migration change.
7. **Tenir à jour `ROADMAP.md`**, la liste numérotée des idées partagée avec Matt : cocher une idée réalisée (date et commit), ajouter toute nouvelle idée proposée avec le numéro suivant, ne jamais renuméroter. Quand Matt dit « fais l'idée N », c'est le numéro de cette liste.
8. Un push sur `main` peut partir en production : ne pousse que du code vérifié et complet.

## Base de données et migrations

- Les évolutions de schéma passent par `runMigration("vN-description", ...)` dans `ensureV2Schema` (`src/worker.js`).
- **Toute nouvelle évolution reçoit une nouvelle version** à la suite des existantes. Ne jamais modifier une migration déjà publiée.
- Les migrations sont **additives et idempotentes** (`CREATE ... IF NOT EXISTS`, ajout de colonne seulement si elle manque). Jamais de suppression ni de réinitialisation de données.
- Ajouter les index nécessaires aux nouvelles requêtes.

## Règles de sécurité

- **Requêtes SQL toujours paramétrées** (`?` + `.bind()`). Ne jamais concaténer une valeur venant de la requête.
- **Toute lecture ou écriture est filtrée par `user_id`.** Avant d'écrire dans une table liée (mouvements cochés, plans, thèmes…), vérifier que l'élément parent appartient à l'utilisateur, et renvoyer 404 sinon.
- **Valider côté serveur** toutes les entrées (dates, durées, identifiants, longueurs), même si le front les contrôle déjà.
- Les écritures multiples qui doivent réussir ensemble passent par `env.DB.batch()`.
- **Côté front, tout texte injecté dans du HTML passe par `esc()`.**
- Les routes `/api/admin/*` restent réservées au compte défini par `ADMIN_EMAIL`.
- Aucun secret (mot de passe, jeton, clé) dans le dépôt.
- Ne pas ajouter de script ou de ressource externe sans nécessité ; préférer l'hébergement dans `public/`.

## Frontend et CSS

- Réutiliser les composants et classes existants avant d'en créer de nouveaux.
- Ne pas empiler de nouvelles surcharges CSS : modifier la règle existante plutôt que d'en ajouter une plus spécifique. Pas de `!important` (seule exception : le bloc « réduire les animations » en fin de `style.css`).
- Utiliser les variables CSS de `:root` pour les couleurs et les espacements.
- Interface responsive : vérifier le rendu mobile.

## En fin d'intervention

Résume en quelques lignes ce qui a été modifié, les migrations ajoutées éventuelles, et les points à vérifier par l'utilisateur.
