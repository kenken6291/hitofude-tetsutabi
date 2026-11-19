/**
 * ひとふで鉄旅～JR完乗コレクション — 設定ファイル
 * GAS の URL などはここだけを書き換えてください（コード本体には書きません）。
 */
window.APP_CONFIG = {
  // GAS「ウェブアプリ」としてデプロイした URL（…/exec）
  GAS_URL: "https://script.google.com/macros/s/AKfycbz5ZwX4ZmWX9UYqt4WYGWiHmhBchMH6I2q6FymwAcEzNFSjymFzUlEqoVWxoMixgBOZ/exec",

  APP_NAME: "ひとふで鉄旅～JR完乗コレクション",
  VERSION: "v1.1.0",

  // 既定のGeminiモデル（画面で選ばなかった時に使う）。空文字 "" = 自動（汎用の最新）
  GEMINI_MODEL: "",

  // 画面の「AIモデル」選択肢（value が API のモデルID）
  // 指定モデルに該当がない（廃止・未公開・名前違い）時は GAS 側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: "",                  label: "自動モード（汎用の最新）" },
    { value: "gemini-4-hydrogen", label: "4 Hydrogen（日々の暮らしをサポート）" },
    { value: "gemini-4-neon",     label: "4 Neon（Deeper analysis）" },
    { value: "gemini-4-carbon",   label: "4 Carbon（Code & complex work）" },
    { value: "gemini-4-argon",    label: "4 Argon" },
    { value: "gemini-3.8-flash",  label: "3.8 Flash" },
    { value: "gemini-3.5-flash",  label: "3.5 Flash" }
  ],

  // 写真・動画アップロードの上限（MB）。GAS の受信上限を考慮して 20MB 程度まで
  MAX_UPLOAD_MB: 20,

  // AI車掌の声（Gemini TTS のプリセット名。明るめ: Puck / Zephyr / Leda など）
  TTS_VOICE: "Puck",

  // 地図の初期表示
  MAP_CENTER: [36.2, 138.0],
  MAP_ZOOM: 5
};
