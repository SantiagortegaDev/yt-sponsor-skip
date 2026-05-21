/**
 * popup.js — Lógica del popup de configuración de YT Sponsor Skip
 */

// Compatibilidad Firefox/Chrome
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('api-key-input');
  const saveBtn = document.getElementById('save-btn');
  const testBtn = document.getElementById('test-btn');
  const toggleBtn = document.getElementById('toggle-visibility');
  const statusEl = document.getElementById('api-key-status');
  const testResultEl = document.getElementById('test-result');

  // Cargar API key guardada
  try {
    const result = await browserAPI.storage.local.get('groqApiKey');
    if (result.groqApiKey) {
      apiKeyInput.value = result.groqApiKey;
      updateStatus(true);
    }
  } catch (error) {
    console.error('[YT-Skip] Error cargando API key:', error);
  }

  // Toggle visibilidad de la API key
  toggleBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleBtn.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleBtn.textContent = '👁';
    }
  });

  // Guardar API key
  saveBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showTestResult(false, 'La API Key no puede estar vacía.');
      return;
    }

    if (!apiKey.startsWith('gsk_')) {
      showTestResult(false, 'La API Key debe comenzar con "gsk_".');
      return;
    }

    try {
      await browserAPI.storage.local.set({ groqApiKey: apiKey });
      updateStatus(true);
      showTestResult(true, 'API Key guardada ✓');
    } catch (error) {
      showTestResult(false, `Error al guardar: ${error.message}`);
    }
  });

  // Probar conexión
  testBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showTestResult(false, 'Ingresa una API Key primero.');
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Probando...';

    try {
      const response = await browserAPI.runtime.sendMessage({
        action: 'testGroqConnection',
        apiKey: apiKey
      });

      showTestResult(response.success, response.message);

      if (response.success) {
        // También guardar la key si la prueba es exitosa
        await browserAPI.storage.local.set({ groqApiKey: apiKey });
        updateStatus(true);
      }
    } catch (error) {
      showTestResult(false, `Error: ${error.message}`);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Probar conexión';
    }
  });

  /**
   * Actualiza el indicador de estado de la API key
   */
  function updateStatus(hasKey) {
    if (hasKey) {
      statusEl.textContent = 'API Key guardada ✓';
      statusEl.className = 'popup-status popup-status-ok';
    } else {
      statusEl.textContent = 'API Key no configurada';
      statusEl.className = 'popup-status popup-status-error';
    }
  }

  /**
   * Muestra el resultado de la prueba de conexión
   */
  function showTestResult(success, message) {
    testResultEl.style.display = 'block';
    testResultEl.textContent = message;
    testResultEl.className = `popup-test-result ${success ? 'test-success' : 'test-error'}`;

    // Auto-ocultar después de 5 segundos
    setTimeout(() => {
      testResultEl.style.display = 'none';
    }, 5000);
  }
});
