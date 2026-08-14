// Contrôleur TCL Fire TV via ADB sur TCP (port 5555).
//
// La Fire TV n'a pas les services Google : le protocole Shield ne marche pas.
// On envoie donc les touches avec `adb shell input keyevent <code>`.
//
// IMPORTANT — état du mute : la Fire TV ne rapporte pas son état de sourdine de
// façon fiable. On suit donc l'INTENTION côté serveur (persistée dans DATA_DIR)
// et on ne bascule le mute que si l'état voulu diffère de l'état suivi. La
// télécommande physique peut désynchroniser ce suivi (voir README).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, firetvTarget } from './config.js';
import { KEYS, FIRETV_KEYCODE } from './keys.js';

const ADB_TIMEOUT = 6000;
const POLL_INTERVAL = 5000;

function adb(args, { timeout = ADB_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim() || 'échec adb'));
      resolve(String(stdout).trim());
    });
  });
}

export class FireTVController {
  constructor() {
    this.target = firetvTarget();
    this.mutePath = path.join(config.dataDir, 'firetv-mute.json');

    this.status = {
      configured: Boolean(config.firetv.host),
      online: false,
      awake: false,
      // État de mute *suivi* (intention), pas mesuré sur l'appareil.
      muted: false,
    };
    this._loadMute();
    this._connecting = false;
  }

  start() {
    if (!this.status.configured) {
      console.warn('[firetv] FIRETV_HOST non défini — contrôleur inactif.');
      return;
    }
    this._refresh();
    setInterval(() => this._refresh(), POLL_INTERVAL);
  }

  _loadMute() {
    try {
      const raw = fs.readFileSync(this.mutePath, 'utf8');
      this.status.muted = Boolean(JSON.parse(raw)?.muted);
    } catch {
      this.status.muted = false;
    }
  }

  _saveMute() {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.mutePath, JSON.stringify({ muted: this.status.muted }));
    } catch (err) {
      console.error('[firetv] Échec écriture intent mute :', err.message);
    }
  }

  // Se (re)connecter puis relever présence + éveil.
  async _refresh() {
    if (this._connecting) return;
    this._connecting = true;
    try {
      await adb(['connect', this.target]).catch(() => {});
      const state = await adb(['-s', this.target, 'get-state']).catch(() => 'offline');
      const online = state === 'device';
      if (online !== this.status.online) console.log(`[firetv] ${online ? 'en ligne' : 'hors ligne'}`);
      this.status.online = online;
      this.status.awake = online ? await this._isAwake() : false;
    } finally {
      this._connecting = false;
    }
  }

  async _isAwake() {
    try {
      const out = await adb(['-s', this.target, 'shell', 'dumpsys', 'power']);
      // Éveillé si mWakefulness=Awake ou Display Power: state=ON
      if (/mWakefulness=Awake/i.test(out)) return true;
      if (/Display Power:\s*state=ON/i.test(out)) return true;
      return false;
    } catch {
      return false;
    }
  }

  async _keyevent(code) {
    await adb(['-s', this.target, 'shell', 'input', 'keyevent', String(code)]);
  }

  // Envoie une touche du vocabulaire commun. `mute` passe par le suivi d'intent.
  async key(name) {
    if (name === 'mute') return this.toggleMute();
    const code = KEYS[name]?.firetv;
    if (code == null) throw new Error(`Touche inconnue: ${name}`);
    await this._connectFirst();
    await this._keyevent(code);
  }

  async _connectFirst() {
    // Une connexion rapide avant chaque action ; adb connect est idempotent.
    await adb(['connect', this.target]).catch(() => {});
  }

  // Bouton mute du bandeau : bascule et met à jour l'intention suivie.
  async toggleMute() {
    await this._connectFirst();
    await this._keyevent(KEYS.mute.firetv);
    this.status.muted = !this.status.muted;
    this._saveMute();
  }

  // Amène le mute à l'état voulu — ne bascule QUE si l'intention diffère.
  async setMuted(desired) {
    if (this.status.muted === desired) return; // déjà dans l'état voulu (suivi)
    await this._connectFirst();
    await this._keyevent(KEYS.mute.firetv);
    this.status.muted = desired;
    this._saveMute();
  }

  // Endormissement idempotent (KEYCODE_SLEEP ne rallume jamais).
  async standby() {
    await this._connectFirst();
    await this._keyevent(FIRETV_KEYCODE.SLEEP);
  }

  getState() {
    return { ...this.status };
  }
}
