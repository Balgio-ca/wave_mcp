# ManCave — Multi TV Universal Remote

**Contrôle plusieurs TV depuis ton téléphone.** Télécommande web auto-hébergée
qui pilote tous tes téléviseurs, quelle que soit leur marque, groupés par
pièce, sur un seul écran. Un tap coupe le son de toutes les TV sauf celle du
match.

Prend en charge **Android TV / Google TV** (Nvidia Shield, Chromecast, Sony,
TCL, Philips, Hisense, Xiaomi…), **Fire TV** (Amazon) et **Roku**
(expérimental) — et le squelette est conçu pour qu'ajouter une marque
supplémentaire soit une entrée de catalogue plus un pilote, sans toucher au
reste. Voir [Ajouter un type d'appareil](#ajouter-un-type-dappareil).

> Nom au format ASO : marque courte + phrase-clé recherchée. Modifiable dans
> **Réglages → Marque** (ou `BRAND_NAME` / `TAGLINE`), ce qui change aussi le
> nom sur l'écran d'accueil via le manifest.

Sous le capot : *Android TV Remote v2* (TLS, code PIN) via
[`androidtv-remote`](https://www.npmjs.com/package/androidtv-remote), **adb sur
TCP** pour Fire TV et le volume absolu, **ECP/HTTP** pour Roku.

Un seul conteneur Docker (Node 22 + Express), un frontend statique (une page
`index.html` en JavaScript vanille), interface en **français**, installable sur
l'écran d'accueil d'un iPhone.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
- [Premier démarrage : ajouter tes TV](#premier-démarrage--ajouter-tes-tv)
- [Activer le débogage ADB](#activer-le-débogage-adb)
- [Appairer une Android TV (code PIN)](#appairer-une-android-tv-code-pin)
- [Pièces et scènes](#pièces-et-scènes)
- [Ajouter un type d'appareil](#ajouter-un-type-dappareil)
- [Le mute : comment ManCave le rend fiable](#le-mute--comment-mancave-le-rend-fiable)
- [Scènes personnalisées](#scènes-personnalisées)
- [Marque](#marque)
- [Référence de l'API](#référence-de-lapi)
- [Exposer via Cloudflare Tunnel + Access](#exposer-via-cloudflare-tunnel--access)
- [Dépannage](#dépannage)

---

## Fonctionnalités

1. **Multi-TV, multi-pièces.** Nombre d'appareils illimité, groupés par pièce,
   avec des onglets de pièce en haut de l'écran. Tout se configure dans
   l'interface — aucune IP en dur dans le code.
2. **Découverte réseau multi-protocoles.** Le scan sonde les ports déclarés au
   catalogue (6466 Android TV Remote, 5555 adb, 8060 Roku ECP), **devine le
   type** de chaque appareil trouvé et l'ajoute en un tap.
3. **Scènes automatiques par pièce** — générées dès qu'un appareil existe :
   - **solo** (un bouton par TV) — cette TV au son, les autres de la pièce en muet ;
   - **switch** — fait tourner le solo sur la TV suivante ;
   - **silence** — toute la pièce en muet ;
   - **pause** — lecture/pause sur toute la pièce ;
   - **extinction** — toute la pièce en veille.
   Avec plusieurs pièces s'ajoutent **Silence total** et **Tout éteindre**.
4. **Scènes personnalisées** — combinaisons libres d'actions par appareil.
5. **État en direct** par TV : en ligne / hors ligne, éveil / veille, app au
   premier plan (Android TV), barre et pourcentage de volume, état adb.
6. **Contrôle audio en boucle fermée** — voir la section dédiée : ManCave lit
   l'état réel des TV et écrit des volumes **absolus** vérifiés, au lieu
   d'envoyer des bascules aveugles.
7. **Pairing PIN dans l'interface**, certificat persisté par appareil.

---

## Installation

Prérequis : Docker + Docker Compose, et les TV sur le **même réseau local** que
l'hôte.

```bash
cd salon-tv
docker compose up -d --build
```

Le service écoute sur `http://<IP-de-l-hôte>:8099`. Ouvre-le dans Safari sur
ton iPhone, puis **Partager → Sur l'écran d'accueil** pour l'installer comme une
app plein écran.

> **`network_mode: host` est obligatoire** : le pairing Android TV (mDNS/TLS),
> adb et le scan réseau échouent tous en mode `bridge`.

### Sans Docker (développement)

```bash
npm install
DATA_DIR=./data PORT=8099 npm start
npm test          # tests unitaires
```
`adb` doit être installé sur la machine (`brew install android-platform-tools`,
`apk add android-tools`, `apt install adb`…). L'image Docker l'embarque déjà.

---

## Premier démarrage : ajouter tes TV

Ouvre l'app, déplie **Réglages → Appareils, pièces & marque** :

1. **Scanner le réseau** (~10 s) → la liste des TV trouvées s'affiche → bouton
   **Ajouter** sur chacune. Le champ **Pièce** juste au-dessus détermine la
   pièce d'affectation (ex. `Man Cave`), et le champ **Nom** l'étiquette.
2. Ou **ajout manuel** : nom, type (liste issue du catalogue), IP, pièce.
   Le bouton **Guide** à côté du type explique comment préparer ce modèle.

Le registre est enregistré dans `data/devices.json` et appliqué **à chaud** —
aucun redémarrage.

> **Réserve des baux DHCP fixes** dans ton routeur pour chaque TV : si une IP
> change, l'appareil apparaît hors ligne jusqu'à correction.

### Migration depuis une installation à deux TV

Si `data/devices.json` n'existe pas encore et que `SHIELD_HOST` / `FIRETV_HOST`
sont définis, ManCave crée automatiquement les deux appareils correspondants **et
reprend le certificat de pairing existant** (`shield-cert.json`) : rien à
réappairer.

---

## Activer le débogage ADB

**Les instructions sont dans l'application**, adaptées au modèle : bouton
**Guide d'installation** sur chaque bandeau de TV, et bouton **Guide** à côté
du sélecteur de type au moment de l'ajout. Les guides couvrent, pas à pas :

- **Fire TV** (Fire TV Stick, Cube, TCL/Insignia/Toshiba Fire TV) — activation
  du débogage ADB, et quoi faire si la fenêtre d'autorisation ne revient pas
  (révoquer les autorisations).
- **Nvidia Shield** — débogage réseau.
- **Chromecast / Google TV** — 7 appuis sur *Version d'Android TV OS*.
- **Sony Bravia, Philips, TCL, Hisense, Xiaomi** — parcours Android TV générique.
- **Roku** — pas d'adb : autorisation du contrôle par le réseau (ECP).

Le canal adb apporte le **contrôle de volume absolu** et l'état réel. Il est
indispensable sur Fire TV, fortement recommandé sur Android TV, et sans objet
sur Roku.

Après activation : bouton **Connecter** du bandeau. La **première** connexion
affiche « Autoriser le débogage USB ? » **sur la TV** : coche **Toujours
autoriser** puis **OK**. L'état passe alors à **adb connecté**.

Les guides vivent dans [`src/catalog.js`](src/catalog.js) : les corriger ou en
ajouter ne demande aucune modification de l'interface.

---

## Appairer une Android TV (code PIN)

Aucun réglage préalable sur la TV :

1. Ajoute l'appareil (type **Android TV**).
2. La TV affiche un **code à 6 caractères hexadécimaux** (chiffres **et**
   lettres A–F) et l'app ouvre automatiquement la fenêtre **Pairing**.
3. Saisis le code, valide. Le certificat est persisté dans
   `data/cert-<id>.json` et survit aux redémarrages.
4. En cas de dé-pairing (événement `unpaired`), le certificat est supprimé et
   l'app redemande un code automatiquement.

---

## Pièces et scènes

- Chaque appareil appartient à une **pièce** (champ libre). Les onglets en haut
  de l'écran n'apparaissent qu'à partir de deux pièces.
- Les scènes sont **générées automatiquement** pour chaque pièce (voir
  [Fonctionnalités](#fonctionnalités)). Un bouton **solo** par TV : son libellé
  est le nom de la TV, et il s'allume en vert quand cette TV est la seule au son.
- **Renommer une pièce** : `POST /api/rooms/rename` (ou modifie le champ pièce
  de chaque appareil).

---

## Le mute : comment ManCave le rend fiable

Les télécommandes classiques envoient une **bascule** de mute « à l'aveugle » :
si l'application se trompe sur l'état courant, les scènes s'inversent. ManCave
fonctionne en **boucle fermée** — il lit l'état réel, agit par commandes
**absolues**, puis **vérifie**. Sources possibles, par ordre de préférence
(champ `muteSource` dans `/api/state`) :

| Source | Comment | Conséquence |
|--------|---------|-------------|
| `volume` | Volume **absolu** via adb (`media volume --set`) : mute = mémoriser le niveau puis écrire **0**, unmute = restaurer. Écriture vérifiée par relecture. | Idéal. La télécommande physique **ne peut plus** désynchroniser l'app : l'état est relu toutes les 5 s. |
| `device` | La TV refuse les commandes volume mais expose son mute dans `dumpsys audio` : touche muet + relecture de contrôle. | Fiable. |
| `events` | Android TV sans adb : boucle fermée sur les événements volume du protocole remote. | Bon. |
| `intent` / `assumed` | Rien n'est lisible : suivi d'intention persisté. | Dernier recours — un bouton **« Son suivi »** apparaît sous le bandeau pour réaligner l'app sur la réalité **sans** actionner la TV. |

Le bouton « Son suivi » **n'apparaît que** dans le dernier cas : quand ManCave lit
l'état réel, il n'y a rien à resynchroniser.

---

## Ajouter un type d'appareil

L'architecture est **agnostique du protocole** : adb, TLS/protobuf (Android TV
Remote v2) et HTTP (Roku ECP) cohabitent déjà. Le reste du système —
découverte, registre, scènes, interface — se pilote à partir de deux choses :
le **catalogue** et les **capacités** déclarées.

Trois étapes, aucun autre fichier à toucher :

1. **Décris le type** dans [`src/catalog.js`](src/catalog.js) : libellé, marques
   couvertes, port par défaut, ports à sonder pendant un scan, capacités, et le
   guide d'installation affiché dans l'app.
2. **Écris le pilote** (voir le contrat en tête de [`src/drivers.js`](src/drivers.js)) :
   `start`, `stop`, `key`, `setMuted`, `standby`, `setMuteIntent`,
   `connectAdb`, `sendPin`, `getState`. Toute erreur doit porter un message en
   français : elle remonte telle quelle dans `errors[]`.
3. **Enregistre-le** dans la table `DRIVERS`.

### Capacités

L'interface et le moteur de scènes s'adaptent tout seuls : un appareil sans
`volume` n'affiche pas de VU-mètre, sans `adb` pas de bouton *Connecter*, sans
`dpad` pas de pavé, et la scène *Pause* ignore les appareils sans `transport`
au lieu de produire une erreur.

| Capacité | Effet |
|----------|-------|
| `mute` | bouton Muet ; participe aux scènes solo/silence |
| `volume` | VU-mètre + pourcentage (niveau absolu lisible) |
| `transport` | bouton Lecture ; participe à la scène Pause |
| `dpad` | pavé directionnel repliable |
| `power` | bouton Alim. ; participe à la scène Extinction |
| `appInfo` | affiche l'app au premier plan |
| `pairing` | flux de code PIN |
| `adb` | bouton *Connecter* + état adb |

`src/roku.js` sert de modèle : ~180 lignes, aucun adb, aucun appairage — la
preuve que le squelette n'est pas lié à Android.

> **Roku est expérimental** : l'API ECP est documentée et stable, mais ce
> pilote n'a pas encore tourné sur un appareil réel.

---

## Scènes personnalisées

Via l'API (une UI dédiée viendra) :

```bash
curl -X POST http://localhost:8099/api/scenes/custom \
  -H 'Content-Type: application/json' \
  -d '{
        "label": "Match",
        "room": "Man Cave",
        "actions": [
          { "deviceId": "dev_abc12345", "action": "unmute" },
          { "deviceId": "dev_def67890", "action": "mute" },
          { "deviceId": "dev_def67890", "action": "key", "key": "play_pause" }
        ]
      }'
```

Actions : `mute`, `unmute`, `play_pause`, `standby`, `key` (avec `key` parmi
`mute, vol_down, vol_up, play_pause, power, up, down, left, right, ok, back,
home, menu`). Les scènes sont stockées dans `data/scenes.json`.

---

## Marque

Nom et sous-titre modifiables dans **Réglages → Marque** (ou via `BRAND_NAME` /
`TAGLINE`), persistés dans `data/settings.json`. Ils alimentent aussi
`/manifest.webmanifest`, donc le nom affiché sous l'icône quand l'app est
installée sur l'écran d'accueil.

Le défaut — **Multi TV Remote** / *man cave control* — suit la logique
ASO/SEO : le titre contient littéralement la phrase recherchée, le
positionnement (man cave) vit dans la baseline et la description. Si tu vises
plutôt une marque mémorisable, garde la requête dans le sous-titre :
`BRAND_NAME="CAVE"` + `TAGLINE="multi tv remote"`.

---

## Référence de l'API

| Méthode | Route | Réponse |
|---------|-------|---------|
| `GET` | `/api/state` | Marque, pièces, appareils (état complet + capacités) et catalogue de scènes. |
| `GET` | `/healthz` | Sonde de vivacité. |
| `POST` | `/api/device/:id/key/:key` | Envoie une touche. Appareil inconnu → **404**, touche inconnue → **400**, échec → **502**. |
| `POST` | `/api/device/:id/connect` | Force une reconnexion adb. `{ adb }` ∈ device/unauthorized/offline/absent. |
| `POST` | `/api/device/:id/pin` | `{ "pin": "A1B2C3" }`. Invalide → **400**, pas de pairing → **409**. |
| `POST` | `/api/device/:id/mute` | `{ "muted": bool }` : réaligne le suivi **sans** actionner la TV. |
| `POST` | `/api/scene/:id` | Déclenche une scène (ID encodé). Inconnue → **404**. Sinon **200** avec `errors[]` par appareil — jamais de 500 global. |
| `GET`/`POST` | `/api/devices` | Liste / ajoute un appareil (**201**). Validation → **400**. |
| `PATCH`/`DELETE` | `/api/devices/:id` | Modifie / supprime un appareil. |
| `POST` | `/api/rooms/rename` | `{ from, to }`. |
| `GET`/`POST` | `/api/scenes/custom` | Liste / crée une scène personnalisée. |
| `PATCH`/`DELETE` | `/api/scenes/custom/:id` | Modifie / supprime. |
| `GET`/`POST` | `/api/settings` | Marque (`brandName`, `tagline`). |
| `GET` | `/api/catalog` | Types pris en charge : libellés, marques, capacités et guides d'installation. |
| `POST` | `/api/discover` | Scan du réseau (~10 s) : `{ subnets, candidates[] }` — chaque candidat porte son `type` deviné, son `model` et ses ports ouverts. |

L'interface web n'est qu'un client de cette API — les futures applications iOS
et Android consommeront exactement les mêmes routes.

---

## Exposer via Cloudflare Tunnel + Access

Publier l'app sur un domaine **sans ouvrir de port**, avec authentification.

### 1. Ajouter le service au tunnel

Dans **Zero Trust → Networks → Tunnels → ton tunnel → Public Hostnames** :

| Champ | Valeur |
|-------|--------|
| Subdomain | `tv` |
| Domain | `balgio.ca` |
| Type | `HTTP` |
| URL | `192.168.0.191:8099` |

Ou dans le `config.yml` de `cloudflared` :

```yaml
ingress:
  - hostname: tv.balgio.ca
    service: http://192.168.0.191:8099
  - service: http_status:404
```

### 2. Politique Access

**Zero Trust → Access → Applications → Add → Self-hosted** :

- **Application domain** : `tv.balgio.ca`
- **Session Duration** : longue (l'app sonde `/api/state` toutes les 2,5 s ;
  une session courte provoquerait des redirections d'auth intempestives).
- **Policy** : *Allow* → **Emails** → les adresses du foyer.

---

## Dépannage

| Symptôme | Piste |
|----------|-------|
| Appareil « hors ligne » | TV allumée ? bonne IP ? (bail DHCP fixe conseillé). Le service retente en backoff automatiquement. |
| `adb hors ligne` malgré une TV allumée | Bouton **Connecter** : il force un `disconnect` + `connect`, seul moyen de récupérer une session adb décrochée. |
| `à autoriser sur la TV` | La fenêtre « Autoriser le débogage USB ? » attend sur l'écran de la TV. |
| `adb absent` | `adb` n'est pas installé sur l'hôte (l'image Docker l'embarque). |
| La fenêtre PIN ne s'ouvre pas | Vérifie que l'appareil est en ligne ; supprime `data/cert-<id>.json` pour forcer un re-pairing. |
| Une scène solo semble inversée | Regarde `muteSource` : en mode `intent`, utilise le bouton **Son suivi**. Active adb pour passer en mode `volume` et supprimer le problème. |
| Rien ne marche en `bridge` | `network_mode: host` est obligatoire. |
