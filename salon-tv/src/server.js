// salon-tv — serveur Express : sert le frontend statique et l'API de contrôle.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, saveSettings } from './config.js';
import { ShieldController } from './shield.js';
import { FireTVController } from './firetv.js';
import { isKnownKey } from './keys.js';
import { isKnownScene, runScene, SCENE_NAMES } from './scenes.js';
import { discover } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const shield = new ShieldController();
const firetv = new FireTVController();
shield.start();
firetv.start();

const app = express();
app.use(express.json());

// --- API ---------------------------------------------------------------

// État complet des deux TV (le frontend le sonde toutes les 2,5 s).
app.get('/api/state', (req, res) => {
  res.json({
    shield: shield.getState(),
    firetv: firetv.getState(),
    scenes: SCENE_NAMES,
  });
});

// Envoi d'une touche à une TV : POST /api/key/:device/:key
app.post('/api/key/:device/:key', async (req, res) => {
  const { device, key } = req.params;
  if (device !== 'shield' && device !== 'firetv') {
    return res.status(404).json({ error: `Appareil inconnu: ${device}` });
  }
  if (!isKnownKey(key)) {
    return res.status(400).json({ error: `Touche inconnue: ${key}` });
  }
  try {
    await (device === 'shield' ? shield.key(key) : firetv.key(key));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

// Déclenche une scène : POST /api/scene/:name
// Toujours 200 pour une scène connue, avec errors[] par appareil.
app.post('/api/scene/:name', async (req, res) => {
  const { name } = req.params;
  if (!isKnownScene(name)) {
    return res.status(404).json({ error: `Scène inconnue: ${name}` });
  }
  const { scene, errors } = await runScene(name, shield, firetv);
  res.json({ ok: errors.length === 0, scene, requested: name, errors });
});

// Envoi du code PIN de pairing du Shield : POST /api/shield/pin { pin }
app.post('/api/shield/pin', (req, res) => {
  // Le code de pairing du Shield est hexadécimal (6 caractères, 0-9 A-F).
  const code = String(req.body?.pin ?? '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(code)) {
    return res.status(400).json({ error: 'Code invalide (6 caractères hexadécimaux : 0-9, A-F)' });
  }
  try {
    shield.sendPin(code);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err?.message || String(err) });
  }
});

// Force une reconnexion du canal adb du Shield : POST /api/shield/connect
// (nécessite « débogage réseau » activé sur le Shield ; sert la vérité
// terrain volume/mute).
app.post('/api/shield/connect', async (req, res) => {
  const result = await shield.connectSidecar();
  res.json({ ok: result.adb === 'device', ...result });
});

// Force une reconnexion adb de la Fire TV : POST /api/firetv/connect
// Renvoie l'état adb ('device' | 'unauthorized' | 'offline' | 'absent' | ...).
app.post('/api/firetv/connect', async (req, res) => {
  const result = await firetv.connect();
  res.json({ ok: result.adb === 'device', ...result });
});

// Réaligne l'intention de mute Fire TV sans actionner la TV : POST /api/firetv/mute
// Corps { muted: true|false }. Sert à corriger un suivi désynchronisé.
app.post('/api/firetv/mute', (req, res) => {
  const muted = req.body?.muted;
  if (typeof muted !== 'boolean') {
    return res.status(400).json({ error: 'Champ "muted" booléen requis' });
  }
  firetv.setMuteIntent(muted);
  res.json({ ok: true, muted });
});

// --- Réglages & découverte réseau --------------------------------------

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
function validIp(s) {
  return typeof s === 'string' && IP_RE.test(s) && s.split('.').every((o) => Number(o) <= 255);
}

// Réglages courants (IP des TV).
app.get('/api/settings', (req, res) => {
  res.json({
    shieldHost: config.shield.host,
    firetvHost: config.firetv.host,
    firetvPort: config.firetv.port,
  });
});

// Modifie les réglages : persiste puis applique à chaud aux contrôleurs.
app.post('/api/settings', (req, res) => {
  const { shieldHost, firetvHost, firetvPort } = req.body ?? {};
  const patch = {};
  if (shieldHost !== undefined) {
    if (!validIp(shieldHost)) return res.status(400).json({ error: `IP Shield invalide: ${shieldHost}` });
    patch.shieldHost = shieldHost;
  }
  if (firetvHost !== undefined) {
    if (!validIp(firetvHost)) return res.status(400).json({ error: `IP Fire TV invalide: ${firetvHost}` });
    patch.firetvHost = firetvHost;
  }
  if (firetvPort !== undefined) {
    const p = Number(firetvPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return res.status(400).json({ error: `Port Fire TV invalide: ${firetvPort}` });
    }
    patch.firetvPort = p;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Aucun réglage fourni (shieldHost, firetvHost, firetvPort)' });
  }
  saveSettings(patch);
  if (patch.shieldHost !== undefined) shield.setHost(patch.shieldHost);
  if (patch.firetvHost !== undefined || patch.firetvPort !== undefined) {
    firetv.setTarget(patch.firetvHost ?? config.firetv.host, patch.firetvPort ?? config.firetv.port);
  }
  res.json({
    ok: true,
    shieldHost: config.shield.host,
    firetvHost: config.firetv.host,
    firetvPort: config.firetv.port,
  });
});

// Balaye le réseau local à la recherche des TV (quelques secondes).
// Garde anti-empilement : un seul scan à la fois, les appels concurrents
// partagent le même résultat.
let scanInFlight = null;
app.post('/api/discover', async (req, res) => {
  try {
    if (!scanInFlight) {
      scanInFlight = discover().finally(() => { scanInFlight = null; });
    }
    const result = await scanInFlight;
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Frontend statique -------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')));

// Sonde de vivacité (Docker healthcheck, supervision).
app.get('/healthz', (req, res) => res.json({ ok: true }));

const server = app.listen(config.port, () => {
  console.log(`salon-tv à l'écoute sur http://0.0.0.0:${config.port}`);
  console.log(`  Shield : ${config.shield.host || '(non défini)'}  Fire TV : ${config.firetv.host || '(non défini)'}:${config.firetv.port}`);
});

// Arrêt propre (docker stop / Ctrl-C) : ferme le serveur HTTP puis sort.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n[salon-tv] ${sig} reçu, arrêt…`);
    server.close(() => process.exit(0));
    // Filet de sécurité si des connexions traînent.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
