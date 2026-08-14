// Catalogue des types d'appareils — SOURCE DE VÉRITÉ unique.
//
// Ajouter la prise en charge d'un nouveau téléviseur = ajouter une entrée ici
// + un pilote dans drivers.js. Rien d'autre à toucher : la découverte réseau,
// la validation du registre, le moteur de scènes et l'interface se pilotent
// tous à partir de ces données.
//
// Chaque entrée décrit :
//   id            identifiant technique stocké dans le registre
//   label         libellé affiché
//   brands        marques/modèles couverts (aide au choix dans l'UI)
//   transport     'adb' | 'androidtv-remote+adb' | 'ecp' (HTTP Roku) …
//   defaultPort   port de contrôle par défaut
//   probePorts    ports TCP qui trahissent ce type pendant un scan réseau
//   capabilities  ce que le pilote sait faire (l'UI s'y adapte)
//   setup         guide pas-à-pas affiché dans l'application
//
// CAPACITÉS reconnues :
//   mute       couper/rétablir le son
//   volume     lecture/écriture du niveau absolu (affiche le VU-mètre)
//   transport  lecture/pause
//   dpad       pavé directionnel
//   power      mise en veille
//   appInfo    application au premier plan
//   pairing    appairage par code PIN
//   adb        canal adb (bouton « Connecter » + état adb)

export const CAPS = ['mute', 'volume', 'transport', 'dpad', 'power', 'appInfo', 'pairing', 'adb'];

// Étapes communes pour activer le mode développeur d'Android TV.
const ANDROID_DEV_MODE = (buildLabel, debugLabel) => [
  `Sur la TV : **Paramètres → Préférences relatives à l'appareil → À propos**.`,
  `Descends sur **${buildLabel}** et appuie **7 fois** sur OK, jusqu'au message « Vous êtes maintenant développeur ».`,
  `Reviens en arrière, puis ouvre **Options pour les développeurs**.`,
  `Active **${debugLabel}**.`,
  `Note l'adresse IP : **Paramètres → Réseau et Internet** → ton Wi-Fi.`,
  `Dans cette app, appuie sur **Connecter** : la TV affiche « Autoriser le débogage ? » → coche **Toujours autoriser**, puis **OK**.`,
];

export const CATALOG = [
  {
    id: 'androidtv',
    label: 'Android TV / Google TV',
    brands: ['Nvidia Shield', 'Chromecast Google TV', 'Sony Bravia', 'Philips', 'TCL (Google TV)', 'Hisense', 'Xiaomi Mi Box'],
    transport: 'androidtv-remote+adb',
    defaultPort: 5555,
    probePorts: [6466, 5555],
    capabilities: ['mute', 'volume', 'transport', 'dpad', 'power', 'appInfo', 'pairing', 'adb'],
    setup: {
      title: 'Android TV / Google TV',
      intro: "Le pairing par code PIN suffit pour piloter la TV. Le débogage réseau (adb) est optionnel mais fortement recommandé : il donne le volume réel et un mute fiable.",
      sections: [
        {
          heading: 'Appairage (obligatoire)',
          steps: [
            'Ajoute la TV ici, puis attends quelques secondes.',
            "Un code à 6 caractères (chiffres et lettres A–F) s'affiche sur la TV.",
            "Saisis-le dans la fenêtre qui s'ouvre automatiquement dans l'app.",
          ],
        },
        {
          heading: 'Débogage réseau — Nvidia Shield',
          steps: ANDROID_DEV_MODE('Build', 'Débogage réseau (Network debugging)'),
        },
        {
          heading: 'Débogage — Chromecast / Google TV',
          steps: [
            'Sur la TV : **Paramètres → Système → À propos**.',
            "Appuie **7 fois** sur **Version d'Android TV OS** (ou **Build**).",
            'Reviens, puis **Paramètres → Système → Options pour les développeurs**.',
            'Active **Débogage USB**, et **Débogage réseau** si la ligne existe.',
            "Dans cette app : **Connecter**, puis accepte l'autorisation sur la TV (**Toujours autoriser**).",
          ],
        },
        {
          heading: 'Débogage — Sony Bravia, Philips, TCL, Hisense, Xiaomi',
          steps: ANDROID_DEV_MODE('Build / Numéro de build', 'Débogage USB (et Débogage réseau si présent)'),
        },
      ],
    },
  },

  {
    id: 'firetv',
    label: 'Fire TV (Amazon)',
    brands: ['Fire TV Stick', 'Fire TV Cube', 'TCL Fire TV', 'Insignia Fire TV', 'Toshiba Fire TV'],
    transport: 'adb',
    defaultPort: 5555,
    probePorts: [5555],
    capabilities: ['mute', 'volume', 'transport', 'dpad', 'power', 'adb'],
    setup: {
      title: 'Fire TV (Amazon)',
      intro: "Les Fire TV n'ont pas les services Google : tout passe par adb. Le débogage ADB est donc obligatoire.",
      sections: [
        {
          heading: 'Activer le débogage ADB',
          steps: [
            'Sur la TV : **Paramètres → Mon Fire TV** (ou **My Fire TV** / **Appareil et logiciel**).',
            'Ouvre **À propos**, surligne le **nom de l’appareil** et appuie **7 fois** sur OK.',
            'Reviens, puis ouvre **Options pour les développeurs**.',
            'Active **Débogage ADB**.',
            "Note l'IP : **Paramètres → Réseau** → sélectionne ton Wi-Fi.",
            "Dans cette app : **Connecter**, puis sur la TV coche **Toujours autoriser depuis cet ordinateur** → **OK**.",
          ],
        },
        {
          heading: 'Si la fenêtre d’autorisation ne revient pas',
          steps: [
            '**Options pour les développeurs → Révoquer les autorisations de débogage USB**.',
            "Puis **Connecter** de nouveau dans l'app : la fenêtre réapparaît.",
          ],
        },
      ],
    },
  },

  {
    id: 'roku',
    label: 'Roku (expérimental)',
    brands: ['Roku Express', 'Roku Streaming Stick', 'TCL Roku TV', 'Hisense Roku TV', 'Sharp Roku TV'],
    transport: 'ecp',
    defaultPort: 8060,
    probePorts: [8060],
    // Pas de volume absolu lisible ni de pairing : le mute est suivi côté serveur.
    capabilities: ['mute', 'transport', 'dpad', 'power'],
    experimental: true,
    setup: {
      title: 'Roku',
      intro: "Roku utilise ECP (HTTP, port 8060) — ni adb ni code PIN. Il suffit d'autoriser le contrôle par le réseau.",
      sections: [
        {
          heading: 'Autoriser le contrôle réseau',
          steps: [
            'Sur la TV : **Paramètres → Système → Paramètres avancés du système**.',
            '**Contrôle par les applications mobiles** → **Accès réseau** = **Par défaut** ou **Permissif**.',
            "L'IP se trouve dans **Paramètres → Réseau → À propos**.",
            "Ajoute l'appareil ici : aucun appairage n'est nécessaire.",
          ],
        },
        {
          heading: 'Limite connue',
          steps: [
            "Roku ne publie pas son niveau de volume : le mute est **suivi côté serveur**. Si quelqu'un utilise la télécommande physique, réaligne avec le bouton **Son suivi**.",
          ],
        },
      ],
    },
  },
];

export const TYPE_IDS = CATALOG.map((t) => t.id);

export function getType(id) {
  return CATALOG.find((t) => t.id === id) || null;
}

export function capabilitiesOf(id) {
  return getType(id)?.capabilities ?? [];
}

export function supports(id, cap) {
  return capabilitiesOf(id).includes(cap);
}

export function defaultPortOf(id) {
  return getType(id)?.defaultPort ?? 5555;
}

// Tous les ports à sonder pendant un scan, avec le type qu'ils suggèrent.
// Un port peut désigner plusieurs types (5555 = adb : Android TV OU Fire TV) ;
// on renvoie donc la liste des types candidats par port.
export function probeMap() {
  const map = new Map();
  for (const t of CATALOG) {
    for (const port of t.probePorts) {
      if (!map.has(port)) map.set(port, []);
      map.get(port).push(t.id);
    }
  }
  return map;
}

// Catalogue allégé pour l'interface (sans logique serveur).
export function publicCatalog() {
  return CATALOG.map((t) => ({
    id: t.id,
    label: t.label,
    brands: t.brands,
    defaultPort: t.defaultPort,
    capabilities: t.capabilities,
    experimental: Boolean(t.experimental),
    setup: t.setup,
  }));
}
