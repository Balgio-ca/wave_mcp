# ManCave — Multi TV Universal Remote

Télécommande web auto-hébergée pilotant **plusieurs TV Android groupées par
pièce** depuis un téléphone. Cas d'usage central (man cave) : couper le son de
toutes les TV sauf celle du match, en un tap.

> Ce fichier est le passage de relais. Il décrit l'état réel du projet, les
> décisions structurantes et **ce qui n'a jamais été validé sur matériel**.

---

## Démarrer

```bash
npm install
DATA_DIR=./data PORT=8099 npm start     # http://localhost:8099
npm test                                 # 24 tests unitaires
```

`adb` doit être présent (`brew install android-platform-tools`). L'image Docker
l'embarque. En Docker : `docker compose up -d --build` — **`network_mode: host`
est obligatoire** (pairing mDNS/TLS, adb et scan réseau échouent en `bridge`).

Matériel de l'auteur : Nvidia Shield `192.168.0.70`, TCL Fire TV `192.168.0.13`,
NAS UGREEN `192.168.0.191`.

---

## Architecture

Node 22 ESM + Express, frontend statique d'un seul fichier (vanille, sans
build). Tout l'état persiste dans `DATA_DIR`.

| Fichier | Rôle |
|---------|------|
| `src/catalog.js` | **Source de vérité** : types d'appareils, ports, capacités, guides d'installation |
| `src/drivers.js` | Fabrique + **contrat de pilote** documenté (point d'extension unique) |
| `src/androidtv.js` | Android TV / Google TV : protocole Remote v2 (PIN) + canal adb |
| `src/firetv.js` | Fire TV : adb seul |
| `src/adb.js` | Couche adb **partagée et sérialisée** + volume absolu vérifié |
| `src/devices.js` | Registre persisté (`devices.json`), pièces, migration |
| `src/manager.js` | Une instance de pilote par appareil, cycle de vie à chaud |
| `src/scenes.js` | Moteur de scènes (données, pas code), sensible aux capacités |
| `src/discovery.js` | Scan réseau multi-ports + déduction de type |
| `public/index.html` | UI complète (pièces, scènes, réglages, guides) |

### Les trois idées à ne pas casser

**1. Le mute est en boucle fermée, jamais une bascule aveugle.**
C'est LA leçon du projet : les bascules « à l'aveugle » (`KEYCODE_MUTE`) pilotées
par un état deviné produisent des solos inversés et un comportement erratique.
À la place : lire l'état réel → écrire une valeur **absolue** → **vérifier** par
relecture. Mute = mémoriser le niveau puis écrire 0 ; unmute = restaurer.
Ordre de préférence dans `muteSource` : `volume` (adb, idéal) → `device`
(dumpsys) → `events` (protocole) → `intent` (dernier recours, resync manuel).
**Ne jamais revenir à un toggle non vérifié.**

**2. Un seul verrou adb pour tout le processus** (`withLock` dans `adb.js`).
La connexion adb TCP des TV décroche dès qu'on la frappe en parallèle : c'est ce
qui faisait passer la Fire TV « hors ligne » à chaque changement de volume. Les
décisions composées (lire → décider → écrire) doivent être **entièrement dans le
verrou**, sinon on réintroduit un TOCTOU. Ne jamais appeler `adb()` (verrouillé)
depuis l'intérieur d'un `withLock` → interblocage ; utiliser `adbUnlocked`.

**3. Récupération adb : `disconnect` PUIS `connect`.**
Un simple `adb connect` sur une session « offline » est un no-op — seul le reset
complet la récupère. Idem générations (`_gen`) : elles invalident les
continuations d'une connexion périmée après changement d'hôte.

### Ajouter un type d'appareil

1. Entrée dans `src/catalog.js` (libellé, marques, ports, capacités, **guide**).
2. Pilote respectant le contrat en tête de `src/drivers.js`.
3. L'enregistrer dans `DRIVERS`.

Rien d'autre : découverte, registre, scènes et UI se pilotent par les données.
Un test garantit que chaque type déclaré a un pilote **et** un guide utilisable.

**Capacités** (`mute`, `volume`, `transport`, `dpad`, `power`, `appInfo`,
`pairing`, `adb`) : l'UI masque ce que l'appareil ne sait pas faire, et les
scènes ignorent les appareils incapables au lieu de produire une erreur.

---

## Conventions

- **Interface et messages d'erreur en français.** Les erreurs de pilote
  remontent telles quelles dans `errors[]` — elles doivent être lisibles par
  l'utilisateur final.
- **Les scènes sont best-effort** : une TV hors ligne n'empêche jamais les
  autres. Toujours **200 + `errors[]`**, jamais de 500 global.
- Commentaires en français, expliquant le *pourquoi* (pièges matériels), pas le
  *quoi*.
- Pas de dépendance nouvelle sans raison forte (actuellement : `express` et
  `androidtv-remote` uniquement).

---

## État de vérification — À LIRE

**Vérifié :** 24/24 tests unitaires ; contrat d'API (17 checks) ; migration
depuis l'ancienne config à deux TV, certificat de pairing repris ; UI rendue et
inspectée ; scénarios TV hors ligne.

**JAMAIS validé sur matériel réel — le vrai reste à faire :**
- La refonte du mute en boucle fermée **n'a pas encore tourné sur les TV de
  l'auteur.** Le symptôme d'origine (solos qui s'inversent, Shield qui coupe et
  rétablit le son de façon erratique) est corrigé *en théorie*.
- **Test attendu** : `git pull`, démarrer, appuyer sur **Connecter** sur chaque
  bandeau jusqu'à obtenir `adb connecté`, puis enchaîner les solos et Switch
  plusieurs fois. Le VU-mètre doit descendre à `MUET` et remonter, lu en direct
  sur les TV.
- Le canal adb du **Shield** exige « Débogage réseau » activé (Paramètres →
  Préférences appareil → À propos → Build ×7 → Options développeur). Sans lui,
  le mute retombe en mode `events`, moins robuste.

**Pilote Roku** : `extras/roku.js.disabled` — écrit d'après la doc ECP publique,
**jamais exécuté contre un appareil**. Retiré du produit quand le périmètre a
été recentré sur Android. Ne pas le réactiver sans le tester.

---

## Périmètre

**Dans le périmètre :** OS dérivés d'Android — Android TV / Google TV (Shield,
Chromecast, Sony, Philips, TCL, Hisense, Sharp, Xiaomi, boîtiers, projecteurs
XGIMI/Nebula) et Fire OS (Fire TV, Insignia, Toshiba, TCL/Hisense Fire TV).

**Hors périmètre (décision explicite) :** Roku (ECP), LG webOS (SSAP), Samsung
Tizen. Techniquement atteignables par le même mécanisme — Node 22 a un client
WebSocket natif — mais ce sont des API rétro-conçues, non supportées par les
constructeurs. Pièges connus : chez LG et Samsung la TV coupe son réseau en
veille (allumage = Wake-on-LAN, pas l'API), et Samsung ne publie pas son état de
mute par WebSocket (il faudrait UPnP RenderingControl, variable selon modèle) —
ce qui ferait retomber le mute en mode `intent`.

---

## Suite envisagée

1. **Validation sur les TV réelles** (bloquant pour parler de « production »).
2. UI des scènes personnalisées (le moteur et l'API existent déjà).
3. Port mobile iOS/Android : **clients de la même API HTTP**, rien à réécrire
   côté logique. Attention : les protocoles étant strictement locaux, aucun
   back-end cloud ne peut piloter les TV — soit le serveur reste sur le LAN
   (NAS), soit l'app embarque la couche de contrôle en natif.
4. Sortir le projet dans son propre dépôt (il vit aujourd'hui sous `salon-tv/`
   dans le dépôt `wave_mcp`, ce qui n'a plus de sens).
