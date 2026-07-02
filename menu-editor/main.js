'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseMenu, serializeMenu, patchBuilderFunctions } = require('./parser');

let win = null;

/** Tiny persisted config (just remembers which HTML file to auto-load next time). */
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('Could not save config:', err);
  }
}

/** In-memory state for the file currently open. */
const state = {
  filePath: null,
  raw: null,
};

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#111111',
    title: 'CDC Menu Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', async (e) => {
    if (win.isDirtyGuardBypassed) return;
    e.preventDefault();
    const proceed = await confirmCloseIfDirty();
    if (proceed) {
      win.isDirtyGuardBypassed = true;
      win.close();
    }
  });
}

async function confirmCloseIfDirty() {
  const isDirty = await win.webContents.executeJavaScript('window.__isDirty === true').catch(() => false);
  if (!isDirty) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Discard Changes & Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Unsaved changes',
    message: 'You have unsaved menu changes.',
    detail: 'If you quit now, your edits since the last save will be lost.',
  });
  return response === 0;
}

function loadFromDisk(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const patched = patchBuilderFunctions(raw);
  state.filePath = filePath;
  state.raw = patched;
  const menu = parseMenu(patched);
  return { ok: true, filePath, pages: menu.pages, fileName: path.basename(filePath) };
}

ipcMain.handle('load-last-or-prompt', async () => {
  const cfg = readConfig();
  if (cfg.lastFilePath && fs.existsSync(cfg.lastFilePath)) {
    try {
      return loadFromDisk(cfg.lastFilePath);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
  return { ok: false, needsPick: true };
});

ipcMain.handle('pick-menu-file', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Locate menu-modal.html',
    properties: ['openFile'],
    filters: [{ name: 'HTML files', extensions: ['html', 'htm'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const loaded = loadFromDisk(filePath);
    writeConfig({ ...readConfig(), lastFilePath: filePath });
    return loaded;
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('reload-menu', async () => {
  if (!state.filePath) return { ok: false, error: 'No file open.' };
  try {
    return loadFromDisk(state.filePath);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('get-open-file', () => {
  return state.filePath
    ? { ok: true, filePath: state.filePath, fileName: path.basename(state.filePath) }
    : { ok: false };
});

ipcMain.handle('save-menu', async (_evt, items) => {
  if (!state.filePath || state.raw == null) {
    return { ok: false, error: 'No file is open.' };
  }
  try {
    const updated = serializeMenu(state.raw, items);
    // Extra safety: keep a rolling backup before we ever overwrite the live file.
    const backupPath = state.filePath + '.bak';
    fs.writeFileSync(backupPath, state.raw, 'utf8');
    fs.writeFileSync(state.filePath, updated, 'utf8');

    state.raw = updated;
    const menu = parseMenu(updated);
    return { ok: true, pages: menu.pages, filePath: state.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('choose-image', async (_evt, { itemName }) => {
  if (!state.filePath) return { ok: false, error: 'No file is open.' };
  const result = await dialog.showOpenDialog(win, {
    title: `Choose an image for "${itemName}"`,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

  const src = result.filePaths[0];
  const ext = path.extname(src).toLowerCase() || '.jpg';
  const slug =
    itemName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';

  const menuDir = path.dirname(state.filePath);
  const imagesDir = path.join(menuDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  let destName = `${slug}${ext}`;
  let destPath = path.join(imagesDir, destName);
  let n = 2;
  while (fs.existsSync(destPath) && path.resolve(destPath) !== path.resolve(src)) {
    // Avoid clobbering an unrelated existing file with a different source image.
    const existing = fs.readFileSync(destPath);
    const incoming = fs.readFileSync(src);
    if (Buffer.compare(existing, incoming) === 0) break; // identical file, fine to reuse
    destName = `${slug}-${n}${ext}`;
    destPath = path.join(imagesDir, destName);
    n++;
  }

  try {
    fs.copyFileSync(src, destPath);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }

  return { ok: true, relPath: `images/${destName}`, absPath: destPath };
});

ipcMain.handle('reveal-in-folder', (_evt, relPath) => {
  if (!state.filePath || !relPath) return;
  const abs = path.join(path.dirname(state.filePath), relPath);
  shell.showItemInFolder(abs);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
