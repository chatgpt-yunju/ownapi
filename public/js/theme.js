(function () {
  var STORAGE_KEY = 'openclaw-theme';
  var AUTO_FLAG_KEY = 'openclaw-theme-auto';
  var WORK_START_HOUR = 9;
  var WORK_END_HOUR = 19;

  function getAutoThemeByTime() {
    var hour = new Date().getHours();
    return hour >= WORK_START_HOUR && hour < WORK_END_HOUR ? 'light' : 'dark';
  }

  function getStoredTheme() {
    try {
      var theme = localStorage.getItem(STORAGE_KEY);
      return theme === 'light' || theme === 'dark' ? theme : null;
    } catch (error) {
      return null;
    }
  }

  function shouldUseAutoTheme() {
    try {
      return localStorage.getItem(AUTO_FLAG_KEY) !== 'manual';
    } catch (error) {
      return true;
    }
  }

  function getResolvedTheme() {
    var storedTheme = getStoredTheme();
    if (!storedTheme || shouldUseAutoTheme()) return getAutoThemeByTime();
    return storedTheme;
  }

  function updateThemeControls(theme, auto) {
    var fabIcon = document.getElementById('theme-fab-icon');
    var fabLabel = document.getElementById('theme-fab-label');
    if (fabIcon && fabLabel) {
      fabIcon.textContent = theme === 'dark' ? '🌙' : '☀';
      fabLabel.textContent = auto
        ? (theme === 'dark' ? '夜间模式' : '白天模式')
        : (theme === 'dark' ? '切到白天' : '切到夜间');
    }

    var navButton = document.getElementById('theme-toggle-btn');
    if (navButton) {
      navButton.textContent = auto
        ? (theme === 'dark' ? '夜间模式' : '白天模式')
        : (theme === 'dark' ? '切换白天模式' : '切换夜间模式');
    }
  }

  function setTheme(theme, auto) {
    document.documentElement.setAttribute('data-theme', theme);
    window.__openclawTheme = theme;
    updateThemeControls(theme, !!auto);
  }

  function initTheme() {
    setTheme(getResolvedTheme(), shouldUseAutoTheme());
  }

  function setManualTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
      localStorage.setItem(AUTO_FLAG_KEY, 'manual');
    } catch (error) {}
    setTheme(theme, false);
  }

  function toggleThemePreference() {
    var currentTheme = window.__openclawTheme || getResolvedTheme();
    setManualTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  function resetThemePreference() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(AUTO_FLAG_KEY);
    } catch (error) {}
    initTheme();
  }

  window.getAutoThemeByTime = getAutoThemeByTime;
  window.toggleThemePreference = toggleThemePreference;
  window.toggleTheme = toggleThemePreference;
  window.resetThemePreference = resetThemePreference;
  window.refreshThemeControls = function () {
    updateThemeControls(window.__openclawTheme || getResolvedTheme(), shouldUseAutoTheme());
  };

  initTheme();
  document.addEventListener('DOMContentLoaded', function () {
    updateThemeControls(window.__openclawTheme || getResolvedTheme(), shouldUseAutoTheme());
  });
})();
