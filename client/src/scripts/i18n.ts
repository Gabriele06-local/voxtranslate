// UI internationalization. The interface language follows the chosen "my
// language", defaulting from the browser (fallback: en).

export const SUPPORTED = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ja', 'zh'] as const;

export const ENDONYM: Record<string, string> = {
  it: 'Italiano', en: 'English', es: 'Español', fr: 'Français',
  de: 'Deutsch', pt: 'Português', ja: '日本語', zh: '中文',
};

export const FLAG: Record<string, string> = {
  it: '🇮🇹', en: '🇬🇧', es: '🇪🇸', fr: '🇫🇷',
  de: '🇩🇪', pt: '🇵🇹', ja: '🇯🇵', zh: '🇨🇳',
};

type Dict = Record<string, string>;

export const I18N: Record<string, Dict> = {
  en: {
    tagline: 'Real-time translated video calls', roomCode: 'Room code', copy: 'Copy',
    copied: 'Copied', copyFailed: 'Copy failed', nameLabel: 'Your name', namePlaceholder: 'Guest',
    langLabel: 'Your language', connect: 'Enter room', enterRoom: 'Enter a room code',
    camMicDenied: 'Camera/microphone access denied', connecting: 'Connecting…', roomFull: 'This room is full (max 4)',
    createOrJoin: 'Create or join a room', visibility: 'Visibility', public: 'Public', private: 'Private',
    publicRooms: 'Public rooms online', noPublicRooms: 'No public rooms yet — create one!',
    refresh: 'Refresh', privateHint: "Private rooms aren't listed in the lobby",
    prejoinTitle: 'Ready to join?', camera: 'Camera', microphone: 'Microphone', join: 'Join now', back: 'Back',
    you: 'You', waitingPeers: 'Waiting for others to join…', connectionLost: 'Connection lost — reconnecting…',
    chatTitle: 'Chat', chatPlaceholder: 'Type a message…', send: 'Send',
    muteTip: 'Microphone', camTip: 'Camera', ttsTip: 'Speak translations', chatTip: 'Chat', leaveTip: 'Leave',
    handTip: 'Raise hand', handUp: 'Lower hand',
    fullscreenTip: 'Fullscreen', pipTip: 'Picture in Picture', participants: 'Participants', participantsTip: 'Participants',
    handRaisedNotif: 'raised hand',
    pinTip: 'Pin video', unpinTip: 'Unpin video', viewGrid: 'Grid view', viewSpeaker: 'Speaker view',
  },
  it: {
    tagline: 'Videochiamate tradotte in tempo reale', roomCode: 'Codice stanza', copy: 'Copia',
    copied: 'Copiato', copyFailed: 'Copia non riuscita', nameLabel: 'Il tuo nome', namePlaceholder: 'Ospite',
    langLabel: 'La tua lingua', connect: 'Entra', enterRoom: 'Inserisci un codice stanza',
    camMicDenied: 'Accesso a camera/microfono negato', connecting: 'Connessione…', roomFull: 'Stanza piena (max 4)',
    createOrJoin: 'Crea o entra in una stanza', visibility: 'Visibilità', public: 'Pubblica', private: 'Privata',
    publicRooms: 'Stanze pubbliche online', noPublicRooms: 'Ancora nessuna stanza pubblica — creane una!',
    refresh: 'Aggiorna', privateHint: 'Le stanze private non compaiono nella lobby',
    prejoinTitle: 'Pronto a entrare?', camera: 'Camera', microphone: 'Microfono', join: 'Entra ora', back: 'Indietro',
    you: 'Tu', waitingPeers: 'In attesa di altri partecipanti…', connectionLost: 'Connessione persa — riconnessione…',
    chatTitle: 'Chat', chatPlaceholder: 'Scrivi un messaggio…', send: 'Invia',
    muteTip: 'Microfono', camTip: 'Camera', ttsTip: 'Pronuncia traduzioni', chatTip: 'Chat', leaveTip: 'Esci',
    handTip: 'Alza mano', handUp: 'Abbassa mano',
    fullscreenTip: 'Schermo intero', pipTip: 'Picture in Picture', participants: 'Partecipanti', participantsTip: 'Partecipanti',
    handRaisedNotif: 'ha alzato la mano',
    pinTip: 'Fissa video', unpinTip: 'Rimuovi fissaggio', viewGrid: 'Griglia', viewSpeaker: 'Relatore',
  },
  es: {
    tagline: 'Videollamadas traducidas en tiempo real', roomCode: 'Código de sala', copy: 'Copiar',
    copied: 'Copiado', copyFailed: 'Error al copiar', nameLabel: 'Tu nombre', namePlaceholder: 'Invitado',
    langLabel: 'Tu idioma', connect: 'Entrar', enterRoom: 'Introduce un código de sala',
    camMicDenied: 'Acceso a cámara/micrófono denegado', connecting: 'Conectando…', roomFull: 'Sala llena (máx 4)',
    createOrJoin: 'Crea o únete a una sala', visibility: 'Visibilidad', public: 'Pública', private: 'Privada',
    publicRooms: 'Salas públicas en línea', noPublicRooms: 'Aún no hay salas públicas — ¡crea una!',
    refresh: 'Actualizar', privateHint: 'Las salas privadas no aparecen en el lobby',
    prejoinTitle: '¿Listo para entrar?', camera: 'Cámara', microphone: 'Micrófono', join: 'Entrar', back: 'Atrás',
    you: 'Tú', waitingPeers: 'Esperando a otros participantes…', connectionLost: 'Conexión perdida — reconectando…',
    chatTitle: 'Chat', chatPlaceholder: 'Escribe un mensaje…', send: 'Enviar',
    muteTip: 'Micrófono', camTip: 'Cámara', ttsTip: 'Leer traducciones', chatTip: 'Chat', leaveTip: 'Salir',
    handTip: 'Levantar mano', handUp: 'Bajar mano',
    fullscreenTip: 'Pantalla completa', pipTip: 'Picture in Picture', participants: 'Participantes', participantsTip: 'Participantes',
    handRaisedNotif: 'levantó la mano',
    pinTip: 'Fijar video', unpinTip: 'Desfijar video', viewGrid: 'Cuadrícula', viewSpeaker: 'Orador',
  },
  fr: {
    tagline: 'Appels vidéo traduits en temps réel', roomCode: 'Code de salle', copy: 'Copier',
    copied: 'Copié', copyFailed: 'Échec de la copie', nameLabel: 'Votre nom', namePlaceholder: 'Invité',
    langLabel: 'Votre langue', connect: 'Rejoindre', enterRoom: 'Saisissez un code de salle',
    camMicDenied: 'Accès caméra/micro refusé', connecting: 'Connexion…', roomFull: 'Salle pleine (max 4)',
    createOrJoin: 'Créer ou rejoindre une salle', visibility: 'Visibilité', public: 'Publique', private: 'Privée',
    publicRooms: 'Salles publiques en ligne', noPublicRooms: 'Aucune salle publique — créez-en une !',
    refresh: 'Actualiser', privateHint: "Les salles privées n'apparaissent pas dans le lobby",
    prejoinTitle: 'Prêt à rejoindre ?', camera: 'Caméra', microphone: 'Micro', join: 'Rejoindre', back: 'Retour',
    you: 'Vous', waitingPeers: "En attente d'autres participants…", connectionLost: 'Connexion perdue — reconnexion…',
    chatTitle: 'Chat', chatPlaceholder: 'Écrivez un message…', send: 'Envoyer',
    muteTip: 'Micro', camTip: 'Caméra', ttsTip: 'Lire les traductions', chatTip: 'Chat', leaveTip: 'Quitter',
    handTip: 'Lever la main', handUp: 'Baisser la main',
    fullscreenTip: 'Plein écran', pipTip: 'Picture in Picture', participants: 'Participants', participantsTip: 'Participants',
    handRaisedNotif: 'a levé la main',
    pinTip: 'Épingler', unpinTip: 'Détacher', viewGrid: 'Grille', viewSpeaker: 'Intervenant',
  },
  de: {
    tagline: 'Übersetzte Videoanrufe in Echtzeit', roomCode: 'Raumcode', copy: 'Kopieren',
    copied: 'Kopiert', copyFailed: 'Kopieren fehlgeschlagen', nameLabel: 'Dein Name', namePlaceholder: 'Gast',
    langLabel: 'Deine Sprache', connect: 'Beitreten', enterRoom: 'Gib einen Raumcode ein',
    camMicDenied: 'Kamera-/Mikrofonzugriff verweigert', connecting: 'Verbinden…', roomFull: 'Raum voll (max. 4)',
    createOrJoin: 'Raum erstellen oder beitreten', visibility: 'Sichtbarkeit', public: 'Öffentlich', private: 'Privat',
    publicRooms: 'Öffentliche Räume online', noPublicRooms: 'Noch keine öffentlichen Räume — erstelle einen!',
    refresh: 'Aktualisieren', privateHint: 'Private Räume erscheinen nicht in der Lobby',
    prejoinTitle: 'Bereit beizutreten?', camera: 'Kamera', microphone: 'Mikrofon', join: 'Beitreten', back: 'Zurück',
    you: 'Du', waitingPeers: 'Warte auf weitere Teilnehmer…', connectionLost: 'Verbindung verloren — neu verbinden…',
    chatTitle: 'Chat', chatPlaceholder: 'Nachricht schreiben…', send: 'Senden',
    muteTip: 'Mikrofon', camTip: 'Kamera', ttsTip: 'Übersetzungen vorlesen', chatTip: 'Chat', leaveTip: 'Verlassen',
    handTip: 'Hand heben', handUp: 'Hand senken',
    fullscreenTip: 'Vollbild', pipTip: 'Bild im Bild', participants: 'Teilnehmer', participantsTip: 'Teilnehmer',
    handRaisedNotif: 'hat die Hand gehoben',
    pinTip: 'Video anheften', unpinTip: 'Loslösen', viewGrid: 'Raster', viewSpeaker: 'Sprecher',
  },
  pt: {
    tagline: 'Videochamadas traduzidas em tempo real', roomCode: 'Código da sala', copy: 'Copiar',
    copied: 'Copiado', copyFailed: 'Falha ao copiar', nameLabel: 'Seu nome', namePlaceholder: 'Convidado',
    langLabel: 'Seu idioma', connect: 'Entrar', enterRoom: 'Insira um código de sala',
    camMicDenied: 'Acesso à câmera/microfone negado', connecting: 'Conectando…', roomFull: 'Sala cheia (máx 4)',
    createOrJoin: 'Criar ou entrar em uma sala', visibility: 'Visibilidade', public: 'Pública', private: 'Privada',
    publicRooms: 'Salas públicas online', noPublicRooms: 'Ainda não há salas públicas — crie uma!',
    refresh: 'Atualizar', privateHint: 'Salas privadas não aparecem no lobby',
    prejoinTitle: 'Pronto para entrar?', camera: 'Câmera', microphone: 'Microfone', join: 'Entrar', back: 'Voltar',
    you: 'Você', waitingPeers: 'Aguardando outros participantes…', connectionLost: 'Conexão perdida — reconectando…',
    chatTitle: 'Chat', chatPlaceholder: 'Escreva uma mensagem…', send: 'Enviar',
    muteTip: 'Microfone', camTip: 'Câmera', ttsTip: 'Ler traduções', chatTip: 'Chat', leaveTip: 'Sair',
    handTip: 'Levantar mão', handUp: 'Abaixar mão',
    fullscreenTip: 'Tela cheia', pipTip: 'Picture in Picture', participants: 'Participantes', participantsTip: 'Participantes',
    handRaisedNotif: 'levantou a mão',
    pinTip: 'Fixar vídeo', unpinTip: 'Desafixar', viewGrid: 'Grade', viewSpeaker: 'Orador',
  },
  ja: {
    tagline: 'リアルタイム翻訳ビデオ通話', roomCode: 'ルームコード', copy: 'コピー',
    copied: 'コピーしました', copyFailed: 'コピーに失敗', nameLabel: 'あなたの名前', namePlaceholder: 'ゲスト',
    langLabel: 'あなたの言語', connect: '参加', enterRoom: 'ルームコードを入力してください',
    camMicDenied: 'カメラ／マイクへのアクセスが拒否されました', connecting: '接続中…', roomFull: 'ルームが満員です（最大4人）',
    createOrJoin: 'ルームを作成または参加', visibility: '公開設定', public: '公開', private: '非公開',
    publicRooms: '公開ルーム（オンライン）', noPublicRooms: '公開ルームはまだありません — 作成しましょう！',
    refresh: '更新', privateHint: '非公開ルームはロビーに表示されません',
    prejoinTitle: '参加の準備はできましたか？', camera: 'カメラ', microphone: 'マイク', join: '参加する', back: '戻る',
    you: 'あなた', waitingPeers: '他の参加者を待っています…', connectionLost: '接続が切れました — 再接続中…',
    chatTitle: 'チャット', chatPlaceholder: 'メッセージを入力…', send: '送信',
    muteTip: 'マイク', camTip: 'カメラ', ttsTip: '翻訳を読み上げる', chatTip: 'チャット', leaveTip: '退出',
    handTip: '手を上げる', handUp: '手を下げる',
    fullscreenTip: '全画面', pipTip: 'ピクチャーインピクチャー', participants: '参加者', participantsTip: '参加者',
    handRaisedNotif: 'が手を上げました',
    pinTip: 'ピン固定', unpinTip: 'ピン解除', viewGrid: 'グリッド', viewSpeaker: 'スピーカー',
  },
  zh: {
    tagline: '实时翻译视频通话', roomCode: '房间代码', copy: '复制',
    copied: '已复制', copyFailed: '复制失败', nameLabel: '你的名字', namePlaceholder: '访客',
    langLabel: '你的语言', connect: '加入', enterRoom: '请输入房间代码',
    camMicDenied: '摄像头/麦克风访问被拒绝', connecting: '连接中…', roomFull: '房间已满（最多4人）',
    createOrJoin: '创建或加入房间', visibility: '可见性', public: '公开', private: '私密',
    publicRooms: '在线公开房间', noPublicRooms: '还没有公开房间 — 创建一个吧！',
    refresh: '刷新', privateHint: '私密房间不会显示在大厅中',
    prejoinTitle: '准备加入了吗？', camera: '摄像头', microphone: '麦克风', join: '加入', back: '返回',
    you: '你', waitingPeers: '正在等待其他参与者…', connectionLost: '连接断开 — 正在重连…',
    chatTitle: '聊天', chatPlaceholder: '输入消息…', send: '发送',
    muteTip: '麦克风', camTip: '摄像头', ttsTip: '朗读翻译', chatTip: '聊天', leaveTip: '离开',
    handTip: '举手', handUp: '放下手',
    fullscreenTip: '全屏', pipTip: '画中画', participants: '参与者', participantsTip: '参与者',
    handRaisedNotif: '举了手',
    pinTip: '固定视频', unpinTip: '取消固定', viewGrid: '网格', viewSpeaker: '演讲者',
  },
};

export function detectLang(): string {
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return (SUPPORTED as readonly string[]).includes(nav) ? nav : 'en';
}

let uiLang = detectLang();
export const getUiLang = (): string => uiLang;
export function setUiLang(l: string): void {
  if ((SUPPORTED as readonly string[]).includes(l)) uiLang = l;
}
export const t = (key: string): string => I18N[uiLang]?.[key] ?? I18N.en[key] ?? key;

export function applyI18n(): void {
  document.documentElement.lang = uiLang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPh!));
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle!));
    el.setAttribute('aria-label', t(el.dataset.i18nTitle!));
  });
}
