// Moteur de scènes — les scènes sont des DONNÉES, plus du code en dur.
//
// Scènes générées automatiquement par pièce :
//   solo:<deviceId>   — cet appareil au son, les autres de la pièce en muet
//   switch:<room>     — fait tourner le solo sur l'appareil suivant
//   silence:<room>    — toute la pièce en muet
//   pause:<room>      — lecture/pause sur toute la pièce
//   off:<room>        — toute la pièce en veille
// Et globalement (si plusieurs pièces) :
//   silence:*  /  off:*
//
// Scènes personnalisées : DATA_DIR/scenes.json
//   { id, label, room, actions: [{ deviceId, action, key? }] }
//   action ∈ mute | unmute | play_pause | standby | key
//
// Exécution TOUJOURS best-effort : un appareil hors ligne n'empêche pas les
// autres ; on renvoie la liste des erreurs par appareil.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isKnownKey } from './keys.js';

const SCENES_FILE = 'scenes.json';
export const ACTIONS = ['mute', 'unmute', 'play_pause', 'standby', 'key'];
const GLOBAL = '*';

function filePath() {
  return path.join(config.dataDir, SCENES_FILE);
}

export function loadCustomScenes() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(raw?.scenes) ? raw.scenes : [];
  } catch {
    return [];
  }
}

function saveCustomScenes(scenes) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify({ scenes }, null, 2));
}

// Valide une scène personnalisée (messages en français).
export function normalizeCustomScene(input, existing = {}) {
  const s = { ...existing, ...input };
  const label = String(s.label ?? '').trim();
  if (!label) throw new Error('Nom de scène requis');
  if (!Array.isArray(s.actions) || s.actions.length === 0) {
    throw new Error('Au moins une action est requise');
  }
  const actions = s.actions.map((a, i) => {
    if (!a?.deviceId) throw new Error(`Action ${i + 1} : appareil manquant`);
    if (!ACTIONS.includes(a.action)) {
      throw new Error(`Action ${i + 1} : type invalide (${a.action})`);
    }
    if (a.action === 'key' && !isKnownKey(a.key)) {
      throw new Error(`Action ${i + 1} : touche inconnue (${a.key})`);
    }
    return a.action === 'key'
      ? { deviceId: a.deviceId, action: 'key', key: a.key }
      : { deviceId: a.deviceId, action: a.action };
  });
  return {
    id: s.id || 'scn_' + Math.random().toString(36).slice(2, 10),
    label,
    room: String(s.room ?? '').trim() || null,
    actions,
  };
}

export function addCustomScene(input) {
  const scenes = loadCustomScenes();
  const scene = normalizeCustomScene(input);
  scenes.push(scene);
  saveCustomScenes(scenes);
  return scene;
}

export function updateCustomScene(id, patch) {
  const scenes = loadCustomScenes();
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Scène inconnue: ${id}`);
  scenes[idx] = normalizeCustomScene({ ...patch, id }, scenes[idx]);
  saveCustomScenes(scenes);
  return scenes[idx];
}

export function removeCustomScene(id) {
  const scenes = loadCustomScenes();
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Scène inconnue: ${id}`);
  const [gone] = scenes.splice(idx, 1);
  saveCustomScenes(scenes);
  return gone;
}

// ---- Catalogue ---------------------------------------------------------

// Liste les scènes disponibles pour le registre courant (pour l'UI).
export function listScenes(manager) {
  const rooms = manager.roomsState();
  const out = [];
  for (const room of rooms) {
    const multi = room.devices.length > 1;
    for (const d of room.devices) {
      out.push({
        id: `solo:${d.id}`,
        label: d.name,
        sub: multi ? 'solo audio' : 'son actif',
        kind: 'solo',
        room: room.name,
        deviceId: d.id,
      });
    }
    if (multi) {
      out.push({ id: `switch:${room.name}`, label: 'Switch', sub: 'bascule le solo', kind: 'switch', room: room.name });
    }
    out.push({ id: `silence:${room.name}`, label: 'Silence', sub: multi ? 'tout muet' : 'muet', kind: 'silence', room: room.name });
    out.push({ id: `pause:${room.name}`, label: 'Pause', sub: multi ? 'les deux' : 'lecture', kind: 'pause', room: room.name });
    out.push({ id: `off:${room.name}`, label: 'Extinction', sub: multi ? 'veille de la pièce' : 'veille', kind: 'off', room: room.name });
  }
  if (rooms.length > 1) {
    out.push({ id: `silence:${GLOBAL}`, label: 'Silence total', sub: 'toutes les pièces', kind: 'silence', room: null });
    out.push({ id: `off:${GLOBAL}`, label: 'Tout éteindre', sub: 'toutes les pièces', kind: 'off', room: null });
  }
  for (const s of loadCustomScenes()) {
    out.push({ id: s.id, label: s.label, sub: 'personnalisée', kind: 'custom', room: s.room, custom: true });
  }
  return out;
}

export function isKnownScene(id, manager) {
  return listScenes(manager).some((s) => s.id === id);
}

// ---- Exécution ---------------------------------------------------------

function targets(manager, room) {
  return room === GLOBAL || room === null ? manager.all() : manager.inRoom(room);
}

// Un appareil ne reçoit une action que s'il la sait faire : une TV sans
// capacité 'transport' est simplement ignorée par la scène Pause, au lieu de
// produire une erreur inutile dans errors[].
function able(controller, cap) {
  const caps = controller.capabilities;
  return !Array.isArray(caps) || caps.includes(cap);
}

// Construit la liste d'actions { controller, run } d'une scène.
function planFor(id, manager) {
  const [kind, arg] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];

  if (kind === 'solo') {
    const target = manager.get(arg);
    if (!target) return null;
    const room = target.device.room;
    return manager.inRoom(room).filter((c) => able(c, 'mute')).map((c) => ({
      controller: c,
      run: () => c.setMuted(c.id !== target.id),
    }));
  }

  if (kind === 'switch') {
    const list = manager.inRoom(arg).filter((c) => able(c, 'mute'));
    if (list.length === 0) return [];
    // L'appareil « au son » actuel, sinon le premier ; on passe au suivant.
    const currentIdx = list.findIndex((c) => !c.getState().muted);
    const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % list.length;
    const next = list[nextIdx];
    return list.map((c) => ({
      controller: c,
      run: () => c.setMuted(c.id !== next.id),
    }));
  }

  if (kind === 'silence') {
    return targets(manager, arg).filter((c) => able(c, 'mute'))
      .map((c) => ({ controller: c, run: () => c.setMuted(true) }));
  }

  if (kind === 'pause') {
    return targets(manager, arg).filter((c) => able(c, 'transport'))
      .map((c) => ({ controller: c, run: () => c.key('play_pause') }));
  }

  if (kind === 'off') {
    return targets(manager, arg).filter((c) => able(c, 'power'))
      .map((c) => ({ controller: c, run: () => c.standby() }));
  }

  // Scène personnalisée.
  const custom = loadCustomScenes().find((s) => s.id === id);
  if (!custom) return null;
  return custom.actions
    .map((a) => {
      const c = manager.get(a.deviceId);
      if (!c) return null;
      const run = {
        mute: () => c.setMuted(true),
        unmute: () => c.setMuted(false),
        play_pause: () => c.key('play_pause'),
        standby: () => c.standby(),
        key: () => c.key(a.key),
      }[a.action];
      return { controller: c, run };
    })
    .filter(Boolean);
}

// Exécute une scène. Renvoie { scene, errors: [{ device, error }] }.
// Best-effort : chaque action est isolée.
export async function runScene(id, manager) {
  const plan = planFor(id, manager);
  if (plan === null) return null; // scène inconnue
  const errors = [];
  for (const action of plan) {
    try {
      await action.run();
    } catch (err) {
      errors.push({
        device: action.controller.device.name,
        deviceId: action.controller.id,
        error: err?.message || String(err),
      });
    }
  }
  return { scene: id, errors };
}
