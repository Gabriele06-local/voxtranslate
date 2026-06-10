// Room glossary editor (spec 0011). Term pairs saved here are injected into
// the Groq translation prompt server-side ("MANDATORY TERMINOLOGY"), so the
// room's jargon translates verbatim. Entry points: a 📖 button next to the
// room code on home, and an in-call header badge that appears (via the
// `glossary_active` WS message) whenever the room has entries. Auth-only:
// guests see the badge but can't open the editor.

import {
  deleteGlossary,
  fetchGlossary,
  importGlossaryCsv,
  saveGlossary,
  type Glossary,
  type GlossaryEntry,
} from './api';
import { isLoggedIn } from './auth';
import { ENDONYM, SUPPORTED, t } from './i18n';
import { icon } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const homeBtn = $<HTMLButtonElement>('btn-glossary-home');
const badge = $<HTMLButtonElement>('glossary-badge');
const modal = $('glossary-modal');
const nameInput = $<HTMLInputElement>('glossary-name');
const rowsEl = $('glossary-rows');
const addRowBtn = $<HTMLButtonElement>('glossary-add-row');
const countEl = $('glossary-count');
const csvText = $<HTMLTextAreaElement>('glossary-csv-text');
const importBtn = $<HTMLButtonElement>('glossary-import');
const statusEl = $('glossary-status');
const deleteBtn = $<HTMLButtonElement>('glossary-delete');
const saveBtn = $<HTMLButtonElement>('glossary-save');

/** app.ts's show(): modal-overlay visibility + focus trap/restore. */
let show: (el: HTMLElement, visible: boolean) => void = (el, v) =>
  el.classList.toggle('hidden', !v);
/** Room of the call we're currently in (badge target); null outside calls. */
let activeRoom: string | null = null;
/** Room the open editor is bound to (home can edit before joining). */
let editingRoom: string | null = null;
let maxEntries = 200;
let deleteArmTimer: number | null = null;

/** Wire events; app.ts passes its `show` so the modal gets the focus trap. */
export function initGlossary(opts: { show?: typeof show } = {}): void {
  if (opts.show) show = opts.show;
  refreshGlossaryHome();
}

/** Home 📖 button is auth-only; re-checked when the home screen is entered. */
export function refreshGlossaryHome(): void {
  homeBtn.hidden = !isLoggedIn();
}

/** Called on room join (room code) and on leave (null). */
export function setGlossaryRoom(room: string | null): void {
  activeRoom = room;
  badge.classList.add('hidden');
  if (!room && !modal.classList.contains('hidden')) show(modal, false);
}

/** `glossary_active` WS frame: badge on join + live re-broadcast after edits. */
export function onGlossaryActive(name: string | null, entries: number): void {
  if (!activeRoom || entries === 0) {
    badge.classList.add('hidden');
    return;
  }
  badge.textContent = `📖 ${name ? `${name} ` : ''}(${entries})`;
  badge.disabled = !isLoggedIn(); // guests see it but can't open the editor
  badge.classList.remove('hidden');
}

homeBtn.addEventListener('click', () => {
  // Same normalization the join flow applies — glossaries key on that form.
  const room = $<HTMLInputElement>('room').value.trim().toLowerCase();
  if (!room) {
    $<HTMLInputElement>('room').focus();
    return;
  }
  void openEditor(room);
});

badge.addEventListener('click', () => {
  if (activeRoom && isLoggedIn()) void openEditor(activeRoom);
});

$('glossary-close').addEventListener('click', () => show(modal, false));

async function openEditor(room: string): Promise<void> {
  editingRoom = room;
  setStatus('', false);
  csvText.value = '';
  renderEditor({ name: null, entries: [], max_entries: maxEntries });
  show(modal, true);
  const g = await fetchGlossary(room);
  if (editingRoom !== room) return; // closed/retargeted while loading
  if (g) renderEditor(g);
  else setStatus(t('glossaryLoadFailed'), true);
}

function setStatus(text: string, isError: boolean): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// ---- Table -------------------------------------------------------------------

function renderEditor(g: Glossary): void {
  maxEntries = g.max_entries;
  nameInput.value = g.name ?? '';
  rowsEl.innerHTML = '';
  for (const e of g.entries) addRow(e);
  if (!g.entries.length) addRow();
  updateCount();
}

function langSelect(label: string, value: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', label);
  for (const code of SUPPORTED) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = ENDONYM[code];
    sel.appendChild(opt);
  }
  sel.value = value;
  return sel;
}

function termInput(label: string, value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 200;
  input.autocomplete = 'off';
  input.value = value;
  input.setAttribute('aria-label', label);
  return input;
}

function addRow(e?: GlossaryEntry): void {
  const row = document.createElement('div');
  row.className = 'glossary-row';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'glossary-remove';
  remove.innerHTML = icon('close', 14);
  remove.title = t('glossaryRemove');
  remove.setAttribute('aria-label', t('glossaryRemove'));
  remove.addEventListener('click', () => {
    row.remove();
    updateCount();
  });
  row.append(
    langSelect(t('glossarySrcLang'), e?.source_lang ?? 'en'),
    langSelect(t('glossaryTgtLang'), e?.target_lang ?? 'it'),
    termInput(t('glossarySrcTerm'), e?.source_term ?? ''),
    termInput(t('glossaryTgtTerm'), e?.target_term ?? ''),
    remove,
  );
  rowsEl.appendChild(row);
  updateCount();
}

addRowBtn.addEventListener('click', () => {
  addRow();
  rowsEl.querySelector<HTMLElement>('.glossary-row:last-child input')?.focus();
});

function updateCount(): void {
  const n = rowsEl.querySelectorAll('.glossary-row').length;
  countEl.textContent = `${n} / ${maxEntries}`;
  addRowBtn.disabled = n >= maxEntries;
}

/**
 * Read the table back into entries. Rows with both terms empty are skipped
 * (leftover blanks); a half-filled row or a same-language pair is an error.
 */
function collectRows(): GlossaryEntry[] | null {
  const entries: GlossaryEntry[] = [];
  for (const row of rowsEl.querySelectorAll<HTMLElement>('.glossary-row')) {
    const [src, tgt] = Array.from(row.querySelectorAll('select')).map((s) => s.value);
    const [sterm, tterm] = Array.from(row.querySelectorAll('input')).map((i) => i.value.trim());
    if (!sterm && !tterm) continue;
    if (!sterm || !tterm || src === tgt) {
      setStatus(t('glossaryRowInvalid'), true);
      return null;
    }
    entries.push({ source_lang: src, target_lang: tgt, source_term: sterm, target_term: tterm });
  }
  return entries;
}

// ---- Save / import / delete ----------------------------------------------------

/** Save the table. Returns true on success (import chains on this). */
async function doSave(silent: boolean): Promise<boolean> {
  const room = editingRoom;
  const entries = collectRows();
  if (!room || !entries) return false;
  saveBtn.disabled = true;
  const res = await saveGlossary(room, nameInput.value.trim() || null, entries);
  saveBtn.disabled = false;
  if (!res.glossary) {
    // The server's 400 carries the precise reason (entry index, cap, …).
    setStatus(res.error || t('glossaryLoadFailed'), true);
    return false;
  }
  renderEditor(res.glossary);
  if (!silent) setStatus(t('glossarySaved'), false);
  return true;
}

saveBtn.addEventListener('click', () => void doSave(false));

importBtn.addEventListener('click', async () => {
  const room = editingRoom;
  const csv = csvText.value.trim();
  if (!room || !csv) {
    csvText.focus();
    return;
  }
  // Save the table first so unsaved edits aren't clobbered by the re-render.
  importBtn.disabled = true;
  const saved = await doSave(true);
  if (saved) {
    const res = await importGlossaryCsv(room, csv);
    if (res.glossary) {
      renderEditor(res.glossary);
      csvText.value = '';
      setStatus(t('glossarySaved'), false);
    } else {
      setStatus(res.error || t('glossaryLoadFailed'), true);
    }
  }
  importBtn.disabled = false;
});

/** Two-click delete: first click arms ("click again…"), second one deletes. */
deleteBtn.addEventListener('click', async () => {
  if (!editingRoom) return;
  if (deleteArmTimer === null) {
    deleteBtn.textContent = t('glossaryDeleteSure');
    deleteArmTimer = window.setTimeout(disarmDelete, 4000);
    return;
  }
  disarmDelete();
  if (await deleteGlossary(editingRoom)) {
    renderEditor({ name: null, entries: [], max_entries: maxEntries });
    setStatus(t('glossaryDeleted'), false);
  } else {
    setStatus(t('glossaryLoadFailed'), true);
  }
});

function disarmDelete(): void {
  if (deleteArmTimer !== null) clearTimeout(deleteArmTimer);
  deleteArmTimer = null;
  deleteBtn.textContent = t('glossaryDeleteAll');
}
