// ═══════════════════════════════════════════════════════════════════
//  AudioSpire Workforce™ — Render Backend
//  Handles: AI (Ollama/Claude), OpenAI TTS, ElevenLabs TTS, AWeber
// ═══════════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));                        // Allow requests from your HTML file
app.use(express.json({ limit: '2mb' })); // Parse JSON bodies

// ── Health check — visit your Render URL to confirm it's alive ────
app.get('/', (req, res) => {
  res.json({ status: 'AudioSpire Workforce Backend — Online ✓' });
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 1: /ai
//  Proxies to Ollama (local) or Anthropic Claude (cloud fallback)
//  The dashboard sends: { system, messages, model, max_tokens }
//  We forward to Anthropic streaming SSE and pipe it back.
// ═══════════════════════════════════════════════════════════════════
app.post('/ai', async (req, res) => {
  const { system, messages, model, max_tokens } = req.body;
console.log('AI request received:', model, 'messages:', messages?.length);
  
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Set headers for Server-Sent Events streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'messages-2023-12-15'
      },
      body: JSON.stringify({
        model:      model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 900,
        system:     system || '',
        stream:     true,
        messages:   messages.filter(m => m.role !== 'system')
      })
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error('Anthropic error:', upstream.status, err);
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      return res.end();
    }
    console.log('Anthropic request success, streaming...');

    // Pipe the upstream SSE stream straight to the client
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
//  ROUTE 2: /tts
//  OpenAI Text-to-Speech — returns raw audio bytes (mp3)
//  Dashboard sends: { text, voice, model }
// ═══════════════════════════════════════════════════════════════════
app.post('/tts', async (req, res) => {
  const { text, voice = 'nova', model = 'tts-1' } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Trim to 4000 chars — OpenAI TTS limit is 4096 chars
  const trimmed = text.trim().slice(0, 4000);

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        voice,
        input: trimmed,
        response_format: 'mp3'
      })
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
//  ROUTE 3: /tts-elevenlabs
//  ElevenLabs Text-to-Speech — returns raw audio bytes (mp3)
//  Dashboard sends: { text, voice_id }
// ═══════════════════════════════════════════════════════════════════
app.post('/tts-elevenlabs', async (req, res) => {
  const { text, voice_id } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!voice_id) {
    return res.status(400).json({ error: 'voice_id is required' });
  }

  const trimmed = text.trim().slice(0, 5000); // ElevenLabs limit varies by plan

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
          model_id: 'eleven_turbo_v2_5',   // Fast, high quality — change to eleven_multilingual_v2 if preferred
          voice_settings: {
            stability:        0.45,   // Lower = more expressive
            similarity_boost: 0.82,   // Higher = closer to original voice
            style:            0.35,   // Style exaggeration (0–1)
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
//  ROUTE 4: /aweber/send
//  Sends a broadcast email via the AWeber API
//  Dashboard sends: { subject, body, from_name, list_id }
// ═══════════════════════════════════════════════════════════════════
app.post('/aweber/send', async (req, res) => {
  const { subject, body, from_name = 'Leigh Spusta', list_id } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }

  // AWeber uses OAuth2 — we use a pre-authorized access token stored in env vars.
  // See SETUP_GUIDE.md for how to get this token (one-time process).
  const accessToken = process.env.AWEBER_ACCESS_TOKEN;
  const accountId   = process.env.AWEBER_ACCOUNT_ID;
  const listIdToUse = list_id || process.env.AWEBER_DEFAULT_LIST_ID;

  if (!accessToken || !accountId || !listIdToUse) {
    return res.status(500).json({
      error: 'AWeber not configured — set AWEBER_ACCESS_TOKEN, AWEBER_ACCOUNT_ID, AWEBER_DEFAULT_LIST_ID in Render env vars'
    });
  }

  try {
    // Step 1: Create the broadcast
    const createRes = await fetch(
      `https://api.aweber.com/1.0/accounts/${accountId}/lists/${listIdToUse}/broadcasts`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          subject,
          html_body:  body.replace(/\n/g, '<br>'),
          plain_text: body,
          from_name
        })
      }
    );

    if (!createRes.ok) {
      console.error('AWeber create failed, status:', createRes.status);
      const err = await createRes.json().catch(() => ({}));
      // Check if token needs refresh
      if (createRes.status === 401) {
        const body401 = await createRes.text();
        console.error('AWeber 401 body:', body401);
        return res.status(401).json({
          error: 'AWeber token expired — re-run the token refresh script (see SETUP_GUIDE.md)'
        });
      }
      return res.status(createRes.status).json({ error: err.error_description || 'AWeber create error' });
    }

    const broadcast = await createRes.json();
    const broadcastId = broadcast.id;

    // Step 2: Schedule the broadcast to send immediately
    const scheduleRes = await fetch(
      `https://api.aweber.com/1.0/accounts/${accountId}/lists/${listIdToUse}/broadcasts/${broadcastId}/schedule`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ scheduled_for: 'now' })
      }
    );

    if (!scheduleRes.ok) {
      const err = await scheduleRes.json().catch(() => ({}));
      return res.status(scheduleRes.status).json({ error: err.error_description || 'AWeber schedule error' });
    }

    res.json({
      success:      true,
      broadcast_id: broadcastId,
      message:      `Broadcast "${subject}" scheduled successfully`
    });

  } catch (err) {
    console.error('/aweber/send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 5: /aweber/refresh-token
//  Call this once whenever your AWeber access token expires (~1 hour)
//  It uses the refresh token to get a new access token automatically.
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

    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}));
      return res.status(tokenRes.status).json({ error: err.error_description || 'Token refresh failed' });
    }

    const tokens = await tokenRes.json();
    // NOTE: In production you would persist the new access_token to your DB or
    // update Render env vars via the Render API. For now we return it so you can
    // manually copy it into your Render dashboard.
    res.json({
      success:       true,
      access_token:  tokens.access_token,
      expires_in:    tokens.expires_in,
      note: 'Copy access_token into AWEBER_ACCESS_TOKEN in your Render environment variables'
    });

  } catch (err) {
    console.error('/aweber/refresh-token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AudioSpire Workforce Backend running on port ${PORT}`);
});
