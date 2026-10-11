(() => {
  const widget = document.querySelector('#ai-chat-widget');
  const toggle = document.querySelector('#ai-chat-toggle');
  const panel = document.querySelector('#ai-chat-panel');
  if (!widget || !toggle || !panel) return;

  widget.addEventListener('toggle', () => {
    toggle.setAttribute('aria-expanded', String(widget.open));
    if (widget.open) input?.focus();
  });

  const close = document.querySelector('#ai-chat-close');
  const form = document.querySelector('#ai-chat-form');
  const input = document.querySelector('#ai-chat-input');
  const send = document.querySelector('#ai-chat-send');
  const messages = document.querySelector('#ai-chat-messages');
  const status = document.querySelector('#ai-chat-status');
  if (!close || !form || !input || !send || !messages || !status) {
    if (status) status.textContent = 'Chat controls could not be initialized. Reload the dashboard and try again.';
    return;
  }

  const history = [];
  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The AI request timed out. Check the server connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function secureRequest(url, payload) {
    const csrfResponse = await fetchWithTimeout('/api/auth/csrf', {
      credentials: 'same-origin',
      cache: 'no-store'
    }, 10000);
    const csrfData = await csrfResponse.json();
    if (!csrfResponse.ok || !csrfData.csrf_token) {
      throw new Error(csrfData.error || 'Could not start a secure request. Reload the page and sign in again.');
    }
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfData.csrf_token
      },
      body: JSON.stringify(payload)
    }, 55000);
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The server returned an invalid response. Restart the JibonGuard server and retry.'); }
    if (response.status === 401) {
      location.assign('/login.html?next=%2Fdashboard.html');
      throw new Error('Your session expired. Sign in again.');
    }
    if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    return data;
  }

  const appendMessage = (text, className) => {
    const node = document.createElement('p');
    node.className = className;
    node.textContent = text;
    messages.append(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  };

  close.addEventListener('click', () => {
    widget.open = false;
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
    const original = scheduleButton.textContent;
    scheduleButton.disabled = true;
    scheduleButton.textContent = 'Checking weather...';
    try {
      const result = await secureRequest('/api/breaks/ai-schedule', {});
      if (typeof window.loadBreaks === 'function') await window.loadBreaks({ quiet: true });
      const smsCount = (result.sms || []).filter(item => item.status === 'queued').length;
      const message = result.created?.length && smsCount
        ? `${result.message} ${smsCount} SMS batch(es) queued.`
        : result.message;
      if (typeof window.notify === 'function') window.notify(message);
      else status.textContent = message;
    } catch (error) {
      if (typeof window.notify === 'function') window.notify(error.message);
      else status.textContent = `AI scheduling failed: ${error.message}`;
    } finally {
      scheduleButton.disabled = false;
      scheduleButton.textContent = original;
    }
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
      const data = await secureRequest('/api/ai/chat', { messages: history });
      if (typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new Error('Gemini returned an empty response. Try again.');
      }
      pending.textContent = data.reply;
      pending.classList.remove('pending-message');
      history.push({ role: 'model', text: data.reply });
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
