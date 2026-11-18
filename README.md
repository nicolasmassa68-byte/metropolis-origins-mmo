# METROPOLIS ORIGINS MMO — V37 « Renaissance »

Version de développement **à tester avant ouverture publique**. Elle reprend les mécaniques du MMO V34–V36 en gardant **la même base PostgreSQL**.

## Nouveautés

- Refonte des écrans PC, iPhone et Android ; interface adaptative et navigation tactile.
- Terrain 3D continu en remplacement de la mosaïque de blocs, éclairage retravaillé et petits détails sur les bâtiments. La scène reste du **low-poly procédural** : elle n'atteint pas un jeu 3D AAA.
- Comptes joueurs avec e-mail/mot de passe (hachage scrypt), sessions aléatoires dont seule l'empreinte est stockée en base, durée 30 jours.
- Rattachement d'une tribu existante à un compte **sans perdre les habitants, bâtiments, animaux ni recherches**.
- Admin configuré côté Render ; vue globale des joueurs/comptes, statistiques et suspension/réactivation de comptes, avec journal d'audit.
- Les clés anonymes des villages existants restent compatibles pour se connecter **avant association à un compte**. Une fois liée, l'ancienne clé est invalidée.

## Sauvegarder avant déploiement

**Faites une sauvegarde de votre base PostgreSQL** avant tout déploiement. Les migrations `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` sont additives et visent à préserver l'existant, mais elles n'ont pas été testées sur la base Render en production.

## Mettre à jour GitHub (Windows PowerShell)

Décompressez `MetroPolis_Origins_V37_MMO_Refonte_GitHub_Render.zip` dans `C:\Metropolis\V37` (assurez-vous d'avoir `index.html`, `mmo`, `server` directement dans ce dossier).

```powershell
cd C:\Metropolis\metropolis-origins
Copy-Item 'C:\Metropolis\V37\*' . -Recurse -Force
git add .
git commit -m 'V37 Renaissance graphique et comptes MMO'
git push origin main
```

GitHub Pages : dépôt `nicolasmassa68-byte/metropolis-origins-mmo` → Settings → Pages → main / (root). Jeu MMO :
`https://nicolasmassa68-byte.github.io/metropolis-origins-mmo/mmo/`.

## Mettre à jour Render

Le serveur est **modifié** dans cette version : il faut redéployer le service Render `metropolis-origins-mmo` après le push.

- Root Directory : `server`
- Build Command : `npm install`
- Start Command : `npm start`
- `DATABASE_URL` : l'URL PostgreSQL **privée** déjà configurée
- `FRONTEND_ORIGIN` : `https://nicolasmassa68-byte.github.io`
- `ADMIN_EMAIL` : votre adresse e-mail de compte administrateur, à choisir vous-même
- `ADMIN_PASSWORD` : **votre mot de passe admin fort et unique de 12 à 128 caractères, à choisir vous-même**

Aucun mot de passe n'est fourni dans le ZIP. `ADMIN_EMAIL` et `ADMIN_PASSWORD` doivent être configurés dans **Render → Environment**, jamais dans le code ou GitHub. Lors du premier démarrage avec ces valeurs, si l'e-mail n'existe pas encore dans `origins_accounts`, le serveur crée un compte avec rôle `admin`. S'il existe, il lui attribue ce rôle **sans changer son mot de passe**. Le compte administrateur commence sans tribu ; depuis l'interface admin, il peut se créer une tribu personnelle.

**Après le premier démarrage réussi**, vous pouvez enlever `ADMIN_PASSWORD` des variables Render (sans changer les identifiants en base) pour éviter de conserver inutilement un secret d'initialisation. Gardez `ADMIN_EMAIL` si vous le souhaitez. Ne confondez pas un mot de passe serveur et l'URL DATABASE_URL.

Test santé : `https://metropolis-origins-mmo.onrender.com/api/health` doit répondre avec `ok:true` et `version:37`.

La page racine `/` redirige vers `/mmo/`. L’ancien client solo reste archivé sous `/solo/` (non pris en charge par le serveur MMO).

## Récupérer la tribu existante

Sur le **même navigateur** que la V36 : connexion via la clé sauvegardée, puis **Options → Sécuriser cette tribu avec un compte**. Saisissez un e-mail et un mot de passe unique (12 caractères minimum). Le serveur lie les identifiants à la tribu et **invalide l'ancienne clé anonyme**.

Sur un autre navigateur : choisissez « J'ai une ancienne clé de tribu » puis importez la clé privée V34–V36 avant de créer le compte. **Ne choisissez pas « Créer mon compte et mon village » si vous voulez conserver l'ancienne tribu**, car cela crée une autre colonie.

La connexion ultérieure utilise e-mail + mot de passe, sur PC/iPhone/Android. La clé de tribu n'est pas requise après la liaison.

## Administration

Connexion normale avec `ADMIN_EMAIL` et `ADMIN_PASSWORD` → tableau de bord accessible si le compte n'a pas de tribu ; sinon Options → Administration. L'admin voit les derniers comptes et villages et peut suspendre ou réactiver des comptes joueurs. Les autres admins et le compte courant sont protégés contre cette suspension.

## Limites et sécurité à résoudre avant ouverture publique

- Pas de vérification d'e-mail, de réinitialisation de mot de passe ni de protection MFA à ce stade.
- Jetons de session stockés dans le localStorage du navigateur : HTTPS obligatoire, besoin à terme de cookies HttpOnly et d'une CSP stricte.
- Limitation des tentatives en mémoire par instance : pour un public nombreux, utiliser une protection centralisée et un contrôle anti-bot.
- Système de modération et journalisation encore minimal ; prévoir des sauvegardes automatiques.
- Renderer Three.js chargé par CDN ; fonctionnement hors ligne complet non garanti.
- Ne pas confondre **vérifications de syntaxe** avec test multijoueur réel sur Render/PostgreSQL/iPhone ; ce dernier n'a pas été réalisé dans cet environnement.

## Si l'ancien jeu est encore affiché

Ctrl+F5 sous Windows ; sur mobile, fermez le site/PWA et effacez les données du site si nécessaire (attention aux anciennes clés de tribu non exportées). Le cache du service worker MMO utilise `origins-mmo-v37`.
