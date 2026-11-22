# Feuille de route — idées et évolutions

Liste partagée par tous les agents et par Matt. Chaque idée a un **numéro définitif** (on ne renumérote jamais) : on peut
dire « fais l'idée 7 ».

- Idée faite : cocher la case (`[x]`) et ajouter la date et le commit en fin de ligne ; on peut la déplacer dans
  « Fait » plus tard.
- Idée abandonnée : la barrer (`~~…~~`) en disant pourquoi, sans la supprimer (le numéro reste pris).
- Nouvelle idée : l'ajouter dans la bonne rubrique avec le **numéro suivant le plus grand existant**.
- *En italique* : la décision de Matt quand il y en a une.

Prochain numéro libre : **42**

## Fiabilité et exploitation

- [ ] **1.** Sauvegardes automatiques de la base D1 (copie hebdomadaire dans R2, en plus du Time Travel de 30 jours). *Reporté à plus tard.*
- [x] **2.** Supprimer l'ancien Worker `fitfactory` (page « déménagé ») et l'ancienne base D1 `fitfactory`. *Après validation de Matt.* — fait le 19/11/2026
- [ ] **3.** Envoi des e-mails « mot de passe oublié » : compte Resend, secret `RESEND_API_KEY`, variable `MAIL_FROM` (voir README, Configuration). *Matt : mis de côté pour le moment (dépend de l'idée 6, nom de domaine).*

## Déploiement

- [ ] **4.** Branche `dev` déployée sur une adresse de test, pour valider avant la production. *Prévu plus tard.*
- [x] **5.** Contrôle automatique sur GitHub (GitHub Action : `node --check`, Prettier, tests) à chaque push. — fait le 19/11/2026 (`.github/workflows/verifications.yml`)
- [ ] **6.** Nom de domaine propre (par exemple `myfitfactory.fr`) au lieu de `workers.dev`.

## Code

- [x] **7.** Finir le nettoyage du CSS : supprimer les `!important` restants de `style.css` (52 au 19/11/2026, 374 au départ). — fait le 19/11/2026 : 50 retirés sans aucun changement de rendu (styles calculés comparés sur 116 états × 4 thèmes, mobile et grand écran) ; restent les 2 du réglage « réduire les animations », où ils sont l'usage normal
- [x] **8.** Tests : éviter les collisions de ports entre fichiers de test (port choisi au hasard dans 8790–8889) et les serveurs `wrangler dev` restés ouverts, qui font échouer des tests sans raison. — fait le 19/11/2026 (`ff06c92`, `03c6a78`)

## Fonctionnalités

- [x] **9.** Graphiques de progression : séances par semaine, répartition par WOD et par mouvement, régularité. Page PR, rubrique Progression (depuis la semaine de la première séance enregistrée). — fait le 21/11/2026 (`8ec7539`)
- [x] **10.** Score des WOD de la programmation (temps, tours, charge) avec historique personnel par WOD. — fait le 22/11/2026 (`920628b`)
- [ ] **11.** Objectifs : nombre de séances par semaine ou PR cible, avec une jauge. *Pas maintenant.*
- [ ] **12.** Calculateur de charges : pourcentages des PR (WOD « à 75 % du 1RM »).
- [ ] **13.** Rappeler le dernier commentaire laissé sur le même WOD au moment d'enregistrer une séance.
- [x] **14.** WOD du jour : WOD de référence tirés au hasard (Fran, Cindy, Murph…), sans IA, gratuits et hors ligne. Résultats suivis dans la page PR (rubrique Benchmarks). — fait le 21/11/2026 (`1127792`)
- [ ] **15.** WOD du jour : mode « Mon coach » (WOD proposé chaque matin, semaine équilibrée, notification possible).
- [ ] **16.** WOD du jour : privilégier les mouvements peu travaillés ces dernières semaines.
- [ ] **18.** Affichage dynamique sur un écran dans la box (WOD du jour, scores, anniversaires, mot du jour, événements) : voir le détail plus bas.
- [x] **31.** Score de fitness de l'athlète (0–100) : régularité, force (PR rapportés au poids de corps), gym, engine, polyvalence, progression ; radar par pilier et score global, calculé à partir des données déjà saisies (profil à compléter : poids, sexe, année de naissance, facultatifs). — fait le 20/11/2026 (page PR)
- [x] **32.** PR Engine en « temps sur une distance » ou « distance dans un temps » (allure au km / au 500 m, historique, courbe) et pilier Engine du score de forme. — fait le 20/11/2026
- [ ] **33.** Widget iOS (écran d'accueil / écran verrouillé) : WOD du jour, prochaine séance, séances de la semaine. Demande une vraie app iPhone (Swift, WidgetKit) en plus de l'app web, un compte Apple Developer (99 €/an) et une connexion par jeton pour l'app native. *À décider par Matt.*
- [ ] **34.** Application Apple Watch : chrono de WOD au poignet (rounds, EMOM, Tabata) avec vibrations, WOD du jour affiché, séance enregistrée à la fin. Même prérequis que l'idée 33 (app native, compte Apple Developer) ; à faire avec ou après le widget. *À décider par Matt.*
- [ ] **38.** Widget iOS « léger », sans app native : l'app gratuite Scriptable affiche un widget (écran d'accueil ou verrouillé) à partir d'un petit script JavaScript fourni par myFitFactory, qui lit une route en lecture seule (WOD du jour, WOD de la semaine, séances faites) protégée par un jeton personnel révocable, généré dans « Mon compte ». Pas de compte Apple Developer ; mise à jour du widget toutes les 15 min à quelques heures selon iOS. Alternative à l'idée 33. *À décider par Matt.*
- [x] **39.** Bilan mensuel : récapitulatif du mois écoulé (séances, régularité, répartition, mouvements, PR, scores, score de forme), consultable dans l'app et annoncé par notification le 1er du mois ; commentaire de coach par IA en option. Bandeau dans Séances (7 premiers jours), notification le 1er, rubrique Bilans mensuels de la page PR. — fait le 21/11/2026 (`bb04b75`)
- [x] **41.** Alimentation : scanner un produit (code-barres, caméra ou saisie) pour reprendre les valeurs de l'étiquette depuis Open Food Facts, en grammes ou en portions, sans IA ; Nutri-Score et NOVA dans le détail du repas, part des calories ultra-transformées (NOVA 4) dans le bilan du jour. Pas de liste de produits récents (choix de Matt). — fait le 21/11/2026 (`a8f6614`, `415f465`)
- [x] **40.** Onglet « Mon fitness » (à la place de « PR ») : sous-onglets Forme (score de forme, progression), Records (PR, benchmarks), Bilans (bilans mensuels). — fait le 21/11/2026 (`07249eb`)
- [x] **35.** Interface simplifiée par défaut pour les nouveaux comptes, au choix dans Mon compte → Apparence : page Séances réduite à l'historique puis aux mouvements travaillés (sans rubriques WOD de la programmation, de la box ni WOD du jour), onglet Programmes masqué ; le formulaire de séance propose toujours tous les WOD. — fait le 21/11/2026
- [x] **36.** Programmes : champ du WOD renommé « Thématique / Structure », repris dans la consigne particulière de la génération par IA (un WOD ou tout le programme). — fait le 21/11/2026 (`f440f06`)
- [x] **37.** Programmes : mouvements à travailler propres à chaque WOD, repris par la génération IA et cochés par défaut dans la séance. — fait le 21/11/2026 (`247cc58`)
- [x] **36.** Taguer des partenaires sur une séance : invitation (pastille rouge sur l'onglet Séances, rubrique « Séances partagées »), acceptation qui copie la séance dans son historique (copie indépendante) ou refus. — fait le 21/11/2026
- [x] **37.** Notification push quand on est tagué sur une séance (en plus de la pastille rouge), pour les comptes qui ont activé les notifications. — fait le 21/11/2026
- [x] **41.** Page Séances : plus de rubrique « WOD du jour » séparée (doublon de la séance « Autres », écran alourdi). Les WOD du jour (IA ou WOD de référence) s'affichent « en plus » en fin de rubrique « WOD de la programmation », rattachés à aucun programme et hors de son compteur (« +N ») ; boutons 🎲 et ✨ dans le titre de cette rubrique. — fait le 22/11/2026

## Look and feel

- [ ] **19.** Thèmes de couleur supplémentaires dans « Apparence » : orange, rose, vert citron (maquettes faites le 19/11/2026). *Matt doit choisir.*
- [ ] **20.** Bordure un peu plus foncée pour les blocs « pas de contenu », sur toutes les pages.
- [x] **21.** WOD de la box déjà fait : retirer aussi son bouton ＋ (comme pour la programmation). — fait le 19/11/2026
- [x] **22.** Mouvements cochés d'office par le WOD du jour : reconnaître aussi les variantes de noms (« Wall ball » / « Wall balls », pluriels, abréviations). — fait le 19/11/2026
- [ ] **23.** Écrans de démarrage et icône : vérifier le rendu sur Android (icône « maskable »).

## Écartées

- ~~**17.** WOD du jour : proposer d'abord le WOD de la box du jour s'il existe, l'IA en alternative.~~ *Matt : ne sera pas fait.*
- ~~**24.** Accessibilité : respecter « réduire les animations », renforcer les contrastes.~~ *Matt : non.*

## Fait

- [x] **25.** Logs du Worker, limitation des tentatives de connexion, bibliothèque Excel et polices hébergées dans l'app.
- [x] **26.** Rappels par notification, mode hors ligne avec resynchronisation, chronomètre de WOD.
- [x] **27.** Renommage en myFitFactory (dépôt, Worker, base D1), icône et écran de démarrage, police Saira.
- [x] **28.** WOD du jour généré par IA, chrono préréglé, séance enregistrée plus tard (19/11/2026, `3480ad8`). Fenêtre de génération commune aux autres WOD avec choix de la date et rendu au format tableau blanc le 22/11/2026.
- [x] **29.** Programmes : bouton ✨ sur chaque semaine de la programmation hebdomadaire pour regénérer ce WOD pour cette semaine seulement. — fait le 20/11/2026 (`77012e8`)
- [x] **35.** Texte des WOD générés par IA structuré : une rubrique par bloc choisi (icône et titre), consignes courtes, un mouvement par ligne. — fait le 21/11/2026 (`06523ed`)
- [x] **30.** Attente de l'IA plus agréable : étoiles animées, coche verte à l'arrivée du résultat, effet scanner sur la photo du repas. — fait le 20/11/2026 (`5bd97d3`)

## Détails des idées

### 18. Affichage dynamique sur un écran dans la box

Un écran installé dans la salle fait défiler des informations sur la box : WOD du jour, scores, anniversaires, mot du jour, événements.

#### Contenu

- **Depuis les données de l'application** :
  - WOD du jour de la box (WOD de box existants).
  - Scores et classements des WOD (classements de box existants, par catégorie RX / Inter / Scaled).
  - Anniversaires des membres. Il faudra ajouter une date de naissance au profil, avec une case « Afficher mon anniversaire sur l'écran de la box ». On n'affiche que le jour et le mois, jamais l'âge.
- **Saisi par le gestionnaire de la box** (nouvelle page dans l'espace gestionnaire) :
  - Mot du jour.
  - Événements sociaux : plusieurs en même temps, chacun avec une période d'affichage (dates de début et de fin).

#### Principes

- Plusieurs box : chaque box a son propre écran et son propre contenu.
- Une page dédiée (par exemple `/ecran`) en plein écran, sans interaction. Elle fait tourner des cartes (WOD, scores, anniversaires, mot du jour, événements), chacune avec une durée d'affichage. Une carte sans contenu est sautée.
- Authentification par un **jeton d'écran** propre à la box : lecture seule, généré et révocable par le gestionnaire. On ne laisse pas de session utilisateur ouverte sur un écran public.
- Une seule route qui renvoie tout le contenu de l'écran, interrogée toutes les 1 à 5 minutes, avec un cache côté Worker (limites du plan gratuit Cloudflare).
- Vie privée : un membre doit pouvoir choisir de ne pas apparaître sur l'écran (scores, anniversaire). Afficher le prénom et l'initiale du nom plutôt que le nom complet.

#### Matériel (à décider)

- Idéalement une TV avec navigateur intégré, sinon un Raspberry Pi en mode kiosque.
- Prévoir une mise en page lisible de loin (grands caractères, fort contraste), en 16:9, et éviter que l'écran se mette en veille.
