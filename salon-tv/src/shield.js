// Contrôleur Nvidia Shield via le protocole Android TV Remote v2.
//
// S'appuie sur le paquet `androidtv-remote`. Points importants du paquet :
//   - événements : secret, ready, powered, volume, current_app, unpaired, error
//     (il n'y a PAS d'événement `close`)
//   - getCertificate() -> { key, cert } à persister pour survivre aux redémarrages
//   - sendCode(pin) pendant le pairing ; sendKey(code, direction) ; sendPower()
//
// Reconnexion : backoff exponentiel, protégé par des drapeaux pour que les
// tentatives ne s'empilent jamais.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { AndroidRemote, RemoteKeyCode, RemoteDirection } from 'androidtv-remote';
import { config } from './config.js';
import { KEYS } from './keys.js';

const RECONNECT_MIN = 2000;      // 2 s
const RECONNECT_MAX = 60000;     // plafond 60 s
const PROBE_INTERVAL = 5000;     // sonde TCP de présence
const PROBE_TIMEOUT = 1500;

export class ShieldController {
  constructor() {
    this.certPath = path.join(config.dataDir, 'shield-cert.json');

    this.remote = null;          // instance AndroidRemote courante
    this.connecting = false;     // un connect() est en cours
    this.reconnectTimer = null;  // un reconnect est déjà programmé
    this.backoff = RECONNECT_MIN;
    this._started = false;       // la boucle de sonde tourne

    // État observable exposé à l'API.
    this.status = {
      configured: Boolean(config.shield.host),
      online: false,       // joignable sur le réseau
      awake: false,        // allumé (vs veille)
      paired: false,       // certificat valide en place
      pairing: false,      // en attente d'un code PIN
      app: null,           // package de l'app au premier plan
      volume: null,        // 0..100
      muted: false,
    };
  }

  start() {
    if (!this.status.configured) {
      console.warn('[shield] SHIELD_HOST non défini — contrôleur inactif.');
      return;
    }
    this._begin();
  }

  _begin() {
    if (this._started) return;
    this._started = true;
    this._loadCert();
    this.connect();
    // Sonde de présence indépendante de la bibliothèque : donne un
    // online/offline honnête même sans événement `close`.
    setInterval(() => this._probe(), PROBE_INTERVAL);
  }

  // Change l'hôte à chaud (réglages / découverte réseau).
  setHost(host) {
    if (host === config.shield.host) return;
    console.log(`[shield] Nouvel hôte : ${host}`);
    config.shield.host = host;
    this.status.configured = Boolean(host);
    // Coupe la connexion courante et repart proprement. Si la nouvelle TV
    // n'est pas celle du certificat, le flux `unpaired` relancera le pairing.
    this._clearReconnect();
    try { this.remote?.stop?.(); } catch { /* ignore */ }
    this.remote = null;
    this.connecting = false;
    this.backoff = RECONNECT_MIN;
    this.status.online = false;
    this.status.awake = false;
    this.status.pairing = false;
    this.status.app = null;
    this.status.volume = null;
    if (!this.status.configured) return;
    if (!this._started) this._begin();
    else this._scheduleReconnect(0);
  }

  _loadCert() {
    try {
      const raw = fs.readFileSync(this.certPath, 'utf8');
      this.cert = JSON.parse(raw);
      this.status.paired = Boolean(this.cert?.key && this.cert?.cert);
      if (this.status.paired) console.log('[shield] Certificat chargé depuis', this.certPath);
    } catch {
      this.cert = undefined;
      this.status.paired = false;
    }
  }

  _saveCert(cert) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.certPath, JSON.stringify(cert), { mode: 0o600 });
      this.cert = cert;
      this.status.paired = true;
      console.log('[shield] Certificat enregistré.');
    } catch (err) {
      console.error('[shield] Échec écriture certificat :', err.message);
    }
  }

  _deleteCert() {
    try { fs.unlinkSync(this.certPath); } catch { /* déjà absent */ }
    this.cert = undefined;
    this.status.paired = false;
  }

  async connect() {
    // Garde : jamais deux connexions en parallèle.
    if (this.connecting) return;
    this.connecting = true;
    this._clearReconnect();

    const options = {
      pairing_port: config.shield.pairingPort,
      remote_port: config.shield.remotePort,
      service_name: config.shield.serviceName,
      cert: this.cert,
    };

    const remote = new AndroidRemote(config.shield.host, options);
    this.remote = remote;
    this._wire(remote);

    try {
      const started = await remote.start();
      // Après start(), certains messages d'erreur protocolaires sont émis sur
      // les sous-gestionnaires internes ; on y attache un garde pour éviter un
      // crash « Unhandled error » de Node.
      this._guardInternal(remote);
      this.connecting = false;
      if (!started) {
        // Appareil injoignable / pairing avorté : on retente en backoff.
        this._scheduleReconnect();
      }
    } catch (err) {
      this.connecting = false;
      console.error('[shield] connect a échoué :', err?.message || err);
      this._scheduleReconnect();
    }
  }

  _wire(remote) {
    remote.on('secret', () => {
      // La TV affiche un code : le frontend doit demander le PIN.
      this.status.pairing = true;
      console.log('[shield] En attente du code PIN…');
    });

    remote.on('ready', () => {
      this.status.pairing = false;
      this.status.online = true;
      this.backoff = RECONNECT_MIN;
      // Le pairing vient peut-être de réussir : on persiste le certificat.
      const cert = remote.getCertificate();
      if (cert?.key && cert?.cert) this._saveCert(cert);
      console.log('[shield] Prêt.');
    });

    remote.on('powered', (powered) => {
      this.status.online = true;
      this.status.awake = Boolean(powered);
    });

    remote.on('volume', (v) => {
      this.status.online = true;
      if (v && typeof v.maximum === 'number' && v.maximum > 0) {
        this.status.volume = Math.round((v.level / v.maximum) * 100);
      }
      this.status.muted = Boolean(v?.muted);
    });

    remote.on('current_app', (app) => {
      this.status.online = true;
      this.status.app = app || null;
    });

    remote.on('unpaired', () => {
      console.warn('[shield] Dé-pairé — suppression du certificat et re-pairing.');
      this._deleteCert();
      this.status.pairing = false;
      this._recreate();
    });

    remote.on('error', (err) => {
      // AndroidRemote n'émet normalement pas `error`, mais on écoute par
      // sécurité pour ne jamais laisser un `error` non géré crasher Node.
      console.error('[shield] error :', err?.message || err);
    });
  }

  // Attache un écouteur d'erreur sur les sous-gestionnaires internes du paquet
  // (RemoteManager/PairingManager) qui, eux, émettent parfois `error`.
  _guardInternal(remote) {
    for (const mgr of [remote.remoteManager, remote.pairingManager]) {
      if (mgr && typeof mgr.on === 'function' && mgr.listenerCount('error') === 0) {
        mgr.on('error', (e) => console.error('[shield] (interne) error :', e?.error || e?.message || e));
      }
    }
  }

  _recreate() {
    try { this.remote?.stop?.(); } catch { /* ignore */ }
    this.remote = null;
    this.connecting = false;
    this._scheduleReconnect(0);
  }

  _scheduleReconnect(delay) {
    if (this.reconnectTimer || this.connecting) return; // garde anti-empilement
    const wait = delay ?? this.backoff;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    // Backoff exponentiel plafonné pour la prochaine fois.
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX);
    if (wait > 0) console.log(`[shield] Reconnexion dans ${Math.round(wait / 1000)} s`);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Sonde TCP du port distant : vérité terrain pour online/offline.
  _probe() {
    if (!this.status.configured) return;
    const sock = net.connect({ host: config.shield.host, port: config.shield.remotePort });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      const was = this.status.online;
      this.status.online = ok;
      if (!ok) {
        this.status.awake = false;
        this.status.app = null;
        // Injoignable alors qu'on a un certificat : on tente de se reconnecter.
        if (this.status.paired && !this.connecting) this._scheduleReconnect();
      }
      if (was !== ok) console.log(`[shield] ${ok ? 'en ligne' : 'hors ligne'}`);
    };
    sock.setTimeout(PROBE_TIMEOUT);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  }

  // Prêt à recevoir des touches : la session « remote » doit être établie.
  _ready() {
    return Boolean(this.remote && this.remote.remoteManager);
  }

  _assertReady() {
    if (this.status.pairing) throw new Error('Shield en attente de pairing');
    if (!this._ready()) throw new Error('Shield hors ligne');
  }

  sendPin(code) {
    if (!this.status.pairing || !this.remote?.pairingManager) {
      throw new Error('Aucun pairing en cours');
    }
    this.remote.sendCode(String(code));
  }

  // Envoie une touche du vocabulaire commun. `power` passe par sendPower().
  key(name) {
    this._assertReady();
    if (name === 'power') {
      this.remote.sendPower();
      return;
    }
    const codeName = KEYS[name]?.shield;
    if (!codeName) throw new Error(`Touche inconnue: ${name}`);
    const code = RemoteKeyCode[codeName];
    this.remote.sendKey(code, RemoteDirection.SHORT);
    // Mise à jour optimiste du mute : certains Shield n'émettent pas toujours
    // l'événement `volume` après une bascule. Sans ça, l'état suivi ne changerait
    // jamais et chaque scène re-basculerait (« on/off/on/off »). L'événement
    // `volume`, quand il arrive, écrase cette valeur avec la réalité.
    if (name === 'mute') this.status.muted = !this.status.muted;
  }

  // Amène le mute à l'état voulu. key('mute') met à jour l'état suivi de façon
  // optimiste, donc deux appels successifs ne re-basculent pas à tort.
  setMuted(desired) {
    this._assertReady();
    if (this.status.muted !== desired) this.key('mute');
  }

  // Éteint de façon idempotente : ne bascule l'alimentation que si allumé.
  standby() {
    this._assertReady();
    if (this.status.awake) this.remote.sendPower();
  }

  getState() {
    return { ...this.status };
  }
}
