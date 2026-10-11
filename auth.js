async function getCsrfToken() {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not start a secure request.');
  return data.csrf_token;
}

async function postApi(url, values) {
  const csrf = await getCsrfToken();
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(values)
  });
  let data = {};
  try { data = await response.json(); } catch { data = { error: 'The server returned an invalid response.' }; }
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status });
  return data;
}

// Dashboard AI controls live in this shared, already-authorized script so a
// separate static bundle cannot silently leave the buttons without handlers.
(() => {
  const toggle = document.querySelector('#ai-chat-toggle');
  const panel = document.querySelector('#ai-chat-panel');
  const close = document.querySelector('#ai-chat-close');
  const form = document.querySelector('#ai-chat-form');
  const input = document.querySelector('#ai-chat-input');
  const send = document.querySelector('#ai-chat-send');
  const messages = document.querySelector('#ai-chat-messages');
  const status = document.querySelector('#ai-chat-status');
  if (!toggle || !panel || !close || !form || !input || !send || !messages || !status) return;

  const history = [];
  const appendMessage = (text, className) => {
    const node = document.createElement('p');
    node.className = className;
    node.textContent = text;
    messages.append(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  };
  const notifyUser = message => {
    if (typeof window.notify === 'function') window.notify(message);
    else status.textContent = message;
  };

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) input.focus();
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });

  const scheduleButton = document.querySelector('#ai-schedule-button');
  if (scheduleButton) scheduleButton.addEventListener('click', async () => {
    scheduleButton.disabled = true;
    const original = scheduleButton.textContent;
    scheduleButton.textContent = 'Checking weather...';
    try {
      const result = await postApi('/api/breaks/ai-schedule', {});
      if (typeof window.loadBreaks === 'function') await window.loadBreaks({ quiet: true });
      else location.reload();
      const smsCount = (result.sms || []).filter(item => item.status === 'queued').length;
      notifyUser(result.created?.length && smsCount ? `${result.message} ${smsCount} SMS batch(es) queued.` : result.message);
    } catch (error) { notifyUser(`AI scheduling failed: ${error.message}`); }
    finally { scheduleButton.disabled = false; scheduleButton.textContent = original; }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt || send.disabled) return;
    history.push({ role: 'user', text: prompt });
    appendMessage(prompt, 'user-message');
    input.value = '';
    input.disabled = true;
    send.disabled = true;
    send.textContent = 'Sending...';
    status.textContent = 'Sending your message to JibonGuard AI...';
    const pending = appendMessage('Thinking...', 'assistant-message pending-message');
    try {
      const result = await postApi('/api/ai/chat', { messages: history });
      if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('Gemini returned an empty response. Try again.');
      pending.textContent = result.reply;
      pending.classList.remove('pending-message');
      history.push({ role: 'model', text: result.reply });
      status.textContent = 'Reply received.';
    } catch (error) {
      pending.textContent = error.message || 'Could not send the request. Check the server and retry.';
      pending.classList.add('chat-error');
      history.pop();
      status.textContent = `Request failed: ${pending.textContent}`;
    } finally {
      input.disabled = false;
      send.disabled = false;
      send.textContent = 'Send';
      input.focus();
    }
  });
})();

function showAuthMessage(element, message, type = 'error', actionUrl = '') {
  if (!element) return;
  element.replaceChildren();
  element.className = `auth-message show ${type}`;
  element.append(document.createTextNode(message));
  if (actionUrl) {
    const link = document.createElement('a');
    link.href = actionUrl;
    link.textContent = ' Open the one-time link';
    element.append(link);
  }
}

function setBusy(form, busy, label) {
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  }
}

const signupForm = document.querySelector('#signup-form');
if (signupForm) signupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#signup-message');
  const form = event.currentTarget;
  setBusy(form, true, 'Creating secure account…');
  try {
    const values = Object.fromEntries(new FormData(form));
    values.privacy_consent = new FormData(form).get('privacy_consent') === 'on';
    const result = await postApi('/api/auth/signup', values);
    showAuthMessage(message, result.message, 'success', result.development_action_url || '');
    form.reset();
  } catch (error) {
    showAuthMessage(message, error.message);
  } finally { setBusy(form, false); }
});

const resendForm = document.querySelector('#resend-form');
if (resendForm) resendForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true, 'Sending…');
  try {
    const result = await postApi('/api/auth/resend-verification', Object.fromEntries(new FormData(form)));
    showAuthMessage(document.querySelector('#resend-message'), result.message, 'success', result.development_action_url || '');
  } catch (error) {
    showAuthMessage(document.querySelector('#resend-message'), error.message);
  } finally { setBusy(form, false); }
});

const loginForm = document.querySelector('#login-form');
if (loginForm) loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#login-message');
  setBusy(form, true, 'Signing in…');
  try {
    const values = Object.fromEntries(new FormData(form));
    values.remember = new FormData(form).get('remember') === 'on';
    values.next = new URLSearchParams(location.search).get('next') || '/dashboard.html';
    const result = await postApi('/api/auth/login', values);
    location.assign(result.next || '/dashboard.html');
  } catch (error) {
    showAuthMessage(message, error.message);
    if (error.status === 403 && error.message.startsWith('Verify your email')) {
      const link = document.createElement('a');
      link.href = '/resend-verification.html';
      link.textContent = ' Send another verification link.';
      message.append(link);
    }
  } finally { setBusy(form, false); }
});

const forgotForm = document.querySelector('#forgot-form');
if (forgotForm) forgotForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true, 'Sending…');
  try {
    const result = await postApi('/api/auth/forgot', Object.fromEntries(new FormData(form)));
    showAuthMessage(document.querySelector('#forgot-message'), result.message, 'success', result.development_action_url || '');
  } catch (error) {
    showAuthMessage(document.querySelector('#forgot-message'), error.message);
  } finally { setBusy(form, false); }
});

const resetForm = document.querySelector('#reset-form');
const resetToken = new URLSearchParams(location.search).get('token') || '';
if (new URLSearchParams(location.search).get('mode') === 'reset') history.replaceState(null, '', '/login.html?mode=reset');
if (resetForm) resetForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const message = document.querySelector('#reset-message');
  if (values.password !== values.confirm_password) {
    showAuthMessage(message, 'The passwords do not match.');
    return;
  }
  setBusy(form, true, 'Updating password…');
  try {
    const result = await postApi('/api/auth/reset', { token: resetToken, password: values.password });
    showAuthMessage(message, result.message, 'success');
    form.reset();
    setTimeout(() => location.assign('/login.html'), 1200);
  } catch (error) {
    showAuthMessage(message, error.message);
  } finally { setBusy(form, false); }
});

const query = new URLSearchParams(location.search);
if (document.querySelector('#login-panel')) {
  const mode = query.get('mode');
  if (mode === 'forgot') {
    document.querySelector('#login-panel').hidden = true;
    document.querySelector('#forgot-panel').hidden = false;
  } else if (mode === 'reset') {
    document.querySelector('#login-panel').hidden = true;
    document.querySelector('#reset-panel').hidden = false;
  }
}

if (document.querySelector('#verify-title')) {
  const token = query.get('token') || '';
  if (token) history.replaceState(null, '', '/verify.html');
  const title = document.querySelector('#verify-title');
  const description = document.querySelector('#verify-message');
  if (!token) {
    title.textContent = 'Verification link missing';
    description.textContent = 'Open the one-time link from the JibonGuard email to verify your address.';
  } else {
    postApi('/api/auth/verify', { token }).then(result => {
      title.textContent = 'Email verified';
      description.textContent = result.message;
      const link = document.querySelector('#verify-login');
      link.hidden = false;
      link.classList.add('button-large');
    }).catch(error => {
      title.textContent = 'Could not verify this email';
      description.textContent = error.message;
      document.querySelector('#verify-login').hidden = false;
    });
  }
}

const privacyExport = document.querySelector('#privacy-export');
if (privacyExport) privacyExport.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/privacy/export', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { location.assign('/login.html?next=%2Faccount.html'); return; }
    if (!response.ok) throw new Error('Could not export account data.');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'jibonguard-account-data.json';
    link.click();
    URL.revokeObjectURL(link.href);
    showAuthMessage(document.querySelector('#account-message'), 'Your account data export was downloaded.', 'success');
  } catch (error) { showAuthMessage(document.querySelector('#account-message'), error.message); }
});

const deleteForm = document.querySelector('#delete-account-form');
if (deleteForm) deleteForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.confirm('Permanently delete this organization account and its organization profile? This action cannot be undone.')) return;
  const form = event.currentTarget;
  setBusy(form, true, 'Deleting account…');
  try {
    const result = await postApi('/api/privacy/delete-account', { password: new FormData(form).get('password') });
    showAuthMessage(document.querySelector('#account-message'), result.message, 'success');
    setTimeout(() => location.assign('/'), 1000);
  } catch (error) {
    showAuthMessage(document.querySelector('#account-message'), error.message);
  } finally { setBusy(form, false); }
});

const accountName = document.querySelector('#account-name');
if (accountName) fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
  if (!response.ok) { location.assign('/login.html?next=%2Faccount.html'); return null; }
  return response.json();
}).then(data => {
  if (!data) return;
  accountName.textContent = `${data.user.full_name} · ${data.user.email}`;
  document.querySelector('#account-organization').textContent = data.user.organization_name;
}).catch(() => showAuthMessage(document.querySelector('#account-message'), 'Could not load the signed-in account.'));
