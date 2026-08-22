import { ref, watchEffect } from "vue";

/*
 * Window-wide dark-mode state. Bootstrap 5 themes through the data-bs-theme
 * attribute on <html> — a document-root concern, not a component's. This
 * composable is the single owner of the stored preference and the attribute,
 * so components only ever see a reactive boolean (and never reach into the
 * document themselves).
 */

const THEME_KEY = "qba.theme";
const isDark = ref(false);

function readStored() {
  let dark = false;
  try {
    dark = localStorage.getItem(THEME_KEY) === "dark";
  } catch {
    /* storage may be unavailable; the light theme is a fine fallback */
  }
  isDark.value = dark;
}

function applyToDocument(dark) {
  if (dark) {
    document.documentElement.setAttribute("data-bs-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-bs-theme");
  }
}

export function useDarkMode() {
  readStored();
  watchEffect(() => applyToDocument(isDark.value));

  function toggle(dark) {
    isDark.value = dark;
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      /* storage may be unavailable; remembering is best-effort */
    }
  }

  return { isDark, toggle };
}

export function initTheme() {
  readStored();
  applyToDocument(isDark.value);
}
