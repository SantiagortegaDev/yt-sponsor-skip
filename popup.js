/**
 * popup.js — Lógica del popup de configuración de YT Sponsor Skip
 * Incluye visor de logs
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('api-key-input');
  const saveBtn = document.getElementById('save-btn');
  const testBtn = document.getElementById('test-btn');
  const toggleBtn = document.getElementById('toggle-visibility');
  const statusEl = document.getElementById('api-key-status');
  const testResultEl = document.getElementById('test-result');
  const logsContainer = document.getElementById('logs-container');
  const refreshLogsBtn = document.getElementById('refresh-logs-btn');
  const clearLogsBtn = document.getElementById('clear-logs-btn');

  // Cargar API key guardada
  try {
    const result = await browserAPI.storage.local.get('groqApiKey');
    if (result.groqApiKey) { apiKeyInput.value = result.groqApiKey; updateStatus(true); }
  } catch (error) { console.error('[YT-Skip] Error cargando API key:', error); }

  // Cargar logs
  loadLogs();

  // Toggle visibilidad
  toggleBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') { apiKeyInput.type = 'text'; toggleBtn.textContent = '🔒'; }
    else { apiKeyInput.type = 'password'; toggleBtn.textContent = '👁'; }
  });

  // Guardar API key
  saveBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) { showTestResult(false, 'La API Key no puede estar vacía.'); return; }
    if (!apiKey.startsWith('gsk_')) { showTestResult(false, 'La API Key debe comenzar con "gsk_".'); return; }
    try {
      await browserAPI.storage.local.set({ groqApiKey: apiKey });
      updateStatus(true);
      showTestResult(true, 'API Key guardada ✓');
    } catch (error) { showTestResult(false, `Error al guardar: ${error.message}`); }
  });

  // Probar conexión
  testBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) { showTestResult(false, 'Ingresa una API Key primero.'); return; }
    testBtn.disabled = true;
    testBtn.textContent = 'Probando...';
    try {
      const response = await browserAPI.runtime.sendMessage({ action: 'testGroqConnection', apiKey });
      showTestResult(response.success, response.message);
      if (response.success) { await browserAPI.storage.local.set({ groqApiKey: apiKey }); updateStatus(true); }
    } catch (error) { showTestResult(false, `Error: ${error.message}`); }
    finally { testBtn.disabled = false; testBtn.textContent = 'Probar conexión'; }
  });

  // Refrescar logs
  refreshLogsBtn.addEventListener('click', loadLogs);

  // Limpiar logs
  clearLogsBtn.addEventListener('click', async () => {
    try {
      await browserAPI.runtime.sendMessage({ action: 'clearLogs' });
      logsContainer.innerHTML = '<div class="popup-logs-empty">Logs limpiados</div>';
    } catch (_) {}
  });

  function updateStatus(hasKey) {
    if (hasKey) { statusEl.textContent = 'API Key guardada ✓'; statusEl.className = 'popup-status popup-status-ok'; }
    else { statusEl.textContent = 'API Key no configurada'; statusEl.className = 'popup-status popup-status-error'; }
  }

  function showTestResult(success, message) {
    testResultEl.style.display = 'block';
    testResultEl.textContent = message;
    testResultEl.className = `popup-test-result ${success ? 'test-success' : 'test-error'}`;
    setTimeout(() => { testResultEl.style.display = 'none'; }, 5000);
  }

  async function loadLogs() {
    try {
      const response = await browserAPI.runtime.sendMessage({ action: 'getLogs' });
      const logs = response?.logs || [];

      if (logs.length === 0) {
        logsContainer.innerHTML = '<div class="popup-logs-empty">Sin logs</div>';
        return;
      }

      // Mostrar los últimos 50 logs (los más recientes al final)
      const recentLogs = logs.slice(-50);
      let html = '';
      for (const entry of recentLogs) {
        const levelClass = `log-level-${(entry.level || 'INFO').toLowerCase()}`;
        const levelBadge = entry.level || 'INFO';
        const msg = escapeHtml(entry.msg || '');
        const dataStr = entry.data ? ` ${escapeHtml(typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data))}` : '';
        html += `<div class="popup-log-entry"><span class="log-ts">${entry.ts || ''}</span><span class="${levelClass}">${levelBadge}</span><span class="log-msg">${msg}${dataStr}</span></div>`;
      }
      logsContainer.innerHTML = html;
      logsContainer.scrollTop = logsContainer.scrollHeight;
    } catch (error) {
      logsContainer.innerHTML = `<div class="popup-logs-empty">Error cargando logs</div>`;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Auto-refrescar logs cada 3 segundos mientras el popup está abierto
  setInterval(loadLogs, 3000);
});
