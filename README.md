# METROPOLIS ORIGINS MMO V35 — correctif visuel immédiat

Cette version réutilise le serveur et la base PostgreSQL de V34 sans modifier leurs données.

## Corrections du rendu
- Caméra initiale centrée sur la colonie du joueur au lieu du centre vide du secteur.
- Zoom plus proche avec réglages de zoom plus fins pour souris et écran tactile.
- Nuit plus lisible : éclairage minimum renforcé, ciel moins noir.
- Brouillard de guerre en couleurs variées et légère hauteur pour éviter l’effet dalle unie, sans dévoiler les biomes inconnus.
- Anticrénelage WebGL et détails près des huttes.
- Cache PWA V35 pour forcer la mise à jour après publication.

## Déploiement Windows — aucune modification Render nécessaire
Depuis C:\Metropolis\metropolis-origins, décompresser le ZIP et remplacer les fichiers ; puis :

```powershell
git add .
git commit -m "V35 correctif camera et rendu 3D"
git push origin main
```

GitHub Pages met à jour l’interface. Render V34 reste inchangé ; PostgreSQL et les tribus existantes sont conservés.

## Limites
Cette version corrige la composition visuelle et la lisibilité ; elle ne remplace pas les objets géométriques simplifiés par des modèles 3D professionnels. Le rendu iPhone/PC et le gameplay doivent être testés après déploiement. Ne pas décompresser le ZIP dans un dossier supplémentaire du dépôt : index.html et mmo doivent rester à la racine.
