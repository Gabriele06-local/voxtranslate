// VoxTranslate V2 client orchestrator: home/lobby → pre-join (camera + devices)
// → WebRTC video call with translated subtitles + chat.

import { applyI18n, detectLang, FLAG, setUiLang, t } from './i18n';
import { MeshManager } from './webrtc';
import { AudioCapture } from './audio-capture';
import { ChatManager, type ChatPayload } from './chat';

// ---- Config ----------------------------------------------------------------
const WS_HOST = import.meta.env.PUBLIC_WS_HOST || location.host;
const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${WS_PROTO}//${WS_HOST}`;
const HTTP_BASE = WS_BASE.replace(/^ws/, 'http');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- Screens ---------------------------------------------------------------
const homeScreen = $('home');
const prejoinScreen = $('prejoin');
const callScreen = $('call');

// ---- Home refs -------------------------------------------------------------
const roomInput = $<HTMLInputElement>('room');
const nameInput = $<HTMLInputElement>('name');
const langSel = $<HTMLSelectElement>('lang');
const enterBtn = $<HTMLButtonElement>('enter');
const homeStatus = $('home-status');
const visGroup = $('vis-group');
const visHint = $('vis-hint');
const roomsList = $('rooms-list');

// ---- Pre-join refs ---------------------------------------------------------
const previewVideo = $<HTMLVideoElement>('preview');
const camSelect = $<HTMLSelectElement>('cam-select');
const micSelect = $<HTMLSelectElement>('mic-select');
const prejoinRoom = $('prejoin-room');
const prejoinVis = $('prejoin-vis');
const prejoinStatus = $('prejoin-status');

// ---- Call refs -------------------------------------------------------------
const videoGrid = $('video-grid');
const callRoom = $('call-room');
const callVis = $('call-vis');
const chatPanel = $('chat-panel');
const chatMessages = $('chat-messages');
const chatInput = $<HTMLInputElement>('chat-input');
const chatBadge = $('chat-badge');
const btnMic = $('btn-mic');
const btnCam = $('btn-cam');
const btnTts = $('btn-tts');
const btnChat = $('btn-chat');

// ---- State -----------------------------------------------------------------
const myId =
  (crypto && crypto.randomUUID && crypto.randomUUID()) ||
  `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

let session: { room: string; lang: string; name: string; isPublic: boolean } | null = null;
let localStream: MediaStream | null = null;
let ws: WebSocket | null = null;
let mesh: MeshManager | null = null;
let audioCapture: AudioCapture | null = null;
let chat: ChatManager | null = null;
let lobbyTimer: number | null = null;
let visibilityPublic = true;
let micOn = true;
let camOn = true;
let ttsOn = false;
let manualClose = false;

const peerNames = new Map<string, { name: string; lang: string }>();
const subtitleTimers = new Map<string, number>();

// ============================================================================
// i18n
// ============================================================================
langSel.value = detectLang();
applyI18n();
langSel.addEventListener('change', () => {
  setUiLang(langSel.value);
  applyI18n();
  updateVisHint();
});

function updateVisHint(): void {
  visHint.textContent = visibilityPublic ? '' : t('privateHint');
}

// ============================================================================
// Home + lobby
// ============================================================================
function randomRoom(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
roomInput.value = randomRoom();
$('dice').addEventListener('click', () => (roomInput.value = randomRoom()));

visGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLElement | null;
  if (!btn) return;
  visibilityPublic = btn.dataset.vis === 'public';
  visGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  updateVisHint();
});

function homeStatusMsg(msg: string, isError = false): void {
  homeStatus.textContent = msg;
  homeStatus.classList.toggle('error', isError);
}

enterBtn.addEventListener('click', () => {
  const room = roomInput.value.trim().toLowerCase();
  if (!room) return homeStatusMsg(t('enterRoom'), true);
  goPrejoin(room, visibilityPublic);
});

async function fetchRooms(): Promise<void> {
  try {
    const res = await fetch(`${HTTP_BASE}/rooms`, { cache: 'no-store' });
    const data = await res.json();
    renderRooms(data.rooms || []);
  } catch {
    /* keep last render */
  }
}

function renderRooms(rooms: Array<{ room: string; count: number; participants: Array<{ name: string; lang: string }> }>): void {
  roomsList.innerHTML = '';
  if (!rooms.length) {
    const empty = document.createElement('div');
    empty.className = 'lobby-empty';
    empty.textContent = t('noPublicRooms');
    roomsList.appendChild(empty);
    return;
  }
  for (const r of rooms) {
    const item = document.createElement('button');
    item.className = 'room-item';
    item.type = 'button';
    const main = document.createElement('div');
    main.className = 'room-item-main';
    const code = document.createElement('span');
    code.className = 'room-item-code';
    code.textContent = r.room;
    const count = document.createElement('span');
    count.className = 'room-item-count';
    count.textContent = `👤 ${r.count}/4`;
    main.append(code, count);
    const members = document.createElement('div');
    members.className = 'room-item-members';
    for (const m of r.participants) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${FLAG[m.lang] || ''} ${m.name}`.trim();
      members.appendChild(chip);
    }
    item.append(main, members);
    item.addEventListener('click', () => goPrejoin(r.room, true));
    roomsList.appendChild(item);
  }
}

function startLobby(): void {
  fetchRooms();
  if (!lobbyTimer) lobbyTimer = window.setInterval(fetchRooms, 3000);
}
function stopLobby(): void {
  if (lobbyTimer) {
    clearInterval(lobbyTimer);
    lobbyTimer = null;
  }
}
$('refresh').addEventListener('click', fetchRooms);

// ============================================================================
// Pre-join: camera preview + device selectors
// ============================================================================
async function goPrejoin(room: string, isPublic: boolean): Promise<void> {
  session = { room, lang: langSel.value, name: nameInput.value.trim(), isPublic };
  stopLobby();
  homeScreen.classList.add('hidden');
  prejoinScreen.classList.remove('hidden');
  prejoinRoom.textContent = room;
  prejoinVis.textContent = isPublic ? t('public') : t('private');
  prejoinStatus.textContent = '';
  try {
    await acquireMedia();
    await populateDevices();
  } catch {
    prejoinStatus.textContent = t('camMicDenied');
    prejoinStatus.classList.add('error');
  }
}

async function acquireMedia(): Promise<void> {
  const camId = camSelect.value;
  const micId = micSelect.value;
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(micId ? { deviceId: { exact: micId } } : {}),
  };
  const video: MediaTrackConstraints = {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 30 },
    ...(camId ? { deviceId: { exact: camId } } : {}),
  };
  if (localStream) localStream.getTracks().forEach((t2) => t2.stop());
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
    camOn = true;
  } catch {
    // Fall back to audio-only (no camera available / denied video).
    localStream = await navigator.mediaDevices.getUserMedia({ audio });
    camOn = false;
  }
  previewVideo.srcObject = localStream;
  void previewVideo.play().catch(() => {});
}

async function populateDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const curCam = localStream?.getVideoTracks()[0]?.getSettings().deviceId || '';
  const curMic = localStream?.getAudioTracks()[0]?.getSettings().deviceId || '';
  fillDeviceSelect(camSelect, cams, curCam, 'Camera');
  fillDeviceSelect(micSelect, mics, curMic, 'Mic');
}

function fillDeviceSelect(sel: HTMLSelectElement, devices: MediaDeviceInfo[], current: string, fallback: string): void {
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallback} ${i + 1}`;
    if (d.deviceId === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.disabled = devices.length === 0;
}

camSelect.addEventListener('change', () => acquireMedia());
micSelect.addEventListener('change', () => acquireMedia());

$('back-btn').addEventListener('click', () => {
  if (localStream) localStream.getTracks().forEach((tr) => tr.stop());
  localStream = null;
  prejoinScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
  startLobby();
});

$('join-btn').addEventListener('click', () => {
  if (!localStream || !session) return;
  startCall();
});

// ============================================================================
// Call
// ============================================================================
function startCall(): void {
  if (!session || !localStream) return;
  prejoinScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
  callRoom.textContent = session.room;
  callVis.textContent = session.isPublic ? t('public') : t('private');
  videoGrid.innerHTML = '';
  peerNames.clear();

  micOn = true;
  camOn = localStream.getVideoTracks().length > 0 && localStream.getVideoTracks()[0].enabled;
  setControlState();

  // Self cell.
  addCell(myId, session.name || t('namePlaceholder'), session.lang, true);
  attachStream(myId, localStream);
  setCameraOff(myId, !camOn);

  manualClose = false;
  openSocket();
}

function openSocket(): void {
  if (!session) return;
  const params = new URLSearchParams({ room: session.room, lang: session.lang, id: myId, public: String(session.isPublic) });
  if (session.name) params.set('name', session.name);
  ws = new WebSocket(`${WS_BASE}/ws?${params}`);

  ws.onopen = () => {
    mesh = new MeshManager(localStream!, (sig) => ws?.send(JSON.stringify(sig)));
    mesh.onRemoteStream = (peerId, stream) => attachStream(peerId, stream);
    mesh.onPeerRemoved = (peerId) => removeCell(peerId);

    audioCapture = new AudioCapture(localStream!, ws!);
    if (micOn) audioCapture.start();

    chat = new ChatManager({ myLang: session!.lang, myId, container: chatMessages, ws: ws! });
    chat.onUnread = (n) => {
      chatBadge.textContent = String(n);
      chatBadge.hidden = n === 0;
    };
  };

  ws.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleServer(msg);
  };

  ws.onclose = (e) => {
    if (!manualClose && e.code !== 1000) setTimeout(() => !manualClose && openSocket(), 2000);
  };
}

async function handleServer(msg: any): Promise<void> {
  switch (msg.type) {
    case 'room_joined':
      for (const p of msg.peers) {
        peerNames.set(p.id, { name: p.user_name, lang: p.lang });
        addCell(p.id, p.user_name, p.lang, false);
        await mesh?.addPeer(p.id, false); // they'll initiate the offer
      }
      break;
    case 'peer_joined':
      peerNames.set(msg.peer_id, { name: msg.user_name, lang: msg.lang });
      addCell(msg.peer_id, msg.user_name, msg.lang, false);
      await mesh?.addPeer(msg.peer_id, true); // we initiate toward the newcomer
      break;
    case 'peer_left':
      mesh?.removePeer(msg.peer_id);
      removeCell(msg.peer_id);
      break;
    case 'room_full':
      leaveCall();
      homeStatusMsg(t('roomFull'), true);
      break;
    case 'offer':
      await mesh?.handleOffer(msg.from, msg.sdp);
      break;
    case 'answer':
      await mesh?.handleAnswer(msg.from, msg.sdp);
      break;
    case 'ice':
      await mesh?.handleIce(msg.from, msg.candidate);
      break;
    case 'chat_message':
      chat?.addMessage(msg as ChatPayload);
      break;
    case 'peer_muted':
      if (msg.kind === 'audio') setAudioMuted(msg.peer_id, msg.muted);
      else setCameraOff(msg.peer_id, msg.muted);
      break;
    case 'subtitle_interim':
      showSubtitle(msg.speaker_id, msg.text, true);
      break;
    case 'subtitle_final': {
      const myLang = session?.lang || 'en';
      const text = msg.translations?.[myLang] ?? msg.original;
      showSubtitle(msg.speaker_id, text, false, msg.original);
      if (ttsOn && msg.speaker_id !== myId) speak(text, myLang);
      break;
    }
  }
}

// ---- Video grid ------------------------------------------------------------
function addCell(id: string, name: string, lang: string, isSelf: boolean): void {
  if (videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`)) return;
  const cell = document.createElement('div');
  cell.className = `video-cell${isSelf ? ' self' : ''}`;
  cell.dataset.peer = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isSelf) video.muted = true; // never echo yourself
  cell.appendChild(video);

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.hidden = true;
  avatar.style.background = avatarGradient(name);
  const initials = document.createElement('span');
  initials.className = 'avatar-initials';
  initials.textContent = name.slice(0, 2).toUpperCase();
  avatar.appendChild(initials);
  cell.appendChild(avatar);

  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  const nameEl = document.createElement('span');
  nameEl.className = 'peer-name';
  nameEl.textContent = isSelf ? `${name} · ${t('you')}` : name;
  const langEl = document.createElement('span');
  langEl.className = 'peer-lang';
  langEl.textContent = `${FLAG[lang] || ''} ${lang.toUpperCase()}`.trim();
  const mute = document.createElement('span');
  mute.className = 'mute-indicator';
  mute.hidden = true;
  mute.textContent = '🔇';
  overlay.append(nameEl, langEl, mute);
  cell.appendChild(overlay);

  const subs = document.createElement('div');
  subs.className = 'subtitle-area';
  cell.appendChild(subs);

  videoGrid.appendChild(cell);
  updateGridCount();
}

function removeCell(id: string): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`);
  if (cell) cell.remove();
  peerNames.delete(id);
  updateGridCount();
}

function updateGridCount(): void {
  videoGrid.dataset.peers = String(videoGrid.querySelectorAll('.video-cell').length);
}

function attachStream(id: string, stream: MediaStream): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`);
  if (!cell) return;
  const video = cell.querySelector('video') as HTMLVideoElement;
  video.srcObject = stream;
  void video.play().catch(() => {});
  const hasVideo = stream.getVideoTracks().length > 0;
  if (id !== myId) setCameraOff(id, !hasVideo);
}

function setCameraOff(id: string, off: boolean): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`);
  if (!cell) return;
  (cell.querySelector('video') as HTMLElement).style.visibility = off ? 'hidden' : 'visible';
  (cell.querySelector('.avatar') as HTMLElement).hidden = !off;
}

function setAudioMuted(id: string, muted: boolean): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`);
  if (cell) (cell.querySelector('.mute-indicator') as HTMLElement).hidden = !muted;
}

// ---- Subtitles -------------------------------------------------------------
function showSubtitle(speakerId: string, text: string, interim: boolean, original?: string): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(speakerId)}"]`);
  if (!cell) return;
  const area = cell.querySelector('.subtitle-area') as HTMLElement;
  area.innerHTML = '';
  const box = document.createElement('div');
  box.className = `subtitle${interim ? ' subtitle-interim' : ''}`;
  const main = document.createElement('span');
  main.className = 'subtitle-translation';
  main.textContent = text;
  box.appendChild(main);
  if (!interim && original && original !== text) {
    const orig = document.createElement('span');
    orig.className = 'subtitle-original';
    orig.textContent = original;
    box.appendChild(orig);
  }
  area.appendChild(box);

  const prev = subtitleTimers.get(speakerId);
  if (prev) clearTimeout(prev);
  if (!interim) {
    subtitleTimers.set(
      speakerId,
      window.setTimeout(() => {
        area.innerHTML = '';
        subtitleTimers.delete(speakerId);
      }, 6000),
    );
  }
}

// ---- Controls --------------------------------------------------------------
function setControlState(): void {
  btnMic.classList.toggle('active-danger', !micOn);
  btnMic.textContent = micOn ? '🎤' : '🔇';
  btnCam.classList.toggle('active-danger', !camOn);
  btnCam.textContent = camOn ? '📷' : '🚫';
  btnTts.classList.toggle('active-success', ttsOn);
}

btnMic.addEventListener('click', () => {
  micOn = !micOn;
  mesh?.setAudioEnabled(micOn);
  audioCapture?.setMuted(!micOn);
  setAudioMuted(myId, !micOn);
  ws?.send(JSON.stringify({ type: 'mute_audio', muted: !micOn }));
  setControlState();
});

btnCam.addEventListener('click', () => {
  camOn = !camOn;
  mesh?.setVideoEnabled(camOn);
  setCameraOff(myId, !camOn);
  ws?.send(JSON.stringify({ type: 'mute_video', muted: !camOn }));
  setControlState();
});

btnTts.addEventListener('click', () => {
  ttsOn = !ttsOn;
  if (!ttsOn && window.speechSynthesis) speechSynthesis.cancel();
  setControlState();
});

btnChat.addEventListener('click', () => toggleChat());
$('chat-close').addEventListener('click', () => toggleChat(false));
function toggleChat(force?: boolean): void {
  const open = force ?? !chatPanel.classList.contains('open');
  chatPanel.classList.toggle('open', open);
  chatPanel.classList.toggle('closed', !open);
  chat?.setOpen(open);
  if (open) chatInput.focus();
}

function sendChat(): void {
  const text = chatInput.value;
  chat?.sendMessage(text);
  chatInput.value = '';
}
$('chat-send').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

$('btn-leave').addEventListener('click', leaveCall);
function leaveCall(): void {
  manualClose = true;
  audioCapture?.stop();
  mesh?.destroy();
  if (ws) {
    ws.close(1000, 'leave');
    ws = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((tr) => tr.stop());
    localStream = null;
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  mesh = null;
  audioCapture = null;
  chat = null;
  chatPanel.classList.remove('open');
  callScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
  roomInput.value = randomRoom();
  startLobby();
}

// ---- Helpers ---------------------------------------------------------------
function avatarGradient(name: string): string {
  let hash = 0;
  for (const ch of name) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue},60%,25%), hsl(${(hue + 40) % 360},60%,15%))`;
}

function cssEsc(s: string): string {
  return (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));
}

function speak(text: string, lang: string): void {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = speechSynthesis.getVoices().find((vo) => vo.lang.toLowerCase().startsWith(lang.toLowerCase()));
  if (v) u.voice = v;
  u.lang = lang;
  u.rate = 1.1;
  speechSynthesis.speak(u);
}
if (window.speechSynthesis) speechSynthesis.getVoices();

// Copy room code from the call header.
callRoom.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(callRoom.textContent?.trim() || '');
    const prev = callVis.textContent;
    callVis.textContent = t('copied');
    setTimeout(() => (callVis.textContent = prev), 1200);
  } catch {
    /* ignore */
  }
});

// ---- Boot ------------------------------------------------------------------
startLobby();
