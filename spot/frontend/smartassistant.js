// Voice Assistant Integration
function startwwd() {
    // Start the voice assistant
    if (typeof startAssistant === 'function') {
        startAssistant();
    } else {
        console.error('Voice assistant not loaded');
        alert('Voice assistant is not available. Please refresh the page.');
    }
}

// Demo-only: theme toggle + persistence.
(function initThemeToggle() {
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) {
        return;
    }

    const storageKey = "theme";
    const root = document.documentElement;

    const readStoredTheme = () => {
        try {
            const stored = localStorage.getItem(storageKey);
            return stored === "light" || stored === "dark" ? stored : null;
        } catch (error) {
            return null;
        }
    };

    const writeStoredTheme = (theme) => {
        try {
            localStorage.setItem(storageKey, theme);
        } catch (error) {
            return;
        }
    };

    const getPreferredTheme = () => {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
            return "dark";
        }
        return "light";
    };

    const applyTheme = (theme) => {
        root.setAttribute("data-theme", theme);
        const isDark = theme === "dark";
        toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
        toggle.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
        toggle.setAttribute("aria-pressed", String(isDark));
    };

    applyTheme(readStoredTheme() || getPreferredTheme());

    toggle.addEventListener("click", () => {
        const nextTheme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        writeStoredTheme(nextTheme);
        applyTheme(nextTheme);
    });

    if (window.matchMedia) {
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        const handleChange = (event) => {
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
