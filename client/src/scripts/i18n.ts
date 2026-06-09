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
    loginSub: 'Sign in to track credits & usage', orText: 'or', continueGuest: 'Continue as guest',
    buyCredits: 'Buy credits', logout: 'Log out', currentBalance: 'Current balance', history: 'Credits',
    usageHistory: 'Usage', outOfCredits: 'Out of credits',
    outOfCreditsText: 'Your speaking was paused. Buy credits to keep talking — the call stays connected.',
    dismiss: 'Dismiss', lowBalanceWarn: 'Low balance', noActivity: 'No activity yet',
    checkoutFailed: 'Checkout unavailable — please try again later',
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
    loginSub: 'Accedi per tracciare crediti e utilizzo', orText: 'oppure', continueGuest: 'Continua come ospite',
    buyCredits: 'Acquista crediti', logout: 'Esci', currentBalance: 'Saldo attuale', history: 'Crediti',
    usageHistory: 'Utilizzo', outOfCredits: 'Crediti esauriti',
    outOfCreditsText: 'Il tuo audio è in pausa. Acquista crediti per continuare a parlare — la chiamata resta attiva.',
    dismiss: 'Chiudi', lowBalanceWarn: 'Saldo basso', noActivity: 'Ancora nessuna attività',
    checkoutFailed: 'Checkout non disponibile — riprova più tardi',
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
    loginSub: 'Inicia sesión para ver créditos y uso', orText: 'o', continueGuest: 'Continuar como invitado',
    buyCredits: 'Comprar créditos', logout: 'Salir', currentBalance: 'Saldo actual', history: 'Créditos',
    usageHistory: 'Uso', outOfCredits: 'Sin créditos',
    outOfCreditsText: 'Tu voz se ha pausado. Compra créditos para seguir hablando — la llamada sigue conectada.',
    dismiss: 'Cerrar', lowBalanceWarn: 'Saldo bajo', noActivity: 'Aún no hay actividad',
    checkoutFailed: 'Pago no disponible — inténtalo de nuevo más tarde',
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
    loginSub: 'Connectez-vous pour suivre crédits et usage', orText: 'ou', continueGuest: 'Continuer en invité',
    buyCredits: 'Acheter des crédits', logout: 'Déconnexion', currentBalance: 'Solde actuel', history: 'Crédits',
    usageHistory: 'Usage', outOfCredits: 'Plus de crédits',
    outOfCreditsText: "Votre voix est en pause. Achetez des crédits pour continuer — l'appel reste connecté.",
    dismiss: 'Fermer', lowBalanceWarn: 'Solde faible', noActivity: 'Aucune activité',
    checkoutFailed: 'Paiement indisponible — réessayez plus tard',
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
    loginSub: 'Anmelden, um Guthaben & Nutzung zu sehen', orText: 'oder', continueGuest: 'Als Gast fortfahren',
    buyCredits: 'Guthaben kaufen', logout: 'Abmelden', currentBalance: 'Aktuelles Guthaben', history: 'Guthaben',
    usageHistory: 'Nutzung', outOfCredits: 'Guthaben aufgebraucht',
    outOfCreditsText: 'Deine Sprache wurde pausiert. Kaufe Guthaben, um weiterzusprechen — der Anruf bleibt verbunden.',
    dismiss: 'Schließen', lowBalanceWarn: 'Niedriges Guthaben', noActivity: 'Noch keine Aktivität',
    checkoutFailed: 'Checkout nicht verfügbar — bitte später erneut versuchen',
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
    loginSub: 'Entre para acompanhar créditos e uso', orText: 'ou', continueGuest: 'Continuar como convidado',
    buyCredits: 'Comprar créditos', logout: 'Sair', currentBalance: 'Saldo atual', history: 'Créditos',
    usageHistory: 'Uso', outOfCredits: 'Sem créditos',
    outOfCreditsText: 'Sua voz foi pausada. Compre créditos para continuar falando — a chamada permanece conectada.',
    dismiss: 'Fechar', lowBalanceWarn: 'Saldo baixo', noActivity: 'Nenhuma atividade ainda',
    checkoutFailed: 'Checkout indisponível — tente novamente mais tarde',
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
    loginSub: 'ログインしてクレジットと利用状況を管理', orText: 'または', continueGuest: 'ゲストとして続ける',
    buyCredits: 'クレジットを購入', logout: 'ログアウト', currentBalance: '現在の残高', history: 'クレジット',
    usageHistory: '利用履歴', outOfCredits: 'クレジット不足',
    outOfCreditsText: '発話が一時停止されました。クレジットを購入すると続けられます — 通話は接続されたままです。',
    dismiss: '閉じる', lowBalanceWarn: '残高わずか', noActivity: 'まだ利用履歴はありません',
    checkoutFailed: '決済を開始できません — 後でもう一度お試しください',
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
    loginSub: '登录以跟踪积分和用量', orText: '或', continueGuest: '以访客身份继续',
    buyCredits: '购买积分', logout: '退出登录', currentBalance: '当前余额', history: '积分',
    usageHistory: '用量', outOfCredits: '积分用尽',
    outOfCreditsText: '你的语音已暂停。购买积分即可继续通话 — 通话保持连接。',
    dismiss: '关闭', lowBalanceWarn: '余额不足', noActivity: '暂无活动',
    checkoutFailed: '无法发起结账 — 请稍后重试',
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
