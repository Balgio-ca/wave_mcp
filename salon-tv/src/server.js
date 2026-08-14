// salon-tv — serveur Express : sert le frontend statique et l'API de contrôle.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ShieldController } from './shield.js';
import { FireTVController } from './firetv.js';
import { isKnownKey } from './keys.js';
import { isKnownScene, runScene, SCENE_NAMES } from './scenes.js';

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
  const { errors } = await runScene(name, shield, firetv);
  res.json({ ok: errors.length === 0, scene: name, errors });
});

// Envoi du code PIN de pairing du Shield : POST /api/shield/pin { pin }
app.post('/api/shield/pin', (req, res) => {
  const pin = req.body?.pin;
  if (!pin || !/^\d{4,8}$/.test(String(pin).trim())) {
    return res.status(400).json({ error: 'PIN invalide (4 à 8 chiffres attendus)' });
  }
  try {
    shield.sendPin(String(pin).trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err?.message || String(err) });
  }
});

// --- Frontend statique -------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, () => {
  console.log(`salon-tv à l'écoute sur http://0.0.0.0:${config.port}`);
  console.log(`  Shield : ${config.shield.host || '(non défini)'}  Fire TV : ${config.firetv.host || '(non défini)'}:${config.firetv.port}`);
});
