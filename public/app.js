const STORAGE_KEYS = {
  baseUrl: 'telegramConnector.baseUrl',
  apiKey: 'telegramConnector.apiKey',
};

const state = {
  baseUrl: localStorage.getItem(STORAGE_KEYS.baseUrl) || window.location.origin,
  apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) || '',
  sessions: [],
  webhooks: [],
  editingSessionName: null,
};

const els = {
  serviceStatus: document.getElementById('serviceStatus'),
  settingsForm: document.getElementById('settingsForm'),
  baseUrlInput: document.getElementById('baseUrlInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  clearSettingsBtn: document.getElementById('clearSettingsBtn'),
  checkStatusBtn: document.getElementById('checkStatusBtn'),
  sessionForm: document.getElementById('sessionForm'),
  sessionFormTitle: document.getElementById('sessionFormTitle'),
  sessionNameInput: document.getElementById('sessionNameInput'),
  sessionApiIdInput: document.getElementById('sessionApiIdInput'),
  sessionApiHashInput: document.getElementById('sessionApiHashInput'),
  sessionPhoneInput: document.getElementById('sessionPhoneInput'),
  sessionStringInput: document.getElementById('sessionStringInput'),
  sessionSendCodeInput: document.getElementById('sessionSendCodeInput'),
  sessionStartInput: document.getElementById('sessionStartInput'),
  saveSessionBtn: document.getElementById('saveSessionBtn'),
  cancelSessionEditBtn: document.getElementById('cancelSessionEditBtn'),
  loginConfirmForm: document.getElementById('loginConfirmForm'),
  loginSessionInput: document.getElementById('loginSessionInput'),
  loginCodeInput: document.getElementById('loginCodeInput'),
  loginPasswordInput: document.getElementById('loginPasswordInput'),
  loginResult: document.getElementById('loginResult'),
  refreshSessionsBtn: document.getElementById('refreshSessionsBtn'),
  sessionsList: document.getElementById('sessionsList'),
  sendSessionSelect: document.getElementById('sendSessionSelect'),
  activeSessionLabel: document.getElementById('activeSessionLabel'),
  recipientTypeInput: document.getElementById('recipientTypeInput'),
  recipientValueInput: document.getElementById('recipientValueInput'),
  sendTextForm: document.getElementById('sendTextForm'),
  messageTextInput: document.getElementById('messageTextInput'),
  sendMediaForm: document.getElementById('sendMediaForm'),
  mediaUrlInput: document.getElementById('mediaUrlInput'),
  mediaCaptionInput: document.getElementById('mediaCaptionInput'),
  sendResult: document.getElementById('sendResult'),
  refreshWebhooksBtn: document.getElementById('refreshWebhooksBtn'),
  createWebhookForm: document.getElementById('createWebhookForm'),
  webhookUrlInput: document.getElementById('webhookUrlInput'),
  webhookSessionInput: document.getElementById('webhookSessionInput'),
  webhookSecretInput: document.getElementById('webhookSecretInput'),
  webhooksList: document.getElementById('webhooksList'),
  toast: document.getElementById('toast'),
};

const ALL_EVENTS = [
  'message.received',
  'message.edited',
  'message.deleted',
  'message.sent',
  'session.status',
  'session.error',
];

init();

function init() {
  els.baseUrlInput.value = state.baseUrl;
  els.apiKeyInput.value = state.apiKey;

  els.settingsForm.addEventListener('submit', onSaveSettings);
  els.clearSettingsBtn.addEventListener('click', onClearSettings);
  els.checkStatusBtn.addEventListener('click', checkServiceStatus);
  els.sessionForm.addEventListener('submit', onSaveSession);
  els.cancelSessionEditBtn.addEventListener('click', resetSessionForm);
  els.loginConfirmForm.addEventListener('submit', onConfirmLogin);
  els.refreshSessionsBtn.addEventListener('click', refreshSessions);
  els.refreshWebhooksBtn.addEventListener('click', refreshWebhooks);
  els.sendTextForm.addEventListener('submit', onSendText);
  els.sendMediaForm.addEventListener('submit', onSendMedia);
  els.createWebhookForm.addEventListener('submit', onCreateWebhook);
  els.sendSessionSelect.addEventListener('change', updateActiveSessionLabel);

  void checkServiceStatus();
  if (state.apiKey) {
    void refreshAll();
  } else {
    renderSessions();
    renderWebhooks();
  }
}

async function refreshAll() {
  await Promise.allSettled([refreshSessions(), refreshWebhooks()]);
}

function onSaveSettings(event) {
  event.preventDefault();
  state.baseUrl = normalizeBaseUrl(els.baseUrlInput.value);
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem(STORAGE_KEYS.baseUrl, state.baseUrl);
  localStorage.setItem(STORAGE_KEYS.apiKey, state.apiKey);
  els.baseUrlInput.value = state.baseUrl;
  showToast('Settings saved.');
  void checkServiceStatus();
  void refreshAll();
}

function onClearSettings() {
  state.baseUrl = window.location.origin;
  state.apiKey = '';
  localStorage.removeItem(STORAGE_KEYS.baseUrl);
  localStorage.removeItem(STORAGE_KEYS.apiKey);
  els.baseUrlInput.value = state.baseUrl;
  els.apiKeyInput.value = '';
  state.sessions = [];
  state.webhooks = [];
  renderSessions();
  renderWebhooks();
  showToast('Settings cleared.');
}

async function checkServiceStatus() {
  try {
    const health = await fetchJson('/health', { auth: false });
    const ready = await fetchJson('/ready', { auth: false });
    setServiceStatus(
      health.ok && ready.ready ? 'ok' : 'warn',
      health.ok && ready.ready ? 'Online' : 'Degraded',
    );
  } catch (error) {
    setServiceStatus('error', error.message);
  }
}

async function refreshSessions() {
  try {
    const data = await fetchJson('/api/sessions');
    state.sessions = data.sessions || [];
    renderSessions();
  } catch (error) {
    showError(error);
    state.sessions = [];
    renderSessions();
  }
}

function renderSessions() {
  els.sessionsList.innerHTML = '';
  els.sendSessionSelect.innerHTML = '';

  if (!state.apiKey) {
    els.sessionsList.append(emptyState('Save the API key to load sessions.'));
    updateActiveSessionLabel();
    return;
  }

  if (state.sessions.length === 0) {
    els.sessionsList.append(emptyState('No sessions found.'));
    updateActiveSessionLabel();
    return;
  }

  for (const session of state.sessions) {
    const option = document.createElement('option');
    option.value = session.name;
    option.textContent = session.name;
    els.sendSessionSelect.append(option);

    const card = document.createElement('article');
    card.className = 'row-card';
    card.innerHTML = `
      <div class="row-card-head">
        <div>
          <div class="row-title">${escapeHtml(session.name)}</div>
          <div class="meta">
            <span>Updated: ${formatDate(session.updatedAt)}</span>
            <span>API ID: ${escapeHtml(session.apiId || 'missing')}</span>
            <span>StringSession: ${session.hasStringSession ? 'present' : 'missing'}</span>
            ${session.lastError ? `<span>Detail: ${escapeHtml(session.lastError)}</span>` : ''}
            ${
              session.status === 'auth_required'
                ? '<span>Send a login code or import an existing StringSession.</span>'
                : ''
            }
          </div>
        </div>
        <span class="badge ${escapeAttr(session.status)}">${escapeHtml(session.status)}</span>
      </div>
      <div class="button-row">
        <button type="button" data-action="start">Start</button>
        <button type="button" class="secondary" data-action="stop">Stop</button>
        <button type="button" class="secondary" data-action="code">Send Code</button>
        <button type="button" class="secondary" data-action="edit">Edit</button>
        <button type="button" class="danger" data-action="delete">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="start"]').addEventListener('click', () => {
      void sessionAction(session.name, 'start');
    });
    card.querySelector('[data-action="stop"]').addEventListener('click', () => {
      void sessionAction(session.name, 'stop');
    });
    card.querySelector('[data-action="code"]').addEventListener('click', () => {
      void requestLoginCode(session.name);
    });
    card.querySelector('[data-action="edit"]').addEventListener('click', () => {
      enterSessionEditMode(session);
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      void deleteSession(session.name);
    });
    els.sessionsList.append(card);
  }

  updateActiveSessionLabel();
}

async function onSaveSession(event) {
  event.preventDefault();

  const name = els.sessionNameInput.value.trim();
  const apiIdValue = els.sessionApiIdInput.value.trim();
  const apiHash = els.sessionApiHashInput.value.trim();
  const phoneNumber = els.sessionPhoneInput.value.trim();
  const stringSession = els.sessionStringInput.value.trim();
  const sendCodeAfterSave = els.sessionSendCodeInput.checked;
  const startAfterSave = els.sessionStartInput.checked;
  const targetSessionName = state.editingSessionName || name;

  try {
    if (state.editingSessionName) {
      const body = {};
      if (apiIdValue) body.apiId = Number(apiIdValue);
      if (apiHash) body.apiHash = apiHash;
      if (stringSession) body.stringSession = stringSession;

      const hasCredentialUpdate = Object.keys(body).length > 0;
      if (!hasCredentialUpdate && !(phoneNumber && sendCodeAfterSave)) {
        showToast('Enter at least one credential field to update.');
        return;
      }

      if (hasCredentialUpdate) {
        await fetchJson(`/api/sessions/${encodeURIComponent(state.editingSessionName)}`, {
          method: 'PATCH',
          body,
        });
      }

      if (hasCredentialUpdate && stringSession && startAfterSave) {
        await fetchJson(
          `/api/sessions/${encodeURIComponent(state.editingSessionName)}/start`,
          { method: 'POST' },
        );
      }
      if (phoneNumber && sendCodeAfterSave) {
        await requestLoginCode(state.editingSessionName, phoneNumber);
      }
      showToast('Session updated.');
    } else {
      await fetchJson('/api/sessions', {
        method: 'POST',
        body: {
          name,
          apiId: Number(apiIdValue),
          apiHash,
          stringSession: stringSession || undefined,
          start: Boolean(stringSession && startAfterSave),
        },
      });
      if (phoneNumber && sendCodeAfterSave) {
        await requestLoginCode(name, phoneNumber);
      }
      showToast('Session added.');
    }

    resetSessionForm();
    await refreshSessions();
    if (phoneNumber && sendCodeAfterSave) {
      els.loginSessionInput.value = targetSessionName;
      els.loginCodeInput.focus();
    }
  } catch (error) {
    showError(error);
    await refreshSessions().catch(() => undefined);
  }
}

function enterSessionEditMode(session) {
  state.editingSessionName = session.name;
  els.sessionFormTitle.textContent = `Edit ${session.name}`;
  els.saveSessionBtn.textContent = 'Update Session';
  els.cancelSessionEditBtn.hidden = false;
  els.sessionNameInput.value = session.name;
  els.sessionNameInput.disabled = true;
  els.sessionApiIdInput.value = session.apiId || '';
  els.sessionApiHashInput.value = '';
  els.sessionPhoneInput.value = '';
  els.sessionStringInput.value = '';
  els.sessionSendCodeInput.checked = false;
  els.sessionStartInput.checked = false;
  els.sessionApiHashInput.placeholder = 'Leave blank to keep current hash';
  els.sessionStringInput.placeholder = 'Leave blank to keep current StringSession';
  els.sessionForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetSessionForm() {
  state.editingSessionName = null;
  els.sessionForm.reset();
  els.sessionFormTitle.textContent = 'Add Session';
  els.saveSessionBtn.textContent = 'Add Session';
  els.cancelSessionEditBtn.hidden = true;
  els.sessionNameInput.disabled = false;
  els.sessionApiHashInput.placeholder = '';
  els.sessionStringInput.placeholder = '';
  els.sessionSendCodeInput.checked = true;
}

async function deleteSession(sessionName) {
  const confirmed = window.confirm(`Delete session "${sessionName}"?`);
  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(`/api/sessions/${encodeURIComponent(sessionName)}`, {
      method: 'DELETE',
    });
    if (state.editingSessionName === sessionName) {
      resetSessionForm();
    }
    showToast('Session deleted.');
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function requestLoginCode(sessionName, providedPhoneNumber) {
  const phoneNumber =
    providedPhoneNumber ||
    window.prompt(`Phone number for "${sessionName}" including country code`);
  if (!phoneNumber || !phoneNumber.trim()) {
    return;
  }

  try {
    const result = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionName)}/login/code`,
      {
        method: 'POST',
        body: {
          phoneNumber: phoneNumber.trim(),
        },
      },
    );
    renderLoginResult(result);
    els.loginSessionInput.value = sessionName;
    els.loginCodeInput.value = '';
    els.loginPasswordInput.value = '';
    showToast(
      result.login?.isCodeViaApp
        ? 'Login code sent to the Telegram app.'
        : 'Login code sent.',
    );
    await refreshSessions();
  } catch (error) {
    renderLoginResult(errorToResult(error));
    showError(error);
  }
}

async function onConfirmLogin(event) {
  event.preventDefault();
  const sessionName = els.loginSessionInput.value.trim();
  if (!sessionName) {
    showToast('Enter the session name first.');
    return;
  }

  const code = els.loginCodeInput.value.trim();
  const password = els.loginPasswordInput.value;
  if (!code && !password) {
    showToast('Enter the login code or 2FA password.');
    return;
  }

  try {
    const result = await fetchJson(
      `/api/sessions/${encodeURIComponent(sessionName)}/login/confirm`,
      {
        method: 'POST',
        body: {
          code: code || undefined,
          password: password || undefined,
        },
      },
    );
    renderLoginResult(result);

    if (result.login?.status === 'password_required') {
      showToast('Telegram 2FA password required.');
      els.loginPasswordInput.focus();
    } else {
      showToast('Telegram session connected.');
      els.loginCodeInput.value = '';
      els.loginPasswordInput.value = '';
    }
    await refreshSessions();
  } catch (error) {
    renderLoginResult(errorToResult(error));
    showError(error);
    await refreshSessions().catch(() => undefined);
  }
}

async function sessionAction(sessionName, action) {
  try {
    await fetchJson(`/api/sessions/${encodeURIComponent(sessionName)}/${action}`, {
      method: 'POST',
    });
    showToast(`Session ${action} requested.`);
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function onSendText(event) {
  event.preventDefault();
  const session = readSelectedSession();
  if (!session) return;

  try {
    const result = await fetchJson(
      `/api/sessions/${encodeURIComponent(session)}/messages/text`,
      {
        method: 'POST',
        body: {
          to: readRecipient(),
          text: els.messageTextInput.value,
        },
      },
    );
    renderResult(result);
    showToast('Text message sent.');
  } catch (error) {
    renderResult(errorToResult(error));
    showError(error);
  }
}

async function onSendMedia(event) {
  event.preventDefault();
  const session = readSelectedSession();
  if (!session) return;

  try {
    const result = await fetchJson(
      `/api/sessions/${encodeURIComponent(session)}/messages/media`,
      {
        method: 'POST',
        body: {
          to: readRecipient(),
          mediaUrl: els.mediaUrlInput.value.trim(),
          caption: els.mediaCaptionInput.value.trim() || undefined,
        },
      },
    );
    renderResult(result);
    showToast('Media message sent.');
  } catch (error) {
    renderResult(errorToResult(error));
    showError(error);
  }
}

function readSelectedSession() {
  const session = els.sendSessionSelect.value;
  if (!session) {
    showToast('Select a session first.');
    return null;
  }
  return session;
}

function readRecipient() {
  return {
    type: els.recipientTypeInput.value,
    value: els.recipientValueInput.value.trim(),
  };
}

function updateActiveSessionLabel() {
  const session = els.sendSessionSelect.value;
  els.activeSessionLabel.textContent = session ? `Active: ${session}` : 'No session selected';
}

async function refreshWebhooks() {
  try {
    const data = await fetchJson('/api/webhooks');
    state.webhooks = data.webhooks || [];
    renderWebhooks();
  } catch (error) {
    showError(error);
    state.webhooks = [];
    renderWebhooks();
  }
}

function renderWebhooks() {
  els.webhooksList.innerHTML = '';

  if (!state.apiKey) {
    els.webhooksList.append(emptyState('Save the API key to load webhooks.'));
    return;
  }

  if (state.webhooks.length === 0) {
    els.webhooksList.append(emptyState('No webhooks configured.'));
    return;
  }

  for (const webhook of state.webhooks) {
    const card = document.createElement('article');
    card.className = 'row-card';
    card.innerHTML = `
      <div class="row-card-head">
        <div>
          <div class="row-title">${escapeHtml(webhook.url)}</div>
          <div class="meta">
            <span>Session: ${escapeHtml(webhook.session || 'all')}</span>
            <span>Events: ${escapeHtml((webhook.events || []).join(', '))}</span>
            <span>Created: ${formatDate(webhook.createdAt)}</span>
          </div>
        </div>
        <span class="badge connected">active</span>
      </div>
      <div class="button-row">
        <button type="button" data-action="test">Test</button>
        <button type="button" class="danger" data-action="delete">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="test"]').addEventListener('click', () => {
      void testWebhook(webhook.id);
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      void deleteWebhook(webhook.id);
    });
    els.webhooksList.append(card);
  }
}

async function onCreateWebhook(event) {
  event.preventDefault();
  const events = [...els.createWebhookForm.querySelectorAll('.events input:checked')].map(
    (input) => input.value,
  );

  if (events.length === 0) {
    showToast('Select at least one event.');
    return;
  }

  try {
    await fetchJson('/api/webhooks', {
      method: 'POST',
      body: {
        url: els.webhookUrlInput.value.trim(),
        events,
        secret: els.webhookSecretInput.value || undefined,
        session: els.webhookSessionInput.value.trim() || null,
      },
    });
    els.createWebhookForm.reset();
    restoreDefaultWebhookEvents();
    showToast('Webhook created.');
    await refreshWebhooks();
  } catch (error) {
    showError(error);
  }
}

async function testWebhook(id) {
  try {
    await fetchJson(`/api/webhooks/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    });
    showToast('Test webhook sent.');
  } catch (error) {
    showError(error);
  }
}

async function deleteWebhook(id) {
  try {
    await fetchJson(`/api/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    showToast('Webhook deleted.');
    await refreshWebhooks();
  } catch (error) {
    showError(error);
  }
}

async function fetchJson(path, options = {}) {
  const { auth = true, body, ...init } = options;
  const headers = new Headers(init.headers || {});
  if (auth) {
    if (!state.apiKey) {
      throw new Error('API key is required.');
    }
    headers.set('authorization', `Bearer ${state.apiKey}`);
  }
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(removeUndefined(body));
  }

  const response = await fetch(`${state.baseUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  const data = parseResponseText(text);

  if (!response.ok) {
    const message =
      data && typeof data === 'object'
        ? data.error || data.message || JSON.stringify(data)
        : text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function parseResponseText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function removeUndefined(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function normalizeBaseUrl(value) {
  const fallback = window.location.origin;
  return (value || fallback).trim().replace(/\/+$/, '');
}

function renderResult(value) {
  els.sendResult.textContent = JSON.stringify(value, null, 2);
}

function renderLoginResult(value) {
  els.loginResult.textContent = JSON.stringify(value, null, 2);
}

function errorToResult(error) {
  return {
    error: error.message,
  };
}

function setServiceStatus(kind, text) {
  els.serviceStatus.className = `status-pill ${kind}`;
  els.serviceStatus.textContent = text;
}

function showError(error) {
  showToast(error.message || String(error));
}

let toastTimer = null;
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function emptyState(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function formatDate(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function restoreDefaultWebhookEvents() {
  for (const input of els.createWebhookForm.querySelectorAll('.events input')) {
    input.checked = ['message.received', 'session.status', 'session.error'].includes(
      input.value,
    );
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}
