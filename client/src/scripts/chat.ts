// Translated chat. Renders each message in the viewer's language, with the
// original shown small below when it was translated. Tracks unread while closed.

export interface ChatPayload {
  sender_id: string;
  sender_name: string;
  sender_lang: string;
  original: string;
  translations: Record<string, string>;
  timestamp: number;
}

export class ChatManager {
  private myLang: string;
  private myId: string;
  private container: HTMLElement;
  private ws: WebSocket;
  private unread = 0;
  private isOpen = false;

  onUnread: (count: number) => void = () => {};

  constructor(opts: { myLang: string; myId: string; container: HTMLElement; ws: WebSocket }) {
    this.myLang = opts.myLang;
    this.myId = opts.myId;
    this.container = opts.container;
    this.ws = opts.ws;
  }

  addMessage(data: ChatPayload): void {
    // Every user reads incoming messages only in their own language.
    const translated = data.translations[this.myLang] ?? data.original;
    const isMine = data.sender_id === this.myId;

    const msg = document.createElement('div');
    msg.className = `chat-msg ${isMine ? 'chat-msg-mine' : 'chat-msg-other'}`;

    // Sender name (bold) and message rendered inline on the same line.
    if (!isMine) {
      const sender = document.createElement('span');
      sender.className = 'chat-sender';
      sender.textContent = data.sender_name;
      msg.appendChild(sender);
      msg.appendChild(document.createTextNode(' '));
    }
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = translated;
    msg.appendChild(text);

    this.container.appendChild(msg);
    this.container.scrollTop = this.container.scrollHeight;

    if (!this.isOpen && !isMine) {
      this.unread++;
      this.onUnread(this.unread);
    }
  }

  sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'chat', text: trimmed }));
    }
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
    if (open) {
      this.unread = 0;
      this.onUnread(0);
    }
  }

  setMyLang(lang: string): void {
    this.myLang = lang;
  }
}
