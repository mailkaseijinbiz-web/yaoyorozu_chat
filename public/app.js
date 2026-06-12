document.addEventListener('DOMContentLoaded', () => {
  // ===== チューニング用定数 =====
  const GAZE_DURATION = 3000;        // 凝視で注入完了までの時間(ms)
  const SCAN_INTERVAL = 900;         // AIスキャン(物体検出)の間隔(ms)
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

  // ===== 状態 =====
  let mode = 'scan'; // 'scan' (初期登録) | 'ar' (ARシーン + 追加召喚)
  const spirits = []; // {image, vessel, name, personality, voice, color}

  let mediaStream = null;
  let activeVideo = videoElement; // 現在フレームを取得する対象のvideo要素
  let arVideo = null;

  let scanSessionId = 0;
  let isScanning = false;
  let isRequestPending = false;
  let scanTimeout = null;
  let detectedTarget = null;
  let detectedColor = null;
  let isCompiling = false;

  let gazeStartTime = null;
  let gazeInterval = null;

  let motionInterval = null;
  let prevMotionFrame = null;

  let compiledMindUrl = null;
  const visibleTargets = new Set();

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
      showToast('カメラAPIが利用できません。HTTPSでアクセスしてください', true);
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
      showToast('カメラへのアクセスを許可してください', true);
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

  function updateGuideUI() {
    const color = '#00e5ff';
    if (mode === 'scan') {
      guideText.textContent = '精霊を凝視して召喚せよ...';
    } else {
      guideText.textContent = '新しいモノを写すと精霊が増えます';
    }
    scanStatus.textContent = '';
    guideText.style.borderColor = color;
    guideText.style.boxShadow = `0 0 14px ${color}59`;
    scanLine.style.background = `linear-gradient(90deg, transparent, ${color}, transparent)`;
    scanLine.style.boxShadow = `0 0 14px ${color}`;
    updateScanLine();
  }

  // スキャンラインは初期スキャン中のみ表示 (凝視中は矩形の塗り潰しが進行表示になる)
  function updateScanLine() {
    const show = mode === 'scan' && isScanning && gazeStartTime === null;
    scanLine.classList.toggle('hidden', !show);
  }

  function startScanning() {
    scanSessionId++;
    isScanning = true;
    isRequestPending = false;
    detectedTarget = null;
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
        const target = data.targets[0];
        if (isRegistered(target.name) || isOverTrackedSpirit(target.box)) {
          // 登録済み・会話参加中のモノはスルー (二重登録とマークの重なりを防ぐ)
          detectedTarget = null;
          clearOverlay();
          if (mode === 'scan') {
            scanStatus.textContent = `「${target.name}」は登録済み — 別のモノを写してください`;
          } else {
            updateGuideUI();
          }
          resetGaze();
        } else {
          detectedTarget = target;
          detectedColor = extractThemeColor(snapshotCanvas, target.box);
          const progress = gazeStartTime !== null
            ? Math.min(1, (Date.now() - gazeStartTime) / GAZE_DURATION) : 0;
          drawBoundingBox(target, progress);
          scanStatus.textContent = `「${target.name}」を捕捉中 — そのまま凝視！`;
          if (mode === 'ar') guideText.textContent = `「${target.spiritName}」を凝視で召喚`;
          startGaze();
        }
      } else {
        detectedTarget = null;
        detectedColor = null;
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

  // progress (0〜1): 凝視の進行度。矩形が下から段々と色で塗られていく
  function drawBoundingBox(target, progress = 0) {
    const ctx = overlayCanvas.getContext('2d');
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const color = detectedColor || nextColor();
    const [ymin, xmin, ymax, xmax] = target.box.map(v => v / 1000);
    const rx = xmin * w;
    const ry = ymin * h;
    const rw = (xmax - xmin) * w;
    const rh = (ymax - ymin) * h;

    // ベースのうっすら塗り + 進行度に応じた下からの塗り潰し
    ctx.fillStyle = color + '1a';
    ctx.fillRect(rx, ry, rw, rh);
    if (progress > 0) {
      const fillH = rh * Math.min(1, progress);
      ctx.fillStyle = color + '8c';
      ctx.fillRect(rx, ry + rh - fillH, rw, fillH);
    }

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    const labelText = `✨ ${target.spiritName || '精霊'}: ${target.name}`;
    ctx.font = 'bold 13px Helvetica Neue, Arial, sans-serif';
    const labelW = ctx.measureText(labelText).width + 16;
    const labelH = 24;
    let labelX = rx;
    let labelY = ry - labelH - 5;
    if (labelY < 0) labelY = ry + 5;

    ctx.fillStyle = 'rgba(11, 15, 25, 0.85)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(labelX, labelY, labelW, labelH, 5);
    else ctx.rect(labelX, labelY, labelW, labelH);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, labelX + 8, labelY + labelH / 2);
  }

  // ==========================================
  // 凝視ゲージ (3秒で自動注入)
  // ==========================================

  function startGaze() {
    if (gazeStartTime !== null) return;
    gazeStartTime = Date.now();
    updateScanLine();

    gazeInterval = setInterval(() => {
      if (gazeStartTime === null) return;
      const elapsed = Date.now() - gazeStartTime;
      const progress = Math.min(1, elapsed / GAZE_DURATION);

      // 認識した矩形が段々と塗られていく
      if (detectedTarget) drawBoundingBox(detectedTarget, progress);

      if (elapsed >= GAZE_DURATION) {
        clearInterval(gazeInterval);
        gazeInterval = null;
        gazeStartTime = null;
        triggerSoulInfusion();
      }
    }, 50);
  }

  function resetGaze() {
    gazeStartTime = null;
    if (gazeInterval) {
      clearInterval(gazeInterval);
      gazeInterval = null;
    }
    if (detectedTarget) drawBoundingBox(detectedTarget, 0);
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
        scanStatus.textContent = '視線が逸れました — ゲージをリセット';
      }
    }
    prevMotionFrame = gray;
  }

  // ==========================================
  // 魂の注入 → 召喚 (登録数無制限)
  // ==========================================

  const infusionSound = new Audio('install_soul.mp3');

  async function triggerSoulInfusion() {
    if (!detectedTarget) {
      resetGaze();
      return;
    }
    const target = detectedTarget;
    stopScanning();

    flashOverlay.classList.remove('flash');
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add('flash');

    // 注入効果音 (初回タップ前のiOSではブロックされる場合があるが無視)
    infusionSound.currentTime = 0;
    infusionSound.play().catch(() => {});

    try {
      const fullImg = await loadImage(snapshotCanvas.toDataURL('image/jpeg'));
      spirits.push({
        image: cropImageWithBox(fullImg, target.box),
        vessel: target.name || '不思議な器',
        name: target.spiritName || `精霊${spirits.length}`,
        personality: target.personality || '陽気でおしゃべり好き',
        voice: target.voice || 'cool_male',
        color: detectedColor || nextColor() // 撮影したモノのドミナントカラー
      });
      const newSpirit = spirits[spirits.length - 1];
      showToast(`✨ ${newSpirit.name}が宿った！`);

      if (spirits.length >= 2) {
        // 2体以上で(再)コンパイル → ARへ。3体目以降は会話に途中参加
        await enterAR(spirits.length > 2 ? newSpirit.name : null);
      } else {
        startScanning();
      }
    } catch (err) {
      console.error('Infusion error:', err);
      showToast('画像の処理に失敗しました。もう一度どうぞ');
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
    const vid = arSceneContainer.querySelector('video');
    if (vid && vid.srcObject) {
      vid.srcObject.getTracks().forEach(t => t.stop());
    }
    arSceneContainer.innerHTML = '';
    visibleTargets.clear();
    arVideo = null;
  }

  async function enterAR(newcomerName) {
    isCompiling = true;
    stopScanning();
    stopBanterLoop();

    loadingOverlay.classList.remove('hidden');
    loadingText.textContent = 'MindARコンパイル準備中...';

    if (mode === 'scan') {
      stopCamera();
      videoElement.classList.add('hidden-feed');
    }
    teardownScene();

    try {
      const imgs = await Promise.all(spirits.map(s => loadImage(s.image)));
      const compiler = new window.MINDAR.IMAGE.Compiler();
      await compiler.compileImageTargets(imgs, (p) => {
        loadingText.textContent = `魂を抽出中... ${Math.round(p)}%`;
      });
      const buffer = await compiler.exportData();
      if (compiledMindUrl) URL.revokeObjectURL(compiledMindUrl);
      compiledMindUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));

      buildScene();
      const sceneEl = arSceneContainer.querySelector('a-scene');
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        sceneEl.addEventListener('arReady', finish, { once: true });
        setTimeout(finish, 8000);
      });

      arVideo = arSceneContainer.querySelector('video');
      if (arVideo) activeVideo = arVideo;
      mode = 'ar';
      isCompiling = false;

      captureGuide.classList.add('subtle');
      loadingOverlay.classList.add('hidden');
      updateGuideUI();
      setupTargetListeners();

      startBanter(newcomerName); // 会話は自動で開始
      startScanning();           // 追加召喚用のスキャンも継続
    } catch (err) {
      console.error('Compilation error:', err);
      isCompiling = false;
      loadingOverlay.classList.add('hidden');
      showToast('ARコンパイルに失敗しました。リロードしてやり直してください', true);
    }
  }

  function buildScene() {
    const maxTrack = Math.min(spirits.length, 3);
    const targetsHTML = spirits.map((s, i) => `
      <a-entity mindar-image-target="targetIndex: ${i}" id="target-entity-${i}">
        <a-ring color="${s.color}" radius-inner="0.45" radius-outer="0.5" position="0 0 0.05"
                material="shader: flat; transparent: true; opacity: 0.85"></a-ring>
        <a-plane id="bubble-plane-${i}" position="0 0.85 0.1" width="1.6" height="0.8"
                 material="shader: flat; transparent: true;" visible="false" scale="0 0 0"></a-plane>
      </a-entity>`).join('');

    arSceneContainer.innerHTML = `
      <a-scene mindar-image="imageTargetSrc: ${compiledMindUrl}; maxTrack: ${maxTrack}; filterMinCF: 0.0001; filterBeta: 0.001;"
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
        scanStatus.textContent = `${spirit.name}がここにいます`;
      });
      el.addEventListener('targetLost', () => {
        visibleTargets.delete(i);
        if (visibleTargets.size === 0) scanStatus.textContent = '';
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
    // 注入効果音もタップ起点でアンロックしておく (iOS対策)
    if (infusionSound.paused) {
      infusionSound.muted = true;
      infusionSound.play().then(() => {
        infusionSound.pause();
        infusionSound.currentTime = 0;
        infusionSound.muted = false;
      }).catch(() => { infusionSound.muted = false; });
    }
    audioUnlocked = true;
  });

  function ttsUrl(spiritIndex, text) {
    const cleanText = text
      .replace(/[「」『』【】\[\]\(\)（）]/g, ' ')
      .replace(/[\n\r]+/g, '、')
      .trim();
    const voice = (spirits[spiritIndex] && spirits[spiritIndex].voice) || 'cool_male';
    return `/api/tts?text=${encodeURIComponent(cleanText)}&voice=${encodeURIComponent(voice)}`;
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
    audio.play().catch(() => {
      audioUnlocked = false;
      showToast('🔊 画面をタップすると精霊の声が出ます', true);
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

  function speakerIndex(nextSpeaker) {
    const idx = parseInt(String(nextSpeaker).replace('agent', ''), 10);
    return Number.isInteger(idx) && idx >= 0 && idx < spirits.length ? idx : 0;
  }

  // 次のターンのセリフ生成とTTS音声取得をまとめて先読みする
  function prefetchTurn() {
    const body = JSON.stringify({
      spirits: spirits.map(s => ({ name: s.name, vessel: s.vessel, personality: s.personality })),
      history: banterHistory,
      newcomer: newcomerToAnnounce
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
        const idx = speakerIndex(data.nextSpeaker);
        const audioP = fetch(ttsUrl(idx, data.reply))
          .then(r => (r.ok ? r.blob() : null))
          .catch(() => null);
        return { data, audioP };
      })
      .catch(err => ({ data: { error: String(err) } }));
  }

  function startBanter(newcomerName) {
    banterSession++;
    isBanterRunning = true;
    pendingTurn = null;
    newcomerToAnnounce = newcomerName || null;
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

    const turn = await (pendingTurn || prefetchTurn());
    pendingTurn = null;
    if (!isBanterRunning || session !== banterSession) return;

    if (!turn || !turn.data || turn.data.error || !turn.data.reply) {
      console.error('Banter turn error:', turn && turn.data);
      banterTimeout = setTimeout(() => runBanterTurn(session), 4000);
      return;
    }

    const data = turn.data;
    const idx = speakerIndex(data.nextSpeaker);

    banterHistory.push({ sender: `agent${idx}`, text: data.reply });
    if (banterHistory.length > 15) banterHistory.shift();

    // 再生中に次のターンを先読みしてテンポを上げる
    pendingTurn = prefetchTurn();

    spirits.forEach((_, i) => { if (i !== idx) hideSpeechBubble(i); });
    showSpeechBubble(idx, data.reply);

    const blob = turn.audioP ? await turn.audioP : null;
    if (!isBanterRunning || session !== banterSession) return;

    playLine(blob, (spoke) => {
      if (!isBanterRunning || session !== banterSession) return;
      const delay = spoke ? TURN_GAP_MS : Math.min(4500, 1100 + data.reply.length * 90);
      banterTimeout = setTimeout(() => runBanterTurn(session), delay);
    });
  }

  // ===== 3D吹き出し (CanvasTexture直接適用) =====
  const bubbleCanvases = [];
  const bubbleTextures = [];

  function getBubbleCanvas(i) {
    if (!bubbleCanvases[i]) {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 256;
      bubbleCanvases[i] = c;
    }
    return bubbleCanvases[i];
  }

  function showSpeechBubble(id, text) {
    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;

    const canvas = getBubbleCanvas(id);
    const ctx = canvas.getContext('2d');
    const themeColor = spirits[id].color;

    ctx.clearRect(0, 0, 512, 256);

    ctx.fillStyle = 'rgba(11, 15, 25, 0.93)';
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 6;
    const rx = 15, ry = 15, rw = 482, rh = 180, radius = 16;
    ctx.beginPath();
    ctx.moveTo(rx + radius, ry);
    ctx.lineTo(rx + rw - radius, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + radius);
    ctx.lineTo(rx + rw, ry + rh - radius);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - radius, ry + rh);
    ctx.lineTo(256 + 18, ry + rh);
    ctx.lineTo(256, ry + rh + 22);
    ctx.lineTo(256 - 18, ry + rh);
    ctx.lineTo(rx + radius, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - radius);
    ctx.lineTo(rx, ry + radius);
    ctx.quadraticCurveTo(rx, ry, rx + radius, ry);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px Helvetica Neue, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const charsPerLine = 15;
    const lines = [];
    for (let i = 0; i < text.length; i += charsPerLine) {
      lines.push(text.slice(i, i + charsPerLine));
    }
    const startY = ry + rh / 2 - (lines.length - 1) * 17;
    lines.forEach((line, i) => ctx.fillText(line, 256, startY + i * 34));

    // CanvasTextureを直接マテリアルに適用 (A-Frameのsrc属性経由はiOSで真っ黒になる)
    const mesh = plane.getObject3D('mesh');
    if (mesh) {
      if (!bubbleTextures[id]) {
        const tex = new THREE.CanvasTexture(canvas);
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
        bubbleTextures[id] = tex;
      }
      bubbleTextures[id].needsUpdate = true;
      mesh.material.map = bubbleTextures[id];
      mesh.material.transparent = true;
      mesh.material.needsUpdate = true;
    }

    plane.setAttribute('visible', 'true');
    plane.setAttribute('animation', {
      property: 'scale',
      from: '0 0 0',
      to: '1 1 1',
      dur: 300,
      easing: 'easeOutBack'
    });
  }

  function hideSpeechBubble(id) {
    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;
    plane.setAttribute('animation', {
      property: 'scale',
      from: plane.getAttribute('scale'),
      to: '0 0 0',
      dur: 200,
      easing: 'easeInQuad'
    });
    setTimeout(() => plane.setAttribute('visible', 'false'), 220);
  }

  // ==========================================
  // 起動: 即カメラ → スキャン開始 (ボタン不要の全自動フロー)
  // ==========================================

  window.addEventListener('resize', () => {
    if (isScanning) syncOverlayCanvas();
  });

  async function init() {
    const started = await startCamera();
    if (started) startScanning();
  }

  setTimeout(init, 300);
});
