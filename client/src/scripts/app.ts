// VoxTranslate V2 client orchestrator: home/lobby → pre-join (camera + devices)
// → WebRTC video call with translated subtitles + chat.

import { applyI18n, detectLang, FLAG, setUiLang, t } from './i18n';
import { icon } from './icons';
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
const preMic = $<HTMLButtonElement>('pre-mic');
const preCam = $<HTMLButtonElement>('pre-cam');
const previewOff = $('preview-off');
const previewAvatar = $('preview-avatar');
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
const btnHand = $('btn-hand');
const btnChat = $('btn-chat');
const btnFullscreen = $('btn-fullscreen');
const btnPip = $('btn-pip');
const btnParticipants = $('btn-participants');
const btnView = $('btn-view');
const btnShare = $('btn-share');
const btnRecord = $('btn-record');
const notifBanner = $('notif-banner');
const participantsPanel = $('participants-panel');
const participantsList = $('participants-list');
const partClose = $('part-close');

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
let ttsOn = true; // "translated voice" mode: hear the translation, mute foreign originals
let handRaised = false;
let isFullscreen = false;
let pipWindow: Window | null = null;
let manualClose = false;
let viewMode: 'grid' | 'speaker' = 'grid';
let pinnedPeerId: string | null = null;
let lastSpeakerId: string | null = null;
let isSharingScreen = false;
let screenStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let isRecording = false;
let recordedChunks: Blob[] = [];

const peerNames = new Map<string, { name: string; lang: string }>();
const peerCamOff = new Map<string, boolean>(); // camera-off state from peer_muted
const peerMicMuted = new Map<string, boolean>(); // mic muted state from peer_muted
const peerHandRaised = new Map<string, boolean>(); // hand-raise state
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
    count.innerHTML = `${icon('users', 13)} ${r.count}/4`;
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
  micOn = true;
  camOn = true;
  try {
    await acquireMedia();
    await populateDevices();
  } catch {
    prejoinStatus.textContent = t('camMicDenied');
    prejoinStatus.classList.add('error');
  }
}

// Apply the current mic/camera toggle state to the preview stream + UI. Used in
// the pre-join screen so you enter the room already muted / camera-off.
function applyPreToggles(): void {
  const hasVideo = !!localStream && localStream.getVideoTracks().length > 0;
  if (!hasVideo) camOn = false;
  if (localStream) {
    localStream.getAudioTracks().forEach((tr) => (tr.enabled = micOn));
    localStream.getVideoTracks().forEach((tr) => (tr.enabled = camOn));
  }
  // Preview overlay when the camera is off.
  previewOff.hidden = camOn && hasVideo;
  if (!previewOff.hidden) {
    const name = nameInput.value.trim() || t('namePlaceholder');
    previewAvatar.textContent = name.slice(0, 2).toUpperCase();
    previewAvatar.style.background = avatarGradient(name);
  }
  preMic.classList.toggle('active-danger', !micOn);
  preMic.innerHTML = icon(micOn ? 'mic' : 'mic-off');
  preCam.classList.toggle('active-danger', !camOn);
  preCam.innerHTML = icon(camOn ? 'video' : 'video-off');
}

preMic.addEventListener('click', () => {
  micOn = !micOn;
  applyPreToggles();
});
preCam.addEventListener('click', () => {
  camOn = !camOn;
  applyPreToggles();
});

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
  } catch {
    // Fall back to audio-only (no camera available / denied video).
    localStream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  previewVideo.srcObject = localStream;
  void previewVideo.play().catch(() => {});
  // Re-apply the current mic/camera toggle state to the new tracks.
  applyPreToggles();
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
  videoGrid.dataset.mode = 'grid';
  peerNames.clear();

  // micOn / camOn carry over from the pre-join toggles.
  setControlState();

  // Self cell — reflect the pre-join mic/camera choice.
  addCell(myId, session.name || t('namePlaceholder'), session.lang, true);
  attachStream(myId, localStream);
  setCameraOff(myId, !camOn);
  setAudioMuted(myId, !micOn);

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
    mesh.setAudioEnabled(micOn);
    mesh.setVideoEnabled(camOn);

    audioCapture = new AudioCapture(localStream!, ws!);
    if (micOn) audioCapture.start();

    // Tell peers if we joined already muted / camera-off so their UI matches.
    if (!micOn) ws?.send(JSON.stringify({ type: 'mute_audio', muted: true }));
    if (!camOn) ws?.send(JSON.stringify({ type: 'mute_video', muted: true }));

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
      updateParticipantsList();
      break;
    case 'peer_joined':
      peerNames.set(msg.peer_id, { name: msg.user_name, lang: msg.lang });
      addCell(msg.peer_id, msg.user_name, msg.lang, false);
      await mesh?.addPeer(msg.peer_id, true); // we initiate toward the newcomer
      // Re-announce our current mute/camera state so the newcomer's UI matches.
      if (!micOn) ws?.send(JSON.stringify({ type: 'mute_audio', muted: true }));
      if (!camOn) ws?.send(JSON.stringify({ type: 'mute_video', muted: true }));
      updateParticipantsList();
      break;
    case 'peer_left':
      mesh?.removePeer(msg.peer_id);
      removeCell(msg.peer_id);
      peerHandRaised.delete(msg.peer_id);
      updateParticipantsList();
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
      if (msg.kind === 'audio') {
        peerMicMuted.set(msg.peer_id, msg.muted);
        setAudioMuted(msg.peer_id, msg.muted);
      } else {
        peerCamOff.set(msg.peer_id, msg.muted);
        setCameraOff(msg.peer_id, msg.muted);
      }
      updateParticipantsList();
      break;
    case 'emoji_reaction':
      showEmojiReaction(msg.peer_id, msg.emoji);
      break;
    case 'hand_raised':
      peerHandRaised.set(msg.peer_id, msg.raised);
      setHandIndicator(msg.peer_id, msg.raised);
      if (msg.raised && msg.peer_id !== myId) {
        const pname = peerNames.get(msg.peer_id)?.name || 'Someone';
        showNotif(`✋ ${pname} ${t('handRaisedNotif')}`);
      }
      updateParticipantsList();
      break;
    case 'subtitle_interim':
      showSubtitle(msg.speaker_id, msg.text, true);
      break;
    case 'subtitle_final': {
      const myLang = session?.lang || 'en';
      const text = msg.translations?.[myLang] ?? msg.original;
      showSubtitle(msg.speaker_id, text, false, msg.original);
      // Track active speaker for speaker view
      if (msg.speaker_id !== myId) {
        lastSpeakerId = msg.speaker_id;
        if (viewMode === 'speaker') layoutVideos();
      }
      // Speak only foreign-language speakers (same-language → you hear their
      // real voice). Their original WebRTC audio is muted by applyAudioMode().
      if (ttsOn && msg.speaker_id !== myId && msg.lang !== myLang) speak(text, myLang);
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
  mute.innerHTML = icon('mic-off', 14);
  overlay.append(nameEl, langEl, mute);
  if (!isSelf) {
    const pinBtn = document.createElement('span');
    pinBtn.className = 'pin-btn';
    pinBtn.innerHTML = icon('pin', 14);
    pinBtn.title = t('pinTip');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(id);
    });
    overlay.appendChild(pinBtn);
  }
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
  peerCamOff.delete(id);
  if (pinnedPeerId === id) pinnedPeerId = null;
  if (lastSpeakerId === id) lastSpeakerId = null;
  updateGridCount();
}

function updateGridCount(): void {
  videoGrid.dataset.peers = String(videoGrid.querySelectorAll('.video-cell').length);
  layoutVideos();
}

// The grid fills the whole stage. In focus mode (pinned or speaker), the main
// cell fills the stage and others become small overlays at the bottom-right.
function layoutVideos(): void {
  const stage = document.querySelector('.video-stage') as HTMLElement | null;
  if (!stage) return;
  const allCells = [...videoGrid.querySelectorAll<HTMLElement>('.video-cell')];
  const n = Math.max(allCells.length, 1);
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw === 0 || sh === 0) return;

  // Determine focus id
  const focusId = pinnedPeerId || (viewMode === 'speaker' ? lastSpeakerId : null);
  const focusCell = focusId ? videoGrid.querySelector<HTMLElement>(`[data-peer="${cssEsc(focusId)}"]`) : null;

  // Remove all special classes first
  allCells.forEach((c) => c.classList.remove('main-cell', 'video-thumb', 'active-speaker'));

  if (focusCell && focusId && n > 1) {
    // Focus mode: one main + thumbnails
    videoGrid.dataset.mode = 'focus';
    videoGrid.style.gridTemplateColumns = '';
    videoGrid.style.gridTemplateRows = '';
    videoGrid.style.position = 'relative';
    videoGrid.style.width = '100%';
    videoGrid.style.height = '100%';

    focusCell.classList.add('main-cell');

    for (const cell of allCells) {
      if (cell === focusCell) continue;
      cell.classList.add('video-thumb');
      // Click thumbnail to pin
      const id = cell.dataset.peer || '';
      cell.addEventListener('click', () => { if (id) togglePin(id); }, { once: true });
    }

    // Mark active speaker
    if (lastSpeakerId && lastSpeakerId !== pinnedPeerId) {
      const as = videoGrid.querySelector<HTMLElement>(`[data-peer="${cssEsc(lastSpeakerId)}"]`);
      if (as) as.classList.add('active-speaker');
    }
  } else {
    // Grid mode (default)
    videoGrid.dataset.mode = 'grid';
    let cols: number, rows: number;
    if (n <= 1) {
      cols = 1; rows = 1;
    } else if (n === 2) {
      if (sw >= sh) { cols = 2; rows = 1; }
      else { cols = 1; rows = 2; }
    } else {
      cols = 2; rows = 2;
    }
    videoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    videoGrid.style.position = '';
    videoGrid.style.width = '';
    videoGrid.style.height = '';

    // Mark active speaker in grid mode
    if (lastSpeakerId) {
      const as = videoGrid.querySelector<HTMLElement>(`[data-peer="${cssEsc(lastSpeakerId)}"]`);
      if (as) as.classList.add('active-speaker');
    }
  }
}

function togglePin(id: string): void {
  if (pinnedPeerId === id) {
    pinnedPeerId = null;
  } else {
    pinnedPeerId = id;
    if (viewMode === 'speaker') viewMode = 'grid';
  }
  setControlState();
  layoutVideos();
  updatePinButtons();
}

function updatePinButtons(): void {
  videoGrid.querySelectorAll<HTMLElement>('.pin-btn').forEach((btn) => {
    const cell = btn.closest<HTMLElement>('[data-peer]');
    const id = cell?.dataset.peer || '';
    const isPinned = id === pinnedPeerId;
    btn.innerHTML = icon(isPinned ? 'pin-off' : 'pin', 14);
    btn.title = isPinned ? t('unpinTip') : t('pinTip');
  });
}

function attachStream(id: string, stream: MediaStream): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`);
  if (!cell) return;
  const video = cell.querySelector('video') as HTMLVideoElement;
  video.srcObject = stream;
  void video.play().catch(() => {});
  // A disabled remote track still counts, so a known camera-off state (from
  // peer_muted) takes precedence over the raw track count.
  const hasVideo = stream.getVideoTracks().length > 0;
  if (id !== myId) setCameraOff(id, peerCamOff.get(id) ?? !hasVideo);
  applyAudioMode();
}

// "Translated voice" mode: when on, mute the original WebRTC audio of peers who
// speak a different language (you'll hear their TTS translation instead), so the
// original and translated voices never overlap. Same-language peers keep their
// real audio (no robotic dubbing of your own language). Self is always muted.
function applyAudioMode(): void {
  const myLang = session?.lang;
  videoGrid.querySelectorAll<HTMLElement>('.video-cell').forEach((cell) => {
    const id = cell.dataset.peer || '';
    const video = cell.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;
    if (id === myId) {
      video.muted = true;
      return;
    }
    const peerLang = peerNames.get(id)?.lang;
    video.muted = !!(ttsOn && peerLang && myLang && peerLang !== myLang);
  });
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

function setHandIndicator(id: string, raised: boolean): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(id)}"]`);
  if (!cell) return;
  let indicator = cell.querySelector('.hand-indicator') as HTMLElement | null;
  if (raised) {
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'hand-indicator';
      indicator.textContent = '✋';
      cell.appendChild(indicator);
    }
  } else if (indicator) {
    indicator.remove();
  }
}

function showEmojiReaction(peerId: string, emoji: string): void {
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(peerId)}"]`);
  if (!cell) return;
  const floater = document.createElement('span');
  floater.className = 'emoji-float';
  floater.textContent = emoji;
  cell.appendChild(floater);
  setTimeout(() => floater.remove(), 1500);
}

// ---- Notification banner ---------------------------------------------------
let notifTimer: number | null = null;
function showNotif(text: string): void {
  notifBanner.textContent = text;
  notifBanner.classList.remove('hidden');
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = window.setTimeout(() => notifBanner.classList.add('hidden'), 4000);
}

// ---- Participants panel ----------------------------------------------------
function toggleParticipants(force?: boolean): void {
  const open = force ?? participantsPanel.classList.contains('closed');
  participantsPanel.classList.toggle('open', open);
  participantsPanel.classList.toggle('closed', !open);
  if (open) updateParticipantsList();
  setTimeout(layoutVideos, 320);
}

partClose.addEventListener('click', () => toggleParticipants(false));

function updateParticipantsList(): void {
  const myLang = session?.lang || 'en';
  const myName = session?.name || t('namePlaceholder');
  const items: Array<{ id: string; name: string; lang: string; isSelf: boolean; micMuted: boolean; handRaised: boolean }> = [];

  items.push({ id: myId, name: myName, lang: myLang, isSelf: true, micMuted: !micOn, handRaised });
  for (const [id, info] of peerNames) {
    items.push({ id, name: info.name, lang: info.lang, isSelf: false, micMuted: peerMicMuted.get(id) ?? false, handRaised: peerHandRaised.get(id) ?? false });
  }

  participantsList.innerHTML = '';
  for (const p of items) {
    const el = document.createElement('div');
    el.className = `part-item${p.isSelf ? ' self' : ''}`;

    const avatar = document.createElement('span');
    avatar.className = 'part-avatar';
    avatar.style.background = avatarGradient(p.name);
    avatar.textContent = p.name.slice(0, 2).toUpperCase();

    const info = document.createElement('div');
    info.className = 'part-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'part-name';
    nameEl.innerHTML = `${FLAG[p.lang] || ''} ${p.name}${p.isSelf ? ` · ${t('you')}` : ''}`.trim();
    const langEl = document.createElement('div');
    langEl.className = 'part-lang';
    langEl.textContent = p.lang.toUpperCase();
    info.append(nameEl, langEl);

    const status = document.createElement('div');
    status.className = 'part-status';
    if (p.handRaised) {
      const hand = document.createElement('span');
      hand.className = 'part-hand';
      hand.textContent = '✋';
      status.appendChild(hand);
    }
    if (p.micMuted) {
      status.innerHTML += icon('mic-off', 16);
      status.querySelector('.ico')?.classList.add('part-status-danger');
    }

    el.append(avatar, info, status);
    participantsList.appendChild(el);
  }
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
  btnMic.innerHTML = icon(micOn ? 'mic' : 'mic-off');
  btnCam.classList.toggle('active-danger', !camOn);
  btnCam.innerHTML = icon(camOn ? 'video' : 'video-off');
  btnTts.classList.toggle('active-success', ttsOn);
  btnTts.innerHTML = icon(ttsOn ? 'volume-on' : 'volume-off');
  btnHand.classList.toggle('active-success', handRaised);
  btnHand.innerHTML = icon(handRaised ? 'hand-raised' : 'hand');
  btnHand.title = handRaised ? t('handUp') : t('handTip');
  btnFullscreen.innerHTML = icon(document.fullscreenElement ? 'fullscreen-off' : 'fullscreen');
  btnPip.innerHTML = icon('pip');
  btnView.innerHTML = icon(viewMode === 'speaker' ? 'speaker' : 'grid');
  btnView.title = t(viewMode === 'speaker' ? 'viewGrid' : 'viewSpeaker');
  btnShare.innerHTML = icon(isSharingScreen ? 'monitor' : 'monitor');
  btnShare.classList.toggle('active-success', isSharingScreen);
  btnShare.title = isSharingScreen ? t('stopShare') : t('screenShareTip');
  btnRecord.innerHTML = icon('recording');
  btnRecord.classList.toggle('active-danger', isRecording);
  btnRecord.title = isRecording ? t('recording') : t('recordingTip');
  const partIco = btnParticipants.querySelector('.part-ico');
  if (partIco) partIco.innerHTML = icon('users');
  const chatIco = btnChat.querySelector('.chat-ico');
  if (chatIco) chatIco.innerHTML = icon('chat');
  const leave = document.getElementById('btn-leave');
  if (leave) leave.innerHTML = icon('leave');
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
  applyAudioMode(); // mute/unmute foreign originals to match the mode
  setControlState();
});

btnHand.addEventListener('click', () => {
  handRaised = !handRaised;
  ws?.send(JSON.stringify({ type: 'hand_raise', raised: handRaised }));
  setControlState();
});

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

btnPip.addEventListener('click', () => {
  if (pipWindow && !pipWindow.closed) {
    pipWindow.close();
    pipWindow = null;
    return;
  }
  if ('documentPictureInPicture' in window) {
    (window as any).documentPictureInPicture.requestWindow({ width: 480, height: 360 }).then((w: Window) => {
      pipWindow = w;
      const stage = document.querySelector('.video-stage') as HTMLElement;
      if (stage) {
        w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
        const clone = stage.cloneNode(true) as HTMLElement;
        clone.style.cssText = 'width:100%;height:100dvh';
        w.document.body.appendChild(clone);
        // Re-set video srcObjects in the cloned stage
        clone.querySelectorAll('video').forEach((v) => {
          const peer = (v.closest('[data-peer]') as HTMLElement)?.dataset.peer;
          if (!peer) return;
          const cell = videoGrid.querySelector(`[data-peer="${cssEsc(peer)}"]`);
          if (cell) {
            const src = (cell.querySelector('video') as HTMLVideoElement)?.srcObject;
            if (src) v.srcObject = src;
          }
        });
      }
      w.addEventListener('pagehide', () => { pipWindow = null; });
    }).catch(() => {});
  }
});

btnView.addEventListener('click', () => {
  viewMode = viewMode === 'grid' ? 'speaker' : 'grid';
  if (viewMode === 'grid') pinnedPeerId = null;
  setControlState();
  layoutVideos();
  updatePinButtons();
});

btnShare.addEventListener('click', () => {
  if (isSharingScreen) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
});

async function startScreenShare(): Promise<void> {
  if (!mesh || !localStream) return;
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenStream = s;
    isSharingScreen = true;
    // Replace video track on all peers with screen track (audio stays from mic)
    mesh.setLocalStream(s);
    // Show indicator on self cell
    const cell = videoGrid.querySelector(`[data-peer="${cssEsc(myId)}"]`);
    if (cell) {
      let badge = cell.querySelector('.screen-share-badge') as HTMLElement | null;
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'screen-share-badge';
        badge.textContent = '🖥';
        cell.querySelector('.video-overlay')?.appendChild(badge);
      }
    }
    // Stop sharing when user clicks "Stop sharing" in browser
    s.getVideoTracks()[0]?.addEventListener('ended', stopScreenShare);
    setControlState();
  } catch {
    // User cancelled
  }
}

function stopScreenShare(): void {
  if (!isSharingScreen || !mesh || !localStream) return;
  isSharingScreen = false;
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  // Restore camera stream
  mesh.setLocalStream(localStream);
  // Remove badge
  const cell = videoGrid.querySelector(`[data-peer="${cssEsc(myId)}"]`);
  cell?.querySelector('.screen-share-badge')?.remove();
  setControlState();
  showNotif(t('stopShare'));
}

btnRecord.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

function startRecording(): void {
  if (!localStream) return;
  recordedChunks = [];
  try {
    const mimeType = 'video/webm;codecs=vp9,opus';
    mediaRecorder = new MediaRecorder(localStream, { mimeType });
  } catch {
    try {
      mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    } catch {
      mediaRecorder = new MediaRecorder(localStream);
    }
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    if (recordedChunks.length === 0) return;
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxtranslate-${session?.room || 'call'}-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  };
  mediaRecorder.start(1000);
  isRecording = true;
  showNotif(t('recording'));
  setControlState();
}

function stopRecording(): void {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  isRecording = false;
  setControlState();
}

btnParticipants.addEventListener('click', () => toggleParticipants());

btnChat.addEventListener('click', () => toggleChat());
$('chat-close').addEventListener('click', () => toggleChat(false));
function toggleChat(force?: boolean): void {
  const open = force ?? !chatPanel.classList.contains('open');
  chatPanel.classList.toggle('open', open);
  chatPanel.classList.toggle('closed', !open);
  chat?.setOpen(open);
  if (open) chatInput.focus();
  // The desktop sidebar narrows call-main — re-fit after the transition.
  setTimeout(layoutVideos, 320);
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
  if (pipWindow && !pipWindow.closed) { pipWindow.close(); pipWindow = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (isSharingScreen) stopScreenShare();
  if (isRecording) stopRecording();
  if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
  if (ws) {
    ws.close(1000, 'leave');
    ws = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((tr) => tr.stop());
    localStream = null;
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  handRaised = false;
  isFullscreen = false;
  viewMode = 'grid';
  pinnedPeerId = null;
  lastSpeakerId = null;
  mesh = null;
  audioCapture = null;
  chat = null;
  chatPanel.classList.remove('open');
  participantsPanel.classList.remove('open');
  participantsPanel.classList.add('closed');
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
window.addEventListener('resize', layoutVideos);
window.addEventListener('orientationchange', () => setTimeout(layoutVideos, 200));
document.addEventListener('fullscreenchange', setControlState);
$('dice').innerHTML = icon('shuffle', 18);
$('chat-close').innerHTML = icon('close', 16);
$('chat-send').innerHTML = icon('send', 20);
$('part-close').innerHTML = icon('close', 16);

// ---- Emoji picker ----------------------------------------------------------
const EMOJI_LIST = ['👍','❤️','😂','😮','😢','👏','🎉','🔥','💯','✅','🤔','😍','🙌','💪','🤝','😊','🥳','😎','🤬','👎'];
const emojiToggle = $('emoji-toggle');
const emojiPanel = $('emoji-panel');
const emojiGrid = $('emoji-grid');

for (const em of EMOJI_LIST) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = em;
  btn.addEventListener('click', () => sendEmoji(em));
  emojiGrid.appendChild(btn);
}

emojiToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle('hidden');
});
document.addEventListener('click', () => emojiPanel.classList.add('hidden'));

function sendEmoji(emoji: string): void {
  ws?.send(JSON.stringify({ type: 'emoji', emoji }));
  emojiPanel.classList.add('hidden');
}

startLobby();
