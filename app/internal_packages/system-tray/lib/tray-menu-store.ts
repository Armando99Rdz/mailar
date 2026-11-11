import { ipcRenderer } from 'electron';
import {
  AccountStore,
  Actions,
  DatabaseStore,
  DateUtils,
  Message,
  Thread,
  Utils,
  localized,
} from 'mailspring-exports';

const UNREAD_LIMIT = 3;
const LOOKBACK = 60;
const UNREAD_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export interface TrayMenuMessage {
  threadId: string;
  name: string;
  email: string;
  subject: string;
  snippet: string;
  unread: boolean;
  letter: string;
  color: string;
  when: string;
}

function oneLine(value: string | null | undefined, max: number) {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The latest real message stands for the thread. If we sent it, the row
// names the recipient; otherwise it names the sender.
function correspondent(message: Message) {
  const from = message.from && message.from[0];
  const sentByMe = !!(from && from.email && AccountStore.isMyEmail(from.email));
  const contact = sentByMe ? (message.to && message.to[0]) || from : from;
  if (!contact) return { name: '', email: '' };
  const email = oneLine(contact.email, 120);
  const name = oneLine(contact.name, 80);
  if (!name || name.toLowerCase() === email.toLowerCase()) {
    return { name: email, email: '' };
  }
  return { name, email };
}

// Same initials and color as the thread-list avatar.
function monogram(name: string, email: string) {
  const source = (name || email || '').trim();
  const words = source.split(/\s+/).filter(Boolean);
  let letters: string;
  if (words.length >= 2 && !source.includes('@')) {
    letters = `${Array.from(words[0])[0] || ''}${Array.from(words[1])[0] || ''}`;
  } else {
    const chars = Array.from(source.split('@')[0]);
    letters = `${chars[0] || '?'}${chars[1] || ''}`;
  }
  return { letter: letters.toUpperCase(), color: Utils.avatarGradient(email || source) };
}

export function rowsFromMessages(messages: Message[]): TrayMenuMessage[] {
  const accountIds = new Set(AccountStore.accountIds());
  const seen = new Set<string>();
  const rows: TrayMenuMessage[] = [];
  for (const message of messages) {
    if (!message || message.draft || !message.unread || !message.threadId) continue;
    if (message.date && message.date.getTime() < Date.now() - UNREAD_WINDOW_MS) continue;
    if (seen.has(message.threadId)) continue;
    if (accountIds.size > 0 && !accountIds.has(message.accountId)) continue;
    seen.add(message.threadId);
    const who = correspondent(message);
    const avatar = monogram(who.name, who.email);
    rows.push({
      threadId: message.threadId,
      name: who.name,
      email: who.email,
      subject: oneLine(message.subject, 140) || localized('(No Subject)'),
      snippet: oneLine(message.snippet, 180),
      unread: true,
      letter: avatar.letter,
      color: avatar.color,
      when: message.date ? DateUtils.shortTimeString(new Date(message.date)) : '',
    });
    if (rows.length >= UNREAD_LIMIT) break;
  }
  return rows;
}

// Publishes the latest messages for the menu-bar panel and opens a thread
// when that panel asks the main window to.
export default class TrayMenuStore {
  _unsubscribers: Array<() => void> = [];
  _timer: ReturnType<typeof setTimeout> | null = null;
  _generation = 0;

  activate() {
    if (process.platform !== 'darwin') return;

    this._unsubscribers.push(DatabaseStore.listen(this._schedule));
    this._unsubscribers.push(AccountStore.listen(this._schedule));
    ipcRenderer.on('focus-tray-thread', this._onFocusThread);
    this._unsubscribers.push(() =>
      ipcRenderer.removeListener('focus-tray-thread', this._onFocusThread)
    );
    this._schedule();
  }

  deactivate() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._generation += 1;
    this._unsubscribers.forEach((unsub) => unsub());
    this._unsubscribers = [];
  }

  _schedule = () => {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._publish();
    }, 300);
  };

  _publish = async () => {
    const generation = ++this._generation;
    const accountIds = AccountStore.accountIds();
    const since = new Date(Date.now() - UNREAD_WINDOW_MS);
    const messagesQuery = DatabaseStore.findAll<Message>(Message)
      .where({ draft: false, unread: true })
      .where(Message.attributes.date.greaterThan(since))
      .order(Message.attributes.date.descending())
      .limit(LOOKBACK);
    const countQuery = DatabaseStore.count(Thread)
      .where({ unread: true })
      .where(Thread.attributes.lastMessageReceivedTimestamp.greaterThan(since));
    if (accountIds.length > 0) {
      messagesQuery.where(Message.attributes.accountId.in(accountIds));
      countQuery.where(Thread.attributes.accountId.in(accountIds));
    }
    let messages: Message[] = [];
    let unreadTotal = 0;
    try {
      const result = await Promise.all([messagesQuery, countQuery]);
      messages = result[0] || [];
      unreadTotal = Number(result[1]) || 0;
    } catch (err) {
      console.warn('Tray menu could not read recent messages', err);
      return;
    }
    if (generation !== this._generation) return;
    const rows = rowsFromMessages(messages);
    const moreUnread = Math.max(0, Math.floor(unreadTotal) - rows.length);
    ipcRenderer.send('update-system-tray-messages', {
      messages: rows,
      moreLabel: moreUnread > 0 ? localized('+%@ more unread', moreUnread) : '',
    });
  };

  _onFocusThread = async (_event: unknown, threadId: string) => {
    if (typeof threadId !== 'string' || !threadId) return;
    const thread = await DatabaseStore.find<Thread>(Thread, threadId);
    if (!thread) return;
    Actions.focusThreadMainWindow(thread);
  };
}
