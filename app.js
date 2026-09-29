(() => {
  "use strict";

  const STORAGE_KEY = "notesVaultEnvelopeV1";
  const ITERATIONS = 350000;
  const SYNC_FILE = "vault.enc.json";

  const $ = id => document.getElementById(id);

  const welcomeView = $("welcomeView");
  const unlockView = $("unlockView");
  const vaultView = $("vaultView");
  const lockBtn = $("lockBtn");
  const addPanel = $("addPanel");
  const chatList = $("chatList");
  const emptyState = $("emptyState");
  const countLabel = $("countLabel");
  const searchInput = $("searchInput");
  const categoryFilters = $("categoryFilters");
  const libraryLauncher = $("libraryLauncher");
  const libraryOverlay = $("libraryOverlay");
  const libraryDrawer = $("libraryDrawer");
  const librarySearchInput = $("librarySearchInput");
  const libraryCategoryFilters = $("libraryCategoryFilters");
  const libraryChatList = $("libraryChatList");

  let unlockedPin = null;
  let vaultData = null;
  let currentCategory = "Tous";
  let libraryCategory = "Tous";
  let syncTimer = null;
  let syncBusy = false;

  function normalizeData(data) {
    if (!data || typeof data !== "object") data = {};
    if (!Array.isArray(data.chats)) data.chats = [];

    data.chats = data.chats.map(chat => ({
      id: chat.id || crypto.randomUUID(),
      label: chat.label || "Note",
      url: chat.url || "",
      category: chat.category || "Autre",
      createdAt: chat.createdAt || Date.now(),
      updatedAt: chat.updatedAt || chat.createdAt || Date.now()
    }));

    if (!data.sync || typeof data.sync !== "object") {
      data.sync = { enabled: false, owner: "", repo: "", token: "", path: SYNC_FILE };
    }
    data.sync.path ||= SYNC_FILE;
    return data;
  }

  function setMsg(id, text, type = "") {
    const el = $(id);
    el.textContent = text;
    el.className = `msg ${type}`;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    return Uint8Array.from(binary, ch => ch.charCodeAt(0));
  }

  function toB64Url(text) {
    const bytes = new TextEncoder().encode(text);
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function fromB64Url(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return new TextDecoder().decode(base64ToBytes(s));
  }

  async function deriveKey(pin, salt, iterations = ITERATIONS) {
    const rawKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      rawKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptVault(pin, data, existingSaltB64 = null) {
    const salt = existingSaltB64
      ? base64ToBytes(existingSaltB64)
      : crypto.getRandomValues(new Uint8Array(16));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));

    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

    return {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(cipher)),
      updatedAt: Date.now()
    };
  }

  async function decryptVault(pin, envelope) {
    const key = await deriveKey(
      pin,
      base64ToBytes(envelope.salt),
      Number(envelope.iterations) || ITERATIONS
    );

    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.data)
    );

    return normalizeData(JSON.parse(new TextDecoder().decode(plain)));
  }

  function getEnvelope() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveEnvelope(envelope) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  }

  async function persist({ sync = true } = {}) {
    if (!unlockedPin || !vaultData) throw new Error("Locked");
    const old = getEnvelope();
    const envelope = await encryptVault(unlockedPin, vaultData, old?.salt || null);
    saveEnvelope(envelope);
    if (sync && vaultData.sync?.enabled) scheduleAutoSync();
    return envelope;
  }

  function lock() {
    unlockedPin = null;
    vaultData = null;
    $("unlockPin").value = "";
    vaultView.classList.add("hidden");
    welcomeView.classList.add("hidden");
    unlockView.classList.remove("hidden");
    lockBtn.classList.add("hidden");
    libraryLauncher.classList.add("hidden");
    closeLibrary();
  }

  function showWelcome() {
    unlockedPin = null;
    vaultData = null;
    vaultView.classList.add("hidden");
    unlockView.classList.add("hidden");
    welcomeView.classList.remove("hidden");
    lockBtn.classList.add("hidden");
    libraryLauncher.classList.add("hidden");
    closeLibrary();
  }

  function showVault() {
    welcomeView.classList.add("hidden");
    unlockView.classList.add("hidden");
    vaultView.classList.remove("hidden");
    lockBtn.classList.remove("hidden");
    libraryLauncher.classList.remove("hidden");
    renderCategories();
    renderChats();
    renderLibrarySidebar();
    updateSyncUI();

    if (vaultData.sync?.enabled) {
      setTimeout(() => syncNow({ silent: true }).catch(() => {}), 350);
    }
  }

  async function createVault() {
    const pin = $("newPin").value.trim();
    const confirmPin = $("confirmPin").value.trim();

    if (!/^\d{6,}$/.test(pin)) {
      setMsg("welcomeMsg", "Choisis au moins 6 chiffres.", "err");
      return;
    }

    if (pin !== confirmPin) {
      setMsg("welcomeMsg", "Les deux codes ne correspondent pas.", "err");
      return;
    }

    vaultData = normalizeData({ chats: [] });
    unlockedPin = pin;
    saveEnvelope(await encryptVault(pin, vaultData));

    $("newPin").value = "";
    $("confirmPin").value = "";
    setMsg("welcomeMsg", "");
    showVault();
  }

  async function unlockVault() {
    const pin = $("unlockPin").value.trim();
    const envelope = getEnvelope();

    if (!envelope) {
      showWelcome();
      return;
    }

    try {
      vaultData = await decryptVault(pin, envelope);
      unlockedPin = pin;
      $("unlockPin").value = "";
      setMsg("unlockMsg", "");
      showVault();
    } catch {
      setMsg("unlockMsg", "Code incorrect.", "err");
      $("unlockPin").select();
    }
  }

  function normalizeChatUrl(value) {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:") return null;
      if (!["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) return null;
      if (!/^\/c\/[^/?#]+/.test(url.pathname)) return null;
      return `https://chatgpt.com${url.pathname}`;
    } catch {
      return null;
    }
  }

  function categories() {
    const set = new Set(vaultData.chats.map(c => (c.category || "Autre").trim()).filter(Boolean));
    return ["Tous", ...Array.from(set).sort((a, b) => a.localeCompare(b, "fr"))];
  }


  function openChatFromNotes(chat) {
    // Ouvre le vrai thread ChatGPT, sans toucher à son état archivé/désarchivé.
    // On laisse Notes ouvert derrière pour que ta bibliothèque reste disponible.
    window.open(chat.url, "_blank", "noopener");
  }

  function openLibrary() {
    if (!vaultData) return;
    libraryDrawer.classList.remove("hidden");
    libraryOverlay.classList.remove("hidden");
    libraryDrawer.classList.add("open");
    libraryOverlay.classList.add("open");
    renderLibrarySidebar();
    setTimeout(() => librarySearchInput?.focus(), 80);
  }

  function closeLibrary() {
    libraryDrawer.classList.remove("open");
    libraryOverlay.classList.remove("open");
    setTimeout(() => {
      libraryDrawer.classList.add("hidden");
      libraryOverlay.classList.add("hidden");
    }, 220);
  }

  function renderLibrarySidebar() {
    if (!vaultData) return;

    const cats = categories();
    if (!cats.includes(libraryCategory)) libraryCategory = "Tous";

    libraryCategoryFilters.innerHTML = "";
    for (const category of cats) {
      const button = document.createElement("button");
      button.className = `chip ${category === libraryCategory ? "active" : ""}`;
      button.textContent = category;
      button.addEventListener("click", () => {
        libraryCategory = category;
        renderLibrarySidebar();
      });
      libraryCategoryFilters.appendChild(button);
    }

    const query = (librarySearchInput?.value || "").trim().toLocaleLowerCase("fr");
    const chats = [...vaultData.chats]
      .filter(chat => libraryCategory === "Tous" || (chat.category || "Autre") === libraryCategory)
      .filter(chat => {
        if (!query) return true;
        return `${chat.label} ${chat.category || ""}`.toLocaleLowerCase("fr").includes(query);
      })
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

    libraryChatList.innerHTML = "";

    if (!chats.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.innerHTML = "<span>౨ৎ</span><p>Aucun chat ici.</p>";
      libraryChatList.appendChild(empty);
      return;
    }

    for (const chat of chats) {
      const button = document.createElement("button");
      button.className = "library-chat";
      button.innerHTML = `
        <span class="library-chat-icon">♡</span>
        <span class="library-chat-copy">
          <strong></strong>
          <small></small>
        </span>
        <span class="library-chat-arrow">›</span>
      `;
      button.querySelector("strong").textContent = chat.label;
      button.querySelector("small").textContent = chat.category || "Autre";
      button.addEventListener("click", () => openChatFromNotes(chat));
      libraryChatList.appendChild(button);
    }
  }

  function renderCategories() {
    const list = categories();
    if (!list.includes(currentCategory)) currentCategory = "Tous";
    categoryFilters.innerHTML = "";

    for (const category of list) {
      const button = document.createElement("button");
      button.className = `chip ${category === currentCategory ? "active" : ""}`;
      button.textContent = category;
      button.addEventListener("click", () => {
        currentCategory = category;
        renderCategories();
        renderChats();
      });
      categoryFilters.appendChild(button);
    }
  }

  function filteredChats() {
    const query = searchInput.value.trim().toLocaleLowerCase("fr");

    return [...vaultData.chats]
      .filter(chat => currentCategory === "Tous" || (chat.category || "Autre") === currentCategory)
      .filter(chat => {
        if (!query) return true;
        return `${chat.label} ${chat.category || ""}`.toLocaleLowerCase("fr").includes(query);
      })
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }

  function renderChats() {
    const chats = filteredChats();
    chatList.innerHTML = "";
    emptyState.classList.toggle("hidden", chats.length > 0);
    countLabel.textContent = `${vaultData.chats.length} note${vaultData.chats.length > 1 ? "s" : ""}`;

    for (const chat of chats) {
      const row = $("chatItemTemplate").content.firstElementChild.cloneNode(true);
      row.querySelector(".note-name").textContent = chat.label;
      row.querySelector(".note-category").textContent = chat.category || "Autre";

      row.querySelector(".note-main").addEventListener("click", () => {
        openChatFromNotes(chat);
      });

      row.querySelector(".note-more").addEventListener("click", async () => {
        const action = prompt(
          `Options — ${chat.label}\n\n1 = Renommer\n2 = Changer la catégorie\n3 = Retirer de Notes\n\nTape 1, 2 ou 3 :`
        );

        if (action === "1") {
          const name = prompt("Nouveau nom :", chat.label);
          if (name?.trim()) {
            chat.label = name.trim().slice(0, 80);
            chat.updatedAt = Date.now();
            await persist();
            renderChats();
          }
        } else if (action === "2") {
          const category = prompt("Nouvelle catégorie :", chat.category || "Autre");
          if (category?.trim()) {
            chat.category = category.trim().slice(0, 40);
            chat.updatedAt = Date.now();
            await persist();
            renderCategories();
            renderChats();
          }
        } else if (action === "3") {
          if (!confirm(`Retirer "${chat.label}" de Notes ?\n\nÇa ne supprime PAS la conversation ChatGPT.`)) return;
          vaultData.chats = vaultData.chats.filter(item => item.id !== chat.id);
          await persist();
          renderCategories();
          renderChats();
        }
      });

      chatList.appendChild(row);
    }

    if (vaultData && libraryChatList) renderLibrarySidebar();
  }

  async function saveChat() {
    const label = $("chatLabel").value.trim();
    const category = ($("chatCategory").value.trim() || "Autre").slice(0, 40);
    const url = normalizeChatUrl($("chatUrl").value);

    if (!label) {
      setMsg("addMsg", "Mets un petit nom.", "err");
      return;
    }
    if (!url) {
      setMsg("addMsg", "Colle un lien du type chatgpt.com/c/…", "err");
      return;
    }

    const existing = vaultData.chats.find(chat => chat.url === url);

    if (existing) {
      existing.label = label.slice(0, 80);
      existing.category = category;
      existing.updatedAt = Date.now();
    } else {
      vaultData.chats.push({
        id: crypto.randomUUID(),
        label: label.slice(0, 80),
        category,
        url,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    await persist();
    $("chatLabel").value = "";
    $("chatCategory").value = "";
    $("chatUrl").value = "";
    addPanel.classList.add("hidden");
    setMsg("addMsg", "Enregistré ♡", "ok");
    renderCategories();
    renderChats();
  }

  function encodeEnvelope(envelope) {
    return toB64Url(JSON.stringify(envelope));
  }

  function parseImportedValue(value) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Empty");

    let payload = trimmed;
    try {
      const url = new URL(trimmed);
      const params = new URLSearchParams(url.hash.replace(/^#/, ""));
      payload = params.get("vault") || trimmed;
    } catch {
      const match = trimmed.match(/(?:^|[#?&])vault=([^&]+)/);
      if (match) payload = match[1];
    }

    const envelope = JSON.parse(fromB64Url(payload));
    if (!envelope || envelope.v !== 1 || !envelope.salt || !envelope.iv || !envelope.data) {
      throw new Error("Invalid");
    }
    return envelope;
  }

  async function importFromWelcome() {
    try {
      const envelope = parseImportedValue($("importText").value);
      saveEnvelope(envelope);
      $("importText").value = "";
      setMsg("welcomeMsg", "Importé. Entre maintenant ton code.", "ok");
      setTimeout(lock, 450);
    } catch {
      setMsg("welcomeMsg", "Ce code n’est pas valide.", "err");
    }
  }

  async function restoreInsideApp() {
    try {
      const envelope = parseImportedValue($("restoreText").value);
      const data = await decryptVault(unlockedPin, envelope);
      saveEnvelope(envelope);
      vaultData = data;
      $("restoreText").value = "";
      setMsg("backupMsg", "Sauvegarde restaurée ♡", "ok");
      renderCategories();
      renderChats();
      updateSyncUI();
    } catch {
      setMsg("backupMsg", "Impossible de restaurer avec ce code/PIN.", "err");
    }
  }

  async function copyText(text, msgId) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg(msgId, "Copié ♡", "ok");
    } catch {
      prompt("Copie ce texte :", text);
    }
  }

  async function copyPrivateLink() {
    const envelope = await persist({ sync: false });
    if (location.protocol === "http:" || location.protocol === "https:") {
      const base = `${location.origin}${location.pathname}`;
      await copyText(`${base}#vault=${encodeEnvelope(envelope)}`, "backupMsg");
    }
  }

  async function copyBackup() {
    await copyText(encodeEnvelope(await persist({ sync: false })), "backupMsg");
  }

  function maybeImportFromHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const payload = params.get("vault");
    if (!payload) return false;

    try {
      saveEnvelope(parseImportedValue(payload));
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    } catch {
      return false;
    }
  }

  function ghHeaders(token) {
    return {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  function ghUrl(sync) {
    return `https://api.github.com/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}/contents/${encodeURIComponent(sync.path || SYNC_FILE)}`;
  }

  function utf8ToB64(text) {
    return bytesToBase64(new TextEncoder().encode(text));
  }

  function b64ToUtf8(text) {
    return new TextDecoder().decode(base64ToBytes(text.replace(/\n/g, "")));
  }

  async function getRemote(sync) {
    const response = await fetch(ghUrl(sync), {
      method: "GET",
      headers: ghHeaders(sync.token),
      cache: "no-store"
    });

    if (response.status === 404) return { exists: false, sha: null, envelope: null };
    if (!response.ok) throw new Error(`GET ${response.status}`);

    const body = await response.json();
    return {
      exists: true,
      sha: body.sha,
      envelope: JSON.parse(b64ToUtf8(body.content))
    };
  }

  async function putRemote(sync, envelope, sha = null) {
    const body = {
      message: "Sync Notes vault",
      content: utf8ToB64(JSON.stringify(envelope))
    };
    if (sha) body.sha = sha;

    const response = await fetch(ghUrl(sync), {
      method: "PUT",
      headers: { ...ghHeaders(sync.token), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`PUT ${response.status}`);
    return response.json();
  }

  function setSyncState(kind, text) {
    $("syncDot").className = `dot ${kind || ""}`;
    $("syncStatusText").textContent = text;
  }

  function updateSyncUI() {
    const enabled = Boolean(vaultData?.sync?.enabled);
    $("syncOffArea").classList.toggle("hidden", enabled);
    $("syncOnArea").classList.toggle("hidden", !enabled);
    $("syncSetupArea").classList.add("hidden");

    $("syncBadge").textContent = enabled ? "on" : "off";
    $("syncBadge").className = `badge ${enabled ? "on" : "off"}`;

    if (enabled) {
      $("syncRepoLabel").textContent = `${vaultData.sync.owner}/${vaultData.sync.repo}`;
      setSyncState("ok", "Synchro activée");
    }
  }

  async function connectSync() {
    const owner = $("ghOwner").value.trim();
    const repo = $("ghRepo").value.trim();
    const token = $("ghToken").value.trim();

    if (!owner || !repo || !token) {
      setMsg("syncMsg", "Remplis les trois champs.", "err");
      return;
    }

    const sync = { enabled: true, owner, repo, token, path: SYNC_FILE };

    try {
      setSyncState("busy", "Connexion…");
      const remote = await getRemote(sync);

      vaultData.sync = sync;
      const localEnvelope = await persist({ sync: false });

      if (!remote.exists) {
        await putRemote(sync, localEnvelope);
      } else if (Number(remote.envelope?.updatedAt || 0) > Number(localEnvelope.updatedAt || 0)) {
        const useRemote = confirm("Le dépôt contient déjà une sauvegarde plus récente. La récupérer ?");
        if (useRemote) {
          vaultData = await decryptVault(unlockedPin, remote.envelope);
          vaultData.sync = sync;
          saveEnvelope(remote.envelope);
          await persist({ sync: false });
        } else {
          await putRemote(sync, localEnvelope, remote.sha);
        }
      } else {
        await putRemote(sync, localEnvelope, remote.sha);
      }

      $("ghToken").value = "";
      setMsg("syncMsg", "Synchro automatique activée ♡", "ok");
      updateSyncUI();
      renderCategories();
      renderChats();
    } catch {
      vaultData.sync.enabled = false;
      await persist({ sync: false });
      setMsg("syncMsg", "Connexion impossible. Vérifie ton pseudo, le dépôt privé et le token.", "err");
      updateSyncUI();
    }
  }

  function scheduleAutoSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow({ silent: true }).catch(() => {}), 900);
  }

  async function syncNow({ silent = false } = {}) {
    if (syncBusy || !vaultData?.sync?.enabled || !vaultData.sync.token) return;
    syncBusy = true;

    try {
      if (!silent) setMsg("syncMsg", "Synchronisation…");
      setSyncState("busy", "Synchronisation…");

      const sync = vaultData.sync;
      const localEnvelope = getEnvelope();
      const remote = await getRemote(sync);

      if (!remote.exists) {
        await putRemote(sync, localEnvelope);
      } else {
        const remoteTime = Number(remote.envelope?.updatedAt || 0);
        const localTime = Number(localEnvelope?.updatedAt || 0);

        if (remoteTime > localTime) {
          const remoteData = await decryptVault(unlockedPin, remote.envelope);
          if (!remoteData.sync?.enabled) remoteData.sync = sync;
          vaultData = normalizeData(remoteData);
          await persist({ sync: false });
          renderCategories();
          renderChats();
          updateSyncUI();
        } else if (localTime > remoteTime) {
          await putRemote(sync, localEnvelope, remote.sha);
        }
      }

      setSyncState("ok", "À jour");
      if (!silent) setMsg("syncMsg", "Tout est à jour ♡", "ok");
    } catch {
      setSyncState("err", "Synchro impossible");
      if (!silent) setMsg("syncMsg", "La synchro a échoué. Ton coffre local reste intact.", "err");
    } finally {
      syncBusy = false;
    }
  }

  async function disableSync() {
    if (!confirm("Désactiver la synchro automatique ?")) return;

    vaultData.sync = { enabled: false, owner: "", repo: "", token: "", path: SYNC_FILE };
    await persist({ sync: false });
    setMsg("syncMsg", "Synchro désactivée.", "ok");
    updateSyncUI();
  }


  libraryLauncher.addEventListener("click", openLibrary);
  libraryOverlay.addEventListener("click", closeLibrary);
  $("closeLibraryBtn").addEventListener("click", closeLibrary);
  librarySearchInput.addEventListener("input", renderLibrarySidebar);

  $("createVaultBtn").addEventListener("click", createVault);
  $("unlockBtn").addEventListener("click", unlockVault);
  $("unlockPin").addEventListener("keydown", e => { if (e.key === "Enter") unlockVault(); });
  $("importBtn").addEventListener("click", importFromWelcome);
  $("restoreBtn").addEventListener("click", restoreInsideApp);

  $("resetLocalBtn").addEventListener("click", () => {
    if (!confirm("Effacer le coffre de CET appareil ?\n\nTes conversations ChatGPT ne seront pas supprimées.")) return;
    localStorage.removeItem(STORAGE_KEY);
    showWelcome();
  });

  lockBtn.addEventListener("click", lock);
  $("addBtn").addEventListener("click", () => {
    addPanel.classList.remove("hidden");
    setMsg("addMsg", "");
    setTimeout(() => $("chatLabel").focus(), 0);
  });
  $("cancelAddBtn").addEventListener("click", () => {
    addPanel.classList.add("hidden");
    setMsg("addMsg", "");
  });
  $("saveChatBtn").addEventListener("click", saveChat);
  searchInput.addEventListener("input", renderChats);

  $("copyPrivateLinkBtn").addEventListener("click", copyPrivateLink);
  $("copyBackupBtn").addEventListener("click", copyBackup);

  $("openSyncSetupBtn").addEventListener("click", () => {
    $("syncOffArea").classList.add("hidden");
    $("syncSetupArea").classList.remove("hidden");
  });
  $("cancelSyncBtn").addEventListener("click", () => {
    $("syncSetupArea").classList.add("hidden");
    $("syncOffArea").classList.remove("hidden");
  });
  $("connectSyncBtn").addEventListener("click", connectSync);
  $("syncNowBtn").addEventListener("click", () => syncNow({ silent: false }));
  $("disableSyncBtn").addEventListener("click", disableSync);

  window.addEventListener("focus", () => {
    if (vaultData?.sync?.enabled) syncNow({ silent: true }).catch(() => {});
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && vaultData?.sync?.enabled) {
      syncNow({ silent: true }).catch(() => {});
    }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }

  const imported = maybeImportFromHash();
  const envelope = getEnvelope();
  if (imported || envelope) lock();
  else showWelcome();
})();
