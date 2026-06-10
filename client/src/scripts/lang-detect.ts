// Auto-detected language UX (spec 0012). Joining with lang="auto" makes the
// server probe the first ~3s of audio and broadcast `language_detected`; for
// OUR OWN result app.ts calls `onLanguageDetected`, which shows an interactive
// toast — "Detected language: Italiano 🇮🇹  [Change]". The Change picker sends
// `set_lang` and restarts the mic capture so the next Deepgram stream opens
// with the corrected language (a fresh MediaRecorder carries the WebM header).
//
// The toast gets its own .lang-toast class: the shared .vox-toast is
// pointer-events:none and can't host a button.

import { ENDONYM, FLAG, SUPPORTED, t } from './i18n';

interface LangDetectDeps {
  /** Send a JSON message over the (current) call WebSocket. */
  send: (msg: Record<string, unknown>) => void;
  /** Restart MediaRecorder so the new Deepgram stream gets a WebM header. */
  restartCapture: () => void;
}

let deps: LangDetectDeps | null = null;
let toastEl: HTMLDivElement | null = null;
let hideTimer = 0;

/** Wire the toast's Change action to the live socket + capture (call once at boot). */
export function initLangDetect(d: LangDetectDeps): void {
  deps = d;
}

/** Remove the toast instantly (call teardown). */
export function dismissLangToast(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
  toastEl?.remove();
  toastEl = null;
}

function fadeOut(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
  const el = toastEl;
  if (!el) return;
  toastEl = null;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 300);
}

/** Show the "Detected language: …" toast for our own auto-detection result. */
export function onLanguageDetected(lang: string): void {
  dismissLangToast();

  const el = document.createElement('div');
  el.className = 'lang-toast';
  el.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'lang-toast-text';
  text.textContent =
    `${t('langDetected')}: ${ENDONYM[lang] || lang.toUpperCase()} ${FLAG[lang] || ''}`.trim();

  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'lang-toast-change';
  change.textContent = t('langChange');
  change.addEventListener('click', () => {
    // Swap the button for a language picker (endonyms, detected lang preselected).
    const sel = document.createElement('select');
    sel.className = 'lang-toast-select';
    sel.setAttribute('aria-label', t('langLabel'));
    for (const code of SUPPORTED) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${FLAG[code] || ''} ${ENDONYM[code]}`.trim();
      if (code === lang) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      if (sel.value !== lang) {
        deps?.send({ type: 'set_lang', lang: sel.value });
        deps?.restartCapture();
      }
      fadeOut();
    });
    change.replaceWith(sel);
    sel.focus();
    // Picker open = the user is deciding; extend the auto-dismiss window.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(fadeOut, 20000);
  });

  el.append(text, change);
  document.body.appendChild(el);
  toastEl = el;
  requestAnimationFrame(() => el.classList.add('show'));
  hideTimer = window.setTimeout(fadeOut, 8000);
}
