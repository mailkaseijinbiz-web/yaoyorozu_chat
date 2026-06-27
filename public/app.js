// フキダシ用ビルボード: 親(トラッキング対象)がどんな角度でも、常にカメラ正面を向かせて歪みを防ぐ
AFRAME.registerComponent('billboard', {
  init() {
    // tickは毎フレーム走るため、ベクトル/クォータニオンは使い回してGC負荷を避ける
    this.camPos = new THREE.Vector3();
    this.targetPos = new THREE.Vector3();
    this.qParentInv = new THREE.Quaternion();
    this.dir = new THREE.Vector3();
    this.qWorld = new THREE.Quaternion();
    this.zAxis = new THREE.Vector3(0, 0, 1);
  },
  tick() {
    const cam = this.el.sceneEl.camera;
    const obj = this.el.object3D;
    if (!cam || !obj.parent) return;

    // カメラと吹き出しのワールド座標を取得
    cam.getWorldPosition(this.camPos);
    obj.getWorldPosition(this.targetPos);

    // ターゲットからカメラへの方向ベクトル (プレーンの表面Z+が向くべき方向)
    this.dir.subVectors(this.camPos, this.targetPos).normalize();

    // Z+方向からdirへのワールド回転を計算
    this.qWorld.setFromUnitVectors(this.zAxis, this.dir);

    // 親のワールド回転の逆を求めて、ローカル回転に変換
    obj.parent.getWorldQuaternion(this.qParentInv).invert();
    obj.quaternion.copy(this.qParentInv.multiply(this.qWorld));
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // ===== チューニング用定数 =====
  const SPIRIT_STORAGE_KEY = 'ar_agents_2_spirits';
  const GAZE_DURATION = 2000;        // 凝視で注入完了までの時間(ms)
  const SCAN_INTERVAL = 700;         // AIスキャン(物体検出)の間隔(ms)
  const MOTION_CHECK_INTERVAL = 150; // カメラぶれ検知の間隔(ms)
  const MOTION_THRESHOLD = 25;       // 平均輝度差がこれを超えたら「視線逸らし」とみなす(0-255)
  const TURN_GAP_MS = 250;           // セリフ読み上げ後、次のターンまでの間(ms)
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

  let gazeStartTime = null;
  let gazeInterval = null;
  let gazeSig = null; // すり替え判定の基準シグネチャ。凝視中は毎周期その時点のフレームへ更新する(runScanCycle参照)

  let motionInterval = null;
  let prevMotionFrame = null;

  let compiledMindUrl = null;
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
  // 精霊の永続化 (LocalStorage)
  // ==========================================

  function saveSpirits() {
    try {
      localStorage.setItem(SPIRIT_STORAGE_KEY, JSON.stringify(
        spirits.map(s => ({ ...s, sig: s.sig ? Array.from(s.sig) : null }))
      ));
    } catch (e) {
      console.warn('Spirit save failed:', e);
    }
  }

  function loadSpirits() {
    try {
      const raw = localStorage.getItem(SPIRIT_STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(raw).map(s => ({ ...s, sig: s.sig ? new Float32Array(s.sig) : null }));
    } catch (e) {
      return [];
    }
  }

  function updateSpiritCountBtn() {
    spiritCountNum.textContent = spirits.length;
    spiritCountBtn.classList.toggle('hidden', spirits.length === 0);
  }

  // ==========================================
  // 精霊一覧パネル
  // ==========================================

  function openSpiritPanel() {
    renderSpiritPanel();
    spiritPanel.classList.add('open');
  }

  function closeSpiritPanel() {
    spiritPanel.classList.remove('open');
  }

  function renderSpiritPanel() {
    const list = document.getElementById('spirit-list');
    spiritPanelCount.textContent = spirits.length;
    list.innerHTML = '';
    spirits.forEach((spirit, idx) => {
      const row = document.createElement('div');
      row.className = 'spirit-row';
      row.innerHTML = `
        <img class="spirit-thumb" src="${spirit.image}" style="border-color:${spirit.color}">
        <div class="spirit-info">
          <div class="spirit-name">${spirit.name}</div>
          <div class="spirit-vessel">${spirit.vessel}</div>
        </div>
        <button class="spirit-delete-btn" data-idx="${idx}">Release</button>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll('.spirit-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteSpirit(parseInt(btn.dataset.idx)));
    });
  }

  async function deleteSpirit(idx) {
    closeSpiritPanel();
    spirits.splice(idx, 1);
    saveSpirits();
    updateSpiritCountBtn();

    if (spirits.length === 0) {
      executeReset();
      return;
    }

    if (spirits.length === 1) {
      stopBanterLoop();
      teardownScene();
      mode = 'scan';
      activeVideo = videoElement;
      videoElement.classList.remove('hidden-feed');
      setUIMode('scan');
      const ok = await startCamera();
      if (ok) startScanning();
      showToast('Down to one spirit. Find one more.');
      return;
    }

    await enterAR(null);
  }

  spiritCountBtn.addEventListener('click', openSpiritPanel);
  document.getElementById('spirit-panel-backdrop').addEventListener('click', closeSpiritPanel);
  document.getElementById('spirit-panel-close').addEventListener('click', closeSpiritPanel);

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
      showToast('Camera API unavailable. Please access over HTTPS.', true);
      return false;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      videoElement.srcObject = mediaStream;
      return true;
    } catch (err) {
      console.error('Camera error:', err);
      showToast('Please allow camera access.', true);
      return false;
    }
  }

  function stopCamera() {
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
    if (mode === 'scan') {
      guideText.textContent = 'Gaze at an object to summon its spirit...';
    } else {
      guideText.textContent = 'Point at new objects to add more spirits';
    }
    scanStatus.textContent = '';
    guideText.style.borderColor = color;
    guideText.style.boxShadow = `0 0 14px ${color}59`;
    scanLine.style.background = `linear-gradient(90deg, transparent, ${color}, transparent)`;
    scanLine.style.boxShadow = `0 0 14px ${color}`;
    updateScanLine();
    updateScanGuideVisibility();
  }

  // スキャンライン: スキャンUI表示中かつスキャン稼働中は常に表示 (凝視中は矩形の塗り潰しが進行表示になる)
  // mode('scan'/'ar')ではなくuiModeで判定し、AR中にScanタブで追加召喚する間も出るようにする。
  function updateScanLine() {
    const show = uiMode === 'scan' && isScanning && gazeStartTime === null;
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
    startMotionWatch();
    runScanCycle();
  }

  function stopScanning() {
    isScanning = false;
    isRequestPending = false;
    if (scanTimeout) {
      clearTimeout(scanTimeout);
      scanTimeout = null;
    }
    stopMotionWatch();
    resetGaze();
  }

  function syncOverlayCanvas() {
    const rect = captureGuide.getBoundingClientRect();
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;
    overlayCanvas.style.left = rect.left + 'px';
    overlayCanvas.style.top = rect.top + 'px';
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

    snapshotCanvas.width = sourceW;
    snapshotCanvas.height = sourceH;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(video, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);

    return snapshotCanvas.toDataURL('image/jpeg');
  }

  async function runScanCycle() {
    if (!isScanning || isRequestPending) return;
    const session = scanSessionId;

    // コンパイル中は新規スキャンを止める (登録済みのモノは検出後に名前でスキップする)
    if (isCompiling) {
      clearOverlay();
      resetGaze();
      scanTimeout = setTimeout(runScanCycle, SCAN_INTERVAL);
      return;
    }

    if (!activeVideo || activeVideo.videoWidth === 0) {
      scanTimeout = setTimeout(runScanCycle, 300);
      return;
    }

    const dataUrl = captureGuideRegion();
    if (!dataUrl) {
      scanTimeout = setTimeout(runScanCycle, 300);
      return;
    }
    isRequestPending = true;

    try {
      const response = await fetch('/api/segment-vessels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });
      const data = await response.json();

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
            if (mode === 'ar') guideText.textContent = `Gaze to summon "${newTargets[0].target.spiritName}"`;
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
      if (isScanning && scanSessionId === session) {
        scanTimeout = setTimeout(runScanCycle, SCAN_INTERVAL);
      }
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
    drawRecognition(time);
    overlayRAF = requestAnimationFrame(overlayTick);
  }

  function drawRecognition(time) {
    const ctx = overlayCanvas.getContext('2d');
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const progress = gazeStartTime !== null
      ? Math.min(1, (Date.now() - gazeStartTime) / GAZE_DURATION) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(time / 300);

    for (const { target, color } of detectedTargets) {
      const col = color || nextColor();
      const [ymin, xmin, ymax, xmax] = target.box.map(v => v / 1000);
      const cx = (xmin + xmax) / 2 * w;
      const cy = (ymin + ymax) / 2 * h;

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

      if (elapsed >= GAZE_DURATION) {
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

  // ==========================================
  // カメラぶれ検知 (視線逸らしで即ゲージリセット)
  // ==========================================

  const motionCanvas = document.createElement('canvas');
  motionCanvas.width = 32;
  motionCanvas.height = 24;
  const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });

  function startMotionWatch() {
    stopMotionWatch();
    motionInterval = setInterval(checkMotion, MOTION_CHECK_INTERVAL);
  }

  function stopMotionWatch() {
    if (motionInterval) {
      clearInterval(motionInterval);
      motionInterval = null;
    }
    prevMotionFrame = null;
  }

  function checkMotion() {
    if (!activeVideo || activeVideo.videoWidth === 0) return;
    motionCtx.drawImage(activeVideo, 0, 0, 32, 24);
    const data = motionCtx.getImageData(0, 0, 32, 24).data;
    const gray = new Float32Array(32 * 24);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      gray[i] = (data[p] + data[p + 1] + data[p + 2]) / 3;
    }
    if (prevMotionFrame) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevMotionFrame[i]);
      if (sum / gray.length > MOTION_THRESHOLD && gazeStartTime !== null) {
        resetGaze();
        detectedTargets = [];
        clearOverlay();
        scanStatus.textContent = 'Gaze broke — gauge reset';
        if (mode === 'ar') updateGuideUI();
      }
    }
    prevMotionFrame = gray;
  }

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
        ? `✨ ${newNames[0]} has taken form!`
        : `✨ ${newNames.join(', ')} have taken form!`);
      saveSpirits();
      updateSpiritCountBtn();
      resetBtn.classList.remove('hidden');

      if (spirits.length >= 2) {
        // ARが既に動いていた(prevCount >= 2)なら最後の新参精霊を途中参加として通知
        const newcomerName = prevCount >= 2 ? newNames[newNames.length - 1] : null;
        await enterAR(newcomerName);
      } else {
        startScanning();
      }
    } catch (err) {
      console.error('Infusion error:', err);
      showToast('Failed to process the image. Please try again.');
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

    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.getContext('2d').drawImage(img, sqX, sqY, size, size, 0, 0, size, size);
    return c.toDataURL('image/jpeg');
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
      if (v.srcObject) {
        v.srcObject.getTracks().forEach(t => t.stop());
      }
      v.remove();
    });

    const vid = arSceneContainer.querySelector('video');
    if (vid && vid.srcObject) {
      vid.srcObject.getTracks().forEach(t => t.stop());
    }
    arSceneContainer.innerHTML = '';
    visibleTargets.clear();
    clearBanterVisibility();
    arVideo = null;

    // 旧WebGLコンテキストに紐づいたテクスチャキャッシュを破棄する。
    // シーン再構築後は新コンテキストで新テクスチャを生成しないと吹き出しが描画されない。
    bubbleHideTimers.forEach(t => t && clearTimeout(t));
    bubbleCanvases.length = 0;
    bubbleTextures.length = 0;
    bubbleHideTimers.length = 0;
  }

  async function enterAR(newcomerName, isRetry = false) {
    isCompiling = true;
    stopScanning();
    stopBanterLoop();

    // ARが既に動いている場合: コンパイルを先行させてARシーンを見せ続け、
    // 差し替え直前だけ短時間オーバーレイを出す（3〜8秒のブラックアウトを解消）。
    // 初回コンパイル(スキャンモード): 従来どおりフルオーバーレイ。
    const recompile = (mode === 'ar');

    if (!recompile) {
      loadingOverlay.classList.remove('hidden');
      loadingText.textContent = 'Preparing MindAR compile...';
      stopCamera();
      videoElement.classList.add('hidden-feed');
      teardownScene();
    } else {
      showToast(newcomerName ? `✨ Summoning ${newcomerName}...` : 'Updating AR scene...');
    }

    try {
      const imgs = await Promise.all(spirits.map(s => loadImage(s.image)));
      const compiler = new window.MINDAR.IMAGE.Compiler();
      await compiler.compileImageTargets(imgs, (p) => {
        // recompile中はオーバーレイ非表示なのでloadingTextへの書き込みは無害
        // MindARの進捗pは0〜100(%)で渡ってくるのでそのまま使う(以前は*100で10000%になっていた)
        loadingText.textContent = `Extracting soul... ${Math.min(100, Math.round(p))}%`;
      });
      const buffer = await compiler.exportData();
      if (compiledMindUrl) URL.revokeObjectURL(compiledMindUrl);
      compiledMindUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));

      // recompile: コンパイル完了後にシーン差し替え (ここだけ瞬時に暗転)
      if (recompile) {
        loadingOverlay.classList.remove('hidden');
        loadingText.textContent = 'Updating AR scene...';
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

      // 直前まで動いていた構成(>=2体)が残っていれば、その構成でARを一度だけ作り直して会話を復帰。
      if (poppedNewcomer && !isRetry && spirits.length >= 2) {
        showToast('Failed to add spirit. Returning to the previous conversation...');
        return enterAR(null, true);
      }

      // 復旧できない場合はスキャンモードへ安全に戻す。失敗時はモードに関わらずカメラを必ず生かす。
      showToast('AR compile failed. Re-scanning...');
      teardownScene();
      mode = 'scan';
      activeVideo = videoElement;
      videoElement.classList.remove('hidden-feed');
      const recovered = await startCamera();
      if (recovered) {
        startScanning();
      } else {
        showToast('Failed to restart the camera. Please reload the page.', true);
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
      <a-scene mindar-image="imageTargetSrc: ${compiledMindUrl}; maxTrack: ${maxTrack}; filterMinCF: 0.0001; filterBeta: 0.001; uiScanning: no; uiLoading: no; uiError: no;"
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
        // 2体が実際に映ったら会話タブへ自動切替＆バンター開始
        if (mode === 'ar' && visibleTargets.size >= 2) {
          if (uiMode !== 'banter') setUIMode('banter');
          if (!isBanterRunning) startBanter(null);
        }
      });
      el.addEventListener('targetLost', () => {
        visibleTargets.delete(i);
        // 画面外に出たら吹き出し・マーカーを消す
        hideSpeechBubble(i);
        const ring = document.getElementById(`ring-${i}`);
        if (ring) ring.setAttribute('visible', 'false');
        if (visibleTargets.size === 0) scanStatus.textContent = '';
        updateScanGuideVisibility();
        // 猶予付き: すぐには会話可視集合から外さない。一定時間で戻ってこなければ確定で外す。
        if (visibleGraceTimers[i]) clearTimeout(visibleGraceTimers[i]);
        visibleGraceTimers[i] = setTimeout(() => {
          visibleGraceTimers[i] = null;
          banterVisible.delete(i);
          // 確定で2体未満になったらスキャンタブへ自動で戻す
          if (mode === 'ar' && banterVisible.size < 2 && uiMode === 'banter') {
            setUIMode('scan');
          }
        }, VISIBLE_GRACE_MS);
      });
    });
  }

  // ==========================================
  // 音声 (ElevenLabs TTS / 先読み再生)
  // ==========================================

  let banterAudio = null;
  let audioUnlocked = false;
  // 無音wav: ユーザー操作起点でAudioをアンロックする (iOS Safari対策)
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  document.addEventListener('pointerdown', () => {
    if (audioUnlocked) return;
    if (!banterAudio) banterAudio = new Audio();
    banterAudio.src = SILENT_WAV;
    banterAudio.play().then(() => hideToast()).catch(() => {});
    audioUnlocked = true;
  });

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
      onEnd(spoke);
    };

    objUrl = URL.createObjectURL(blob);
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
      showToast('🔊 Tap the screen to hear the spirits speak', true);
      finish(false);
    });
  }

  function stopSpeaking() {
    if (banterAudio) {
      banterAudio.onended = banterAudio.onerror = null;
      banterAudio.pause();
      banterAudio.removeAttribute('src');
    }
  }

  // ==========================================
  // 精霊Banter (自動開始 / N体対応 / 先読みパイプライン)
  // ==========================================

  let banterSession = 0;
  let isBanterRunning = false;
  let banterHistory = [];
  let banterTimeout = null;
  let pendingTurn = null;
  let newcomerToAnnounce = null;

  // 会話参加できる精霊のグローバルindex一覧。
  // 吹き出しは実際にトラッキング中の物体にしか描画できないため、ここは「実可視(visibleTargets)」を使う。
  // (猶予付きbanterVisibleはタブの自動切替を安定させる用途のみ。会話の話者は必ず実際に映っている精霊にする)
  function visibleSpiritIndices() {
    return [...visibleTargets].filter(i => i >= 0 && i < spirits.length).sort((a, b) => a - b);
  }

  // 指定した参加者(グローバルindex配列)だけでセリフ生成とTTS音声取得を先読みする。
  // nextSpeaker は参加者配列内のローカルindex(agent0..)なのでグローバルindexへ写し戻す。
  function fetchTurn(participants) {
    const participantNames = new Set(participants.map(i => spirits[i].name));
    const filteredHistory = banterHistory.filter(h => participantNames.has(h.name));
    const body = JSON.stringify({
      spirits: participants.map(i => ({
        name: spirits[i].name, vessel: spirits[i].vessel, personality: spirits[i].personality
      })),
      history: filteredHistory,
      newcomer: newcomerToAnnounce,
      situation: currentSituation
    });
    newcomerToAnnounce = null;

    return fetch('/api/banter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
      .then(r => r.json())
      .then(data => {
        if (data.error || !data.reply) return { data };
        const local = parseInt(String(data.nextSpeaker).replace('agent', ''), 10);
        const globalIdx = participants[Number.isInteger(local) ? local : 0] ?? participants[0];
        const speechText = data.ttsReply || data.reply;
        const audioP = fetchTTS(globalIdx, speechText)
          .then(r => (r.ok ? r.blob() : null))
          .catch(() => null);
        return { data, globalIdx, audioP };
      })
      .catch(err => ({ data: { error: String(err) } }));
  }

  function startBanter(newcomerName) {
    banterSession++;
    isBanterRunning = true;
    pendingTurn = null;
    newcomerToAnnounce = newcomerName || null;

    // 新メンバー参加時は会話履歴をリセットし、起承転結を最初(起)からやり直す。
    // (古い履歴が残っていると server 側の turnCount が大きいまま「結」になり、
    //  歓迎する間もなく1ターンでオチがついて即終了してしまう)
    if (newcomerName) banterHistory = [];

    // シチュエーションは初回/再開時のみ更新。新メンバー参加時は場面を維持する。
    if (!currentSituation || !newcomerName) {
      currentSituation = SITUATIONS[Math.floor(Math.random() * SITUATIONS.length)];
    }
    console.log('Current Situation:', currentSituation);

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

  async function runBanterTurn(session) {
    if (!isBanterRunning || session !== banterSession) return;
    try {

    // 画面に2体以上映っていなければ会話しない（映るまで待機）
    const visible = visibleSpiritIndices();
    if (visible.length < 2) {
      pendingTurn = null;
      spirits.forEach((_, i) => hideSpeechBubble(i));
      // ヒント表示: 精霊を探しているときにユーザーを誘導する
      if (mode === 'ar' && uiMode === 'banter') {
        if (visible.length === 0) {
          scanStatus.textContent = `Point your camera at the spirits`;
        } else {
          const missingIdx = spirits.findIndex((_, i) => !visibleTargets.has(i));
          const missingName = missingIdx >= 0 ? spirits[missingIdx].name : 'a spirit';
          scanStatus.textContent = `Point your camera at ${missingName}`;
        }
      }
      banterTimeout = setTimeout(() => runBanterTurn(session), 700);
      return;
    }
    scanStatus.textContent = '';

    const turn = await (pendingTurn || fetchTurn(visible));
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

    // 再生中に次のターンを先読み（現在映っている参加者で）してテンポを上げる
    // ただし、これが終了ターンの場合は次のターンを先読みしない
    const nextVisible = visibleSpiritIndices();
    const isEnding = turn.data.isEnd === true;
    pendingTurn = (nextVisible.length >= 2 && !isEnding) ? fetchTurn(nextVisible) : null;

    spirits.forEach((_, i) => { if (i !== idx) hideSpeechBubble(i); });
    showSpeechBubble(idx, turn.data.reply);

    const blob = turn.audioP ? await turn.audioP : null;
    if (!isBanterRunning || session !== banterSession) return;

    playLine(blob, (spoke) => {
      if (!isBanterRunning || session !== banterSession) return;
      if (isEnding) {
        isBanterRunning = false;
        // 会話終了後、少し間を置いて自動再開（会話モードの場合）
        setTimeout(() => {
          spirits.forEach((_, i) => hideSpeechBubble(i));
          if (uiMode === 'banter' && spirits.length >= 2) {
            banterHistory = [];
            startBanter();
          }
        }, 5000);
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
  function applyBubbleTexture(id) {
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
    if (mesh) apply(mesh);
    // arReady後でもエンティティ初期化が1フレーム遅れる場合があるため再試行
    else requestAnimationFrame(() => { const m = plane.getObject3D('mesh'); if (m) apply(m); });
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
    // 精霊が2体未満では会話できない。Scanタブのまま誘導トーストだけ出す。
    if (spirits.length < 2) {
      showToast('Summon 2 spirits to start a conversation');
      return;
    }
    setUIMode('banter');
    // 再タップでも強制リスタート (スタック時の回復手段)
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
    resetBtn.textContent = 'Confirm?';
    resetConfirmTimer = setTimeout(() => {
      resetConfirmTimer = null;
      resetBtn.classList.remove('confirm');
      resetBtn.textContent = 'Reset';
    }, 2000);
  });

  function executeReset() {
    stopBanterLoop();
    stopScanning();
    teardownScene();
    stopCamera();

    spirits.length = 0;
    visibleTargets.clear();
    clearBanterVisibility();
    banterHistory = [];
    newcomerToAnnounce = null;
    currentSituation = null;
    pendingTurn = null;
    detectedTargets = [];
    isCompiling = false;
    arReadyFired = false;
    banterTurns = 0;
    lastBanterErr = '—';
    if (compiledMindUrl) { URL.revokeObjectURL(compiledMindUrl); compiledMindUrl = null; }
    localStorage.removeItem(SPIRIT_STORAGE_KEY);

    mode = 'scan';
    uiMode = 'scan';
    activeVideo = videoElement;

    resetBtn.textContent = 'Reset';
    resetBtn.classList.add('hidden');
    updateSpiritCountBtn();
    videoElement.classList.remove('hidden-feed');
    modeScanBtn.classList.add('active');
    modeBanterBtn.classList.remove('active');
    captureGuide.classList.remove('hidden');
    captureGuide.classList.remove('subtle');
    captureGuide.classList.remove('transparent');
    guideText.classList.remove('hidden');
    guideText.textContent = 'Gaze at an object to summon its spirit...';
    scanStatus.textContent = '';
    clearOverlay();
    resetGaze();

    startCamera().then(ok => { if (ok) startScanning(); });
  }

  // ==========================================
  // 起動: カメラ即時開始・音声は初回タップでアンロック
  // ==========================================

  window.addEventListener('resize', () => {
    if (isScanning) syncOverlayCanvas();
  });

  showToast('Tap to enable sound', true);

  // ===== デバッグ表示 =====
  const debugEl = document.getElementById('debug-overlay');
  setInterval(() => {
    if (!debugEl) return;
    const lines = [
      `mode:    ${mode} / ui: ${uiMode}`,
      `spirits: ${spirits.length}  visible: ${visibleTargets.size}  arRdy: ${arReadyFired ? '✓' : '—'}`,
      `scan:    ${isScanning ? '▶' : '—'}  compile: ${isCompiling ? '⏳' : '—'}  req: ${isRequestPending ? '⏳' : '—'}`,
      `banter:  ${isBanterRunning ? '▶' : '—'}  turns: ${banterTurns}  audio: ${audioUnlocked ? '✓' : '✗'}`,
      `detect:  ${detectedTargets.length ? detectedTargets.map(t => t.target.name).join(', ') : '—'}`,
      `gaze:    ${gazeStartTime ? Math.round((Date.now() - gazeStartTime) / 100) / 10 + 's' : '—'}`,
      `err:     ${lastBanterErr}`,
    ];
    debugEl.textContent = lines.join('\n');
  }, 200);

  (async () => {
    // 前回の精霊をLocalStorageから復元
    const saved = loadSpirits();
    if (saved.length > 0) {
      spirits.push(...saved);
      updateSpiritCountBtn();
      resetBtn.classList.remove('hidden');
    }

    const started = await startCamera();
    if (!started) return;

    if (spirits.length >= 2) {
      showToast(`✨ Restored ${spirits.length} spirits`);
      await enterAR(null);
    } else {
      if (spirits.length === 1) showToast(`✨ Restored ${spirits[0].name}. Find one more.`);
      startScanning();
    }
  })();

  // ===== Service Worker: アップデート検知 =====
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          // 新しいSWがインストール済みで、かつ既存SWが動いている = アップデートあり
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Update available — tap to restart', true);
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
