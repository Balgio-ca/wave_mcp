// Contrôleur TCL Fire TV via ADB sur TCP (port 5555).
//
// La Fire TV n'a pas les services Google : le protocole Shield ne marche pas.
// On envoie donc les touches avec `adb shell input keyevent <code>`.
//
// IMPORTANT — état du mute : la Fire TV ne rapporte pas son état de sourdine de
// façon fiable. On suit donc l'INTENTION côté serveur (persistée dans DATA_DIR)
// et on ne bascule le mute que si l'état voulu diffère de l'état suivi. La
// télécommande physique peut désynchroniser ce suivi (voir README).
//
// FIABILITÉ — la connexion adb TCP de la Fire TV décroche facilement. On :
//   1) sérialise TOUS les appels adb (jamais deux commandes en parallèle, sinon
//      la connexion passe « offline ») ;
//   2) considère qu'une touche acceptée prouve que la TV est en ligne ;
//   3) n'affiche « hors ligne » qu'après plusieurs sondes ratées d'affilée
//      (anti-clignotement) ;
//   4) reconnecte et réessaie une fois si une touche échoue.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, firetvTarget } from './config.js';
import { KEYS, FIRETV_KEYCODE } from './keys.js';

const ADB_TIMEOUT = 6000;
const POLL_INTERVAL = 5000;
const OFFLINE_GRACE = 2; // sondes ratées consécutives avant de déclarer hors ligne

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

    this._chain = Promise.resolve(); // file d'attente : sérialise les appels adb
    this._refreshing = false;
    this._failstreak = 0;
  }

  start() {
    if (!this.status.configured) {
      console.warn('[firetv] FIRETV_HOST non défini — contrôleur inactif.');
      return;
    }
    this._refresh();
    setInterval(() => this._refresh(), POLL_INTERVAL);
  }

  // Sérialise tout accès adb : la commande fn ne démarre qu'une fois la
  // précédente terminée (succès OU échec). Renvoie le résultat réel de fn.
  _serial(fn) {
    const result = this._chain.then(fn, fn);
    this._chain = result.then(() => {}, () => {});
    return result;
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

  _markOnline(awake) {
    this._failstreak = 0;
    if (!this.status.online) console.log('[firetv] en ligne');
    this.status.online = true;
    this.status.awake = awake;
  }

  _markProblem() {
    this._failstreak++;
    if (this._failstreak >= OFFLINE_GRACE && this.status.online) {
      console.log('[firetv] hors ligne');
      this.status.online = false;
      this.status.awake = false;
    }
  }

  // Se (re)connecter puis relever présence + éveil. Sérialisé et anti-pileup.
  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      await this._serial(async () => {
        await adb(['connect', this.target]).catch(() => {});
        const state = await adb(['-s', this.target, 'get-state']).catch(() => 'offline');
        if (state === 'device') {
          const awake = await this._isAwake();
          this._markOnline(awake);
        } else {
          this._markProblem();
        }
      });
    } finally {
      this._refreshing = false;
    }
  }

  async _isAwake() {
    try {
      const out = await adb(['-s', this.target, 'shell', 'dumpsys', 'power'], { timeout: 4000 });
      // Éveillé si mWakefulness=Awake ou Display Power: state=ON
      if (/mWakefulness=Awake/i.test(out)) return true;
      if (/Display Power:\s*state=ON/i.test(out)) return true;
      return false;
    } catch {
      return false;
    }
  }

  // Envoie une touche, avec reconnexion + un réessai si la connexion a décroché.
  // Une touche acceptée prouve la présence -> on marque en ligne aussitôt.
  async _sendKeyevent(code, awake = true) {
    try {
      await adb(['-s', this.target, 'shell', 'input', 'keyevent', String(code)]);
    } catch {
      // Connexion probablement décrochée : reconnexion propre puis un réessai.
      await adb(['disconnect', this.target]).catch(() => {});
      await adb(['connect', this.target]).catch(() => {});
      await adb(['-s', this.target, 'shell', 'input', 'keyevent', String(code)]);
    }
    this._markOnline(awake);
  }

  // Envoie une touche du vocabulaire commun. `mute` passe par le suivi d'intent.
  async key(name) {
    if (name === 'mute') return this.toggleMute();
    const code = KEYS[name]?.firetv;
    if (code == null) throw new Error(`Touche inconnue: ${name}`);
    return this._serial(() => this._sendKeyevent(code));
  }

  // Bouton mute du bandeau : bascule et met à jour l'intention suivie.
  async toggleMute() {
    return this._serial(async () => {
      await this._sendKeyevent(KEYS.mute.firetv);
      this.status.muted = !this.status.muted;
      this._saveMute();
    });
  }

  // Amène le mute à l'état voulu — ne bascule QUE si l'intention diffère.
  async setMuted(desired) {
    if (this.status.muted === desired) return; // déjà dans l'état voulu (suivi)
    return this._serial(async () => {
      await this._sendKeyevent(KEYS.mute.firetv);
      this.status.muted = desired;
      this._saveMute();
    });
  }

  // Endormissement idempotent (KEYCODE_SLEEP ne rallume jamais).
  async standby() {
    return this._serial(() => this._sendKeyevent(FIRETV_KEYCODE.SLEEP, false));
  }

  // Corrige l'intention de mute SANS envoyer de touche à la TV.
  // Sert à réaligner le suivi quand la télécommande physique l'a désynchronisé.
  setMuteIntent(muted) {
    this.status.muted = Boolean(muted);
    this._saveMute();
  }

  getState() {
    return { ...this.status };
  }
}
