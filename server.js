const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

dotenv.config({ override: true, quiet: true });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const hasApiKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';
const ai = hasApiKey ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

if (!hasApiKey) {
  console.warn('GEMINI_API_KEY が未設定のため、デモモード（固定レスポンス）で起動します。');
}

function parseJSONSafe(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.substring(start, end + 1));
    }
    throw e;
  }
}

// ==========================================
// 物体検出 + 動的精霊名 (スキャンフェーズ)
// ==========================================

const segmentResponseSchema = {
  type: 'OBJECT',
  properties: {
    targets: {
      type: 'ARRAY',
      description: '画像内で最も代表的な対象物（最大1つ）。適切な対象物がなければ空配列。',
      items: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description: '対象物の短い日本語名（15文字以内、例: 「青い空き缶」「目覚まし時計」）'
          },
          spiritName: {
            type: 'STRING',
            description: '対象物のカテゴリを表す「◯◯の精霊」形式の精霊名（日本語、10文字以内）。例: 時計なら「時の精霊」、缶・ボトルなら「ドリンクの精霊」、本・ノートなら「知恵の精霊」、コップ・グラスなら「器の精霊」、キーボードなら「タイピングの精霊」。リストにない物体はその本質を捉えた名前を考案する。'
          },
          box: {
            type: 'ARRAY',
            items: { type: 'INTEGER' },
            description: '[ymin, xmin, ymax, xmax] 0〜1000で規格化されたバウンディングボックス'
          }
        },
        required: ['name', 'spiritName', 'box']
      }
    }
  },
  required: ['targets']
};

const DEMO_VESSELS = [
  { name: 'デモの青い器', spiritName: 'ドリンクの精霊' },
  { name: 'デモの赤い器', spiritName: '時の精霊' }
];
let demoSegmentCount = 0;

app.post('/api/segment-vessels', async (req, res) => {
  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'Image data is required' });
  }

  if (!hasApiKey) {
    const demo = DEMO_VESSELS[demoSegmentCount++ % DEMO_VESSELS.length];
    return res.json({
      demo: true,
      targets: [{ name: demo.name, spiritName: demo.spiritName, box: [200, 200, 800, 800] }]
    });
  }

  try {
    const base64Data = image.split(',')[1] || image;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: base64Data, mimeType: 'image/jpeg' } },
            {
              text: `画像の中から、ARターゲット（ロゴ、ラベル、または主要な立体物）として認識・追跡するのに最も適した代表的な対象物を1つだけ検出してください。
バウンディングボックスを [ymin, xmin, ymax, xmax]（0〜1000の整数規格化座標、左上が[0,0]）で指定し、日本語の名前（15文字以内）と、そのモノのカテゴリにふさわしい「◯◯の精霊」形式の精霊名（10文字以内）と共にJSONで返してください。
明確な対象物が写っていない場合は targets を空配列にしてください。`
            }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: segmentResponseSchema
      }
    });

    const data = parseJSONSafe(response.text);
    console.log('Detected:', JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error('Error segmenting image:', error.message);
    res.status(500).json({ error: 'Failed to segment image' });
  }
});

// ==========================================
// 精霊同士のBanter (AR会話フェーズ)
// ==========================================

const banterResponseSchema = {
  type: 'OBJECT',
  properties: {
    nextSpeaker: {
      type: 'STRING',
      enum: ['agent0', 'agent1'],
      description: '次に発言するエージェントのID'
    },
    reply: {
      type: 'STRING',
      description: '発言内容。短く自然な日本語のセリフ（1〜2文、最大35文字）'
    }
  },
  required: ['nextSpeaker', 'reply']
};

const BANTER_SYSTEM_PROMPT = `
あなたは2つの物体の器に宿る精霊同士の掛け合い（会話）を生成するディレクターです。
登場人物は以下の2人です：

【精霊0 (agent0)】
- 属性: {spirit0}、クール、やれやれ系（だるそうだが話し好き）
- 口調: 「〜だぜ」「〜だよな」など、少し投げやりでラフな感じ
- 一人称: 「俺」
- 現在宿っている器: {vessel0}

【精霊1 (agent1)】
- 属性: {spirit1}、元気、熱血、フレンドリー、お調子者
- 口調: 「〜だぞ！」「〜だな！」など、活発でテンションが高い感じ
- 一人称: 「オイラ」
- 現在宿っている器: {vessel1}

これまでの会話履歴を踏まえて、次の発言者（nextSpeaker）と発言内容（reply）を生成してください。
制約事項：
1. 発言は必ず短く（1〜2文、35文字以内）、感情豊かに。
2. お互いの精霊の属性や器（{vessel0} と {vessel1}）の特徴に言及したりツッコミを入れると面白い。（例: ドリンクの精霊なら「飲み干されて空っぽだぜ」、時の精霊なら「時間を刻むのに忙しいんだぞ！」）
3. 原則として直前の発言者とは異なるエージェントを選び、交互に会話を成立させる。
4. JSONのみを返却し、前置きや解説は一切出力しない。
`;

function demoBanterLine(spirit0, spirit1, turn) {
  const lines = [
    { nextSpeaker: 'agent0', reply: `俺は${spirit0}。まあ、よろしく頼むぜ` },
    { nextSpeaker: 'agent1', reply: `オイラは${spirit1}だぞ！会えて嬉しいな！` },
    { nextSpeaker: 'agent0', reply: 'お前、朝からテンション高すぎだろ…' },
    { nextSpeaker: 'agent1', reply: 'そっちはダルそうすぎるぞ！シャキッとしろ！' },
    { nextSpeaker: 'agent0', reply: 'この器、なかなか居心地がいいんだぜ' },
    { nextSpeaker: 'agent1', reply: 'オイラの器のほうがカッコいいぞ！' }
  ];
  return lines[turn % lines.length];
}

app.post('/api/banter', async (req, res) => {
  const { vessel0, vessel1, spirit0, spirit1, history } = req.body;

  if (!hasApiKey) {
    const turn = history ? history.length : 0;
    return res.json({ demo: true, ...demoBanterLine(spirit0 || '青の精霊', spirit1 || '赤の精霊', turn) });
  }

  try {
    const systemPrompt = BANTER_SYSTEM_PROMPT
      .replace(/{vessel0}/g, vessel0 || '不思議な器')
      .replace(/{vessel1}/g, vessel1 || '不思議な器')
      .replace(/{spirit0}/g, spirit0 || '青の精霊')
      .replace(/{spirit1}/g, spirit1 || '赤の精霊');

    let conversation = 'これまでの会話履歴:\n';
    if (history && history.length > 0) {
      history.forEach(h => {
        const name = h.sender === 'agent0' ? '精霊0' : '精霊1';
        conversation += `${name}: ${h.text}\n`;
      });
    } else {
      conversation += '(履歴なし。会話を開始してください。)\n';
    }
    conversation += '\n次の会話のターン（発言者とセリフ）を生成してください。';

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + conversation }] }],
      config: {
        temperature: 0.9,
        responseMimeType: 'application/json',
        responseSchema: banterResponseSchema
      }
    });

    const data = parseJSONSafe(response.text);
    console.log('Banter:', JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error('Error generating banter:', error.message);
    res.status(500).json({ error: 'Failed to generate banter' });
  }
});

// ==========================================
// ElevenLabs TTS (精霊の声)
// ==========================================

const ELEVENLABS_VOICES = {
  agent0: 'Mv8AjrYZCBkdsmDHNwcB', // 青/クール: Ishibashi (日本語男性)
  agent1: 'fUjY9K2nAIwlALOwSiwc'  // 赤/元気: Yui (日本語アニメ声)
};

const hasTtsKey = !!process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here';

app.get('/api/tts', async (req, res) => {
  const { text, agentId } = req.query;

  if (!text) {
    return res.status(400).json({ error: 'Text query parameter is required' });
  }
  if (!hasTtsKey) {
    return res.status(503).json({ error: 'ELEVENLABS_API_KEY is not configured.' });
  }

  const voiceId = (agentId === '1') ? ELEVENLABS_VOICES.agent1 : ELEVENLABS_VOICES.agent0;

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('ElevenLabs API failure:', errText);
      return res.status(response.status).json({ error: `ElevenLabs API failed: ${errText}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    const { Readable } = require('stream');
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error('Error generating ElevenLabs TTS:', error);
    res.status(500).json({ error: 'Failed to generate TTS' });
  }
});

// ローカル実行時のみlisten (Vercelではapi/index.js経由のサーバーレス関数として動く)
if (require.main === module) {
  app.listen(port, () => {
    console.log(`AR Agents 2 prototype running at http://localhost:${port}`);
    console.log(`Mode: ${hasApiKey ? 'Gemini API' : 'DEMO (no API key)'}`);
  });
}

module.exports = app;
