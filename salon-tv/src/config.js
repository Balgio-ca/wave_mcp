// Configuration centralisée, lue depuis l'environnement.
// Toutes les valeurs ont un défaut raisonnable pour le NAS UGREEN.

export const config = {
  port: parseInt(process.env.PORT || '8099', 10),

  // Répertoire persistant (certificat de pairing Shield, intent mute Fire TV).
  dataDir: process.env.DATA_DIR || '/app/data',

  shield: {
    host: process.env.SHIELD_HOST || '',
    // Ports standards du protocole Android TV Remote v2.
    pairingPort: parseInt(process.env.SHIELD_PAIRING_PORT || '6467', 10),
    remotePort: parseInt(process.env.SHIELD_REMOTE_PORT || '6466', 10),
    // Nom affiché sur la TV pendant le pairing.
    serviceName: process.env.SHIELD_NAME || 'salon-tv',
  },

  firetv: {
    host: process.env.FIRETV_HOST || '',
    port: parseInt(process.env.FIRETV_PORT || '5555', 10),
  },
};

export function firetvTarget() {
  return `${config.firetv.host}:${config.firetv.port}`;
}
