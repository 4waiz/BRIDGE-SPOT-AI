// Demo-only: theme toggle + persistence for the audio assistant UI.
(function () {
  var toggle = document.getElementById("theme-toggle");
  if (!toggle) {
    return;
  }

  var storageKey = "theme";
  var root = document.documentElement;

  var readStoredTheme = function () {
    try {
      var stored = localStorage.getItem(storageKey);
      return stored === "light" || stored === "dark" ? stored : null;
    } catch (error) {
      return null;
    }
  };

  var writeStoredTheme = function (theme) {
    try {
      localStorage.setItem(storageKey, theme);
    } catch (error) {
      return;
    }
  };

  var getPreferredTheme = function () {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  };

  var applyTheme = function (theme) {
    root.setAttribute("data-theme", theme);
    var isDark = theme === "dark";
    toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    toggle.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
    toggle.setAttribute("aria-pressed", String(isDark));
  };

  applyTheme(readStoredTheme() || getPreferredTheme());

  toggle.addEventListener("click", function () {
    var nextTheme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    writeStoredTheme(nextTheme);
    applyTheme(nextTheme);
  });

  if (window.matchMedia) {
    var mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    var handleChange = function (event) {
      if (readStoredTheme()) {
        return;
      }
      applyTheme(event.matches ? "dark" : "light");
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(handleChange);
    }
  }
})();
