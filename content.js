/**
 * content.js — Inyectado en YouTube: DOM, transcripción, botón Skip Sponsor
 */

// Compatibilidad Firefox/Chrome
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Estado global del content script
const state = {
  videoId: null,
  transcript: [],
  sponsors: [],
  isAnalyzing: false,
  monitorInterval: null,
  skipButton: null,
  confirmationPanel: null,
  transcriptPanel: null,
  currentSponsorIndex: -1,
  observer: null,
  urlObserver: null
};

// ============================================================
// UTILIDADES
// ============================================================

/**
 * Extrae el videoId de la URL actual de YouTube
 */
function getVideoId() {
  const url = new URL(window.location.href);
  return url.searchParams.get('v') || null;
}

/**
 * Formatea segundos a formato MM:SS o H:MM:SS
 */
function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Parsea un timestamp en formato MM:SS o H:MM:SS a segundos
 */
function parseTimeInput(timeStr) {
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Muestra un toast temporal en la página
 */
function showToast(message, duration = 3000) {
  // Remover toast existente
  const existingToast = document.getElementById('yt-skip-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.id = 'yt-skip-toast';
  toast.className = 'yt-skip-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Forzar reflow para la animación
  toast.offsetHeight;
  toast.classList.add('yt-skip-toast-show');

  setTimeout(() => {
    toast.classList.remove('yt-skip-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Obtiene la API key desde el storage
 */
async function getApiKey() {
  try {
    const result = await browserAPI.storage.local.get('groqApiKey');
    return result.groqApiKey || '';
  } catch (error) {
    console.error('[YT-Skip] Error obteniendo API key:', error);
    return '';
  }
}

/**
 * Obtiene los sponsors guardados para un video
 */
async function getCachedSponsors(videoId) {
  try {
    const result = await browserAPI.storage.local.get(`sponsors_${videoId}`);
    return result[`sponsors_${videoId}`] || null;
  } catch (error) {
    console.error('[YT-Skip] Error obteniendo sponsors cacheados:', error);
    return null;
  }
}

/**
 * Guarda los sponsors en storage
 */
async function cacheSponsors(videoId, data) {
  try {
    await browserAPI.storage.local.set({ [`sponsors_${videoId}`]: data });
  } catch (error) {
    console.error('[YT-Skip] Error guardando sponsors en cache:', error);
  }
}

/**
 * Guarda feedback del usuario
 */
async function saveFeedback(videoId, sponsorIndex, feedback) {
  try {
    const key = `feedback_${videoId}`;
    const result = await browserAPI.storage.local.get(key);
    const feedbacks = result[key] || {};
    feedbacks[sponsorIndex] = feedback;
    await browserAPI.storage.local.set({ [key]: feedbacks });
  } catch (error) {
    console.error('[YT-Skip] Error guardando feedback:', error);
  }
}

// ============================================================
// FEAT-2: DETECCIÓN DE CARGA Y SCRAPING DE TRANSCRIPCIÓN
// ============================================================

/**
 * Espera a que el elemento video esté disponible y cargado
 */
function waitForVideo() {
  return new Promise((resolve) => {
    const check = () => {
      const video = document.querySelector('video');
      if (video && video.readyState >= 2) {
        resolve(video);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Espera a que un elemento aparezca en el DOM
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    const observer = new MutationObserver((_, obs) => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout esperando elemento: ${selector}`));
    }, timeout);
  });
}

/**
 * Abre el panel de transcripción de YouTube y extrae los datos
 */
async function scrapeTranscript() {
  try {
    console.log('[YT-Skip] Iniciando scraping de transcripción...');

    let transcriptButton = null;

    console.log('[YT-Skip] Buscando botón de transcripción...');
    // Intentar buscar el botón durante un máximo de 6 segundos (12 intentos, 500ms entre cada uno)
    for (let attempt = 0; attempt < 12; attempt++) {
      // Método 1: Intentar buscar el botón directo de transcripción en la descripción
      const descriptionContainer = document.querySelector('#description') || 
                                   document.querySelector('#description-inline-expander') ||
                                   document.querySelector('ytd-watch-metadata') ||
                                   document.querySelector('#primary-inner');
      if (descriptionContainer) {
        const buttons = descriptionContainer.querySelectorAll('button');
        for (const btn of buttons) {
          const txt = btn.textContent.trim().toLowerCase();
          if ((txt.includes('transcripción') || txt.includes('transcript') || 
               txt.includes('transkript') || txt.includes('transcription')) &&
              !btn.classList.contains('yt-skip-transcript-btn')) {
            transcriptButton = btn;
            console.log('[YT-Skip] Botón directo de transcripción encontrado en la descripción');
            break;
          }
        }
      }

      // Si no lo encontramos en la descripción, buscar en todo el documento (excluyendo el nuestro)
      if (!transcriptButton) {
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          const txt = btn.textContent.trim().toLowerCase();
          if ((txt.includes('transcripción') || txt.includes('transcript') || 
               txt.includes('transkript') || txt.includes('transcription')) &&
              !btn.classList.contains('yt-skip-transcript-btn')) {
            transcriptButton = btn;
            console.log('[YT-Skip] Botón de transcripción encontrado por texto en el documento');
            break;
          }
        }
      }

      if (transcriptButton) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Método 2 (Fallback): Buscar el menú de tres puntos si no hay botón directo tras el periodo de espera
    if (!transcriptButton) {
      console.log('[YT-Skip] Botón directo no encontrado tras esperar. Probando con el menú de tres puntos...');
      const moreButton =
        document.querySelector('#top-level-buttons-computed ytd-button-renderer:last-of-type button') ||
        document.querySelector('button[aria-label="More actions"]') ||
        document.querySelector('button[aria-label="Más acciones"]') ||
        document.querySelector('#menu button yt-icon-button button') ||
        document.querySelector('#top-level-buttons ytd-button-renderer:last-of-type button') ||
        document.querySelector('ytd-menu-renderer button:last-of-type');

      if (moreButton) {
        moreButton.click();
        // Esperar a que el menú se abra
        await new Promise(r => setTimeout(r, 500));

        // Buscar en los items del menú popup
        const menuItems = document.querySelectorAll(
          'ytd-menu-popup-renderer tp-yt-paper-listbox ytd-menu-service-item-renderer, ' +
          'ytd-menu-popup-renderer ytd-menu-service-item-renderer'
        );

        for (const item of menuItems) {
          const text = item.textContent.trim().toLowerCase();
          if (text.includes('transcript') || text.includes('transcripción') ||
              text.includes('transcrição') || text.includes('trascrizione') ||
              text.includes('transkript') || text.includes('transkription')) {
            transcriptButton = item;
            break;
          }
        }

        if (!transcriptButton) {
          // Fallback: buscar por path del icono de transcripción
          transcriptButton = document.querySelector(
            'ytd-menu-service-item-renderer[role="menuitem"]:last-of-type'
          );
        }

        if (!transcriptButton) {
          // Fallback adicional: buscar por el path SVG del icono de transcripción
          const allMenuItems = document.querySelectorAll('ytd-menu-service-item-renderer');
          for (const item of allMenuItems) {
            const path = item.querySelector('path[d*="M4"]'); // Icono de lista/transcripción
            if (path) {
              transcriptButton = item;
              break;
            }
          }
        }
      }
    }

    if (!transcriptButton) {
      // Intentar cerrar el menú por si acaso
      document.body.click();
      throw new Error('Este video no tiene transcripción disponible o no se pudo encontrar el botón.');
    }

    // Hacer clic en el botón para abrir el panel
    transcriptButton.click();

    // Paso 3: Esperar a que el panel de transcripción se cargue
    await new Promise(r => setTimeout(r, 1500));

    // Esperar los segmentos de transcripción
    const transcriptPanel = await waitForElement('ytd-transcript-renderer, ytd-transcript-search-panel-renderer, #segments-container', 8000).catch(() => null);
    if (!transcriptPanel) {
      throw new Error('No se pudo cargar el panel de transcripción.');
    }

    // Esperar los segmentos individuales
    await waitForElement('ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer', 5000).catch(() => null);

    // Paso 4: Extraer bloques de texto con timestamps
    const segments = document.querySelectorAll('ytd-transcript-segment-renderer');
    const transcript = [];

    segments.forEach(segment => {
      const timeElement = segment.querySelector('.segment-timestamp');
      const textElement = segment.querySelector('.segment-text');

      if (timeElement && textElement) {
        const timeText = timeElement.textContent.trim();
        const text = textElement.textContent.trim();

        // Parsear timestamp (formato "1:23" o "1:23:45")
        const timeSeconds = parseTimeInput(timeText);
        if (timeSeconds !== null && text) {
          transcript.push({ time: timeSeconds, text: text });
        }
      }
    });

    // Paso 5: Cerrar el panel de transcripción
    const closeButton = document.querySelector('ytd-transcript-renderer button[aria-label="Close transcript"]') ||
                        document.querySelector('ytd-transcript-renderer button[aria-label="Cerrar transcripción"]') ||
                        document.querySelector('ytd-transcript-renderer #header button') ||
                        document.querySelector('ytd-transcript-search-panel-renderer button[aria-label="Close transcript"]') ||
                        document.querySelector('ytd-transcript-search-panel-renderer button[aria-label="Cerrar transcripción"]') ||
                        document.querySelector('ytd-transcript-search-panel-renderer #header button') ||
                        document.querySelector('ytd-transcript-search-panel-renderer button');

    if (closeButton) {
      closeButton.click();
    }

    if (transcript.length === 0) {
      throw new Error('No se pudo extraer texto de la transcripción.');
    }

    console.log(`[YT-Skip] Transcripción extraída: ${transcript.length} segmentos`);
    return transcript;

  } catch (error) {
    console.error('[YT-Skip] Error scraping transcripción:', error);
    showToast(error.message || 'Error al obtener la transcripción', 4000);
    return [];
  }
}

// ============================================================
// FEAT-3: ANÁLISIS CON GROQ
// ============================================================

/**
 * Envía la transcripción a Groq para análisis de sponsors
 */
async function analyzeWithGroq(transcript) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    showToast('API Key de Groq no configurada. Ábrela desde el popup de la extensión.', 5000);
    return { sponsors: [], has_sponsors: false };
  }

  // Agrupar segmentos de la transcripción en bloques de ~15 segundos para reducir drásticamente el uso de tokens (TPM)
  const compressedSegments = [];
  let currentSegment = null;

  for (const seg of transcript) {
    if (!currentSegment) {
      currentSegment = { time: seg.time, text: seg.text };
    } else if (seg.time - currentSegment.time < 15) {
      currentSegment.text += " " + seg.text;
    } else {
      compressedSegments.push(currentSegment);
      currentSegment = { time: seg.time, text: seg.text };
    }
  }
  if (currentSegment) {
    compressedSegments.push(currentSegment);
  }

  // Construir texto de transcripción en formato "tiempo|texto"
  const transcriptText = compressedSegments.map(seg => `${Math.round(seg.time)}|${seg.text}`).join('\n');
  console.log(`[YT-Skip] Transcripción comprimida para la API de Groq: de ${transcript.length} a ${compressedSegments.length} líneas`);

  try {
    state.isAnalyzing = true;
    updateTranscriptPanelStatus();

    const response = await browserAPI.runtime.sendMessage({
      action: 'analyzeTranscript',
      apiKey: apiKey,
      transcriptText: transcriptText,
      transcript: transcript
    });

    state.isAnalyzing = false;

    if (!response.success) {
      throw new Error(response.error || 'Error desconocido al analizar la transcripción.');
    }

    console.log(`[YT-Skip] Análisis completado: ${response.data.sponsors.length} sponsors detectados`);
    return response.data;

  } catch (error) {
    state.isAnalyzing = false;
    console.error('[YT-Skip] Error analizando con Groq:', error);
    showToast(`Error: ${error.message}`, 5000);
    return { sponsors: [], has_sponsors: false };
  }
}

// ============================================================
// FEAT-4: BOTÓN SKIP SPONSOR
// ============================================================

/**
 * Crea el botón Skip Sponsor con estilos de YouTube
 */
function createSkipButton() {
  const btn = document.createElement('button');
  btn.className = 'yt-skip-sponsor-btn';
  btn.innerHTML = 'Saltar sponsor <span style="font-size:14px">→</span>';
  btn.addEventListener('click', () => skipSponsor());
  return btn;
}

/**
 * Muestra el botón Skip Sponsor en el player
 */
function showSkipButton(sponsor) {
  removeSkipButton();

  const playerContainer = document.querySelector('#movie_player') ||
                          document.querySelector('ytd-player') ||
                          document.querySelector('.html5-video-container');

  if (!playerContainer) return;

  const btn = createSkipButton();
  btn.dataset.sponsorStart = sponsor.start;
  btn.dataset.sponsorEnd = sponsor.end;
  btn.dataset.sponsorIndex = state.sponsors.indexOf(sponsor);
  playerContainer.appendChild(btn);

  state.skipButton = btn;
}

/**
 * Remueve el botón Skip Sponsor
 */
function removeSkipButton() {
  if (state.skipButton) {
    state.skipButton.remove();
    state.skipButton = null;
  }
  // También remover cualquier botón residual
  document.querySelectorAll('.yt-skip-sponsor-btn').forEach(el => el.remove());
}

/**
 * Salta al final del sponsor actual
 */
function skipSponsor() {
  const video = document.querySelector('video');
  if (!video || !state.skipButton) return;

  const endTime = parseFloat(state.skipButton.dataset.sponsorEnd);
  const sponsorIndex = parseInt(state.skipButton.dataset.sponsorIndex);

  video.currentTime = endTime;
  removeSkipButton();

  // Mostrar panel de confirmación (FEAT-5)
  if (sponsorIndex >= 0 && sponsorIndex < state.sponsors.length) {
    showConfirmationPanel(state.sponsors[sponsorIndex], sponsorIndex);
  }
}

// ============================================================
// FEAT-5: CONFIRMACIÓN Y EDICIÓN DE TIMESTAMPS
// ============================================================

/**
 * Muestra el panel de confirmación después de saltar un sponsor
 */
function showConfirmationPanel(sponsor, index) {
  removeConfirmationPanel();

  const playerContainer = document.querySelector('#movie_player') ||
                          document.querySelector('ytd-player') ||
                          document.querySelector('.html5-video-container');

  if (!playerContainer) return;

  const panel = document.createElement('div');
  panel.className = 'yt-skip-confirmation-panel';
  panel.innerHTML = `
    <div class="yt-skip-confirmation-title">¿El sponsor terminó aquí?</div>
    <div class="yt-skip-confirmation-info">
      Detectado: ${formatTime(sponsor.start)} → ${formatTime(sponsor.end)}
    </div>
    <div class="yt-skip-confirmation-actions">
      <button class="yt-skip-btn-confirm" data-action="confirm">✓ Sí, correcto</button>
      <button class="yt-skip-btn-edit" data-action="edit">✗ No, editar</button>
    </div>
  `;

  // Evitar que los clics e interacciones se propaguen al reproductor de YouTube
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('mouseup', (e) => e.stopPropagation());

  playerContainer.appendChild(panel);
  state.confirmationPanel = panel;

  // Event listeners
  panel.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    saveFeedback(state.videoId, index, { correct: true, timestamp: Date.now() });
    removeConfirmationPanel();
    showToast('¡Gracias por el feedback! ✓', 2000);
  });

  panel.querySelector('[data-action="edit"]').addEventListener('click', () => {
    showEditPanel(sponsor, index);
  });

  // Auto-desaparecer después de 8 segundos
  setTimeout(() => {
    if (state.confirmationPanel === panel) {
      removeConfirmationPanel();
    }
  }, 8000);
}

/**
 * Muestra el panel de edición de timestamps
 */
function showEditPanel(sponsor, index) {
  removeConfirmationPanel();

  const playerContainer = document.querySelector('#movie_player') ||
                          document.querySelector('ytd-player') ||
                          document.querySelector('.html5-video-container');

  if (!playerContainer) return;

  const panel = document.createElement('div');
  panel.className = 'yt-skip-confirmation-panel';
  panel.innerHTML = `
    <div class="yt-skip-confirmation-title">Editar timestamps del sponsor</div>
    <div class="yt-skip-edit-fields">
      <div class="yt-skip-edit-field">
        <label>Inicio del sponsor:</label>
        <input type="text" class="yt-skip-time-input" id="yt-skip-edit-start" value="${formatTime(sponsor.start)}" />
      </div>
      <div class="yt-skip-edit-field">
        <label>Fin del sponsor:</label>
        <input type="text" class="yt-skip-time-input" id="yt-skip-edit-end" value="${formatTime(sponsor.end)}" />
      </div>
    </div>
    <div class="yt-skip-confirmation-actions">
      <button class="yt-skip-btn-confirm" data-action="save">Guardar corrección</button>
      <button class="yt-skip-btn-cancel" data-action="cancel">Cancelar</button>
    </div>
  `;

  // Evitar que los clics se propaguen al reproductor de YouTube
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('mouseup', (e) => e.stopPropagation());

  // Evitar que las teclas pulsadas se propaguen al reproductor (evita pausar con espacio, buscar con números, etc.)
  const inputs = panel.querySelectorAll('input');
  inputs.forEach(input => {
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
  });

  playerContainer.appendChild(panel);
  state.confirmationPanel = panel;

  // Event listeners
  panel.querySelector('[data-action="save"]').addEventListener('click', () => {
    const startStr = document.getElementById('yt-skip-edit-start').value;
    const endStr = document.getElementById('yt-skip-edit-end').value;

    const newStart = parseTimeInput(startStr);
    const newEnd = parseTimeInput(endStr);

    if (newStart === null || newEnd === null) {
      showToast('Formato de tiempo inválido. Usa MM:SS o H:MM:SS', 3000);
      return;
    }

    if (newEnd <= newStart) {
      showToast('El fin debe ser mayor que el inicio', 3000);
      return;
    }

    // Actualizar sponsor en memoria
    state.sponsors[index].start = newStart;
    state.sponsors[index].end = newEnd;

    // Guardar en storage
    cacheSponsors(state.videoId, { sponsors: state.sponsors, has_sponsors: state.sponsors.length > 0 });
    saveFeedback(state.videoId, index, { correct: false, edited: true, newStart, newEnd, timestamp: Date.now() });

    removeConfirmationPanel();
    showToast('Corrección guardada ✓', 2000);
    updateTranscriptPanel();
  });

  panel.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    removeConfirmationPanel();
  });

  // Auto-desaparecer después de 15 segundos
  setTimeout(() => {
    if (state.confirmationPanel === panel) {
      removeConfirmationPanel();
    }
  }, 15000);
}

/**
 * Remueve el panel de confirmación
 */
function removeConfirmationPanel() {
  if (state.confirmationPanel) {
    state.confirmationPanel.remove();
    state.confirmationPanel = null;
  }
  document.querySelectorAll('.yt-skip-confirmation-panel').forEach(el => el.remove());
}

// ============================================================
// FEAT-6: PANEL DE TRANSCRIPCIÓN Y SPONSORS
// ============================================================

/**
 * Actualiza el estado del panel de transcripción
 */
function updateTranscriptPanelStatus() {
  const statusEl = document.querySelector('.yt-skip-panel-status');
  if (!statusEl) return;

  if (state.isAnalyzing) {
    statusEl.innerHTML = '<span class="yt-skip-analyzing">Analizando con IA...</span>';
  } else if (state.sponsors.length > 0) {
    statusEl.innerHTML = `<span class="yt-skip-found">${state.sponsors.length} sponsor${state.sponsors.length > 1 ? 's' : ''} detectado${state.sponsors.length > 1 ? 's' : ''}</span>`;
  } else if (state.transcript.length > 0) {
    statusEl.innerHTML = '<span class="yt-skip-no-sponsors">Sin sponsors detectados</span>';
  } else {
    statusEl.innerHTML = '<span class="yt-skip-no-transcript">Sin transcripción</span>';
  }
}

/**
 * Actualiza el contenido del panel de transcripción
 */
function updateTranscriptPanel() {
  const contentEl = document.querySelector('.yt-skip-panel-content');
  if (!contentEl) return;

  let html = '';

  state.transcript.forEach((seg, i) => {
    const isSponsor = state.sponsors.some((s, si) => seg.time >= s.start && seg.time <= s.end);
    const sponsorData = state.sponsors.find(s => seg.time >= s.start && seg.time <= s.end);

    const segmentClass = isSponsor ? 'yt-skip-transcript-segment yt-skip-transcript-sponsor' : 'yt-skip-transcript-segment';
    const sponsorLabel = sponsorData ? `<span class="yt-skip-sponsor-label">[SPONSOR: ${sponsorData.brand || 'Desconocido'}]</span> ` : '';
    const editBtn = sponsorData ? `<button class="yt-skip-edit-segment-btn" data-index="${state.sponsors.indexOf(sponsorData)}">✎</button>` : '';

    html += `
      <div class="${segmentClass}">
        <span class="yt-skip-timestamp" data-time="${seg.time}">${formatTime(seg.time)}</span>
        ${sponsorLabel}${seg.text}
        ${editBtn}
      </div>
    `;
  });

  contentEl.innerHTML = html;

  // Agregar event listeners a los timestamps
  contentEl.querySelectorAll('.yt-skip-timestamp').forEach(el => {
    el.addEventListener('click', () => {
      const time = parseFloat(el.dataset.time);
      const video = document.querySelector('video');
      if (video) video.currentTime = time;
    });
  });

  // Agregar event listeners a los botones de editar
  contentEl.querySelectorAll('.yt-skip-edit-segment-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(el.dataset.index);
      if (index >= 0 && index < state.sponsors.length) {
        showEditPanel(state.sponsors[index], index);
      }
    });
  });

  updateTranscriptPanelStatus();
}

/**
 * Alterna la visibilidad del panel de transcripción
 */
function toggleTranscriptPanel() {
  if (state.transcriptPanel) {
    state.transcriptPanel.remove();
    state.transcriptPanel = null;
    return;
  }

  // Crear el panel lateral
  const panel = document.createElement('div');
  panel.className = 'yt-skip-transcript-panel';
  panel.innerHTML = `
    <div class="yt-skip-panel-header">
      <span class="yt-skip-panel-title">📋 Transcripción</span>
      <button class="yt-skip-panel-close">&times;</button>
    </div>
    <div class="yt-skip-panel-status"></div>
    <div class="yt-skip-panel-content"></div>
  `;

  document.body.appendChild(panel);
  state.transcriptPanel = panel;

  // Cerrar con botón X
  panel.querySelector('.yt-skip-panel-close').addEventListener('click', () => {
    panel.remove();
    state.transcriptPanel = null;
  });

  // Cerrar con click fuera
  document.addEventListener('click', function closePanel(e) {
    if (state.transcriptPanel !== panel) {
      document.removeEventListener('click', closePanel);
      return;
    }
    if (!panel.contains(e.target) && !e.target.closest('.yt-skip-transcript-btn')) {
      panel.remove();
      state.transcriptPanel = null;
      document.removeEventListener('click', closePanel);
    }
  });

  updateTranscriptPanel();
}

/**
 * Agrega el botón "📋 Ver transcripción" debajo del título del video
 */
function addTranscriptButton() {
  // Remover botón existente si hay
  document.querySelectorAll('.yt-skip-transcript-btn').forEach(el => el.remove());

  const titleContainer = document.querySelector('#above-the-fold') ||
                         document.querySelector('#info-contents') ||
                         document.querySelector('ytd-video-primary-info-renderer');

  if (!titleContainer) return;

  const btn = document.createElement('button');
  btn.className = 'yt-skip-transcript-btn';
  btn.innerHTML = '📋 Ver transcripción';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTranscriptPanel();
  });

  titleContainer.appendChild(btn);
}

// ============================================================
// FEAT-4: MONITOREO DEL TIEMPO DEL VIDEO
// ============================================================

/**
 * Inicia el monitoreo del tiempo del video para mostrar el botón Skip
 */
function startVideoMonitor() {
  stopVideoMonitor();

  state.monitorInterval = setInterval(() => {
    const video = document.querySelector('video');
    if (!video || state.sponsors.length === 0) return;

    const currentTime = video.currentTime;

    // Buscar si estamos dentro de algún segmento de sponsor
    let activeSponsorIndex = -1;
    for (let i = 0; i < state.sponsors.length; i++) {
      const sponsor = state.sponsors[i];
      // Mostrar botón desde 1 segundo antes del inicio hasta el final del sponsor
      if (currentTime >= sponsor.start - 1 && currentTime < sponsor.end) {
        activeSponsorIndex = i;
        break;
      }
    }

    if (activeSponsorIndex >= 0) {
      // Mostrar el botón para este sponsor si no está ya visible
      if (!state.skipButton || parseInt(state.skipButton.dataset.sponsorIndex) !== activeSponsorIndex) {
        showSkipButton(state.sponsors[activeSponsorIndex]);
        state.currentSponsorIndex = activeSponsorIndex;
      }
    } else if (state.skipButton) {
      // Ya pasamos el rango del sponsor, remover el botón
      removeSkipButton();
      state.currentSponsorIndex = -1;
    }
  }, 500);
}

/**
 * Detiene el monitoreo del video
 */
function stopVideoMonitor() {
  if (state.monitorInterval) {
    clearInterval(state.monitorInterval);
    state.monitorInterval = null;
  }
}

// ============================================================
// FEAT-7: MANEJO DE NAVEGACIÓN SPA
// ============================================================

/**
 * Limpia todo el estado al cambiar de video
 */
function cleanup() {
  stopVideoMonitor();
  removeSkipButton();
  removeConfirmationPanel();

  if (state.transcriptPanel) {
    state.transcriptPanel.remove();
    state.transcriptPanel = null;
  }

  document.querySelectorAll('.yt-skip-transcript-btn').forEach(el => el.remove());

  state.videoId = null;
  state.transcript = [];
  state.sponsors = [];
  state.isAnalyzing = false;
  state.currentSponsorIndex = -1;
}

/**
 * Flujo principal: procesar el video actual
 */
async function processVideo() {
  const videoId = getVideoId();
  if (!videoId) return;

  // Si ya estamos procesando este video, no hacer nada
  if (state.videoId === videoId && state.transcript.length > 0) return;

  cleanup();
  state.videoId = videoId;

  console.log(`[YT-Skip] Procesando video: ${videoId}`);

  // Verificar si ya fue analizado
  const cached = await getCachedSponsors(videoId);
  if (cached && cached.sponsors && cached.sponsors.length > 0) {
    console.log(`[YT-Skip] Video ya analizado, cargando desde cache`);
    state.sponsors = cached.sponsors;
  }

  // Esperar a que el video cargue
  await waitForVideo();

  // Si ya tenemos sponsors de caché, iniciar monitoreo inmediatamente
  if (state.sponsors.length > 0) {
    console.log(`[YT-Skip] Iniciando monitoreo inmediato con sponsors de caché`);
    startVideoMonitor();
  }

  // Agregar botón de transcripción
  addTranscriptButton();

  // Scrappear transcripción
  const transcript = await scrapeTranscript();
  if (transcript.length === 0) {
    // Si falló el scraping de transcripción pero ya tenemos sponsors de caché, al menos mostrar en el panel lo que tenemos
    if (state.sponsors.length > 0) {
      updateTranscriptPanel();
    }
    return;
  }

  state.transcript = transcript;

  // Si ya tenemos sponsors cacheados y los estamos usando, solo actualizar el panel lateral
  if (cached && cached.sponsors && cached.sponsors.length > 0) {
    updateTranscriptPanel();
    return;
  }

  // Analizar con Groq
  const result = await analyzeWithGroq(transcript);
  state.sponsors = result.sponsors || [];

  // Guardar resultado
  await cacheSponsors(videoId, result);
  updateTranscriptPanel();

  // Iniciar monitoreo del video si no se inició antes
  if (state.sponsors.length > 0 && !state.monitorInterval) {
    startVideoMonitor();
  }
}

/**
 * Detecta cambios de video en la SPA de YouTube
 */
function setupSPANavigation() {
  // Evento interno de YouTube
  window.addEventListener('yt-navigate-finish', () => {
    console.log('[YT-Skip] Navegación SPA detectada (yt-navigate-finish)');
    setTimeout(() => processVideo(), 1500);
  });

  // Fallback: observar cambios en la URL
  let lastUrl = window.location.href;
  const urlCheckInterval = setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch') {
        console.log('[YT-Skip] Cambio de URL detectado');
        setTimeout(() => processVideo(), 1500);
      }
    }
  }, 1000);
}

// ============================================================
// INICIALIZACIÓN
// ============================================================

/**
 * Inicializa el content script
 */
async function init() {
  console.log('[YT-Skip] Extensión YT Sponsor Skip cargada');

  setupSPANavigation();

  // Si ya estamos en un video, procesarlo
  if (window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch') {
    setTimeout(() => processVideo(), 2000);
  }
}

// Ejecutar al cargar
init();
