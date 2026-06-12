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
// 物体検出 + 動的精霊名 + キャラ付け (スキャン)
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
          personality: {
            type: 'STRING',
            description: 'その物体の見た目・用途・状態から発想した精霊のキャラ設定（性格・口調・一人称、50文字以内）。例: 目覚まし時計なら「几帳面でせっかち。一人称は私。語尾は〜である。遅刻に厳しい」、空き缶なら「飲み干されて達観している。一人称は俺。気だるい口調」'
          },
          voice: {
            type: 'STRING',
            enum: ['cool_male', 'genki_girl', 'wise_elder', 'gentle_lady'],
            description: 'キャラ設定に合う声質。cool_male=クールな男性声(ガジェット・黒物・スポーティな物向き)、genki_girl=元気なアニメ女声(お菓子・カラフルな物・かわいい物向き)、wise_elder=渋く落ち着いた長老声(本・時計・アンティーク向き)、gentle_lady=おっとり優しい女性声(マグカップ・ぬいぐるみ・植物向き)'
          },
          box: {
            type: 'ARRAY',
            items: { type: 'INTEGER' },
            description: '[ymin, xmin, ymax, xmax] 0〜1000で規格化されたバウンディングボックス'
          }
        },
        required: ['name', 'spiritName', 'personality', 'voice', 'box']
      }
    }
  },
  required: ['targets']
};

const DEMO_VESSELS = [
  { name: 'デモの青い器', spiritName: 'ドリンクの精霊', personality: '飲み干されて達観している。一人称は俺。気だるい口調', voice: 'cool_male' },
  { name: 'デモの赤い器', spiritName: '時の精霊', personality: '几帳面でせっかち。一人称は私。語尾は〜である', voice: 'wise_elder' },
  { name: 'デモの黄色い器', spiritName: 'お菓子の精霊', personality: '甘えん坊でハイテンション。一人称はあたし', voice: 'genki_girl' }
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
      targets: [{ ...demo, box: [200, 200, 800, 800] }]
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
バウンディングボックスを [ymin, xmin, ymax, xmax]（0〜1000の整数規格化座標、左上が[0,0]）で指定し、以下と共にJSONで返してください:
- name: 日本語の名前（15文字以内）
- spiritName: そのモノのカテゴリにふさわしい「◯◯の精霊」形式の精霊名（10文字以内）
- personality: その物体の見た目・用途・状態（汚れ、空っぽ、新品など）から発想したユニークなキャラ設定（性格・口調・一人称、50文字以内）
- voice: キャラに合う声質
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
// 精霊同士のBanter (N体対応)
// ==========================================

function buildBanterPrompt(spirits, newcomer) {
  const cast = spirits.map((s, i) =>
    `【精霊${i} (agent${i})】
- 精霊名: ${s.name || `精霊${i}`}
- 宿っている器: ${s.vessel || '不思議な器'}
- キャラ設定: ${s.personality || '陽気でおしゃべり好き'}`
  ).join('\n\n');

  return `あなたは複数の物体に宿る精霊たちの、テンポの良い掛け合い（会話）を生成する放送作家です。
登場精霊は以下の${spirits.length}体です:

${cast}
${newcomer ? `\n※たった今「${newcomer}」が新しく会話に加わった！みんなで歓迎したりツッコんだりすること。\n` : ''}
これまでの会話履歴を踏まえて、次の発言者（nextSpeaker）と発言内容（reply）を生成してください。
ルール:
1. 発言は必ず短く（1〜2文、35文字以内）。テンポ最優先、間延びした説明口調は禁止。
2. 感情豊かに！感嘆詞（「えっ！？」「おお！」「まったく…」など）や「！」「？」「…」を多用して喜怒哀楽と抑揚をはっきり出す。
3. 各精霊のキャラ設定（性格・口調・一人称）を厳守する。
4. 原則として直前の発言者とは異なる精霊を選び、全員に満遍なく話させる。
5. お互いの器の特徴いじり、ボケとツッコミ、軽い言い合いを歓迎。
6. JSONのみを返却し、前置きや解説は一切出力しない。`;
}

app.post('/api/banter', async (req, res) => {
  const { spirits, history, newcomer } = req.body;

  if (!spirits || !Array.isArray(spirits) || spirits.length < 2) {
    return res.status(400).json({ error: 'At least 2 spirits are required' });
  }

  const agentIds = spirits.map((_, i) => `agent${i}`);

  if (!hasApiKey) {
    const turn = history ? history.length : 0;
    const speaker = turn % spirits.length;
    const demoLines = [
      `おっ、${spirits[(speaker + 1) % spirits.length].name}じゃないか！元気か？`,
      `えっ！？急に話しかけるなよ…びっくりするだろ`,
      `あはは！みんな賑やかだなあ！`
    ];
    return res.json({ demo: true, nextSpeaker: agentIds[speaker], reply: demoLines[turn % demoLines.length] });
  }

  try {
    const systemPrompt = buildBanterPrompt(spirits, newcomer);

    let conversation = 'これまでの会話履歴:\n';
    if (history && history.length > 0) {
      history.forEach(h => {
        // 新形式は {name, text}。旧形式 {sender:'agentN'} もフォールバックで対応
        let name = h.name;
        if (!name && h.sender != null) {
          const idx = parseInt(String(h.sender).replace('agent', ''), 10);
          name = (spirits[idx] && spirits[idx].name) || h.sender;
        }
        conversation += `${name || '精霊'}: ${h.text}\n`;
      });
    } else {
      conversation += '(履歴なし。誰かが勢いよく会話の口火を切ること。)\n';
    }
    conversation += '\n次の会話のターン（発言者とセリフ）を生成してください。';

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + conversation }] }],
      config: {
        temperature: 1.0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            nextSpeaker: {
              type: 'STRING',
              enum: agentIds,
              description: '次に発言する精霊のID'
            },
            reply: {
              type: 'STRING',
              description: '発言内容。感情豊かで短い日本語のセリフ（1〜2文、最大35文字）'
            }
          },
          required: ['nextSpeaker', 'reply']
        }
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
// ElevenLabs TTS (精霊の声 / キャラ別ボイス)
// ==========================================

const ELEVENLABS_VOICES = {
  cool_male: 'Mv8AjrYZCBkdsmDHNwcB',   // Ishibashi: クールな日本語男性
  genki_girl: 'fUjY9K2nAIwlALOwSiwc',  // Yui: 元気な日本語アニメ声
  wise_elder: 'onwK4e9ZLuTAKqWW03F9',  // Daniel: 渋く落ち着いた低音
  gentle_lady: 'EXAVITQu4vr4xnSDxMaL'  // Sarah: おっとり柔らかい女性
};

const hasTtsKey = !!process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here';

app.get('/api/tts', async (req, res) => {
  const { text, voice } = req.query;

  if (!text) {
    return res.status(400).json({ error: 'Text query parameter is required' });
  }
  if (!hasTtsKey) {
    return res.status(503).json({ error: 'ELEVENLABS_API_KEY is not configured.' });
  }

  const voiceId = ELEVENLABS_VOICES[voice] || ELEVENLABS_VOICES.cool_male;

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
          stability: 0.35,        // 低め = 感情表現・抑揚が豊かになる
          similarity_boost: 0.8,
          style: 0.6,             // スタイル誇張で演技がかった話し方に
          use_speaker_boost: true,
          speed: 1.1              // テンポアップ
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
