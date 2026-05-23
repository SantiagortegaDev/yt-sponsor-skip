/**
 * content.js — Inyectado en YouTube: DOM, transcripción, botón Skip Sponsor
 */

// Compatibilidad Firefox/Chrome
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ============================================================
// SISTEMA DE LOGS
// ============================================================

const Log = {
  MAX_ENTRIES: 200,

  _getTimestamp() {
    return new Date().toLocaleTimeString('es', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },

  async _write(level, msg, data) {
    const entry = { ts: this._getTimestamp(), level, msg, data: data || null };
    const prefix = `[YT-Skip] [${level}]`;
    if (level === 'ERROR') console.error(prefix, msg, data || '');
    else if (level === 'WARN') console.warn(prefix, msg, data || '');
    else if (level === 'DEBUG') console.debug(prefix, msg, data || '');
    else console.log(prefix, msg, data || '');

    try {
      const result = await browserAPI.storage.local.get('ytSkipLogs');
      const logs = result.ytSkipLogs || [];
      logs.push(entry);
      if (logs.length > this.MAX_ENTRIES) logs.splice(0, logs.length - this.MAX_ENTRIES);
      await browserAPI.storage.local.set({ ytSkipLogs: logs });
    } catch (_) { /* storage no disponible, ignorar */ }
  },

  info(msg, data)  { this._write('INFO', msg, data); },
  warn(msg, data)  { this._write('WARN', msg, data); },
  error(msg, data) { this._write('ERROR', msg, data); },
  debug(msg, data) { this._write('DEBUG', msg, data); },

  async clear() {
    try { await browserAPI.storage.local.remove('ytSkipLogs'); } catch (_) {}
  }
};

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
  urlObserver: null,
  editPanelAutoCloseTimer: null
};

// ============================================================
// UTILIDADES
// ============================================================

function getVideoId() {
  const url = new URL(window.location.href);
  return url.searchParams.get('v') || null;
}

function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parseTimeInput(timeStr) {
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function showToast(message, duration = 3000) {
  const existingToast = document.getElementById('yt-skip-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.id = 'yt-skip-toast';
  toast.className = 'yt-skip-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  toast.offsetHeight;
  toast.classList.add('yt-skip-toast-show');

  setTimeout(() => {
    toast.classList.remove('yt-skip-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

async function getApiKey() {
  try {
    const result = await browserAPI.storage.local.get('groqApiKey');
    return result.groqApiKey || '';
  } catch (error) {
    Log.error('Error obteniendo API key', error.message);
    return '';
  }
}

async function getCachedSponsors(videoId) {
  try {
    const result = await browserAPI.storage.local.get(`sponsors_${videoId}`);
    return result[`sponsors_${videoId}`] || null;
  } catch (error) {
    Log.error('Error obteniendo sponsors cacheados', error.message);
    return null;
  }
}

async function cacheSponsors(videoId, data) {
  try {
    await browserAPI.storage.local.set({ [`sponsors_${videoId}`]: data });
  } catch (error) {
    Log.error('Error guardando sponsors en cache', error.message);
  }
}

async function saveFeedback(videoId, sponsorIndex, feedback) {
  try {
    const key = `feedback_${videoId}`;
    const result = await browserAPI.storage.local.get(key);
    const feedbacks = result[key] || {};
    feedbacks[sponsorIndex] = feedback;
    await browserAPI.storage.local.set({ [key]: feedbacks });
  } catch (error) {
    Log.error('Error guardando feedback', error.message);
  }
}

// ============================================================
// DETECCIÓN DE CARGA Y SCRAPING DE TRANSCRIPCIÓN
// ============================================================

function waitForVideo() {
  return new Promise((resolve) => {
    const check = () => {
      const video = document.querySelector('video');
      if (video && video.readyState >= 2) { resolve(video); return; }
      setTimeout(check, 500);
    };
    check();
  });
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) { resolve(element); return; }
    const observer = new MutationObserver((_, obs) => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
  });
}

function findTranscriptButton() {
  const transcriptSection = document.querySelector('ytd-video-description-transcript-section-renderer');
  if (transcriptSection) {
    const btn = transcriptSection.querySelector('button');
    if (btn) { Log.info('Botón encontrado en transcript-section-renderer'); return btn; }
  }

  const chipBtn = document.querySelector('button.ytChipShapeButtonReset');
  if (chipBtn) {
    const txt = chipBtn.textContent.trim().toLowerCase();
    const label = (chipBtn.getAttribute('aria-label') || '').toLowerCase();
    if (txt.includes('transcript') || label.includes('transcript') ||
        txt.includes('transcripción') || label.includes('transcripción')) {
      Log.info('Botón encontrado como chip Transcript');
      return chipBtn;
    }
  }

  const ariaBtn = document.querySelector('button[aria-label="Show transcript"]') ||
                  document.querySelector('button[aria-label="Show Transcript"]') ||
                  document.querySelector('button[aria-label="Mostrar transcripción"]');
  if (ariaBtn) { Log.info('Botón encontrado por aria-label'); return ariaBtn; }

  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    if (btn.classList.contains('yt-skip-transcript-btn')) continue;
    const txt = btn.textContent.trim().toLowerCase();
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if ((txt.includes('transcript') || txt.includes('transcripción') ||
         txt.includes('transkript') || label.includes('transcript')) &&
        !txt.includes('saltar') && !txt.includes('skip')) {
      Log.info('Botón encontrado por texto', txt.substring(0, 40));
      return btn;
    }
  }

  return null;
}

function findTranscriptButtonViaMenu() {
  Log.info('Intentando vía menú de tres puntos...');
  const moreButton =
    document.querySelector('button[aria-label="More actions"]') ||
    document.querySelector('button[aria-label="Más acciones"]') ||
    document.querySelector('#top-level-buttons-computed ytd-button-renderer:last-of-type button') ||
    document.querySelector('#top-level-buttons ytd-button-renderer:last-of-type button') ||
    document.querySelector('ytd-menu-renderer button:last-of-type');
  if (!moreButton) return null;
  moreButton.click();
  return moreButton;
}

function findTranscriptMenuItem() {
  const menuItems = document.querySelectorAll(
    'ytd-menu-popup-renderer tp-yt-paper-listbox ytd-menu-service-item-renderer, ' +
    'ytd-menu-popup-renderer ytd-menu-service-item-renderer'
  );
  for (const item of menuItems) {
    const text = item.textContent.trim().toLowerCase();
    if (text.includes('transcript') || text.includes('transcripción') ||
        text.includes('transcrição') || text.includes('trascrizione') ||
        text.includes('transkript') || text.includes('transkription')) {
      return item;
    }
  }
  return null;
}

function extractTranscriptSegments() {
  const transcript = [];

  // UI 2025+
  const newSegments = document.querySelectorAll('transcript-segment-view-model');
  if (newSegments.length > 0) {
    Log.info(`Extrayendo ${newSegments.length} segmentos (UI 2025+)`);
    newSegments.forEach(segment => {
      const timeElement = segment.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
      const textElement = segment.querySelector('.ytAttributedStringHost');
      if (timeElement && textElement) {
        const timeText = timeElement.textContent.trim();
        const text = textElement.textContent.trim();
        const timeSeconds = parseTimeInput(timeText);
        if (timeSeconds !== null && text) transcript.push({ time: timeSeconds, text });
      }
    });
    if (transcript.length > 0) return transcript;
  }

  // UI antigua
  const oldSegments = document.querySelectorAll('ytd-transcript-segment-renderer');
  if (oldSegments.length > 0) {
    Log.info(`Extrayendo ${oldSegments.length} segmentos (UI antigua)`);
    oldSegments.forEach(segment => {
      const timeElement = segment.querySelector('.segment-timestamp');
      const textElement = segment.querySelector('.segment-text');
      if (timeElement && textElement) {
        const timeText = timeElement.textContent.trim();
        const text = textElement.textContent.trim();
        const timeSeconds = parseTimeInput(timeText);
        if (timeSeconds !== null && text) transcript.push({ time: timeSeconds, text });
      }
    });
    if (transcript.length > 0) return transcript;
  }

  // Fallback genérico
  const genericContainer = document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]');
  if (genericContainer) {
    Log.info('Intentando extracción genérica...');
    const allTimestamps = genericContainer.querySelectorAll('[class*="Timestamp"], [class*="timestamp"]');
    allTimestamps.forEach(tsEl => {
      const parent = tsEl.parentElement;
      if (!parent) return;
      const textEls = parent.querySelectorAll('[class*="String"], [class*="Text"], span');
      let text = '';
      textEls.forEach(t => { if (t !== tsEl && t.textContent.trim()) text += (text ? ' ' : '') + t.textContent.trim(); });
      const timeSeconds = parseTimeInput(tsEl.textContent.trim());
      if (timeSeconds !== null && text) transcript.push({ time: timeSeconds, text });
    });
  }
  return transcript;
}

function closeTranscriptPanel() {
  const closeBtn = document.querySelector('button[aria-label="Close transcript"]') ||
                   document.querySelector('button[aria-label="Cerrar transcripción"]');
  if (closeBtn) { closeBtn.click(); return; }

  const headerCloseBtn = document.querySelector('ytd-engagement-panel-title-header-renderer button[aria-label="Close"]') ||
                         document.querySelector('ytd-engagement-panel-title-header-renderer button');
  if (headerCloseBtn) { headerCloseBtn.click(); return; }

  const expandedPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]');
  if (expandedPanel) expandedPanel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
}

async function scrapeTranscript() {
  try {
    Log.info('Iniciando scraping de transcripción...');

    // Verificar si ya está abierto
    const alreadyOpen = document.querySelector('transcript-segment-view-model') ||
                        document.querySelector('ytd-transcript-segment-renderer');
    if (alreadyOpen) {
      Log.info('Panel ya abierto, extrayendo...');
      const transcript = extractTranscriptSegments();
      if (transcript.length > 0) {
        closeTranscriptPanel();
        Log.info(`Transcripción extraída: ${transcript.length} segmentos`);
        return transcript;
      }
    }

    // Buscar botón con reintentos
    let transcriptButton = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      transcriptButton = findTranscriptButton();
      if (transcriptButton) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Fallback: menú de tres puntos
    if (!transcriptButton) {
      Log.info('Botón directo no encontrado. Intentando menú...');
      findTranscriptButtonViaMenu();
      await new Promise(r => setTimeout(r, 800));
      transcriptButton = findTranscriptMenuItem();
      if (!transcriptButton) { document.body.click(); await new Promise(r => setTimeout(r, 300)); }
    }

    if (!transcriptButton) {
      throw new Error('Este video no tiene transcripción disponible.');
    }

    Log.info('Abriendo panel de transcripción...');
    transcriptButton.click();
    await new Promise(r => setTimeout(r, 1500));

    // Esperar segmentos con reintentos
    let transcript = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      transcript = extractTranscriptSegments();
      if (transcript.length > 0) break;
      Log.debug(`Intento ${attempt + 1}: sin segmentos aún`);
    }

    // Cerrar el panel de transcripción de YouTube
    closeTranscriptPanel();
    Log.info('Panel de transcripción de YouTube cerrado');

    if (transcript.length === 0) throw new Error('No se pudo extraer texto de la transcripción.');

    Log.info(`Transcripción extraída: ${transcript.length} segmentos`);
    return transcript;

  } catch (error) {
    Log.error('Error scraping transcripción', error.message);
    showToast(error.message || 'Error al obtener la transcripción', 4000);
    return [];
  }
}

// ============================================================
// ANÁLISIS CON GROQ (con retry y rate limit)
// ============================================================

async function analyzeWithGroq(transcript, retryCount = 0) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    showToast('API Key de Groq no configurada. Ábrela desde el popup.', 5000);
    return { sponsors: [], has_sponsors: false };
  }

  // Agrupar segmentos en bloques de ~15 segundos
  const compressedSegments = [];
  let currentSegment = null;
  for (const seg of transcript) {
    if (!currentSegment) { currentSegment = { time: seg.time, text: seg.text }; }
    else if (seg.time - currentSegment.time < 15) { currentSegment.text += " " + seg.text; }
    else { compressedSegments.push(currentSegment); currentSegment = { time: seg.time, text: seg.text }; }
  }
  if (currentSegment) compressedSegments.push(currentSegment);

  const transcriptText = compressedSegments.map(seg => `${Math.round(seg.time)}|${seg.text}`).join('\n');
  Log.info(`Transcripción comprimida: ${transcript.length} → ${compressedSegments.length} líneas`);

  try {
    state.isAnalyzing = true;
    updateTranscriptPanelStatus();

    const response = await browserAPI.runtime.sendMessage({
      action: 'analyzeTranscript',
      apiKey,
      transcriptText,
      transcript
    });

    state.isAnalyzing = false;

    if (!response.success) {
      const errMsg = response.error || 'Error desconocido';

      // Rate limit: auto-retry con backoff
      if (errMsg.includes('rate limit') || errMsg.includes('429') || errMsg.includes('Límite de rate')) {
        if (retryCount < 3) {
          const waitSec = Math.pow(2, retryCount) * 5; // 5s, 10s, 20s
          Log.warn(`Rate limit alcanzado. Reintentando en ${waitSec}s (intento ${retryCount + 1}/3)...`);
          showToast(`Rate limit. Reintentando en ${waitSec}s...`, waitSec * 1000);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          return analyzeWithGroq(transcript, retryCount + 1);
        }
        Log.error('Rate limit: máximo de reintentos alcanzado');
        showToast('Rate limit alcanzado. Intenta de nuevo más tarde.', 5000);
        return { sponsors: [], has_sponsors: false };
      }

      throw new Error(errMsg);
    }

    Log.info(`Análisis completado: ${response.data.sponsors.length} sponsors detectados`);
    return response.data;

  } catch (error) {
    state.isAnalyzing = false;
    Log.error('Error analizando con Groq', error.message);
    showToast(`Error: ${error.message}`, 5000);
    return { sponsors: [], has_sponsors: false };
  }
}

// ============================================================
// BOTÓN SKIP SPONSOR (idéntico al ytp-skip-ad-button de YouTube)
// ============================================================

function createSkipButton() {
  const btn = document.createElement('button');
  btn.className = 'ytp-skip-ad-button yt-skip-sponsor-btn';
  btn.setAttribute('data-tooltip-target', 'yt-skip-sponsor-tooltip');

  const textDiv = document.createElement('div');
  textDiv.className = 'ytp-skip-ad-button__text';
  textDiv.textContent = 'Skip sponsor';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'ytp-skip-ad-button__icon';
  iconSpan.innerHTML = `<svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M20 20C20.26 20 20.51 19.89 20.70 19.70C20.89 19.51 21 19.26 21 19V5C21 4.73 20.89 4.48 20.70 4.29C20.51 4.10 20.26 4 20 4C19.73 4 19.48 4.10 19.29 4.29C19.10 4.48 19 4.73 19 5V19C19 19.26 19.10 19.51 19.29 19.70C19.48 19.89 19.73 20 20 20ZM5.04 19.77L18 12L5.04 4.22C4.84 4.10 4.60 4.03 4.36 4.03C4.12 4.03 3.89 4.09 3.68 4.21C3.47 4.32 3.30 4.49 3.18 4.70C3.06 4.91 2.99 5.14 3 5.38V18.61C2.99 18.85 3.06 19.08 3.18 19.29C3.30 19.50 3.47 19.67 3.68 19.79C3.89 19.90 4.12 19.96 4.36 19.96C4.60 19.96 4.84 19.89 5.04 19.77Z" fill="white"></path></svg>`;

  btn.appendChild(textDiv);
  btn.appendChild(iconSpan);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    skipSponsor();
  });

  return btn;
}

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
  Log.debug(`Botón Skip mostrado [${formatTime(sponsor.start)} → ${formatTime(sponsor.end)}]`);
}

function removeSkipButton() {
  if (state.skipButton) { state.skipButton.remove(); state.skipButton = null; }
  document.querySelectorAll('.yt-skip-sponsor-btn').forEach(el => el.remove());
}

function skipSponsor() {
  const video = document.querySelector('video');
  if (!video || !state.skipButton) return;

  const endTime = parseFloat(state.skipButton.dataset.sponsorEnd);
  const sponsorIndex = parseInt(state.skipButton.dataset.sponsorIndex);

  video.currentTime = endTime;
  removeSkipButton();
  Log.info(`Sponsor saltado a ${formatTime(endTime)}`);

  if (sponsorIndex >= 0 && sponsorIndex < state.sponsors.length) {
    showConfirmationPanel(state.sponsors[sponsorIndex], sponsorIndex);
  }
}

// ============================================================
// CONFIRMACIÓN Y EDICIÓN DE TIMESTAMPS
// ============================================================

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

  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('mouseup', (e) => e.stopPropagation());

  playerContainer.appendChild(panel);
  state.confirmationPanel = panel;

  panel.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    saveFeedback(state.videoId, index, { correct: true, timestamp: Date.now() });
    removeConfirmationPanel();
    showToast('¡Gracias por el feedback! ✓', 2000);
  });

  panel.querySelector('[data-action="edit"]').addEventListener('click', () => {
    showEditPanel(sponsor, index);
  });

  // Auto-cerrar panel de confirmación después de 8s (NO el de edición)
  setTimeout(() => {
    if (state.confirmationPanel === panel) removeConfirmationPanel();
  }, 8000);
}

function showEditPanel(sponsor, index) {
  removeConfirmationPanel();
  // Limpiar timer de auto-cierre anterior si existe
  if (state.editPanelAutoCloseTimer) { clearTimeout(state.editPanelAutoCloseTimer); state.editPanelAutoCloseTimer = null; }

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
        <label>Inicio:</label>
        <input type="text" class="yt-skip-time-input" id="yt-skip-edit-start" value="${formatTime(sponsor.start)}" />
      </div>
      <div class="yt-skip-edit-field">
        <label>Fin:</label>
        <input type="text" class="yt-skip-time-input" id="yt-skip-edit-end" value="${formatTime(sponsor.end)}" />
      </div>
    </div>
    <div class="yt-skip-confirmation-actions">
      <button class="yt-skip-btn-confirm" data-action="save">Guardar corrección</button>
      <button class="yt-skip-btn-cancel" data-action="cancel">Cancelar</button>
    </div>
  `;

  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('mouseup', (e) => e.stopPropagation());

  const inputs = panel.querySelectorAll('input');
  inputs.forEach(input => {
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
  });

  playerContainer.appendChild(panel);
  state.confirmationPanel = panel;

  // Foco al primer input
  setTimeout(() => { const firstInput = document.getElementById('yt-skip-edit-start'); if (firstInput) firstInput.select(); }, 100);

  panel.querySelector('[data-action="save"]').addEventListener('click', () => {
    const startStr = document.getElementById('yt-skip-edit-start').value;
    const endStr = document.getElementById('yt-skip-edit-end').value;
    const newStart = parseTimeInput(startStr);
    const newEnd = parseTimeInput(endStr);

    if (newStart === null || newEnd === null) { showToast('Formato inválido. Usa MM:SS o H:MM:SS', 3000); return; }
    if (newEnd <= newStart) { showToast('El fin debe ser mayor que el inicio', 3000); return; }

    state.sponsors[index].start = newStart;
    state.sponsors[index].end = newEnd;

    cacheSponsors(state.videoId, { sponsors: state.sponsors, has_sponsors: state.sponsors.length > 0 });
    saveFeedback(state.videoId, index, { correct: false, edited: true, newStart, newEnd, timestamp: Date.now() });

    removeConfirmationPanel();
    showToast('Corrección guardada ✓', 2000);
    Log.info(`Sponsor editado: ${formatTime(newStart)} → ${formatTime(newEnd)}`);
    updateTranscriptPanel();
    startVideoMonitor(); // Reiniciar monitor con los nuevos timestamps
  });

  panel.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    removeConfirmationPanel();
  });

  // NO auto-cerrar el panel de edición — espera hasta que el usuario presione Guardar o Cancelar
}

function removeConfirmationPanel() {
  if (state.editPanelAutoCloseTimer) { clearTimeout(state.editPanelAutoCloseTimer); state.editPanelAutoCloseTimer = null; }
  if (state.confirmationPanel) { state.confirmationPanel.remove(); state.confirmationPanel = null; }
  document.querySelectorAll('.yt-skip-confirmation-panel').forEach(el => el.remove());
}

// ============================================================
// PANEL DE TRANSCRIPCIÓN Y SPONSORS
// ============================================================

function updateTranscriptPanelStatus() {
  const statusEl = document.querySelector('.yt-skip-panel-status');
  if (!statusEl) return;
  if (state.isAnalyzing) statusEl.innerHTML = '<span class="yt-skip-analyzing">Analizando con IA...</span>';
  else if (state.sponsors.length > 0) statusEl.innerHTML = `<span class="yt-skip-found">${state.sponsors.length} sponsor${state.sponsors.length > 1 ? 's' : ''} detectado${state.sponsors.length > 1 ? 's' : ''}</span>`;
  else if (state.transcript.length > 0) statusEl.innerHTML = '<span class="yt-skip-no-sponsors">Sin sponsors detectados</span>';
  else statusEl.innerHTML = '<span class="yt-skip-no-transcript">Sin transcripción</span>';
}

function updateTranscriptPanel() {
  const contentEl = document.querySelector('.yt-skip-panel-content');
  if (!contentEl) return;

  let html = '';
  state.transcript.forEach((seg) => {
    const isSponsor = state.sponsors.some(s => seg.time >= s.start && seg.time <= s.end);
    const sponsorData = state.sponsors.find(s => seg.time >= s.start && seg.time <= s.end);
    const segmentClass = isSponsor ? 'yt-skip-transcript-segment yt-skip-transcript-sponsor' : 'yt-skip-transcript-segment';
    const sponsorLabel = sponsorData ? `<span class="yt-skip-sponsor-label">[SPONSOR: ${sponsorData.brand || 'Desconocido'}]</span> ` : '';
    const editBtn = sponsorData ? `<button class="yt-skip-edit-segment-btn" data-index="${state.sponsors.indexOf(sponsorData)}">✎</button>` : '';
    html += `<div class="${segmentClass}"><span class="yt-skip-timestamp" data-time="${seg.time}">${formatTime(seg.time)}</span>${sponsorLabel}${seg.text}${editBtn}</div>`;
  });
  contentEl.innerHTML = html;

  contentEl.querySelectorAll('.yt-skip-timestamp').forEach(el => {
    el.addEventListener('click', () => {
      const time = parseFloat(el.dataset.time);
      const video = document.querySelector('video');
      if (video) video.currentTime = time;
    });
  });

  contentEl.querySelectorAll('.yt-skip-edit-segment-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(el.dataset.index);
      if (index >= 0 && index < state.sponsors.length) showEditPanel(state.sponsors[index], index);
    });
  });

  updateTranscriptPanelStatus();
}

function toggleTranscriptPanel() {
  if (state.transcriptPanel) { state.transcriptPanel.remove(); state.transcriptPanel = null; return; }

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

  panel.querySelector('.yt-skip-panel-close').addEventListener('click', () => { panel.remove(); state.transcriptPanel = null; });

  document.addEventListener('click', function closePanel(e) {
    if (state.transcriptPanel !== panel) { document.removeEventListener('click', closePanel); return; }
    if (!panel.contains(e.target) && !e.target.closest('.yt-skip-transcript-btn')) {
      panel.remove(); state.transcriptPanel = null; document.removeEventListener('click', closePanel);
    }
  });

  updateTranscriptPanel();
}

function addTranscriptButton() {
  document.querySelectorAll('.yt-skip-transcript-btn').forEach(el => el.remove());
  const titleContainer = document.querySelector('#above-the-fold') ||
                         document.querySelector('#info-contents') ||
                         document.querySelector('ytd-video-primary-info-renderer');
  if (!titleContainer) return;
  const btn = document.createElement('button');
  btn.className = 'yt-skip-transcript-btn';
  btn.innerHTML = '📋 Ver transcripción';
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleTranscriptPanel(); });
  titleContainer.appendChild(btn);
}

// ============================================================
// MONITOREO DEL TIEMPO DEL VIDEO
// ============================================================

function startVideoMonitor() {
  stopVideoMonitor();
  state.monitorInterval = setInterval(() => {
    const video = document.querySelector('video');
    if (!video || state.sponsors.length === 0) return;
    const currentTime = video.currentTime;

    let activeSponsorIndex = -1;
    for (let i = 0; i < state.sponsors.length; i++) {
      const sponsor = state.sponsors[i];
      if (currentTime >= sponsor.start - 1 && currentTime < sponsor.end) { activeSponsorIndex = i; break; }
    }

    if (activeSponsorIndex >= 0) {
      if (!state.skipButton || parseInt(state.skipButton.dataset.sponsorIndex) !== activeSponsorIndex) {
        showSkipButton(state.sponsors[activeSponsorIndex]);
        state.currentSponsorIndex = activeSponsorIndex;
      }
    } else if (state.skipButton) {
      removeSkipButton();
      state.currentSponsorIndex = -1;
    }
  }, 500);
}

function stopVideoMonitor() {
  if (state.monitorInterval) { clearInterval(state.monitorInterval); state.monitorInterval = null; }
}

// ============================================================
// MANEJO DE NAVEGACIÓN SPA
// ============================================================

function cleanup() {
  stopVideoMonitor();
  removeSkipButton();
  removeConfirmationPanel();
  if (state.transcriptPanel) { state.transcriptPanel.remove(); state.transcriptPanel = null; }
  document.querySelectorAll('.yt-skip-transcript-btn').forEach(el => el.remove());
  state.videoId = null;
  state.transcript = [];
  state.sponsors = [];
  state.isAnalyzing = false;
  state.currentSponsorIndex = -1;
}

async function processVideo() {
  const videoId = getVideoId();
  if (!videoId) return;
  if (state.videoId === videoId && state.transcript.length > 0) return;

  cleanup();
  state.videoId = videoId;
  Log.info(`Procesando video: ${videoId}`);

  const cached = await getCachedSponsors(videoId);
  if (cached && cached.sponsors && cached.sponsors.length > 0) {
    Log.info('Video ya analizado, cargando desde cache');
    state.sponsors = cached.sponsors;
  }

  await waitForVideo();

  if (state.sponsors.length > 0) {
    Log.info('Iniciando monitoreo con sponsors de caché');
    startVideoMonitor();
  }

  addTranscriptButton();

  const transcript = await scrapeTranscript();
  if (transcript.length === 0) {
    if (state.sponsors.length > 0) updateTranscriptPanel();
    return;
  }

  state.transcript = transcript;

  if (cached && cached.sponsors && cached.sponsors.length > 0) {
    updateTranscriptPanel();
    return;
  }

  const result = await analyzeWithGroq(transcript);
  state.sponsors = result.sponsors || [];
  await cacheSponsors(videoId, result);
  updateTranscriptPanel();

  if (state.sponsors.length > 0 && !state.monitorInterval) startVideoMonitor();
}

function setupSPANavigation() {
  window.addEventListener('yt-navigate-finish', () => {
    Log.info('Navegación SPA detectada (yt-navigate-finish)');
    setTimeout(() => processVideo(), 1500);
  });

  let lastUrl = window.location.href;
  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch') {
        Log.info('Cambio de URL detectado');
        setTimeout(() => processVideo(), 1500);
      }
    }
  }, 1000);
}

// ============================================================
// INICIALIZACIÓN
// ============================================================

async function init() {
  Log.info('Extensión YT Sponsor Skip cargada');
  setupSPANavigation();
  if (window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch') {
    setTimeout(() => processVideo(), 2000);
  }
}

init();
