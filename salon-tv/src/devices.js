// Registre d'appareils : liste dynamique de TV, groupées par pièce.
//
// Persisté dans DATA_DIR/devices.json. Chaque appareil :
//   { id, name, type: 'androidtv'|'firetv', host, port, room }
//
// - 'androidtv' : Android TV / Google TV (Shield…) — protocole Remote v2
//   (pairing PIN) + canal adb optionnel pour la vérité terrain audio.
// - 'firetv'    : Fire TV (pas de services Google) — adb uniquement.
//
// Migration : au premier démarrage sans devices.json, on reconstruit le
// registre depuis l'ancienne configuration (settings.json / variables
// d'environnement) pour ne rien casser — y compris le certificat de pairing
// déjà obtenu, qui est repris tel quel.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { TYPE_IDS, defaultPortOf } from './catalog.js';

const DEVICES_FILE = 'devices.json';
// Types valides = ceux du catalogue (voir catalog.js pour en ajouter un).
export const DEVICE_TYPES = TYPE_IDS;
export const DEFAULT_ROOM = 'Salon';

function filePath() {
  return path.join(config.dataDir, DEVICES_FILE);
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(raw?.devices) ? raw.devices : null;
  } catch {
    return null;
  }
}

function writeFile(devices) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify({ devices }, null, 2));
}

export function newId() {
  return 'dev_' + randomUUID().slice(0, 8);
}

// Normalise/valide un appareil. Lève une Error avec un message français.
export function normalizeDevice(input, existing = {}) {
  const d = { ...existing, ...input };
  const name = String(d.name ?? '').trim();
  if (!name) throw new Error('Nom requis');
  if (!DEVICE_TYPES.includes(d.type)) {
    throw new Error(`Type invalide: ${d.type} (attendu : ${DEVICE_TYPES.join(', ')})`);
  }
  const host = String(d.host ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.split('.').some((o) => Number(o) > 255)) {
    throw new Error(`Adresse IP invalide: ${host}`);
  }
  // Port par défaut selon le type (5555 adb, 8060 ECP Roku…).
  const port = d.port === undefined || d.port === null || d.port === ''
    ? defaultPortOf(d.type)
    : Number(d.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port invalide: ${d.port}`);
  }
  const room = String(d.room ?? '').trim() || DEFAULT_ROOM;
  return { id: d.id || newId(), name, type: d.type, host, port, room };
}

// Reconstruit le registre depuis l'ancienne config (deux TV en dur).
function migrateFromLegacy() {
  const devices = [];
  if (config.shield.host) {
    devices.push(normalizeDevice({
      name: 'Shield',
      type: 'androidtv',
      host: config.shield.host,
      port: 5555,
      room: DEFAULT_ROOM,
    }));
  }
  if (config.firetv.host) {
    devices.push(normalizeDevice({
      name: 'Fire TV',
      type: 'firetv',
      host: config.firetv.host,
      port: config.firetv.port,
      room: DEFAULT_ROOM,
    }));
  }
  if (devices.length) {
    // Reprend le certificat de pairing existant pour ne pas ré-appairer.
    const legacyCert = path.join(config.dataDir, 'shield-cert.json');
    const androidtv = devices.find((d) => d.type === 'androidtv');
    if (androidtv && fs.existsSync(legacyCert)) {
      try {
        fs.copyFileSync(legacyCert, path.join(config.dataDir, `cert-${androidtv.id}.json`));
        console.log('[devices] Certificat de pairing migré vers', androidtv.id);
      } catch (err) {
        console.error('[devices] Migration du certificat impossible :', err.message);
      }
    }
    writeFile(devices);
    console.log(`[devices] Registre initialisé depuis l'ancienne config (${devices.length} appareil(s)).`);
  }
  return devices;
}

export class DeviceRegistry {
  constructor() {
    this.devices = readFile() ?? migrateFromLegacy();
  }

  all() {
    return this.devices.map((d) => ({ ...d }));
  }

  get(id) {
    return this.devices.find((d) => d.id === id) || null;
  }

  // Pièces dans l'ordre d'apparition, avec leurs appareils.
  rooms() {
    const byRoom = new Map();
    for (const d of this.devices) {
      if (!byRoom.has(d.room)) byRoom.set(d.room, []);
      byRoom.get(d.room).push({ ...d });
    }
    return [...byRoom.entries()].map(([name, devices]) => ({ name, devices }));
  }

  add(input) {
    const device = normalizeDevice(input);
    if (this.devices.some((d) => d.host === device.host && d.port === device.port)) {
      throw new Error(`Un appareil utilise déjà ${device.host}:${device.port}`);
    }
    this.devices.push(device);
    writeFile(this.devices);
    return { ...device };
  }

  update(id, patch) {
    const idx = this.devices.findIndex((d) => d.id === id);
    if (idx === -1) throw new Error(`Appareil inconnu: ${id}`);
    const device = normalizeDevice({ ...patch, id }, this.devices[idx]);
    if (this.devices.some((d, i) => i !== idx && d.host === device.host && d.port === device.port)) {
      throw new Error(`Un appareil utilise déjà ${device.host}:${device.port}`);
    }
    this.devices[idx] = device;
    writeFile(this.devices);
    return { ...device };
  }

  remove(id) {
    const idx = this.devices.findIndex((d) => d.id === id);
    if (idx === -1) throw new Error(`Appareil inconnu: ${id}`);
    const [gone] = this.devices.splice(idx, 1);
    writeFile(this.devices);
    // Nettoie le certificat de pairing associé.
    try { fs.unlinkSync(path.join(config.dataDir, `cert-${id}.json`)); } catch { /* absent */ }
    return { ...gone };
  }

  // Renomme une pièce (tous les appareils qui l'utilisent).
  renameRoom(from, to) {
    const name = String(to ?? '').trim();
    if (!name) throw new Error('Nom de pièce requis');
    let n = 0;
    for (const d of this.devices) {
      if (d.room === from) { d.room = name; n++; }
    }
    if (n) writeFile(this.devices);
    return n;
  }
}
