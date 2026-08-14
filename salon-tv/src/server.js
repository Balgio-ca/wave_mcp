// DECK — serveur Express : sert le frontend statique et l'API de contrôle.
//
// API multi-appareils / multi-pièces. Toutes les routes renvoient des messages
// d'erreur en français ; les scènes sont best-effort (200 + errors[]).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, saveSettings } from './config.js';
import { DeviceManager } from './manager.js';
import { isKnownKey } from './keys.js';
import {
  listScenes,
  runScene,
  loadCustomScenes,
  addCustomScene,
  updateCustomScene,
  removeCustomScene,
} from './scenes.js';
import { discover } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const manager = new DeviceManager();
manager.start();

const app = express();
app.use(express.json());

// Petit utilitaire : exécute et transforme les erreurs en 400 propres.
function guard(res, fn, status = 400) {
  try {
    return fn();
  } catch (err) {
    res.status(status).json({ error: err?.message || String(err) });
    return undefined;
  }
}

// --- État ---------------------------------------------------------------

// État complet (le frontend le sonde toutes les 2,5 s).
app.get('/api/state', (req, res) => {
  res.json({
    brand: { name: config.brandName, tagline: config.tagline },
    rooms: manager.roomsState(),
    devices: manager.devicesState(),
    scenes: listScenes(manager),
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- Contrôle -----------------------------------------------------------

// Envoie une touche : POST /api/device/:id/key/:key
app.post('/api/device/:id/key/:key', async (req, res) => {
  const { id, key } = req.params;
  const controller = manager.get(id);
  if (!controller) return res.status(404).json({ error: `Appareil inconnu: ${id}` });
  if (!isKnownKey(key)) return res.status(400).json({ error: `Touche inconnue: ${key}` });
  try {
    await controller.key(key);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

// Force une reconnexion adb : POST /api/device/:id/connect
app.post('/api/device/:id/connect', async (req, res) => {
  const controller = manager.get(req.params.id);
  if (!controller) return res.status(404).json({ error: `Appareil inconnu: ${req.params.id}` });
  const result = await controller.connectAdb();
  res.json({ ok: result.adb === 'device', ...result });
});

// Code PIN de pairing : POST /api/device/:id/pin { pin }
app.post('/api/device/:id/pin', (req, res) => {
  const controller = manager.get(req.params.id);
  if (!controller) return res.status(404).json({ error: `Appareil inconnu: ${req.params.id}` });
  const code = String(req.body?.pin ?? '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(code)) {
    return res.status(400).json({ error: 'Code invalide (6 caractères hexadécimaux : 0-9, A-F)' });
  }
  try {
    controller.sendPin(code);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err?.message || String(err) });
  }
});

// Réaligne l'intention de mute sans actionner la TV : POST /api/device/:id/mute
app.post('/api/device/:id/mute', (req, res) => {
  const controller = manager.get(req.params.id);
  if (!controller) return res.status(404).json({ error: `Appareil inconnu: ${req.params.id}` });
  const muted = req.body?.muted;
  if (typeof muted !== 'boolean') {
    return res.status(400).json({ error: 'Champ "muted" booléen requis' });
  }
  controller.setMuteIntent(muted);
  res.json({ ok: true, muted });
});

// Déclenche une scène : POST /api/scene/:id
// (l'ID est encodé côté client — il peut contenir « : » et des accents)
app.post('/api/scene/:id', async (req, res) => {
  const result = await runScene(req.params.id, manager);
  if (result === null) return res.status(404).json({ error: `Scène inconnue: ${req.params.id}` });
  res.json({ ok: result.errors.length === 0, ...result });
});

// --- Appareils ----------------------------------------------------------

app.get('/api/devices', (req, res) => res.json({ devices: manager.registry.all() }));

app.post('/api/devices', (req, res) => {
  const device = guard(res, () => manager.addDevice(req.body ?? {}));
  if (device) res.status(201).json({ ok: true, device });
});

app.patch('/api/devices/:id', (req, res) => {
  const device = guard(res, () => manager.updateDevice(req.params.id, req.body ?? {}));
  if (device) res.json({ ok: true, device });
});

app.delete('/api/devices/:id', (req, res) => {
  const gone = guard(res, () => manager.removeDevice(req.params.id), 404);
  if (gone) res.json({ ok: true, device: gone });
});

// Renomme une pièce : POST /api/rooms/rename { from, to }
app.post('/api/rooms/rename', (req, res) => {
  const { from, to } = req.body ?? {};
  if (!from) return res.status(400).json({ error: 'Champ "from" requis' });
  const n = guard(res, () => manager.renameRoom(String(from), to));
  if (n !== undefined) res.json({ ok: true, updated: n });
});

// --- Scènes personnalisées ---------------------------------------------

app.get('/api/scenes/custom', (req, res) => res.json({ scenes: loadCustomScenes() }));

app.post('/api/scenes/custom', (req, res) => {
  const scene = guard(res, () => addCustomScene(req.body ?? {}));
  if (scene) res.status(201).json({ ok: true, scene });
});

app.patch('/api/scenes/custom/:id', (req, res) => {
  const scene = guard(res, () => updateCustomScene(req.params.id, req.body ?? {}));
  if (scene) res.json({ ok: true, scene });
});

app.delete('/api/scenes/custom/:id', (req, res) => {
  const gone = guard(res, () => removeCustomScene(req.params.id), 404);
  if (gone) res.json({ ok: true, scene: gone });
});

// --- Réglages & découverte ---------------------------------------------

app.get('/api/settings', (req, res) => {
  res.json({ brandName: config.brandName, tagline: config.tagline });
});

app.post('/api/settings', (req, res) => {
  const { brandName, tagline } = req.body ?? {};
  const patch = {};
  if (brandName !== undefined) {
    const v = String(brandName).trim();
    if (!v || v.length > 24) return res.status(400).json({ error: 'Nom de marque : 1 à 24 caractères' });
    patch.brandName = v;
  }
  if (tagline !== undefined) {
    const v = String(tagline).trim();
    if (v.length > 40) return res.status(400).json({ error: 'Sous-titre : 40 caractères max' });
    patch.tagline = v;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Aucun réglage fourni (brandName, tagline)' });
  }
  saveSettings(patch);
  Object.assign(config, patch);
  res.json({ ok: true, brandName: config.brandName, tagline: config.tagline });
});

// Scan du réseau local (quelques secondes). Un seul scan à la fois.
let scanInFlight = null;
app.post('/api/discover', async (req, res) => {
  try {
    const known = new Set(manager.registry.all().map((d) => d.host));
    if (!scanInFlight) {
      scanInFlight = discover([...known]).finally(() => { scanInFlight = null; });
    }
    const result = await scanInFlight;
    // Marque les hôtes déjà enregistrés pour que l'UI puisse les griser.
    const tag = (list) => list.map((c) => ({ ...c, known: known.has(c.host) }));
    res.json({ ok: true, subnets: result.subnets, androidtv: tag(result.shield), firetv: tag(result.firetv) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Frontend statique -------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(config.port, () => {
  console.log(`${config.brandName} à l'écoute sur http://0.0.0.0:${config.port}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n[deck] ${sig} reçu, arrêt…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
