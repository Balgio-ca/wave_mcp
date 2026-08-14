# extras

Code conservé mais **hors du produit**.

## roku.js.disabled

Pilote Roku (ECP / HTTP, port 8060), écrit d'après la documentation publique
mais **jamais validé sur un appareil réel**. Retiré quand le périmètre a été
recentré sur les OS Android.

Pour le réactiver :
1. `cp extras/roku.js.disabled src/roku.js`
2. Ajouter l'entrée `roku` dans `src/catalog.js` (voir le commit `a54de8c`)
3. L'enregistrer dans `DRIVERS`, `src/drivers.js`
4. **Le tester sur un vrai Roku avant de s'y fier.**
