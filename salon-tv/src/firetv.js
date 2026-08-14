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
//   1) sérialise TOUS les appels adb (jamais deux commandes en parallèle) ;
//   2) considère qu'une touche acceptée prouve que la TV est en ligne ;
//   3) n'affiche « hors ligne » qu'après plusieurs sondes ratées (anti-clignote) ;
//   4) RÉCUPÈRE un état « offline » par disconnect+connect (un simple connect ne
//      suffit pas), et réessaie une fois une touche qui échoue.

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
      if (err) {
        const e = new Error((stderr || err.message || '').trim() || 'échec adb');
        e.code = err.code; // préserve ENOENT (adb absent), etc.
        return reject(e);
      }
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
      // 'device' | 'offline' | 'unauthorized' | 'absent' | 'inconnu'
      adb: 'inconnu',
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

  // Sérialise tout accès adb : fn ne démarre qu'une fois la précédente terminée.
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
    this.status.adb = 'device';
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

  // Lit l'état de l'appareil dans `adb devices` : device/offline/unauthorized.
  async _deviceState() {
    try {
      const out = await adb(['devices']);
      for (const line of out.split('\n')) {
        const [addr, st] = line.trim().split(/\s+/);
        if (addr === this.target) return st || 'offline';
      }
      return 'offline'; // pas listé
    } catch (e) {
      if (e.code === 'ENOENT') return 'absent';
      return 'inconnu';
    }
  }

  // connect, puis si l'état n'est pas 'device', reset propre (disconnect+connect)
  // — un simple `adb connect` ne récupère PAS une connexion « offline ».
  async _probeState() {
    let connectErr = null;
    await adb(['connect', this.target]).catch((e) => { connectErr = e; });
    if (connectErr && connectErr.code === 'ENOENT') return 'absent';

    let state = await this._deviceState();
    if (state !== 'device' && state !== 'absent') {
      await adb(['disconnect', this.target]).catch(() => {});
      await adb(['connect', this.target]).catch(() => {});
      state = await this._deviceState();
    }
    return state;
  }

  // Sonde périodique : présence + éveil. Sérialisée et anti-pileup.
  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      await this._serial(async () => {
        const state = await this._probeState();
        this.status.adb = state;
        if (state === 'device') {
          this._markOnline(await this._isAwake());
        } else {
          this._markProblem();
        }
      });
    } finally {
      this._refreshing = false;
    }
  }

  // Reconnexion à la demande (bouton « Connecter » de l'UI).
  async connect() {
    return this._serial(async () => {
      await adb(['disconnect', this.target]).catch(() => {});
      let connectErr = null;
      await adb(['connect', this.target]).catch((e) => { connectErr = e; });
      if (connectErr && connectErr.code === 'ENOENT') {
        this.status.adb = 'absent';
        this._markProblem();
        return { adb: 'absent', online: false };
      }
      const state = await this._deviceState();
      this.status.adb = state;
      if (state === 'device') {
        this._markOnline(await this._isAwake());
      } else {
        this._markProblem();
      }
      return { adb: state, online: this.status.online };
    });
  }

  async _isAwake() {
    try {
      const out = await adb(['-s', this.target, 'shell', 'dumpsys', 'power'], { timeout: 4000 });
      if (/mWakefulness=Awake/i.test(out)) return true;
      if (/Display Power:\s*state=ON/i.test(out)) return true;
      return false;
    } catch {
      return false;
    }
  }

  // Envoie une touche, avec reconnexion + un réessai si la connexion a décroché.
  async _sendKeyevent(code, awake = true) {
    try {
      await adb(['-s', this.target, 'shell', 'input', 'keyevent', String(code)]);
    } catch {
      await adb(['disconnect', this.target]).catch(() => {});
      await adb(['connect', this.target]).catch(() => {});
      await adb(['-s', this.target, 'shell', 'input', 'keyevent', String(code)]);
    }
    this._markOnline(awake); // touche acceptée -> présence prouvée
  }

  async key(name) {
    if (name === 'mute') return this.toggleMute();
    const code = KEYS[name]?.firetv;
    if (code == null) throw new Error(`Touche inconnue: ${name}`);
    return this._serial(() => this._sendKeyevent(code));
  }

  async toggleMute() {
    return this._serial(async () => {
      await this._sendKeyevent(KEYS.mute.firetv);
      this.status.muted = !this.status.muted;
      this._saveMute();
    });
  }

  async setMuted(desired) {
    if (this.status.muted === desired) return; // déjà dans l'état voulu (suivi)
    return this._serial(async () => {
      await this._sendKeyevent(KEYS.mute.firetv);
      this.status.muted = desired;
      this._saveMute();
    });
  }

  async standby() {
    return this._serial(() => this._sendKeyevent(FIRETV_KEYCODE.SLEEP, false));
  }

  // Corrige l'intention de mute SANS envoyer de touche à la TV.
  setMuteIntent(muted) {
    this.status.muted = Boolean(muted);
    this._saveMute();
  }

  getState() {
    return { ...this.status };
  }
}
