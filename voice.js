/**
 * ひとふで鉄旅 — 音声入力（Web Speech API）と AI車掌の読み上げ（Gemini TTS）
 */
(function () {
  'use strict';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /**
   * 長いポーズでも止まらない音声入力。
   * ブラウザが無音で自動終了しても、利用者が「完了」を押すまで自動で再接続して聞き続ける。
   */
  class VoiceInput {
    static supported() { return !!SR; }
    constructor({ onText, onState, lang } = {}) {
      this.onText = onText || (() => {});
      this.onState = onState || (() => {});
      this.lang = lang || 'ja-JP';
      this.done = '';        // これまでのセッションで確定した文
      this.finalText = '';
      this.wanted = false;
      this.active = false;
      this.rec = null;
      this.restarts = [];
    }
    start() {
      if (!SR) throw new Error('このブラウザは音声入力に対応していません');
      this.wanted = true; this.done = ''; this.finalText = '';
      this._open();
      this.onState('listening');
    }
    _open() {
      const r = new SR();
      r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      r.onresult = (e) => {
        let fin = '', interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) fin += t; else interim += t;
        }
        this.finalText = this.done + fin;
        this.onText(this.finalText, interim);
      };
      r.onerror = (e) => {
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
          this.wanted = false; this.onState('denied');
        }
        // no-speech / aborted / network は onend 側で再接続する
      };
      r.onend = () => {
        this.active = false;
        this.done = this.finalText;
        if (!this.wanted) { this.onState('stopped'); return; }
        // 無音で自動終了 → バッファを保持したまま再接続
        const now = Date.now();
        this.restarts = this.restarts.filter(t => now - t < 10000);
        this.restarts.push(now);
        const wait = this.restarts.length > 6 ? 1500 : 200;
        clearTimeout(this._t);
        this._t = setTimeout(() => {
          if (!this.wanted) { this.onState('stopped'); return; }
          try { this._open(); } catch (_) { this.wanted = false; this.onState('stopped'); }
        }, wait);
      };
      this.rec = r;
      r.start();
      this.active = true;
    }
    stop() {
      this.wanted = false;
      clearTimeout(this._t);
      if (this.active && this.rec) { try { this.rec.stop(); return; } catch (_) { /* fallthrough */ } }
      this.onState('stopped');
    }
  }

  /**
   * 読み上げ原稿のサニタイズ。
   * 「以下を読み上げます」「明るい口調で」などのメタ文・ト書き・記号を取り除き、本文だけにする。
   * （サーバー側 GAS でも同じ処理を二重にかけます）
   */
  function sanitize(t) {
    let s = String(t || '');
    s = s.replace(/```[\s\S]*?```/g, '');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/https?:\/\/\S+/g, '');
    s = s.replace(/[*#_`>~|]/g, '');
    s = s.replace(/^\s*[-・●■◆◇○]\s*/gm, '');
    s = s.replace(/^\s*(ナレーション|読み上げ(原稿|文)?|原稿|本文|AI車掌|車掌|セリフ|台詞|音声|narration|script)\s*[:：]\s*/gim, '');
    s = s.replace(/[（(][^（）()]{0,30}(読み|口調|トーン|声|調子|間を|笑|SE|BGM|効果音|ゆっくり|明るく|元気)[^（）()]{0,30}[）)]/g, '');
    s = s.replace(/[[【〔][^\]】〕]{0,40}[\]】〕]/g, '');
    const meta = [
      /読み上げ(て|ます|る|を|用|原稿)/, /^以下(を|は|の|に)/, /(トーン|口調|声色|話し方|調子)で(読|話|お願い)/,
      /ナレーション(を|です|として|案)/, /(承知|かしこまり)ました/, /^(はい|了解|わかりました)[、。!！]?\s*$/,
      /(プロンプト|システム指示|内部指示)/, /^(here|sure|okay|ok)\b/i
    ];
    s = s.split(/\n+/).map(l => l.trim()).filter(l => l && !meta.some(r => r.test(l))).join('\n');
    s = s.replace(/^[「『"“]+/, '').replace(/[」』"”]+$/, '');
    return s.replace(/[ \t]{2,}/g, ' ').trim();
  }

  function chunks(text) {
    const sents = text.replace(/([。！？!?\n])/g, '$1\u0000').split('\u0000');
    const out = [];
    let cur = '';
    sents.forEach(s => {
      if ((cur + s).length > 350 && cur) { out.push(cur); cur = s; } else cur += s;
    });
    if (cur.trim()) out.push(cur);
    return out;
  }

  function pcmToWav(b64, rate) {
    const bin = atob(b64);
    const len = bin.length;
    const buf = new ArrayBuffer(44 + len);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + len, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, len, true);
    const u = new Uint8Array(buf, 44);
    for (let i = 0; i < len; i++) u[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: 'audio/wav' });
  }

  function toBlob(d) {
    const mime = String(d.mimeType || '');
    if (/wav|mpeg|mp3|ogg/.test(mime)) {
      const bin = atob(d.data); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: mime });
    }
    const m = mime.match(/rate=(\d+)/);
    return pcmToWav(d.data, m ? Number(m[1]) : 24000);
  }

  const Tts = (() => {
    const cache = new Map();
    let audio = null, stopFlag = false, resolveCur = null;

    async function fetchAudio(text) {
      if (cache.has(text)) return cache.get(text);
      const d = await window.API.call('tts', { text, voice: (window.APP_CONFIG || {}).TTS_VOICE }, { silent: true });
      const url = URL.createObjectURL(toBlob(d));
      cache.set(text, url);
      return url;
    }
    function play(url) {
      return new Promise(res => {
        resolveCur = res;
        audio = new Audio(url);
        audio.onended = res; audio.onerror = res;
        audio.play().catch(res);
      });
    }
    async function speak(text, { onstate } = {}) {
      stop();
      const st = onstate || (() => {});
      const clean = sanitize(text);
      if (!clean) { st('idle'); return; }
      const parts = chunks(clean);
      stopFlag = false;
      st('loading');
      try {
        let next = fetchAudio(parts[0]);
        for (let i = 0; i < parts.length; i++) {
          const url = await next;
          if (stopFlag) break;
          if (i + 1 < parts.length) { next = fetchAudio(parts[i + 1]); next.catch(() => {}); }
          st('playing');
          await play(url);
          if (stopFlag) break;
        }
        st('idle');
      } catch (e) {
        console.warn(e);
        st('error');
      }
    }
    function stop() {
      stopFlag = true;
      if (audio) { try { audio.pause(); } catch (_) {} audio = null; }
      if (resolveCur) { resolveCur(); resolveCur = null; }
    }
    return { speak, stop, sanitize };
  })();

  window.VoiceInput = VoiceInput;
  window.Tts = Tts;
})();
