// ═══════════════════════════════════════════════════════════════════
//  AudioSpire Workforce™ — Render Backend
//  Handles: AI (Claude), OpenAI TTS, ElevenLabs TTS, AWeber
// ═══════════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AudioSpire Workforce Backend — Online ✓' });
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 1: /ai  — Anthropic Claude streaming
// ═══════════════════════════════════════════════════════════════════
app.post('/ai', async (req, res) => {
  const { system, messages, model, max_tokens } = req.body;
  console.log('AI request received:', model, 'messages:', messages?.length);

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const cleanMessages = messages.filter(m => m.role !== 'system');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 900,
        system:     system || '',
        stream:     true,
        messages:   cleanMessages
      })
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error('Anthropic error:', upstream.status, err);
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      return res.end();
    }

    console.log('Anthropic request success, streaming...');
    upstream.body.on('data', chunk => res.write(chunk));
    upstream.body.on('end',  ()    => res.end());
    upstream.body.on('error', e    => { console.error('AI stream error:', e); res.end(); });

  } catch (err) {
    console.error('/ai error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 2: /tts  — OpenAI Text-to-Speech
// ═══════════════════════════════════════════════════════════════════
app.post('/tts', async (req, res) => {
  const { text, voice = 'nova', model = 'tts-1' } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const trimmed = text.trim().slice(0, 4000);

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model, voice, input: trimmed, response_format: 'mp3' })
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: err.error?.message || 'OpenAI TTS error' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    upstream.body.pipe(res);

  } catch (err) {
    console.error('/tts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 3: /tts-elevenlabs  — ElevenLabs Text-to-Speech
// ═══════════════════════════════════════════════════════════════════
app.post('/tts-elevenlabs', async (req, res) => {
  const { text, voice_id } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!voice_id) {
    return res.status(400).json({ error: 'voice_id is required' });
  }

  const trimmed = text.trim().slice(0, 5000);

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key':   process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability:         0.45,
            similarity_boost:  0.82,
            style:             0.35,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: err.detail?.message || 'ElevenLabs TTS error' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    upstream.body.pipe(res);

  } catch (err) {
    console.error('/tts-elevenlabs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 4: /aweber/send  — Send broadcast email via AWeber API
//  AWeber API — uses OAuth2 Bearer token
// ═══════════════════════════════════════════════════════════════════
app.post('/aweber/send', async (req, res) => {
  const { subject, body, from_name = 'Leigh Spusta', list_id } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }

  const accountId   = process.env.AWEBER_ACCOUNT_ID;
  const listIdToUse = list_id || process.env.AWEBER_DEFAULT_LIST_ID;
  const accessToken = process.env.AWEBER_ACCESS_TOKEN;

  console.log('AWeber send — list:', listIdToUse, 'subject:', subject);

  try {
    const createUrl = `https://api.aweber.com/1.0/accounts/${accountId}/lists/${listIdToUse}/broadcasts`;

    const createParams = new URLSearchParams({
      subject,
      html_body:  body.replace(/\n/g, '<br>'),
      plain_text: body,
      from_name
    });

    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`
      },
      body: createParams.toString()
    });

    const createText = await createRes.text();
    console.log('AWeber create status:', createRes.status, 'body:', createText);

    if (!createRes.ok) {
      let errObj = {};
      try { errObj = JSON.parse(createText); } catch(_) {}
      return res.status(createRes.status).json({ error: errObj.error?.message || errObj.error_description || createText || 'AWeber create error' });
    }

    const broadcast = JSON.parse(createText);
    const broadcastId = broadcast.id || broadcast.broadcast_id;
    console.log('Broadcast created, id:', broadcastId);

    const scheduleUrl = `https://api.aweber.com/1.0/accounts/${accountId}/lists/${listIdToUse}/broadcasts/${broadcastId}/schedule`;

    const scheduleRes = await fetch(scheduleUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`
      },
      body: new URLSearchParams({ scheduled_for: 'now' }).toString()
    });

    const scheduleText = await scheduleRes.text();
    console.log('AWeber schedule status:', scheduleRes.status, 'body:', scheduleText);

    if (!scheduleRes.ok) {
      let errObj = {};
      try { errObj = JSON.parse(scheduleText); } catch(_) {}
      return res.status(scheduleRes.status).json({ error: errObj.error?.message || errObj.error_description || scheduleText || 'AWeber schedule error' });
    }

    res.json({ success: true, broadcast_id: broadcastId, message: `Broadcast "${subject}" sent successfully` });

  } catch (err) {
    console.error('/aweber/send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ═══════════════════════════════════════════════════════════════════
//  ROUTE 5: /aweber/refresh-token  — Refresh AWeber OAuth token
// ═══════════════════════════════════════════════════════════════════
app.post('/aweber/refresh-token', async (req, res) => {
  try {
    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.AWEBER_REFRESH_TOKEN,
      client_id:     process.env.AWEBER_CLIENT_ID,
      client_secret: process.env.AWEBER_CLIENT_SECRET
    });

    const tokenRes = await fetch('https://auth.aweber.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.status(tokenRes.status).json({ error: tokens.error_description || 'Token refresh failed' });
    }

    res.json({
      success:      true,
      access_token: tokens.access_token,
      expires_in:   tokens.expires_in,
      note: 'Copy access_token into AWEBER_ACCESS_TOKEN in your Render environment variables'
    });

  } catch (err) {
    console.error('/aweber/refresh-token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`AudioSpire Workforce Backend running on port ${PORT}`);
});
