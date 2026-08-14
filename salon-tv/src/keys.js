// Vocabulaire de touches commun aux deux TV.
//
// Chaque touche connue est mappée vers :
//   - shield : le nom RemoteKeyCode du paquet androidtv-remote
//   - firetv : le code numérique `adb shell input keyevent <code>`
//
// Une touche absente de cette table est inconnue -> l'API répond 400.

export const KEYS = {
  // Volume / lecture / alimentation
  mute:       { shield: 'KEYCODE_VOLUME_MUTE',    firetv: 164 },
  vol_down:   { shield: 'KEYCODE_VOLUME_DOWN',    firetv: 25 },
  vol_up:     { shield: 'KEYCODE_VOLUME_UP',      firetv: 24 },
  play_pause: { shield: 'KEYCODE_MEDIA_PLAY_PAUSE', firetv: 85 },
  power:      { shield: 'KEYCODE_POWER',          firetv: 26 },

  // Pavé directionnel
  up:    { shield: 'KEYCODE_DPAD_UP',     firetv: 19 },
  down:  { shield: 'KEYCODE_DPAD_DOWN',   firetv: 20 },
  left:  { shield: 'KEYCODE_DPAD_LEFT',   firetv: 21 },
  right: { shield: 'KEYCODE_DPAD_RIGHT',  firetv: 22 },
  ok:    { shield: 'KEYCODE_DPAD_CENTER', firetv: 23 },
  back:  { shield: 'KEYCODE_BACK',        firetv: 4 },
  home:  { shield: 'KEYCODE_HOME',        firetv: 3 },
  menu:  { shield: 'KEYCODE_MENU',        firetv: 82 },
};

// Codes Fire TV supplémentaires utilisés par les scènes (endormissement idempotent).
export const FIRETV_KEYCODE = {
  SLEEP: 223,
  WAKEUP: 224,
};

export function isKnownKey(name) {
  return Object.prototype.hasOwnProperty.call(KEYS, name);
}
