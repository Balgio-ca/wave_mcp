// Fabrique de pilotes — POINT D'EXTENSION unique du projet.
//
// Pour prendre en charge un nouveau téléviseur :
//   1. ajoute une entrée dans catalog.js (type, ports, capacités, guide) ;
//   2. écris un pilote qui respecte le contrat ci-dessous ;
//   3. enregistre-le dans DRIVERS.
// Rien d'autre à modifier : registre, découverte, scènes et interface se
// pilotent à partir du catalogue et des capacités déclarées.
//
// CONTRAT DE PILOTE — un pilote reçoit l'appareil ({id, name, type, host,
// port, room}) et expose :
//
//   get id            identifiant de l'appareil
//   start()           démarre connexion + sondes périodiques
//   stop()            arrêt propre (timers, sockets) — doit être idempotent
//   key(name)         envoie une touche du vocabulaire commun (keys.js)
//   setMuted(bool)    amène le son à l'état voulu (idempotent)
//   standby()         met en veille (idempotent)
//   setMuteIntent(b)  corrige l'état suivi SANS agir sur la TV
//   connectAdb()      (re)connecte le canal auxiliaire -> { adb, online }
//   sendPin(code)     appairage ; lève une erreur si non applicable
//   getState()        état sérialisable, fusionné avec la fiche appareil
//
// Toute méthode peut être asynchrone. Les erreurs doivent porter un message
// en français : elles remontent telles quelles dans errors[] des scènes.

import { AndroidTVController } from './androidtv.js';
import { FireTVController } from './firetv.js';
import { getType, capabilitiesOf } from './catalog.js';

// Périmètre actuel : OS dérivés d'Android. Les deux pilotes utilisent déjà des
// transports différents (protocole Remote v2 + adb / adb seul), ce qui exerce
// réellement l'abstraction. Un OS non-Android (Roku ECP, LG webOS SSAP,
// Samsung Tizen) s'ajouterait de la même façon, sans toucher au reste.
const DRIVERS = {
  androidtv: AndroidTVController,
  firetv: FireTVController,
};

export function createDriver(device) {
  const Driver = DRIVERS[device.type];
  if (!Driver) throw new Error(`Aucun pilote pour le type: ${device.type}`);
  const instance = new Driver(device);
  // Les capacités viennent du catalogue : un pilote ne peut pas mentir sur
  // ce qu'il sait faire, et l'UI s'adapte sans connaître les pilotes.
  instance.capabilities = capabilitiesOf(device.type);
  return instance;
}

export function driverExists(type) {
  return Boolean(DRIVERS[type]) && Boolean(getType(type));
}

// Types réellement utilisables (catalogue ET pilote présents).
export function supportedTypes() {
  return Object.keys(DRIVERS).filter((t) => Boolean(getType(t)));
}
