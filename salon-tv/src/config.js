// Configuration centralisée.
//
// Ordre de priorité : data/settings.json (réglé depuis l'UI) > variables
// d'environnement > défauts. Les réglages faits dans l'UI sont persistés dans
// DATA_DIR/settings.json et survivent aux redémarrages.

import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || '/app/data';
const settingsPath = path.join(dataDir, 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

const saved = loadSettings();

export const config = {
  port: parseInt(process.env.PORT || '8099', 10),

  // Marque affichée dans l'interface (modifiable dans les réglages).
  brandName: saved.brandName ?? (process.env.BRAND_NAME || 'DECK'),
  tagline: saved.tagline ?? (process.env.TAGLINE || 'tv control'),

  // Répertoire persistant (certificat Shield, intent mute, réglages).
  dataDir,

  shield: {
    host: saved.shieldHost ?? (process.env.SHIELD_HOST || ''),
    // Ports standards du protocole Android TV Remote v2.
    pairingPort: parseInt(process.env.SHIELD_PAIRING_PORT || '6467', 10),
    remotePort: parseInt(process.env.SHIELD_REMOTE_PORT || '6466', 10),
    // Nom affiché sur la TV pendant le pairing.
    serviceName: process.env.SHIELD_NAME || 'salon-tv',
  },

  firetv: {
    host: saved.firetvHost ?? (process.env.FIRETV_HOST || ''),
    port: saved.firetvPort ?? parseInt(process.env.FIRETV_PORT || '5555', 10),
  },
};

export function firetvTarget() {
  return `${config.firetv.host}:${config.firetv.port}`;
}

// Persiste les réglages modifiables depuis l'UI (fusion avec l'existant).
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  return next;
}
