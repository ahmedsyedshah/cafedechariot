'use strict';

(() => {
  const els = {
    fileLabel: document.getElementById('fileLabel'),
    dirtyPill: document.getElementById('dirtyPill'),
    changeFileBtn: document.getElementById('changeFileBtn'),
    reloadBtn: document.getElementById('reloadBtn'),
    saveBtn: document.getElementById('saveBtn'),
    onboard: document.getElementById('onboard'),
    onboardPickBtn: document.getElementById('onboardPickBtn'),
    onboardError: document.getElementById('onboardError'),
    workspace: document.getElementById('workspace'),
    tree: document.getElementById('tree'),
    searchInput: document.getElementById('searchInput'),
    searchCount: document.getElementById('searchCount'),
    editPane: document.getElementById('editPane'),
    emptyState: document.getElementById('emptyState'),
    editForm: document.getElementById('editForm'),
    metaSection: document.getElementById('metaSection'),
    metaKind: document.getElementById('metaKind'),
    fieldName: document.getElementById('fieldName'),
    priceRow: document.getElementById('priceRow'),
    fieldPrice: document.getElementById('fieldPrice'),
    sizesRow: document.getElementById('sizesRow'),
    fieldP7: document.getElementById('fieldP7'),
    fieldP10: document.getElementById('fieldP10'),
    fieldP13: document.getElementById('fieldP13'),
    descField: document.getElementById('descField'),
    fieldDesc: document.getElementById('fieldDesc'),
    noteField: document.getElementById('noteField'),
    fieldNote: document.getElementById('fieldNote'),
    imageThumb: document.getElementById('imageThumb'),
    imagePreviewImg: document.getElementById('imagePreviewImg'),
    imagePlaceholder: document.getElementById('imagePlaceholder'),
    chooseImageBtn: document.getElementById('chooseImageBtn'),
    clearImageBtn: document.getElementById('clearImageBtn'),
    imagePath: document.getElementById('imagePath'),
    pmImg: document.getElementById('pmImg'),
    pmPlaceholder: document.getElementById('pmPlaceholder'),
    pmName: document.getElementById('pmName'),
    pmPrice: document.getElementById('pmPrice'),
    pmDesc: document.getElementById('pmDesc'),
  };

  /** @type {{pages: any[]}} */
  let state = { pages: [] };
  let itemsById = new Map();
  let dirtyIds = new Set();
  let currentId = null;
  let menuDir = null; // absolute folder containing menu-modal.html, for resolving image previews
  let filePath = null;

  window.__isDirty = false;

  function setDirty(id, isDirty) {
    if (isDirty) dirtyIds.add(id);
    else dirtyIds.delete(id);
    window.__isDirty = dirtyIds.size > 0;
    els.saveBtn.disabled = dirtyIds.size === 0;
    els.dirtyPill.hidden = dirtyIds.size === 0;
  }

  function flattenItems(pages) {
    const map = new Map();
    for (const page of pages) {
      for (const section of page.sections) {
        for (const item of section.items) map.set(item.id, item);
      }
    }
    return map;
  }

  function fileUrl(relPath) {
    if (!relPath || !filePath) return null;
    // filePath is absolute; build sibling path and convert to a file:// URL
    const dir = filePath.replace(/[\\/][^\\/]*$/, '');
    const abs = `${dir}/${relPath}`.replace(/\\/g, '/');
    return 'file://' + (abs.startsWith('/') ? abs : '/' + abs);
  }

  /* ── Tree rendering ── */
  function renderTree() {
    const q = els.searchInput.value.trim().toLowerCase();
    els.tree.innerHTML = '';
    let visibleCount = 0;
    let totalCount = 0;

    for (const page of state.pages) {
      const pageItemsVisible = [];
      page.sections.forEach((section) => {
        section.items.forEach((item) => {
          totalCount++;
          if (!q || item.name.toLowerCase().includes(q)) pageItemsVisible.push(item);
        });
      });
      if (q && pageItemsVisible.length === 0) continue;

      const pageTitleEl = document.createElement('div');
      pageTitleEl.className = 'tree-page-title';
      pageTitleEl.textContent = page.title;
      els.tree.appendChild(pageTitleEl);

      page.sections.forEach((section) => {
        const items = section.items.filter((it) => !q || it.name.toLowerCase().includes(q));
        if (items.length === 0) return;

        const secWrap = document.createElement('div');
        secWrap.className = 'tree-section';

        const secTitle = document.createElement('div');
        secTitle.className = 'tree-section-title';
        secTitle.innerHTML = `<span>${escapeHtml(section.name)}</span><span class="count">${items.length}</span>`;
        secWrap.appendChild(secTitle);

        items.forEach((item) => {
          visibleCount++;
          const row = document.createElement('div');
          row.className = 'tree-item' + (item.id === currentId ? ' active' : '') + (dirtyIds.has(item.id) ? ' dirty' : '');
          row.dataset.id = item.id;
          const priceLabel = item.shape === 'pizza' ? item.sizes.p7 : item.price;
          row.innerHTML = `<span class="ti-name">${escapeHtml(item.name)}</span><span class="ti-price">${escapeHtml(
            priceLabel || ''
          )}</span>`;
          row.addEventListener('click', () => selectItem(item.id));
          secWrap.appendChild(row);
        });

        els.tree.appendChild(secWrap);
      });
    }

    els.searchCount.textContent = q ? `${visibleCount}/${totalCount}` : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ── Edit form ── */
  function selectItem(id) {
    currentId = id;
    renderTree();
    const item = itemsById.get(id);
    if (!item) return;

    els.emptyState.hidden = true;
    els.editForm.hidden = false;

    els.metaSection.textContent = item.section;
    els.metaKind.textContent = item.kind === 'inline' ? 'Menu list item' : 'Data-driven item';

    els.fieldName.value = item.name || '';

    const isPizza = item.shape === 'pizza';
    els.sizesRow.hidden = !isPizza;
    els.priceRow.hidden = isPizza;
    if (isPizza) {
      els.fieldP7.value = item.sizes.p7 ?? '';
      els.fieldP10.value = item.sizes.p10 ?? '';
      els.fieldP13.value = item.sizes.p13 ?? '';
    } else {
      els.fieldPrice.value = item.price || '';
    }

    const hasDesc = item.kind === 'inline';
    els.descField.hidden = !hasDesc;
    els.fieldDesc.value = item.desc || '';

    els.noteField.hidden = item.kind !== 'data';
    els.fieldNote.value = item.note || '';

    updateImageUI(item);
    updatePreviewMock(item);
  }

  function updateImageUI(item) {
    const url = fileUrl(item.img);
    if (url) {
      els.imagePreviewImg.src = url;
      els.imagePreviewImg.hidden = false;
      els.imagePlaceholder.hidden = true;
      els.imagePath.textContent = item.img;
      els.clearImageBtn.hidden = false;
    } else {
      els.imagePreviewImg.hidden = true;
      els.imagePlaceholder.hidden = false;
      els.imagePath.textContent = '';
      els.clearImageBtn.hidden = true;
    }
  }

  function priceDisplayFor(item) {
    if (item.shape === 'pizza') {
      return `7": Rs.${item.sizes.p7} | 10": Rs.${item.sizes.p10} | 13": Rs.${item.sizes.p13}`;
    }
    return item.price || '';
  }

  function updatePreviewMock(item) {
    els.pmName.textContent = item.name || 'Item name';
    els.pmPrice.textContent = priceDisplayFor(item) || 'Price';
    const descText = item.kind === 'inline' ? item.desc : item.note;
    els.pmDesc.textContent = descText || 'No description yet.';

    const url = fileUrl(item.img);
    if (url) {
      els.pmImg.src = url;
      els.pmImg.hidden = false;
      els.pmPlaceholder.hidden = true;
    } else {
      els.pmImg.hidden = true;
      els.pmPlaceholder.hidden = false;
    }
  }

  function markCurrentDirty() {
    if (!currentId) return;
    setDirty(currentId, true);
    renderTree(); // refresh dot + price label in the list
  }

  function bindFieldEvents() {
    els.fieldName.addEventListener('input', () => {
      const item = itemsById.get(currentId);
      if (!item) return;
      item.name = els.fieldName.value;
      updatePreviewMock(item);
      markCurrentDirty();
    });

    els.fieldPrice.addEventListener('input', () => {
      const item = itemsById.get(currentId);
      if (!item) return;
      item.price = els.fieldPrice.value;
      updatePreviewMock(item);
      markCurrentDirty();
    });

    [els.fieldP7, els.fieldP10, els.fieldP13].forEach((el, i) => {
      const key = ['p7', 'p10', 'p13'][i];
      el.addEventListener('input', () => {
        const item = itemsById.get(currentId);
        if (!item) return;
        item.sizes[key] = el.value;
        updatePreviewMock(item);
        markCurrentDirty();
      });
    });

    els.fieldDesc.addEventListener('input', () => {
      const item = itemsById.get(currentId);
      if (!item) return;
      item.desc = els.fieldDesc.value;
      updatePreviewMock(item);
      markCurrentDirty();
    });

    els.fieldNote.addEventListener('input', () => {
      const item = itemsById.get(currentId);
      if (!item) return;
      item.note = els.fieldNote.value;
      updatePreviewMock(item);
      markCurrentDirty();
    });

    els.chooseImageBtn.addEventListener('click', async () => {
      const item = itemsById.get(currentId);
      if (!item) return;
      const res = await window.menuAPI.chooseImage(item.name);
      if (!res.ok) {
        if (!res.canceled) alert(`Could not add image: ${res.error}`);
        return;
      }
      item.img = res.relPath;
      updateImageUI(item);
      updatePreviewMock(item);
      markCurrentDirty();
    });

    els.clearImageBtn.addEventListener('click', () => {
      const item = itemsById.get(currentId);
      if (!item) return;
      item.img = '';
      updateImageUI(item);
      updatePreviewMock(item);
      markCurrentDirty();
    });

    els.searchInput.addEventListener('input', renderTree);
  }

  /* ── Save / load / reload ── */
  async function doSave() {
    const items = Array.from(itemsById.values()).map((it) => ({
      ...it,
      _dirty: dirtyIds.has(it.id),
    }));
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = 'Saving…';
    const res = await window.menuAPI.saveMenu(items);
    els.saveBtn.textContent = 'Save to menu-modal.html';
    if (!res.ok) {
      alert(`Save failed: ${res.error}`);
      els.saveBtn.disabled = dirtyIds.size === 0;
      return;
    }
    applyLoadedPages(res.pages, { keepSelection: true });
    dirtyIds.clear();
    setDirty(null, false);
  }

  function applyLoadedPages(pages, opts = {}) {
    state = { pages };
    itemsById = flattenItems(pages);
    if (opts.keepSelection && currentId && itemsById.has(currentId)) {
      // keep as-is
    } else {
      currentId = null;
      els.emptyState.hidden = false;
      els.editForm.hidden = true;
    }
    renderTree();
    if (currentId) selectItem(currentId);
  }

  async function afterFileLoaded(res) {
    filePath = res.filePath;
    els.fileLabel.textContent = res.filePath;
    els.onboard.hidden = true;
    els.workspace.hidden = false;
    dirtyIds.clear();
    setDirty(null, false);
    applyLoadedPages(res.pages);
  }

  async function boot() {
    const res = await window.menuAPI.loadLastOrPrompt();
    if (res.ok) {
      await afterFileLoaded(res);
    } else {
      els.onboard.hidden = false;
      if (res.error) {
        els.onboardError.hidden = false;
        els.onboardError.textContent = res.error;
      }
    }
  }

  els.onboardPickBtn.addEventListener('click', async () => {
    els.onboardError.hidden = true;
    const res = await window.menuAPI.pickMenuFile();
    if (res.ok) await afterFileLoaded(res);
    else if (!res.canceled) {
      els.onboardError.hidden = false;
      els.onboardError.textContent = res.error || 'Could not open that file.';
    }
  });

  els.changeFileBtn.addEventListener('click', async () => {
    if (dirtyIds.size > 0 && !confirm('You have unsaved changes. Discard them and open a different file?')) return;
    const res = await window.menuAPI.pickMenuFile();
    if (res.ok) await afterFileLoaded(res);
  });

  els.reloadBtn.addEventListener('click', async () => {
    if (dirtyIds.size > 0 && !confirm('You have unsaved changes. Discard them and reload from disk?')) return;
    const res = await window.menuAPI.reloadMenu();
    if (res.ok) await afterFileLoaded(res);
  });

  els.saveBtn.addEventListener('click', doSave);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!els.saveBtn.disabled) doSave();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirtyIds.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  bindFieldEvents();
  boot();
})();
