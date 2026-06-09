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
    const translated = data.translations[this.myLang] ?? data.original;
    const isMine = data.sender_id === this.myId;
    const isTranslated = data.sender_lang !== this.myLang && translated !== data.original;

    const msg = document.createElement('div');
    msg.className = `chat-msg ${isMine ? 'chat-msg-mine' : 'chat-msg-other'}`;

    if (!isMine) {
      const sender = document.createElement('div');
      sender.className = 'chat-sender';
      sender.textContent = data.sender_name;
      msg.appendChild(sender);
    }
    const text = document.createElement('div');
    text.className = 'chat-text';
    text.textContent = translated;
    msg.appendChild(text);

    if (isTranslated) {
      const original = document.createElement('div');
      original.className = 'chat-original';
      original.textContent = data.original;
      msg.appendChild(original);
    }

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
