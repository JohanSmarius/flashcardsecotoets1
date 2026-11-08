(function () {
  "use strict";

  var DATA_URL = "data/begrippen.json";
  var ALL = "__alle__";
  var PROGRESS_KEY = "flashcards.economie.progress.v1";
  var SETTINGS_KEY = "flashcards.economie.settings.v1";

  // Leitner-systeem: box 1 t/m 5. Aantal dagen tot de volgende herhaling per box.
  // Afgestemd op een toets over ongeveer een week: geen enkele termijn is langer dan 3 dagen,
  // zodat elke kaart vóór de toets nog meerdere keren terugkomt.
  var BOX_DAYS = [0, 0, 1, 2, 3, 3];
  var MAX_BOX = 5;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var REQUEUE_OFFSET = 4; // een gemiste kaart komt na ongeveer 4 kaarten terug

  var allCards = [];
  var deck = [];          // bladermodus
  var queue = [];         // slim oefenen
  var index = 0;
  var shuffled = false;
  var mode = "adaptive";
  var busy = false;
  var sessionTotal = 0;
  var sessionDone = 0;
  var storageOk = true;
  var progress = {};      // { sleutel: { b: box, d: volgende-herhaling (ms) } }

  var el = {};
  [
    "deckSelect", "modeSelect", "directionSelect", "shuffleBtn", "shuffleWrap",
    "flashcard", "frontText", "backText", "frontLabel", "backLabel", "counter",
    "paragraphLabel", "progressBar", "prevBtn", "nextBtn", "flipBtn", "flipBtn2",
    "browseControls", "adaptiveControls", "ratingButtons", "againBtn", "knownBtn",
    "cardWrap", "donePanel", "doneText", "practiceAllBtn", "resetBtn",
    "statsBar", "statsLegend", "statsSection", "keyHint", "storageWarning", "errorBox"
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /* ---------- opslag ---------- */

  function readStore(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      var value = raw ? JSON.parse(raw) : fallback;
      // Beschadigde of onverwachte opslag (bijv. "null" of een getal) negeren
      return value && typeof value === "object" ? value : fallback;
    } catch (e) {
      storageOk = false;
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      storageOk = false;
    }
    el.storageWarning.classList.toggle("d-none", storageOk);
  }

  function saveSettings() {
    writeStore(SETTINGS_KEY, {
      deck: el.deckSelect.value,
      direction: el.directionSelect.value,
      mode: mode
    });
  }

  /* ---------- hulpfuncties ---------- */

  function shuffleArray(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function unique(values) {
    return values.filter(function (v, i) { return values.indexOf(v) === i; });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Sleutel op begrip: tekst van een antwoord aanpassen verliest dus geen voortgang.
  function cardKey(c) {
    return c.begrip.trim().toLowerCase();
  }

  function getBox(c) {
    var p = progress[cardKey(c)];
    return p ? p.b : 0; // 0 = nieuw
  }

  function isDue(c) {
    var p = progress[cardKey(c)];
    return !p || p.d <= Date.now();
  }

  function selection() {
    var v = el.deckSelect.value;
    if (v === ALL) { return allCards.slice(); }
    if (v.indexOf("h:") === 0) {
      return allCards.filter(function (c) { return c.hoofdstuk === v.slice(2); });
    }
    return allCards.filter(function (c) { return c.paragraaf === v.slice(2); });
  }

  /* ---------- selectielijst ---------- */

  function buildDeckOptions() {
    var chapters = unique(allCards.map(function (c) { return c.hoofdstuk; }));
    var html = '<option value="' + ALL + '">Alle begrippen (' + allCards.length + ")</option>";

    chapters.forEach(function (chapter) {
      var inChapter = allCards.filter(function (c) { return c.hoofdstuk === chapter; });
      html += '<optgroup label="' + escapeHtml("Hoofdstuk " + chapter) + '">';
      html += '<option value="h:' + escapeHtml(chapter) + '">Heel hoofdstuk ' +
              escapeHtml(chapter.split(" ")[0]) + " (" + inChapter.length + ")</option>";
      unique(inChapter.map(function (c) { return c.paragraaf; })).forEach(function (par) {
        var n = inChapter.filter(function (c) { return c.paragraaf === par; }).length;
        html += '<option value="p:' + escapeHtml(par) + '">' + escapeHtml(par) + " (" + n + ")</option>";
      });
      html += "</optgroup>";
    });
    el.deckSelect.innerHTML = html;
  }

  /* ---------- kaart tonen ---------- */

  function setFlipped(flipped) {
    el.flashcard.classList.toggle("flipped", flipped);
    el.flashcard.setAttribute("aria-pressed", flipped ? "true" : "false");
    if (mode === "adaptive") {
      el.flipBtn2.classList.toggle("d-none", flipped);
      el.ratingButtons.classList.toggle("d-none", !flipped);
    }
  }

  function isFlipped() {
    return el.flashcard.classList.contains("flipped");
  }

  function flip() {
    if (busy) { return; }
    if (mode === "adaptive" && !queue.length) { return; }
    setFlipped(!isFlipped());
  }

  function showFaces(card) {
    var termFirst = el.directionSelect.value === "begrip";
    el.frontText.textContent = termFirst ? card.begrip : card.antwoord;
    el.backText.textContent = termFirst ? card.antwoord : card.begrip;
    el.frontText.classList.toggle("is-term", termFirst);
    el.backText.classList.toggle("is-term", !termFirst);
    el.frontLabel.textContent = termFirst ? "Begrip" : "Omschrijving";
    el.backLabel.textContent = termFirst ? "Omschrijving" : "Begrip";
    el.paragraphLabel.textContent = card.paragraaf;
  }

  function setProgress(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    el.progressBar.style.width = pct + "%";
    el.progressBar.parentElement.setAttribute("aria-valuenow", pct);
  }

  /* ---------- bladermodus ---------- */

  function buildBrowseDeck() {
    var cards = selection();
    deck = shuffled ? shuffleArray(cards) : cards;
    index = 0;
    renderBrowse();
  }

  function renderBrowse() {
    if (!deck.length) { return; }
    showFaces(deck[index]);
    el.counter.textContent = (index + 1) + " / " + deck.length;
    setProgress(index + 1, deck.length);
    el.prevBtn.disabled = index === 0;
    el.nextBtn.disabled = index === deck.length - 1;
  }

  function goBrowse(delta) {
    var next = index + delta;
    if (busy || next < 0 || next >= deck.length) { return; }
    var wasFlipped = isFlipped();
    setFlipped(false);
    if (wasFlipped) {
      busy = true;
      setTimeout(function () { index = next; renderBrowse(); busy = false; }, 250);
    } else {
      index = next;
      renderBrowse();
    }
  }

  /* ---------- slim oefenen ---------- */

  function buildQueue(ignoreDue) {
    var cards = selection().filter(function (c) { return ignoreDue || isDue(c); });
    // Eerst door elkaar, dan op box (laagste eerst). Sort is stabiel in moderne browsers.
    queue = shuffleArray(cards).sort(function (a, b) { return getBox(a) - getBox(b); });
    sessionTotal = queue.length;
    sessionDone = 0;
    renderAdaptive();
  }

  function renderAdaptive() {
    renderStats();
    if (!queue.length) {
      showDone();
      return;
    }
    el.donePanel.classList.add("d-none");
    el.cardWrap.classList.remove("d-none");
    showFaces(queue[0]);
    el.counter.textContent = "Nog " + queue.length + " te gaan";
    setProgress(sessionDone, sessionTotal);
    setFlipped(false);
  }

  function rate(known) {
    if (busy || !queue.length || !isFlipped()) { return; }
    var card = queue.shift();
    var key = cardKey(card);
    var current = progress[key] ? progress[key].b : 0;
    var box;

    if (known) {
      box = Math.min(MAX_BOX, Math.max(1, current) + 1);
      progress[key] = { b: box, d: Date.now() + BOX_DAYS[box] * DAY_MS };
      sessionDone++;
    } else {
      progress[key] = { b: 1, d: Date.now() };
      queue.splice(Math.min(queue.length, REQUEUE_OFFSET), 0, card);
    }
    writeStore(PROGRESS_KEY, progress);

    // Eerst terugdraaien zodat het antwoord van de volgende kaart niet even zichtbaar is.
    busy = true;
    setFlipped(false);
    el.ratingButtons.classList.add("d-none");
    setTimeout(function () { busy = false; renderAdaptive(); }, 250);
  }

  function showDone() {
    el.cardWrap.classList.add("d-none");
    el.donePanel.classList.remove("d-none");

    var cards = selection();
    var now = Date.now();
    var upcoming = cards
      .map(function (c) { return progress[cardKey(c)]; })
      .filter(function (p) { return p && p.d > now; })
      .map(function (p) { return p.d; })
      .sort(function (a, b) { return a - b; });

    var text;
    if (sessionTotal === 0 && !upcoming.length) {
      text = "Er zijn geen kaarten in deze selectie.";
    } else if (sessionTotal === 0) {
      text = "Er staat op dit moment niets meer te herhalen in deze selectie.";
    } else {
      text = "Je hebt " + sessionTotal + (sessionTotal === 1 ? " kaart" : " kaarten") + " doorgewerkt.";
    }
    if (upcoming.length) {
      text += " De volgende herhaling is " + describeDate(upcoming[0]) + ".";
    }
    el.doneText.textContent = text;
  }

  function describeDate(ms) {
    var d = new Date(ms);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    var tomorrow = new Date(today.getTime() + DAY_MS);
    if (sameDay) { return "vandaag"; }
    if (d.toDateString() === tomorrow.toDateString()) { return "morgen"; }
    return "op " + d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
  }

  /* ---------- statistiek ---------- */

  function renderStats() {
    var cards = selection();
    var groups = [
      { label: "Nieuw", color: "#adb5bd", n: 0 },
      { label: "Aan het leren", color: "#ffc107", n: 0 },
      { label: "Gaat goed", color: "#0dcaf0", n: 0 },
      { label: "Beheerst", color: "#198754", n: 0 }
    ];
    cards.forEach(function (c) {
      var b = getBox(c);
      var g = b === 0 ? 0 : b <= 2 ? 1 : b <= 4 ? 2 : 3;
      groups[g].n++;
    });

    var total = cards.length || 1;
    el.statsBar.innerHTML = groups.map(function (g) {
      return '<div class="progress-bar" style="width:' + (g.n / total * 100) +
             "%;background-color:" + g.color + '"></div>';
    }).join("");
    el.statsLegend.innerHTML = groups.map(function (g) {
      return '<span class="stats-legend-item" style="--dot:' + g.color + '">' +
             g.label + " " + g.n + "</span>";
    }).join("");
  }

  /* ---------- modus en weergave ---------- */

  function applyMode() {
    var adaptive = mode === "adaptive";
    el.browseControls.classList.toggle("d-none", adaptive);
    el.adaptiveControls.classList.toggle("d-none", !adaptive);
    el.shuffleWrap.classList.toggle("d-none", adaptive);
    el.statsSection.classList.toggle("d-none", !adaptive);
    el.keyHint.textContent = adaptive
      ? "Sneltoetsen: spatiebalk = antwoord tonen, pijltje links = nog niet, pijltje rechts = weet ik"
      : "Sneltoetsen: spatiebalk = omdraaien, pijltjes links/rechts = vorige/volgende";
    el.donePanel.classList.add("d-none");
    el.cardWrap.classList.remove("d-none");
    busy = false;
    setFlipped(false);
    if (adaptive) { buildQueue(false); } else { buildBrowseDeck(); }
  }

  function toggleShuffle() {
    shuffled = !shuffled;
    el.shuffleBtn.classList.toggle("btn-primary", shuffled);
    el.shuffleBtn.classList.toggle("btn-outline-primary", !shuffled);
    el.shuffleBtn.setAttribute("aria-pressed", shuffled ? "true" : "false");
    setFlipped(false);
    buildBrowseDeck();
  }

  function onDeckOrDirectionChange(rebuild) {
    saveSettings();
    busy = false;
    setFlipped(false);
    if (mode === "adaptive") {
      if (rebuild) { buildQueue(false); } else { renderAdaptive(); }
    } else {
      if (rebuild) { buildBrowseDeck(); } else { renderBrowse(); }
    }
  }

  function resetProgress() {
    if (!window.confirm("Weet je zeker dat je alle voortgang wilt wissen?")) { return; }
    progress = {};
    writeStore(PROGRESS_KEY, progress);
    applyMode();
  }

  /* ---------- events ---------- */

  function bindEvents() {
    el.flashcard.addEventListener("click", flip);
    el.flipBtn.addEventListener("click", flip);
    el.flipBtn2.addEventListener("click", flip);
    el.prevBtn.addEventListener("click", function () { goBrowse(-1); });
    el.nextBtn.addEventListener("click", function () { goBrowse(1); });
    el.againBtn.addEventListener("click", function () { rate(false); });
    el.knownBtn.addEventListener("click", function () { rate(true); });
    el.shuffleBtn.addEventListener("click", toggleShuffle);
    el.practiceAllBtn.addEventListener("click", function () { buildQueue(true); });
    el.resetBtn.addEventListener("click", resetProgress);

    el.deckSelect.addEventListener("change", function () { onDeckOrDirectionChange(true); });
    el.directionSelect.addEventListener("change", function () { onDeckOrDirectionChange(false); });
    el.modeSelect.addEventListener("change", function () {
      mode = el.modeSelect.value;
      saveSettings();
      applyMode();
    });

    document.addEventListener("keydown", function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "select" || tag === "button") { return; }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        flip();
      } else if (e.key === "ArrowRight") {
        if (mode === "adaptive") { rate(true); } else { goBrowse(1); }
      } else if (e.key === "ArrowLeft") {
        if (mode === "adaptive") { rate(false); } else { goBrowse(-1); }
      }
    });
  }

  function showError(msg) {
    el.errorBox.textContent = msg;
    el.errorBox.classList.remove("d-none");
  }

  /* ---------- start ---------- */

  function init(data) {
    allCards = data;
    progress = readStore(PROGRESS_KEY, {});
    var settings = readStore(SETTINGS_KEY, {});

    buildDeckOptions();
    if (settings.deck && el.deckSelect.querySelector('option[value="' + settings.deck.replace(/"/g, '\\"') + '"]')) {
      el.deckSelect.value = settings.deck;
    }
    if (settings.direction === "begrip" || settings.direction === "antwoord") {
      el.directionSelect.value = settings.direction;
    }
    if (settings.mode === "adaptive" || settings.mode === "browse") {
      mode = settings.mode;
    }
    el.modeSelect.value = mode;
    el.storageWarning.classList.toggle("d-none", storageOk);

    bindEvents();
    applyMode();
  }

  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    })
    .then(init)
    .catch(function (err) {
      showError("De begrippen konden niet worden geladen (" + err.message + "). " +
        "Open de site via een webserver of Azure Static Web Apps; direct openen vanaf het bestandssysteem werkt niet.");
    });
})();
