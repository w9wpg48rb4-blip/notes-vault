(() => {
  "use strict";

  const STORAGE_KEY = "notesVaultEnvelopeV1";
  const ITERATIONS = 350000;
  const SYNC_FILE = "vault.enc.json";
  const APP_VERSION = "5.1";

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

  let unlockedPin = null;
  let vaultData = null;
  let currentCategory = "Tous";
  let editingId = null;
  let sheetChatId = null;
  let syncTimer = null;
  let syncBusy = false;
  let toastTimer = null;

  function normalizeData(data) {
    if (!data || typeof data !== "object") data = {};
    if (!Array.isArray(data.chats)) data.chats = [];
    if (!data.deleted || typeof data.deleted !== "object") data.deleted = {};

    data.chats = data.chats.map(chat => ({
      id: chat.id || crypto.randomUUID(),
      label: String(chat.label || "Note").slice(0, 80),
      searchTerm: String(chat.searchTerm || chat.label || "Note").slice(0, 120),
      url: chat.url || "",
      category: String(chat.category || "Autre").slice(0, 40),
      createdAt: Number(chat.createdAt) || Date.now(),
      updatedAt: Number(chat.updatedAt || chat.createdAt) || Date.now()
    }));

    // Respect tombstones from newer versions.
    data.chats = data.chats.filter(chat => {
      const deletedAt = Number(data.deleted[chat.id] || 0);
      return !deletedAt || deletedAt < chat.updatedAt;
    });

    // Deduplicate by URL, keeping the newest copy.
    const byUrl = new Map();
    for (const chat of data.chats) {
      const key = chat.url || chat.id;
      const old = byUrl.get(key);
      if (!old || chat.updatedAt >= old.updatedAt) byUrl.set(key, chat);
    }
    data.chats = [...byUrl.values()];

    if (!data.sync || typeof data.sync !== "object") {
      data.sync = { enabled: false, owner: "", repo: "", token: "", path: SYNC_FILE };
    }
    data.sync = {
      enabled: Boolean(data.sync.enabled),
      owner: String(data.sync.owner || ""),
      repo: String(data.sync.repo || ""),
      token: String(data.sync.token || ""),
      path: String(data.sync.path || SYNC_FILE)
    };

    return data;
  }

  function setMsg(id, text, type = "") {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = `msg ${type}`;
  }

  function showToast(text, ms = 1900) {
    clearTimeout(toastTimer);
    const el = $("toast");
    el.textContent = text;
    el.classList.remove("hidden");
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
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
    return bytesToBase64(new TextEncoder().encode(text))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function fromB64Url(value) {
    let s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return new TextDecoder().decode(base64ToBytes(s));
  }

  async function deriveKey(pin, salt, iterations = ITERATIONS) {
    const raw = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      raw,
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
    const plain = new TextEncoder().encode(JSON.stringify(normalizeData(data)));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);

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
    if (!unlockedPin || !vaultData) throw new Error("locked");
    const old = getEnvelope();
    const envelope = await encryptVault(unlockedPin, vaultData, old?.salt || null);
    saveEnvelope(envelope);
    if (sync && vaultData.sync?.enabled) scheduleAutoSync();
    return envelope;
  }

  function lock() {
    unlockedPin = null;
    vaultData = null;
    editingId = null;
    closeSheet();
    vaultView.classList.add("hidden");
    welcomeView.classList.add("hidden");
    unlockView.classList.remove("hidden");
    lockBtn.classList.add("hidden");
    $("unlockPin").value = "";
  }

  function showWelcome() {
    unlockedPin = null;
    vaultData = null;
    editingId = null;
    closeSheet();
    vaultView.classList.add("hidden");
    unlockView.classList.add("hidden");
    welcomeView.classList.remove("hidden");
    lockBtn.classList.add("hidden");
  }

  function showVault() {
    welcomeView.classList.add("hidden");
    unlockView.classList.add("hidden");
    vaultView.classList.remove("hidden");
    lockBtn.classList.remove("hidden");
    renderAll();
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

    vaultData = normalizeData({ chats: [], deleted: {} });
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
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:") return null;
      if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/c\/([^/?#]+)/);
      if (!match) return null;
      return `https://chatgpt.com/c/${match[1]}`;
    } catch {
      return null;
    }
  }

  function categories() {
    const set = new Set(
      vaultData.chats
        .map(chat => (chat.category || "Autre").trim())
        .filter(Boolean)
    );
    return ["Tous", ...Array.from(set).sort((a, b) => a.localeCompare(b, "fr"))];
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
        renderChats();
        renderCategories();
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
        return `${chat.label} ${chat.searchTerm} ${chat.category}`
          .toLocaleLowerCase("fr")
          .includes(query);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function renderChats() {
    const chats = filteredChats();
    chatList.innerHTML = "";
    emptyState.classList.toggle("hidden", chats.length > 0);
    countLabel.textContent = `${vaultData.chats.length} chat${vaultData.chats.length > 1 ? "s" : ""}`;

    for (const chat of chats) {
      const row = $("chatItemTemplate").content.firstElementChild.cloneNode(true);
      row.querySelector(".chat-name").textContent = chat.label;
      row.querySelector(".chat-meta").textContent = `${chat.category || "Autre"} · recherche : ${chat.searchTerm || chat.label}`;

      row.querySelector(".chat-main").addEventListener("click", () => launchFullChat(chat));
      row.querySelector(".chat-more").addEventListener("click", () => openSheet(chat.id));

      chatList.appendChild(row);
    }
  }

  function renderAll() {
    renderCategories();
    renderChats();
  }

  function isIOSDevice() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function legacyCopy(text) {
    let area = null;
    try {
      area = document.createElement("textarea");
      area.value = String(text || "");
      area.setAttribute("readonly", "");
      area.setAttribute("aria-hidden", "true");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      const ok = document.execCommand("copy");
      area.remove();
      return Boolean(ok);
    } catch {
      area?.remove();
      return false;
    }
  }

  async function copyQuietly(text) {
    // Try the synchronous path first so iOS still treats the following app-open as user initiated.
    const syncOk = legacyCopy(text);

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(String(text || "")).catch(() => {});
    }

    return syncOk || Boolean(navigator.clipboard?.writeText);
  }

  async function launchFullChat(chat) {
    const term = (chat.searchTerm || chat.label || "").trim();

    if (!term) {
      showToast("Ajoute d’abord un titre de recherche pour ce chat.");
      editChat(chat);
      return;
    }

    const copied = await copyQuietly(term);

    if (!copied) {
      showToast(`Copie manuelle : ${term}`, 3200);
      return;
    }

    sessionStorage.setItem("notesLastSearchTerm", term);

    // IMPORTANT V5.1:
    // On n'ouvre volontairement PAS ChatGPT depuis Notes.
    // Toute ouverture externe (universal link, URL scheme, Shortcut, etc.)
    // peut laisser l'app iOS dans un contexte de navigation externe.
    // L'utilisateur ouvre ensuite ChatGPT depuis son icône normale.
    showToast(`✓ “${term}” copié · ouvre ChatGPT normalement → Rechercher → Coller`, 4200);
  }

  function openSheet(chatId) {
    sheetChatId = chatId;
    const chat = vaultData.chats.find(item => item.id === chatId);
    if (!chat) return;

    $("sheetTitle").textContent = chat.label;
    $("sheetOverlay").classList.remove("hidden");
    $("actionSheet").classList.remove("hidden");
  }

  function closeSheet() {
    sheetChatId = null;
    $("sheetOverlay")?.classList.add("hidden");
    $("actionSheet")?.classList.add("hidden");
  }

  function beginAdd() {
    editingId = null;
    $("editorTitle").textContent = "Ajouter un chat";
    $("chatLabel").value = "";
    $("chatSearchTerm").value = "";
    $("chatCategory").value = "";
    $("chatUrl").value = "";
    setMsg("addMsg", "");
    addPanel.classList.remove("hidden");
    setTimeout(() => $("chatLabel").focus(), 0);
  }

  function editChat(chat) {
    editingId = chat.id;
    $("editorTitle").textContent = "Modifier le raccourci";
    $("chatLabel").value = chat.label;
    $("chatSearchTerm").value = chat.searchTerm || chat.label;
    $("chatCategory").value = chat.category || "Autre";
    $("chatUrl").value = chat.url;
    setMsg("addMsg", "");
    addPanel.classList.remove("hidden");
    addPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelEditor() {
    editingId = null;
    addPanel.classList.add("hidden");
    setMsg("addMsg", "");
  }

  async function saveChat() {
    const label = $("chatLabel").value.trim().slice(0, 80);
    const searchTerm = ($("chatSearchTerm").value.trim() || label).slice(0, 120);
    const category = ($("chatCategory").value.trim() || "Autre").slice(0, 40);
    const url = normalizeChatUrl($("chatUrl").value);

    if (!label) {
      setMsg("addMsg", "Mets un nom dans Notes.", "err");
      return;
    }
    if (!searchTerm) {
      setMsg("addMsg", "Mets un titre à rechercher dans ChatGPT.", "err");
      return;
    }
    if (!url) {
      setMsg("addMsg", "Colle un lien du type chatgpt.com/c/…", "err");
      return;
    }

    const duplicate = vaultData.chats.find(chat => chat.url === url && chat.id !== editingId);
    if (duplicate) {
      setMsg("addMsg", "Ce chat est déjà dans Notes.", "err");
      return;
    }

    const now = Date.now();

    if (editingId) {
      const chat = vaultData.chats.find(item => item.id === editingId);
      if (!chat) return;
      chat.label = label;
      chat.searchTerm = searchTerm;
      chat.category = category;
      chat.url = url;
      chat.updatedAt = now;
    } else {
      vaultData.chats.push({
        id: crypto.randomUUID(),
        label,
        searchTerm,
        category,
        url,
        createdAt: now,
        updatedAt: now
      });
    }

    await persist();
    editingId = null;
    addPanel.classList.add("hidden");
    renderAll();
    showToast("Enregistré ♡");
  }

  async function removeChat(chat) {
    if (!confirm(`Retirer “${chat.label}” de Notes ?\n\nLa conversation ChatGPT ne sera pas supprimée.`)) return;

    vaultData.deleted[chat.id] = Date.now();
    vaultData.chats = vaultData.chats.filter(item => item.id !== chat.id);
    await persist();
    closeSheet();
    renderAll();
    showToast("Retiré de Notes.");
  }

  function encodeEnvelope(envelope) {
    return toB64Url(JSON.stringify(envelope));
  }

  function parseImportedValue(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) throw new Error("empty");

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
      throw new Error("invalid");
    }

    return envelope;
  }

  async function copyWithFeedback(text, msgId) {
    let ok = false;

    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }

    if (ok) {
      setMsg(msgId, "Copié ♡", "ok");
      return true;
    }

    setMsg(msgId, "Copie automatique impossible. Sélectionne le texte manuellement après un nouvel essai.", "err");
    return false;
  }

  async function importFromWelcome() {
    try {
      const envelope = parseImportedValue($("importText").value);
      saveEnvelope(envelope);
      $("importText").value = "";
      setMsg("welcomeMsg", "Importé. Entre maintenant ton code.", "ok");
      setTimeout(lock, 350);
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
      renderAll();
      updateSyncUI();
    } catch {
      setMsg("backupMsg", "Impossible de restaurer avec ce code/PIN.", "err");
    }
  }

  async function copyBackup() {
    const envelope = await persist({ sync: false });
    await copyWithFeedback(encodeEnvelope(envelope), "backupMsg");
  }

  function utf8ToB64(text) {
    return bytesToBase64(new TextEncoder().encode(text));
  }

  function b64ToUtf8(text) {
    return new TextDecoder().decode(base64ToBytes(String(text || "").replace(/\n/g, "")));
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
      message: "Sync Notes vault v5",
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

  function mergeData(localData, remoteData, currentSync) {
    const local = normalizeData(structuredClone(localData));
    const remote = normalizeData(structuredClone(remoteData));

    const deleted = { ...remote.deleted, ...local.deleted };
    for (const [id, ts] of Object.entries(remote.deleted || {})) {
      deleted[id] = Math.max(Number(deleted[id] || 0), Number(ts || 0));
    }
    for (const [id, ts] of Object.entries(local.deleted || {})) {
      deleted[id] = Math.max(Number(deleted[id] || 0), Number(ts || 0));
    }

    const byId = new Map();

    for (const chat of [...remote.chats, ...local.chats]) {
      const old = byId.get(chat.id);
      if (!old || chat.updatedAt >= old.updatedAt) byId.set(chat.id, chat);
    }

    let chats = [...byId.values()].filter(chat => Number(deleted[chat.id] || 0) < chat.updatedAt);

    const byUrl = new Map();
    for (const chat of chats) {
      const key = chat.url || chat.id;
      const old = byUrl.get(key);
      if (!old || chat.updatedAt >= old.updatedAt) byUrl.set(key, chat);
    }
    chats = [...byUrl.values()];

    return normalizeData({
      chats,
      deleted,
      sync: currentSync || local.sync || remote.sync
    });
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

  function openSyncSetup() {
    const sync = vaultData?.sync || {};
    $("ghOwner").value = sync.owner || "";
    $("ghRepo").value = sync.repo || "";
    $("ghToken").value = "";
    $("syncOffArea").classList.add("hidden");
    $("syncOnArea").classList.add("hidden");
    $("syncSetupArea").classList.remove("hidden");
    setMsg("syncMsg", "");
  }

  function cancelSyncSetup() {
    updateSyncUI();
  }

  async function connectSync() {
    const owner = $("ghOwner").value.trim();
    const repo = $("ghRepo").value.trim();
    const token = $("ghToken").value.trim() || vaultData?.sync?.token || "";

    if (!owner || !repo || !token) {
      setMsg("syncMsg", "Remplis le pseudo, le dépôt et le token.", "err");
      return;
    }

    const sync = { enabled: true, owner, repo, token, path: SYNC_FILE };

    try {
      setSyncState("busy", "Connexion…");
      const remote = await getRemote(sync);

      vaultData.sync = sync;
      let merged = vaultData;

      if (remote.exists) {
        const remoteData = await decryptVault(unlockedPin, remote.envelope);
        merged = mergeData(vaultData, remoteData, sync);
      }

      vaultData = merged;
      const envelope = await persist({ sync: false });
      await putRemote(sync, envelope, remote.sha);

      $("ghToken").value = "";
      setMsg("syncMsg", "Synchro automatique activée ♡", "ok");
      updateSyncUI();
      renderAll();
    } catch {
      setSyncState("err", "Connexion impossible");
      setMsg("syncMsg", "Vérifie le dépôt privé, ton pseudo et le token.", "err");
    }
  }

  function scheduleAutoSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow({ silent: true }).catch(() => {}), 1000);
  }

  async function syncNow({ silent = false } = {}) {
    if (syncBusy || !vaultData?.sync?.enabled || !vaultData.sync.token) return;
    syncBusy = true;

    try {
      if (!silent) setMsg("syncMsg", "Synchronisation…");
      setSyncState("busy", "Synchronisation…");

      const sync = { ...vaultData.sync };
      const remote = await getRemote(sync);

      if (!remote.exists) {
        const envelope = await persist({ sync: false });
        await putRemote(sync, envelope);
      } else {
        const remoteData = await decryptVault(unlockedPin, remote.envelope);
        vaultData = mergeData(vaultData, remoteData, sync);
        const mergedEnvelope = await persist({ sync: false });
        await putRemote(sync, mergedEnvelope, remote.sha);
      }

      renderAll();
      updateSyncUI();
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

  // ---------- Events ----------

  $("createVaultBtn").addEventListener("click", createVault);
  $("unlockBtn").addEventListener("click", unlockVault);
  $("unlockPin").addEventListener("keydown", event => {
    if (event.key === "Enter") unlockVault();
  });

  $("importBtn").addEventListener("click", importFromWelcome);
  $("restoreBtn").addEventListener("click", restoreInsideApp);

  $("resetLocalBtn").addEventListener("click", () => {
    if (!confirm("Effacer le coffre de CET appareil ?\n\nTes conversations ChatGPT ne seront pas supprimées.")) return;
    localStorage.removeItem(STORAGE_KEY);
    showWelcome();
  });

  lockBtn.addEventListener("click", lock);
  $("addBtn").addEventListener("click", beginAdd);
  $("cancelAddBtn").addEventListener("click", cancelEditor);
  $("saveChatBtn").addEventListener("click", saveChat);
  searchInput.addEventListener("input", renderChats);

  $("copyBackupBtn").addEventListener("click", copyBackup);

  $("openSyncSetupBtn").addEventListener("click", openSyncSetup);
  $("editSyncBtn").addEventListener("click", openSyncSetup);
  $("cancelSyncBtn").addEventListener("click", cancelSyncSetup);
  $("connectSyncBtn").addEventListener("click", connectSync);
  $("syncNowBtn").addEventListener("click", () => syncNow({ silent: false }));
  $("disableSyncBtn").addEventListener("click", disableSync);

  $("sheetOverlay").addEventListener("click", closeSheet);
  $("sheetCancelBtn").addEventListener("click", closeSheet);

  $("sheetEditBtn").addEventListener("click", () => {
    const chat = vaultData.chats.find(item => item.id === sheetChatId);
    closeSheet();
    if (chat) editChat(chat);
  });

  $("sheetCopySearchBtn").addEventListener("click", async () => {
    const chat = vaultData.chats.find(item => item.id === sheetChatId);
    if (!chat) return;
    const term = chat.searchTerm || chat.label;
    await copyQuietly(term);
    closeSheet();
    showToast(`“${term}” copié`);
  });

  $("sheetCopyLinkBtn").addEventListener("click", async () => {
    const chat = vaultData.chats.find(item => item.id === sheetChatId);
    if (!chat) return;
    await copyQuietly(chat.url);
    closeSheet();
    showToast("Lien du chat copié.");
  });

  $("sheetRemoveBtn").addEventListener("click", () => {
    const chat = vaultData.chats.find(item => item.id === sheetChatId);
    if (chat) removeChat(chat);
  });

  window.addEventListener("focus", () => {
    if (vaultData?.sync?.enabled) syncNow({ silent: true }).catch(() => {});
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && vaultData?.sync?.enabled) {
      syncNow({ silent: true }).catch(() => {});
    }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("service-worker-v51.js").catch(() => {});
  }

  // ---------- Boot ----------
  const envelope = getEnvelope();
  if (envelope) lock();
  else showWelcome();

  console.info(`Notes Vault ${APP_VERSION}`);
})();
