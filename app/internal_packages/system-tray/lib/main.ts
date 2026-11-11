import SystemTrayIconStore from './system-tray-icon-store';
import TrayMenuStore from './tray-menu-store';

export function activate() {
  this.store = new SystemTrayIconStore();
  this.store.activate();
  this.menuStore = new TrayMenuStore();
  this.menuStore.activate();
}

export function deactivate() {
  if (this.store) this.store.deactivate();
  if (this.menuStore) this.menuStore.deactivate();
}

export function serialize() {}
