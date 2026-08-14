# DECK

Télécommande web auto-hébergée pour piloter **plusieurs téléviseurs, groupés
par pièce, depuis un seul écran de téléphone**. Pensée pour le *man cave* : un
tap coupe le son de toutes les TV sauf celle du match.

- **Android TV / Google TV** (Nvidia Shield, Chromecast…) — protocole
  *Android TV Remote v2* (TLS, pairing par code PIN), via
  [`androidtv-remote`](https://www.npmjs.com/package/androidtv-remote), plus un
  canal **adb** optionnel pour la vérité terrain audio.
- **Fire TV** (Amazon, TCL…) — pas de services Google, donc pilotée en **ADB
  sur TCP** (`adb shell …`).

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
- [Le mute : comment DECK le rend fiable](#le-mute--comment-deck-le-rend-fiable)
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
2. **Découverte réseau.** Le scan trouve les TV du réseau local (port 6466 =
   Android TV Remote, port 5555 = adb) et les ajoute en un tap.
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
6. **Contrôle audio en boucle fermée** — voir la section dédiée : DECK lit
   l'état réel des TV et écrit des volumes **absolus** vérifiés, au lieu
   d'envoyer des bascules aveugles.
7. **Pairing PIN dans l'interface**, certificat persisté par appareil.

---

## Installation

Prérequis : Docker + Docker Compose, et les TV sur le **même réseau local** que
l'hôte.

```bash
cd deck
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
2. Ou **ajout manuel** : nom, type (Android TV / Fire TV), IP, pièce.

Le registre est enregistré dans `data/devices.json` et appliqué **à chaud** —
aucun redémarrage.

> **Réserve des baux DHCP fixes** dans ton routeur pour chaque TV : si une IP
> change, l'appareil apparaît hors ligne jusqu'à correction.

### Migration depuis une installation à deux TV

Si `data/devices.json` n'existe pas encore et que `SHIELD_HOST` / `FIRETV_HOST`
sont définis, DECK crée automatiquement les deux appareils correspondants **et
reprend le certificat de pairing existant** (`shield-cert.json`) : rien à
réappairer.

---

## Activer le débogage ADB

Le canal adb apporte le **contrôle de volume absolu** et l'état réel. Il est
indispensable sur Fire TV, et fortement recommandé sur Android TV.

**Fire TV** — Paramètres → **My Fire TV / Mon Fire TV** → **À propos** →
appuie **7 fois** sur le nom de l'appareil → retour → **Options pour les
développeurs** → **Débogage ADB** = activé.

**Android TV / Shield** — Paramètres → **Préférences relatives à l'appareil** →
**À propos** → appuie 7 fois sur **Numéro de build** → retour → **Options pour
les développeurs** → **Débogage réseau** = activé.

Ensuite, dans l'app, bouton **Connecter** du bandeau de la TV. La **première**
connexion affiche « Autoriser le débogage USB ? » **sur la TV** : coche
**Toujours autoriser depuis cet ordinateur** puis **OK**. L'état à côté du
bouton passe alors à **adb connecté**.

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

## Le mute : comment DECK le rend fiable

Les télécommandes classiques envoient une **bascule** de mute « à l'aveugle » :
si l'application se trompe sur l'état courant, les scènes s'inversent. DECK
fonctionne en **boucle fermée** — il lit l'état réel, agit par commandes
**absolues**, puis **vérifie**. Sources possibles, par ordre de préférence
(champ `muteSource` dans `/api/state`) :

| Source | Comment | Conséquence |
|--------|---------|-------------|
| `volume` | Volume **absolu** via adb (`media volume --set`) : mute = mémoriser le niveau puis écrire **0**, unmute = restaurer. Écriture vérifiée par relecture. | Idéal. La télécommande physique **ne peut plus** désynchroniser l'app : l'état est relu toutes les 5 s. |
| `device` | La TV refuse les commandes volume mais expose son mute dans `dumpsys audio` : touche muet + relecture de contrôle. | Fiable. |
| `events` | Android TV sans adb : boucle fermée sur les événements volume du protocole remote. | Bon. |
| `intent` / `assumed` | Rien n'est lisible : suivi d'intention persisté. | Dernier recours — un bouton **« Son suivi »** apparaît sous le bandeau pour réaligner l'app sur la réalité **sans** actionner la TV. |

Le bouton « Son suivi » **n'apparaît que** dans le dernier cas : quand DECK lit
l'état réel, il n'y a rien à resynchroniser.

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

Le nom et le sous-titre affichés sont modifiables dans **Réglages → Marque**
(ou via `BRAND_NAME` / `TAGLINE`). Ils sont persistés dans
`data/settings.json`.

---

## Référence de l'API

| Méthode | Route | Réponse |
|---------|-------|---------|
| `GET` | `/api/state` | Marque, pièces, appareils (état complet) et catalogue de scènes. |
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
| `POST` | `/api/discover` | Scan du réseau (~10 s) : `{ subnets, androidtv[], firetv[] }`. |

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
