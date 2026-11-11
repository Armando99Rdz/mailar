import path from 'path';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  NativeImage,
  nativeTheme,
  screen,
  Tray,
} from 'electron';
import { localized } from '../intl';
import { waitForStatusNotifierHost } from './sni-host';
import WindowManager from './window-manager';
import Application from './application';

const TRAY_MENU_LIMIT = 3;
const TRAY_MENU_WIDTH = 320;

// Windows remembers whether a tray icon is pinned to the taskbar or hidden in the
// overflow flyout. Without a GUID it keys that choice by the executable's path, and
// Squirrel installs every update into a new app-x.y.z folder, so the icon falls back
// into the overflow after each update. With a GUID on a signed executable, Windows
// keys the choice by the GUID and the signer instead. Never change this value: users
// would have to pin the icon again.
const WINDOWS_TRAY_GUID = 'a66c4fa1-dd67-4732-9609-776b8a41579c';

function _createTray(platform: string, icon: NativeImage) {
  // An unsigned executable ties the GUID to its path, and Windows then refuses to
  // create the icon from any other path. Dev builds run an unsigned electron.exe
  // from each checkout, so only packaged builds use the GUID. Electron rejects an
  // explicit `undefined` GUID, so the argument is omitted everywhere else.
  if (platform === 'win32' && app.isPackaged) {
    return new Tray(icon, WINDOWS_TRAY_GUID);
  }
  return new Tray(icon);
}

function _getMenuTemplate(platform: string, application: Application) {
  const template = [
    {
      label: localized('New Message'),
      click: () => application.emit('application:new-message'),
    },
    {
      label: localized('Preferences'),
      click: () => application.emit('application:open-preferences'),
    },
    {
      type: 'separator',
    },
    {
      label: localized('Quit MailAr'),
      click: () => application.emit('application:quit'),
    },
  ];

  if (platform !== 'win32') {
    template.unshift({
      label: `${localized('Open')} ${localized('Inbox')}`,
      click: () => application.emit('application:show-main-window'),
    });
  }

  return template;
}

function _getTooltip(unreadString: string) {
  return unreadString ? `${unreadString} unread messages` : '';
}

function _unreadCount(unreadString: string) {
  if (!unreadString) return 0;
  const digits = String(unreadString).replace(/[^\d]/g, '');
  const count = parseInt(digits, 10);
  return Number.isFinite(count) ? count : 0;
}

// macOS draws this beside the template icon, in the menu bar's own type.
function _menuBarTitle(unreadString: string) {
  const count = _unreadCount(unreadString);
  if (count <= 0) return '';
  return count > 99 ? ' 99+' : ` ${count}`;
}

interface TrayMenuMessage {
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

function _clean(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function _cleanColor(value: unknown) {
  if (typeof value !== 'string') return '';
  return /^radial-gradient\(circle at 32% 28%, rgba\(255,255,255,0\.55\), rgba\(255,255,255,0\) 46%\), linear-gradient\(145deg, hsl\(\d{1,3}, 78%, 70%\), hsl\(\d{1,3}, 72%, 56%\)\)$/.test(
    value
  )
    ? value
    : '';
}

function _cleanLetter(value: unknown) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, 2).join('');
}

function _normalizeMessages(raw: unknown): TrayMenuMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: TrayMenuMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const threadId = _clean((item as TrayMenuMessage).threadId, 128);
    if (!threadId) continue;
    messages.push({
      threadId,
      name: _clean((item as TrayMenuMessage).name, 80),
      email: _clean((item as TrayMenuMessage).email, 120),
      subject: _clean((item as TrayMenuMessage).subject, 140),
      snippet: _clean((item as TrayMenuMessage).snippet, 180),
      unread: (item as TrayMenuMessage).unread === true,
      letter: _cleanLetter((item as TrayMenuMessage).letter),
      color: _cleanColor((item as TrayMenuMessage).color),
      when: _clean((item as TrayMenuMessage).when, 40),
    });
    if (messages.length >= TRAY_MENU_LIMIT) break;
  }
  return messages;
}

function _readMenu(raw: unknown) {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { messages?: unknown; moreLabel?: unknown })
      : null;
  return {
    messages: _normalizeMessages(record ? record.messages : raw),
    moreLabel: _clean(record ? record.moreLabel : '', 80),
  };
}

function _getIcon(iconPath: string) {
  if (!iconPath) {
    return nativeImage.createEmpty();
  }
  return nativeImage.createFromPath(iconPath);
}

class SystemTrayManager {
  _iconPath = null;
  _unreadString = null;
  _tray: Tray = null;
  _popover: BrowserWindow = null;
  _messages: TrayMenuMessage[] = [];
  _moreLabel = '';
  _ignoreNextClick = false;
  _suspendBlur = false;
  _awaitingTrayHost = false;
  _platform: string = null;
  _application: Application;

  constructor(platform: string, application: Application) {
    this._platform = platform;
    this._application = application;
    this.initTray();

    this._application.config.onDidChange('core.workspace.systemTray', ({ newValue }) => {
      if (newValue === false) {
        this.destroyTray();
      } else {
        this.initTray();
      }
    });

    // The panel is not a MailAr window, so its clicks are checked against
    // its own webContents instead of the trusted-window allowlist.
    ipcMain.on('tray-menu-action', (event, action) => {
      if (!this._popover || event.sender !== this._popover.webContents) return;
      this._onMenuAction(action);
    });
  }

  _defaultIconPath() {
    if (this._platform !== 'linux') return null;

    const traySystemTheme =
      this._application.config.get('core.workspace.traySystemTheme') || 'automatic';
    let dark: string;
    if (traySystemTheme === 'dark') {
      dark = '-dark';
    } else if (traySystemTheme === 'light') {
      dark = '';
    } else {
      // Automatic: On GNOME/Unity the top bar panel is always dark regardless of the
      // application theme, so nativeTheme.shouldUseDarkColors is unreliable
      // for choosing the tray icon variant. Default to the light-on-dark icon.
      const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toUpperCase();
      if (desktop.includes('GNOME') || desktop.includes('UNITY')) {
        dark = '-dark';
      } else {
        dark = nativeTheme.shouldUseDarkColors ? '-dark' : '';
      }
    }

    return path.join(
      this._application.resourcePath,
      'internal_packages',
      'system-tray',
      'assets',
      'linux',
      `MenuItem-Inbox-Full${dark}.png`
    );
  }

  _trayEnabled() {
    return this._application.config.get('core.workspace.systemTray') !== false;
  }

  async initTray() {
    if (!this._trayEnabled() || this._tray !== null || this._awaitingTrayHost) return;

    if (this._platform === 'linux') {
      this._awaitingTrayHost = true;
      try {
        await waitForStatusNotifierHost();
      } finally {
        this._awaitingTrayHost = false;
      }
      // The setting can be switched off while we were waiting for the host.
      if (!this._trayEnabled() || this._tray !== null) return;
    }

    this._tray = _createTray(this._platform, _getIcon(this._iconPath || this._defaultIconPath()));
    this._tray.setToolTip(_getTooltip(this._unreadString));
    this._tray.addListener('click', this._onClick);
    if (this._platform === 'darwin') {
      // A native menu is a single line per item. The panel below the icon can
      // show the sender, address, subject and one line of the message.
      this._applyMenuBarTitle();
      this._tray.addListener('right-click', this._onClick);
      if (typeof this._tray.setIgnoreDoubleClickEvents === 'function') {
        this._tray.setIgnoreDoubleClickEvents(true);
      }
    } else {
      this._tray.setContextMenu(
        Menu.buildFromTemplate(_getMenuTemplate(this._platform, this._application) as any)
      );
    }
  }

  _onClick = () => {
    if (this._platform === 'darwin') {
      if (this._ignoreNextClick) return;
      if (this._popover && !this._popover.isDestroyed() && this._popover.isVisible()) {
        this._popover.hide();
        return;
      }
      this._showPopover();
      return;
    }
    if (this._application.windowManager.getVisibleWindowCount() === 0) {
      this._application.emit('application:show-main-window');
    } else {
      const visibleWindows = this._application.windowManager.getVisibleWindows();
      visibleWindows.forEach((window) => window.hide());
    }
  };

  updateRecentMessages(payload: unknown) {
    const menu = _readMenu(payload);
    this._messages = menu.messages;
    this._moreLabel = menu.moreLabel;
    this._pushMenuData();
  }

  updateTraySettings(iconPath: string, unreadString: string) {
    if (this._iconPath !== iconPath) {
      this._iconPath = iconPath;
      if (this._tray) this._tray.setImage(_getIcon(this._iconPath));
    }
    if (this._unreadString !== unreadString) {
      this._unreadString = unreadString;
      if (this._tray) {
        this._tray.setToolTip(_getTooltip(unreadString));
        this._applyMenuBarTitle();
      }
    }
  }

  _applyMenuBarTitle() {
    if (this._platform !== 'darwin' || !this._tray) return;
    this._tray.setTitle(_menuBarTitle(this._unreadString), { fontType: 'monospacedDigit' });
  }

  _menuPayload() {
    return {
      labels: {
        openInbox: `${localized('Open')} ${localized('Inbox')}`,
        newMessage: localized('New Message'),
        preferences: localized('Preferences'),
        quit: localized('Quit MailAr'),
        empty: localized('No unread messages'),
        title: localized('Unread mail'),
      },
      messages: this._messages,
      moreLabel: this._moreLabel,
    };
  }

  _ensurePopover() {
    if (this._popover && !this._popover.isDestroyed()) return this._popover;
    const root = this._application.resourcePath;
    this._popover = new BrowserWindow({
      width: TRAY_MENU_WIDTH,
      height: 360,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      roundedCorners: true,
      vibrancy: 'menu',
      visualEffectState: 'active',
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(
          root,
          'internal_packages',
          'system-tray',
          'static',
          'tray-menu-preload.js'
        ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this._popover.setAlwaysOnTop(true, 'pop-up-menu');
    this._popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this._popover.on('blur', () => {
      if (this._suspendBlur) return;
      if (!this._popover || this._popover.isDestroyed() || !this._popover.isVisible()) return;
      this._popover.hide();
      // The click that dismissed the panel also hits the status icon.
      this._ignoreNextClick = true;
      setTimeout(() => {
        this._ignoreNextClick = false;
      }, 200);
    });
    this._popover.webContents.on('will-navigate', (event) => event.preventDefault());
    this._popover.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this._popover.loadFile(
      path.join(root, 'internal_packages', 'system-tray', 'static', 'tray-menu.html')
    );
    return this._popover;
  }

  _popoverHeight() {
    const rows = this._messages.length;
    const list = rows === 0 ? 28 : rows * 68;
    const more = this._moreLabel ? 22 : 0;
    return 32 + list + more + 128;
  }

  _showPopover() {
    if (!this._tray) return;
    const pop = this._ensurePopover();
    const width = TRAY_MENU_WIDTH;
    const height = this._popoverHeight();
    const trayBounds = this._tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const area = display.workArea;
    const maxHeight = Math.max(180, area.height - 16);
    const usedHeight = Math.min(height, maxHeight);
    pop.setSize(width, usedHeight);
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    let y = Math.round(trayBounds.y + trayBounds.height + 4);
    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
    if (y + usedHeight > area.y + area.height - 8) {
      y = Math.max(area.y + 8, Math.round(trayBounds.y - usedHeight - 4));
    }
    pop.setPosition(x, y, false);
    this._pushMenuData();
    this._suspendBlur = true;
    pop.show();
    pop.focus();
    setTimeout(() => {
      this._suspendBlur = false;
    }, 150);
  }

  _pushMenuData() {
    const pop = this._popover;
    if (!pop || pop.isDestroyed()) return;
    const send = () => {
      if (!pop.isDestroyed()) pop.webContents.send('tray-menu-data', this._menuPayload());
    };
    if (pop.webContents.isLoading()) pop.webContents.once('did-finish-load', send);
    else send();
  }

  _revealMain() {
    this._application.emit('application:show-main-window');
    if (process.platform === 'darwin') app.focus({ steal: true });
  }

  _onMenuAction(action: { type?: string; threadId?: string }) {
    if (this._popover && !this._popover.isDestroyed()) this._popover.hide();
    if (!action || typeof action.type !== 'string') return;
    if (action.type === 'close') return;
    if (action.type === 'open-inbox') {
      this._revealMain();
      return;
    }
    if (action.type === 'new-message') {
      this._revealMain();
      this._application.emit('application:new-message');
      return;
    }
    if (action.type === 'preferences') {
      this._revealMain();
      this._application.emit('application:open-preferences');
      return;
    }
    if (action.type === 'quit') {
      this._application.emit('application:quit');
      return;
    }
    if (
      action.type === 'open-thread' &&
      typeof action.threadId === 'string' &&
      action.threadId.length < 128
    ) {
      this._revealMain();
      this._application.windowManager
        .get(WindowManager.MAIN_WINDOW)
        ?.sendMessage('focus-tray-thread', action.threadId);
    }
  }

  destroyTray() {
    if (this._popover && !this._popover.isDestroyed()) {
      this._popover.destroy();
      this._popover = null;
    }
    // Due to https://github.com/electron/electron/issues/17622
    // we cannot destroy the tray icon on linux.
    if (this._tray && process.platform !== 'linux') {
      this._tray.removeListener('click', this._onClick);
      this._tray.removeListener('right-click', this._onClick);
      this._tray.destroy();
      this._tray = null;
    }
  }
}

export default SystemTrayManager;
