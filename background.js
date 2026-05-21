/**
 * background.js — Service Worker para YT Sponsor Skip
 * Maneja las llamadas a la API de Groq para detección de sponsors.
 */

// Compatibilidad Firefox/Chrome
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

/**
 * Valida los timestamps de los sponsors detectados
 * @param {Array} sponsors - Array de objetos sponsor con start, end, brand, confidence, reason
 * @param {Array} transcript - Array de objetos {time, text} de la transcripción original
 * @returns {Array} - Sponsors validados
 */
function validateSponsors(sponsors, transcript) {
  if (!Array.isArray(sponsors)) return [];

  return sponsors.filter(sponsor => {
    // Verificar campos requeridos
    if (typeof sponsor.start !== 'number' || typeof sponsor.end !== 'number') {
      console.warn('[YT-Skip] Sponsor descartado: timestamps inválidos', sponsor);
      return false;
    }

    // start >= 0 y end > start
    if (sponsor.start < 0 || sponsor.end <= sponsor.start) {
      console.warn('[YT-Skip] Sponsor descartado: rango inválido', sponsor);
      return false;
    }

    // Duración mínima 10 segundos
    if (sponsor.end - sponsor.start < 10) {
      console.warn('[YT-Skip] Sponsor descartado: duración menor a 10s', sponsor);
      return false;
    }

    // Duración máxima 600 segundos (10 minutos)
    if (sponsor.end - sponsor.start > 600) {
      console.warn('[YT-Skip] Sponsor descartado: duración mayor a 600s', sponsor);
      return false;
    }

    // Verificar que los timestamps existen en la transcripción (±5 segundos de tolerancia)
    const transcriptTimes = transcript.map(t => t.time);
    const startNear = transcriptTimes.some(t => Math.abs(t - sponsor.start) <= 5);
    const endNear = transcriptTimes.some(t => Math.abs(t - sponsor.end) <= 5);

    if (!startNear || !endNear) {
      console.warn('[YT-Skip] Sponsor descartado: timestamps no encontrados en transcripción', sponsor);
      return false;
    }

    // Confidence >= 0.7
    if (typeof sponsor.confidence !== 'number' || sponsor.confidence < 0.7) {
      console.warn('[YT-Skip] Sponsor descartado: confidence insuficiente', sponsor);
      return false;
    }

    return true;
  });
}

/**
 * Llama a la API de Groq para analizar la transcripción
 * @param {string} apiKey - API key de Groq
 * @param {string} transcriptText - Transcripción en formato "tiempo|texto\n..."
 * @param {Array} transcript - Array de objetos {time, text} para validación
 * @returns {Object} - Resultado del análisis {sponsors, has_sponsors}
 */
async function analyzeTranscript(apiKey, transcriptText, transcript) {
  try {
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

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}`;

      if (response.status === 401) {
        throw new Error('API key inválida. Verifica tu clave de Groq en la configuración.');
      }
      if (response.status === 429) {
        throw new Error('Límite de rate alcanzado. Espera unos segundos e intenta de nuevo.');
      }
      if (response.status === 503) {
        throw new Error('Servicio de Groq no disponible temporalmente. Intenta de nuevo más tarde.');
      }

      throw new Error(`Error de Groq API: ${errorMessage}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Respuesta vacía de Groq API.');
    }

    // Intentar parsear el JSON de la respuesta
    let parsed;
    try {
      // Limpiar posible markdown code blocks
      let cleanContent = content.trim();
      if (cleanContent.startsWith('```json')) {
        cleanContent = cleanContent.slice(7);
      }
      if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.slice(3);
      }
      if (cleanContent.endsWith('```')) {
        cleanContent = cleanContent.slice(0, -3);
      }
      cleanContent = cleanContent.trim();

      parsed = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('[YT-Skip] Error parseando respuesta de Groq:', content);
      throw new Error('No se pudo interpretar la respuesta de la IA. Intenta de nuevo.');
    }

    // Validar estructura
    if (!parsed || typeof parsed.has_sponsors !== 'boolean') {
      throw new Error('Respuesta de la IA con formato inesperado.');
    }

    // Validar sponsors
    const validatedSponsors = validateSponsors(parsed.sponsors || [], transcript);

    return {
      sponsors: validatedSponsors,
      has_sponsors: validatedSponsors.length > 0
    };
  } catch (error) {
    console.error('[YT-Skip] Error en analyzeTranscript:', error);
    throw error;
  }
}

/**
 * Prueba la conexión con la API de Groq
 * @param {string} apiKey - API key de Groq
 * @returns {Object} - {success: boolean, message: string}
 */
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
        messages: [
          { role: 'user', content: 'Responde solo: OK' }
        ],
        max_completion_tokens: 10,
        temperature: 0
      })
    });

    if (response.ok) {
      return { success: true, message: 'Conexión exitosa con Groq API ✓' };
    }

    if (response.status === 401) {
      return { success: false, message: 'API key inválida' };
    }
    if (response.status === 429) {
      return { success: true, message: 'API key válida (rate limit alcanzado, pero la key es correcta)' };
    }

    const errorData = await response.json().catch(() => ({}));
    return {
      success: false,
      message: `Error: ${errorData.error?.message || response.status}`
    };
  } catch (error) {
    return { success: false, message: `Error de conexión: ${error.message}` };
  }
}

// Escuchar mensajes del content script
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyzeTranscript') {
    const { apiKey, transcriptText, transcript } = message;

    analyzeTranscript(apiKey, transcriptText, transcript)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));

    return true; // Indica que sendResponse será llamado async
  }

  if (message.action === 'testGroqConnection') {
    const { apiKey } = message;

    testGroqConnection(apiKey)
      .then(result => sendResponse(result));

    return true;
  }

  return false;
});
