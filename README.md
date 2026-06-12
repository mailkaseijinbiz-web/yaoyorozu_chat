# AR Agents 2 — 精霊召喚プロトタイプ

身の回りのモノをスキャンして精霊を宿らせ、AR空間で精霊同士を会話させるプロトタイプ。

## フロー

1. **起動** — 背面カメラが立ち上がり、1つ目の器（青の魂）のスキャンが自動で始まる
2. **凝視注入** — 対象を枠に収めてカメラを固定すると注入ゲージが溜まり、3秒（100%）で自動注入 → 画面が白くフラッシュ。カメラをそらすとゲージは即0%にリセット
3. **自動遷移** — 1つ目の注入後、そのまま2つ目（赤の魂）のスキャンへ。2つ目が完了すると自動でMindARコンパイル → ARシーンへ
4. **AR会話** — 器をカメラに写すと頭上に吹き出しが出現。「💬 精霊たちを会話させる」を押すと精霊たちがElevenLabsの音声で交互にしゃべり続ける（カメラが外れても会話は継続）
5. **リセット** — 「🔄 最初からやり直す」でいつでもスロット0から再スタート

精霊名は Gemini の画像認識でカテゴリから自動命名される（時計→時の精霊、缶→ドリンクの精霊、本→知恵の精霊 など）。

## セットアップ

```bash
npm install
cp .env.example .env   # GEMINI_API_KEY を設定
npm start
```

http://localhost:3000 を開く。

- `GEMINI_API_KEY` 未設定の場合は**デモモード**（固定の精霊名・固定セリフ）で動作する
- `ELEVENLABS_API_KEY` 未設定の場合は音声なし（テキストのみ）で会話が進む
- スマホで試す場合はカメラAPIの制約上 **HTTPS が必須**。`npx cloudflared tunnel --url http://localhost:3000` や ngrok などでトンネルを張る

## 構成

| ファイル | 役割 |
|---|---|
| `server.js` | Express + Gemini API（物体検出/動的精霊名 `/api/segment-vessels`、会話生成 `/api/banter`、ElevenLabs音声 `/api/tts`） |
| `public/app.js` | スキャン→凝視ゲージ→自動注入→MindARランタイムコンパイル→ARシーン→Banterループ |
| `public/index.html` | A-Frame 1.5.0 + MindAR 1.2.5 (CDN) |

## チューニング

`public/app.js` 冒頭の定数で調整可能:

- `GAZE_DURATION` — 凝視で注入完了までの時間（既定 3000ms）
- `SCAN_INTERVAL` — AIスキャンの間隔（既定 900ms）
- `MOTION_THRESHOLD` — カメラぶれ（視線逸らし）判定の感度。下げるほど敏感
