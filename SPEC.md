# AR Agents 2 — 仕様書

## 概要

スマートフォンカメラで実物を撮影し、そのモノに「精霊」を宿らせるARプロトタイプ。  
精霊同士が自律的に会話し、ElevenLabs TTSの声で話しかけてくる。

---

## フロー全体像

```
起動 → カメラ許可・音声アンロック
  ↓
スキャンモード: カメラでモノを枠に収める
  ↓ (Gemini物体認識)
対象を3秒凝視 → 魂の注入フラッシュ
  ↓ (1体目はここで待機)
2体以上登録 → MindARコンパイル (3〜8秒)
  ↓
ARモード: マーカー追跡 + 自動会話開始
  ↓ (スキャン継続 — 追加召喚可)
精霊が増える度にARを再コンパイル
```

---

## 主要機能

### 1. 物体認識 (Gemini 2.5 Flash)

- エンドポイント: `POST /api/segment-vessels`
- スキャン間隔: 900ms
- 入力: ガイド枠内のJPEG画像 (base64)
- 出力: `{ targets: [{ name, spiritName, personality, voice, box }] }`
  - `box`: `[ymin, xmin, ymax, xmax]` (0〜1000の正規化座標)
  - `voice`: `cool_male` / `genki_girl` / `wise_elder` / `gentle_lady`

### 2. 凝視スキャン (3秒)

- ガイド枠中央に対象を収め、3秒間静止
- 進行表示: キャンバスオーバーレイにクロスヘア + 円弧プログレス
- カメラぶれ検知 (32×24グレースケール差分、閾値25): 視線逸らしで即リセット
- すり替え検知 (隣接フレームの16×16正規化相関、閾値0.45): 別物に変わったらリセット

### 3. 重複召喚防止 (3段階)

| チェック | 方法 | 閾値 |
|---|---|---|
| 名前一致 | vessel名文字列比較 | 完全一致 |
| 画像類似度 | 16×16正規化クロスコリレーション | ≥0.85 |
| 画面重複 | THREE.Vector3.project()でスクリーン投影 | 重なりあり |

### 4. MindARコンパイル

- ライブラリ: `mind-ar@1.2.5`
- 全精霊の切り抜き画像を一括コンパイル → Blob URL生成
- `arReady`イベント OR 8秒タイムアウトで完了待機
- 3体目以降も同じフローで再コンパイル
- コンパイル失敗時: 追加精霊を破棄し前の構成で再試行。それも失敗ならスキャンモードへ復帰

### 5. ARシーン (A-Frame 1.5.0)

- `<a-ring>`: 発話中の1体のみ表示 (visible="false"がデフォルト)
- `<a-plane billboard>`: 吹き出し表示用プレーン
- `billboard`コンポーネント: カメラへの方向ベクトルからクォータニオン計算し常に正面を向かせる
- テクスチャ: `THREE.CanvasTexture`をmesh.material.mapに直接代入 (iOS Safari対策)

### 6. 自動バンター

- エンドポイント: `POST /api/banter`
- 参加者: 現在画面に映っている精霊のみ (2体以上で発動)
- 起承転結: turnCountで4段階のフェーズ管理
- 先読み: 再生中に次ターンのLLM+TTSをパラレルフェッチ
- `isEnd: true`ターンで終了 → 3.5秒後に「もう一度会話させる」ボタン表示
- 履歴: 最大15ターン保持、参加者名でフィルタリング
- 新メンバー加入時: 履歴リセット、起承転結を最初から

### 7. TTS音声 (ElevenLabs)

- エンドポイント: `GET /api/tts`
- モデル: `eleven_multilingual_v2`
- 設定: stability 0.35 / style 0.6 / speed 1.1x
- 4ボイスキャラクター:

| キー | 用途 | ElevenLabs Voice ID |
|---|---|---|
| `cool_male` | クールな男性 | Mv8AjrYZCBkdsmDHNwcB |
| `genki_girl` | 元気な女性 | fUjY9K2nAIwlALOwSiwc |
| `wise_elder` | 物知りな老人 | onwK4e9ZLuTAKqWW03F9 |
| `gentle_lady` | 穏やかな女性 | EXAVITQu4vr4xnSDxMaL |

### 8. 音声自動再生 (iOS対策)

- スタートボタン操作でサイレントWAVを再生 → `audioUnlocked = true`
- その後 `getUserMedia({audio: true})` でマイクキャプチャ → OSが音声アクティブ状態を維持
  - **順序重要**: マイクキャプチャはカメラ起動より先に実行 (後からaudioのgetUserMediaを呼ぶとiOSでビデオトラックが停止する)

### 9. 配色 (ドミナントカラー抽出)

- 撮影画像の検出領域を24×24にリサイズ
- HSL変換 → 彩度加重の色相ヒストグラム → 最多ビンを採用
- 無彩色(d<0.08)・白飛び・黒潰れは除外してパレット色にフォールバック

---

## ファイル構成

```
ar_agents_2/
├── server.js          # Expressサーバー + API実装
├── api/
│   └── index.js       # Vercel向けエントリポイント (server.jsをre-export)
├── public/
│   ├── index.html     # アプリHTML
│   ├── app.js         # フロントエンド全体 (~1300行)
│   ├── style.css      # スタイル
│   ├── manifest.json  # PWAマニフェスト
│   ├── sw.js          # Service Worker (ネットワークファースト)
│   ├── icon-192.png   # PWAアイコン
│   └── icon-512.png   # PWAアイコン
├── .env               # APIキー (gitignore)
├── .env.example       # テンプレート
├── vercel.json        # Vercelデプロイ設定
└── package.json
```

---

## 環境変数

| 変数 | 説明 |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter APIキー |
| `OPENROUTER_MODEL` | 使用モデル (デフォルト: `google/gemma-3-27b-it`) |
| `ELEVENLABS_API_KEY` | ElevenLabs APIキー |
| `PORT` | ローカルサーバーポート (デフォルト: 3000) |

---

## デプロイ

### ローカル
```bash
npm start   # http://localhost:3000
```

### Vercel
- `vercel.json` で `/api/*` → `api/index.js` にルーティング
- `outputDirectory: "public"` で静的ファイルを配信
- 環境変数はVercelダッシュボードで設定

### PWA (スマホにインストール)
- HTTPSでアクセス後、ブラウザの「ホーム画面に追加」を選択
- Android Chrome: インストールバナー自動表示
- iOS Safari: 共有ボタン → 「ホーム画面に追加」

---

## 技術的制約・注意点

- **MindARコンパイル**: 精霊を追加する度に全画像を再コンパイル (3〜8秒のローディング)
- **iOS Safari**: `getUserMedia` の呼び出し順序 (audio → video) を守らないとカメラが停止
- **吹き出しテクスチャ**: A-FrameのDOM `src`属性経由はiOSで真っ黒になるため `THREE.CanvasTexture` で直接適用
- **ビルボード**: `billboardコンポーネントの回転はtickで毎フレーム計算 (GC負荷軽減のためQuaternion/Vector3は使い回し)
- **バンター先読み**: `pendingTurn` に次ターンのPromiseを保持し、再生中にLLM+TTSをパラレル実行
- **凝視すり替え検知**: 固定シグネチャ比較は低テクスチャ物体で誤リセットを起こすため、隣接フレーム間比較を採用

---

## ローカルAI化の検討

| ステップ | 現在 | ローカル代替 | 評価 |
|---|---|---|---|
| 物体認識 | Gemini 2.5 Flash | Ollama + LLaVA / moondream | △ 精度低下 |
| バンター生成 | Gemini | Ollama llama3/qwen | △ 日本語品質低い |
| TTS | ElevenLabs | Piper / Coqui | × 感情表現なし |
| ARコンパイル | MindAR JS | — | ボトルネック (3〜8秒) |

ボトルネックはMindARのコンパイル処理であり、AI呼び出し部分ではない。  
ローカルAI化よりも「コンパイルのキャッシュ活用」「変更があった画像のみ差分コンパイル」の方が体感速度改善に効果が大きい。
