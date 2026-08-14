// Contrôleur Roku via ECP (External Control Protocol) — HTTP simple, port 8060.
//
// Ce pilote existe autant pour la prise en charge des Roku que pour PROUVER que
// le squelette est agnostique du protocole : ni adb, ni TLS, ni appairage —
// juste des requêtes HTTP — et pourtant il s'branche exactement comme les
// autres (mêmes méthodes, mêmes capacités déclarées dans catalog.js).
//
// ⚠️ Non validé sur matériel réel (aucun Roku disponible pendant le
// développement). L'API ECP est stable et documentée par Roku, mais considère
// ce pilote comme expérimental tant qu'il n'a pas tourné sur un appareil.
//
// Limite : ECP ne publie pas le niveau de volume. Le mute est donc suivi côté
// serveur (comme l'ancien mode « intent ») et le VU-mètre reste masqué —
// capacité 'volume' absente du catalogue.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const POLL_INTERVAL = 5000;
const HTTP_TIMEOUT = 4000;
const OFFLINE_GRACE = 2;

// Vocabulaire commun -> touches ECP.
const ECP_KEYS = {
  mute: 'VolumeMute',
  vol_down: 'VolumeDown',
  vol_up: 'VolumeUp',
  play_pause: 'Play',
  power: 'PowerOff',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  ok: 'Select',
  back: 'Back',
  home: 'Home',
  menu: 'Info',
};

// Parser pur (testé) : extrait les champs utiles de /query/device-info.
export function parseDeviceInfo(xml) {
  const pick = (tag) => {
    const m = String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const power = pick('power-mode');
  if (power === null && !pick('model-name')) return null; // réponse inexploitable
  return {
    model: pick('model-name') || pick('friendly-model-name'),
    name: pick('user-device-name') || pick('friendly-device-name'),
    // « PowerOn » = allumé ; « DisplayOff »/« Headless » = veille.
    awake: power ? /^poweron$/i.test(power) : null,
  };
}

export class RokuController {
  constructor(device) {
    this.device = device;
    this.mutePath = path.join(config.dataDir, `mute-${device.id}.json`);

    this.status = {
      online: false,
      awake: false,
      muted: false,
      muteSource: 'intent',   // ECP ne rapporte pas le mute
      volume: null,           // pas de volume absolu en ECP
      adb: 'off',             // sans objet pour ce transport
      model: null,
    };
    this._loadMute();

    this.pollTimer = null;
    this._gen = 0;
    this._failstreak = 0;
    this._stopped = false;
  }

  get id() { return this.device.id; }
  get base() { return `http://${this.device.host}:${this.device.port}`; }

  start() {
    this._refresh();
    this.pollTimer = setInterval(() => this._refresh(), POLL_INTERVAL);
  }

  stop() {
    this._stopped = true;
    this._gen++;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  _loadMute() {
    try {
      this.status.muted = Boolean(JSON.parse(fs.readFileSync(this.mutePath, 'utf8'))?.muted);
    } catch {
      this.status.muted = false;
    }
  }

  _saveMute() {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.mutePath, JSON.stringify({ muted: this.status.muted }));
    } catch { /* best-effort */ }
  }

  // Toutes les erreurs sont traduites : elles remontent telles quelles dans
  // errors[] des scènes (contrat de pilote, voir drivers.js).
  async _http(method, urlPath) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT);
    try {
      const r = await fetch(this.base + urlPath, { method, signal: ctrl.signal });
      if (!r.ok) throw new Error(`${this.device.name} : réponse ECP ${r.status}`);
      return method === 'GET' ? await r.text() : '';
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new Error(`${this.device.name} ne répond pas (délai dépassé)`);
      }
      if (/fetch failed|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/i.test(err?.message || '')) {
        throw new Error(`${this.device.name} injoignable — TV allumée ? contrôle réseau activé ?`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _refresh() {
    if (this._stopped) return;
    const gen = this._gen;
    try {
      const xml = await this._http('GET', '/query/device-info');
      if (gen !== this._gen) return;
      const info = parseDeviceInfo(xml);
      this._failstreak = 0;
      if (!this.status.online) console.log(`[${this.device.name}] en ligne`);
      this.status.online = true;
      if (info) {
        this.status.model = info.model;
        if (info.awake !== null) this.status.awake = info.awake;
      }
    } catch {
      if (gen !== this._gen) return;
      this._failstreak++;
      if (this._failstreak >= OFFLINE_GRACE && this.status.online) {
        console.log(`[${this.device.name}] hors ligne`);
        this.status.online = false;
        this.status.awake = false;
      }
    }
  }

  async _press(ecpKey) {
    await this._http('POST', '/keypress/' + ecpKey);
    this._failstreak = 0;
    this.status.online = true;
  }

  async key(name) {
    if (name === 'mute') return this.setMuted(!this.status.muted);
    const ecp = ECP_KEYS[name];
    if (!ecp) throw new Error(`Touche inconnue: ${name}`);
    await this._press(ecp);
    if (name === 'power') setTimeout(() => this._refresh(), 1500);
  }

  // ECP n'expose pas l'état de mute : bascule + suivi d'intention.
  async setMuted(desired) {
    if (this.status.muted === desired) return;
    await this._press(ECP_KEYS.mute);
    this.status.muted = desired;
    this._saveMute();
  }

  async standby() {
    // PowerOff est idempotent sur les Roku TV ; sans objet sur les clés HDMI.
    if (!this.status.awake) return;
    await this._press(ECP_KEYS.power);
    this.status.awake = false;
  }

  setMuteIntent(muted) {
    this.status.muted = Boolean(muted);
    this._saveMute();
  }

  // Pas de canal adb ni de pairing pour ce transport.
  async connectAdb() {
    await this._refresh();
    return { adb: 'off', online: this.status.online };
  }

  sendPin() {
    throw new Error("Cet appareil ne demande pas de code PIN");
  }

  getState() {
    return { ...this.device, ...this.status, kind: 'roku', paired: true, pairing: false, app: null };
  }
}
