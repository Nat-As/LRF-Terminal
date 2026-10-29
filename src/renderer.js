(() => {
  const BAUD = 115200;
  const MAX_LINES = 10000;
  const SILABS_VID = 0x10c4;

  const $ = id => document.getElementById(id);
  const term = $('term');
  const connectBtn = $('connectBtn');
  const dtrBtn = $('dtrBtn');
  const rtsBtn = $('rtsBtn');
  const isMac = window.lrf.platform === 'darwin';

  let port = null;
  let portLabel = '';
  let choosing = false;
  let reader = null;
  let readLoopDone = null;
  let keepReading = false;
  let writeChain = Promise.resolve();
  let rxBytes = 0, txBytes = 0;

  // Web Serial "asserted" (true) drives the CP2104 pin LOW (signals are active-low).
  // Default: DTR released (RST HIGH), RTS asserted (SWCLK LOW) so the micro runs.
  const DEFAULT_SIGNALS = { dataTerminalReady: false, requestToSend: true };
  const signals = { ...DEFAULT_SIGNALS };

  // ---------- Terminal model ----------
  // Committed lines are DOM nodes; the current line is edited in place so
  // carriage returns and backspaces can overwrite characters.
  let curText = '';
  let curCol = 0;
  let escState = 0;          // 0 = normal, 1 = after ESC, 2 = inside CSI
  let pendingLines = [];
  let renderQueued = false;
  const logLines = [];
  const decoder = new TextDecoder('utf-8');

  const curLineEl = document.createElement('div');
  curLineEl.className = 'line';
  const curTextNode = document.createTextNode('');
  const cursorEl = document.createElement('span');
  cursorEl.className = 'cursor';
  curLineEl.append(curTextNode, cursorEl);
  term.append(curLineEl);

  function putChar(ch) {
    if (curCol >= curText.length) {
      curText += ch;
    } else {
      curText = curText.slice(0, curCol) + ch + curText.slice(curCol + 1);
    }
    curCol++;
  }

  function newLine() {
    pendingLines.push(curText);
    logLines.push(curText);
    if (logLines.length > MAX_LINES) logLines.splice(0, logLines.length - MAX_LINES);
    curText = '';
    curCol = 0;
  }

  function feedText(str) {
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (escState === 1) {
        escState = (ch === '[') ? 2 : 0;
        continue;
      }
      if (escState === 2) {
        if (c >= 0x40 && c <= 0x7e) {
          escState = 0;
          if (ch === 'J') clearTerminal();           // ESC[2J clear screen
          else if (ch === 'K') curText = curText.slice(0, curCol); // erase to end of line
        }
        continue;
      }
      if (c === 0x1b) { escState = 1; continue; }
      if (ch === '\n') { newLine(); continue; }
      if (ch === '\r') { curCol = 0; continue; }
      if (c === 0x08) { if (curCol > 0) curCol--; continue; }
      if (ch === '\t') { do { putChar(' '); } while (curCol % 8); continue; }
      if (c < 0x20 || c === 0x7f) continue;          // drop other control chars
      putChar(ch);
    }
    queueRender();
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function render() {
    renderQueued = false;
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    if (pendingLines.length) {
      const frag = document.createDocumentFragment();
      for (const text of pendingLines) {
        const div = document.createElement('div');
        div.className = 'line';
        div.textContent = text;
        frag.append(div);
      }
      pendingLines = [];
      term.insertBefore(frag, curLineEl);
      let excess = term.childElementCount - 1 - MAX_LINES;
      while (excess-- > 0) term.firstElementChild.remove();
    }
    curTextNode.data = curText;
    if (atBottom) term.scrollTop = term.scrollHeight;
  }

  function clearTerminal() {
    while (term.firstChild !== curLineEl) term.firstChild.remove();
    pendingLines = [];
    logLines.length = 0;
    curText = '';
    curCol = 0;
    queueRender();
  }

  function systemMessage(msg) {
    if (curText.length) newLine();
    feedText(`*** ${msg} ***\n`);
  }

  // ---------- Port picker ----------
  // navigator.serial.requestPort() asks the main process, which sends the
  // port list here; the user's choice goes back through window.lrf.choosePort.
  const picker = $('picker');
  const portListEl = $('portList');
  const pickerConnect = $('pickerConnect');
  let ports = [];
  let selectedId = null;

  // Electron reports USB IDs as decimal strings ("4292" for 0x10C4).
  function usbId(value) {
    if (!value) return null;
    const n = /^0x/i.test(value) ? parseInt(value, 16) : parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }

  function isUsb(p) { return usbId(p.vendorId) != null; }
  function isSilabs(p) { return usbId(p.vendorId) === SILABS_VID; }

  function portTitle(p) { return p.portName || p.displayName || 'Serial port'; }

  function renderPorts() {
    ports.sort((a, b) => (isSilabs(b) - isSilabs(a)) || (isUsb(b) - isUsb(a)) ||
      portTitle(a).localeCompare(portTitle(b), undefined, { numeric: true }));
    const shown = shownPorts();
    if (!shown.some(p => p.portId === selectedId)) {
      selectedId = shown.length ? shown[0].portId : null;
    }
    portListEl.replaceChildren(...shown.map(p => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(p.portId === selectedId));
      li.dataset.portId = p.portId;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = portTitle(p);
      if (isSilabs(p)) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'LRF adapter';
        name.append(badge);
      }

      const detail = document.createElement('div');
      detail.className = 'detail';
      const ids = isUsb(p) ? `USB ${hex4(usbId(p.vendorId))}:${hex4(usbId(p.productId) ?? 0)}` : '';
      detail.textContent = [p.displayName !== portTitle(p) ? p.displayName : '', ids, p.serialNumber && `S/N ${p.serialNumber}`]
        .filter(Boolean).join(' · ') || ' ';

      li.append(name, detail);
      return li;
    }));
    $('portEmpty').hidden = shown.length > 0;
    pickerConnect.disabled = selectedId == null;
  }

  function shownPorts() {
    return $('showAllPorts').checked ? ports : ports.filter(isUsb);
  }

  function openPicker(list) {
    ports = list.slice();
    selectedId = null;
    renderPorts();
    picker.hidden = false;
    portListEl.focus();
  }

  function closePicker(portId) {
    if (picker.hidden) return;
    picker.hidden = true;
    const p = ports.find(x => x.portId === portId);
    portLabel = p ? portTitle(p) : '';
    window.lrf.choosePort(portId || '');
    term.focus();
  }

  function moveSelection(delta) {
    const shown = shownPorts();
    if (!shown.length) return;
    const i = Math.max(0, shown.findIndex(p => p.portId === selectedId));
    selectedId = shown[Math.min(shown.length - 1, Math.max(0, i + delta))].portId;
    renderPorts();
    portListEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  window.lrf.onPortList(openPicker);
  window.lrf.onPortAdded(p => {
    if (picker.hidden || ports.some(x => x.portId === p.portId)) return;
    ports.push(p);
    renderPorts();
  });
  window.lrf.onPortRemoved(p => {
    if (picker.hidden) return;
    ports = ports.filter(x => x.portId !== p.portId);
    renderPorts();
  });

  portListEl.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li) return;
    selectedId = li.dataset.portId;
    renderPorts();
  });
  portListEl.addEventListener('dblclick', e => {
    const li = e.target.closest('li');
    if (li) closePicker(li.dataset.portId);
  });
  picker.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closePicker(''); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter' && selectedId != null && e.target.tagName !== 'BUTTON') { e.preventDefault(); closePicker(selectedId); }
  });
  picker.addEventListener('mousedown', e => { if (e.target === picker) closePicker(''); });
  $('pickerCancel').addEventListener('click', () => closePicker(''));
  $('showAllPorts').addEventListener('change', () => { renderPorts(); portListEl.focus(); });
  pickerConnect.addEventListener('click', () => closePicker(selectedId));

  // ---------- Serial ----------
  function setStatus(connected, text) {
    $('status').textContent = text;
    $('dot').classList.toggle('on', connected);
    connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
    dtrBtn.disabled = rtsBtn.disabled = !connected;
  }

  function renderSignals() {
    for (const [btn, key, name] of [[dtrBtn, 'dataTerminalReady', 'DTR → RST'], [rtsBtn, 'requestToSend', 'RTS → SWCLK']]) {
      const asserted = signals[key];
      btn.classList.toggle('low', asserted);
      btn.classList.toggle('high', !asserted);
      btn.innerHTML = `${name}<small>${asserted ? 'asserted · pin LOW' : 'released · pin HIGH'}</small>`;
      btn.setAttribute('aria-pressed', String(asserted));
    }
  }

  async function applySignals() {
    if (!port) return;
    try {
      await port.setSignals({ ...signals });
      const t = new Date().toISOString().slice(11, 23);
      systemMessage(`${t} DTR→RST ${signals.dataTerminalReady ? 'LOW' : 'HIGH'}, RTS→SWCLK ${signals.requestToSend ? 'LOW' : 'HIGH'}`);
    } catch (e) {
      systemMessage(`Failed to set signals: ${e.message}`);
    }
    renderSignals();
  }

  async function connect() {
    if (choosing) return;
    choosing = true;
    try {
      port = await navigator.serial.requestPort();
    } catch (e) {
      return; // user cancelled the chooser
    } finally {
      choosing = false;
    }
    try {
      await port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536 });
    } catch (e) {
      systemMessage(`Could not open ${portLabel || 'port'}: ${e.message}`);
      port = null;
      return;
    }

    // Opening the port asserts DTR/RTS (pins LOW). Restore the defaults unless the user opted out.
    if ($('applyDefaults').checked) {
      Object.assign(signals, DEFAULT_SIGNALS);
    } else {
      signals.dataTerminalReady = true;
      signals.requestToSend = true;
    }
    await applySignals();

    const info = port.getInfo();
    $('portInfo').textContent = portLabel || (info.usbVendorId != null
      ? `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`
      : 'serial port');
    setStatus(true, `Connected @ ${BAUD}`);
    systemMessage(`Connected to ${portLabel || 'port'} at ${BAUD} 8N1`);
    term.focus();

    keepReading = true;
    readLoopDone = readLoop();
  }

  async function readLoop() {
    while (port && port.readable && keepReading) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) {
            rxBytes += value.length;
            $('rxCount').textContent = rxBytes.toLocaleString();
            feedText(decoder.decode(value, { stream: true }));
          }
        }
      } catch (e) {
        // Framing/parity/break errors are recoverable; a lost device is not.
        if (keepReading) systemMessage(`Read error: ${e.message}`);
      } finally {
        reader.releaseLock();
        reader = null;
      }
    }
  }

  async function disconnect(reason) {
    if (!port) return;
    keepReading = false;
    try { if (reader) await reader.cancel(); } catch (e) {}
    try { await readLoopDone; } catch (e) {}
    try { await writeChain; } catch (e) {}
    try { await port.close(); } catch (e) {}
    port = null;
    setStatus(false, 'Disconnected');
    $('portInfo').textContent = '–';
    systemMessage(reason || 'Disconnected');
  }

  function send(str) {
    if (!port || !port.writable) return;
    const bytes = new TextEncoder().encode(str);
    if ($('echo').checked) feedText(str.replace(/\r\n?/g, '\n'));
    writeChain = writeChain.then(async () => {
      if (!port || !port.writable) return;
      const writer = port.writable.getWriter();
      try {
        await writer.write(bytes);
        txBytes += bytes.length;
        $('txCount').textContent = txBytes.toLocaleString();
      } finally {
        writer.releaseLock();
      }
    }).catch(e => systemMessage(`Write error: ${e.message}`));
  }

  function hex4(n) { return n.toString(16).toUpperCase().padStart(4, '0'); }

  function eol() {
    return $('eol').value.replace('\\r', '\r').replace('\\n', '\n');
  }

  // ---------- Clipboard ----------
  function copySelection() {
    const text = String(window.getSelection());
    if (text) window.lrf.writeClipboard(text);
  }

  async function pasteToPort() {
    const text = await window.lrf.readClipboard();
    if (!text) return;
    if (!port) { systemMessage('Not connected — press Connect first'); return; }
    send(text.replace(/\r\n|\r|\n/g, eol()));
  }

  window.lrf.onPasteRequest(pasteToPort);

  // ---------- Keyboard (Tera Term style: keys go straight to the port) ----------
  const KEYMAP = {
    Backspace: '\x08', Tab: '\t', Escape: '\x1b', Delete: '\x1b[3~',
    ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
    Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  };

  term.addEventListener('keydown', e => {
    if (e.metaKey || e.altKey) return;                         // macOS Cmd shortcuts go to the app menu
    const k = e.key.toLowerCase();
    if (!isMac && e.ctrlKey && (k === 'c' || k === 'v') && (e.shiftKey || k === 'v' || String(window.getSelection()))) {
      e.preventDefault();                                      // Ctrl+Shift+C/V, Ctrl+V, Ctrl+C with a selection
      if (k === 'c') copySelection(); else pasteToPort();
      return;
    }
    if (e.ctrlKey && e.shiftKey) return;

    let out = null;
    if (e.key === 'Enter') out = eol();
    else if (KEYMAP[e.key]) out = KEYMAP[e.key];
    else if (e.ctrlKey && /^[a-z]$/i.test(e.key)) out = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
    else if (!e.ctrlKey && e.key.length === 1) out = e.key;

    if (out !== null) {
      e.preventDefault();
      if (!port) { systemMessage('Not connected — press Connect first'); return; }
      send(out);
    }
  });

  // ---------- UI wiring ----------
  connectBtn.addEventListener('click', () => port ? disconnect() : connect());

  dtrBtn.addEventListener('click', () => {
    signals.dataTerminalReady = !signals.dataTerminalReady;
    applySignals();
    term.focus();
  });
  rtsBtn.addEventListener('click', () => {
    signals.requestToSend = !signals.requestToSend;
    applySignals();
    term.focus();
  });

  $('clearBtn').addEventListener('click', () => { clearTerminal(); term.focus(); });

  $('saveBtn').addEventListener('click', async () => {
    const text = logLines.concat(curText ? [curText] : []).join('\n') + '\n';
    const name = `lrf-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    try {
      const saved = await window.lrf.saveLog(text, name);
      if (saved) systemMessage(`Log saved to ${saved}`);
    } catch (e) {
      systemMessage(`Could not save log: ${e.message}`);
    }
    term.focus();
  });

  let fontSize = 22;
  try { fontSize = Number(localStorage.getItem('termFontSize')) || 22; } catch (e) {}
  function applyFont() {
    term.style.fontSize = fontSize + 'px';
    try { localStorage.setItem('termFontSize', String(fontSize)); } catch (e) {}
  }
  $('fontUp').addEventListener('click', () => { fontSize = Math.min(48, fontSize + 2); applyFont(); });
  $('fontDown').addEventListener('click', () => { fontSize = Math.max(12, fontSize - 2); applyFont(); });
  applyFont();

  $('clipHint').textContent = isMac ? '⌘C / ⌘V' : 'Ctrl+Shift+C / Ctrl+Shift+V';
  renderSignals();

  navigator.serial.addEventListener('disconnect', e => {
    if (port && e.target === port) disconnect('Device unplugged');
  });
  term.focus();
})();
