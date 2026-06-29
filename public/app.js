// フキダシ用ビルボード: 親(トラッキング対象)がどんな角度でも常にカメラ正面を向かせる。
// ただし up軸をワールド上方向に固定し、吹き出しが傾かない(ロールしない=常に水平)ようにする。
AFRAME.registerComponent('billboard', {
  init() {
    // tickは毎フレーム走るため、ベクトル/行列は使い回してGC負荷を避ける
    this.camPos = new THREE.Vector3();
    this.targetPos = new THREE.Vector3();
    this.qParentInv = new THREE.Quaternion();
    this.dir = new THREE.Vector3();
    this.qWorld = new THREE.Quaternion();
    this.up = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.realUp = new THREE.Vector3();
    this.m = new THREE.Matrix4();
  },
  tick() {
    const cam = this.el.sceneEl.camera;
    const obj = this.el.object3D;
    if (!cam || !obj.parent) return;

    cam.getWorldPosition(this.camPos);
    obj.getWorldPosition(this.targetPos);

    // プレーンの表面(+Z)が向くべき方向 = ターゲット→カメラ
    this.dir.subVectors(this.camPos, this.targetPos).normalize();

    // up軸はワールド上方向に固定してロール(傾き)を抑える。
    this.up.set(0, 1, 0);
    if (Math.abs(this.dir.dot(this.up)) > 0.99) this.up.set(0, 0, 1); // 真上/真下を見たときの破綻回避
    this.right.crossVectors(this.up, this.dir).normalize();
    this.realUp.crossVectors(this.dir, this.right).normalize();
    // 列ベクトル [right, up, forward(+Z)] から回転を作る
    this.m.makeBasis(this.right, this.realUp, this.dir);
    this.qWorld.setFromRotationMatrix(this.m);

    // 親のワールド回転の逆を掛けてローカル回転へ
    obj.parent.getWorldQuaternion(this.qParentInv).invert();
    obj.quaternion.copy(this.qParentInv.multiply(this.qWorld));
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // ===== チューニング用定数 =====
  const SPIRIT_STORAGE_KEY = 'ar_agents_2_spirits';
  const MEMORY_STORAGE_KEY  = 'ar_agents_2_memory';
  const GAZE_DURATION = 0;           // 0=タップ即注入
  const SCAN_INTERVAL = 700;         // AIスキャン(物体検出)の間隔(ms)
  const TURN_GAP_MS = 250;           // セリフ読み上げ後、次のターンまでの間(ms)
  const MAX_SPIRITS = 5;             // 精霊の最大数（ところてん式FIFO）
  const BANTER_PAUSE_AFTER = 30;     // この会話ターン数に達したら一時停止
  const COLORS = ['#00e5ff', '#ff5252', '#ffd740', '#69f0ae', '#e040fb', '#ff9100'];

  // ===== DOM =====
  const videoElement = document.getElementById('camera-feed');
  const overlayCanvas = document.getElementById('camera-overlay-canvas');
  const captureGuide = document.getElementById('capture-guide');
  const guideText = document.getElementById('guide-text');
  const scanLine = document.getElementById('scan-line');
  const scanStatus = document.getElementById('scan-status');
  const flashOverlay = document.getElementById('flash-overlay');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const snapshotCanvas = document.getElementById('snapshot-canvas');
  const arSceneContainer = document.getElementById('ar-scene-container');
  const toastDiv = document.getElementById('toast');
  const modeToggle = document.getElementById('mode-toggle');
  const modeScanBtn = document.getElementById('mode-scan-btn');
  const modeBanterBtn = document.getElementById('mode-banter-btn');
  const resetBtn = document.getElementById('reset-btn');
  const spiritCountBtn = document.getElementById('spirit-count-btn');
  const spiritCountNum = document.getElementById('spirit-count-num');
  const spiritPanel = document.getElementById('spirit-panel');
  const spiritPanelCount = document.getElementById('spirit-panel-count');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');

  // ===== 状態 =====
  let currentSituation = null;
  const SITUATIONS = [
    { location: 'a living room', weather: 'pouring rain outside the window' },
    { location: 'a bench in a quiet park', weather: 'pleasant sunshine filtering through the trees' },
    { location: 'the terrace of a stylish cafe', weather: 'a cloudy sky with a bit of a breeze' },
    { location: 'a cluttered work desk', weather: 'the soft glow of the setting sun at dusk' },
    { location: 'a study at midnight', weather: 'a starry sky with a cold wind blowing' }
  ];
  let mode = 'scan';    // 'scan' (初期登録) | 'ar' (ARシーン + 追加召喚)
  let uiMode = 'scan'; // 'scan' (スキャンUI表示) | 'banter' (会話鑑賞)
  let arReadyFired = false;
  let banterTurns = 0;
  let banterPaused = false;
  let lastBanterErr = '—';
  const spirits = []; // {image, vessel, name, personality, voice, color}

  let mediaStream = null;
  let activeVideo = videoElement; // 現在フレームを取得する対象のvideo要素
  let arVideo = null;

  let scanSessionId = 0;
  let isScanning = false;
  let isRequestPending = false;
  let scanTimeout = null;
  let detectedTargets = []; // [{target, sig, color}, ...]
  let isCompiling = false;
  let lastScanMs = null;     // 直近の /api/segment-vessels にかかった時間(ms)。デバッグ表示用。
  let scanReqStart = null;   // 物体検出リクエスト中の開始時刻(performance.now)。通信中はライブで経過を表示。
  let lastScanAt = 0;        // lastScanMsを更新した時刻(どちらを表示するか判定用)
  let lastBanterMs = null;   // 直近の /api/banter にかかった時間(ms)。
  let banterReqStart = null; // banterリクエスト中の開始時刻。通信中はライブで経過を表示。
  let lastBanterAt = 0;      // lastBanterMsを更新した時刻
  // スキャン方式: 'auto'=一定間隔で自動 / 'manual'=画面タップで1回ずつ。設定で切替・永続化。
  // 既定は manual(画面タップでスキャン開始)。設定で auto に切替可能。

  // 推論モデルプリセット: 'cerebras'(高速) / 'gemma4'(標準ルーティング)
  const MODEL_PRESET_KEY = 'ar_agents_2_model';
  let modelPreset = localStorage.getItem(MODEL_PRESET_KEY) === 'gemma4' ? 'gemma4' : 'cerebras';

  // 言語設定(English基準＋日本語含む6言語)。AIの生成言語・On-device TTSの読み上げ言語に反映。
  const LANG_KEY = 'ar_agents_2_lang';
  const LANGS = [
    { code: 'en',    flag: '🇺🇸', label: 'English',    bcp47: 'en-US'  },
    { code: 'ja',    flag: '🇯🇵', label: '日本語',      bcp47: 'ja-JP'  },
    { code: 'zh',    flag: '🇨🇳', label: '中文',        bcp47: 'zh-CN'  },
    { code: 'ko',    flag: '🇰🇷', label: '한국어',      bcp47: 'ko-KR'  },
    { code: 'es',    flag: '🇪🇸', label: 'Español',    bcp47: 'es-ES'  },
    { code: 'fr',    flag: '🇫🇷', label: 'Français',   bcp47: 'fr-FR'  },
  ];
  const UI_STRINGS = {
    en: {
      scanBtn: 'Scan', talkBtn: 'Talk', resetBtn: 'Reset', resetConfirm: 'Confirm?',
      spiritLabel: (n) => n === 1 ? ' spirit' : ' spirits',
      spiritPanelPrefix: 'Summoned spirits:',
      settingsTitle: 'Settings', langLabel: 'Language',
      langHint: "Spirits' names and speech are generated in this language.",
      ttsLabel: 'Voice (TTS)', ttsElevenLabs: 'ElevenLabs', ttsOnDevice: 'On-device',
      ttsHint: 'High-quality cloud voices (needs ElevenLabs API key).',
      modelLabel: 'Model', modelCerebras: '⚡ Cerebras', modelOpenRouter: 'OpenRouter',
      summoningVoice: (name) => `Summoning the spirit of ${name}!`,
      modelHintCerebras: '⚡ Cerebras: ultra-fast inference (Gemma 4 31B).',
      modelHintOpenRouter: 'OpenRouter: standard routing (Gemma 4 31B).',
      guideGaze: 'Gaze at an object to summon its spirit...',
      guideScan: 'Tap the screen to scan an object',
      guideScanNew: 'Tap the screen to scan a new object',
      guideGazeName: (name) => `Gaze to summon "${name}"`,
      loadingPrepare: 'Preparing MindAR compile...',
      loadingRestore: 'Restoring spirits...',
      loadingExtract: (p) => `Extracting soul... ${Math.min(100, Math.round(p))}%`,
      loadingSummon: (p) => `Summoning... ${Math.min(100, Math.round(p))}%`,
      loadingUpdate: 'Updating AR scene...',
      toastTapSound: 'Tap to enable sound',
      toastNoCamera: 'Camera API unavailable. Please access over HTTPS.',
      toastCameraPermission: 'Please allow camera access.',
      toastSummonFirst: 'Summon a spirit first',
      toastImageFailed: 'Failed to process the image. Please try again.',
      toastSummonedOne: (name) => `✨ ${name} has taken form!`,
      toastSummonedMany: (names) => `✨ ${names} have taken form!`,
      toastSummoning: (name) => `✨ Summoning ${name}...`,
      toastUpdatingAR: 'Updating AR scene...',
      toastAddFailed: 'Failed to add spirit. Returning to the previous conversation...',
      toastCompileFailed: 'AR compile failed. Re-scanning...',
      toastCameraFailed: 'Failed to restart the camera. Please reload the page.',
      toastTapSpeak: '🔊 Tap the screen to hear the spirits speak',
      toastUpdate: 'Update available — tap to restart',
      banterPauseTap: 'Tap to continue',
    },
    ja: {
      scanBtn: 'スキャン', talkBtn: 'トーク', resetBtn: 'リセット', resetConfirm: '確認',
      spiritLabel: ' 体の精霊',
      spiritPanelPrefix: '召喚した精霊:',
      settingsTitle: '設定', langLabel: '言語',
      langHint: '精霊の名前と会話がこの言語で生成されます。',
      ttsLabel: '音声 (TTS)', ttsElevenLabs: 'ElevenLabs', ttsOnDevice: 'オンデバイス',
      ttsHint: '高品質クラウド音声（ElevenLabs APIキーが必要）。',
      modelLabel: 'モデル', modelCerebras: '⚡ Cerebras', modelOpenRouter: 'OpenRouter',
      summoningVoice: (name) => `${name}の精霊を召喚します！`,
      modelHintCerebras: '⚡ Cerebras: 超高速推論 (Gemma 4 31B)。',
      modelHintOpenRouter: 'OpenRouter: 標準ルーティング (Gemma 4 31B)。',
      guideGaze: '物体を見つめて精霊を召喚...',
      guideScan: '画面をタップしてスキャン',
      guideScanNew: '画面をタップして新しい物体をスキャン',
      guideGazeName: (name) => `「${name}」を召喚するために見つめて`,
      loadingPrepare: 'コンパイル準備中...',
      loadingRestore: '精霊を復元中...',
      loadingExtract: (p) => `魂を抽出中... ${Math.min(100, Math.round(p))}%`,
      loadingSummon: (p) => `召喚中... ${Math.min(100, Math.round(p))}%`,
      loadingUpdate: 'ARシーンを更新中...',
      toastTapSound: 'タップして音を有効にする',
      toastNoCamera: 'カメラAPIが利用できません。HTTPSでアクセスしてください。',
      toastCameraPermission: 'カメラへのアクセスを許可してください。',
      toastSummonFirst: '先に精霊を召喚してください',
      toastImageFailed: '画像の処理に失敗しました。もう一度お試しください。',
      toastSummonedOne: (name) => `✨ ${name}が姿を現した！`,
      toastSummonedMany: (names) => `✨ ${names}が姿を現した！`,
      toastSummoning: (name) => `✨ ${name}を召喚中...`,
      toastUpdatingAR: 'ARシーンを更新中...',
      toastAddFailed: '精霊の追加に失敗しました。前の会話に戻ります...',
      toastCompileFailed: 'ARコンパイルに失敗しました。再スキャン中...',
      toastCameraFailed: 'カメラの再起動に失敗しました。ページをリロードしてください。',
      toastTapSpeak: '🔊 画面をタップして精霊の声を聞く',
      toastUpdate: '更新があります — タップして再起動',
      banterPauseTap: 'タップして再開',
    },
  };
  function s(key, ...args) {
    const strings = UI_STRINGS[language] || UI_STRINGS.en;
    const val = strings[key] !== undefined ? strings[key] : UI_STRINGS.en[key];
    if (val === undefined) return key;
    return typeof val === 'function' ? val(...args) : val;
  }

  function detectOsLanguage() {
    const nav = (navigator.language || navigator.userLanguage || 'en').split('-')[0].toLowerCase();
    return (LANGS.find(l => l.code === nav) || LANGS[0]).code;
  }
  let language = localStorage.getItem(LANG_KEY) || detectOsLanguage();
  if (!LANGS.some(l => l.code === language)) language = 'en';
  function langBcp47() { const l = LANGS.find(x => x.code === language); return l ? l.bcp47 : 'en-US'; }

  // 通信中(in-flight fetch)を数える。window.fetchをラップして全API通信を捕捉し、
  // デバッグ表示＋通信ログをサーバー(PCコンソール)へ転送する。
  let netInFlight = 0;
  let lastNetUrl = '';
  const _origFetch = window.fetch.bind(window);
  // サーバーの /api/clientlog へ1行送る(PC側のターミナルに出る)。生fetchで送り再帰を避ける。
  function logToPC(line) {
    try {
      _origFetch('/api/clientlog', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line }), keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }
  if (!window.__fetchWrapped) {
    window.fetch = function (input, init) {
      const url = (() => { try { return String((input && input.url) || input || ''); } catch (e) { return ''; } })();
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = (init && init.method) || (input && input.method) || 'GET';
      // ログ送信自身は計測・転送しない(無限ループ防止)
      if (path.indexOf('/api/clientlog') !== -1) return _origFetch(input, init);
      netInFlight++;
      lastNetUrl = path;
      const t0 = performance.now();
      const p = _origFetch(input, init);
      p.then(
        (r) => logToPC(`${method} ${path} -> ${r.status} ${Math.round(performance.now() - t0)}ms`),
        (e) => logToPC(`${method} ${path} -> ERR ${String(e && e.message || e).slice(0, 80)} ${Math.round(performance.now() - t0)}ms`)
      );
      p.finally(() => { netInFlight = Math.max(0, netInFlight - 1); });
      return p;
    };
    window.__fetchWrapped = true;
  }

  let gazeStartTime = null;
  let gazeInterval = null;
  let gazeSig = null; // すり替え判定の基準シグネチャ。凝視中は毎周期その時点のフレームへ更新する(runScanCycle参照)

  let compiledMindUrl = null;
  let compiledMindBuffer = null; // 直前のコンパイル済みArrayBuffer (差分コンパイル用)
  let compiledSpiritCount = 0;  // 直前コンパイル時の精霊数
  const visibleTargets = new Set();          // 実際にMindARでトラッキング中の精霊index
  // 会話判定用の「猶予付き」可視集合。トラッキングが一瞬切れても少しの間は映っている扱いにし、
  // ARの追跡ブレで会話が止まったり、なかなか始まらなくなるのを防ぐ。
  const banterVisible = new Set();
  const visibleGraceTimers = {};
  const VISIBLE_GRACE_MS = 2200;
  function clearBanterVisibility() {
    banterVisible.clear();
    Object.keys(visibleGraceTimers).forEach(k => {
      if (visibleGraceTimers[k]) clearTimeout(visibleGraceTimers[k]);
      delete visibleGraceTimers[k];
    });
  }

  // ==========================================
  // 会話メモリ (LocalStorage) — セッションをまたいで精霊が覚えている
  // ==========================================
  function banterMemoryKey() {
    return spirits.map(s => s.name).sort().join('|');
  }
  function saveBanterMemory(history) {
    if (!history || history.length === 0) return;
    try {
      const all = JSON.parse(localStorage.getItem(MEMORY_STORAGE_KEY) || '{}');
      all[banterMemoryKey()] = history.slice(-15);
      const keys = Object.keys(all);
      if (keys.length > 10) delete all[keys[0]]; // 古い組み合わせを自動削除
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  function loadBanterMemory() {
    try {
      const all = JSON.parse(localStorage.getItem(MEMORY_STORAGE_KEY) || '{}');
      return all[banterMemoryKey()] || [];
    } catch (e) { return []; }
  }

  // ==========================================
  // MindARコンパイルキャッシュ (IndexedDB)
  // ページ再読み込み時に同じ精霊セットなら再コンパイルをスキップする
  // ==========================================
  function mindCacheKey(spList) {
    // 各精霊のvessel名 + base64画像の先頭64文字でキーを生成 (十分ユニーク)
    return spList.map(s => `${s.vessel}|${s.image.slice(23, 87)}`).join('::');
  }
  function getMindCache(key) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('yaorozu_mind', 1);
        req.onupgradeneeded = (e) => e.target.result.createObjectStore('cache');
        req.onsuccess = (e) => {
          try {
            const gr = e.target.result.transaction('cache', 'readonly').objectStore('cache').get('v1');
            gr.onsuccess = () => { const d = gr.result; resolve(d && d.key === key ? d.buffer : null); };
            gr.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        };
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  function setMindCache(key, buffer) {
    try {
      const req = indexedDB.open('yaorozu_mind', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('cache');
      req.onsuccess = (e) => {
        try { e.target.result.transaction('cache', 'readwrite').objectStore('cache').put({ key, buffer }, 'v1'); } catch (_) {}
      };
    } catch (_) {}
  }
  function clearMindCache() {
    try {
      const req = indexedDB.open('yaorozu_mind', 1);
      req.onsuccess = (e) => {
        try { e.target.result.transaction('cache', 'readwrite').objectStore('cache').clear(); } catch (_) {}
      };
    } catch (_) {}
  }

  function updateSpiritCountBtn() {
    spiritCountNum.textContent = spirits.length;
    spiritCountBtn.classList.toggle('hidden', spirits.length === 0);
    const spiritLabelEl = document.getElementById('spirit-label');
    if (spiritLabelEl) spiritLabelEl.textContent = s('spiritLabel', spirits.length);
  }

  // ==========================================
  // 精霊一覧パネル
  // ==========================================

  function openSpiritPanel() {
    renderSpiritPanel();
    spiritPanel.classList.add('open');
    startPanelChat();
  }

  function closeSpiritPanel() {
    spiritPanel.classList.remove('open');
    stopPanelChat();
  }

  function renderSpiritPanel() {
    const list = document.getElementById('spirit-list');
    spiritPanelCount.textContent = spirits.length;
    list.innerHTML = '';
    spirits.forEach((spirit, idx) => {
      const row = document.createElement('div');
      row.className = 'spirit-row' + (spirit.muted ? ' muted' : '');
      row.innerHTML = `
        <img class="spirit-thumb" src="${spirit.image}" style="border-color:${spirit.color}">
        <div class="spirit-info">
          <div class="spirit-name">${spirit.name}</div>
          <div class="spirit-vessel">${spirit.vessel}</div>
        </div>
        <button class="spirit-mute-btn" data-idx="${idx}" aria-label="Mute">${spirit.muted ? '🔇' : '🔊'}</button>
        <button class="spirit-delete-btn" data-idx="${idx}">Release</button>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll('.spirit-mute-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleMute(parseInt(btn.dataset.idx)));
    });
    list.querySelectorAll('.spirit-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteSpirit(parseInt(btn.dataset.idx)));
    });
  }

  // 精霊のミュート切替(タップ)。ミュート中はTTSを出さない。
  function toggleMute(idx) {
    if (!spirits[idx]) return;
    spirits[idx].muted = !spirits[idx].muted;
    renderSpiritPanel();
    if (spirits[idx].muted) stopSpeaking(); // 発話中なら即停止
  }

  async function deleteSpirit(idx) {
    closeSpiritPanel();
    spirits.splice(idx, 1);
    updateSpiritCountBtn();

    if (spirits.length === 0) {
      executeReset();
      return;
    }

    // 1体でもARを維持(ソロ会話できる)。残った精霊でシーンを作り直す。
    await enterAR(null);
  }

  spiritCountBtn.addEventListener('click', openSpiritPanel);
  document.getElementById('spirit-panel-backdrop').addEventListener('click', closeSpiritPanel);
  document.getElementById('spirit-panel-close').addEventListener('click', closeSpiritPanel);

  // ==========================================
  // 一覧内の会話 (カメラに写っていなくてもパネル内で精霊同士が会話する)
  // ==========================================
  let panelChatRunning = false;
  let panelChatSession = 0;
  let panelChatTimeout = null;
  let panelHistory = [];
  let panelSituation = null;

  function appendPanelMsg(idx, text) {
    const chat = document.getElementById('panel-chat');
    if (!chat) return;
    chat.innerHTML = ''; // 一覧ビューでは最後の吹き出し1つだけを表示する
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    msg.style.borderColor = spirits[idx].color;
    const who = document.createElement('span');
    who.className = 'who'; who.style.color = spirits[idx].color; who.textContent = spirits[idx].name;
    const body = document.createElement('span'); body.textContent = text;
    msg.appendChild(who); msg.appendChild(body);
    chat.appendChild(msg);
  }

  // パネル用のターン取得(全精霊が参加・カメラ可視性は不要)
  function fetchPanelTurn(participants) {
    const names = new Set(participants.map(i => spirits[i].name));
    const filtered = panelHistory.filter(h => names.has(h.name));
    const body = JSON.stringify({
      spirits: participants.map(i => ({ name: spirits[i].name, vessel: spirits[i].vessel, personality: spirits[i].personality })),
      history: filtered,
      situation: panelSituation,
      language
    });
    return fetch('/api/banter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(r => r.json())
      .then(data => {
        if (data.error || !data.reply) return { data };
        const local = parseInt(String(data.nextSpeaker).replace('agent', ''), 10);
        const globalIdx = participants[Number.isInteger(local) ? local : 0] ?? participants[0];
        return { data, globalIdx, speechText: ttsTextFromData(data) };
      })
      .catch(err => ({ data: { error: String(err) } }));
  }

  async function runPanelTurn(session) {
    if (!panelChatRunning || session !== panelChatSession) return;
    const participants = spirits.map((_, i) => i);
    if (participants.length < 1) { stopPanelChat(); return; }

    const turn = await fetchPanelTurn(participants);
    if (!panelChatRunning || session !== panelChatSession) return;
    if (!turn || !turn.data || turn.data.error || !turn.data.reply) {
      panelChatTimeout = setTimeout(() => runPanelTurn(session), 3000);
      return;
    }
    const idx = turn.globalIdx;
    panelHistory.push({ name: spirits[idx].name, text: turn.data.reply });
    if (panelHistory.length > 15) panelHistory.shift();
    appendPanelMsg(idx, turn.data.reply);

    const isEnding = turn.data.isEnd === true;
    const next = (spoke) => {
      if (!panelChatRunning || session !== panelChatSession) return;
      if (isEnding) {
        panelChatTimeout = setTimeout(() => { panelHistory = []; runPanelTurn(session); }, 4000);
      } else {
        const delay = spoke ? TURN_GAP_MS : Math.min(4000, 900 + turn.data.reply.length * 80);
        panelChatTimeout = setTimeout(() => runPanelTurn(session), delay);
      }
    };

    // ミュート中は無音で進める
    if (spirits[idx] && spirits[idx].muted) { next(false); return; }
    if (ttsEngine === 'standalone') {
      speakStandalone(idx, turn.speechText, next);
    } else {
      const blob = await fetchTTS(idx, turn.speechText).then(r => (r.ok ? r.blob() : null)).catch(() => null);
      if (!panelChatRunning || session !== panelChatSession) return;
      playLine(blob, next);
    }
  }

  function startPanelChat() {
    if (spirits.length < 1) { showToast(s('toastSummonFirst')); return; }
    stopBanterLoop();
    panelChatSession++;
    panelChatRunning = true;
    panelHistory = [];
    panelSituation = SITUATIONS[Math.floor(Math.random() * SITUATIONS.length)];
    const chat = document.getElementById('panel-chat');
    if (chat) { chat.classList.remove('hidden'); chat.innerHTML = ''; }
    runPanelTurn(panelChatSession);
  }

  function stopPanelChat() {
    if (!panelChatRunning) return;
    panelChatRunning = false;
    if (panelChatTimeout) { clearTimeout(panelChatTimeout); panelChatTimeout = null; }
    stopSpeaking();
  }

  // ==========================================
  // トースト通知
  // ==========================================

  let toastTimeout = null;
  function showToast(msg, sticky = false) {
    toastDiv.textContent = msg;
    toastDiv.classList.remove('hidden');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = sticky ? null : setTimeout(() => toastDiv.classList.add('hidden'), 2600);
  }
  function hideToast() {
    if (toastTimeout) clearTimeout(toastTimeout);
    toastDiv.classList.add('hidden');
  }

  // ==========================================
  // カメラ (スキャンフェーズ用)
  // ==========================================

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast(s('toastNoCamera'), true);
      return false;
    }
    // 既存のstreamを再利用してiOSで許可ダイアログが毎回出るのを防ぐ
    if (mediaStream && mediaStream.active) {
      videoElement.srcObject = mediaStream;
      return true;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      videoElement.srcObject = mediaStream;
      // MindARが内部でgetUserMedia()を呼ぶたびに許可ダイアログが出るのを防ぐ。
      // 既存のstreamをそのまま返すことでOS側への新規リクエストをスキップする。
      if (!navigator.mediaDevices._gumPatched) {
        const _orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (mediaStream && mediaStream.active && constraints && constraints.video) {
            return mediaStream;
          }
          return _orig(constraints);
        };
        navigator.mediaDevices._gumPatched = true;
        navigator.mediaDevices._gumOrig = _orig;
      }
      return true;
    } catch (err) {
      console.error('Camera error:', err);
      showToast(s('toastCameraPermission'), true);
      return false;
    }
  }

  function stopCamera() {
    // トラックは停止しない（再開時にiOSで許可ダイアログが出るため）
    // video要素からだけ切り離す。
    videoElement.srcObject = null;
  }

  function releaseCamera() {
    // getUserMediaパッチを元に戻す
    if (navigator.mediaDevices._gumPatched && navigator.mediaDevices._gumOrig) {
      navigator.mediaDevices.getUserMedia = navigator.mediaDevices._gumOrig;
      delete navigator.mediaDevices._gumPatched;
      delete navigator.mediaDevices._gumOrig;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    videoElement.srcObject = null;
  }

  // ==========================================
  // スキャンループ (Gemini物体検出 / 両モード共用)
  // ==========================================

  function nextColor() {
    return COLORS[spirits.length % COLORS.length];
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // 切り出した画像領域から、彩度で重み付けした色相ヒストグラムでドミナントカラーを抽出
  function extractThemeColor(source, box) {
    try {
      const [ymin, xmin, ymax, xmax] = box.map(v => v / 1000);
      const sw = Math.max(1, (xmax - xmin) * source.width);
      const sh = Math.max(1, (ymax - ymin) * source.height);
      const c = document.createElement('canvas');
      c.width = 24;
      c.height = 24;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(source, xmin * source.width, ymin * source.height, sw, sh, 0, 0, 24, 24);
      const data = cx.getImageData(0, 0, 24, 24).data;

      const bins = new Array(12).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        if (d < 0.08 || l < 0.12 || l > 0.92) continue; // 無彩色・白飛び・黒潰れは無視
        let h;
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        const s = d / (1 - Math.abs(2 * l - 1));
        bins[Math.floor((h * 60) / 30) % 12] += s;
      }

      let best = -1, bestV = 0;
      bins.forEach((v, i) => { if (v > bestV) { bestV = v; best = i; } });
      if (best < 0) return nextColor(); // ほぼ無彩色のオブジェクトはパレットから
      return hslToHex(best * 30 + 15, 85, 62);
    } catch (e) {
      return nextColor();
    }
  }

  // ===== 画像類似度による重複判定 =====
  // 登録済みのモノがトラッキングを外れた瞬間に別名で再認識され、
  // 二重召喚されてマーカーが重なるのを防ぐ
  const DUP_SIMILARITY = 0.85; // 正規化相関がこれ以上なら同一物とみなす
  // 凝視のすり替え検知用。これ"未満"なら別物とみなしゲージをリセットする。
  // 重複判定(0.85)を流用すると同一物体のbboxジッタで誤リセットし召喚不能になるため、
  // 「明らかに別物」だけを捉える十分緩い値にする。
  const GAZE_SWAP_THRESHOLD = 0.45;

  function regionSignature(source, box) {
    try {
      const [ymin, xmin, ymax, xmax] = box.map(v => v / 1000);
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(
        source,
        xmin * source.width, ymin * source.height,
        Math.max(1, (xmax - xmin) * source.width), Math.max(1, (ymax - ymin) * source.height),
        0, 0, 16, 16
      );
      const d = cx.getImageData(0, 0, 16, 16).data;
      const v = new Float32Array(256);
      let mean = 0;
      for (let i = 0; i < 256; i++) {
        v[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
        mean += v[i];
      }
      mean /= 256;
      let norm = 0;
      for (let i = 0; i < 256; i++) {
        v[i] -= mean;
        norm += v[i] * v[i];
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < 256; i++) v[i] /= norm;
      return v;
    } catch (e) {
      return null;
    }
  }

  function matchesRegisteredImage(sig) {
    if (!sig) return false;
    return spirits.some(s => sigCorrelation(s.sig, sig) >= DUP_SIMILARITY);
  }

  // 2つの正規化シグネチャの相関(内積)。どちらか欠けていれば0(=非類似)。
  function sigCorrelation(a, b) {
    if (!a || !b) return 0;
    let dot = 0;
    for (let i = 0; i < 256; i++) dot += a[i] * b[i];
    return dot;
  }

  // 検出矩形が、トラッキング中の精霊のスクリーン位置と重なっているか
  // (既に会話に参加しているモノの上から二重登録されるのを防ぐ)
  function isOverTrackedSpirit(box) {
    if (mode !== 'ar' || visibleTargets.size === 0) return false;
    const sceneEl = arSceneContainer.querySelector('a-scene');
    if (!sceneEl || !sceneEl.camera) return false;

    const guideRect = captureGuide.getBoundingClientRect();
    const [ymin, xmin, ymax, xmax] = box.map(v => v / 1000);
    const bx1 = guideRect.left + xmin * guideRect.width;
    const by1 = guideRect.top + ymin * guideRect.height;
    const bx2 = guideRect.left + xmax * guideRect.width;
    const by2 = guideRect.top + ymax * guideRect.height;
    const mx = (bx2 - bx1) * 0.2;
    const my = (by2 - by1) * 0.2;

    const v = new THREE.Vector3();
    for (const i of visibleTargets) {
      const el = document.getElementById(`target-entity-${i}`);
      if (!el || !el.object3D) continue;
      el.object3D.getWorldPosition(v);
      v.project(sceneEl.camera);
      const sx = (v.x + 1) / 2 * window.innerWidth;
      const sy = (1 - v.y) / 2 * window.innerHeight;
      if (sx >= bx1 - mx && sx <= bx2 + mx && sy >= by1 - my && sy <= by2 + my) return true;
    }
    return false;
  }

  function isRegistered(name) {
    const n = String(name).replace(/\s/g, '');
    return spirits.some(s => String(s.vessel).replace(/\s/g, '') === n);
  }

  // 精霊名の重複を避ける。同名(例:コップ2個→両方「器の精霊」)だと
  // banter履歴の名前ベースのフィルタでセリフが混ざるため、②③…を付けて一意にする。
  function uniqueSpiritName(base) {
    const name = base || `Spirit ${spirits.length}`;
    if (!spirits.some(s => s.name === name)) return name;
    const SUP = ['②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    for (let n = 2; n <= 20; n++) {
      const cand = name + (SUP[n - 2] || n);
      if (!spirits.some(s => s.name === cand)) return cand;
    }
    return `${name} ${spirits.length + 1}`;
  }

  function updateScanGuideVisibility() {
    if (uiMode === 'banter') {
      captureGuide.classList.add('hidden');
      guideText.classList.add('hidden');
      return;
    }
    if (mode === 'ar') {
      if (visibleTargets.size > 0) {
        // 精霊が映っている間: 文言を隠し、capture枠は完全透明(opacity:0)で残す。
        // display:noneにするとgetBoundingClientRectが0になりAIスキャンが壊れ、isOverTrackedSpirit
        // も効かなくなるため、レイアウトを保つopacity:0で「見えないが計測可能」にする
        // (0.35の半透明だとコーナー枠がAR映像に被って見えてしまう)。
        guideText.classList.add('hidden');
        captureGuide.classList.remove('hidden');
        captureGuide.classList.remove('subtle');
        captureGuide.classList.add('transparent');
      } else {
        guideText.classList.remove('hidden');
        captureGuide.classList.remove('hidden');
        captureGuide.classList.remove('transparent');
        captureGuide.classList.add('subtle');
      }
    } else {
      guideText.classList.remove('hidden');
      captureGuide.classList.remove('hidden');
      captureGuide.classList.remove('subtle');
      captureGuide.classList.remove('transparent');
    }
  }

  function updateGuideUI() {
    const color = '#00e5ff';
    guideText.textContent = mode === 'scan'
      ? s('guideScan')
      : s('guideScanNew');
    scanStatus.textContent = '';
    guideText.style.borderColor = color;
    guideText.style.boxShadow = `0 0 14px ${color}59`;
    scanLine.style.background = `linear-gradient(90deg, transparent, ${color}, transparent)`;
    scanLine.style.boxShadow = `0 0 14px ${color}`;
    updateScanLine();
    updateScanGuideVisibility();
  }

  function updateScanLine() {
    const show = uiMode === 'scan' && isScanning && gazeStartTime === null && isRequestPending;
    scanLine.classList.toggle('hidden', !show);
  }

  function startScanning() {
    scanSessionId++;
    isScanning = true;
    isRequestPending = false;
    detectedTargets = [];
    resetGaze();
    updateGuideUI();
    syncOverlayCanvas();
    clearOverlay();
  }

  function stopScanning() {
    isScanning = false;
    isRequestPending = false;
    if (scanTimeout) {
      clearTimeout(scanTimeout);
      scanTimeout = null;
    }
    resetGaze();
  }

  // 画面タップで即スキャン。manualでは1回ずつ、autoでは次サイクルを前倒しする。
  function triggerScan() {
    if (uiMode !== 'scan') return;
    if (!isScanning) startScanning();   // 状態を整える(manualは自動スキャンしない)
    if (isRequestPending) return;       // 進行中なら二重起動しない
    if (scanTimeout) { clearTimeout(scanTimeout); scanTimeout = null; }
    runScanCycle();
  }

  function syncOverlayCanvas() {
    const rect = captureGuide.getBoundingClientRect();
    overlayCanvas.width = Math.round(rect.width);
    overlayCanvas.height = Math.round(rect.height);
    // 位置はCSSで#capture-guideと同一ルール指定済み — JS側のpx指定は不要
  }

  function clearOverlay() {
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  // ガイド枠内の映像を snapshot-canvas に切り出す
  // - スキャン用video: object-fit: cover の座標補正
  // - MindARのvideo: 要素自体がカバーサイズに広げられているため線形マッピング
  function captureGuideRegion() {
    const video = activeVideo;
    const guideRect = captureGuide.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();

    // ガイドが非表示(display:none)や映像未準備のときは空画像を作らずに諦める
    if (guideRect.width < 1 || guideRect.height < 1 || !video.videoWidth) return null;

    let originX, originY, scale;
    if (video === videoElement) {
      scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
      originX = videoRect.left + (videoRect.width - video.videoWidth * scale) / 2;
      originY = videoRect.top + (videoRect.height - video.videoHeight * scale) / 2;
    } else {
      scale = videoRect.width / video.videoWidth;
      originX = videoRect.left;
      originY = videoRect.top;
    }

    const sourceX = (guideRect.left - originX) / scale;
    const sourceY = (guideRect.top - originY) / scale;
    const sourceW = guideRect.width / scale;
    const sourceH = guideRect.height / scale;

    // AI送信用に最大512pxに縮小 (転送量削減・高速化)
    const MAX_DIM = 512;
    const scale512 = Math.min(1, MAX_DIM / Math.max(sourceW, sourceH));
    snapshotCanvas.width = Math.round(sourceW * scale512);
    snapshotCanvas.height = Math.round(sourceH * scale512);
    const ctx = snapshotCanvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, sourceX, sourceY, sourceW, sourceH, 0, 0, snapshotCanvas.width, snapshotCanvas.height);

    return snapshotCanvas.toDataURL('image/jpeg', 0.85);
  }

  async function runScanCycle() {
    if (!isScanning || isRequestPending) return;
    const session = scanSessionId;

    // コンパイル中は新規スキャンを止める (登録済みのモノは検出後に名前でスキップする)
    if (isCompiling) {
      clearOverlay();
      resetGaze();
      return;
    }

    if (!activeVideo || activeVideo.videoWidth === 0) return;

    const dataUrl = captureGuideRegion();
    if (!dataUrl) return;

    isRequestPending = true;
    scanReqStart = performance.now();
    updateScanLine(); // タップ中はスキャンライン表示

    try {
      const response = await fetch('/api/segment-vessels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, language, modelPreset })
      });
      const data = await response.json();
      // /api/segment-vessels にかかった時間を確定してデバッグ表示する
      lastScanMs = Math.round(performance.now() - scanReqStart);
      lastScanAt = performance.now();

      if (!isScanning || scanSessionId !== session) return;

      if (data.targets && data.targets.length > 0) {
        // 全ターゲットを評価し、未登録・未重複のものだけ収集する
        const newTargets = [];
        const registeredNames = [];
        for (const target of data.targets) {
          const sig = regionSignature(snapshotCanvas, target.box);
          if (isRegistered(target.name) || isOverTrackedSpirit(target.box) || matchesRegisteredImage(sig)) {
            registeredNames.push(target.name);
          } else {
            const color = extractThemeColor(snapshotCanvas, target.box);
            newTargets.push({ target, sig, color });
          }
        }

        // スキャンは同時に1つまで: 候補が複数あっても、最も大きく写っている対象だけを残す
        if (newTargets.length > 1) {
          const boxArea = (b) => Math.max(0, (b[2] - b[0])) * Math.max(0, (b[3] - b[1]));
          newTargets.sort((a, b) => boxArea(b.target.box) - boxArea(a.target.box));
          newTargets.length = 1;
        }

        if (newTargets.length === 0) {
          // 検出されたモノはすべて登録済み
          detectedTargets = [];
          clearOverlay();
          if (mode === 'scan') {
            scanStatus.textContent = `"${registeredNames[0]}" already registered — point at a different object`;
          } else {
            updateGuideUI();
          }
          resetGaze();
        } else {
          // ターゲット集合が変わった(別のモノに切り替わった)場合はゲージをリセット
          const newNames = newTargets.map(t => t.target.name).sort().join(',');
          const oldNames = detectedTargets.map(t => t.target.name).sort().join(',');
          if (newNames !== oldNames && gazeStartTime !== null) {
            resetGaze();
          }

          // 凝視中に枠内が「別物」へすり替わった瞬間だけゲージをリセットし、溜めた時間の乗っ取りを防ぐ。
          // 【意図的なトレードオフ】基準gazeSigは凝視開始時に固定せず、毎周期”直前フレーム”へ更新する(下記)。
          //  - 開始フレームに固定すると、同一物体のbboxジッタ/露出ドリフトで相関が落ち、静止した正規の
          //    対象でもゲージが誤リセットされ「召喚できない」P1不具合になる（しきい値を下げても低テクスチャ
          //    物体では起こりうる）。隣接フレーム比較なら静止物は決して誤リセットしない。
          //  - 代償として、隣接フレーム間で相関が急落しない”緩慢なパン”でのすり替えは捕捉できない。
          //    これは別系統のmotion-watch（カメラ移動で即リセット）が補完する。
          //  しきい値は重複判定(0.85)ではなく、明らかな別物だけを捉える緩いGAZE_SWAP_THRESHOLDを使う。
          const primarySig = newTargets[0].sig;
          if (gazeStartTime !== null && primarySig && gazeSig && sigCorrelation(primarySig, gazeSig) < GAZE_SWAP_THRESHOLD) {
            resetGaze();
          }

          detectedTargets = newTargets;
          startOverlayLoop();

          // ステータステキスト
          if (newTargets.length === 1) {
            scanStatus.textContent = `${newTargets[0].target.name} — ${newTargets[0].target.spiritName}`;
            if (mode === 'ar') guideText.textContent = s('guideGazeName', newTargets[0].target.spiritName);
          } else {
            const names = newTargets.map(t => t.target.spiritName).join(', ');
            scanStatus.textContent = `${names} — summon ${newTargets.length} at once!`;
          }

          startGaze();
          // 基準を最新フレームへ更新（隣接フレーム比較にして静止物の誤リセットを防ぐ。上のコメント参照）
          if (gazeStartTime !== null && primarySig) gazeSig = primarySig;
        }
      } else {
        detectedTargets = [];
        clearOverlay();
        if (mode === 'scan') scanStatus.textContent = '';
        else updateGuideUI();
        resetGaze();
      }
    } catch (err) {
      console.error('Scan request failed:', err);
      if (scanSessionId === session) resetGaze();
    } finally {
      isRequestPending = false;
      scanReqStart = null;
      updateScanLine(); // タップスキャン終了でスキャンラインを消す
    }
  }

  // ===== 認識エフェクト (requestAnimationFrameで常時描画) =====

  let overlayRAF = null;

  function startOverlayLoop() {
    if (overlayRAF === null) overlayRAF = requestAnimationFrame(overlayTick);
  }

  function overlayTick(time) {
    overlayRAF = null;
    if (!isScanning || detectedTargets.length === 0) {
      clearOverlay();
      return;
    }
    // ビューポート変化(アドレスバー出現等)でガイド枠が動いた場合にキャンバスサイズを追従
    const r = captureGuide.getBoundingClientRect();
    const rw = Math.round(r.width), rh = Math.round(r.height);
    if (overlayCanvas.width !== rw || overlayCanvas.height !== rh) {
      overlayCanvas.width = rw;
      overlayCanvas.height = rh;
    }
    drawRecognition(time);
    overlayRAF = requestAnimationFrame(overlayTick);
  }

  function drawRecognition(time) {
    const ctx = overlayCanvas.getContext('2d');
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const progress = gazeStartTime !== null
      ? (GAZE_DURATION > 0 ? Math.min(1, (Date.now() - gazeStartTime) / GAZE_DURATION) : 1) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(time / 300);

    for (const { target, color } of detectedTargets) {
      const col = color || nextColor();
      const [ymin, xmin, ymax, xmax] = target.box.map(v => v / 1000);
      const cx = (xmin + xmax) / 2 * w;
      const cy = (ymin + ymax) / 2 * h;

      // 認識した物体を囲む矩形 (バウンディングボックス)。
      // 見た目は実際の判定より少し大きめに描画する(各辺へ判定サイズの約8%を外側に広げる)。
      const PAD = 0.08;
      const rawBw = (xmax - xmin) * w, rawBh = (ymax - ymin) * h;
      const padX = rawBw * PAD, padY = rawBh * PAD;
      const bx = Math.max(0, xmin * w - padX);
      const by = Math.max(0, ymin * h - padY);
      const bw = Math.min(w, xmax * w + padX) - bx;
      const bh = Math.min(h, ymax * h + padY) - by;
      ctx.save();
      ctx.shadowColor = col;
      // 細い枠線全体
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.55 + pulse * 0.25;
      ctx.shadowBlur = 8;
      ctx.strokeRect(bx, by, bw, bh);
      // 凝視の進行に応じて枠内をうっすら塗る (溜まっている感)
      if (progress > 0) {
        ctx.globalAlpha = 0.10 + progress * 0.22;
        ctx.fillStyle = col;
        ctx.fillRect(bx, by, bw, bh);
      }
      // 四隅のコーナーブラケット (検出枠らしく強調)
      const cl = Math.max(14, Math.min(bw, bh) * 0.22);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(bx, by + cl); ctx.lineTo(bx, by); ctx.lineTo(bx + cl, by);                       // 左上
      ctx.moveTo(bx + bw - cl, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cl);         // 右上
      ctx.moveTo(bx + bw, by + bh - cl); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - cl, by + bh); // 右下
      ctx.moveTo(bx + cl, by + bh); ctx.lineTo(bx, by + bh); ctx.lineTo(bx, by + bh - cl);         // 左下
      ctx.stroke();
      ctx.restore();

      // 中心クロスヘア
      const crossLen = 10 + pulse * 3;
      const gapR = 6;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(cx - crossLen - gapR, cy); ctx.lineTo(cx - gapR, cy);
      ctx.moveTo(cx + gapR, cy);           ctx.lineTo(cx + crossLen + gapR, cy);
      ctx.moveTo(cx, cy - crossLen - gapR); ctx.lineTo(cx, cy - gapR);
      ctx.moveTo(cx, cy + gapR);           ctx.lineTo(cx, cy + crossLen + gapR);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 凝視進行アーク (0→360°)
      const arcR = 22 + progress * 6;
      ctx.lineWidth = 3;
      ctx.shadowColor = col;
      ctx.shadowBlur = 10 + progress * 10;
      ctx.globalAlpha = 0.35 + progress * 0.65;
      ctx.strokeStyle = col;
      ctx.beginPath();
      if (progress > 0) {
        ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      } else {
        ctx.arc(cx, cy, arcR * (0.9 + pulse * 0.1), 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  }

  // ==========================================
  // 凝視ゲージ (3秒で自動注入)
  // ==========================================

  function startGaze() {
    if (gazeStartTime !== null) return;
    gazeStartTime = Date.now();
    gazeSig = detectedTargets[0]?.sig || null; // この対象で凝視を開始したことを記録
    updateScanLine();

    gazeInterval = setInterval(() => {
      if (gazeStartTime === null) return;
      const elapsed = Date.now() - gazeStartTime;
      // 進行の見た目はoverlayTick(rAF)側がgazeStartTimeから描画する

      if (GAZE_DURATION === 0 || elapsed >= GAZE_DURATION) {
        clearInterval(gazeInterval);
        gazeInterval = null;
        gazeStartTime = null;
        stopScanning();
        triggerSoulInfusion();
      }
    }, 50);
  }

  function resetGaze() {
    gazeStartTime = null;
    gazeSig = null;
    if (gazeInterval) {
      clearInterval(gazeInterval);
      gazeInterval = null;
    }
    updateScanLine();
  }

  // カメラぶれ検知は廃止。凝視中の対象すり替えは runScanCycle の隣接フレーム相関で判定する。

  // ==========================================
  // 魂の注入 → 召喚 (登録数無制限)
  // ==========================================

  async function triggerSoulInfusion() {
    if (detectedTargets.length === 0) {
      resetGaze();
      return;
    }
    const snapshot = detectedTargets.slice(); // 最終チェック用にコピー

    // 注入直前の最終チェック: 凝視中にトラッキングが復帰/同一物だと判明した場合は除外
    const validTargets = snapshot.filter(({ target, sig }) =>
      !isRegistered(target.name) && !isOverTrackedSpirit(target.box) && !matchesRegisteredImage(sig)
    );

    if (validTargets.length === 0) {
      detectedTargets = [];
      resetGaze();
      return;
    }

    flashOverlay.classList.remove('flash');
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add('flash');

    try {
      const fullImg = await loadImage(snapshotCanvas.toDataURL('image/jpeg'));
      const prevCount = spirits.length;
      const newNames = [];

      for (const { target, sig, color } of validTargets) {
        // ところてん式: MAX_SPIRITS超えたら最古の精霊を押し出す
        if (spirits.length >= MAX_SPIRITS) {
          spirits.shift();
          compiledMindBuffer = null;
          compiledSpiritCount = 0;
        }
        spirits.push({
          image: cropImageWithBox(fullImg, target.box),
          vessel: target.name || 'a mysterious vessel',
          name: uniqueSpiritName(target.spiritName),
          personality: target.personality || 'cheerful and talkative',
          voice: target.voice || 'cool_male',
          color: color || nextColor(),
          sig
        });
        newNames.push(spirits[spirits.length - 1].name);
      }

      showToast(newNames.length === 1
        ? s('toastSummonedOne', newNames[0])
        : s('toastSummonedMany', newNames.join(', ')));
      updateSpiritCountBtn();
      resetBtn.classList.remove('hidden');

      // 召喚アナウンス (fire-and-forget — ローディング中に再生)
      const announceName = newNames[newNames.length - 1];

      // 初回コンパイルをアナウンス再生と並行して先行開始 (ローディング待ち時間を短縮)
      // ARが既に動いている場合は差分コンパイルを使うのでここでは不要
      const earlyCompile = prevCount === 0
        ? compileMindAR(spirits.map(sp => sp.image), null, () => {})
        : null;

      speakStandalone(spirits.length - 1, s('summoningVoice', announceName), () => {});

      // 1体でもAR(ソロ会話)へ。ARが既に動いていた(prevCount >= 1)なら新参として途中参加を通知。
      const newcomerName = prevCount >= 1 ? newNames[newNames.length - 1] : null;
      await enterAR(newcomerName, false, earlyCompile);
    } catch (err) {
      console.error('Infusion error:', err);
      showToast(s('toastImageFailed'));
      startScanning();
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function cropImageWithBox(img, box) {
    const [ymin, xmin, ymax, xmax] = box.map(v => v / 1000);
    const cropX = xmin * img.width;
    const cropY = ymin * img.height;
    const cropW = (xmax - xmin) * img.width;
    const cropH = (ymax - ymin) * img.height;

    const size = Math.min(Math.max(cropW, cropH), Math.min(img.width, img.height));
    let sqX = cropX + cropW / 2 - size / 2;
    let sqY = cropY + cropH / 2 - size / 2;
    sqX = Math.max(0, Math.min(sqX, img.width - size));
    sqY = Math.max(0, Math.min(sqY, img.height - size));

    // 240pxに正規化: コンパイルピクセル数が480px比で1/4になり大幅に高速化
    const TARGET = 240;
    const c = document.createElement('canvas');
    c.width = TARGET;
    c.height = TARGET;
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, sqX, sqY, size, size, 0, 0, TARGET, TARGET);
    return c.toDataURL('image/jpeg', 0.92);
  }

  // ==========================================
  // ==========================================
  // MindARコンパイル WebWorker
  // ==========================================

  const USE_MIND_WORKER = false; // CDNスクリプトがESM形式のためimportScriptsが失敗する

  const MIND_AR_WORKER_SRC = `
self.window = self;
self.document = { createElement: (t) => t === 'canvas' ? new OffscreenCanvas(1, 1) : {} };
importScripts('https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-compiler.prod.js');
self.onmessage = async ({ data: { id, images, prevBuffer } }) => {
  try {
    const ocs = images.map(({ buf, w, h }) => {
      const oc = new OffscreenCanvas(w, h);
      oc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
      return oc;
    });
    let result;
    if (prevBuffer) {
      const nc = new MINDAR.IMAGE.Compiler();
      await nc.compileImageTargets(ocs, p => self.postMessage({ id, type: 'progress', p }));
      const pc = new MINDAR.IMAGE.Compiler();
      pc.importData(prevBuffer);
      pc.targetList = [...pc.targetList, ...nc.targetList];
      result = await pc.exportData();
    } else {
      const c = new MINDAR.IMAGE.Compiler();
      await c.compileImageTargets(ocs, p => self.postMessage({ id, type: 'progress', p }));
      result = await c.exportData();
    }
    self.postMessage({ id, type: 'done', result }, result instanceof ArrayBuffer ? [result] : []);
  } catch(e) {
    self.postMessage({ id, type: 'error', msg: e.message });
  }
};
`;

  let _mindWorker = null;
  function getMindWorker() {
    if (!_mindWorker) {
      const blob = new Blob([MIND_AR_WORKER_SRC], { type: 'text/javascript' });
      _mindWorker = new Worker(URL.createObjectURL(blob));
    }
    return _mindWorker;
  }

  async function compileWithWorker(srcs, prevBuffer, onProgress) {
    const imgData = await Promise.all(srcs.map(async src => {
      const img = await loadImage(src);
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { buf: data.buffer.slice(0), w: width, h: height };
    }));
    return new Promise((resolve, reject) => {
      const id = (Math.random() * 1e9 | 0).toString(36);
      const worker = getMindWorker();
      const handler = ({ data }) => {
        if (data.id !== id) return;
        if (data.type === 'progress') { onProgress && onProgress(data.p); return; }
        worker.removeEventListener('message', handler);
        data.type === 'done' ? resolve(data.result) : reject(new Error(data.msg));
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ id, images: imgData, prevBuffer: prevBuffer || null },
        imgData.map(d => d.buf));
    });
  }

  async function compileMindAR(srcs, prevBuffer, onProgress) {
    if (USE_MIND_WORKER) {
      try { return await compileWithWorker(srcs, prevBuffer, onProgress); }
      catch(e) { console.warn('Worker compile failed, falling back to main thread:', e); }
    }
    // フォールバック: メインスレッド
    const imgs = await Promise.all(srcs.map(loadImage));
    if (prevBuffer) {
      const nc = new window.MINDAR.IMAGE.Compiler();
      await nc.compileImageTargets(imgs, onProgress);
      const pc = new window.MINDAR.IMAGE.Compiler();
      pc.importData(prevBuffer);
      pc.targetList = [...pc.targetList, ...nc.targetList];
      return pc.exportData();
    }
    const c = new window.MINDAR.IMAGE.Compiler();
    await c.compileImageTargets(imgs, onProgress);
    return c.exportData();
  }

  // ==========================================
  // MindARコンパイル + ARシーン構築 (再入可能)
  // ==========================================

  function teardownScene() {
    const sceneEl = arSceneContainer.querySelector('a-scene');
    if (sceneEl) {
      try {
        const sys = sceneEl.systems['mindar-image-system'];
        if (sys) sys.stop();
      } catch (e) { /* 停止失敗は無視 */ }
    }
    // MindARがボディやコンテナに自動生成したUIや警告を削除
    document.querySelectorAll('.mindar-ui-scanning, .mindar-ui-compatibility, mindar-ui-scanning, mindar-ui-compatibility').forEach(el => el.remove());
    
    // a-sceneやMindARが作成した追加のvideo/canvas要素を全削除
    const vids = document.querySelectorAll('body > video, body > canvas');
    vids.forEach(v => {
      // 自前の要素(スキャンvideo・スナップショット/オーバーレイcanvas)は消さない
      if (v === videoElement || v === snapshotCanvas || v === overlayCanvas) return;
      if (v.srcObject && v.srcObject !== mediaStream) {
        // mediaStreamは共有しているため停止しない（再利用でiOSの許可ダイアログを防ぐ）
        v.srcObject.getTracks().forEach(t => t.stop());
      }
      v.remove();
    });

    const vid = arSceneContainer.querySelector('video');
    if (vid && vid.srcObject && vid.srcObject !== mediaStream) {
      vid.srcObject.getTracks().forEach(t => t.stop());
    }
    arSceneContainer.innerHTML = '';
    visibleTargets.clear();
    clearBanterVisibility();
    arVideo = null;

    // 旧WebGLコンテキストに紐づいたテクスチャキャッシュを破棄する。
    // シーン再構築後は新コンテキストで新テクスチャを生成しないと吹き出しが描画されない。
    bubbleHideTimers.forEach(t => t && clearTimeout(t));
    bubbleTypeTimers.forEach(t => t && clearInterval(t)); // 進行中のタイプライターも止める
    bubbleCanvases.length = 0;
    bubbleTextures.length = 0;
    bubbleHideTimers.length = 0;
    bubbleTypeTimers.length = 0;
  }

  async function enterAR(newcomerName, isRetry = false, earlyCompilePromise = null) {
    isCompiling = true;
    stopScanning();
    stopBanterLoop();
    // iOS: stopBanterLoop→stopSpeaking→stopSynthKeepAliveでセッション維持が止まる。
    // ARコンパイル中もセッションを維持するため即座に再開する。
    if (isIOS && speechSupported && audioUnlocked) startSynthKeepAlive();

    // コンパイル中にbanter先読みを並行実行（AR表示直後に即セリフを出すため）
    preFetchedBanterTurn = null;
    if (spirits.length >= 1) {
      newcomerToAnnounce = newcomerName || null;
      preFetchedBanterTurn = fetchTurn([...spirits.keys()]);
    }

    // ARが既に動いている場合: コンパイルを先行させてARシーンを見せ続け、
    // 差し替え直前だけ短時間オーバーレイを出す（3〜8秒のブラックアウトを解消）。
    // 初回コンパイル(スキャンモード): 従来どおりフルオーバーレイ。
    const recompile = (mode === 'ar');

    if (!recompile) {
      loadingOverlay.classList.remove('hidden');
      loadingText.textContent = s('loadingPrepare');
      stopCamera();
      videoElement.classList.add('hidden-feed');
      teardownScene();
    } else {
      showToast(newcomerName ? s('toastSummoning', newcomerName) : s('toastUpdatingAR'));
    }

    try {
      // コンパイル戦略: キャッシュ → 差分 → フルコンパイル の順でフォールバック
      const cacheKey = mindCacheKey(spirits);
      let buffer = await getMindCache(cacheKey);

      if (buffer) {
        // IndexedDBキャッシュヒット: 再コンパイル不要
        loadingText.textContent = s('loadingRestore');
      } else if (recompile && compiledMindBuffer && compiledSpiritCount > 0 && spirits.length > compiledSpiritCount) {
        // 差分コンパイル: 新規精霊分だけコンパイルし、以前の結果とマージ
        try {
          buffer = await compileMindAR(
            spirits.slice(compiledSpiritCount).map(s => s.image),
            compiledMindBuffer.slice(0),
            (p) => { loadingText.textContent = s('loadingSummon', p); }
          );
        } catch (e) {
          console.warn('Incremental compile failed, falling back to full compile:', e);
          buffer = null;
        }
      }

      if (!buffer) {
        // フルコンパイル (初回 / 差分不可 / 精霊削除後)
        // 先行コンパイルが既に走っていればその結果を再利用する
        if (earlyCompilePromise) {
          try {
            buffer = await earlyCompilePromise;
          } catch (e) {
            console.warn('Early compile failed, retrying on main thread:', e);
            buffer = await compileMindAR(
              spirits.map(s => s.image),
              null,
              (p) => { loadingText.textContent = s('loadingExtract', p); }
            );
          }
          earlyCompilePromise = null;
        } else {
          buffer = await compileMindAR(
            spirits.map(s => s.image),
            null,
            (p) => { loadingText.textContent = s('loadingExtract', p); }
          );
        }
      }

      // 次回の差分コンパイルとキャッシュのために保存
      compiledMindBuffer = buffer.slice ? buffer.slice(0) : buffer;
      compiledSpiritCount = spirits.length;
      setMindCache(cacheKey, compiledMindBuffer); // 非同期・fire-and-forget

      if (compiledMindUrl) URL.revokeObjectURL(compiledMindUrl);
      compiledMindUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));

      // recompile: コンパイル完了後にシーン差し替え (ここだけ瞬時に暗転)
      if (recompile) {
        loadingOverlay.classList.remove('hidden');
        loadingText.textContent = s('loadingUpdate');
        teardownScene();
      }

      arReadyFired = false;
      buildScene();
      const sceneEl = arSceneContainer.querySelector('a-scene');
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        sceneEl.addEventListener('arReady', () => { arReadyFired = true; finish(); }, { once: true });
        setTimeout(finish, 8000);
      });

      arVideo = arSceneContainer.querySelector('video');
      if (arVideo) activeVideo = arVideo;
      mode = 'ar';
      isCompiling = false;

      loadingOverlay.classList.add('hidden');
      setupTargetListeners();
      modeToggle.classList.remove('hidden');
      // コンパイル完了後は常にTalkへ自動切替して会話を開始
      setUIMode('banter');
      startBanter(newcomerName);
    } catch (err) {
      console.error('Compilation error:', err);
      isCompiling = false;
      loadingOverlay.classList.add('hidden');

      // コンパイルを失敗させた新規精霊(直前にpushされたもの)を取り除く。
      // 残すと以降の再コンパイルに毎回混ざって同じ失敗を繰り返し、AR再入が永久に不能になる。
      const poppedNewcomer = !!newcomerName && spirits.length > 0;
      if (poppedNewcomer) spirits.pop();

      // 直前まで動いていた構成(>=1体)が残っていれば、その構成でARを一度だけ作り直して会話を復帰。
      if (poppedNewcomer && !isRetry && spirits.length >= 1) {
        showToast(s('toastAddFailed'));
        return enterAR(null, true);
      }

      // 復旧できない場合はスキャンモードへ安全に戻す。失敗時はモードに関わらずカメラを必ず生かす。
      showToast(s('toastCompileFailed'));
      teardownScene();
      mode = 'scan';
      activeVideo = videoElement;
      videoElement.classList.remove('hidden-feed');
      const recovered = await startCamera();
      if (recovered) {
        startScanning();
      } else {
        showToast(s('toastCameraFailed'), true);
      }
    }
  }

  function buildScene() {
    const maxTrack = Math.min(spirits.length, 5);
    // リング(目印)は映っている精霊すべてに表示し続ける(targetFound/targetLostで制御)
    const targetsHTML = spirits.map((s, i) => `
      <a-entity mindar-image-target="targetIndex: ${i}" id="target-entity-${i}">
        <a-ring id="ring-${i}" color="${s.color}" radius-inner="0.45" radius-outer="0.5" position="0 0 0.05"
                material="shader: flat; transparent: true; opacity: 0.85" visible="false"></a-ring>
        <a-plane id="bubble-plane-${i}" position="0 0.85 0.1" width="1.6" height="0.8" billboard
                 material="shader: flat; transparent: true; side: double;" visible="false" scale="0 0 0"></a-plane>
      </a-entity>`).join('');

    arSceneContainer.innerHTML = `
      <a-scene mindar-image="imageTargetSrc: ${compiledMindUrl}; maxTrack: ${maxTrack}; filterMinCF: 0.0001; filterBeta: 0.001; warmupTolerance: 2; missTolerance: 8; uiScanning: no; uiLoading: no; uiError: no;"
               color-space="sRGB" renderer="colorManagement: true, physicallyCorrectLights"
               vr-mode-ui="enabled: false" device-orientation-permission-ui="enabled: false">
        <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
        ${targetsHTML}
      </a-scene>
    `;
  }

  function setupTargetListeners() {
    spirits.forEach((spirit, i) => {
      const el = document.getElementById(`target-entity-${i}`);
      if (!el) return;
      el.addEventListener('targetFound', () => {
        visibleTargets.add(i);
        banterVisible.add(i);
        if (visibleGraceTimers[i]) { clearTimeout(visibleGraceTimers[i]); visibleGraceTimers[i] = null; }
        scanStatus.textContent = `${spirit.name} is here`;
        // スキャン済みの目印(リング)は、映っている間ずっと表示し続ける
        const ring = document.getElementById(`ring-${i}`);
        if (ring) ring.setAttribute('visible', 'true');
        updateScanGuideVisibility();
        // ※スキャン後に勝手にTalkへ切り替えない。会話はTalkタブを押したときだけ開始する。
        //   (Talk中なら runBanterTurn のループが映った精霊で自動的に進む)
      });
      el.addEventListener('targetLost', () => {
        visibleTargets.delete(i);
        // 画面外に出たら吹き出し・マーカーを消す
        hideSpeechBubble(i);
        const ring = document.getElementById(`ring-${i}`);
        if (ring) ring.setAttribute('visible', 'false');
        if (visibleTargets.size === 0) scanStatus.textContent = '';
        updateScanGuideVisibility();
        // 猶予付き可視集合からの除外のみ(タブの自動切替はしない)
        if (visibleGraceTimers[i]) clearTimeout(visibleGraceTimers[i]);
        visibleGraceTimers[i] = setTimeout(() => {
          visibleGraceTimers[i] = null;
          banterVisible.delete(i);
        }, VISIBLE_GRACE_MS);
      });
    });
  }

  // ==========================================
  // 音声 (TTS: ElevenLabs / Standalone=端末内蔵 を設定で切替)
  // ==========================================

  let banterAudio = null;
  let audioUnlocked = false;
  // 無音wav: ユーザー操作起点でAudioをアンロックする (iOS Safari対策)
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  // TTSエンジン設定 ('elevenlabs' | 'standalone')。standaloneはブラウザのWeb Speech API。
  const TTS_STORAGE_KEY = 'ar_agents_2_tts_engine';
  const speechSupported = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  // iOS Safari: cancel() がオーディオセッションを破棄するため、非ユーザージェスチャーからの speak() が失敗する
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let ttsEngine = localStorage.getItem(TTS_STORAGE_KEY) || 'elevenlabs';
  if (ttsEngine === 'standalone' && !speechSupported) ttsEngine = 'elevenlabs';

  document.addEventListener('pointerdown', () => {
    if (audioUnlocked) return;
    if (!banterAudio) banterAudio = new Audio();
    banterAudio.src = SILENT_WAV;
    banterAudio.play().then(() => hideToast()).catch(() => {});
    // iOS対策: volume=0では解除されないケースがあるため極小音量で解除
    if (speechSupported) {
      try {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0.01;
        // iOS: warm-up開始時からkeepAliveを開始してARコンパイル中もセッションを維持する
        warm.onstart = () => { if (isIOS) startSynthKeepAlive(); };
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(warm);
      } catch (e) {}
    }
    audioUnlocked = true;
  });

  const CONTROL_SELECTOR = 'button, #mode-toggle, #spirit-panel, #settings-panel, #reset-btn, #spirit-count-btn, #settings-btn, #debug-overlay';

  // 画面(カメラ領域)をタップしたら即スキャン。ボタンやパネル操作のタップでは発火させない。
  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest(CONTROL_SELECTOR)) return;
    if (banterPaused) { resumeFromPause(); return; }
    triggerScan();
  });

  // Talkモード: 認識中の精霊をタップすると、その精霊を次の話者として割り込ませる。
  const _projVec = (window.THREE) ? new THREE.Vector3() : null;
  function spiritAtScreenPoint(clientX, clientY) {
    const sceneEl = arSceneContainer.querySelector('a-scene');
    if (!sceneEl || !sceneEl.camera || !window.THREE) return -1;
    const cam = sceneEl.camera;
    const w = window.innerWidth, h = window.innerHeight;
    let best = -1, bestDist = Infinity;
    for (const i of visibleTargets) {
      const el = document.getElementById(`target-entity-${i}`);
      if (!el || !el.object3D) continue;
      el.object3D.getWorldPosition(_projVec);
      _projVec.project(cam);
      if (_projVec.z > 1) continue; // カメラ後方は無視
      const sx = (_projVec.x * 0.5 + 0.5) * w;
      const sy = (-_projVec.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    // マーカー近傍のタップだけ採用(画面短辺の35%以内)
    return (best >= 0 && bestDist < Math.min(w, h) * 0.35) ? best : -1;
  }

  function requestSpeak(idx) {
    if (mode !== 'ar' || uiMode !== 'banter') return;
    const visible = visibleSpiritIndices();
    if (!visible.includes(idx) || visible.length < 1) return;
    forcedSpeakerIdx = idx;
    // 進行中ターン/先読みを無効化して、その場でforcedターンを差し込む
    banterSession++;
    isBanterRunning = true;
    pendingTurn = null;
    stopSpeaking();
    if (banterTimeout) { clearTimeout(banterTimeout); banterTimeout = null; }
    if (!currentSituation) currentSituation = SITUATIONS[Math.floor(Math.random() * SITUATIONS.length)];
    scanStatus.textContent = `${spirits[idx].name}!`;
    runBanterTurn(banterSession);
  }

  document.addEventListener('pointerdown', (e) => {
    if (banterPaused) return; // resumeFromPause は上のハンドラで処理済み
    if (uiMode !== 'banter' || mode !== 'ar') return;
    if (e.target && e.target.closest && e.target.closest(CONTROL_SELECTOR)) return;
    const idx = spiritAtScreenPoint(e.clientX, e.clientY);
    if (idx >= 0) requestSpeak(idx);
  });

  // ===== 設定パネル: TTSエンジンの切替 =====
  function updateTtsUI() {
    const elBtn = document.getElementById('tts-elevenlabs');
    const stBtn = document.getElementById('tts-standalone');
    const hint = document.getElementById('tts-hint');
    if (elBtn) elBtn.classList.toggle('active', ttsEngine === 'elevenlabs');
    if (stBtn) {
      stBtn.classList.toggle('active', ttsEngine === 'standalone');
      stBtn.disabled = !speechSupported;
      stBtn.style.opacity = speechSupported ? '' : '0.4';
    }
    if (hint) {
      hint.textContent = ttsEngine === 'standalone'
        ? "On-device voices via your browser. No API key needed; quality varies by device."
        : (speechSupported
            ? "High-quality cloud voices (needs ElevenLabs API key)."
            : "High-quality cloud voices (needs ElevenLabs API key). On-device TTS is not supported on this browser.");
    }
  }
  function setTtsEngine(engine) {
    if (engine === 'standalone' && !speechSupported) return;
    ttsEngine = engine;
    localStorage.setItem(TTS_STORAGE_KEY, engine);
    updateTtsUI();
  }
  // ===== 設定パネル: 言語の切替 =====
  const langSelect = document.getElementById('lang-select');
  if (langSelect) {
    LANGS.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code; opt.textContent = (l.flag ? l.flag + ' ' : '') + l.label;
      langSelect.appendChild(opt);
    });
    langSelect.value = language;
    langSelect.addEventListener('change', () => {
      language = langSelect.value;
      localStorage.setItem(LANG_KEY, language);
      applyUIStrings();
    });
  }

  // ===== 設定パネル: モデルプリセットの切替 =====
  function updateModelUI() {
    const cBtn = document.getElementById('model-cerebras');
    const gBtn = document.getElementById('model-gemma4');
    const hint = document.getElementById('model-hint');
    if (cBtn) cBtn.classList.toggle('active', modelPreset === 'cerebras');
    if (gBtn) gBtn.classList.toggle('active', modelPreset === 'gemma4');
    if (hint) hint.textContent = modelPreset === 'cerebras'
      ? s('modelHintCerebras')
      : s('modelHintOpenRouter');
    const banner = document.getElementById('model-banner');
    if (banner) {
      banner.textContent = modelPreset === 'cerebras' ? s('modelCerebras') : s('modelOpenRouter');
      banner.className = modelPreset === 'cerebras' ? 'cerebras' : 'openrouter';
    }
  }

  function applyUIStrings() {
    modeScanBtn.setAttribute('aria-label', s('scanBtn'));
    modeBanterBtn.setAttribute('aria-label', s('talkBtn'));
    resetBtn.textContent = s('resetBtn');
    const spiritLabelEl = document.getElementById('spirit-label');
    if (spiritLabelEl) spiritLabelEl.textContent = s('spiritLabel', spirits.length);
    const panelPrefixEl = document.getElementById('spirit-panel-prefix');
    if (panelPrefixEl) panelPrefixEl.textContent = s('spiritPanelPrefix');
    const settingsTitleEl = document.getElementById('settings-title-text');
    if (settingsTitleEl) settingsTitleEl.textContent = s('settingsTitle');
    const langLabelEl = document.getElementById('settings-lang-label');
    if (langLabelEl) langLabelEl.textContent = s('langLabel');
    const langHintEl = document.getElementById('settings-lang-hint');
    if (langHintEl) langHintEl.textContent = s('langHint');
    const ttsLabelEl = document.getElementById('settings-tts-label');
    if (ttsLabelEl) ttsLabelEl.textContent = s('ttsLabel');
    const ttsHintEl = document.getElementById('tts-hint');
    if (ttsHintEl) ttsHintEl.textContent = s('ttsHint');
    const ttsELEl = document.getElementById('tts-elevenlabs');
    if (ttsELEl) ttsELEl.textContent = s('ttsElevenLabs');
    const ttsODEl = document.getElementById('tts-standalone');
    if (ttsODEl) ttsODEl.textContent = s('ttsOnDevice');
    const modelLabelEl = document.getElementById('settings-model-label');
    if (modelLabelEl) modelLabelEl.textContent = s('modelLabel');
    const pauseTextEl = document.getElementById('banter-pause-text');
    if (pauseTextEl) pauseTextEl.textContent = s('banterPauseTap');
    updateModelUI();
  }
  function setModelPreset(p) {
    const next = p === 'gemma4' ? 'gemma4' : 'cerebras';
    if (next === modelPreset) return;
    modelPreset = next;
    localStorage.setItem(MODEL_PRESET_KEY, next);
    // 途中のリクエストをリセット
    stopBanterLoop();
    preFetchedBanterTurn = null;
    pendingTurn = null;
    scanSessionId++; // 進行中スキャンを無効化
    isRequestPending = false;
    updateModelUI();
  }

  function openSettings() { settingsPanel.classList.add('open'); updateTtsUI(); updateModelUI(); }
  function closeSettings() { settingsPanel.classList.remove('open'); }
  settingsBtn.addEventListener('click', openSettings);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('tts-elevenlabs').addEventListener('click', () => setTtsEngine('elevenlabs'));
  document.getElementById('tts-standalone').addEventListener('click', () => setTtsEngine('standalone'));
  document.getElementById('model-cerebras').addEventListener('click', () => setModelPreset('cerebras'));
  document.getElementById('model-gemma4').addEventListener('click', () => setModelPreset('gemma4'));
  updateTtsUI();
  updateModelUI();

  // ===== Standalone TTS (Web Speech API) =====
  let standaloneVoices = [];
  function loadStandaloneVoices() {
    if (speechSupported) standaloneVoices = window.speechSynthesis.getVoices() || [];
  }
  if (speechSupported) {
    loadStandaloneVoices();
    window.speechSynthesis.onvoiceschanged = loadStandaloneVoices;
  }
  // キャラ別の声色(音域・速さ)。Web Speechは声の種類が端末依存なのでpitch/rateで差をつける。
  const STANDALONE_VOICE_PARAMS = {
    cool_male:   { pitch: 0.8, rate: 1.0,  female: false },
    genki_girl:  { pitch: 1.7, rate: 1.15, female: true  },
    wise_elder:  { pitch: 0.7, rate: 0.9,  female: false },
    gentle_lady: { pitch: 1.25, rate: 0.95, female: true }
  };
  function pickStandaloneVoice(wantFemale, bcp) {
    if (!standaloneVoices.length) loadStandaloneVoices();
    const prefix = (bcp || 'en-US').slice(0, 2).toLowerCase(); // 'ja','zh',...
    const re = new RegExp('^' + prefix + '(-|_|$)', 'i');
    const matched = standaloneVoices.filter(v => re.test(v.lang));
    const pool = matched.length ? matched : standaloneVoices;
    const femaleHint = /female|woman|samantha|victoria|karen|moira|tessa|fiona|zira|susan|kyoko|o-ren|mei-jia|yuna|google .* female/i;
    const maleHint = /male|man|daniel|alex|fred|david|otoya|google .* male|rishi/i;
    const want = wantFemale ? femaleHint : maleHint;
    return pool.find(v => want.test(v.name)) || pool[0] || null;
  }

  // iOS: speechSynthesisは約30秒でOSに一時停止される → 定期的にresume()して防ぐ
  let synthKeepAlive = null;
  function startSynthKeepAlive() {
    if (synthKeepAlive) return;
    synthKeepAlive = setInterval(() => {
      try { window.speechSynthesis.resume(); } catch (e) {}
    }, 5000);
  }
  function stopSynthKeepAlive() {
    if (synthKeepAlive) { clearInterval(synthKeepAlive); synthKeepAlive = null; }
  }

  // Standaloneで1セリフを読み上げ、終了時 onEnd(spoke) を呼ぶ
  function speakStandalone(spiritIndex, text, onEnd) {
    if (!speechSupported || !text) { onEnd(false); return; }
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    const bcp = langBcp47();
    u.lang = bcp;
    const voiceKey = (spirits[spiritIndex] && spirits[spiritIndex].voice) || 'cool_male';
    const p = STANDALONE_VOICE_PARAMS[voiceKey] || { pitch: 1, rate: 1, female: false };
    u.pitch = p.pitch;
    u.rate = p.rate;
    const v = pickStandaloneVoice(p.female, bcp);
    if (v) u.voice = v;

    let done = false;
    let wd = null;
    const finish = (spoke) => {
      if (done) return;
      done = true;
      if (wd) clearTimeout(wd);
      stopSynthKeepAlive();
      setSpeakingState(false);
      onEnd(spoke);
    };
    u.onstart = () => { setSpeakingState(true); startSynthKeepAlive(); };
    u.onend = () => {
      // iOS: 発話終了後も pause() でセッションを維持する
      if (isIOS) { try { synth.pause(); } catch (e2) {} }
      finish(true);
    };
    u.onerror = (e) => {
      // 'interrupted'/'canceled' は cancel() による意図的なキャンセル。エラー扱いしない。
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) { finish(false); return; }
      lastBanterErr = 'tts:' + ((e && e.error) || 'err');
      finish(false);
    };

    // watchdog は speak() を実際に呼んでから起動する（ポーリング待機時間を含めないため）
    const go = () => {
      wd = setTimeout(() => finish(true), Math.min(20000, 1500 + text.length * 110));
      try { synth.resume(); synth.speak(u); }
      catch (e) { finish(false); }
    };
    try {
      if (synth.speaking || synth.pending) {
        if (isIOS) {
          // iOS: cancel() はセッションを破棄するため呼ばない。
          // 前の発話が自然に終わるまでポーリングして待ち、終了後に開始する。
          let polls = 0;
          const waitAndGo = () => {
            if (done) return;
            if ((synth.speaking || synth.pending) && polls++ < 25) {
              setTimeout(waitAndGo, 200);
            } else {
              go(); // 5秒待っても終わらなければ強制開始（queued後にresumeで再生）
            }
          };
          setTimeout(waitAndGo, 200);
          return;
        }
        synth.cancel();
        setTimeout(go, 150);
      } else {
        go();
      }
    } catch (e) { finish(false); }
  }

  // TTSへ渡す読み上げテキストを決める。表示は漢字まじり(reply)、読み上げは仮名(ttsReply)を使い分ける。
  // 日本語でttsReplyが無い場合は、漢字を誤読させないため reply からひらがな/カタカナ以外を除く。
  function ttsTextFromData(data) {
    const ttsKana = data.ttsReply && String(data.ttsReply).trim();
    let speechText = ttsKana || data.reply;
    if (language === 'ja' && !ttsKana) {
      const kanaOnly = String(data.reply).replace(/[^぀-ヿーｦ-ﾟ0-9\s、。！？!?…]/g, '');
      if (kanaOnly.replace(/\s/g, '').length >= 2) speechText = kanaOnly;
    }
    return speechText;
  }

  // エンジンに応じて1ターンを再生する
  async function speakTurn(turn, session, onEnd) {
    // ミュート中の精霊は音声を出さない(吹き出しは出す)
    if (spirits[turn.globalIdx] && spirits[turn.globalIdx].muted) { onEnd(false); return; }
    if (ttsEngine === 'standalone') {
      if (!isBanterRunning || session !== banterSession) return;
      speakStandalone(turn.globalIdx, turn.speechText, onEnd);
      return;
    }
    const blob = turn.audioP ? await turn.audioP : null;
    if (!isBanterRunning || session !== banterSession) return;
    playLine(blob, onEnd);
  }

  function fetchTTS(spiritIndex, text) {
    const cleanText = text
      .replace(/[「」『』【】\[\]\(\)（）]/g, ' ')
      .replace(/[\n\r]+/g, '、')
      .trim();
    const voice = (spirits[spiritIndex] && spirits[spiritIndex].voice) || 'cool_male';
    return fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleanText, voice })
    });
  }

  // 取得済みの音声Blobを再生し、終了時に onEnd(spoke) を呼ぶ
  function setSpeakingState(active) {
    spiritCountBtn.classList.toggle('speaking', active);
  }

  function playLine(blob, onEnd) {
    if (!blob) {
      onEnd(false);
      return;
    }
    if (!banterAudio) banterAudio = new Audio();
    const audio = banterAudio;
    let finished = false;
    let objUrl = null;
    let watchdog = null;
    const finish = (spoke) => {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      audio.onended = audio.onerror = null;
      if (objUrl) URL.revokeObjectURL(objUrl);
      setSpeakingState(false);
      onEnd(spoke);
    };

    objUrl = URL.createObjectURL(blob);
    setSpeakingState(true);
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    watchdog = setTimeout(() => finish(true), 20000);
    audio.src = objUrl;
    audio.play().catch((err) => {
      // pause()による意図的な中断(AbortError)は自動再生ブロックではないので、
      // 偽の「タップしてください」トーストを出さない。
      if (err && err.name === 'AbortError') {
        finish(false);
        return;
      }
      audioUnlocked = false;
      showToast(s('toastTapSpeak'), true);
      finish(false);
    });
  }

  function stopSpeaking() {
    if (banterAudio) {
      banterAudio.onended = banterAudio.onerror = null;
      banterAudio.pause();
      banterAudio.removeAttribute('src');
    }
    // iOS: cancel() はオーディオセッションを破棄するためスキップ。
    // 前の発話は自然に終わるか、speakStandalone のポーリングが完了を待つ。
    if (speechSupported && !isIOS) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    stopSynthKeepAlive();
    setSpeakingState(false);
  }

  // ==========================================
  // 精霊Banter (自動開始 / N体対応 / 先読みパイプライン)
  // ==========================================

  let banterSession = 0;
  let isBanterRunning = false;
  let banterHistory = [];
  let banterMemory = [];         // 過去セッションの会話履歴 (turnCountには使わず記憶として渡す)
  let banterMemoryLoaded = false; // このセッションで一度ロード済みか
  let banterTimeout = null;
  let pendingTurn = null;
  let preFetchedBanterTurn = null; // ARコンパイル中に先読みした最初のターン
  let newcomerToAnnounce = null;
  let forcedSpeakerIdx = -1; // タップで指定された次の話者(グローバルindex)。-1で未指定。

  // 会話参加できる精霊のグローバルindex一覧。
  // 吹き出しは実際にトラッキング中の物体にしか描画できないため、ここは「実可視(visibleTargets)」を使う。
  // (猶予付きbanterVisibleはタブの自動切替を安定させる用途のみ。会話の話者は必ず実際に映っている精霊にする)
  function visibleSpiritIndices() {
    return [...visibleTargets].filter(i => i >= 0 && i < spirits.length).sort((a, b) => a - b);
  }

  // 指定した参加者(グローバルindex配列)だけでセリフ生成とTTS音声取得を先読みする。
  // nextSpeaker は参加者配列内のローカルindex(agent0..)なのでグローバルindexへ写し戻す。
  function fetchTurn(participants, forcedGlobalIdx) {
    const participantNames = new Set(participants.map(i => spirits[i].name));
    const filteredHistory = banterHistory.filter(h => participantNames.has(h.name));
    // タップ指定の話者を参加者配列内のローカルindex(agentN)へ変換
    const forcedLocal = (forcedGlobalIdx != null && forcedGlobalIdx >= 0) ? participants.indexOf(forcedGlobalIdx) : -1;
    const forceSpeaker = forcedLocal >= 0 ? `agent${forcedLocal}` : null;
    const body = JSON.stringify({
      spirits: participants.map(i => ({
        name: spirits[i].name, vessel: spirits[i].vessel, personality: spirits[i].personality
      })),
      history: filteredHistory,
      memory: banterMemory.length > 0 ? banterMemory : undefined,
      newcomer: newcomerToAnnounce,
      situation: currentSituation,
      forceSpeaker,
      language,
      modelPreset
    });
    newcomerToAnnounce = null;

    const t0 = performance.now();
    banterReqStart = t0; // 通信中はライブ表示
    const settle = () => {
      lastBanterMs = Math.round(performance.now() - t0);
      lastBanterAt = performance.now();
      if (banterReqStart === t0) banterReqStart = null; // 自分が最新なら解除(先読み重複対策)
    };
    return fetch('/api/banter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
      .then(r => r.json())
      .then(data => {
        settle();
        if (data.error || !data.reply) return { data };
        const local = parseInt(String(data.nextSpeaker).replace('agent', ''), 10);
        const globalIdx = forceSpeaker
          ? forcedGlobalIdx
          : (participants[Number.isInteger(local) ? local : 0] ?? participants[0]);
        const speechText = ttsTextFromData(data);
        // ElevenLabs選択時のみ音声を先読み。Standaloneは再生時に端末で合成する。
        const audioP = ttsEngine === 'elevenlabs'
          ? fetchTTS(globalIdx, speechText).then(r => (r.ok ? r.blob() : null)).catch(() => null)
          : null;
        return { data, globalIdx, speechText, audioP };
      })
      .catch(err => { settle(); return { data: { error: String(err) } }; });
  }

  function startBanter(newcomerName) {
    banterSession++;
    isBanterRunning = true;
    pendingTurn = null;
    newcomerToAnnounce = newcomerName || null;

    // 新メンバー参加時は会話履歴をリセットし、起承転結を最初(起)からやり直す。
    if (newcomerName) banterHistory = [];

    // 過去セッションのメモリをロード (ページリロード後の初回 or 新メンバー参加時)
    if (!banterMemoryLoaded || newcomerName) {
      banterMemory = loadBanterMemory();
      banterMemoryLoaded = true;
    }

    // シチュエーションは初回/再開時のみ更新。新メンバー参加時は場面を維持する。
    if (!currentSituation || !newcomerName) {
      currentSituation = SITUATIONS[Math.floor(Math.random() * SITUATIONS.length)];
    }
    console.log('Current Situation:', currentSituation);

    // ARコンパイル中に先読みしたターンがあれば即座に使う
    if (preFetchedBanterTurn) {
      pendingTurn = preFetchedBanterTurn;
      preFetchedBanterTurn = null;
      newcomerToAnnounce = null; // 先読み時に既に送信済み
    }

    runBanterTurn(banterSession);
  }

  function stopBanterLoop() {
    isBanterRunning = false;
    pendingTurn = null;
    if (banterTimeout) {
      clearTimeout(banterTimeout);
      banterTimeout = null;
    }
    stopSpeaking();
  }

  function enterBanterPause() {
    banterPaused = true;
    stopBanterLoop();
    spirits.forEach((_, i) => hideSpeechBubble(i));
    const overlay = document.getElementById('banter-pause-overlay');
    const text = document.getElementById('banter-pause-text');
    if (text) text.textContent = s('banterPauseTap');
    if (overlay) overlay.classList.remove('hidden');
  }

  function resumeFromPause() {
    banterPaused = false;
    banterTurns = 0;
    const overlay = document.getElementById('banter-pause-overlay');
    if (overlay) overlay.classList.add('hidden');
    banterHistory = [];
    startBanter();
  }

  async function runBanterTurn(session) {
    if (!isBanterRunning || session !== banterSession) return;
    // 一覧内の会話中はARの会話を止める(音声がかぶらないように)
    if (panelChatRunning) { stopBanterLoop(); return; }
    // スキャン中(Talkタブ以外)は会話しない。吹き出しも音声も出さずにループを止める。
    if (uiMode !== 'banter') { stopBanterLoop(); spirits.forEach((_, i) => hideSpeechBubble(i)); return; }
    try {

    // 画面に2体以上映っていなければ会話しない（映るまで待機）
    const visible = visibleSpiritIndices();
    if (visible.length < 1) {
      // 映っている精霊が0体なら待機。1体以上でソロ会話を開始/継続する。
      pendingTurn = null;
      spirits.forEach((_, i) => hideSpeechBubble(i));
      if (mode === 'ar' && uiMode === 'banter') {
        scanStatus.textContent = `Point your camera at a spirit`;
      }
      banterTimeout = setTimeout(() => runBanterTurn(session), 700);
      return;
    }
    scanStatus.textContent = '';

    // タップで話者が指定されていれば、先読み分を捨ててその精霊のターンを取りに行く
    let turn;
    if (forcedSpeakerIdx >= 0 && visible.includes(forcedSpeakerIdx)) {
      const forced = forcedSpeakerIdx;
      forcedSpeakerIdx = -1;
      pendingTurn = null;
      turn = await fetchTurn(visible, forced);
    } else {
      forcedSpeakerIdx = -1; // 指定精霊が映っていない等は無視
      turn = await (pendingTurn || fetchTurn(visible));
    }
    pendingTurn = null;
    if (!isBanterRunning || session !== banterSession) return;

    if (!turn || !turn.data || turn.data.error || !turn.data.reply) {
      lastBanterErr = turn?.data?.error || 'no reply';
      console.error('Banter turn error:', turn && turn.data);
      banterTimeout = setTimeout(() => runBanterTurn(session), 3000);
      return;
    }
    lastBanterErr = '—';
    banterTurns++;

    const idx = turn.globalIdx;

    // 先読み中に話者が画面外へ出ていたら、このターンは捨てて作り直す
    if (!visibleTargets.has(idx)) {
      banterTimeout = setTimeout(() => runBanterTurn(session), 200);
      return;
    }

    banterHistory.push({ name: spirits[idx].name, text: turn.data.reply });
    if (banterHistory.length > 15) banterHistory.shift();
    saveBanterMemory(banterHistory); // 次回ページロード用に保存

    // 再生中に次のターンを先読み（現在映っている参加者で）してテンポを上げる
    // ただし、これが終了ターンの場合は次のターンを先読みしない
    const nextVisible = visibleSpiritIndices();
    const isEnding = turn.data.isEnd === true;
    pendingTurn = (nextVisible.length >= 1 && !isEnding) ? fetchTurn(nextVisible) : null;

    spirits.forEach((_, i) => { if (i !== idx) hideSpeechBubble(i); });
    showSpeechBubble(idx, turn.data.reply);

    await speakTurn(turn, session, (spoke) => {
      if (!isBanterRunning || session !== banterSession) return;
      if (isEnding) {
        isBanterRunning = false;
        // 会話終了後、少し間を置いて自動再開（会話モードの場合）
        setTimeout(() => {
          spirits.forEach((_, i) => hideSpeechBubble(i));
          if (uiMode === 'banter' && spirits.length >= 1) {
            banterHistory = [];
            startBanter();
          }
        }, 5000);
      } else if (banterTurns >= BANTER_PAUSE_AFTER) {
        // 会話ターン上限に達したので一時停止モードへ
        enterBanterPause();
      } else {
        const delay = spoke ? TURN_GAP_MS : Math.min(4500, 1100 + turn.data.reply.length * 90);
        banterTimeout = setTimeout(() => runBanterTurn(session), delay);
      }
    });

    } catch (e) {
      lastBanterErr = String(e);
      console.error('runBanterTurn exception:', e);
      banterTimeout = setTimeout(() => runBanterTurn(session), 3000);
    }
  }

  // ===== 3D吹き出し (CanvasTexture直接適用 / アメリカンコミック風) =====
  const bubbleCanvases = [];
  const bubbleTextures = [];
  const bubbleHideTimers = []; // hide→show競合で吹き出しが表示直後に消えるのを防ぐ
  const bubbleTypeTimers = []; // タイプライター表示用のインターバル
  // 主役はBangers。読込失敗時もコミック感を保つようOS搭載の手描き系へフォールバック
  // ('Chalkboard SE'/'Marker Felt'=iOS, 'Comic Sans MS'=Win/Mac)
  const COMIC_FONT = "'Bangers', 'Comic Sans MS', 'Chalkboard SE', 'Marker Felt', Impact, sans-serif";
  const TYPE_INTERVAL = 38;    // 1文字あたりの表示間隔(ms)
  // コミックフォントを事前ロードしておく(canvas描画時にフォールバックさせない)
  if (document.fonts && document.fonts.load) document.fonts.load('42px "Bangers"');

  function getBubbleCanvas(i) {
    if (!bubbleCanvases[i]) {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 256;
      bubbleCanvases[i] = c;
    }
    return bubbleCanvases[i];
  }

  // 吹き出しの寸法 (canvas 512x256)
  const BB = { rx: 15, ry: 15, rw: 482, rh: 180, radius: 26 };

  // アメリカンコミック風バルーン: 白地・極太の黒インク輪郭・面取り多角形＋V字の尻尾
  // (毎フレーム再描画されるので形状は固定。色の識別は物体側のリングが担当する)
  function drawComicBalloon(ctx, themeColor) {
    const { rx, ry, rw, rh } = BB;
    const ch = 36;          // 面取り(コーナーの斜めカット)量
    const cx = 256;         // 尻尾の中心X
    ctx.beginPath();
    ctx.moveTo(rx + ch, ry);                 // 上辺(左から)
    ctx.lineTo(rx + rw - ch, ry);            // 上辺(右へ)
    ctx.lineTo(rx + rw, ry + ch);            // 右上の面取り
    ctx.lineTo(rx + rw, ry + rh - ch);       // 右辺
    ctx.lineTo(rx + rw - ch, ry + rh);       // 右下の面取り
    ctx.lineTo(cx + 24, ry + rh);            // 下辺(尻尾の右付け根)
    ctx.lineTo(cx + 3, ry + rh + 32);        // 尻尾の先端(少し右寄りで動きを出す)
    ctx.lineTo(cx - 18, ry + rh);            // 下辺(尻尾の左付け根 = V字)
    ctx.lineTo(rx + ch, ry + rh);            // 下辺(左へ)
    ctx.lineTo(rx, ry + rh - ch);            // 左下の面取り
    ctx.lineTo(rx, ry + ch);                 // 左辺
    ctx.closePath();                         // 左上の面取りで先頭へ

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 白で塗りつぶし → 黒の極太インク輪郭
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  // コミックフォントで折り返し、枠に収まる行レイアウトを計算
  function computeBubbleLayout(id, text) {
    const ctx = getBubbleCanvas(id).getContext('2d');
    const maxTextW = BB.rw - 56;
    // テキストは絶対に省略しない(「…」で切らない)。入りきらなければフォントを小さくして全文を収める。
    const maxLines = 7;
    const wrap = (fontPx) => {
      ctx.font = `${fontPx}px ${COMIC_FONT}`;
      const words = text.split(/(\s+)/);   // 空白も保持
      const lines = [];
      let cur = '';
      const pushWord = (w) => {
        const test = cur + w;
        if (ctx.measureText(test.trim()).width <= maxTextW || cur === '') cur = test;
        else { lines.push(cur.trim()); cur = w.trim() ? w : ''; }
      };
      for (const w of words) {
        if (ctx.measureText(w.trim()).width > maxTextW) { for (const ch of w) pushWord(ch); }
        else pushWord(w);
      }
      if (cur.trim()) lines.push(cur.trim());
      return lines;
    };
    // 上下パディングを引いた、テキストを収められる本体内の高さ
    const maxBlockH = BB.rh - 44;
    // 横幅(行数)と縦(総行高)の両方が枠内に収まるまでフォントを段階的に縮める。
    // 全文を必ず収めるため、切り捨て(slice)はせず最小12pxまで縮小する。
    let fontPx = 46, lines = wrap(fontPx);
    while (fontPx > 12 && (lines.length > maxLines || lines.length * (fontPx + 4) > maxBlockH)) {
      fontPx -= 2;
      lines = wrap(fontPx);
    }
    const lineH = fontPx + 4;
    const startY = BB.ry + BB.rh / 2 - (lines.length - 1) * (lineH / 2);
    return { lines, fontPx, lineH, startY };
  }

  // バルーン + (revealed文字までの)テキストを1フレーム描画する
  function drawBubbleFrame(id, layout, revealed) {
    const ctx = getBubbleCanvas(id).getContext('2d');
    ctx.clearRect(0, 0, 512, 256);
    drawComicBalloon(ctx, spirits[id].color);

    ctx.fillStyle = '#141414';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${layout.fontPx}px ${COMIC_FONT}`;
    let before = 0;
    layout.lines.forEach((line, i) => {
      const take = Math.max(0, Math.min(line.length, revealed - before));
      before += line.length;
      const shown = line.slice(0, take);
      if (shown) ctx.fillText(shown, 256, layout.startY + i * layout.lineH);
    });
  }

  // CanvasTextureを生成しメッシュへ適用 (A-Frameのsrc属性経由はiOSで真っ黒になる)
  // メッシュ初期化が数フレーム遅れることがあるので、取得できるまで複数フレーム再試行する。
  function applyBubbleTexture(id, attempt) {
    attempt = attempt || 0;
    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;
    const canvas = getBubbleCanvas(id);
    const apply = (m) => {
      if (!bubbleTextures[id]) {
        const tex = new THREE.CanvasTexture(canvas);
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
        bubbleTextures[id] = tex;
      }
      bubbleTextures[id].needsUpdate = true;
      m.material.map = bubbleTextures[id];
      m.material.transparent = true;
      m.material.needsUpdate = true;
    };
    const mesh = plane.getObject3D('mesh');
    if (mesh) { apply(mesh); return; }
    if (attempt < 20) requestAnimationFrame(() => applyBubbleTexture(id, attempt + 1));
  }

  function showSpeechBubble(id, text) {
    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;

    // 直前のhideが予約した「消す」タイマー、および進行中のタイプライターを取り消す
    if (bubbleHideTimers[id]) { clearTimeout(bubbleHideTimers[id]); bubbleHideTimers[id] = null; }
    if (bubbleTypeTimers[id]) { clearInterval(bubbleTypeTimers[id]); bubbleTypeTimers[id] = null; }

    const layout = computeBubbleLayout(id, text);
    const total = layout.lines.reduce((sum, l) => sum + l.length, 0);

    // まず空のバルーンを描いて表示(ポップ)してから1文字ずつ出す
    drawBubbleFrame(id, layout, 0);
    applyBubbleTexture(id);

    plane.setAttribute('visible', 'true');
    // アニメが(端末/タイミング次第で)動かなくても確実に見えるよう、まずscaleを1に確定させる。
    // これをしないと初期scale="0 0 0"のまま残り「吹き出しが出ない」ことがある。
    plane.setAttribute('scale', '1 1 1');
    if (plane.object3D) plane.object3D.scale.set(1, 1, 1);
    // 出現: 弾性(ゴムのような跳ね)で勢いよくポップ
    plane.setAttribute('animation', {
      property: 'scale',
      from: '0 0 0',
      to: '1 1 1',
      dur: 700,
      easing: 'easeOutElastic'
    });
    // 待機中: ふわふわ上下に揺れていきいきと(位置を弱くピンポン)
    plane.setAttribute('animation__bob', {
      property: 'object3D.position.y',
      from: 0.85,
      to: 0.95,
      dur: 1500,
      dir: 'alternate',
      loop: true,
      easing: 'easeInOutSine',
      delay: 320
    });

    // リング(目印)はtargetFound/targetLostで制御。会話中も映っている全精霊に印を残す。

    // タイプライター: 1文字ずつ描画してテクスチャを更新
    let revealed = 0;
    bubbleTypeTimers[id] = setInterval(() => {
      revealed++;
      drawBubbleFrame(id, layout, revealed);
      if (bubbleTextures[id]) bubbleTextures[id].needsUpdate = true;
      if (revealed >= total) { clearInterval(bubbleTypeTimers[id]); bubbleTypeTimers[id] = null; }
    }, TYPE_INTERVAL);
  }

  function hideSpeechBubble(id) {
    // 進行中のタイプライターを止める(非表示後に描画が走らないように)
    if (bubbleTypeTimers[id]) { clearInterval(bubbleTypeTimers[id]); bubbleTypeTimers[id] = null; }

    // リング(目印)はここでは消さない。targetLost時のみ消し、映っている間は印を残す。
    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;
    // 上下揺れを止めて定位置に戻す(次回表示がきれいにポップするように)
    plane.removeAttribute('animation__bob');
    if (plane.object3D) plane.object3D.position.y = 0.85;
    plane.setAttribute('animation', {
      property: 'scale',
      from: plane.getAttribute('scale'),
      to: '0 0 0',
      dur: 200,
      easing: 'easeInQuad'
    });
    if (bubbleHideTimers[id]) clearTimeout(bubbleHideTimers[id]);
    bubbleHideTimers[id] = setTimeout(() => {
      bubbleHideTimers[id] = null;
      if (plane.parentNode) plane.setAttribute('visible', 'false');
    }, 220);
  }

  // ==========================================
  // モード切替
  // ==========================================

  function setUIMode(newMode) {
    uiMode = newMode;
    modeScanBtn.classList.toggle('active', newMode === 'scan');
    modeBanterBtn.classList.toggle('active', newMode === 'banter');
    if (newMode === 'scan') {
      // スキャン中は会話を止めて、吹き出し・音声を一切出さない
      if (banterPaused) {
        banterPaused = false;
        document.getElementById('banter-pause-overlay')?.classList.add('hidden');
      }
      stopBanterLoop();
      spirits.forEach((_, i) => hideSpeechBubble(i));
      captureGuide.classList.remove('hidden');
      guideText.classList.remove('hidden');
      updateGuideUI();
      if (!isScanning && mode === 'ar') startScanning();
    } else {
      captureGuide.classList.add('hidden');
      guideText.classList.add('hidden');
      scanStatus.textContent = '';
      if (isScanning) stopScanning();
      clearOverlay();
    }
  }

  modeScanBtn.addEventListener('click', () => {
    if (uiMode === 'scan') return;
    setUIMode('scan');
  });

  modeBanterBtn.addEventListener('click', () => {
    // 精霊が1体もいなければ会話できない。Scanタブのまま誘導トーストだけ出す。
    if (spirits.length < 1) {
      showToast(s('toastSummonFirst'));
      return;
    }
    setUIMode('banter');
    // 再タップでも強制リスタート (スタック時の回復手段)
    if (banterPaused) {
      banterPaused = false;
      banterTurns = 0;
      document.getElementById('banter-pause-overlay')?.classList.add('hidden');
    }
    stopBanterLoop();
    banterHistory = [];
    startBanter();
  });

  // ===== リセットボタン (2回タップで確定) =====
  let resetConfirmTimer = null;

  resetBtn.addEventListener('click', () => {
    if (resetConfirmTimer) {
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = null;
      resetBtn.classList.remove('confirm');
      executeReset();
      return;
    }
    resetBtn.classList.add('confirm');
    resetBtn.textContent = s('resetConfirm');
    resetConfirmTimer = setTimeout(() => {
      resetConfirmTimer = null;
      resetBtn.classList.remove('confirm');
      resetBtn.textContent = s('resetBtn');
    }, 2000);
  });

  function executeReset() {
    stopBanterLoop();
    stopScanning();
    teardownScene();
    releaseCamera();

    spirits.length = 0;
    visibleTargets.clear();
    clearBanterVisibility();
    banterHistory = [];
    banterMemory = [];
    banterMemoryLoaded = false;
    newcomerToAnnounce = null;
    currentSituation = null;
    pendingTurn = null;
    detectedTargets = [];
    isCompiling = false;
    arReadyFired = false;
    banterTurns = 0;
    banterPaused = false;
    document.getElementById('banter-pause-overlay')?.classList.add('hidden');
    lastBanterErr = '—';
    if (compiledMindUrl) { URL.revokeObjectURL(compiledMindUrl); compiledMindUrl = null; }
    compiledMindBuffer = null;
    compiledSpiritCount = 0;
    clearMindCache();
    localStorage.removeItem(SPIRIT_STORAGE_KEY);
    localStorage.removeItem(MEMORY_STORAGE_KEY);

    mode = 'scan';
    uiMode = 'scan';
    activeVideo = videoElement;

    resetBtn.textContent = s('resetBtn');
    resetBtn.classList.add('hidden');
    updateSpiritCountBtn();
    videoElement.classList.remove('hidden-feed');
    modeScanBtn.classList.add('active');
    modeBanterBtn.classList.remove('active');
    captureGuide.classList.remove('hidden');
    captureGuide.classList.remove('subtle');
    captureGuide.classList.remove('transparent');
    guideText.classList.remove('hidden');
    guideText.textContent = s('guideGaze');
    scanStatus.textContent = '';
    clearOverlay();
    resetGaze();

    startCamera().then(ok => { if (ok) startScanning(); });
  }

  // ==========================================
  // 起動: カメラ即時開始・音声は初回タップでアンロック
  // ==========================================

  window.addEventListener('resize', () => {
    syncOverlayCanvas();
  });

  applyUIStrings();

  // ===== デバッグ表示 =====
  // モバイル(タッチ端末)では「読み込み時間のみ」を少し大きく表示。詳細ログは /logs を参照。
  // デスクトップは診断用に全項目を表示する。
  const debugEl = document.getElementById('debug-overlay');
  const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  if (debugEl && isTouch) {
    // モバイル: 画像認識(/api/segment-vessels)とBanter(/api/banter)のうち、
    // 現在通信中の方(なければ直近に更新された方)を1つだけ ms で表示。右揃え・Helvetica。
    debugEl.classList.add('big');
    const row = document.createElement('div'); row.className = 'dbg-row';
    const labelEl = document.createElement('span'); labelEl.className = 'dbg-label';
    const valEl = document.createElement('span'); valEl.className = 'dbg-val';
    row.appendChild(labelEl); row.appendChild(valEl); debugEl.appendChild(row);
    const tick = () => {
      let label, ms;
      if (scanReqStart != null) { label = 'Image Recognition:'; ms = performance.now() - scanReqStart; }
      else if (banterReqStart != null) { label = 'Banter:'; ms = performance.now() - banterReqStart; }
      else if (lastBanterAt >= lastScanAt && lastBanterMs != null) { label = 'Banter:'; ms = lastBanterMs; }
      else if (lastScanMs != null) { label = 'Image Recognition:'; ms = lastScanMs; }
      else { label = 'Image Recognition:'; ms = null; }
      labelEl.textContent = label;
      valEl.textContent = ms != null ? Math.round(ms) + ' ms' : '—';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    // デスクトップもモバイルと同じ1行・ms・Helvetica・右揃え表示
    debugEl.classList.add('big');
    const row = document.createElement('div'); row.className = 'dbg-row';
    const labelEl = document.createElement('span'); labelEl.className = 'dbg-label';
    const valEl = document.createElement('span'); valEl.className = 'dbg-val';
    row.appendChild(labelEl); row.appendChild(valEl); debugEl.appendChild(row);
    const tick = () => {
      let label, ms;
      if (scanReqStart != null) { label = 'Image Recognition:'; ms = performance.now() - scanReqStart; }
      else if (banterReqStart != null) { label = 'Banter:'; ms = performance.now() - banterReqStart; }
      else if (lastBanterAt >= lastScanAt && lastBanterMs != null) { label = 'Banter:'; ms = lastBanterMs; }
      else if (lastScanMs != null) { label = 'Image Recognition:'; ms = lastScanMs; }
      else { label = 'Image Recognition:'; ms = null; }
      labelEl.textContent = label;
      valEl.textContent = ms != null ? Math.round(ms) + ' ms' : '—';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  (async () => {
    const started = await startCamera();
    if (!started) return;
    startScanning();
  })();

  // ===== Service Worker: アップデート検知 =====
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          // 新しいSWがインストール済みで、かつ既存SWが動いている = アップデートあり
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast(s('toastUpdate'), true);
            toastDiv.style.pointerEvents = 'auto';
            toastDiv.style.cursor = 'pointer';
            toastDiv.addEventListener('click', () => {
              toastDiv.style.pointerEvents = '';
              toastDiv.style.cursor = '';
              newWorker.postMessage('SKIP_WAITING');
            }, { once: true });
          }
        });
      });
    }).catch(() => {});

    // SWが切り替わったらページをリロードして新バージョンを適用
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!swRefreshing) { swRefreshing = true; window.location.reload(); }
    });
  }
});
