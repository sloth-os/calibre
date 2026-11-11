/*
 * app.js — UI glue for the calibre WASM PWA (classic script, loaded with defer).
 *
 * Owns: worker boot progress, file intake (#dropzone / #file-input / paste /
 * launchQueue / share-target), the book panel, conversion dispatch, result
 * downloads, install prompt, online/offline pill, version pill. All entry
 * points are feature-detected; browsers without support keep the plain
 * picker behavior.
 *
 * Every URL is RELATIVE — the site must work from any subpath and offline.
 */
(function () {
  'use strict';

  // Extensions the PWA registers for OS file handling; mirrors
 // manifest.webmanifest file_handlers (with the leading dot).
  var EBOOK_EXTS = [
    '.epub', '.kepub', '.mobi', '.azw', '.azw3', '.azw4', '.prc', '.docx',
    '.doc', '.html', '.htm', '.xhtml', '.txt', '.text', '.md', '.markdown',
    '.textile', '.fb2', '.zip', '.fbz', '.htmlz', '.txtz', '.odt', '.rtf',
    '.pml', '.pmlz', '.rb', '.snb', '.tcr', '.pdb', '.opf', '.lit', '.chm',
    '.pdf', '.djvu', '.djv',
  ];

  // Fixed-name cache sw.js stashes share-target files in (never versioned —
  // an unconsumed share must survive a service-worker update).
  var SHARED_CACHE = 'calibre-web-shared';

  var MAX_LOG_LINES = 400;

  // ----------------------------------------------------------------- state --
  var worker = null;
 var workerReady = false;
  var initId = 0;
  var nextId = 1;
  var pending = new Map(); // id -> {resolve, reject, onProgress}
  var book = null;         // {name, size, data: ArrayBuffer, metadata?}
  var availableFormats = { input: [], output: [] };
  var objectUrls = []; // kept alive until Clear
  var deferredInstallPrompt = null;

  // ------------------------------------------------------------- elements --
  var $ = function (id) { return document.getElementById(id); };
  var boot = $('boot'), bootText = $('boot-text'), bootProgress = $('boot-progress');
 var converter = $('converter');
  var dropzone = $('dropzone'), fileInput = $('file-input');
 var bookPanel = $('book-panel'), bookTitle = $('book-title'), bookSub = $('book-sub');
  var bookDetails = $('book-details');
  var mdAuthors = $('md-authors'), mdLanguage = $('md-language'), mdSeries = $('md-series');
  var formatSelect = $('format-select'), convertBtn = $('convert-btn'), clearBtn = $('clear-btn');
  var fmtNote = $('fmt-note');
 var consoleEl = $('console'), downloadsEl = $('downloads'), statusEl = $('status');
  var netStatus = $('net-status'), buildVersion = $('build-version'), installBtn = $('install-btn');

  // ------------------------------------------------------------- helpers --
  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  var logLines = [];
  function logLine(line) {
    logLines.push(String(line));
    if (logLines.length > MAX_LOG_LINES) logLines.shift();
    consoleEl.textContent = logLines.join('\n');
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function humanSize(n) {
    if (n< 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function baseName(name) {
    var s = String(name || 'book');
    var slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (slash >= 0) s = s.slice(slash + 1);
    return s;
  }

  // ------------------------------------------------------------ the worker --
  function bootWorker() {
    // Module worker: pyodide rejects classic workers ('Classic web workers
    // are not supported'); worker.js imports pyodide.mjs dynamically.
    worker = new Worker('./worker.js', { type: 'module' });
    worker.onmessage = function (ev) {
      var msg = ev.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'boot-progress') {
        var labels = {
 pyodide: 'Downloading the Python runtime…',
          bundle: 'Downloading calibre…',
          extract: 'Unpacking calibre…',
          ready: 'Engine ready.',
        };
        bootText.textContent = labels[msg.stage] || msg.stage;
        bootProgress.value = msg.pct || 0;
        if (msg.stage === 'ready') {
          workerReady = true;
          boot.hidden = true;
          converter.hidden = false;
        }
        return;
      }
      if (msg.type === 'progress') {
        if (msg.line) logLine(msg.line);
        return;
      }

      var waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.type === 'error') {
          waiter.reject(new Error(msg.message || 'worker error'));
        } else {
          waiter.resolve(msg);
        }
      }
    };
    worker.onerror = function (e) {
      bootText.textContent = 'The engine failed to start: ' + (e.message || 'unknown error');
      setStatus('Engine failed to start.', 'err');
      (pending.values ? Array.from(pending.values()) : []).forEach(function (w) {
        try { w.reject(new Error('worker crashed')); } catch (e2) { /* already settled */ }
      });
      pending.clear();
    };
    send('init', {}).catch(function (err) {
      bootText.textContent = 'Engine boot failed: ' + err.message;
    });
  }

  function send(type, payload) {
    if (!worker) return Promise.reject(new Error('worker is not running'));
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      var m = { id: id, type: type };
      if (payload) for (var k in payload) m[k] = payload[k];
      worker.postMessage(m);
    });
  }

  // ---------------------------------------------------------------- intake --
  function handleIncomingFiles(files) {
    var list = Array.prototype.filter.call(files, function (f) {
      return f && (typeof f.arrayBuffer === 'function' || typeof f.getFile === 'function');
    });
    if (!list.length) return;
    // Resolve FileSystemFileHandles to Files first.
    Promise.all(list.map(function (f) {
      if (typeof f.getFile === 'function') return f.getFile();
      return f;
    })).then(function (realFiles) {
      var file = realFiles[0];
      if (!file) return;
      book = { name: baseName(file.name), size: file.size, metadata: null };
      logLines = [];
      consoleEl.textContent = '';
      renderBook();
      setStatus('Reading ' + book.name + '…');
      file.arrayBuffer().then(function (buf) {
        book.data = buf;
        setStatus('Loaded ' + humanSize(book.size) + '. Pick a format and Convert.', 'ok');
        convertBtn.disabled = false;
        askMetadata();
      }).catch(function (err) {
        setStatus('Could not read the file: ' + err.message, 'err');
      });
    }).catch(function (err) {
      setStatus('Could not open the launched file(s): ' + err.message, 'err');
    });
  }

  function renderBook() {
    bookPanel.hidden = false;
    bookTitle.textContent = book ? book.name : '—';
    bookSub.textContent = book ? humanSize(book.size) : '—';
    if (book && book.metadata) {
      var md = book.metadata;
      bookDetails.hidden = false;
      mdAuthors.textContent = md.authors && md.authors.length ? md.authors.join(', ') : '—';
      mdLanguage.textContent = md.language || '—';
      mdSeries.textContent = md.series || '—';
      if (md.title && md.title !== book.name) bookTitle.textContent = md.title;
    } else {
      bookDetails.hidden = true;
    }
  }

  function askMetadata() {
    if (!book || !book.data) return;
    send('metadata', { name: book.name, input: book.data }).then(function (msg) {
      if (!book) return;
      book.metadata = msg.metadata;
      renderBook();
    }).catch(function () {
      // Metadata is cosmetic; a failure must not block conversion.
    });
  }

  // ------------------------------------------------------------ conversion --
  function doConvert() {
    if (!book || !book.data) return;
    var fmt = formatSelect.value;
    if (!fmt) return;
    convertBtn.disabled = true;
    clearBtn.disabled = true;
    setStatus('Converting to ' + fmt.toUpperCase() + '…');
    logLine('— converting ' + book.name + ' → ' + fmt.toUpperCase());
    var t0 = performance.now();
    send('convert', {
      name: book.name,
 input: book.data,
      outputFormat: fmt,
    }).then(function (msg) {
      var dt = (performance.now() - t0) / 1000;
 convertBtn.disabled = false;
      clearBtn.disabled = false;
      addDownload(msg.name, msg.data, msg.size);
      setStatus('Converted to ' + fmt.toUpperCase() + ' in ' + dt.toFixed(1) + 's.', 'ok');
      logLine('— done in ' + dt.toFixed(1) + 's (' + humanSize(msg.size) + ')');
    }).catch(function (err) {
      convertBtn.disabled = false;
      clearBtn.disabled = false;
      setStatus('Conversion failed: ' + err.message, 'err');
      logLine('— failed: ' + err.message);
    });
  }

  function addDownload(name, buffer, size) {
    var blob = new Blob([buffer], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    objectUrls.push(url);
    var row = document.createElement('div');
    row.className = 'dl-row';
    var left = document.createElement('span');
    left.className = 'dl-name dl-ok';
    left.textContent = '✓ ' + name;
    var sizeEl = document.createElement('span');
    sizeEl.className = 'dl-size';
    sizeEl.textContent = humanSize(size);
    var a = document.createElement('a');
    a.className = 'btn';
    a.href = url;
    a.download = name;
    a.textContent = 'Save';
    var saveAsBtn = document.createElement('button');
    saveAsBtn.type = 'button';
    saveAsBtn.textContent = 'Save as…';
    saveAsBtn.hidden = true;
    if (typeof window.showSaveFilePicker === 'function') {
      saveAsBtn.hidden = false;
      saveAsBtn.addEventListener('click', function () {
        window.showSaveFilePicker({ suggestedName: name }).then(function (handle) {
          return handle.createWritable().then(function (w) {
            return w.write(blob).then(function () { return w.close(); });
          });
        }).catch(function () { /* user cancelled */ });
      });
    }
    row.appendChild(left);
    row.appendChild(sizeEl);
    row.appendChild(saveAsBtn);
    row.appendChild(a);
    downloadsEl.appendChild(row);
  }

  function clearAll() {
    book = null;
    bookPanel.hidden = true;
    downloadsEl.textContent = '';
    consoleEl.textContent = '';
    logLines = [];
    objectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    objectUrls = [];
    setStatus('');
    if (worker) {
      try { worker.postMessage({ type: 'evict' }); } catch (e) { /* worker gone */ }
    }
  }

  // --------------------------------------------------------------- formats --
  function loadFormats() {
    send('formats', {}).then(function (msg) {
      availableFormats = { input: msg.input || [], output: msg.output || [] };
      renderFormatOptions();
    }).catch(function (err) {
      setStatus('Could not list formats: ' + err.message, 'err');
    });
  }

  function renderFormatOptions() {
    var outs = availableFormats.output;
    // Preferred-first ordering for the dropdown.
    var preferred = ['epub', 'azw3', 'mobi', 'docx', 'txt', 'htmlz', 'rtf', 'fb2'];
    var seen = new Set();
    formatSelect.textContent = '';
    preferred.forEach(function (f) {
      if (outs.indexOf(f) >= 0) { seen.add(f); }
    });
    var ordered = preferred.filter(function (f) { return seen.has(f); })
 .concat(outs.filter(function (f) { return seen.has(f) ? false : (seen.add(f), true); }));
    ordered.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f.toUpperCase();
      formatSelect.appendChild(opt);
    });
    fmtNote.textContent = 'Output: ' + ordered.join(' · ');
    var hintExts = availableFormats.input.map(function (f) { return '.' + f; }).slice(0, 18).join(' ');
    var hint = $('dropzone-hint');
    if (hint) hint.textContent = hintExts + ' …';
  }

  // ------------------------------------------------------- PWA + environment --
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.warn('[calibre-web] service worker registration failed:', err);
      });
    }
  }

  // Desktop "Open with": the OS launches the installed PWA with file handles
  // queued on window.launchQueue (buffered until a consumer registers, so
  // registering at boot cannot miss the launch).
  function setupLaunchQueue() {
    if (!('launchQueue' in window) || !window.launchQueue ||
 typeof window.launchQueue.setConsumer !== 'function') {
      return;
    }
    window.launchQueue.setConsumer(function (params) {
      if (!params || !params.files || !params.files.length) return;
      handleIncomingFiles(params.files);
    });
  }

  // Android share sheet: sw.js stashed the shared files in SHARED_CACHE.
  // Read ALL entries, delete ALL, then process — in that order, so a reload
  // can never ingest a share twice. Never rejects: a broken cache must not
  // break boot.
  function consumeSharedFiles() {
    if (!('caches' in window)) return;
    caches.open(SHARED_CACHE).then(function (cache) {
      return cache.keys().then(function (keys) {
        if (!keys.length) return undefined;
        var fileKeys = keys.filter(function (key) {
          return !new URL(key.url).pathname.endsWith('/__shared/count');
        });
        return Promise.all(fileKeys.map(function (key) {
          return cache.match(key).then(function (resp) {
            return resp.blob().then(function (blob) {
              var name = decodeURIComponent(resp.headers.get('X-File-Name') || '');
              return new File([blob], name || baseName(new URL(key.url).pathname),
 { type: blob.type || '' });
            });
          });
        })).then(function (files) {
          return Promise.all(keys.map(function (key) { return cache.delete(key); }))
            .then(function () { if (files.length) handleIncomingFiles(files); });
 });
      });
    }).catch(function (err) {
      console.warn('[calibre-web] could not consume shared files:', err);
    });
  }

  function updateNetStatus() {
    var online = navigator.onLine !== false;
    netStatus.classList.toggle('online', online);
    netStatus.classList.toggle('offline', !online);
    netStatus.textContent = online ? 'Online' : 'Offline';
  }

  function loadBuildInfo() {
    fetch('./build-info.json').then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function (info) {
 if (!info || !info.version) throw new Error('no version');
      var py = info.pyodide ? ' · pyodide ' + info.pyodide : '';
      buildVersion.textContent = 'calibre ' + info.version + py;
    }).catch(function () {
      buildVersion.textContent = 'local build';
    });
  }

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      deferredInstallPrompt = ev;
 installBtn.hidden = false;
    });
    installBtn.addEventListener('click', function () {
      if (!deferredInstallPrompt) return;
      var promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      installBtn.hidden = true;
      promptEvent.prompt();
      if (promptEvent.userChoice && typeof promptEvent.userChoice.then === 'function') {
        promptEvent.userChoice.catch(function () {});
      }
    });
    window.addEventListener('appinstalled', function () {
      installBtn.hidden = true;
      setStatus('Installed! Use "Open with" on any ebook to convert it.', 'ok');
    });
  }

  // ------------------------------------------------------------- wire-up --
  function setupIntake() {
    dropzone.addEventListener('click', function () { fileInput.click(); });
    dropzone.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      handleIncomingFiles(fileInput.files);
      fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      dropzone.addEventListener(t, function (ev) {
        ev.preventDefault();
        dropzone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      dropzone.addEventListener(t, function (ev) {
        ev.preventDefault();
        dropzone.classList.remove('drag');
      });
    });
    dropzone.addEventListener('drop', function (ev) {
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        handleIncomingFiles(ev.dataTransfer.files);
      }
    });
    window.addEventListener('paste', function (ev) {
      if (ev.clipboardData && ev.clipboardData.files && ev.clipboardData.files.length) {
        handleIncomingFiles(ev.clipboardData.files);
      }
    });
    convertBtn.addEventListener('click', doConvert);
    clearBtn.addEventListener('click', clearAll);
  }

  function setupNetListeners() {
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);
  }

  // ------------------------------------------------------------------ init --
  registerServiceWorker();
  setupLaunchQueue();
  consumeSharedFiles();
  updateNetStatus();
  loadBuildInfo();
  setupInstallPrompt();
  setupIntake();
  setupNetListeners();
  bootWorker();
  loadFormats();
})();
