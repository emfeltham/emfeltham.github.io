(function() {
  const toggle = document.getElementById('theme-toggle');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

  function getTheme() {
    return localStorage.getItem('theme') || 'auto';
  }

  function setTheme(theme) {
    localStorage.setItem('theme', theme);
    applyTheme(theme);
    updateToggle(theme);
  }

  function applyTheme(theme) {
    if (theme === 'dark' || (theme === 'auto' && prefersDark.matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  function updateToggle(theme) {
    if (theme === 'dark' || (theme === 'auto' && prefersDark.matches)) {
      toggle.textContent = '☀️';
      toggle.title = 'Switch to light mode';
    } else {
      toggle.textContent = '🌙';
      toggle.title = 'Switch to dark mode';
    }
  }

  toggle.addEventListener('click', function() {
    const current = getTheme();
    const isDark = current === 'dark' || (current === 'auto' && prefersDark.matches);
    setTheme(isDark ? 'light' : 'dark');
  });

  prefersDark.addEventListener('change', function() {
    if (getTheme() === 'auto') applyTheme('auto');
  });

  // Initialize
  applyTheme(getTheme());
  updateToggle(getTheme());
})();
