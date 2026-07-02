'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuAPI', {
  loadLastOrPrompt: () => ipcRenderer.invoke('load-last-or-prompt'),
  pickMenuFile: () => ipcRenderer.invoke('pick-menu-file'),
  reloadMenu: () => ipcRenderer.invoke('reload-menu'),
  getOpenFile: () => ipcRenderer.invoke('get-open-file'),
  saveMenu: (items) => ipcRenderer.invoke('save-menu', items),
  chooseImage: (itemName) => ipcRenderer.invoke('choose-image', { itemName }),
  revealInFolder: (relPath) => ipcRenderer.invoke('reveal-in-folder', relPath),
});
