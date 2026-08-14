// Scènes : une action qui touche les deux TV en un seul geste.
//
// Chaque scène est une liste d'actions « best-effort » : si une TV est hors
// ligne, son action échoue mais n'empêche pas l'autre. runScene renvoie
// toujours la liste des erreurs par appareil (jamais d'exception globale).

export const SCENE_NAMES = ['shield_solo', 'firetv_solo', 'silence', 'pause_all', 'off'];

function buildScenes(shield, firetv) {
  return {
    // Shield au son, Fire TV en sourdine.
    shield_solo: [
      { device: 'shield', run: () => shield.setMuted(false) },
      { device: 'firetv', run: () => firetv.setMuted(true) },
    ],
    // L'inverse : Fire TV au son, Shield en sourdine.
    firetv_solo: [
      { device: 'firetv', run: () => firetv.setMuted(false) },
      { device: 'shield', run: () => shield.setMuted(true) },
    ],
    // Les deux en sourdine.
    silence: [
      { device: 'shield', run: () => shield.setMuted(true) },
      { device: 'firetv', run: () => firetv.setMuted(true) },
    ],
    // Play/Pause sur les deux.
    pause_all: [
      { device: 'shield', run: () => shield.key('play_pause') },
      { device: 'firetv', run: () => firetv.key('play_pause') },
    ],
    // Les deux en veille (idempotent).
    off: [
      { device: 'shield', run: () => shield.standby() },
      { device: 'firetv', run: () => firetv.standby() },
    ],
  };
}

export function isKnownScene(name) {
  return SCENE_NAMES.includes(name);
}

// Exécute une scène. Renvoie { errors: [{ device, error }] }.
export async function runScene(name, shield, firetv) {
  const scene = buildScenes(shield, firetv)[name];
  const errors = [];
  for (const action of scene) {
    try {
      await action.run();
    } catch (err) {
      errors.push({ device: action.device, error: err?.message || String(err) });
    }
  }
  return { errors };
}
