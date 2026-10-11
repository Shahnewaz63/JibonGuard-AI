(() => {
  const key = 'jibonguard-theme-choice';
  const root = document.documentElement;
  const saved = localStorage.getItem(key);
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  else root.dataset.theme = 'light';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-toggle';
  button.setAttribute('aria-label', 'Switch to dark mode');
  button.title = 'Switch to dark mode';
  const update = () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : false;
    button.innerHTML = dark ? '<span aria-hidden="true">\u2600</span><span>Light</span>' : '<span aria-hidden="true">\u263e</span><span>Dark</span>';
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-pressed', String(dark));
  };
  button.addEventListener('click', () => {
    const currentlyDark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : false;
    root.dataset.theme = currentlyDark ? 'light' : 'dark';
    localStorage.setItem(key, root.dataset.theme);
    update();
  });
  const host = document.querySelector('.header-actions, .header-tools, .auth-panel');
  if (host) {
    if (host.classList.contains('auth-panel')) button.classList.add('theme-toggle-auth');
    host.append(button);
  }
  update();
})();
