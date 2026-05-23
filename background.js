/**
 * background.js — Service Worker para YT Sponsor Skip
 * Maneja las llamadas a la API de Groq para detección de sponsors.
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Eres un detector de segmentos de publicidad y sponsors en transcripciones de videos de YouTube.
Analiza la transcripción proporcionada y detecta TODOS los segmentos donde el creador promociona
un producto, servicio, marca, o patrocinador (sponsors, publicidad integrada, menciones patrocinadas).

Devuelve ÚNICAMENTE un JSON válido con este formato exacto, sin texto adicional, sin markdown:
{
  "sponsors": [
    {
      "start": 142.5,
      "end": 210.0,
      "brand": "nombre de la marca o producto",
      "confidence": 0.95,
      "reason": "breve razón de por qué es un sponsor"
    }
  ],
  "has_sponsors": true
}

Reglas estrictas:
- Los timestamps DEBEN ser números decimales en segundos, tomados exactamente de la transcripción.
- El "start" debe ser el segundo donde EMPIEZA el discurso del sponsor.
- El "end" debe ser el segundo donde TERMINA completamente el sponsor y vuelve el contenido normal.
- Si no detectas sponsors, devuelve: {"sponsors": [], "has_sponsors": false}
- NO inventes timestamps. Solo usa los que aparecen en la transcripción.
- La "confidence" es un número entre 0 y 1 indicando qué tan seguro estás.
- Solo incluye segmentos con confidence >= 0.7`;

function validateSponsors(sponsors, transcript) {
  if (!Array.isArray(sponsors)) return [];
  return sponsors.filter(sponsor => {
    if (typeof sponsor.start !== 'number' || typeof sponsor.end !== 'number') return false;
    if (sponsor.start < 0 || sponsor.end <= sponsor.start) return false;
    if (sponsor.end - sponsor.start < 10) return false;
    if (sponsor.end - sponsor.start > 600) return false;
    const transcriptTimes = transcript.map(t => t.time);
    if (!transcriptTimes.some(t => Math.abs(t - sponsor.start) <= 16)) return false;
    if (!transcriptTimes.some(t => Math.abs(t - sponsor.end) <= 16)) return false;
    if (typeof sponsor.confidence !== 'number' || sponsor.confidence < 0.7) return false;
    return true;
  });
}

async function analyzeTranscript(apiKey, transcriptText, transcript) {
  try {
    const startTime = Date.now();
    console.log('[YT-Skip BG] Enviando request a Groq API...');

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcriptText }
        ],
        temperature: 0.3,
        max_completion_tokens: 4096,
        top_p: 1,
        stream: false
      })
    });

    const elapsed = Date.now() - startTime;
    console.log(`[YT-Skip BG] Groq respondió en ${elapsed}ms (status: ${response.status})`);

    // Rate limit headers
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining-requests');
    const rateLimitReset = response.headers.get('x-ratelimit-reset-requests');
    if (rateLimitRemaining !== null) {
      console.log(`[YT-Skip BG] Rate limit: ${rateLimitRemaining} requests restantes, reset en ${rateLimitReset}`);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}`;

      if (response.status === 401) {
        throw new Error('API key inválida. Verifica tu clave de Groq en la configuración.');
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitSec = retryAfter ? parseInt(retryAfter) : 10;
        console.warn(`[YT-Skip BG] Rate limit 429. retry-after: ${retryAfter}s, requests restantes: ${rateLimitRemaining}`);
        throw new Error(`Límite de rate alcanzado (429). Espera ${waitSec}s e intenta de nuevo. Requests restantes: ${rateLimitRemaining || 'N/A'}`);
      }
      if (response.status === 503) {
        throw new Error('Servicio de Groq no disponible temporalmente (503). Intenta de nuevo más tarde.');
      }
      if (response.status === 400) {
        throw new Error(`Request inválido a Groq: ${errorMessage}`);
      }
      if (response.status === 529) {
        throw new Error('Groq está sobrecargado (529). Intenta de nuevo en unos minutos.');
      }

      throw new Error(`Error de Groq API (${response.status}): ${errorMessage}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const usage = data.usage;

    if (usage) {
      console.log(`[YT-Skip BG] Tokens usados - prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
    }

    if (!content) throw new Error('Respuesta vacía de Groq API.');

    let parsed;
    try {
      let cleanContent = content.trim();
      if (cleanContent.startsWith('```json')) cleanContent = cleanContent.slice(7);
      if (cleanContent.startsWith('```')) cleanContent = cleanContent.slice(3);
      if (cleanContent.endsWith('```')) cleanContent = cleanContent.slice(0, -3);
      cleanContent = cleanContent.trim();
      parsed = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('[YT-Skip BG] Error parseando respuesta:', content.substring(0, 200));
      throw new Error('No se pudo interpretar la respuesta de la IA. Intenta de nuevo.');
    }

    if (!parsed || typeof parsed.has_sponsors !== 'boolean') {
      throw new Error('Respuesta de la IA con formato inesperado.');
    }

    const validatedSponsors = validateSponsors(parsed.sponsors || [], transcript);
    const discardedCount = (parsed.sponsors?.length || 0) - validatedSponsors.length;

    if (discardedCount > 0) {
      console.warn(`[YT-Skip BG] ${discardedCount} sponsors descartados por validación`);
    }

    return {
      sponsors: validatedSponsors,
      has_sponsors: validatedSponsors.length > 0
    };
  } catch (error) {
    console.error('[YT-Skip BG] Error en analyzeTranscript:', error.message);
    throw error;
  }
}

async function testGroqConnection(apiKey) {
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: 'Responde solo: OK' }],
        max_completion_tokens: 10,
        temperature: 0
      })
    });

    if (response.ok) return { success: true, message: 'Conexión exitosa con Groq API ✓' };
    if (response.status === 401) return { success: false, message: 'API key inválida' };
    if (response.status === 429) return { success: true, message: 'API key válida (rate limit alcanzado, pero la key es correcta)' };

    const errorData = await response.json().catch(() => ({}));
    return { success: false, message: `Error: ${errorData.error?.message || response.status}` };
  } catch (error) {
    return { success: false, message: `Error de conexión: ${error.message}` };
  }
}

// Escuchar mensajes
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyzeTranscript') {
    const { apiKey, transcriptText, transcript } = message;
    analyzeTranscript(apiKey, transcriptText, transcript)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'testGroqConnection') {
    testGroqConnection(message.apiKey).then(result => sendResponse(result));
    return true;
  }

  if (message.action === 'getLogs') {
    browserAPI.storage.local.get('ytSkipLogs').then(result => {
      sendResponse({ logs: result.ytSkipLogs || [] });
    });
    return true;
  }

  if (message.action === 'clearLogs') {
    browserAPI.storage.local.remove('ytSkipLogs').then(() => sendResponse({ success: true }));
    return true;
  }

  return false;
});
