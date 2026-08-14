# salon-tv

Télécommande web auto-hébergée pour piloter **deux téléviseurs depuis un seul
écran de téléphone** :

- **Nvidia Shield Pro** — protocole *Android TV Remote v2* (TLS, pairing par
  code PIN), via le paquet [`androidtv-remote`](https://www.npmjs.com/package/androidtv-remote).
- **TCL Fire TV** — pas de services Google, donc pilotée en **ADB sur TCP**
  (`adb shell input keyevent …`).

Un seul conteneur Docker (Node 22 + Express), un frontend statique (une page
`index.html` en JavaScript vanille), interface en **français**, pensée pour être
installée sur l'écran d'accueil d'un iPhone. Conçu pour tourner sur le **NAS
UGREEN** (`192.168.0.191`).

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Prérequis](#prérequis)
- [Configuration](#configuration)
- [Installation et démarrage](#installation-et-démarrage)
- [Activer le débogage ADB sur la Fire TV](#activer-le-débogage-adb-sur-la-fire-tv)
- [Appairer la Nvidia Shield (code PIN)](#appairer-la-nvidia-shield-code-pin)
- [Utilisation](#utilisation)
- [⚠️ Le mute de la Fire TV (à lire)](#️-le-mute-de-la-fire-tv-à-lire)
- [Ajouter une nouvelle scène](#ajouter-une-nouvelle-scène)
- [Exposer en `tv.balgio.ca` via Cloudflare Tunnel + Access](#exposer-en-tvbalgioca-via-cloudflare-tunnel--access)
- [Référence de l'API](#référence-de-lapi)
- [Dépannage](#dépannage)

---

## Fonctionnalités

1. **Deux bandeaux de canal**, un par TV : muet, volume −/+, lecture/pause,
   alimentation, plus un **pavé directionnel repliable** (haut/bas/gauche/droite,
   OK, retour, accueil, menu).
2. **Scènes** qui touchent les deux TV en un seul geste :
   - `shield_solo` — Shield au son, Fire TV en sourdine ;
   - `firetv_solo` — l'inverse ;
   - `silence` — les deux en sourdine ;
   - `pause_all` — lecture/pause sur les deux ;
   - `off` — les deux en veille.
3. **État en direct** par TV : en ligne / hors ligne, éveil / veille, application
   au premier plan (Shield uniquement), barre + pourcentage de volume (Shield
   uniquement).
4. **Pairing PIN du Shield dans l'interface** : le serveur émet l'événement
   `secret`, le frontend affiche un champ numérique, `POST /api/shield/pin`
   envoie le code. Le certificat est **persisté dans `/app/data`** pour survivre
   aux redémarrages ; il est supprimé et re-généré sur l'événement `unpaired`.

---

## Prérequis

- NAS UGREEN (ou toute machine Linux) avec **Docker** et **Docker Compose**.
- Les deux TV et le NAS sur **le même réseau local** (`192.168.0.0/24`).
- La Fire TV avec le **débogage ADB activé** (voir plus bas).
- Réseau Docker en **`network_mode: host`** — *obligatoire* : le pairing du
  Shield (mDNS/TLS) **et** ADB échouent en mode `bridge`.

---

## Configuration

Tout se règle par variables d'environnement (voir `.env.example`) :

| Variable       | Défaut        | Rôle                                              |
|----------------|---------------|---------------------------------------------------|
| `SHIELD_HOST`  | *(vide)*      | IP de la Nvidia Shield                            |
| `FIRETV_HOST`  | *(vide)*      | IP de la TCL Fire TV                              |
| `FIRETV_PORT`  | `5555`        | Port ADB TCP de la Fire TV                        |
| `PORT`         | `8099`        | Port du service web                               |
| `DATA_DIR`     | `/app/data`   | Dossier persistant (certificat Shield, intent mute) |

Les IP sont renseignées **en dur dans `docker-compose.yml`** (section
`environment`). Tu peux aussi créer un fichier `.env` à partir de
`.env.example` — ses valeurs surchargent celles du compose.

Le dossier `./data` est monté sur `/app/data` : il contient le certificat de
pairing du Shield (`shield-cert.json`) et l'intention de mute de la Fire TV
(`firetv-mute.json`). **À ne pas supprimer** sauf pour forcer un re-pairing.

---

## Installation et démarrage

```bash
cd salon-tv
# Vérifie/édite les IP dans docker-compose.yml, puis :
docker compose up -d --build
```

Le service écoute sur `http://192.168.0.191:8099`. Ouvre-le dans Safari sur ton
iPhone, puis **Partager → Sur l'écran d'accueil** pour l'installer comme une app
(icône plein écran, sans barre Safari).

Vérifications rapides :

```bash
curl -s http://192.168.0.191:8099/api/state | jq        # les deux TV présentes
curl -i -X POST http://192.168.0.191:8099/api/scene/xyz  # scène inconnue -> 404
curl -i -X POST http://192.168.0.191:8099/api/key/shield/xyz  # touche inconnue -> 400
```

---

## Activer le débogage ADB sur la Fire TV

À faire **une seule fois**, directement sur la TCL Fire TV :

1. **Paramètres** → **Préférences de l'appareil** (ou **My Fire TV** /
   **Mon Fire TV**) → **À propos**.
2. Surligne le nom de l'appareil (ou **build**) et **appuie 7 fois** sur OK
   jusqu'au message « Vous êtes maintenant développeur ».
3. Reviens et ouvre **Options pour les développeurs**.
4. Active **Débogage ADB** (*ADB debugging*).
5. Active aussi **Applications de sources inconnues** si proposé (facultatif).
6. Note l'IP de la Fire TV : **Paramètres → Réseau** → sélectionne ton Wi-Fi →
   l'adresse IP s'affiche. Réserve-la dans ton routeur (bail DHCP fixe) pour
   qu'elle ne change pas.

À la **première** commande, la Fire TV affiche une fenêtre
« Autoriser le débogage USB ? » avec l'empreinte du NAS : coche **Toujours
autoriser depuis cet ordinateur** puis **OK**. Sans cette autorisation, `adb`
reste en état `unauthorized`.

> Astuce : le conteneur embarque `adb`. Pour diagnostiquer :
> ```bash
> docker exec -it salon-tv adb connect 192.168.0.xx:5555
> docker exec -it salon-tv adb devices        # doit afficher "device", pas "unauthorized"
> ```

---

## Appairer la Nvidia Shield (code PIN)

Tout se passe **dans l'interface web**, aucun réglage préalable sur la Shield :

1. Assure-toi que `SHIELD_HOST` pointe sur l'IP de la Shield et que le conteneur
   tourne.
2. Ouvre l'interface. Dès que le serveur tente le pairing, la **Shield affiche
   un code à 6 chiffres** et l'interface ouvre automatiquement la fenêtre
   **« Pairing Shield »**.
3. Saisis le code, valide. Le serveur appelle `sendCode()` puis, à l'événement
   `ready`, **persiste le certificat** dans `/app/data/shield-cert.json`.
4. Le pairing survit désormais aux redémarrages. En cas de dé-pairing (événement
   `unpaired`, p. ex. réinitialisation de la Shield), le certificat est supprimé
   et l'interface redemande un code automatiquement.

Si la fenêtre ne s'ouvre pas, vérifie que la Shield est allumée et joignable
(`curl .../api/state` → `shield.online: true`).

---

## Utilisation

- **Scènes** en haut : un tap déclenche les deux TV. Une TV hors ligne
  n'empêche pas l'autre — un petit message signale l'appareil injoignable.
- **Bandeaux** : chaque TV a sa LED d'état —
  🟢 **vert** = allumé et actif · 🟡 **ambre** = veille · 🔴 **rouge** = muet ·
  éteinte = hors ligne.
- **Pavé directionnel** : bouton « Pavé directionnel » pour déplier/replier.
- L'état est rafraîchi toutes les **2,5 s**.

---

## ⚠️ Le mute de la Fire TV (à lire)

La Fire TV **ne rapporte pas de façon fiable son état de sourdine**. Le service
suit donc l'**intention** côté serveur (fichier `data/firetv-mute.json`) et
n'envoie la touche muet **que si l'état voulu diffère de l'état suivi**. C'est ce
qui permet aux scènes (`shield_solo`, `firetv_solo`, `silence`) d'être
déterministes.

**Conséquence : la télécommande physique de la Fire TV peut désynchroniser ce
suivi.** Si quelqu'un met/enlève le muet avec la télécommande d'origine, le
service ne le « voit » pas et son idée du mute devient fausse. La prochaine scène
peut alors sembler ne rien faire (elle pense être déjà dans le bon état) ou
inverser le muet.

**Pour resynchroniser** : appuie sur le bouton **Muet** du bandeau Fire TV dans
l'interface — il bascule et réaligne l'intention suivie sur la réalité. En
pratique, pilote le mute de la Fire TV **depuis l'app** plutôt qu'avec la
télécommande physique.

Le Shield, lui, rapporte son mute et son volume correctement : aucune de ces
limites ne s'applique à lui.

---

## Ajouter une nouvelle scène

Les scènes sont déclarées dans [`src/scenes.js`](src/scenes.js). Deux étapes :

1. Ajoute le nom dans `SCENE_NAMES`.
2. Ajoute l'entrée dans `buildScenes()` — une liste d'actions
   `{ device, run }`. Chaque action est **best-effort** : si elle échoue
   (TV hors ligne), l'erreur est collectée dans `errors[]` sans bloquer les
   autres.

Exemple — une scène « cinéma » (Shield au son, Fire TV en veille) :

```js
export const SCENE_NAMES = ['shield_solo', 'firetv_solo', 'silence', 'pause_all', 'off', 'cinema'];

// dans buildScenes(shield, firetv) :
cinema: [
  { device: 'shield', run: () => shield.setMuted(false) },
  { device: 'firetv', run: () => firetv.standby() },
],
```

Puis, dans [`public/index.html`](public/index.html), ajoute le bouton
correspondant dans la grille `.scenes` :

```html
<button class="scene" data-scene="cinema">Cinéma<span class="k">Shield seul</span></button>
```

Méthodes utiles disponibles sur `shield` et `firetv` :
`key('<touche>')`, `setMuted(true|false)`, `standby()` (et `toggleMute()` pour la
Fire TV). Les touches connues : `mute, vol_down, vol_up, play_pause, power,
up, down, left, right, ok, back, home, menu`.

Rebuild : `docker compose up -d --build`.

---

## Exposer en `tv.balgio.ca` via Cloudflare Tunnel + Access

L'idée : publier l'interface sur `tv.balgio.ca` **sans ouvrir de port** sur ta
box, en réutilisant ton **Cloudflare Tunnel** existant, et en plaçant une
politique **Cloudflare Access** devant pour l'authentification.

### 1. Ajouter le service au tunnel

Le service est en `network_mode: host`, donc joignable en
`http://192.168.0.191:8099` depuis le NAS (là où tourne `cloudflared`).

**Via le tableau de bord Zero Trust** (Networks → Tunnels → ton tunnel →
*Public Hostnames* → *Add a public hostname*) :

| Champ        | Valeur                       |
|--------------|------------------------------|
| Subdomain    | `tv`                         |
| Domain       | `balgio.ca`                  |
| Type         | `HTTP`                       |
| URL          | `192.168.0.191:8099`         |

**Ou** en fichier de configuration (`config.yml` de `cloudflared`) :

```yaml
tunnel: <ID-de-ton-tunnel>
credentials-file: /etc/cloudflared/<ID>.json

ingress:
  - hostname: tv.balgio.ca
    service: http://192.168.0.191:8099
  # … tes autres hostnames …
  - service: http_status:404
```

Cloudflare crée l'enregistrement DNS `CNAME tv → <ID>.cfargotunnel.com`
automatiquement (ou `cloudflared tunnel route dns <tunnel> tv.balgio.ca`).

Recharge `cloudflared` (redémarre le service ou le conteneur).

### 2. Protéger avec une politique Access

Dans **Zero Trust → Access → Applications → Add an application → Self-hosted** :

- **Application name** : `Salon TV`
- **Session Duration** : à ton goût (p. ex. 1 mois, pour ne pas te
  ré-authentifier sans cesse depuis le téléphone).
- **Application domain** : `tv.balgio.ca`.
- **Policies** → *Add a policy* :
  - **Policy name** : `Foyer`
  - **Action** : `Allow`
  - **Include** → `Emails` → `mgiosi@balgio.ca` (et les autres adresses du
    foyer), ou `Emails ending in @balgio.ca`.

Résultat : `tv.balgio.ca` demande une authentification Cloudflare Access
(courriel + code à usage unique, ou ton fournisseur d'identité) avant d'atteindre
l'interface. Rien n'est exposé publiquement, aucun port ouvert sur la box.

> Note : comme l'interface sonde `/api/state` toutes les 2,5 s, garde une
> *Session Duration* confortable pour éviter des redirections d'auth
> intempestives. L'app installée sur l'écran d'accueil conserve la session.

---

## Référence de l'API

| Méthode | Route                       | Réponse                                                        |
|---------|-----------------------------|----------------------------------------------------------------|
| `GET`   | `/api/state`                | État des deux TV + liste des scènes.                           |
| `POST`  | `/api/key/:device/:key`     | Envoie une touche. `device` ∈ {`shield`,`firetv`}. Appareil inconnu → **404**, touche inconnue → **400**, échec d'envoi → **502**. |
| `POST`  | `/api/scene/:name`          | Déclenche une scène. Scène inconnue → **404**. Sinon **200** avec `errors[]` par appareil (jamais de 500 global). |
| `POST`  | `/api/shield/pin`           | Corps `{ "pin": "123456" }`. PIN invalide → **400**, pas de pairing en cours → **409**. |

Exemple de `/api/state` :

```json
{
  "shield": { "configured": true, "online": true, "awake": true, "paired": true,
              "pairing": false, "app": "com.netflix.ninja", "volume": 35, "muted": false },
  "firetv": { "configured": true, "online": true, "awake": true, "muted": false },
  "scenes": ["shield_solo","firetv_solo","silence","pause_all","off"]
}
```

---

## Dépannage

| Symptôme | Piste |
|----------|-------|
| `shield.online: false` | Shield allumée ? bonne IP ? Le conteneur retente en backoff automatiquement. |
| La fenêtre PIN ne s'ouvre pas | Vérifie `shield.online` ; supprime `data/shield-cert.json` pour forcer un re-pairing. |
| `firetv.online: false` | `docker exec -it salon-tv adb connect <ip>:5555` puis `adb devices` : si `unauthorized`, valide la fenêtre d'autorisation sur la TV. |
| Le muet Fire TV « ne fait rien » | Suivi désynchronisé par la télécommande physique → appuie sur **Muet** dans l'app pour réaligner (voir la section dédiée). |
| Rien ne marche en `bridge` | `network_mode: host` est obligatoire. |
| Le pairing échoue après reset Shield | Normal : le certificat est invalidé (`unpaired`), l'app redemande un code. |
