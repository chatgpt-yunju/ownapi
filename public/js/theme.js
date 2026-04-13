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

  function syncThemeColor(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta && document.head) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    if (!meta) return;
    meta.setAttribute('content', theme === 'dark' ? '#06111d' : '#f4f9ff');
  }

  function setTheme(theme, auto) {
    document.documentElement.setAttribute('data-theme', theme);
    window.__openclawTheme = theme;
    syncThemeColor(theme);
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

  function shouldShowBottomNav() {
    var pathname = normalizePath(window.location.pathname || '/');
    var hidden = {
      '/login.html': true,
      '/register.html': true,
      '/admin.html': true,
      '/console.html': true
    };
    return !hidden[pathname];
  }

  function normalizePath(pathname) {
    if (!pathname || pathname === '/index.html') return '/';
    return pathname.replace(/\/+$/, '') || '/';
  }

  function createNavIcon(kind) {
    var icons = {
      home:
        '<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10.75V20h11V10.75"/><path d="M10 20v-5h4v5"/>',
      query:
        '<circle cx="11" cy="11" r="5.5"/><path d="M15.2 15.2 19 19"/>',
      model:
        '<path d="M12 3.8 19 7.6v8.8L12 20.2 5 16.4V7.6z"/><path d="M12 8.2v11.9"/><path d="M5.6 7.9 12 11.6l6.4-3.7"/><path d="M8.2 6.3l7.6 4.4"/>',
      blog:
        '<path d="M7 5.5h10a1.5 1.5 0 0 1 1.5 1.5v10.5a1.5 1.5 0 0 1-1.5 1.5H9.5L6 21V7A1.5 1.5 0 0 1 7.5 5.5z"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h4"/>',
      app:
        '<path d="M6.5 6.5h4v4h-4z"/><path d="M13.5 6.5h4v4h-4z"/><path d="M6.5 13.5h4v4h-4z"/><path d="M13.5 13.5h4v4h-4z"/>',
      docs:
        '<path d="M7 4h7l4 4v12H7z"/><path d="M14 4v4h4"/><path d="M9 11h6"/><path d="M9 15h6"/>',
      service:
        '<path d="M20 12c0 2.8-3.6 5-8 5-.9 0-1.77-.1-2.57-.3L5 18l1.45-3.13A4.8 4.8 0 0 1 4 12c0-2.8 3.6-5 8-5s8 2.2 8 5z"/><path d="M8.5 12h.01"/><path d="M12 12h.01"/><path d="M15.5 12h.01"/>',
      guest:
        '<path d="M12 5.5a3.25 3.25 0 1 1 0 6.5a3.25 3.25 0 0 1 0-6.5z"/><path d="M4.8 19c0-3.1 3.25-5.5 7.2-5.5s7.2 2.4 7.2 5.5"/>',
      console:
        '<path d="M5 6.75h14v10.5H5z"/><path d="M8 10.5l3 3-3 3"/><path d="M13 16h4"/>'
    };

    return '<span class="openclaw-bottom-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icons[kind] + '</svg></span>';
  }

  function isActiveNavItem(item, currentPath, currentHash) {
    if (item.hash) {
      return currentPath === item.path && currentHash === item.hash;
    }
    return currentPath === item.path;
  }

  function mountBottomNav() {
    if (!shouldShowBottomNav()) return;
    if (document.getElementById('openclaw-bottom-nav')) return;

    var navItems = [
      { key: 'home', label: '首页', path: '/', icon: 'home' },
      { key: 'query', label: '查询', path: '/guest.html', hash: '#query', icon: 'query' },
      { key: 'docs', label: '文档', path: '/docs.html', icon: 'docs' },
      { key: 'service', label: '客服', href: 'https://work.weixin.qq.com/kfid/kfcdc50dd3ddf3d9a97', icon: 'service', external: true },
      { key: 'model', label: '模型', path: '/', hash: '#pricing', icon: 'model' },
      { key: 'blog', label: '博客', path: '/blog.html', icon: 'blog' },
      { key: 'app', label: '应用', path: '/app-market.html', icon: 'app' }
    ];

    var currentPath = normalizePath(window.location.pathname || '/');
    var currentHash = window.location.hash || '';
    var nav = document.createElement('nav');
    nav.id = 'openclaw-bottom-nav';
    nav.className = 'openclaw-bottom-nav';
    if (/iP(hone|od|ad)/i.test(navigator.userAgent || '')) {
      nav.className += ' openclaw-bottom-nav-ios';
    }
    nav.setAttribute('aria-label', '底部导航');

    nav.innerHTML = navItems.map(function (item) {
      var href = item.href || item.path;
      if (!item.href && item.hash) href = item.path + item.hash;
      var active = isActiveNavItem(item, currentPath, currentHash);
      return '<a href="' + href + '"' +
        (item.external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        (active ? ' class="active"' : '') +
        '>' +
        createNavIcon(item.icon) +
        '<span>' + item.label + '</span>' +
        '</a>';
    }).join('');

    document.body.classList.add('openclaw-has-bottom-nav');
    document.body.appendChild(nav);
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
    mountBottomNav();
  });
})();
