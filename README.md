# METROPOLIS ORIGINS MMO V34 — Correctif tactile et fiches des constructions

Cette version corrige les deux problèmes remontés sur la V33 :

1. **Construction en deux étapes** : Construire → toucher un bâtiment pour ouvrir sa fiche → « Choisir … et placer » → toucher une case sur la carte → aperçu 3D translucide + coûts → Confirmer / Annuler. Le serveur ne reçoit `/api/build` qu'après la confirmation.
2. **Fiches de bâtiments accessibles** : toucher un nom de bâtiment ouvre la fiche (description, coût, rôle, restrictions) au lieu de devoir viser un petit bouton ⓘ.
3. **Toucher mobile fiabilisé** : tolérance de 12 pixels aux tremblements du doigt, temps de toucher de 850 ms, et rotation activée seulement lors d'un véritable glissement.
4. Les fiches de métiers et ressources sont conservées.
5. Version du service worker montée à v34 pour rafraîchir le cache.

## Mettre à jour

- Sauvegarder la base PostgreSQL et la clé de tribu.
- Décompresser le ZIP et remplacer les fichiers du dépôt GitHub par ceux du dossier, sans envoyer le ZIP lui-même.
- Déployer le dossier `server` sur Render comme auparavant ; l'API `/api/health` indique `version: 34`.
- Dans Safari, recharger `/metropolis-origins/mmo/`. Si l'ancienne version reste visible, fermer l'app ajoutée à l'écran d'accueil et ouvrir le site dans un nouvel onglet Safari ; éventuellement effacer les données de site après avoir exporté la clé de tribu.

Le code de l'API de construction côté serveur et la base de données ne changent pas. Pas de migration PostgreSQL requise.

## Limites des tests

Tests de syntaxe et vérifications statiques effectués. Le rendu tactile sur Safari iPhone et l'intégration avec PostgreSQL/Render restent à valider sur les appareils réels.
