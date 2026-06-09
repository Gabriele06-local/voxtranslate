// VoxTranslate V2 client orchestrator: home/lobby → pre-join (camera + devices)
// → WebRTC video call with translated subtitles + chat.

import { applyI18n, detectLang, FLAG, setUiLang, t } from './i18n';
import { icon } from './icons';
import { MeshManager } from './webrtc';
import { AudioCapture } from './audio-capture';
import { ChatManager, type ChatPayload } from './chat';
import * as auth from './auth';

// ---- Config ----------------------------------------------------------------
const WS_HOST = import.meta.env.PUBLIC_WS_HOST || location.host;
const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${WS_PROTO}//${WS_HOST}`;
const HTTP_BASE = WS_BASE.replace(/^ws/, 'http');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- Screens ---------------------------------------------------------------
const loginScreen = $('login');
const homeScreen = $('home');
const prejoinScreen = $('prejoin');
const callScreen = $('call');

// ---- Auth / billing refs ---------------------------------------------------
const accountBar = $('account-bar');
const accountAvatar = $<HTMLImageElement>('account-avatar');
const accountName = $('account-name');
const accountBalance = $('account-balance');
const callBalance = $('call-balance');
const lowBanner = $('low-banner');
const lowBannerText = $('low-banner-text');
const buyModal = $('buy-modal');
const packagesList = $('packages-list');
const ledgerList = $('ledger-list');
const modalBalance = $('modal-balance');
const buyStatus = $('buy-status');
const exhaustedModal = $('exhausted-modal');

let billing = false; // accounts/credits enabled on this backend
let exhaustedIsGuest = false; // last balance_exhausted was a guest trial vs a billed user

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
let ttsOn = true; // "translated voice" mode: hear the translation, mute foreign originals
let manualClose = false;

const peerNames = new Map<string, { name: string; lang: string; avatar?: string | null }>();
const peerCamOff = new Map<string, boolean>(); // camera-off state from peer_muted
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
  // Preview overlay when the camera is off: show the Google photo when logged in,
  // initials otherwise (same as the in-call camera-off cell).
  previewOff.hidden = camOn && hasVideo;
  if (!previewOff.hidden) {
    const name = nameInput.value.trim() || t('namePlaceholder');
    const avatar =
      billing && auth.isLoggedIn() ? auth.avatarUrl(auth.getUser()?.avatar_url, 192) : null;
    if (avatar) {
      previewAvatar.textContent = '';
      previewAvatar.style.background = 'none';
      const img = document.createElement('img');
      img.className = 'preview-avatar-img';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.src = avatar;
      img.addEventListener('error', () => {
        // Fall back to initials if the photo fails to load.
        img.remove();
        previewAvatar.textContent = name.slice(0, 2).toUpperCase();
        previewAvatar.style.background = avatarGradient(name);
      });
      previewAvatar.appendChild(img);
    } else {
      previewAvatar.textContent = name.slice(0, 2).toUpperCase();
      previewAvatar.style.background = avatarGradient(name);
    }
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
  peerNames.clear();

  // micOn / camOn carry over from the pre-join toggles.
  setControlState();

  // Self cell — reflect the pre-join mic/camera choice.
  const myAvatar = billing && auth.isLoggedIn() ? auth.getUser()?.avatar_url : null;
  addCell(myId, session.name || t('namePlaceholder'), session.lang, true, myAvatar);
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
  ws = new WebSocket(auth.buildWsUrl(params));

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
        peerNames.set(p.id, { name: p.user_name, lang: p.lang, avatar: p.avatar_url });
        addCell(p.id, p.user_name, p.lang, false, p.avatar_url);
        await mesh?.addPeer(p.id, false); // they'll initiate the offer
      }
      break;
    case 'peer_joined':
      peerNames.set(msg.peer_id, { name: msg.user_name, lang: msg.lang, avatar: msg.avatar_url });
      addCell(msg.peer_id, msg.user_name, msg.lang, false, msg.avatar_url);
      await mesh?.addPeer(msg.peer_id, true); // we initiate toward the newcomer
      // Re-announce our current mute/camera state so the newcomer's UI matches.
      if (!micOn) ws?.send(JSON.stringify({ type: 'mute_audio', muted: true }));
      if (!camOn) ws?.send(JSON.stringify({ type: 'mute_video', muted: true }));
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
      if (msg.kind === 'audio') {
        setAudioMuted(msg.peer_id, msg.muted);
      } else {
        peerCamOff.set(msg.peer_id, msg.muted);
        setCameraOff(msg.peer_id, msg.muted);
      }
      break;
    case 'subtitle_interim':
      showSubtitle(msg.speaker_id, msg.text, true);
      break;
    case 'subtitle_final': {
      const myLang = session?.lang || 'en';
      const text = msg.translations?.[myLang] ?? msg.original;
      showSubtitle(msg.speaker_id, text, false, msg.original);
      // Speak only foreign-language speakers (same-language → you hear their
      // real voice). Their original WebRTC audio is muted by applyAudioMode().
      if (ttsOn && msg.speaker_id !== myId && msg.lang !== myLang) speak(text, myLang);
      break;
    }
    // ---- Billing (only sent to authenticated speakers) ----
    case 'balance_update':
      if (typeof msg.balance === 'number') {
        auth.setBalance(msg.balance);
        setBalanceUi(msg.balance);
        show(lowBanner, false);
      }
      break;
    case 'low_balance':
      if (typeof msg.balance === 'number') {
        auth.setBalance(msg.balance);
        setBalanceUi(msg.balance);
        lowBannerText.textContent = `${t('lowBalanceWarn')} · ${auth.formatCredits(msg.balance)}`;
        show(lowBanner, true);
      }
      break;
    case 'balance_exhausted': {
      // The server closed our STT session; stop feeding it audio (WebRTC stays
      // up so peers still hear us). The modal adapts: a billed user is out of
      // credits (→ buy); a guest's free trial ended (→ sign in).
      audioCapture?.stop();
      const loggedIn = billing && auth.isLoggedIn();
      exhaustedIsGuest = !loggedIn;
      $('exhausted-title').textContent = t(loggedIn ? 'outOfCredits' : 'trialEnded');
      $('exhausted-text').textContent = t(loggedIn ? 'outOfCreditsText' : 'trialEndedText');
      $('exhausted-buy').textContent = t(loggedIn ? 'buyCredits' : 'signIn');
      if (loggedIn) {
        auth.setBalance(0);
        setBalanceUi(0);
      }
      show(exhaustedModal, true);
      break;
    }
    case 'error':
      if (msg.code === 'insufficient_balance') {
        leaveCall();
        homeStatusMsg(t('outOfCredits'), true);
        if (billing) openBuyModal();
      } else if (msg.message) {
        // Non-fatal; surface transiently in the call header area.
        callVis.textContent = msg.message;
      }
      break;
  }
}

// ---- Video grid ------------------------------------------------------------
function addCell(id: string, name: string, lang: string, isSelf: boolean, avatarSrc?: string | null): void {
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
  const av = auth.avatarUrl(avatarSrc, 168);
  if (av) {
    const img = document.createElement('img');
    img.className = 'avatar-img';
    img.referrerPolicy = 'no-referrer';
    img.alt = name;
    img.src = av;
    img.addEventListener('error', () => {
      // Fall back to initials if the Google image fails to load.
      img.remove();
      const initials = document.createElement('span');
      initials.className = 'avatar-initials';
      initials.textContent = name.slice(0, 2).toUpperCase();
      avatar.appendChild(initials);
    });
    avatar.appendChild(img);
  } else {
    const initials = document.createElement('span');
    initials.className = 'avatar-initials';
    initials.textContent = name.slice(0, 2).toUpperCase();
    avatar.appendChild(initials);
  }
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
  updateGridCount();
}

function updateGridCount(): void {
  videoGrid.dataset.peers = String(videoGrid.querySelectorAll('.video-cell').length);
  layoutVideos();
}

// The grid fills the whole stage (videos use object-fit: cover, so they keep
// their proportions and fill the space with minimal cropping — no black bars,
// no scroll). Columns/rows adapt to count + orientation so cells stay as close
// to the camera aspect as possible (portrait stacks two peers vertically).
function layoutVideos(): void {
  const stage = document.querySelector('.video-stage') as HTMLElement | null;
  if (!stage) return;
  const n = Math.max(videoGrid.querySelectorAll('.video-cell').length, 1);
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw === 0 || sh === 0) return;

  let cols: number;
  let rows: number;
  if (n <= 1) {
    cols = 1;
    rows = 1;
  } else if (n === 2) {
    if (sw >= sh) {
      cols = 2;
      rows = 1;
    } else {
      cols = 1;
      rows = 2;
    }
  } else {
    cols = 2;
    rows = 2;
  }
  videoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
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

// ============================================================================
// Auth + billing
// ============================================================================
function show(el: HTMLElement, visible: boolean): void {
  el.classList.toggle('hidden', !visible);
}

async function boot(): Promise<void> {
  billing = await auth.billingEnabled();
  if (billing && !auth.isLoggedIn()) {
    showLogin();
  } else {
    enterHome();
  }
  // Returned from a Stripe checkout → refresh balance + tidy the URL.
  if (billing && auth.isLoggedIn() && location.search.includes('checkout=success')) {
    await auth.refreshMe();
    renderAccount();
    history.replaceState(null, '', location.pathname);
  }
}

function showLogin(): void {
  loginScreen.classList.remove('hidden');
  homeScreen.classList.add('hidden');
  setupGoogleSignIn();
}

function enterHome(): void {
  loginScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
  if (billing && auth.isLoggedIn()) {
    const u = auth.getUser()!;
    if (u.name && !nameInput.value) nameInput.value = u.name;
    renderAccount();
    void auth.refreshMe().then(() => renderAccount());
  }
  startLobby();
}

function renderAccount(): void {
  const u = auth.getUser();
  if (!billing || !u) {
    accountBar.classList.add('hidden');
    return;
  }
  accountBar.classList.remove('hidden');
  accountName.textContent = u.name;
  const av = auth.avatarUrl(u.avatar_url, 72);
  if (av) {
    accountAvatar.src = av;
    accountAvatar.style.display = '';
  } else {
    accountAvatar.style.display = 'none';
  }
  setBalanceUi(u.balance);
}

function setBalanceUi(balance: number): void {
  const low = balance < 0.5;
  accountBalance.textContent = auth.formatCredits(balance);
  accountBalance.classList.toggle('low', low);
  callBalance.classList.remove('hidden');
  callBalance.textContent = auth.formatCredits(balance);
  callBalance.classList.toggle('low', low);
}

// --- Google Identity Services ---
let gsiLoaded = false;
function setupGoogleSignIn(): void {
  const clientId = auth.getGoogleClientId();
  const container = document.getElementById('gsi-button');
  if (!clientId || !container) return;
  loadGsi()
    .then(() => {
      const g = (window as unknown as { google?: any }).google;
      if (!g?.accounts?.id) return;
      g.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
      container.innerHTML = '';
      g.accounts.id.renderButton(container, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with' });
    })
    .catch(() => {});
}

function loadGsi(): Promise<void> {
  if (gsiLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => {
      gsiLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error('gsi load failed'));
    document.head.appendChild(s);
  });
}

async function onGoogleCredential(resp: { credential?: string }): Promise<void> {
  if (!resp.credential) return;
  try {
    await auth.loginWithGoogle(resp.credential);
    enterHome();
  } catch {
    /* stay on the login screen; the user can retry */
  }
}

$('guest-btn').addEventListener('click', () => enterHome());
$('logout-btn').addEventListener('click', () => {
  auth.clearSession();
  accountBar.classList.add('hidden');
  showLogin();
});

// --- Buy-credits modal ---
function openBuyModal(): void {
  show(buyModal, true);
  buyStatus.textContent = '';
  buyStatus.classList.remove('error');
  const u = auth.getUser();
  if (u) modalBalance.textContent = auth.formatCredits(u.balance);
  void renderPackages();
  selectTab('history');
}

async function renderPackages(): Promise<void> {
  packagesList.innerHTML = '';
  const pkgs = await auth.fetchPackages();
  for (const p of pkgs) {
    const btn = document.createElement('button');
    btn.className = 'pkg';
    btn.type = 'button';
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'pkg-name';
    name.textContent = p.name;
    const credits = document.createElement('div');
    credits.className = 'pkg-credits';
    credits.textContent = `${auth.formatCredits(p.credits_usd)} ${t('history').toLowerCase()}`;
    left.append(name, credits);
    const price = document.createElement('span');
    price.className = 'pkg-price';
    price.textContent = auth.formatCredits(p.price_usd);
    btn.append(left, price);
    btn.addEventListener('click', () => checkout(p.id, btn));
    packagesList.appendChild(btn);
  }
}

async function checkout(pkgId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  buyStatus.textContent = '';
  buyStatus.classList.remove('error');
  try {
    location.href = await auth.startCheckout(pkgId);
  } catch (e) {
    // Surface the failure instead of doing nothing (e.g. Stripe rejected the
    // price — common when the configured price IDs don't match the key's mode).
    console.error('checkout failed:', e);
    buyStatus.textContent = t('checkoutFailed');
    buyStatus.classList.add('error');
    btn.disabled = false;
  }
}

function selectTab(which: 'history' | 'usage'): void {
  $('tab-history').classList.toggle('active', which === 'history');
  $('tab-usage').classList.toggle('active', which === 'usage');
  void loadLedger(which);
}

async function loadLedger(which: 'history' | 'usage'): Promise<void> {
  ledgerList.innerHTML = '';
  let rows: any[] = which === 'history' ? await auth.fetchHistory() : await auth.fetchUsage();
  // "Crediti" shows money in (welcome + purchases); per-call usage lives in the
  // "Utilizzo" tab, so don't repeat each speaking-time deduction here.
  if (which === 'history') rows = rows.filter((r) => r.kind !== 'usage');
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'ledger-empty';
    empty.textContent = t('noActivity');
    ledgerList.appendChild(empty);
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ledger-row';
    const desc = document.createElement('span');
    desc.className = 'ledger-desc';
    const amount = document.createElement('span');
    amount.className = 'ledger-amount';
    if (which === 'history') {
      desc.textContent = r.description || r.kind;
      amount.textContent = `${r.amount >= 0 ? '+' : ''}${auth.formatCredits(r.amount)}`;
      amount.classList.add(r.amount >= 0 ? 'pos' : 'neg');
    } else {
      desc.textContent = `${r.room} · ${Math.round(r.speaking_seconds)}s`;
      amount.textContent = `-${auth.formatCredits(r.cost)}`;
      amount.classList.add('neg');
    }
    row.append(desc, amount);
    ledgerList.appendChild(row);
  }
}

$('buy-btn').addEventListener('click', openBuyModal);
$('buy-close').addEventListener('click', () => show(buyModal, false));
buyModal.addEventListener('click', (e) => {
  if (e.target === buyModal) show(buyModal, false);
});
$('low-banner-buy').addEventListener('click', openBuyModal);
$('tab-history').addEventListener('click', () => selectTab('history'));
$('tab-usage').addEventListener('click', () => selectTab('usage'));
$('exhausted-dismiss').addEventListener('click', () => show(exhaustedModal, false));
$('exhausted-buy').addEventListener('click', () => {
  show(exhaustedModal, false);
  if (exhaustedIsGuest) {
    // Guests can't buy — send them to the login gate to continue with an account.
    leaveCall();
    showLogin();
  } else {
    openBuyModal();
  }
});

// ---- Boot ------------------------------------------------------------------
window.addEventListener('resize', layoutVideos);
window.addEventListener('orientationchange', () => setTimeout(layoutVideos, 200));
$('dice').innerHTML = icon('shuffle', 18);
$('chat-close').innerHTML = icon('close', 16);
$('chat-send').innerHTML = icon('send', 20);
$('logout-btn').innerHTML = icon('leave', 16);
$('buy-close').innerHTML = icon('close', 16);
void boot();
