/**
 * ひとふで鉄旅 — 設定ファイル
 * GAS の URL などはここだけを書き換えてください（コード本体には書きません）。
 */
window.APP_CONFIG = {
  // GAS「ウェブアプリ」としてデプロイした URL（…/exec）
  GAS_URL: "https://script.google.com/macros/s/AKfycbz5ZwX4ZmWX9UYqt4WYGWiHmhBchMH6I2q6FymwAcEzNFSjymFzUlEqoVWxoMixgBOZ/exec",

  APP_NAME: "ひとふで鉄旅",
  VERSION: "v1.0.0",

  // 写真・動画アップロードの上限（MB）。GAS の受信上限を考慮して 20MB 程度まで
  MAX_UPLOAD_MB: 20,

  // AI車掌の声（Gemini TTS のプリセット名。明るめ: Puck / Zephyr / Leda など）
  TTS_VOICE: "Puck",

  // 地図の初期表示
  MAP_CENTER: [36.2, 138.0],
  MAP_ZOOM: 5
};
