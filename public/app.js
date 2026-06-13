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
  const arControls = document.getElementById('ar-controls');
  const restartBanterBtn = document.getElementById('restart-banter-btn');

  // ===== 状態 =====
  let currentSituation = null;
  const SITUATIONS = [
    { location: 'リビングルーム', weather: '窓の外はどしゃ降りの雨' },
    { location: '静かな公園のベンチ', weather: '木漏れ日が心地よい晴天' },
    { location: 'お洒落なカフェのテラス席', weather: '少し風が強い曇り空' },
    { location: 'ごちゃごちゃした作業机の上', weather: '夕暮れ時の淡い西日' },
    { location: '真夜中の書斎', weather: '冷たい風が吹く星空' }
  ];
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
  let detectedSig = null;
  let isCompiling = false;

  let gazeStartTime = null;
  let gazeInterval = null;
  let gazeSig = null; // すり替え判定の基準シグネチャ。凝視中は毎周期その時点のフレームへ更新する(runScanCycle参照)

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
    const name = base || `精霊${spirits.length}`;
    if (!spirits.some(s => s.name === name)) return name;
    const SUP = ['②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    for (let n = 2; n <= 20; n++) {
      const cand = name + (SUP[n - 2] || n);
      if (!spirits.some(s => s.name === cand)) return cand;
    }
    return `${name} ${spirits.length + 1}`;
  }

  function updateScanGuideVisibility() {
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
    updateScanGuideVisibility();
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
        const target = data.targets[0];
        const sig = regionSignature(snapshotCanvas, target.box);
        if (isRegistered(target.name) || isOverTrackedSpirit(target.box) || matchesRegisteredImage(sig)) {
          // 登録済み・会話参加中・見た目が登録済みと同一のモノはスルー (二重登録とマーカーの重なりを防ぐ)
          detectedTarget = null;
          clearOverlay();
          if (mode === 'scan') {
            scanStatus.textContent = `「${target.name}」は登録済み — 別のモノを写してください`;
          } else {
            updateGuideUI();
          }
          resetGaze();
        } else {
          // 凝視中に枠内が「別物」へすり替わった瞬間だけゲージをリセットし、溜めた時間の乗っ取りを防ぐ。
          // 【意図的なトレードオフ】基準gazeSigは凝視開始時に固定せず、毎周期“直前フレーム”へ更新する(下記)。
          //  - 開始フレームに固定すると、同一物体のbboxジッタ/露出ドリフトで相関が落ち、静止した正規の
          //    対象でもゲージが誤リセットされ「召喚できない」P1不具合になる（しきい値を下げても低テクスチャ
          //    物体では起こりうる）。隣接フレーム比較なら静止物は決して誤リセットしない。
          //  - 代償として、隣接フレーム間で相関が急落しない“緩慢なパン”でのすり替えは捕捉できない。
          //    これは別系統のmotion-watch（カメラ移動で即リセット）が補完する。
          //  しきい値は重複判定(0.85)ではなく、明らかな別物だけを捉える緩いGAZE_SWAP_THRESHOLDを使う。
          if (gazeStartTime !== null && sig && gazeSig && sigCorrelation(sig, gazeSig) < GAZE_SWAP_THRESHOLD) {
            resetGaze();
          }
          detectedTarget = target;
          detectedSig = sig;
          detectedColor = extractThemeColor(snapshotCanvas, target.box);
          startOverlayLoop();
          // 認識できたモノを画面下に白で表示
          scanStatus.textContent = `${target.name} — ${target.spiritName}`;
          if (mode === 'ar') guideText.textContent = `「${target.spiritName}」を凝視で召喚`;
          startGaze();
          // 基準を最新フレームへ更新（隣接フレーム比較にして静止物の誤リセットを防ぐ。上のコメント参照）
          if (gazeStartTime !== null && sig) gazeSig = sig;
        }
      } else {
        detectedTarget = null;
        detectedColor = null;
        detectedSig = null;
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
    if (!isScanning || !detectedTarget) {
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

    const color = detectedColor || nextColor();
    const [ymin, xmin, ymax, xmax] = detectedTarget.box.map(v => v / 1000);
    const rx = xmin * w;
    const ry = ymin * h;
    const rw = (xmax - xmin) * w;
    const rh = (ymax - ymin) * h;
    const progress = gazeStartTime !== null
      ? Math.min(1, (Date.now() - gazeStartTime) / GAZE_DURATION) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(time / 300);

    // 1. エネルギー充填 (凝視の進行に合わせて下から満ちる)
    if (progress > 0) {
      const fillH = rh * progress;
      const gy = ry + rh - fillH;
      const grad = ctx.createLinearGradient(0, ry + rh, 0, gy);
      grad.addColorStop(0, color + 'a6');
      grad.addColorStop(1, color + '24');
      ctx.fillStyle = grad;
      ctx.fillRect(rx, gy, rw, fillH);

      // 充填面の光るライン
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(rx, gy);
      ctx.lineTo(rx + rw, gy);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 上昇するパーティクル
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 16; i++) {
        const px = rx + ((i * 0.618) % 1) * rw;
        const speed = 900 + (i % 5) * 350;
        const frac = ((time + i * 530) % speed) / speed;
        const py = ry + rh - frac * fillH;
        const size = 1.5 + (i % 3);
        ctx.globalAlpha = (1 - frac) * 0.9;
        ctx.fillRect(px, py, size, size);
      }
      ctx.globalAlpha = 1;
    }

    // 2. 流れる破線の枠 (解析中の演出)
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([12, 8]);
    ctx.lineDashOffset = -time / 25;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // 3. パルスするコーナーブラケット
    const len = Math.min(26, rw * 0.2, rh * 0.2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 + pulse * 10 + progress * 12;
    const corners = [
      [rx, ry, 1, 1], [rx + rw, ry, -1, 1],
      [rx, ry + rh, 1, -1], [rx + rw, ry + rh, -1, -1]
    ];
    corners.forEach(([cx, cy, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * len);
      ctx.stroke();
    });
    ctx.shadowBlur = 0;

    // 4. 解析スイープライン (凝視前のみ)
    if (progress === 0) {
      const sy = ry + (0.5 + 0.5 * Math.sin(time / 450)) * rh;
      const grad2 = ctx.createLinearGradient(rx, 0, rx + rw, 0);
      grad2.addColorStop(0, color + '00');
      grad2.addColorStop(0.5, color + 'e6');
      grad2.addColorStop(1, color + '00');
      ctx.fillStyle = grad2;
      ctx.fillRect(rx, sy - 1.5, rw, 3);
    }
  }

  // ==========================================
  // 凝視ゲージ (3秒で自動注入)
  // ==========================================

  function startGaze() {
    if (gazeStartTime !== null) return;
    gazeStartTime = Date.now();
    gazeSig = detectedSig; // この対象で凝視を開始したことを記録
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
        detectedTarget = null;
        detectedColor = null;
        detectedSig = null;
        clearOverlay();
        scanStatus.textContent = '視線が逸れました — ゲージをリセット';
        if (mode === 'ar') updateGuideUI();
      }
    }
    prevMotionFrame = gray;
  }

  // ==========================================
  // 魂の注入 → 召喚 (登録数無制限)
  // ==========================================

  async function triggerSoulInfusion() {
    if (!detectedTarget) {
      resetGaze();
      return;
    }
    const target = detectedTarget;

    // 注入直前の最終チェック: 凝視中にトラッキングが復帰した/同一物だと判明した場合は中止
    if (isRegistered(target.name) || isOverTrackedSpirit(target.box) || matchesRegisteredImage(detectedSig)) {
      detectedTarget = null;
      resetGaze();
      return;
    }

    flashOverlay.classList.remove('flash');
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add('flash');

    try {
      const fullImg = await loadImage(snapshotCanvas.toDataURL('image/jpeg'));
      spirits.push({
        image: cropImageWithBox(fullImg, target.box),
        vessel: target.name || '不思議な器',
        name: uniqueSpiritName(target.spiritName),
        personality: target.personality || '陽気でおしゃべり好き',
        voice: target.voice || 'cool_male',
        color: detectedColor || nextColor(), // 撮影したモノのドミナントカラー
        sig: detectedSig                     // 重複召喚防止用の画像シグネチャ
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
    arVideo = null;
  }

  async function enterAR(newcomerName, isRetry = false) {
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
        loadingText.textContent = '魂を抽出中...';
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

      // コンパイルを失敗させた新規精霊(直前にpushされたもの)を取り除く。
      // 残すと以降の再コンパイルに毎回混ざって同じ失敗を繰り返し、AR再入が永久に不能になる。
      const poppedNewcomer = !!newcomerName && spirits.length > 0;
      if (poppedNewcomer) spirits.pop();

      // 直前まで動いていた構成(>=2体)が残っていれば、その構成でARを一度だけ作り直して会話を復帰。
      if (poppedNewcomer && !isRetry && spirits.length >= 2) {
        showToast('追加召喚に失敗。前の会話に戻します…');
        return enterAR(null, true);
      }

      // 復旧できない場合はスキャンモードへ安全に戻す。失敗時はモードに関わらずカメラを必ず生かす。
      // AR中(mode==='ar')の失敗ではteardownSceneでARカメラを停止済みのため、
      // ここでカメラを再開しないと画面が固まる(文鎮化)。
      showToast('ARコンパイルに失敗しました。再スキャンします…');
      teardownScene();
      mode = 'scan';
      activeVideo = videoElement;
      videoElement.classList.remove('hidden-feed');
      const recovered = await startCamera();
      if (recovered) {
        startScanning();
      } else {
        showToast('カメラの再起動に失敗しました。ページを再読み込みしてください', true);
      }
    }
  }

  function buildScene() {
    const maxTrack = Math.min(spirits.length, 5);
    // リングは「今しゃべっている1体」だけに表示してマーカーが複数並ばないようにする
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
        scanStatus.textContent = `${spirit.name}がここにいます`;
        updateScanGuideVisibility();
      });
      el.addEventListener('targetLost', () => {
        visibleTargets.delete(i);
        // 画面外に出たら会話・マーカーを止める
        hideSpeechBubble(i);
        if (visibleTargets.size === 0) scanStatus.textContent = '';
        updateScanGuideVisibility();
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

  // マイクをキャプチャ状態にしておくと、iOS/Androidはページの音声自動再生を許可する。
  // これでタップなしでも精霊の声が出る (録音・送信は一切しない)。
  // 権限を拒否された場合は従来のタップアンロックにフォールバック。
  let micStream = null;
  async function enableTapFreeAudio() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioUnlocked = true;
      hideToast();
    } catch (e) {
      console.warn('Mic capture unavailable, falling back to tap unlock:', e.message);
    }
  }

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

  // 現在トラッキング中（画面に映っている）精霊のグローバルindex一覧
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

    arControls.classList.add('hidden'); // 会話開始時に再開ボタンを隠す
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

    // 画面に2体以上映っていなければ会話しない（映るまで待機）
    const visible = visibleSpiritIndices();
    if (visible.length < 2) {
      pendingTurn = null;
      spirits.forEach((_, i) => hideSpeechBubble(i));
      banterTimeout = setTimeout(() => runBanterTurn(session), 700);
      return;
    }

    const turn = await (pendingTurn || fetchTurn(visible));
    pendingTurn = null;
    if (!isBanterRunning || session !== banterSession) return;

    if (!turn || !turn.data || turn.data.error || !turn.data.reply) {
      console.error('Banter turn error:', turn && turn.data);
      banterTimeout = setTimeout(() => runBanterTurn(session), 3000);
      return;
    }

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
        // 3.5秒後に吹き出しを消し、再開ボタンを表示
        setTimeout(() => {
          spirits.forEach((_, i) => hideSpeechBubble(i));
          arControls.classList.remove('hidden');
        }, 3500);
      } else {
        const delay = spoke ? TURN_GAP_MS : Math.min(4500, 1100 + turn.data.reply.length * 90);
        banterTimeout = setTimeout(() => runBanterTurn(session), delay);
      }
    });
  }

  // ===== 3D吹き出し (CanvasTexture直接適用) =====
  const bubbleCanvases = [];
  const bubbleTextures = [];
  const bubbleHideTimers = []; // hide→show競合で吹き出しが表示直後に消えるのを防ぐ

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

    // 直前のhideが予約した「消す」タイマーを取り消す(表示直後に消されるのを防ぐ)
    if (bubbleHideTimers[id]) {
      clearTimeout(bubbleHideTimers[id]);
      bubbleHideTimers[id] = null;
    }

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

    // マーカー(リング)は話している1体だけに表示する
    const ring = document.getElementById(`ring-${id}`);
    if (ring) ring.setAttribute('visible', 'true');
  }

  function hideSpeechBubble(id) {
    const ring = document.getElementById(`ring-${id}`);
    if (ring) ring.setAttribute('visible', 'false');

    const plane = document.getElementById(`bubble-plane-${id}`);
    if (!plane) return;
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
  // 起動: スタート画面経由でカメラ起動・音声アンロック
  // ==========================================

  window.addEventListener('resize', () => {
    if (isScanning) syncOverlayCanvas();
  });

  const startOverlay = document.getElementById('start-overlay');
  const startBtn = document.getElementById('start-btn');

  startBtn.addEventListener('click', async () => {
    // ユーザー操作起点でオーディオを強制アンロック
    if (!banterAudio) banterAudio = new Audio();
    banterAudio.src = SILENT_WAV;
    try {
      await banterAudio.play();
      audioUnlocked = true;
    } catch (e) {
      console.warn('Audio auto-unlock failed:', e);
    }

    // スタート画面をフェードアウト
    startOverlay.style.opacity = '0';
    setTimeout(() => startOverlay.classList.add('hidden'), 500);

    // カメラとスキャンの開始
    const started = await startCamera();
    if (started) startScanning();
    enableTapFreeAudio();
  });

  restartBanterBtn.addEventListener('click', () => {
    banterHistory = [];
    startBanter();
  });
});
