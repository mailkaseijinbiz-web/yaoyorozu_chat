document.addEventListener('DOMContentLoaded', () => {
  // ===== チューニング用定数 =====
  const GAZE_DURATION = 3000;        // 凝視で注入完了までの時間(ms)
  const SCAN_INTERVAL = 900;         // AIスキャン(物体検出)の間隔(ms)
  const MOTION_CHECK_INTERVAL = 150; // カメラぶれ検知の間隔(ms)
  const MOTION_THRESHOLD = 25;       // 平均輝度差がこれを超えたら「視線逸らし」とみなす(0-255)

  // ===== DOM =====
  const scanContainer = document.getElementById('scan-container');
  const videoElement = document.getElementById('camera-feed');
  const overlayCanvas = document.getElementById('camera-overlay-canvas');
  const captureGuide = document.getElementById('capture-guide');
  const guideText = document.getElementById('guide-text');
  const gaugeFill = document.getElementById('gauge-fill');
  const gaugePct = document.getElementById('gauge-pct');
  const scanStatus = document.getElementById('scan-status');
  const resetBtn = document.getElementById('reset-btn');
  const flashOverlay = document.getElementById('flash-overlay');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const snapshotCanvas = document.getElementById('snapshot-canvas');

  const arUiContainer = document.getElementById('ar-ui-container');
  const arSceneContainer = document.getElementById('ar-scene-container');
  const arStatus = document.getElementById('ar-status');
  const transcriptDiv = document.getElementById('transcript');
  const banterBtn = document.getElementById('banter-btn');
  const arResetBtn = document.getElementById('ar-reset-btn');

  // ===== 状態 =====
  let mediaStream = null;
  let currentSlot = 0; // 0: 青の魂, 1: 赤の魂
  const slotImages = [null, null];        // 切り出した器画像 (DataURL)
  const vesselDescriptions = [null, null]; // 器の名前 (例: 青い空き缶)
  const spiritNames = [null, null];        // 動的精霊名 (例: ドリンクの精霊)

  let scanSessionId = 0;
  let isScanning = false;
  let isRequestPending = false;
  let scanTimeout = null;
  let detectedTarget = null;

  let gazeStartTime = null;
  let gazeInterval = null;

  let motionInterval = null;
  let prevMotionFrame = null;

  let compiledMindUrl = null;

  const SLOT_THEME = [
    { label: '青の魂', icon: '🔵', color: '#00e5ff', bg: 'rgba(0, 229, 255, 0.15)', cls: 'slot-blue', glow: 'blue-glow' },
    { label: '赤の魂', icon: '🔴', color: '#ff5252', bg: 'rgba(255, 82, 82, 0.15)', cls: 'slot-red', glow: 'red-glow' }
  ];

  // ==========================================
  // カメラ
  // ==========================================

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('カメラAPIが利用できません。HTTPSでアクセスしているか確認してください。');
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
      alert('カメラへのアクセスが必要です: ' + err.message);
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
  // スキャンループ (Gemini物体検出)
  // ==========================================

  function startScanning() {
    scanSessionId++;
    isScanning = true;
    isRequestPending = false;
    detectedTarget = null;
    resetGaze();

    const theme = SLOT_THEME[currentSlot];
    guideText.textContent = `${currentSlot + 1}つ目の器（${theme.label}）を枠に収めて凝視`;
    guideText.className = theme.cls;
    gaugeFill.className = currentSlot === 1 ? 'slot-red' : '';
    scanStatus.textContent = 'AIスキャン作動中...';

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

  // ガイド枠内の映像を snapshot-canvas に切り出す (object-fit: cover の座標補正込み)
  function captureGuideRegion() {
    const guideRect = captureGuide.getBoundingClientRect();
    const videoRect = videoElement.getBoundingClientRect();

    const ratioW = videoRect.width / videoElement.videoWidth;
    const ratioH = videoRect.height / videoElement.videoHeight;
    const scale = Math.max(ratioW, ratioH);
    const actualWidth = videoElement.videoWidth * scale;
    const actualHeight = videoElement.videoHeight * scale;
    const offsetX = (videoRect.width - actualWidth) / 2;
    const offsetY = (videoRect.height - actualHeight) / 2;

    const sourceX = (guideRect.left - offsetX) / scale;
    const sourceY = (guideRect.top - offsetY) / scale;
    const sourceW = guideRect.width / scale;
    const sourceH = guideRect.height / scale;

    snapshotCanvas.width = sourceW;
    snapshotCanvas.height = sourceH;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(videoElement, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);

    return snapshotCanvas.toDataURL('image/jpeg');
  }

  async function runScanCycle() {
    if (!isScanning || isRequestPending) return;

    const session = scanSessionId;

    if (videoElement.videoWidth === 0) {
      scanTimeout = setTimeout(runScanCycle, 200);
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
        detectedTarget = data.targets[0];
        drawBoundingBox(detectedTarget);
        scanStatus.textContent = `「${detectedTarget.name}」を捕捉中 — そのまま凝視してください`;
        startGaze();
      } else {
        detectedTarget = null;
        clearOverlay();
        scanStatus.textContent = '対象物を探しています...';
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

  function drawBoundingBox(target) {
    const ctx = overlayCanvas.getContext('2d');
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const theme = SLOT_THEME[currentSlot];
    const [ymin, xmin, ymax, xmax] = target.box.map(v => v / 1000);
    const rx = xmin * w;
    const ry = ymin * h;
    const rw = (xmax - xmin) * w;
    const rh = (ymax - ymin) * h;

    ctx.fillStyle = theme.bg;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.strokeStyle = theme.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // ラベル: 精霊名 + 器の名前
    const labelText = `${theme.icon} ${target.spiritName || '精霊'}: ${target.name}`;
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
    ctx.strokeStyle = theme.color;
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
    if (gazeStartTime !== null) return; // 進行中
    gazeStartTime = Date.now();

    gazeInterval = setInterval(() => {
      if (gazeStartTime === null) return;
      const elapsed = Date.now() - gazeStartTime;
      const pct = Math.min(100, (elapsed / GAZE_DURATION) * 100);
      gaugeFill.style.width = pct + '%';
      gaugePct.textContent = Math.round(pct) + '%';

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
    gaugeFill.style.width = '0%';
    gaugePct.textContent = '0%';
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
    prevMotionFrame = null;
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
    if (videoElement.videoWidth === 0) return;
    motionCtx.drawImage(videoElement, 0, 0, 32, 24);
    const data = motionCtx.getImageData(0, 0, 32, 24).data;
    const gray = new Float32Array(32 * 24);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      gray[i] = (data[p] + data[p + 1] + data[p + 2]) / 3;
    }
    if (prevMotionFrame) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevMotionFrame[i]);
      const meanDiff = sum / gray.length;
      if (meanDiff > MOTION_THRESHOLD && gazeStartTime !== null) {
        resetGaze();
        scanStatus.textContent = '視線が逸れました — ゲージをリセットしました';
      }
    }
    prevMotionFrame = gray;
  }

  // ==========================================
  // 魂の注入 (自動) → スロット遷移 / コンパイル
  // ==========================================

  async function triggerSoulInfusion() {
    if (!detectedTarget) {
      resetGaze();
      return;
    }
    const target = detectedTarget;
    stopScanning();

    // 画面フラッシュ
    flashOverlay.classList.remove('flash');
    void flashOverlay.offsetWidth; // アニメーション再トリガー
    flashOverlay.classList.add('flash');

    try {
      const fullImg = await loadImage(snapshotCanvas.toDataURL('image/jpeg'));
      slotImages[currentSlot] = cropImageWithBox(fullImg, target.box);
      vesselDescriptions[currentSlot] = target.name || `${SLOT_THEME[currentSlot].label}の器`;
      spiritNames[currentSlot] = target.spiritName || `${SLOT_THEME[currentSlot].label.charAt(0)}の精霊`;

      if (currentSlot === 0) {
        // 自動で2つ目のスキャンへ (カメラは開いたまま)
        currentSlot = 1;
        setTimeout(() => startScanning(), 700);
      } else {
        // 両方完了 → MindAR自動コンパイル
        stopCamera();
        clearOverlay();
        await compileTargets();
      }
    } catch (err) {
      console.error('Infusion error:', err);
      alert('画像の処理に失敗しました。もう一度お試しください。');
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

  // バウンディングボックスを正方形で切り出し (MindARターゲット用)
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
  // MindAR ランタイムコンパイル
  // ==========================================

  async function compileTargets() {
    loadingOverlay.classList.remove('hidden');
    loadingText.textContent = 'MindARコンパイル準備中...';

    try {
      const img0 = await loadImage(slotImages[0]);
      const img1 = await loadImage(slotImages[1]);

      const compiler = new window.MINDAR.IMAGE.Compiler();
      await compiler.compileImageTargets([img0, img1], (progress) => {
        loadingText.textContent = `魂を抽出中... ${Math.round(progress)}%`;
      });

      const buffer = await compiler.exportData();
      compiledMindUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));

      loadingOverlay.classList.add('hidden');
      scanContainer.classList.add('hidden');
      arUiContainer.classList.remove('hidden');
      startARScene();
    } catch (err) {
      console.error('Compilation error:', err);
      alert('ARターゲットの生成に失敗しました。やり直してください。');
      loadingOverlay.classList.add('hidden');
      fullReset();
    }
  }

  // ==========================================
  // ARシーン & 精霊Banter
  // ==========================================

  let isBanterMode = false;
  let banterHistory = [];
  let banterTimeout = null;
  const visibleTargets = new Set();

  // ===== ElevenLabs TTS =====
  let banterAudio = null;
  // 無音wav: ボタン押下(ユーザー操作)起点でAudioをアンロックしておく (iOS Safari対策)
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  function unlockAudio() {
    if (banterAudio) return;
    banterAudio = new Audio(SILENT_WAV);
    banterAudio.play().catch(() => {});
  }

  // セリフを再生し、終了時に onEnd(spoke) を呼ぶ。TTS不可なら spoke=false で即コールバック
  function speakLine(agentId, text, onEnd) {
    if (!banterAudio) banterAudio = new Audio();
    const audio = banterAudio;
    let finished = false;
    let watchdog = null;
    const finish = (spoke) => {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      audio.onended = audio.onerror = null;
      onEnd(spoke);
    };

    // 括弧類は読み上げが不自然に途切れるため除去
    const cleanText = text
      .replace(/[「」『』【】\[\]\(\)（）]/g, ' ')
      .replace(/[\n\r]+/g, '、')
      .trim();

    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    watchdog = setTimeout(() => finish(true), 20000);
    audio.src = `/api/tts?text=${encodeURIComponent(cleanText)}&agentId=${agentId}`;
    audio.play().catch(() => finish(false));
  }

  function stopSpeaking() {
    if (banterAudio) {
      banterAudio.onended = banterAudio.onerror = null;
      banterAudio.pause();
      banterAudio.removeAttribute('src');
    }
  }

  function startARScene() {
    arSceneContainer.innerHTML = `
      <a-scene mindar-image="imageTargetSrc: ${compiledMindUrl}; maxTrack: 2; filterMinCF: 0.0001; filterBeta: 0.001;"
               color-space="sRGB" renderer="colorManagement: true, physicallyCorrectLights"
               vr-mode-ui="enabled: false" device-orientation-permission-ui="enabled: false">
        <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>

        <a-entity mindar-image-target="targetIndex: 0" id="target-entity-0">
          <a-ring color="#00e5ff" radius-inner="0.45" radius-outer="0.5" position="0 0 0.05"
                  material="shader: flat; transparent: true; opacity: 0.85"></a-ring>
          <a-plane id="bubble-plane-0" position="0 0.85 0.1" width="1.6" height="0.8"
                   material="shader: flat; transparent: true;" visible="false" scale="0 0 0"></a-plane>
        </a-entity>

        <a-entity mindar-image-target="targetIndex: 1" id="target-entity-1">
          <a-ring color="#ff5252" radius-inner="0.45" radius-outer="0.5" position="0 0 0.05"
                  material="shader: flat; transparent: true; opacity: 0.85"></a-ring>
          <a-plane id="bubble-plane-1" position="0 0.85 0.1" width="1.6" height="0.8"
                   material="shader: flat; transparent: true;" visible="false" scale="0 0 0"></a-plane>
        </a-entity>
      </a-scene>
    `;

    setTimeout(setupARInteractions, 500);
  }

  function setupARInteractions() {
    const agents = [0, 1].map(id => ({
      id,
      el: document.getElementById(`target-entity-${id}`),
      name: spiritNames[id] || `${SLOT_THEME[id].label.charAt(0)}の精霊`,
      vessel: vesselDescriptions[id] || '不思議な器',
      glow: SLOT_THEME[id].glow
    }));

    agents.forEach(agent => {
      agent.el.addEventListener('targetFound', () => {
        visibleTargets.add(agent.id);
        arStatus.textContent = `${agent.name}が現れました！`;
        setTimeout(() => {
          if (visibleTargets.size > 0) arStatus.classList.add('hidden');
        }, 1500);
      });

      agent.el.addEventListener('targetLost', () => {
        visibleTargets.delete(agent.id);
        // 仕様: 会話はカメラが外れても停止しない
        if (visibleTargets.size === 0 && !isBanterMode) {
          arStatus.textContent = '器を探しています...';
          arStatus.classList.remove('hidden');
        }
      });
    });

    banterBtn.addEventListener('click', () => {
      if (isBanterMode) stopBanter();
      else startBanter();
    });

    function startBanter() {
      isBanterMode = true;
      banterHistory = [];
      unlockAudio();
      banterBtn.classList.add('active');
      banterBtn.textContent = '⏸ 会話を止める';
      arStatus.classList.add('hidden');
      showTranscript('system', null, '精霊たちが会話を始めています...');
      runBanterTurn();
    }

    function stopBanter() {
      isBanterMode = false;
      if (banterTimeout) {
        clearTimeout(banterTimeout);
        banterTimeout = null;
      }
      banterBtn.classList.remove('active');
      banterBtn.textContent = '💬 精霊たちを会話させる';
      stopSpeaking();
      agents.forEach(a => hideSpeechBubble(a.id));
      showTranscript('system', null, '会話を停止しました。');
    }

    async function runBanterTurn() {
      if (!isBanterMode) return;

      try {
        const response = await fetch('/api/banter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vessel0: agents[0].vessel,
            vessel1: agents[1].vessel,
            spirit0: agents[0].name,
            spirit1: agents[1].name,
            history: banterHistory
          })
        });
        const data = await response.json();

        if (!isBanterMode) return;
        if (data.error) {
          showTranscript('system', null, '会話エラーが発生しました。');
          stopBanter();
          return;
        }

        const speakerId = data.nextSpeaker === 'agent1' ? 1 : 0;
        const speaker = agents[speakerId];
        const text = data.reply;

        banterHistory.push({ sender: data.nextSpeaker, text });
        if (banterHistory.length > 15) banterHistory.shift();

        // 話していない方の吹き出しは閉じ、話者の頭上に表示
        hideSpeechBubble(1 - speakerId);
        showSpeechBubble(speakerId, text);
        showTranscript(speaker.glow, speaker.name, text);

        // 音声を読み終えたら次のターンへ。TTS不可ならテキスト長ベースの表示時間で代替
        speakLine(speakerId, text, (spoke) => {
          if (!isBanterMode) return;
          const delay = spoke ? 900 : Math.min(6000, 1800 + text.length * 110);
          banterTimeout = setTimeout(runBanterTurn, delay);
        });
      } catch (err) {
        console.error('Banter loop error:', err);
        if (isBanterMode) {
          showTranscript('system', null, '通信エラーが発生しました。');
          stopBanter();
        }
      }
    }
  }

  function showTranscript(glowClass, speakerName, text) {
    transcriptDiv.classList.remove('hidden');
    transcriptDiv.className = glowClass === 'system' ? '' : glowClass;
    transcriptDiv.innerHTML = '';
    if (speakerName) {
      const label = document.createElement('span');
      label.className = 'speaker';
      label.textContent = speakerName;
      transcriptDiv.appendChild(label);
    }
    transcriptDiv.appendChild(document.createTextNode(text));
  }

  // ===== 3D吹き出し (canvasテクスチャ) =====
  const bubbleCanvases = [0, 1].map(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    return c;
  });

  function showSpeechBubble(id, text) {
    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;

    const canvas = bubbleCanvases[id];
    const ctx = canvas.getContext('2d');
    const themeColor = SLOT_THEME[id].color;

    ctx.clearRect(0, 0, 512, 256);

    // 吹き出し本体 + しっぽ
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

    // 日本語テキストの折り返し描画
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

    // canvasをテクスチャとして適用
    plane.setAttribute('src', '');
    plane.setAttribute('src', canvas);
    const mesh = plane.getObject3D('mesh');
    if (mesh && mesh.material.map) mesh.material.map.needsUpdate = true;

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
  // リセット
  // ==========================================

  function fullReset() {
    stopScanning();
    slotImages[0] = slotImages[1] = null;
    vesselDescriptions[0] = vesselDescriptions[1] = null;
    spiritNames[0] = spiritNames[1] = null;
    currentSlot = 0;
    detectedTarget = null;
    if (!mediaStream) {
      startCamera().then(ok => { if (ok) startScanning(); });
    } else {
      startScanning();
    }
  }

  resetBtn.addEventListener('click', fullReset);
  // ARフェーズからのやり直しはMindAR/カメラの後始末が絡むためリロードが確実
  arResetBtn.addEventListener('click', () => location.reload());

  window.addEventListener('resize', () => {
    if (isScanning) syncOverlayCanvas();
  });

  // ==========================================
  // 起動: 即カメラ → 1つ目のスキャン開始
  // ==========================================

  async function init() {
    const started = await startCamera();
    if (started) startScanning();
  }

  setTimeout(init, 300);
});
