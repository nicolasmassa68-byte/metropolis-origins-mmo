# METROPOLIS ORIGINS V37.1 — Correctif menu invisible

Correction **uniquement côté client** : la barre Carte / Construire / Habitants / Familles / Élevage / Options reste visible en bas de l'écran, sur PC, iPhone et Android. Les panneaux s'affichent au-dessus. Le menu ne dépend plus de la hauteur calculée du canvas 3D. Le cache PWA est incrémenté.

## Installer depuis PowerShell

1. Décompresser ce ZIP dans `C:\Metropolis\V37_1`.
2. Copier le contenu à la racine du dépôt local `C:\Metropolis\metropolis-origins`.
3. `git add .`, `git commit -m "V37.1 correction menu visible"`, puis `git push origin main`.
4. Attendre le statut GitHub Pages de publication puis recharger la page avec `Ctrl+F5` ou en fenêtre privée.

**Render et PostgreSQL ne sont pas modifiés**, donc pas besoin de redéployer le serveur. La tribu existante reste enregistrée.

## Vérifications
- Le menu reste visible sur les petites et grandes fenêtres.
- Le panneau Construction apparaît au-dessus de la barre.
- L'API reste celle de la V37 (son `/api/health` affiche toujours version 37).
