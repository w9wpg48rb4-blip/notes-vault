(() => {
  "use strict";

  const STORAGE_KEY = "notesVaultEnvelopeV1";
  const ITERATIONS = 350000;

  const $ = id => document.getElementById(id);

  const welcomeView = $("welcomeView");
  const unlockView = $("unlockView");
  const vaultView = $("vaultView");
  const lockBtn = $("lockBtn");
  const addPanel = $("addPanel");
  const addBtn = $("addBtn");
  const chatList = $("chatList");
  const emptyState = $("emptyState");
  const countLabel = $("countLabel");

  let unlockedPin = null;
  let vaultData = { chats: [] };

  function setMsg(id, text, type = "") {
    const el = $(id);
    el.textContent = text;
    el.className = `msg ${type}`;
  }

  function bytesToB64(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function b64ToBytes(s) {
    const bin = atob(s);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  function toB64Url(text) {
    const bytes = new TextEncoder().encode(text);
    return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function fromB64Url(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bytes = b64ToBytes(s);
    return new TextDecoder().decode(bytes);
  }

  async function deriveKey(pin, salt, iterations = ITERATIONS) {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptVault(pin, data, existingSaltB64 = null) {
    const salt = existingSaltB64
      ? b64ToBytes(existingSaltB64)
      : crypto.getRandomValues(new Uint8Array(16));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));

    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext
    );

    return {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: ITERATIONS,
      salt: bytesToB64(salt),
      iv: bytesToB64(iv),
      data: bytesToB64(new Uint8Array(cipher))
    };
  }

  async function decryptVault(pin, envelope) {
    const salt = b64ToBytes(envelope.salt);
    const iv = b64ToBytes(envelope.iv);
    const cipher = b64ToBytes(envelope.data);
    const key = await deriveKey(pin, salt, Number(envelope.iterations) || ITERATIONS);

    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipher
    );

    const obj = JSON.parse(new TextDecoder().decode(plain));
    if (!obj || !Array.isArray(obj.chats)) throw new Error("Invalid vault");
    return obj;
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

  function lock() {
    unlockedPin = null;
    vaultData = { chats: [] };
    $("unlockPin").value = "";
    vaultView.classList.add("hidden");
    welcomeView.classList.add("hidden");
    unlockView.classList.remove("hidden");
    lockBtn.classList.add("hidden");
  }

  function showWelcome() {
    unlockedPin = null;
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
    renderChats();
  }

  async function persist() {
    const old = getEnvelope();
    const envelope = await encryptVault(unlockedPin, vaultData, old?.salt || null);
    saveEnvelope(envelope);
    return envelope;
  }

  function normalizeChatUrl(value) {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:") return null;
      if (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com") return null;
      if (!/^\/c\/[^/?#]+/.test(url.pathname)) return null;
      return `https://chatgpt.com${url.pathname}`;
    } catch {
      return null;
    }
  }

  function renderChats() {
    chatList.innerHTML = "";
    const chats = [...vaultData.chats].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    emptyState.classList.toggle("hidden", chats.length > 0);
    countLabel.textContent = `${chats.length} conversation${chats.length > 1 ? "s" : ""}`;

    for (const chat of chats) {
      const node = $("chatItemTemplate").content.firstElementChild.cloneNode(true);
      node.querySelector(".chatName").textContent = chat.label;

      node.querySelector(".chatOpen").addEventListener("click", () => {
        window.open(chat.url, "_blank", "noopener");
        lock();
      });

      node.querySelector(".chatMenu").addEventListener("click", async () => {
        const ok = confirm(`Retirer "${chat.label}" de ce coffre ?\n\nÇa ne supprime PAS le chat de ChatGPT.`);
        if (!ok) return;
        vaultData.chats = vaultData.chats.filter(x => x.id !== chat.id);
        await persist();
        renderChats();
      });

      chatList.appendChild(node);
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

    vaultData = { chats: [] };
    unlockedPin = pin;
    const envelope = await encryptVault(pin, vaultData);
    saveEnvelope(envelope);

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
      setMsg("unlockMsg", "");
      $("unlockPin").value = "";
      showVault();
    } catch {
      setMsg("unlockMsg", "Code incorrect.", "err");
      $("unlockPin").select();
    }
  }

  function encodeEnvelope(envelope) {
    return toB64Url(JSON.stringify(envelope));
  }

  function parseImportedValue(value) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Vide");

    let payload = trimmed;

    try {
      const url = new URL(trimmed);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      payload = hash.get("vault") || trimmed;
    } catch {
      const maybe = trimmed.match(/(?:^|[#?&])vault=([^&]+)/);
      if (maybe) payload = maybe[1];
    }

    const json = fromB64Url(payload);
    const envelope = JSON.parse(json);

    if (!envelope || envelope.v !== 1 || !envelope.salt || !envelope.iv || !envelope.data) {
      throw new Error("Format invalide");
    }
    return envelope;
  }

  async function importVaultFromText() {
    try {
      const envelope = parseImportedValue($("importText").value);
      saveEnvelope(envelope);
      $("importText").value = "";
      setMsg("welcomeMsg", "Importé. Entre maintenant ton code.", "ok");
      setTimeout(lock, 500);
    } catch {
      setMsg("welcomeMsg", "Ce lien/code n'est pas valide.", "err");
    }
  }

  async function saveChat() {
    const label = $("chatLabel").value.trim();
    const url = normalizeChatUrl($("chatUrl").value);

    if (!label) {
      setMsg("addMsg", "Mets un petit nom discret.", "err");
      return;
    }
    if (!url) {
      setMsg("addMsg", "Colle un lien de conversation ChatGPT du type chatgpt.com/c/…", "err");
      return;
    }

    const existing = vaultData.chats.find(x => x.url === url);
    if (existing) {
      existing.label = label;
      existing.updatedAt = Date.now();
    } else {
      vaultData.chats.push({
        id: crypto.randomUUID(),
        label,
        url,
        createdAt: Date.now()
      });
    }

    await persist();

    $("chatLabel").value = "";
    $("chatUrl").value = "";
    setMsg("addMsg", "Enregistré.", "ok");
    addPanel.classList.add("hidden");
    renderChats();
  }

  async function copyText(text, msgId) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg(msgId, "Copié ✦", "ok");
    } catch {
      prompt("Copie ce texte :", text);
    }
  }

  async function copyPrivateLink() {
    const envelope = await persist();
    const encoded = encodeEnvelope(envelope);

    if (location.protocol === "http:" || location.protocol === "https:") {
      const base = `${location.origin}${location.pathname}`;
      await copyText(`${base}#vault=${encoded}`, "syncMsg");
    } else {
      setMsg("syncMsg", "Héberge d'abord l'app pour avoir un lien. En attendant, utilise « code de sauvegarde ».", "err");
    }
  }

  async function copyBackup() {
    const envelope = await persist();
    await copyText(encodeEnvelope(envelope), "syncMsg");
  }

  function maybeImportFromHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const payload = params.get("vault");
    if (!payload) return false;

    try {
      const envelope = parseImportedValue(payload);
      saveEnvelope(envelope);
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    } catch {
      return false;
    }
  }

  $("createVaultBtn").addEventListener("click", createVault);
  $("unlockBtn").addEventListener("click", unlockVault);
  $("unlockPin").addEventListener("keydown", e => {
    if (e.key === "Enter") unlockVault();
  });
  $("importBtn").addEventListener("click", importVaultFromText);

  $("resetLocalBtn").addEventListener("click", () => {
    const ok = confirm("Effacer le coffre de CET appareil ?\n\nTes chats ChatGPT ne seront pas supprimés.");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    showWelcome();
  });

  lockBtn.addEventListener("click", lock);

  addBtn.addEventListener("click", () => {
    addPanel.classList.toggle("hidden");
    setMsg("addMsg", "");
    if (!addPanel.classList.contains("hidden")) setTimeout(() => $("chatLabel").focus(), 0);
  });

  $("cancelAddBtn").addEventListener("click", () => {
    addPanel.classList.add("hidden");
    setMsg("addMsg", "");
  });

  $("saveChatBtn").addEventListener("click", saveChat);
  $("copyPrivateLinkBtn").addEventListener("click", copyPrivateLink);
  $("copyBackupBtn").addEventListener("click", copyBackup);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && unlockedPin) lock();
  });

  window.addEventListener("pagehide", () => {
    unlockedPin = null;
    vaultData = { chats: [] };
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }

  const imported = maybeImportFromHash();
  const envelope = getEnvelope();

  if (envelope) lock();
  else showWelcome();

  if (imported) setMsg("unlockMsg", "Coffre importé sur cet appareil. Entre ton code.", "ok");
})();
