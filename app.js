/* ================================================================
   Vexora Share — app.js
   Full implementation: PIN peer IDs, file transfer, recent devices
   ================================================================ */

'use strict';

// ── DOM References ─────────────────────────────────────────────────
const pinDisplay        = document.getElementById('pinDisplay');
const copyPinBtn        = document.getElementById('copyPinBtn');
const receiverPinInput  = document.getElementById('receiverPinInput');
const connectBtn        = document.getElementById('connectBtn');
const sendFileBtn       = document.getElementById('sendFileBtn');
const fileInput         = document.getElementById('fileInput');
const fileDropZone      = document.getElementById('fileDropZone');
const fileInfo          = document.getElementById('fileInfo');
const fileName          = document.getElementById('fileName');
const fileSize          = document.getElementById('fileSize');
const clearFileBtn      = document.getElementById('clearFileBtn');
const progressWrapper   = document.getElementById('progressWrapper');
const progressBar       = document.getElementById('progressBar');
const progressPercent   = document.getElementById('progressPercent');
const progressLabel     = document.getElementById('progressLabel');
const statusLog         = document.getElementById('statusLog');
const clearLogBtn       = document.getElementById('clearLogBtn');
const badgeDot          = document.getElementById('badgeDot');
const badgeLabel        = document.getElementById('badgeLabel');
const recentSection     = document.getElementById('recentSection');
const recentList        = document.getElementById('recentList');
const clearRecentBtn    = document.getElementById('clearRecentBtn');
const toastEl           = document.getElementById('toast');

// ── App State ──────────────────────────────────────────────────────
let peer         = null;   // PeerJS instance
let conn         = null;   // Active DataConnection
let selectedFile = null;   // Chosen File object
let isSending    = false;  // Guard against concurrent sends

// ── Receiver-side reassembly state ─────────────────────────────────
let incomingMeta   = null; // { name, mimeType, size }
let receivedChunks = [];   // ArrayBuffer array
let receivedBytes  = 0;    // Running byte total

// ── Constants ──────────────────────────────────────────────────────
const CHUNK_SIZE         = 64 * 1024;       // 64 KB per chunk
const RECENT_KEY         = 'vexora_recent'; // localStorage key
const MAX_RECENT_DEVICES = 8;               // cap saved devices

// ══════════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════════

/**
 * Generates a random 5-digit numeric PIN (10000–99999).
 * @returns {string}
 */
function generatePin() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

/**
 * Renders the PIN as individual styled digit tiles.
 * @param {string} pin
 */
function renderPin(pin) {
  pinDisplay.innerHTML = '';
  for (const digit of pin) {
    const tile = document.createElement('span');
    tile.className = 'pin-digit';
    tile.textContent = digit;
    pinDisplay.appendChild(tile);
  }
}

/**
 * Returns a human-readable file size string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k     = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Sanitises a string for safe innerHTML insertion.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Yields to the browser event loop (keeps UI responsive during sends).
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Wraps FileReader.readAsArrayBuffer in a Promise.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e  => resolve(e.target.result);
    reader.onerror = () => reject(new Error(`FileReader failed for "${file.name}".`));
    reader.readAsArrayBuffer(file);
  });
}

// ══════════════════════════════════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════════════════════════════════

/**
 * Appends a timestamped entry to the on-screen activity log.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'} type
 */
function log(message, type = 'info') {
  // Remove placeholder on first real entry
  const placeholder = statusLog.querySelector('p.italic');
  if (placeholder) placeholder.remove();

  const colorMap = {
    info:    'text-gray-400',
    success: 'text-emerald-400',
    error:   'text-red-400',
    warn:    'text-yellow-400',
  };

  const time  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('p');
  entry.className = `${colorMap[type] ?? colorMap.info} leading-relaxed`;
  entry.innerHTML = `<span class="text-gray-700 select-none">[${time}]</span> ${escapeHtml(message)}`;

  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════

let toastTimer = null;

/**
 * Shows a brief animated toast notification at the bottom of the screen.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} durationMs
 */
function showToast(message, type = 'success', durationMs = 3000) {
  if (toastTimer) clearTimeout(toastTimer);
  toastEl.innerHTML = '';

  const iconMap = {
    success: `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
    error:   `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-red-400 shrink-0"     fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
    info:    `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-sky-400 shrink-0"     fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01"/></svg>`,
  };

  const inner = document.createElement('div');
  inner.className = 'toast-inner animate-toast-in';
  inner.innerHTML = `${iconMap[type] ?? iconMap.info}<span>${escapeHtml(message)}</span>`;
  toastEl.appendChild(inner);

  toastTimer = setTimeout(() => {
    inner.style.animation = 'toast-out 0.3s ease-in forwards';
    setTimeout(() => { toastEl.innerHTML = ''; }, 350);
  }, durationMs);
}

// ══════════════════════════════════════════════════════════════════
//  CONNECTION BADGE
// ══════════════════════════════════════════════════════════════════

/**
 * @param {'initializing'|'ready'|'connected'|'error'} state
 */
function setBadge(state) {
  const dotClasses = {
    initializing: 'bg-yellow-400 animate-pulse',
    ready:        'bg-blue-400',
    connected:    'bg-emerald-400',
    error:        'bg-red-500 animate-pulse',
  };
  const labels = {
    initializing: 'Initializing',
    ready:        'Ready',
    connected:    'Connected',
    error:        'Error',
  };

  badgeDot.className   = `w-2 h-2 rounded-full ${dotClasses[state] ?? dotClasses.initializing}`;
  badgeLabel.textContent = labels[state] ?? state;
}

// ══════════════════════════════════════════════════════════════════
//  RECENT DEVICES  (localStorage)
// ══════════════════════════════════════════════════════════════════

/**
 * Returns the list of saved recent device PINs from localStorage.
 * @returns {string[]}
 */
function getRecentDevices() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Saves a peer PIN to the recent devices list and refreshes the UI.
 * Deduplicates and caps at MAX_RECENT_DEVICES entries (most-recent first).
 * @param {string} pin
 */
function saveRecentDevice(pin) {
  const existing = getRecentDevices().filter(p => p !== pin); // remove if already present
  const updated  = [pin, ...existing].slice(0, MAX_RECENT_DEVICES);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch {
    /* Ignore storage errors (e.g. private mode quota) */
  }
  renderRecentDevices();
}

/**
 * Clears all saved recent devices and refreshes the UI.
 */
function clearRecentDevices() {
  localStorage.removeItem(RECENT_KEY);
  renderRecentDevices();
}

/**
 * Renders the Recent Devices section from localStorage.
 * Shows the section when there are entries, hides it when empty.
 */
function renderRecentDevices() {
  const devices = getRecentDevices();

  if (devices.length === 0) {
    recentSection.classList.add('hidden');
    return;
  }

  recentSection.classList.remove('hidden');
  recentList.innerHTML = '';

  devices.forEach(pin => {
    const pill = document.createElement('button');
    pill.className = 'device-pill';
    pill.setAttribute('title', `Connect to PIN ${pin}`);
    pill.setAttribute('aria-label', `Connect to recent device with PIN ${pin}`);
    pill.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="pill-icon w-3 h-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      ${escapeHtml(pin)}
    `;

    pill.addEventListener('click', () => {
      receiverPinInput.value = pin;
      receiverPinInput.focus();
      // Automatically attempt to connect
      connectBtn.click();
    });

    recentList.appendChild(pill);
  });
}

// ══════════════════════════════════════════════════════════════════
//  PEER INITIALISATION
// ══════════════════════════════════════════════════════════════════

/**
 * Generates a short PIN, creates the PeerJS instance with it,
 * and wires all signalling-level event handlers.
 */
function initPeer() {
  log('Connecting to signalling server…', 'info');
  setBadge('initializing');

  const myPin = generatePin();

  // Use the 5-digit PIN as the PeerJS peer ID
  peer = new Peer(myPin, {
    debug: 0, // 0 = silent in production
  });

  // ── open: successfully registered with PeerServer ─────────────
  peer.on('open', id => {
    renderPin(id);
    setBadge('ready');
    log(`✓ Your PIN is ready: ${id}`, 'success');
    log('Share your PIN with someone, or enter their PIN to connect.', 'info');
  });

  // ── connection: someone is calling us ─────────────────────────
  peer.on('connection', incomingConn => {
    log(`📲 Incoming connection from PIN ${incomingConn.peer}`, 'warn');
    handleConnection(incomingConn);
  });

  // ── error: PeerJS-level errors ────────────────────────────────
  peer.on('error', err => {
    console.error('[Vexora]', err);
    setBadge('error');

    const friendly = {
      'peer-unavailable':  'PIN not found. Check the number and try again.',
      'network':           'Network error. Check your internet connection.',
      'server-error':      'Signalling server error. Please refresh.',
      'socket-error':      'WebSocket error. Please refresh.',
      'socket-closed':     'Server connection closed. Please refresh.',
      'unavailable-id':    'This PIN is already in use — generating a new one…',
      'invalid-id':        'Invalid PIN format.',
      'ssl-unavailable':   'SSL not available on this server.',
      'disconnected':      'Disconnected from server.',
    };

    const msg = friendly[err.type] ?? `Error (${err.type}): ${err.message}`;
    log(msg, 'error');
    showToast(msg, 'error', 4000);

    // If the chosen PIN is taken, auto-retry with a new one
    if (err.type === 'unavailable-id') {
      setTimeout(() => {
        peer.destroy();
        initPeer();
      }, 1500);
    }
  });

  // ── disconnected: lost contact with signalling server ─────────
  peer.on('disconnected', () => {
    setBadge('error');
    log('Lost connection to signalling server. Reconnecting…', 'warn');
    if (!peer.destroyed) peer.reconnect();
  });

  // ── close: peer fully destroyed ───────────────────────────────
  peer.on('close', () => {
    setBadge('error');
    log('Peer session ended.', 'error');
  });
}

// ══════════════════════════════════════════════════════════════════
//  CONNECTION HANDLER
// ══════════════════════════════════════════════════════════════════

/**
 * Wires events for an established DataConnection (both directions).
 * @param {import('peerjs').DataConnection} dataConn
 */
function handleConnection(dataConn) {
  conn = dataConn;

  // ── open: DataChannel is ready to carry data ───────────────────
  conn.on('open', () => {
    setBadge('connected');
    log(`✓ Connected to PIN: ${conn.peer}`, 'success');
    log('Connection established. You can now send a file.', 'info');
    showToast(`Connected to PIN ${conn.peer}`, 'success');

    // Save this device to recent list
    saveRecentDevice(conn.peer);

    // Enable Send if a file is queued
    if (selectedFile) sendFileBtn.disabled = false;

    // Lock the Connect button while a session is open
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connected';
  });

  // ── data: incoming packets from the remote peer ────────────────
  conn.on('data', data => handleIncomingData(data));

  // ── close: remote side hung up ─────────────────────────────────
  conn.on('close', () => {
    setBadge('ready');
    log(`Connection with PIN ${conn.peer} closed.`, 'warn');
    showToast(`Disconnected from PIN ${conn.peer}`, 'info');
    resetConnectionState();
  });

  // ── error: channel-level error ─────────────────────────────────
  conn.on('error', err => {
    setBadge('error');
    log(`Connection error: ${err.message}`, 'error');
    showToast('Connection error — see log.', 'error');
    resetConnectionState();
  });
}

/**
 * Resets state and UI after a connection ends.
 */
function resetConnectionState() {
  conn = null;
  sendFileBtn.disabled = true;

  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect';

  hideProgressBar();

  // Reset receiver state
  incomingMeta   = null;
  receivedChunks = [];
  receivedBytes  = 0;
}

// ══════════════════════════════════════════════════════════════════
//  INCOMING DATA HANDLER  (receiver side)
// ══════════════════════════════════════════════════════════════════

/**
 * Routes incoming packets by type:
 *   file-meta  → stores metadata, shows progress bar
 *   ArrayBuffer/Uint8Array/Blob → buffers the chunk, updates progress
 *   eof        → assembles Blob, triggers auto-download
 *
 * @param {object|ArrayBuffer|Uint8Array|Blob} data
 */
function handleIncomingData(data) {

  // ── 1. Metadata packet ────────────────────────────────────────
  if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) && !(data instanceof Blob) && data.type === 'file-meta') {
    incomingMeta   = { name: data.name, mimeType: data.mimeType, size: data.size };
    receivedChunks = [];
    receivedBytes  = 0;

    showProgressBar('Receiving…');
    log(`⬇ Incoming: "${data.name}" (${formatBytes(data.size)})`, 'info');
    return;
  }

  // ── 2. Binary chunk (ArrayBuffer, Uint8Array, or Blob) ────────
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
    if (!incomingMeta) {
      log('Received chunk before metadata — ignoring orphaned packet.', 'warn');
      return;
    }

    // byteLength works for ArrayBuffer/TypedArray, size works for Blob
    const chunkSize = data.byteLength !== undefined ? data.byteLength : (data.size || 0);
    
    receivedChunks.push(data);
    receivedBytes += chunkSize;

    // Avoid 0/0 division NaN issue for 0-byte files
    const pct = incomingMeta.size === 0 ? 100 : Math.min(100, Math.round((receivedBytes / incomingMeta.size) * 100));
    updateProgressBar(pct, 'Receiving…');
    return;
  }

  // ── 3. EOF sentinel ───────────────────────────────────────────
  if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) && !(data instanceof Blob) && data.type === 'eof') {
    // Only fail if there are no chunks AND the file size was larger than 0
    if (!incomingMeta || (receivedChunks.length === 0 && incomingMeta.size > 0)) {
      log('Received EOF signal but no data was buffered.', 'warn');
      return;
    }

    const savedName = incomingMeta.name;
    const savedMime = incomingMeta.mimeType || 'application/octet-stream';

    log(`✓ Transfer complete. Assembling "${savedName}"…`, 'success');

    // ── Merge chunks → Blob → Object URL → hidden <a> click ────
    const blob   = new Blob(receivedChunks, { type: savedMime });
    const url    = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href          = url;
    anchor.download      = savedName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();

    // Clean up the object URL after the browser has had time to start the download
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 10_000);

    log(`✅ File downloaded! "${savedName}" saved to your Downloads folder.`, 'success');
    showToast(`File downloaded! "${savedName}"`, 'success', 4000);

    // Reset progress + receiver state
    updateProgressBar(100, 'Downloaded!');
    setTimeout(() => hideProgressBar(), 2500);

    incomingMeta   = null;
    receivedChunks = [];
    receivedBytes  = 0;
    return;
  }

  // Unknown packet type
  console.warn('[Vexora] Unrecognised packet:', data);
}

// ══════════════════════════════════════════════════════════════════
//  PROGRESS BAR HELPERS
// ══════════════════════════════════════════════════════════════════

function showProgressBar(label = 'Transferring…') {
  progressWrapper.classList.remove('hidden');
  progressBar.style.width       = '0%';
  progressPercent.textContent   = '0%';
  progressLabel.textContent     = label;
}

function updateProgressBar(pct, label) {
  progressBar.style.width     = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  if (label) progressLabel.textContent = label;
}

function hideProgressBar() {
  progressWrapper.classList.add('hidden');
  progressBar.style.width     = '0%';
  progressPercent.textContent = '0%';
}

// ══════════════════════════════════════════════════════════════════
//  FILE SENDING
// ══════════════════════════════════════════════════════════════════

/**
 * Reads a File as ArrayBuffer then streams it in 64 KB chunks:
 *   1. Send { type:'file-meta', name, mimeType, size }
 *   2. Send each ArrayBuffer chunk sequentially
 *   3. Send { type:'eof' } sentinel
 *
 * @param {File} file
 * @param {import('peerjs').DataConnection} connection
 */
async function sendFile(file, connection) {
  if (isSending) {
    log('A transfer is already in progress.', 'warn');
    return;
  }
  if (!connection?.open) {
    log('Connection is not open. Cannot send file.', 'error');
    return;
  }

  isSending = true;
  sendFileBtn.disabled    = true;
  sendFileBtn.textContent = 'Sending…';

  showProgressBar('Sending…');
  log(`⬆ Sending: "${file.name}" (${formatBytes(file.size)})`, 'info');

  try {
    // Phase 1 — read
    const arrayBuffer = await readFileAsArrayBuffer(file);

    // Phase 2 — metadata header
    connection.send({
      type:     'file-meta',
      name:     file.name,
      mimeType: file.type || 'application/octet-stream',
      size:     file.size,
    });
    log(`Metadata sent (type: ${file.type || 'application/octet-stream'}).`, 'info');

    // Phase 3 — chunked data
    const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
    let sentBytes = 0;

    if (totalChunks > 0) {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end   = Math.min(start + CHUNK_SIZE, arrayBuffer.byteLength);
        const chunk = arrayBuffer.slice(start, end);

        connection.send(chunk);
        sentBytes += chunk.byteLength;

        const pct = Math.min(100, Math.round((sentBytes / file.size) * 100));
        updateProgressBar(pct, 'Sending…');

        // Yield every ~1 MB to keep the UI and WebRTC buffer healthy
        if ((i + 1) % 16 === 0) await yieldToEventLoop();
      }
    } else {
      // Handle zero-byte files (No chunks will be sent, only metadata & EOF)
      updateProgressBar(100, 'Sending…');
    }

    // Phase 4 — EOF sentinel
    connection.send({ type: 'eof' });

    const chunkWord = totalChunks === 1 ? 'chunk' : 'chunks';
    log(`✓ File sent completely: "${file.name}" (${totalChunks} ${chunkWord}).`, 'success');
    showToast(`"${file.name}" sent!`, 'success');

    updateProgressBar(100, 'Sent!');
    setTimeout(() => hideProgressBar(), 2500);

  } catch (err) {
    log(`Send failed: ${err.message}`, 'error');
    showToast('Send failed — see log.', 'error');
    console.error('[Vexora] sendFile error:', err);
    hideProgressBar();
  } finally {
    isSending               = false;
    sendFileBtn.disabled    = !selectedFile || !conn?.open;
    sendFileBtn.textContent = 'Send File';
  }
}

// ══════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════

// ── Connect button ────────────────────────────────────────────────
connectBtn.addEventListener('click', () => {
  const targetPin = receiverPinInput.value.trim();

  if (!/^\d{5}$/.test(targetPin)) {
    log('Please enter a valid 5-digit PIN.', 'warn');
    receiverPinInput.focus();
    return;
  }
  if (!peer || peer.disconnected || peer.destroyed) {
    log('Still connecting to the server — please wait a moment.', 'warn');
    return;
  }
  if (conn?.open) {
    log('Already connected. Close this session before starting a new one.', 'warn');
    return;
  }
  if (targetPin === peer.id) {
    log('You cannot connect to your own PIN.', 'warn');
    return;
  }

  log(`Dialling PIN ${targetPin}…`, 'info');

  const outgoingConn = peer.connect(targetPin, {
    reliable:      true,
    serialization: 'binary',
  });

  handleConnection(outgoingConn);
});

// Enter key in the PIN input triggers connect
receiverPinInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') connectBtn.click();
});

// Only allow numeric digits in the PIN field
receiverPinInput.addEventListener('input', () => {
  receiverPinInput.value = receiverPinInput.value.replace(/\D/g, '').slice(0, 5);
});

// ── Copy PIN button ───────────────────────────────────────────────
copyPinBtn.addEventListener('click', async () => {
  if (!peer?.id) return;
  try {
    await navigator.clipboard.writeText(peer.id);
    showToast('PIN copied to clipboard!', 'success');
    log('PIN copied to clipboard.', 'success');
  } catch {
    log('Could not access clipboard — please copy the PIN manually.', 'warn');
  }
});

// ── File selection (click) ────────────────────────────────────────
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleFileSelected(file);
});

// ── Drag & drop ───────────────────────────────────────────────────
fileDropZone.addEventListener('dragover', e => {
  e.preventDefault();
  fileDropZone.classList.add('drag-over');
});

fileDropZone.addEventListener('dragleave', () => {
  fileDropZone.classList.remove('drag-over');
});

fileDropZone.addEventListener('drop', e => {
  e.preventDefault();
  fileDropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    handleFileSelected(file);
  }
});

/**
 * Updates state and UI when the user selects a file.
 * @param {File} file
 */
function handleFileSelected(file) {
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileInfo.classList.remove('hidden');
  fileInfo.classList.add('flex');
  if (conn?.open) sendFileBtn.disabled = false;
  log(`File selected: "${file.name}" (${formatBytes(file.size)})`, 'info');
}

// ── Clear file button ─────────────────────────────────────────────
clearFileBtn.addEventListener('click', () => {
  selectedFile         = null;
  fileInput.value      = '';
  sendFileBtn.disabled = true;
  fileInfo.classList.add('hidden');
  fileInfo.classList.remove('flex');
  log('File selection cleared.', 'info');
});

// ── Send file button ──────────────────────────────────────────────
sendFileBtn.addEventListener('click', () => {
  if (!selectedFile)   { log('No file selected.', 'warn'); return; }
  if (!conn?.open)     { log('No active connection.', 'warn'); return; }
  if (isSending)       { log('Transfer already in progress.', 'warn'); return; }
  sendFile(selectedFile, conn);
});

// ── Clear log button ──────────────────────────────────────────────
clearLogBtn.addEventListener('click', () => {
  statusLog.innerHTML = '<p class="text-gray-600 italic">Log cleared.</p>';
});

// ── Clear recent devices button ───────────────────────────────────
clearRecentBtn.addEventListener('click', () => {
  clearRecentDevices();
  log('Recent devices cleared.', 'info');
});

// ══════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════════════════════════

// Render saved recent devices from last session
renderRecentDevices();

// Start the PeerJS session
initPeer();
