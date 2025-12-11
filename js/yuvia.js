(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));
  const todayLocal = new Date();
  todayLocal.setHours(0, 0, 0, 0);
  const API_BASE = "https://yuvia-flights-api.yuviabot.workers.dev";
  const API_SEARCH_PATH = "/api/search";
  const API_MATRIX_PATH = "/api/matrix";
  const AVIA_BASE_URL = "https://www.aviasales.ru";
  const DICTS_STORAGE_KEY = "yuviaDicts";
  const DEFAULT_DICT_TTL_SECONDS = 3600;

  let AIRLINE_NAMES = {};
  let AIRPORT_NAMES = {};
  let CITY_NAMES = {};
  let DICTS_LOADING = false;
  let DICTS_ERROR = null;

  function applyDicts(dicts = {}) {
    AIRLINE_NAMES = dicts.airlines || {};
    AIRPORT_NAMES = dicts.airports || {};
    CITY_NAMES = dicts.cities || {};
  }

  function persistDicts(dicts, ttlSeconds) {
    if (!dicts || typeof localStorage === "undefined") return;
    const ttl = Number(ttlSeconds);
    const safeTtl =
      Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_DICT_TTL_SECONDS;
    const expireAt = Date.now() + safeTtl * 1000;
    const payload = { data: dicts, expireAt };
    try {
      localStorage.setItem(DICTS_STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn("[Yuvia] Failed to persist dictionaries", error);
    }
  }

  function getStoredDicts({ allowExpired = false } = {}) {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(DICTS_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.data) return null;
      if (!allowExpired && parsed.expireAt && Date.now() > parsed.expireAt)
        return null;
      return parsed;
    } catch (error) {
      console.warn("[Yuvia] Failed to parse cached dictionaries", error);
      return null;
    }
  }

  function getCityName(code) {
    if (!code) return "";
    const upper = String(code).toUpperCase();
    return CITY_NAMES[upper] || AIRPORT_NAMES[upper] || upper;
  }

  function getAirportName(code) {
    if (!code) return "";
    const upper = String(code).toUpperCase();
    return AIRPORT_NAMES[upper] || upper;
  }

  function getAirlineName(code) {
    if (!code) return "";
    const upper = String(code).toUpperCase();
    return AIRLINE_NAMES[upper] || upper;
  }

  async function loadDicts() {
    DICTS_LOADING = true;
    DICTS_ERROR = null;

    // 1) Берём любые словари из localStorage (даже "протухшие") и сразу их применяем,
    //    чтобы хоть что-то показать пользователю.
    const cached = getStoredDicts({ allowExpired: true });
    if (cached?.data) {
      applyDicts(cached.data);
    }

    // Используем те же данные как "stale" на случай, если сеть упадёт
    const stale = cached;

    try {
      // 2) ВСЕГДА ходим в настоящий API воркера и просим свежие словари
      const resp = await fetch(API_BASE + "/api/dicts?refresh=1");
      if (!resp.ok) {
        throw new Error("Failed to load dicts: " + resp.status);
      }
      const payload = await resp.json();
      const dicts = payload?.data || {};
      applyDicts(dicts);
      persistDicts(dicts, dicts.ttlSeconds);
    } catch (error) {
      console.error("[Yuvia] Failed to load dictionaries", error);
      DICTS_ERROR = error?.message || "Dicts load error";
      if (stale?.data) {
        applyDicts(stale.data);
      }
    }

    DICTS_LOADING = false;
  }

  function formatAirport(code) {
    if (!code) return "";
    const upper = code.toUpperCase();
    const name = getAirportName(upper);
    return name ? `${name} (${upper})` : upper;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resolveAirlineName(code, primaryName = "", fallbackName = "") {
    const upper = String(code || "").toUpperCase();
    if (primaryName) return primaryName;
    if (AIRLINE_NAMES[upper]) return AIRLINE_NAMES[upper];
    if (fallbackName) return fallbackName;
    return upper;
  }

  let originIATA = "";
  let destIATA = "";
  let allResults = [];
  let filteredResults = [];
  let matrixData = [];
  let currentTopFlights = [];
  let currentCompareFlights = [];
  let lastCurrency = "RUB";
  let lastSearchContext = null;
  let hasSearched = false;
  let lastSearchSuccess = false;
  let currentInlineTarget = null;
  let inlineSnapshot = null;
  let compareDirection = "outbound";

  const TOOLTIP_TEXTS = {
    routeScore:
      "Оценка маршрута — это ориентировочная интегральная оценка, которая учитывает длительность поездки, количество пересадок, ночные перелёты и время ожидания между рейсами. Чем выше оценка, тем в среднем более комфортным и удобным выглядит маршрут для большинства путешественников. Это не персональная рекомендация, а мягкая подсказка, которая помогает сравнивать варианты между собой.",
    stressLevel:
      "Уровень стресса — приблизительная оценка того, насколько поездка может быть утомительной с учётом количества пересадок, длительных стыковок, ночных вылетов и ранних прилётов. Более низкий уровень стресса означает, что маршрут, как правило, воспринимается как более мягкий и щадящий. Эта оценка ориентировочная и не учитывает индивидуальные особенности и предпочтения путешественника.",
  };

  const paxState = {
    adults: 1,
    children: 0,
    infants: 0,
    cabin: "eco",
  };

  const tripState = {
    style: null,
    triggers: {
      no_night_dep: false,
      direct_only: false,
      no_overnight: false,
      no_early_dep: false,
    },
  };
  const favoritesIds = new Set(
    JSON.parse(localStorage.getItem("favoritesIds") || "[]").filter(Boolean),
  );
  const compareIds = new Set(
    JSON.parse(localStorage.getItem("compareIds") || "[]").filter(Boolean),
  );

  const suggestCache = new Map();
  const recentKey = "yuviaRecentSearches";
  const conciergeSubtitle =
    "Я учёл твой стиль поездки и ограничения по рейсам, убрал ночные и перегруженные стыковки. В этом блоке — варианты, с которых обычно удобно начинать выбор.";

  const originInput = $("#origin") || $("#inlineOrigin");
  const destinationInput = $("#destination") || $("#inlineDestination");
  const departInput = $("#depart") || $("#inlineDepart");
  const returnInput = $("#ret") || $("#inlineRet");
  const searchSummary = $("#searchSummary");
  const searchSummaryAction = $("#searchSummaryAction");
  const searchOverlay = $("#searchOverlay");
  const searchOverlayCard =
    searchOverlay?.querySelector?.(".search-overlay-card") || null;
  const searchOverlayTitle = $("#searchOverlayTitle");
  const searchInlineEditor = $("#searchInlineEditor");
  const inlineRouteEditor = $("#inlineRouteEditor");
  const inlineDatesEditor = $("#inlineDatesEditor");
  const inlinePaxEditor = $("#inlinePaxEditor");
  const backToSearchLink = $("#backToSearch");
  const matrixBlock = $("#matrix");
  const resultsBlock = $("#results");
  const summaryChip = $("#summaryChip");
  const loadingOverlay = $("#loadingOverlay");
  const priceMinInput = $("#priceMin");
  const priceMaxInput = $("#priceMax");
  const airlineFilter = $("#airlineFilter");
  const originAirportFilter = $("#originAirportFilter");
  const destinationAirportFilter = $("#destinationAirportFilter");
  const postSearchLayout = $("#postSearchLayout");
  const matrixSection = $("#matrixSection");
  const filtersCard = $("#filtersBlock");
  const filtersToggle = $("#filtersToggle");
  const filtersClose = $("#filtersClose");
  const filtersOverlay = $("#filtersSheetOverlay");
  const filtersApply = $("#filtersApply");
  const durationResetBtn = $("#durationReset");
  const durationCurrentText = $("#durationCurrent");
  const durMaxInput = $("#durMax");
  const swapBtn = $("#swapInline") || $("#inlineSwap");
  const paxTrigger = $("#paxTrigger") || $("#inlinePaxTrigger");
  const paxPanel = $("#paxPanel");
  const recentChips = $("#recentChips");
  const yuviaTopBlock = $("#yuviaTopBlock");
  const yuviaTopList = $("#yuviaTopList");
  const yuviaTopSubtitle = $("#yuviaTopSubtitle");
  const yuviaTopSubtitleText =
    "Я учёл твой стиль поездки и ограничения по рейсам, убрал ночные и перегруженные стыковки. В этом блоке — варианты, с которых обычно удобно начинать выбор.";
  const favoritesBlock = $("#favoritesBlock");
  const compareBlock = $("#compareBlock");
  const compareModal = $("#compareModal");
  const compareTable = $("#compareTable");
  const compareTabs = $("#compareTabs");
  const compareYuviaChoice = $("#compareYuviaChoice");
  const compareClose = $("#compareClose");
  const compareModalDismiss = $("#compareModalDismiss");
  const timeOutboundLabel = $("#timeOutboundLabel");
  const timeReturnLabel = $("#timeReturnLabel");
  const onewayControl = $("#inlineOnewayToggle") || $("#onewayToggle");
  const inlineEditors = {
    route: inlineRouteEditor,
    dates: inlineDatesEditor,
    pax: inlinePaxEditor,
  };
  const searchForm = $("#searchForm");
  const isSearchPage = !!searchForm;
  const isResultsPage = !!postSearchLayout;

  if (yuviaTopSubtitle) {
    yuviaTopSubtitle.textContent = yuviaTopSubtitleText;
  }

  // Home/concierge page selectors
  const homeShell = $("#yuviaShell");
  const homeDialog = $("#yuviaDialog");
  const homeInputForm = $("#yuviaInputForm");
  const homeInput = $("#yuviaUserInput");
  const homeChips = $("#yuviaChips");
  const homeSendBtn = $("#yuviaSend");

  const formState = {
    originName: originInput?.value?.trim() || "",
    destName: destinationInput?.value?.trim() || "",
    departDate: parseDateValue(departInput?.value) || null,
    returnDate: parseDateValue(returnInput?.value) || null,
    oneway: onewayControl?.checked || false,
  };

  function setOriginValue(value) {
    if (originInput) originInput.value = value || "";
    formState.originName = value || "";
  }

  function setDestinationValue(value) {
    if (destinationInput) destinationInput.value = value || "";
    formState.destName = value || "";
  }

  function getOriginValue() {
    return originInput?.value?.trim() || formState.originName || "";
  }

  function getDestinationValue() {
    return destinationInput?.value?.trim() || formState.destName || "";
  }

  function setDepartValue(date) {
    const iso = date ? (typeof date === "string" ? date : toISO(date)) : "";
    if (departInput) departInput.value = iso;
    formState.departDate =
      typeof date === "string" ? parseDateValue(date) : date || null;
  }

  function setReturnValue(date) {
    const iso = date ? (typeof date === "string" ? date : toISO(date)) : "";
    if (returnInput) returnInput.value = iso;
    formState.returnDate =
      typeof date === "string" ? parseDateValue(date) : date || null;
  }

  function getDepartValue() {
    const value = departInput?.value || null;
    return value ? parseDateValue(value) : formState.departDate;
  }

  function getReturnValue() {
    const value = returnInput?.value || null;
    return value ? parseDateValue(value) : formState.returnDate;
  }

  function getOnewayFlag() {
    return onewayControl ? !!onewayControl.checked : !!formState.oneway;
  }

  function setOnewayFlag(value) {
    if (onewayControl) {
      onewayControl.checked = !!value;
    }
    formState.oneway = !!value;
  }

  function formatCurrency(value, currency = "RUB") {
    const safeCurrency = (currency || "RUB").toUpperCase();
    const formatter = new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: safeCurrency,
      maximumFractionDigits: 0,
    });
    return formatter.format(value);
  }

  function toISO(date) {
    if (!date) return "";
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function ddmmyyyy(date) {
    if (!date) return "";
    const day = `${date.getDate()}`.padStart(2, "0");
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    return `${day}.${month}.${date.getFullYear()}`;
  }

  function formatTime(date) {
    if (!date) return "";
    const hours = `${date.getHours()}`.padStart(2, "0");
    const minutes = `${date.getMinutes()}`.padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function formatDuration(minutes) {
    if (!minutes) return "—";
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const parts = [];
    if (hours) parts.push(`${hours} ч`);
    if (mins) parts.push(`${mins} мин`);
    return parts.join(" ");
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function safeDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function makeApiURL(path) {
    if (path instanceof URL) return path.toString();
    if (/^https?:/i.test(path)) return path;
    return new URL(path, API_BASE).toString();
  }

  function pickDeeplink(raw = {}) {
    const candidates = [
      raw.deeplink,
      raw.deep_link,
      raw.aviasales_deeplink,
      raw.ticket_link,
      raw.offer_link,
      raw.link,
    ].filter(Boolean);
    const allowedDomains = [
      "aviasales",
      "travelpayouts",
      "tp.st",
      "jetradar",
      "tp.media",
    ];
    for (const link of candidates) {
      try {
        const url = new URL(link);
        const host = url.hostname.toLowerCase();
        if (host.includes("yuvia")) continue;
        if (allowedDomains.some((domain) => host.includes(domain))) {
          return url.toString();
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  function buildAviasalesTicketUrl(raw = {}) {
    if (!raw || !raw.link) return null;
    const link = String(raw.link).trim();
    if (!link) return null;

    if (/^https?:\/\//i.test(link)) return link;

    const base = AVIA_BASE_URL.replace(/\/+$/, "");
    const path = link.replace(/^\/+/, "");
    return `${base}/${path}`;
  }

  async function callJSON(path) {
    const url = makeApiURL(path);
    console.log("[Yuvia] callJSON →", url);
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[Yuvia] API error", r.status, r.statusText, text);
      throw new Error("HTTP " + r.status);
    }
    const json = await r.json();
    console.log("[Yuvia] API response OK", json);
    return json;
  }

  function buildSearchQuery(params) {
    const paramsObj = new URLSearchParams();
    const oneway = params.oneway === true || params.oneway === "yes";
    // FIX Yuvia search: API expects oneway=yes/no; numeric flags were returning empty results.
    paramsObj.set("origin", params.origin);
    paramsObj.set("destination", params.destination);
    paramsObj.set("currency", params.currency || "RUB");
    paramsObj.set("oneway", oneway ? "yes" : "no");
    const departValue = params.departDate || params.depart || params.d1;
    const departISO =
      typeof departValue === "string" ? departValue : toISO(departValue);
    paramsObj.set("depart", departISO);
    const returnValue = params.returnDate || params.ret || params.d2;
    const returnISO =
      !oneway && returnValue
        ? typeof returnValue === "string"
          ? returnValue
          : toISO(returnValue)
        : "";
    paramsObj.set("ret", returnISO);
    paramsObj.set("adults", String(params.adults || 1));
    if (params.children !== undefined)
      paramsObj.set("children", String(params.children || 0));
    if (params.infants !== undefined)
      paramsObj.set("infants", String(params.infants || 0));
    if (params.cabin) paramsObj.set("cabin", params.cabin);
    return paramsObj;
  }

  function formatDeeplinkDate(value) {
    if (!value) return "";
    const date =
      typeof value === "string" ? parseDateValue(value) : safeDate(value);
    if (!date) return "";
    const day = `${date.getDate()}`.padStart(2, "0");
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    return `${day}${month}`;
  }

  function buildDeeplink({
    origin,
    destination,
    departDate,
    returnDate,
    oneway,
    adults,
    currency,
  }) {
    if (!origin || !destination || !departDate) return "";
    const departSlug = formatDeeplinkDate(departDate);
    const returnSlug =
      !oneway && returnDate ? formatDeeplinkDate(returnDate) : "";
    const slug = oneway
      ? `${origin.toUpperCase()}${departSlug}${destination.toUpperCase()}1`
      : `${origin.toUpperCase()}${departSlug}${destination.toUpperCase()}${returnSlug || departSlug}1`;
    const url = new URL(`https://www.aviasales.ru/search/${slug}`);
    url.searchParams.set("marker", "672309");
    url.searchParams.set("with_request", "true");
    url.searchParams.set("adults", String(Math.max(1, adults || 1)));
    url.searchParams.set("currency", (currency || "rub").toLowerCase());
    url.searchParams.set("utm_source", "yuvia");
    return url.toString();
  }

  function parseDateValue(value) {
    if (!value) return null;
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return null;
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function clampToFuture(date) {
    if (!date) return null;
    return date < todayLocal ? new Date(todayLocal) : date;
  }

  function updateSearchSummary() {
    const origin = getOriginValue();
    const dest = getDestinationValue();
    const departDate = getDepartValue();
    const isOneway = getOnewayFlag();
    const returnDate = isOneway ? null : getReturnValue();
    const passengers = paxState.adults + paxState.children + paxState.infants;

    if (timeOutboundLabel) {
      timeOutboundLabel.textContent = dest || "город назначения";
    }
    if (timeReturnLabel) {
      timeReturnLabel.textContent = origin || "город вылета";
    }

    const routeText = origin || dest ? `${origin || "—"} → ${dest || "—"}` : "";
    let datesText = "";
    if (departDate) {
      const dateText = ddmmyyyy(departDate);
      if (returnDate && !isOneway) {
        datesText = `${dateText} — ${ddmmyyyy(returnDate)}`;
      } else {
        datesText = dateText;
      }
    }
    const paxText =
      passengers === 1 ? "1 пассажир" : `${passengers} пассажиров`;
    const cabinText = paxState.cabin === "eco" ? "эконом" : "бизнес";
    const paxSummary = `${paxText}, ${cabinText}`;

    const segments = [];
    if (routeText) {
      segments.push({
        text: routeText,
        target: "route",
        aria: "Изменить маршрут",
      });
    }
    if (datesText) {
      segments.push({
        text: datesText,
        target: "dates",
        aria: "Изменить даты вылета",
      });
    }
    segments.push({
      text: paxSummary,
      target: "pax",
      aria: "Изменить пассажиров",
    });

    const shouldShow = segments.length > 0 && Boolean(routeText);
    if (searchSummary) {
      searchSummary.classList.toggle("hidden", !shouldShow);
    }
    if (searchSummaryAction) {
      searchSummaryAction.innerHTML = "";
      segments.forEach((segment, index) => {
        if (index > 0) {
          const divider = document.createElement("span");
          divider.className = "search-summary-divider";
          divider.textContent = "·";
          searchSummaryAction.appendChild(divider);
        }
        const node = document.createElement("span");
        node.className = "search-summary-segment";
        node.setAttribute("role", "button");
        node.setAttribute("tabindex", "0");
        node.dataset.target = segment.target;
        node.setAttribute("aria-label", segment.aria);
        node.textContent = segment.text;
        searchSummaryAction.appendChild(node);
      });
    } else if (searchSummary) {
      searchSummary.textContent = segments.map((item) => item.text).join(" · ");
    }
  }

  function focusInlineField(target) {
    if (target === "route") {
      originInput?.focus();
    } else if (target === "dates") {
      departInput?.focus();
    } else if (target === "pax") {
      const firstPaxBtn = document.querySelector("#inlinePaxEditor .pax-btn");
      firstPaxBtn?.focus();
    }
  }

  function captureInlineSnapshot() {
    return {
      origin: getOriginValue(),
      dest: getDestinationValue(),
      originIATA,
      destIATA,
      depart: getDepartValue(),
      returnDate: getReturnValue(),
      oneway: getOnewayFlag(),
      pax: { ...paxState },
    };
  }

  function restoreInlineSnapshot(snapshot) {
    if (!snapshot) return;
    setOriginValue(snapshot.origin);
    setDestinationValue(snapshot.dest);
    originIATA = snapshot.originIATA || "";
    destIATA = snapshot.destIATA || "";
    setDepartValue(snapshot.depart);
    setReturnValue(snapshot.returnDate);
    setOnewayFlag(snapshot.oneway);
    updateReturnControlState();
    Object.assign(paxState, snapshot.pax || {});
    updatePaxSummary();
    updateSearchSummary();
  }

  function hideSearchInlineEditor(options = {}) {
    if (!searchInlineEditor) return;
    const { restore = true } = options;
    if (restore && inlineSnapshot) {
      restoreInlineSnapshot(inlineSnapshot);
    }
    searchInlineEditor.classList.add("hidden");
    searchOverlay?.classList.add("hidden");
    document.body.classList.remove("overlay-locked");
    Object.values(inlineEditors).forEach((node) =>
      node?.classList.add("hidden"),
    );
    currentInlineTarget = null;
    inlineSnapshot = null;
    togglePaxPanel(false);
  }

  function showSearchInlineEditor(target) {
    if (!searchInlineEditor) return;
    if (
      currentInlineTarget &&
      currentInlineTarget !== target &&
      inlineSnapshot
    ) {
      restoreInlineSnapshot(inlineSnapshot);
    }
    inlineSnapshot = captureInlineSnapshot();
    Object.entries(inlineEditors).forEach(([key, node]) => {
      node?.classList.toggle("hidden", key !== target);
    });
    searchInlineEditor.classList.remove("hidden");
    searchOverlay?.classList.remove("hidden");
    if (isInlineMobile()) {
      document.body.classList.add("overlay-locked");
    } else {
      document.body.classList.remove("overlay-locked");
    }
    if (searchOverlayTitle) {
      const overlayTitles = {
        route: "Изменить маршрут",
        dates: "Изменить даты",
        pax: "Пассажиры и класс",
      };
      searchOverlayTitle.textContent =
        overlayTitles[target] || "Редактировать поиск";
    }
    positionInlinePopover(target);
    currentInlineTarget = target;
    setTimeout(() => focusInlineField(target), 20);
  }

  function toggleSearchInlineEditor(target) {
    if (!searchInlineEditor) return;
    const isOpen =
      !searchInlineEditor.classList.contains("hidden") &&
      currentInlineTarget === target;
    if (isOpen) {
      hideSearchInlineEditor();
    } else {
      showSearchInlineEditor(target);
    }
  }

  function updatePostSearchLayout() {
    if (postSearchLayout) {
      postSearchLayout.classList.toggle("hidden", !hasSearched);
    }
    if (matrixSection) {
      matrixSection.classList.toggle("hidden", !hasSearched);
    }
  }

  function initMinDateHints() {
    if (!departInput && !returnInput) return;
    const tomorrow = new Date(todayLocal);
    tomorrow.setDate(todayLocal.getDate() + 1);
    if (departInput) {
      departInput.min = toISO(todayLocal);
      if (!departInput.value) {
        departInput.value = toISO(todayLocal);
      }
    }
    if (returnInput) {
      returnInput.min = toISO(todayLocal);
      if (!returnInput.value) {
        returnInput.value = toISO(tomorrow);
      }
    }
    normalizeDepartDate();
    normalizeReturnDate();
    updateReturnControlState();
  }

  function normalizeDepartDate() {
    if (!departInput) {
      const raw = clampToFuture(formState.departDate);
      formState.departDate = raw;
      return raw;
    }
    let departDate = parseDateValue(departInput.value);
    if (!departDate) {
      return null;
    }
    departDate = clampToFuture(departDate);
    departInput.value = toISO(departDate);
    formState.departDate = departDate;
    return departDate;
  }

  function normalizeReturnDate() {
    if (!returnInput) {
      if (getOnewayFlag()) return null;
      const base = getDepartValue() || todayLocal;
      const current = formState.returnDate;
      if (!current) return null;
      const fixed = current < base ? new Date(base) : current;
      formState.returnDate = fixed;
      return fixed;
    }
    if (onewayControl?.checked) {
      returnInput.value = "";
      formState.returnDate = null;
      return null;
    }
    const departDate = parseDateValue(departInput.value) || todayLocal;
    let returnDate = parseDateValue(returnInput.value);
    if (!returnDate) {
      return null;
    }
    if (returnDate < departDate) {
      returnDate = new Date(departDate);
    }
    returnInput.value = toISO(returnDate);
    formState.returnDate = returnDate;
    return returnDate;
  }

  function updateReturnControlState() {
    if (!returnInput) return;
    if (onewayControl?.checked) {
      returnInput.value = "";
      returnInput.disabled = true;
    } else {
      returnInput.disabled = false;
      normalizeReturnDate();
    }
  }

  const mobileInlineQuery = window.matchMedia("(max-width: 720px)");

  function isInlineMobile() {
    return mobileInlineQuery?.matches;
  }

  function positionInlinePopover(target) {
    if (!searchOverlayCard) return;
    if (isInlineMobile()) {
      searchOverlayCard.style.left = "";
      searchOverlayCard.style.top = "";
      searchOverlayCard.style.width = "";
      return;
    }
    const anchor =
      document.querySelector(
        `.search-summary-segment[data-target="${target}"]`,
      ) || searchSummaryAction;
    const rect = anchor?.getBoundingClientRect();
    if (!rect) return;
    const cardWidth = Math.min(440, Math.max(380, window.innerWidth - 24));
    const centeredLeft = rect.left + rect.width / 2 - cardWidth / 2;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - cardWidth - 12, centeredLeft),
    );
    searchOverlayCard.style.width = `${cardWidth}px`;
    searchOverlayCard.style.left = `${left}px`;
    searchOverlayCard.style.top = `${rect.bottom + 10}px`;
    searchOverlayCard.style.transform = "none";
  }

  function repositionInlinePopover() {
    if (
      !currentInlineTarget ||
      !searchInlineEditor ||
      searchInlineEditor.classList.contains("hidden")
    )
      return;
    positionInlinePopover(currentInlineTarget);
  }

  function updatePaxSummary() {
    const total = paxState.adults + paxState.children + paxState.infants;
    const text = total === 1 ? "1 пассажир" : `${total} пассажиров`;
    const cabinText = paxState.cabin === "eco" ? "эконом" : "бизнес";
    const main = $("#paxMainText");
    if (main) main.textContent = text;
    const sub = $("#paxSubText");
    if (sub) sub.textContent = cabinText;
    const inlineSummary = $("#inlinePaxSummary");
    if (inlineSummary) inlineSummary.textContent = `${text}, ${cabinText}`;
    const adultsSelect = $("#adults");
    if (adultsSelect) {
      adultsSelect.value = String(paxState.adults);
    }
    $$(".pax-count").forEach((node) => {
      const kind = node.getAttribute("data-kind");
      if (kind && paxState[kind] !== undefined) {
        node.textContent = paxState[kind];
      }
    });
    $$(".pax-cabin-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.cabin === paxState.cabin);
    });
    updateSearchSummary();
    if (allResults.length) {
      applyFiltersAndSort();
    }
  }

  function initPaxFromAdultsSelect() {
    const adultsSelect = $("#adults");
    if (adultsSelect) {
      const value = Number(adultsSelect.value) || 1;
      paxState.adults = Math.max(1, value);
    }
    updatePaxSummary();
  }

  function togglePaxPanel(force) {
    if (!paxPanel) return;
    const shouldOpen =
      typeof force === "boolean"
        ? force
        : paxPanel.classList.contains("hidden");
    paxPanel.classList.toggle("hidden", !shouldOpen);
  }

  function handlePaxButtons() {
    $$(".pax-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.kind;
        const delta = Number(btn.dataset.delta || 0);
        if (!kind || Number.isNaN(delta)) return;
        if (kind === "adults") {
          paxState.adults = Math.max(1, paxState.adults + delta);
        } else if (kind === "children") {
          paxState.children = Math.max(0, paxState.children + delta);
        } else if (kind === "infants") {
          const maxInfants = paxState.adults;
          paxState.infants = Math.max(
            0,
            Math.min(maxInfants, paxState.infants + delta),
          );
        }
        updatePaxSummary();
      });
    });
    $$(".pax-cabin-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!btn.dataset.cabin) return;
        paxState.cabin = btn.dataset.cabin;
        updatePaxSummary();
      });
    });
    paxTrigger?.addEventListener("click", (event) => {
      event.preventDefault();
      togglePaxPanel();
    });
    document.addEventListener("click", (event) => {
      if (!paxPanel || !paxTrigger) return;
      if (paxTrigger.contains(event.target)) {
        return;
      }
      if (!paxPanel.contains(event.target)) {
        togglePaxPanel(false);
      }
    });
  }

  function formatSuggestItem(item) {
    const city = item.name || item.city_name || item.city || item.code;
    const country = item.country_name || item.country || "";
    return { city, code: item.code, country };
  }

  async function suggestCity(query) {
    const term = query.trim();
    if (!term) return [];
    if (suggestCache.has(term)) return suggestCache.get(term);
    const url = new URL("https://autocomplete.travelpayouts.com/places2");
    url.searchParams.set("term", term);
    url.searchParams.set("locale", "ru");
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error("suggest failed");
    const json = await response.json();
    const mapped = json
      .map(formatSuggestItem)
      .filter((item) => Boolean(item.code));
    suggestCache.set(term, mapped);
    return mapped;
  }

  function attachSuggest(input, onPick) {
    if (!input) return;
    const wrapper = input.parentElement;
    if (!wrapper) return;
    wrapper.classList.add("suggest-wrapper");
    const panel = document.createElement("div");
    panel.className = "suggest-panel hidden";
    wrapper.appendChild(panel);

    let debounceTimer;
    let currentTerm = "";

    async function runSuggest() {
      const term = input.value.trim();
      currentTerm = term;
      if (!term || term.length < 2) {
        panel.classList.add("hidden");
        panel.innerHTML = "";
        return;
      }
      try {
        const list = await suggestCity(term);
        if (currentTerm !== term) return;
        panel.innerHTML = "";
        if (!list.length) {
          const empty = document.createElement("div");
          empty.className = "suggest-empty";
          empty.textContent = "Ничего не найдено";
          panel.appendChild(empty);
        } else {
          list.slice(0, 8).forEach((item) => {
            const row = document.createElement("div");
            row.className = "suggest-item";
            row.innerHTML = `<strong>${item.city}</strong><span>${item.code} · ${item.country}</span>`;
            row.addEventListener("click", () => {
              panel.classList.add("hidden");
              input.value = item.city;
              onPick(item);
              updateSearchSummary();
            });
            panel.appendChild(row);
          });
        }
        panel.classList.remove("hidden");
      } catch (error) {
        console.error(error);
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSuggest, 200);
    });

    input.addEventListener("focus", runSuggest);

    document.addEventListener("click", (event) => {
      if (panel.contains(event.target) || input.contains(event.target)) return;
      panel.classList.add("hidden");
    });
  }

  function getCurrencyValue() {
    const select = document.getElementById("currency");
    return select?.value || "RUB";
  }

  function ensureIataFromPick(item, setValue) {
    if (!item) return;
    setValue(item.code || "");
  }

  function handleSuggestPick(target) {
    return (item) => {
      if (target === "origin") {
        originIATA = item.code;
        ensureIataFromPick(item, (value) => {
          originIATA = value;
        });
      } else {
        destIATA = item.code;
        ensureIataFromPick(item, (value) => {
          destIATA = value;
        });
      }
    };
  }

  function setLoading(active) {
    if (!loadingOverlay) return;
    loadingOverlay.classList.toggle("hidden", !active);
  }

  function updateFilterOptions() {
    const airlineMap = new Map();
    allResults.forEach((flight) => {
      const metaList = Array.isArray(flight.airlinesMetaAll)
        ? flight.airlinesMetaAll
        : Array.isArray(flight.airlinesAll)
          ? flight.airlinesAll.map((code) => ({
              code,
              name: resolveAirlineName(code, flight.airlineName),
            }))
          : [];
      metaList.forEach(({ code, name }) => {
        if (!code || airlineMap.has(code)) return;
        airlineMap.set(code, resolveAirlineName(code, name));
      });
    });

    if (airlineFilter) {
      airlineFilter.innerHTML = "";
      Array.from(airlineMap.entries())
        .sort((a, b) =>
          String(a[1] || a[0]).localeCompare(String(b[1] || b[0])),
        )
        .forEach(([code, name]) => {
          const label = document.createElement("label");
          label.className = "filter-option";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.name = "airlines";
          input.value = code;
          label.appendChild(input);
          const resolvedName = resolveAirlineName(code, name);
          const text = resolvedName ? `${resolvedName} (${code})` : code;
          label.appendChild(document.createTextNode(` ${text}`));
          airlineFilter.appendChild(label);
        });
    }

    const originAirports = new Set();
    const destinationAirports = new Set();
    allResults.forEach((flight) => {
      if (flight?.outbound?.start?.originAirport) {
        originAirports.add(flight.outbound.start.originAirport);
      }
      if (flight?.return?.start?.originAirport) {
        originAirports.add(flight.return.start.originAirport);
      }
      if (flight?.outbound?.end?.destAirport) {
        destinationAirports.add(flight.outbound.end.destAirport);
      }
      if (flight?.return?.end?.destAirport) {
        destinationAirports.add(flight.return.end.destAirport);
      }
    });

    function fillAirportFilter(container, codesArray) {
      if (!container) return;
      container.innerHTML = "";
      codesArray.sort().forEach((code) => {
        const label = document.createElement("label");
        label.className = "filter-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = code;
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + formatAirport(code)));
        container.appendChild(label);
      });
    }

    fillAirportFilter(originAirportFilter, Array.from(originAirports));
    fillAirportFilter(
      destinationAirportFilter,
      Array.from(destinationAirports),
    );
  }

  function getSelectedCheckboxValues(selector) {
    return $$(selector)
      .filter((el) => el instanceof HTMLInputElement && el.checked)
      .map((el) => el.value);
  }

  function getTimeWindow(date) {
    if (!(date instanceof Date)) return null;
    const hour = date.getHours();
    if (hour >= 0 && hour < 6) return "night";
    if (hour < 12) return "morning";
    if (hour < 18) return "day";
    return "evening";
  }

  function formatDurationLabel(hoursValue) {
    const minutesTotal = Math.round(Number(hoursValue || 0) * 60);
    if (!Number.isFinite(minutesTotal) || minutesTotal <= 0) return "0 мин";
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;
    const parts = [];
    if (hours) parts.push(`${hours} ч`);
    if (minutes) parts.push(`${minutes} мин`);
    return parts.join(" ");
  }

  function isDurationLimited() {
    if (!durMaxInput) return false;
    const current = Number(durMaxInput.value);
    const max = Number(durMaxInput.max);
    return Number.isFinite(current) && Number.isFinite(max) && current < max;
  }

  function updateDurationDisplay() {
    if (!durMaxInput || !durationCurrentText) return;
    const current = Number(durMaxInput.value);
    const max = Number(durMaxInput.max);
    if (!Number.isFinite(current) || !Number.isFinite(max)) return;
    if (current >= max) {
      durationCurrentText.textContent =
        "Сейчас: без ограничения по длительности";
      return;
    }
    durationCurrentText.innerHTML = `Сейчас: показывать рейсы не длиннее <strong>${formatDurationLabel(
      current,
    )}</strong>`;
  }

  function countActiveFilters() {
    let count = 0;
    if (priceMinInput?.value || priceMaxInput?.value) count += 1;

    const stops = document.querySelector('input[name="stops"]:checked')?.value;
    if (stops && stops !== "any") count += 1;

    count += document.querySelectorAll(
      ".depwin-outbound:checked, .depwin-return:checked",
    ).length;

    count += document.querySelectorAll(
      '#originAirportFilter input[type="checkbox"]:checked',
    ).length;
    count += document.querySelectorAll(
      '#destinationAirportFilter input[type="checkbox"]:checked',
    ).length;
    count += document.querySelectorAll(
      '#airlineFilter input[name="airlines"]:checked',
    ).length;

    if (isDurationLimited()) count += 1;
    return count;
  }

  function updateActiveFiltersCount() {
    if (!filtersToggle) return;
    const count = countActiveFilters();
    filtersToggle.textContent = count > 0 ? `Фильтры · ${count}` : "Фильтры";
  }

  function withinListAfterFilters(list) {
    const min = Number(priceMinInput.value) || null;
    const max = Number(priceMaxInput.value) || null;
    const originAirportValues = Array.from(
      document.querySelectorAll(
        '#originAirportFilter input[type="checkbox"]:checked',
      ),
    ).map((el) => el.value);
    const destinationAirportValues = Array.from(
      document.querySelectorAll(
        '#destinationAirportFilter input[type="checkbox"]:checked',
      ),
    ).map((el) => el.value);
    const airlineValues = Array.from(
      document.querySelectorAll(
        '#airlineFilter input[name="airlines"]:checked',
      ),
    ).map((el) => el.value);
    const stopsInput = document.querySelector('input[name="stops"]:checked');
    const stops = stopsInput ? stopsInput.value : "any";
    const durInputEl = durMaxInput || document.getElementById("durMax");
    const durMaxValue = durInputEl ? Number(durInputEl.value) : null;
    const durMaxAttr = durInputEl ? Number(durInputEl.max) : null;
    const hasDurationLimit =
      Number.isFinite(durMaxValue) &&
      Number.isFinite(durMaxAttr) &&
      durMaxValue < durMaxAttr;
    const outboundWindows = getSelectedCheckboxValues(".depwin-outbound");
    const returnWindows = getSelectedCheckboxValues(".depwin-return");

    return list.filter((flight) => {
      const transfersCount = getTransfersCount(flight);
      const departureTimes = getDepartureTimes(flight);
      const arrivalTimes = getArrivalTimes(flight);
      const hasNightDeparture = departureTimes.some((time) =>
        isNightTime(time),
      );
      const hasEarlyDeparture = departureTimes.some((time) =>
        isEarlyTime(time),
      );
      const hasNightArrival = arrivalTimes.some((time) => isNightTime(time));

      const enforcedStops = tripState.triggers.direct_only ? "0" : stops;
      if (min && flight.price < min) return false;
      if (max && flight.price > max) return false;
      if (enforcedStops === "0" && transfersCount !== 0) return false;
      if (
        enforcedStops === "1" &&
        !(transfersCount !== null && transfersCount <= 1)
      )
        return false;
      if (
        airlineValues.length &&
        !(
          Array.isArray(flight.airlinesAll) &&
          flight.airlinesAll.some((code) => airlineValues.includes(code))
        )
      )
        return false;
      const oAirports = [
        flight.outbound?.start?.originAirport,
        flight.return?.start?.originAirport,
      ].filter(Boolean);
      const dAirports = [
        flight.outbound?.end?.destAirport,
        flight.return?.end?.destAirport,
      ].filter(Boolean);
      if (
        originAirportValues.length &&
        !oAirports.some((code) => originAirportValues.includes(code))
      )
        return false;
      if (
        destinationAirportValues.length &&
        !dAirports.some((code) => destinationAirportValues.includes(code))
      )
        return false;
      if (hasDurationLimit) {
        const limit = durMaxValue * 60;
        const outboundDuration = flight?.outbound?.durationMinutes;
        if (Number.isFinite(outboundDuration) && outboundDuration > limit)
          return false;
        const returnDuration = flight?.return?.durationMinutes;
        if (
          flight.return &&
          Number.isFinite(returnDuration) &&
          returnDuration > limit
        )
          return false;
        if (
          !Number.isFinite(outboundDuration) &&
          !Number.isFinite(returnDuration) &&
          Number.isFinite(flight.durationMinutes) &&
          flight.durationMinutes > limit
        ) {
          return false;
        }
      }
      const outboundDepart = flight?.outbound?.start?.departAt;
      const returnDepart = flight?.return?.start?.departAt;
      if (outboundWindows.length && outboundDepart instanceof Date) {
        const window = getTimeWindow(outboundDepart);
        if (window && !outboundWindows.includes(window)) return false;
      }
      if (returnWindows.length && returnDepart instanceof Date) {
        const window = getTimeWindow(returnDepart);
        if (window && !returnWindows.includes(window)) return false;
      }

      if (tripState.triggers.no_night_dep && hasNightDeparture) return false;
      if (tripState.triggers.no_early_dep && hasEarlyDeparture) return false;
      if (
        tripState.triggers.no_overnight &&
        transfersCount > 0 &&
        (hasNightDeparture || hasNightArrival)
      ) {
        return false;
      }
      return true;
    });
  }

  function isNightTime(date) {
    if (!(date instanceof Date)) return false;
    const hour = date.getHours();
    return hour >= 22 || hour < 6;
  }

  function isEarlyTime(date) {
    if (!(date instanceof Date)) return false;
    return date.getHours() < 8;
  }

  function getTransfersCount(flight) {
    const value = Number(flight?.transfers);
    return Number.isFinite(value) ? value : null;
  }

  function getDepartureTimes(flight) {
    return [
      flight?.outbound?.start?.departAt || flight?.departAt,
      flight?.return?.start?.departAt,
    ].filter((time) => time instanceof Date);
  }

  function getArrivalTimes(flight) {
    return [
      flight?.outbound?.end?.arriveAt || flight?.arriveAt,
      flight?.return?.end?.arriveAt,
    ].filter((time) => time instanceof Date);
  }

  function applyTripTriggers(list) {
    return list.filter((flight) => {
      const transfersCount = getTransfersCount(flight);
      const departureTimes = getDepartureTimes(flight);
      const arrivalTimes = getArrivalTimes(flight);

      const hasNightDeparture = departureTimes.some((time) =>
        isNightTime(time),
      );
      const hasEarlyDeparture = departureTimes.some((time) =>
        isEarlyTime(time),
      );
      const hasNightArrival = arrivalTimes.some((time) => isNightTime(time));

      if (tripState.triggers.direct_only && transfersCount !== 0) return false;
      if (tripState.triggers.no_night_dep && hasNightDeparture) return false;
      if (tripState.triggers.no_early_dep && hasEarlyDeparture) return false;

      if (
        tripState.triggers.no_overnight &&
        transfersCount > 0 &&
        (hasNightDeparture || hasNightArrival)
      ) {
        return false;
      }

      return true;
    });
  }

  function getCalmScore(flight, context = {}) {
    const minDurationMinutes = context.minDurationMinutes || 0;
    let score = 50;

    const transfers = Number(flight.transfers) || 0;
    if (transfers === 0) score += 30;
    else if (transfers === 1) score += 18;
    else if (transfers === 2) score += 8;
    else score += 2;

    const departTimes = getDepartureTimes(flight);
    const arriveTimes = getArrivalTimes(flight);

    departTimes.forEach((time) => {
      if (!(time instanceof Date)) return;
      if (isNightTime(time)) score -= 8;
      else if (isEarlyTime(time)) score -= 4;
    });
    arriveTimes.forEach((time) => {
      if (!(time instanceof Date)) return;
      if (isNightTime(time)) score -= 6;
    });

    if (minDurationMinutes) {
      const diff =
        (flight.durationMinutes || minDurationMinutes) - minDurationMinutes;
      if (diff <= 0) score += 4;
      else if (diff <= 60) score -= 2;
      else if (diff <= 180) score -= 6;
      else score -= 12;
    }

    if (typeof flight.rating === "number") {
      score += (flight.rating - 6) * 1.1;
    }

    return score;
  }

  function applyTripStyle(list) {
    if (!tripState.style) return list;
    const baseList = list.slice();
    if (tripState.style === "calm") {
      const durations = baseList
        .map((flight) => flight.durationMinutes)
        .filter((value) => typeof value === "number" && value > 0);
      const minDuration = durations.length ? Math.min(...durations) : 0;
      return baseList
        .map((f) => ({
          flight: f,
          calmScore: getCalmScore(f, { minDurationMinutes: minDuration }),
        }))
        .sort(
          (a, b) =>
            b.calmScore - a.calmScore || a.flight.price - b.flight.price,
        )
        .map((x) => x.flight);
    }
    if (tripState.style === "balanced") {
      return baseList
        .map((flight) => {
          const score = (flight.rating || 0) / (flight.price || 1);
          return { flight, _valueScore: score };
        })
        .sort(
          (a, b) =>
            (b._valueScore || 0) - (a._valueScore || 0) ||
            (a.flight.price || 0) - (b.flight.price || 0),
        )
        .map(({ flight }) => flight);
    }
    if (tripState.style === "cheap") {
      return baseList.sort((a, b) => (a.price || 0) - (b.price || 0));
    }
    return baseList;
  }

  function sortBySelection(list) {
    const sortValue = $("#sortBy")?.value || "yuvia_score";
    const sorted = list.slice();
    if (sortValue === "price_asc") {
      sorted.sort((a, b) => a.price - b.price);
    } else if (sortValue === "price_desc") {
      sorted.sort((a, b) => b.price - a.price);
    } else if (sortValue === "duration_asc") {
      sorted.sort((a, b) => a.durationMinutes - b.durationMinutes);
    } else if (sortValue === "depart_asc") {
      const getTimeSafe = (flight) => {
        const t = flight?.outbound?.start?.departAt;
        if (t instanceof Date) return t.getTime();
        if (flight?.departAt instanceof Date) return flight.departAt.getTime();
        return Infinity;
      };
      sorted.sort((a, b) => getTimeSafe(a) - getTimeSafe(b));
    } else {
      sorted.sort((a, b) => b.yuviaScore - a.yuviaScore);
    }
    return sorted;
  }

  function updateSummaryChip(list) {
    if (!summaryChip) return;
    const workingFlights = list.filter(
      (flight) => (flight.currency || lastCurrency) === lastCurrency,
    );
    const prices = workingFlights
      .map((flight) => Number(flight.price))
      .filter((price) => Number.isFinite(price) && price > 0);
    if (!prices.length) {
      summaryChip.textContent = "—";
      return;
    }
    const median = getMedianPrice(workingFlights);
    const filteredPrices =
      median > 0 ? prices.filter((price) => price <= median * 5) : prices;
    if (!filteredPrices.length) {
      summaryChip.textContent = "—";
      return;
    }
    const min = Math.min(...filteredPrices);
    const avg =
      filteredPrices.reduce((sum, price) => sum + price, 0) /
      filteredPrices.length;
    summaryChip.textContent = `от ${formatCurrency(min, lastCurrency)} · ср. ${formatCurrency(avg, lastCurrency)}`;
  }

  function formatTransfers(transfers) {
    if (!transfers) return "прямой рейс";
    if (transfers === 1) return "1 пересадка";
    if (transfers >= 2 && transfers <= 4) return `${transfers} пересадки`;
    return `${transfers} пересадок`;
  }

  function formatDateRu(date) {
    if (!date) return "";
    return date
      .toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        weekday: "short",
      })
      .replace(/\.$/, "");
  }

  function formatArrivalOffset(departAt, arriveAt) {
    if (!departAt || !arriveAt) return "";
    const diffDays = Math.floor((arriveAt - departAt) / 86400000);
    if (diffDays <= 0) return "";
    const suffix = diffDays === 1 ? "день" : diffDays >= 5 ? "дней" : "дня";
    return ` (+${diffDays} ${suffix})`;
  }

  function renderSegmentBlock(group, label) {
    if (!group || !group.start || !group.end) return "";
    const start = group.start;
    const end = group.end;
    const transfersText = formatTransfers(group.transfers);
    const arrivalOffset = formatArrivalOffset(start.departAt, end.arriveAt);
    return `
            <div class="segment">
              <div class="segment-label">${label}</div>
              <div class="segment-row">
                <div>
                  <div class="segment-time">${formatTime(start.departAt)}</div>
                  <div class="segment-city">${start.originCity || ""}</div>
                  <div class="segment-airport">${formatAirport(start.originAirport)}</div>
                  <div class="segment-date">${start.departAt ? ddmmyyyy(start.departAt) : ""}</div>
                </div>
                <div class="segment-col-middle">
                  <div class="segment-middle-top">${formatDuration(group.durationMinutes)}</div>
                  <div class="segment-line"></div>
                  <div class="segment-middle-bottom">${transfersText}</div>
                </div>
                <div>
                  <div class="segment-time">${formatTime(end.arriveAt)}</div>
                  <div class="segment-city">${end.destCity || ""}</div>
                  <div class="segment-airport">${formatAirport(end.destAirport)}</div>
                  <div class="segment-date">${end.arriveAt ? ddmmyyyy(end.arriveAt) : ""}${arrivalOffset}</div>
                </div>
              </div>
            </div>
          `;
  }

  function renderBadgeWithTooltip({
    label,
    value = "",
    className = "",
    tooltipKey = "",
  }) {
    const text = [label, value].filter(Boolean).join(" ");
    const tooltip = TOOLTIP_TEXTS[tooltipKey] || "";
    const trigger = tooltip
      ? `<button type="button" class="tooltip-trigger" data-tooltip-key="${tooltipKey}" aria-label="Подробнее">?</button>`
      : "";
    const popover = tooltip
      ? `<div class="tooltip-popover" data-tooltip-key="${tooltipKey}">${escapeHtml(tooltip)}</div>`
      : "";
    const tooltipClass = tooltip ? " badge-with-tooltip" : "";
    return `<span class="badge ${className}${tooltipClass}" data-tooltip-key="${tooltipKey}"><span>${text}</span>${trigger}${popover}</span>`;
  }

  function renderResults(list) {
    if (!resultsBlock) return;
    closeAllTooltips();
    const container = resultsBlock;
    let aviasalesAllWrap = document.querySelector(".aviasales-all-wrap");
    if (!aviasalesAllWrap && container) {
      aviasalesAllWrap = document.createElement("div");
      aviasalesAllWrap.className = "aviasales-all-wrap";
      container.after(aviasalesAllWrap);
    }
    const hasBaseResults = Array.isArray(allResults) && allResults.length > 0;
    if (filtersCard) {
      filtersCard.classList.toggle("hidden", !hasBaseResults);
    }
    if (!hasBaseResults && hasSearched) {
      resultsBlock.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "no-results-card";
      empty.innerHTML =
        '<h4 style="margin: 0 0 8px">Нет рейсов по твоему запросу</h4><p style="margin: 0; color: var(--muted);">Попробуй изменить даты или города — мы покажем варианты, как только они появятся.</p>';
      resultsBlock.appendChild(empty);
      updateSummaryChip([]);
      if (matrixSection) {
        matrixSection.classList.add("hidden");
      }
      if (aviasalesAllWrap) {
        aviasalesAllWrap.innerHTML = "";
        aviasalesAllWrap.style.display = "none";
      }
      return;
    }
    if (matrixSection) {
      matrixSection.classList.toggle("hidden", !hasSearched);
    }
    const updateAviasalesAllWrap = (flightsList) => {
      if (!aviasalesAllWrap) return;
      const hasFlights = Array.isArray(flightsList) && flightsList.length > 0;
      if (!lastSearchContext || !hasFlights) {
        aviasalesAllWrap.innerHTML = "";
        aviasalesAllWrap.style.display = "none";
        return;
      }

      const ctx = lastSearchContext;
      const searchUrl = ctx
        ? buildDeeplink({
            origin: ctx.origin,
            destination: ctx.destination,
            departDate: ctx.departDate,
            returnDate: ctx.oneway ? null : ctx.returnDate,
            oneway: ctx.oneway,
            adults: ctx.adults || 1,
            currency: ctx.currency || lastCurrency,
          })
        : null;

      if (searchUrl) {
        aviasalesAllWrap.innerHTML = `
                <button type="button"
                        class="btn-primary aviasales-btn-all">
                  Все варианты на Aviasales ↗
                </button>
              `;
        const button = aviasalesAllWrap.querySelector(".aviasales-btn-all");
        button?.addEventListener("click", () =>
          window.open(searchUrl, "_blank", "noopener"),
        );
        aviasalesAllWrap.style.display = "";
      } else {
        aviasalesAllWrap.innerHTML = "";
        aviasalesAllWrap.style.display = "none";
      }
    };
    resultsBlock.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "Нет рейсов по текущим фильтрам.";
      resultsBlock.appendChild(empty);
      updateSummaryChip(list);
      updateAviasalesAllWrap([]);
      return;
    }
    list.forEach((flight, index) => {
      const card = document.createElement("article");
      card.className = "result";
      card.dataset.id = flight.id;
      card.style.animationDelay = `${index * 40}ms`;

      const outbound = flight.outbound;
      const inbound = flight.return;

      const originCity =
        outbound?.start?.originCity ||
        flight.originCity ||
        flight.originName ||
        formState.originName ||
        "";
      const originCode = formatAirport(
        outbound?.start?.originAirport || flight.originAirport,
      );
      const destCity =
        outbound?.end?.destCity ||
        flight.destCity ||
        flight.destName ||
        formState.destName ||
        "";
      const destCode = formatAirport(
        outbound?.end?.destAirport || flight.destAirport,
      );
      const routeTitle =
        [originCity, destCity].filter(Boolean).join(" → ") || "Маршрут";

      const airlinesAll = Array.isArray(flight.airlinesAll)
        ? flight.airlinesAll
        : [];
      const airlineMetaMap = new Map(
        (Array.isArray(flight.airlinesMetaAll)
          ? flight.airlinesMetaAll
          : []
        ).map(({ code, name }) => {
          const upperCode = String(code || "").toUpperCase();
          return [
            upperCode,
            resolveAirlineName(upperCode, name, flight.airlineName),
          ];
        }),
      );
      const primaryAirlineCode = String(
        flight.airlineCode || airlinesAll[0] || "",
      ).toUpperCase();
      const primaryAirlineName = resolveAirlineName(
        primaryAirlineCode,
        flight.airlineName,
        airlineMetaMap.get(primaryAirlineCode),
      );
      let airlineInfoLine = primaryAirlineName;
      if (airlinesAll.length === 1) {
        airlineInfoLine = `${primaryAirlineName} (${airlinesAll[0]})`;
      } else if (airlinesAll.length > 1) {
        const sampleCode = airlinesAll[0];
        const sampleName =
          airlineMetaMap.get(sampleCode) || primaryAirlineName || sampleCode;
        airlineInfoLine = `Несколько авиакомпаний`;
        airlineInfoLine += `<div style="font-size: 11px; color: var(--muted);">например, ${sampleName} (${sampleCode})</div>`;
      }

      const segments = [];
      if (outbound) {
        segments.push(
          renderSegmentBlock(outbound, inbound ? "Туда" : "Маршрут"),
        );
      }
      if (inbound) {
        segments.push(renderSegmentBlock(inbound, "Обратно"));
      }
      if (!segments.length && flight.departAt && flight.arriveAt) {
        segments.push(
          renderSegmentBlock(
            {
              start: {
                departAt: flight.departAt,
                originCity: flight.originCity,
                originAirport: flight.originAirport,
              },
              end: {
                arriveAt: flight.arriveAt,
                destCity: flight.destCity,
                destAirport: flight.destAirport,
              },
              durationMinutes:
                flight.outbound?.durationMinutes || flight.durationMinutes,
              transfers: flight.transfers,
            },
            "Маршрут",
          ),
        );
      }

      const ratingText =
        typeof flight.rating === "number"
          ? flight.rating.toFixed(1)
          : flight.rating || "—";
      const stressClass =
        flight.stressLevel === "low"
          ? "badge-stress-low"
          : flight.stressLevel === "high"
            ? "badge-stress-high"
            : "badge-stress-medium";
      const ratingBadge = renderBadgeWithTooltip({
        label: "Оценка маршрута",
        value: ratingText,
        className: "badge-rating",
        tooltipKey: "routeScore",
      });
      const stressBadge = renderBadgeWithTooltip({
        label: getStressText(flight.stressLevel),
        className: `${stressClass} result-stress`,
        tooltipKey: "stressLevel",
      });
      const transfersBadge = `<span class="badge badge-chip badge-transfers">${formatTransfers(flight.transfers)}</span>`;
      const ticketUrl =
        flight.aviasalesTicketUrl ||
        flight.aviasalesSearchUrl ||
        flight.deeplink ||
        null;
      const aviasalesButtons = ticketUrl
        ? `
                <a href="${ticketUrl}"
                   class="btn btn-primary btn-sm aviasales-btn-ticket"
                   target="_blank"
                   rel="noopener noreferrer">
                  Купить на Aviasales
                </a>
              `
        : `<button class="btn-primary btn-sm" disabled>Нет ссылки</button>`;
      const topBadges = [];
      if (flight.isTop) {
        topBadges.push(
          '<span class="badge badge-yuvia">Рекомендация Yuvia</span>',
        );
      }
      if (flight.topLabel) {
        topBadges.push(
          `<span class="badge badge-soft">${flight.topLabel}</span>`,
        );
      }
      const flightNumbersAll = [
        ...(flight.flightNumbers?.outbound || []),
        ...(flight.flightNumbers?.inbound || []),
      ];
      const flightNumberLine = flightNumbersAll.length
        ? `<div class="result-flight-number">Рейсы: ${flightNumbersAll.join(", ")}</div>`
        : "";
      card.innerHTML = `
              <div class="result-header">
                <div class="result-header-left">
                  <div class="result-route">
                    <div class="result-route-cities">${routeTitle}</div>
                    <div class="result-route-airports">${[originCode, destCode].filter(Boolean).join(" · ")}</div>
                  </div>
                </div>
                <div class="result-price-block">
                  <div class="result-price">${formatCurrency(flight.price, flight.currency || lastCurrency)}</div>
                  ${stressBadge}
                  <div class="airline-logo-wrap">
                  <div class="airline-logo">${primaryAirlineCode}</div>
                    <div class="airline-info">
                      <div>${airlineInfoLine}</div>
                      ${flightNumberLine}
                    </div>
                  </div>
                </div>
              </div>
              <div class="result-segments">
                ${segments.join("")}
              </div>
              <div class="result-chips">
                ${ratingBadge}
                ${transfersBadge}
                ${topBadges.join("")}
              </div>
              <div class="result-footer">
                <div class="result-footer-actions">
                  <button type="button" class="btn-outline btn-sm" data-action="open-result">Открыть в выдаче</button>
                  ${aviasalesButtons}
                </div>
              </div>
            `;
      const openBtn = card.querySelector('[data-action="open-result"]');
      openBtn?.addEventListener("click", () => highlightResultCard(flight.id));
      resultsBlock.appendChild(card);
    });
    const flightsWithLinks = list || filteredResults || [];
    updateAviasalesAllWrap(flightsWithLinks);
    updateSummaryChip(list);
    renderFavoritesBlock();
    renderCompareBlock();
  }

  function saveRecent(state) {
    const list = JSON.parse(localStorage.getItem(recentKey) || "[]");
    list.unshift(state);
    const unique = [];
    const seen = new Set();
    list.forEach((item) => {
      const key = `${item.origin}|${item.destination}|${item.depart}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(item);
    });
    localStorage.setItem(recentKey, JSON.stringify(unique.slice(0, 6)));
    renderRecent();
  }

  function renderRecent() {
    if (!recentChips) return;
    recentChips.innerHTML = "";
    const list = JSON.parse(localStorage.getItem(recentKey) || "[]");
    list.forEach((item) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = `${item.origin} → ${item.destination}`;
      chip.addEventListener("click", () => {
        originInput.value = item.origin;
        destinationInput.value = item.destination;
        departInput.value = item.depart;
        returnInput.value = item.returnDate;
        originIATA = item.originIata;
        destIATA = item.destIata;
        updateSearchSummary();
        normalizeDepartDate();
        normalizeReturnDate();
      });
      recentChips.appendChild(chip);
    });
  }

  function clearFilters() {
    priceMinInput.value = "";
    priceMaxInput.value = "";
    document
      .querySelectorAll(
        '#originAirportFilter input[type="checkbox"], #destinationAirportFilter input[type="checkbox"]',
      )
      .forEach((input) => {
        input.checked = false;
      });
    document
      .querySelectorAll('#airlineFilter input[name="airlines"]')
      .forEach((input) => {
        input.checked = false;
      });
    document
      .querySelectorAll(".depwin-outbound, .depwin-return")
      .forEach((checkbox) => {
        checkbox.checked = false;
      });
    const durMaxInput = document.getElementById("durMax");
    if (durMaxInput) {
      durMaxInput.value = durMaxInput.max || "";
    }
    const stopsAny = document.querySelector('input[name="stops"][value="any"]');
    if (stopsAny) {
      stopsAny.checked = true;
    }
    applyFiltersAndSort();
    updateDurationDisplay();
    updateActiveFiltersCount();
  }

  function applyFiltersAndSort() {
    if (!allResults.length) {
      resultsBlock.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "Пока нет результатов — начни новый поиск.";
      resultsBlock.appendChild(empty);
      summaryChip.textContent = "—";
      if (yuviaTopBlock) {
        yuviaTopBlock.classList.add("hidden");
      }
      renderFavoritesBlock();
      renderCompareBlock();
      return;
    }
    let list = withinListAfterFilters(allResults);
    list = applyTripTriggers(list);
    const baseForTop = tripState.style ? applyTripStyle(list) : list.slice();
    filteredResults = tripState.style ? baseForTop : sortBySelection(list);
    const topFlights = getYuviaTop3(baseForTop);
    markTopFlights(filteredResults, topFlights);
    renderResults(filteredResults);
    renderYuviaTop(filteredResults, topFlights);
    updateActiveFiltersCount();
  }

  function mapSegment(segment, fallback = {}) {
    if (!segment) return null;
    const departAt = safeDate(
      segment.departAt ||
        segment.depart_at ||
        segment.departure_at ||
        segment.departure ||
        segment.date_from ||
        segment.depart_date ||
        segment.time_from ||
        segment.begin_time,
    );
    const arriveAt = safeDate(
      segment.arriveAt ||
        segment.arrive_at ||
        segment.arrival_at ||
        segment.arrival ||
        segment.date_to ||
        segment.arrival_date ||
        segment.time_to ||
        segment.end_time,
    );
    const originAirport =
      segment.originAirport ||
      segment.origin_airport ||
      segment.flyFrom ||
      segment.from ||
      segment.origin ||
      segment.origin_code ||
      fallback.originAirport;
    const destAirport =
      segment.destAirport ||
      segment.dest_airport ||
      segment.flyTo ||
      segment.to ||
      segment.destination ||
      segment.destination_code ||
      fallback.destAirport;
    const originCityCode =
      segment.originCityCode ||
      segment.origin_city_code ||
      segment.cityFromCode ||
      segment.city_from_code ||
      originAirport ||
      fallback.originAirport;
    const destCityCode =
      segment.destCityCode ||
      segment.dest_city_code ||
      segment.cityToCode ||
      segment.city_to_code ||
      destAirport ||
      fallback.destAirport;
    const originCity =
      getCityName(originCityCode) ||
      segment.originCity ||
      segment.origin_city ||
      segment.cityFrom ||
      segment.city_from ||
      segment.from_city ||
      segment.origin?.city ||
      fallback.originCity;
    const destCity =
      getCityName(destCityCode) ||
      segment.destCity ||
      segment.dest_city ||
      segment.cityTo ||
      segment.city_to ||
      segment.to_city ||
      segment.destination?.city ||
      fallback.destCity;
    const airlineCode =
      segment.airlineCode ||
      segment.airline ||
      segment.carrier ||
      segment.marketing_carrier ||
      fallback.airlineCode ||
      "";
    const airlineName = resolveAirlineName(
      airlineCode,
      segment.airlineName ||
        segment.airline_name ||
        segment.carrier_name ||
        segment.marketing_carrier_name,
      fallback.airlineName || fallback.airlineCode,
    );
    const flightNumber =
      segment.flight_number ||
      segment.flight_no ||
      segment.flightNum ||
      segment.flight ||
      "";
    const durationMinutes =
      segment.durationMinutes ||
      segment.duration ||
      segment.duration_min ||
      (departAt && arriveAt
        ? Math.max(0, Math.round((arriveAt - departAt) / 60000))
        : null);
    return {
      departAt,
      arriveAt,
      originCity: originCity || fallback.originCity || "",
      destCity: destCity || fallback.destCity || "",
      originAirport: originAirport || fallback.originAirport || "",
      destAirport: destAirport || fallback.destAirport || "",
      airlineName: airlineName || "",
      airlineCode: airlineCode || "",
      flightNumber,
      durationMinutes,
    };
  }

  function collectAirlinesMeta(
    segments = [],
    fallbackCode = "",
    fallbackName = "",
  ) {
    const map = new Map();
    segments.forEach((seg) => {
      if (!seg) return;
      const code = seg.airlineCode || seg.airline || "";
      const name =
        seg.airlineName || seg.airline_name || seg.carrier_name || "";
      if (code) {
        const upperCode = String(code).toUpperCase();
        map.set(upperCode, resolveAirlineName(upperCode, name, fallbackName));
      }
    });
    if (fallbackCode) {
      const upperFallback = String(fallbackCode).toUpperCase();
      map.set(upperFallback, resolveAirlineName(upperFallback, fallbackName));
    }
    const airlinesAll = Array.from(map.keys());
    const airlinesMetaAll = airlinesAll.map((code) => ({
      code,
      name: map.get(code) || code,
    }));
    return { airlinesAll, airlinesMetaAll };
  }

  function splitSegments(raw, fallback = {}) {
    const outboundSegments = [];
    const returnSegments = [];
    function addSegment(segment, type = "outbound") {
      const mapped = mapSegment(segment, fallback);
      if (!mapped) return;
      if (type === "return") {
        returnSegments.push(mapped);
      } else {
        outboundSegments.push(mapped);
      }
    }
    const groups = [
      {
        list: raw.outboundSegments || raw.outbound_segments || raw.go_segments,
        type: "outbound",
      },
      {
        list:
          raw.returnSegments ||
          raw.inbound_segments ||
          raw.back_segments ||
          raw.return_segments,
        type: "return",
      },
    ];
    groups.forEach(({ list, type }) => {
      if (Array.isArray(list)) {
        list.forEach((segment) => addSegment(segment, type));
      }
    });
    if (!outboundSegments.length && !returnSegments.length) {
      const generic = Array.isArray(raw.segments)
        ? raw.segments
        : Array.isArray(raw.route)
          ? raw.route
          : [];
      generic.forEach((segment) => {
        const isReturn = Boolean(
          segment?.isReturn ||
            segment?.is_return ||
            segment?.direction === "return" ||
            segment?.leg === "return" ||
            segment?.segment_type === "back" ||
            segment?.trip === "back" ||
            segment?.return === true,
        );
        addSegment(segment, isReturn ? "return" : "outbound");
      });
    }
    if (
      !outboundSegments.length &&
      (fallback.departAt ||
        raw.departAt ||
        raw.depart_at ||
        raw.departure_at ||
        raw.depart_date)
    ) {
      addSegment(
        {
          departAt: fallback.departAt || raw.departAt,
          arriveAt: fallback.arriveAt || raw.arriveAt,
          originCity: fallback.originCity || raw.originCity,
          destCity: fallback.destCity || raw.destCity,
          originAirport:
            fallback.originAirport || raw.originAirport || raw.origin,
          destAirport:
            fallback.destAirport || raw.destAirport || raw.destination,
          airline: fallback.airlineCode || raw.airline,
          airline_name: fallback.airlineName || raw.airlineName,
          durationMinutes: raw.durationMinutes,
        },
        "outbound",
      );
    }
    if (
      !returnSegments.length &&
      (fallback.returnDepartAt ||
        raw.returnDepartAt ||
        raw.return_at ||
        raw.return_date)
    ) {
      addSegment(
        {
          departAt: fallback.returnDepartAt || raw.returnDepartAt,
          arriveAt: fallback.returnArriveAt || raw.returnArriveAt,
          originCity: fallback.destCity || raw.destCity,
          destCity: fallback.originCity || raw.originCity,
          originAirport: fallback.destAirport || raw.destAirport,
          destAirport: fallback.originAirport || raw.originAirport,
          airline: fallback.airlineCode || raw.airline,
          airline_name: fallback.airlineName || raw.airlineName,
          durationMinutes: raw.returnDurationMinutes,
        },
        "return",
      );
    }
    return { outboundSegments, returnSegments };
  }

  function summarizeSegments(segmentList) {
    if (!segmentList.length) return null;
    const start = segmentList[0];
    const end = segmentList[segmentList.length - 1];
    let durationMinutes = 0;
    if (start.departAt && end.arriveAt) {
      durationMinutes = Math.max(
        0,
        Math.round((end.arriveAt - start.departAt) / 60000),
      );
    } else {
      durationMinutes = segmentList.reduce((sum, segment) => {
        if (segment.durationMinutes) return sum + segment.durationMinutes;
        if (segment.departAt && segment.arriveAt) {
          return (
            sum +
            Math.max(
              0,
              Math.round((segment.arriveAt - segment.departAt) / 60000),
            )
          );
        }
        return sum;
      }, 0);
    }
    return {
      start,
      end,
      durationMinutes,
      transfers: Math.max(0, segmentList.length - 1),
      segments: segmentList,
    };
  }

  function normalizeFlight(raw, context = {}) {
    if (!raw) return null;

    const hasCompactAviasalesFields =
      (raw.departure_at || raw.return_at) &&
      (raw.duration_to != null ||
        raw.duration_back != null ||
        raw.duration != null);

    const originAirportCode =
      raw.originAirport ||
      raw.origin_airport ||
      raw.origin ||
      context.origin ||
      "";
    const destAirportCode =
      raw.destAirport ||
      raw.destination_airport ||
      raw.destination ||
      context.destination ||
      "";
    const originCityResolved =
      getCityName(originAirportCode) ||
      context.originCity ||
      raw.origin_name ||
      raw.originCity ||
      raw.origin_city ||
      "";
    const destCityResolved =
      getCityName(destAirportCode) ||
      context.destCity ||
      raw.destination_name ||
      raw.destCity ||
      raw.dest_city ||
      "";

    if (hasCompactAviasalesFields) {
      const departAt = safeDate(raw.departure_at || raw.departAt);
      const returnDepartAt = safeDate(raw.return_at || raw.returnDepartAt);

      let durationTo =
        Number(raw.duration_to ?? raw.durationTo ?? raw.duration_to_min) || 0;
      let durationBack =
        Number(
          raw.duration_back ?? raw.durationBack ?? raw.duration_back_min,
        ) || 0;

      if (
        (!durationTo || !durationBack) &&
        raw.duration != null &&
        returnDepartAt
      ) {
        durationTo = durationTo || Math.floor(Number(raw.duration) / 2) || 0;
        durationBack =
          durationBack || Math.max(0, (Number(raw.duration) || 0) - durationTo);
      }

      const outboundDepart = departAt;
      const outboundArrive =
        outboundDepart && durationTo
          ? new Date(outboundDepart.getTime() + durationTo * 60000)
          : null;

      const outboundSummary = {
        start: {
          departAt: outboundDepart,
          originCity: originCityResolved,
          originAirport: raw.origin_airport || context.origin || "",
        },
        end: {
          arriveAt: outboundArrive,
          destCity: destCityResolved,
          destAirport: raw.destination_airport || context.destination || "",
        },
        durationMinutes:
          durationTo ||
          (outboundArrive && outboundDepart
            ? Math.max(0, Math.round((outboundArrive - outboundDepart) / 60000))
            : 0),
        transfers: raw.transfers ?? raw.number_of_changes ?? raw.stops ?? 0,
      };

      let returnSummary = null;
      if (returnDepartAt) {
        const durationBackMinutes =
          durationBack || Math.max(0, (Number(raw.duration) || 0) - durationTo);
        const returnArrive =
          durationBackMinutes && returnDepartAt
            ? new Date(returnDepartAt.getTime() + durationBackMinutes * 60000)
            : null;

        returnSummary = {
          start: {
            departAt: returnDepartAt,
            originCity: outboundSummary.end.destCity,
            originAirport: outboundSummary.end.destAirport,
          },
          end: {
            arriveAt: returnArrive,
            destCity: outboundSummary.start.originCity,
            destAirport: outboundSummary.start.originAirport,
          },
          durationMinutes: durationBackMinutes,
          transfers: raw.return_transfers ?? raw.returnStops ?? 0,
        };
      }

      const durationMinutes =
        (outboundSummary?.durationMinutes || 0) +
        (returnSummary?.durationMinutes || 0);

      const currency = raw.currency || context.currency || lastCurrency;
      const price = Number(raw.price ?? raw.value ?? raw.total_price ?? 0) || 0;
      const airlineCode = (raw.airline || raw.airlineCode || "").toString();
      const airlineName = resolveAirlineName(
        airlineCode,
        raw.airline_name || raw.airlineName || raw.carrier_name,
      );
      const flightNumber = raw.flight_number || raw.flightNumber || "";
      const transfersTotal =
        (outboundSummary?.transfers || 0) + (returnSummary?.transfers || 0);
      const deeplinkCandidate = pickDeeplink(raw);

      const deeplink =
        deeplinkCandidate ||
        buildDeeplink({
          origin: context.origin || outboundSummary.start.originAirport,
          destination: context.destination || outboundSummary.end.destAirport,
          departDate: outboundSummary.start.departAt,
          returnDate: context.oneway
            ? null
            : returnSummary?.start.departAt || context.returnDate || null,
          oneway: context.oneway,
          adults: context.passengers || context.adults || 1,
          currency,
        });

      const aviasalesTicketUrl = buildAviasalesTicketUrl(raw);
      const aviasalesSearchUrl =
        deeplinkCandidate || aviasalesTicketUrl || null;

      return {
        id: String(
          raw.id ||
            raw.flight_id ||
            raw.search_id ||
            raw.token ||
            context.fallbackId ||
            `${context.origin || ""}-${context.destination || ""}-${Math.random().toString(16).slice(2)}`,
        ),
        originCity: outboundSummary.start.originCity,
        destCity: outboundSummary.end.destCity,
        originAirport: outboundSummary.start.originAirport,
        destAirport: outboundSummary.end.destAirport,
        departAt: outboundSummary.start.departAt,
        arriveAt: outboundSummary.end.arriveAt,
        returnDepartAt: returnSummary?.start.departAt || null,
        returnArriveAt: returnSummary?.end.arriveAt || null,
        outbound: outboundSummary,
        return: returnSummary,
        durationMinutes,
        durationHours: durationMinutes ? +(durationMinutes / 60).toFixed(1) : 0,
        transfers: transfersTotal,
        price,
        currency,
        airlineName,
        airlineCode,
        ...collectAirlinesMeta([], airlineCode, airlineName),
        flightNumber,
        airline: airlineCode,
        segments: [],
        flightNumbers: {
          outbound: [
            [airlineCode, flightNumber].filter(Boolean).join(" ").trim(),
          ].filter(Boolean),
          inbound: returnSummary
            ? [[airlineCode, flightNumber].filter(Boolean).join(" ").trim()]
            : [],
        },
        departHour: outboundSummary.start.departAt
          ? outboundSummary.start.departAt.getHours()
          : 0,
        deeplink,
        aviasalesTicketUrl,
        aviasalesSearchUrl,
      };
    }

    const departAt = safeDate(
      raw.departAt ||
        raw.depart_at ||
        raw.departure_at ||
        raw.departure ||
        raw.start_time ||
        raw.depart_date || // date-only поле, если есть
        raw.date_from, // ещё один возможный вариант
    );
    const arriveAt = safeDate(
      raw.arriveAt ||
        raw.arrive_at ||
        raw.arrival_at ||
        raw.arrival ||
        raw.end_time ||
        raw.arrival_date ||
        raw.date_to,
    );
    const returnDepartAt = safeDate(
      raw.returnDepartAt ||
        raw.return_departure ||
        raw.return_at ||
        raw.return_date ||
        raw.inbound?.depart_at ||
        raw.inbound?.departure_at,
    );
    const returnArriveAt = safeDate(
      raw.returnArriveAt ||
        raw.return_arrival ||
        raw.inbound?.arrive_at ||
        raw.inbound?.arrival_at,
    );
    const fallbackAirlineCode = (
      raw.airlineCode ||
      raw.airline ||
      raw.carrier ||
      ""
    ).toString();
    const fallbackAirlineName = resolveAirlineName(
      fallbackAirlineCode,
      raw.airlineName || raw.carrier_name || "",
    );
    const fallback = {
      originCity: originCityResolved,
      destCity: destCityResolved,
      originAirport: originAirportCode,
      destAirport: destAirportCode,
      airlineName: fallbackAirlineName,
      airlineCode: fallbackAirlineCode,
      departAt,
      arriveAt,
      returnDepartAt,
      returnArriveAt,
    };
    const { outboundSegments, returnSegments } = splitSegments(raw, fallback);
    const outboundSummary = summarizeSegments(outboundSegments);
    const returnSummary = summarizeSegments(returnSegments);
    const primarySegment =
      outboundSummary?.start || outboundSegments[0] || fallback;
    const outboundDuration =
      outboundSummary?.durationMinutes ||
      raw.durationMinutes ||
      raw.duration_min ||
      raw.duration_to ||
      0;
    const returnDuration =
      returnSummary?.durationMinutes ||
      raw.returnDurationMinutes ||
      raw.duration_back ||
      0;
    const durationMinutes = outboundDuration + returnDuration;
    const outboundTransfers =
      outboundSummary?.transfers ?? raw.transfers ?? raw.stops ?? 0;
    const returnTransfers =
      returnSummary?.transfers ??
      raw.return_transfers ??
      raw.transfers_back ??
      0;
    const transfers =
      (Number(outboundTransfers) || 0) + (Number(returnTransfers) || 0);
    const priceValue =
      raw.price?.value ??
      raw.price?.amount ??
      raw.price?.total ??
      raw.price ??
      raw.cost ??
      raw.total_price ??
      0;
    const price = Number(priceValue) || 0;
    const currency =
      raw.currency || raw.price?.currency || context.currency || lastCurrency;
    const departPoint = outboundSummary?.start?.departAt || departAt;
    const arrivePoint = outboundSummary?.end?.arriveAt || arriveAt;
    const departTimeStr = formatTime(departPoint);
    const arriveTimeStr = formatTime(arrivePoint);
    const depDateStr = ddmmyyyy(departPoint);
    const durationHours = Number(
      ((outboundDuration || raw.durationMinutes || 0) / 60).toFixed(1),
    );
    const departHour =
      departPoint instanceof Date ? departPoint.getHours() : null;
    const outboundFlightNumbers = (outboundSegments || [])
      .map((segment) =>
        [segment.airlineCode, segment.flightNumber]
          .filter(Boolean)
          .join(" ")
          .trim(),
      )
      .filter(Boolean);
    const returnFlightNumbers = (returnSegments || [])
      .map((segment) =>
        [segment.airlineCode, segment.flightNumber]
          .filter(Boolean)
          .join(" ")
          .trim(),
      )
      .filter(Boolean);
    const allSegments = [...outboundSegments, ...returnSegments];
    const { airlinesAll, airlinesMetaAll } = collectAirlinesMeta(
      allSegments,
      primarySegment.airlineCode,
      primarySegment.airlineName,
    );
    const deeplinkCandidate = pickDeeplink(raw);
    const aviasalesTicketUrl = buildAviasalesTicketUrl(raw);
    const aviasalesSearchUrl = deeplinkCandidate || aviasalesTicketUrl || null;
    return {
      id: String(
        raw.id ||
          raw.flight_id ||
          raw.search_id ||
          raw.token ||
          context.fallbackId ||
          `${context.origin || ""}-${context.destination || ""}-${Math.random().toString(16).slice(2)}`,
      ),
      originCity:
        getCityName(outboundSummary?.start?.originAirport) ||
        outboundSummary?.start?.originCity ||
        originCityResolved ||
        fallback.originCity ||
        context.originCity ||
        "",
      destCity:
        getCityName(outboundSummary?.end?.destAirport) ||
        outboundSummary?.end?.destCity ||
        destCityResolved ||
        fallback.destCity ||
        context.destCity ||
        "",
      originAirport:
        outboundSummary?.start?.originAirport ||
        fallback.originAirport ||
        context.origin ||
        "",
      destAirport:
        outboundSummary?.end?.destAirport ||
        fallback.destAirport ||
        context.destination ||
        "",
      departAt: outboundSummary?.start?.departAt || departAt,
      arriveAt: outboundSummary?.end?.arriveAt || arriveAt,
      returnDepartAt: returnSummary?.start?.departAt || returnDepartAt,
      returnArriveAt: returnSummary?.end?.arriveAt || returnArriveAt,
      departTimeStr,
      arriveTimeStr,
      depDateStr,
      durationMinutes,
      durationHours,
      duration_to_hours: durationHours,
      transfers,
      price,
      currency,
      airlineName: primarySegment.airlineName || "",
      airlineCode: primarySegment.airlineCode || "",
      airlinesAll,
      airlinesMetaAll,
      airline: primarySegment.airlineCode || "",
      segments: allSegments,
      outbound: outboundSummary
        ? {
            ...outboundSummary,
            durationMinutes: outboundDuration,
            transfers: outboundTransfers,
          }
        : null,
      return: returnSummary
        ? {
            ...returnSummary,
            durationMinutes: returnDuration,
            transfers: returnTransfers,
          }
        : null,
      flightNumbers: {
        outbound: outboundFlightNumbers,
        inbound: returnFlightNumbers,
      },
      departHour,
      deeplink:
        deeplinkCandidate ||
        buildDeeplink({
          origin: context.origin || fallback.originAirport,
          destination: context.destination || fallback.destAirport,
          departDate: outboundSummary?.start?.departAt || departAt,
          returnDate: context.oneway
            ? null
            : context.returnDate ||
              returnSummary?.start?.departAt ||
              returnDepartAt,
          oneway: context.oneway,
          adults: context.passengers || context.adults || 1,
          currency,
        }),
      aviasalesTicketUrl,
      aviasalesSearchUrl,
    };
  }

  function normalizeMatrixResponse(payload) {
    if (!payload) return [];
    let source = [];
    if (Array.isArray(payload)) {
      source = payload;
    } else if (Array.isArray(payload.matrix)) {
      source = payload.matrix;
    } else if (Array.isArray(payload.data)) {
      source = payload.data;
    } else if (payload.entries && typeof payload.entries === "object") {
      source = Object.entries(payload.entries).map(([date, value]) => ({
        ...value,
        date,
      }));
    }
    return source
      .map((item) => {
        const iso = item.date_iso || item.date || item.depart_date;
        const isoDate = iso ? iso.split("T")[0] : "";
        const displayDate =
          item.date_str ||
          (isoDate ? isoDate.split("-").reverse().join(".") : "");
        const price = Number(
          item.price || item.value || item.amount || item.min_price || 0,
        );
        if (!isoDate || !price) return null;
        return {
          date: isoDate,
          date_iso: isoDate,
          date_str: displayDate,
          date_str_ru: item.date_str_ru || displayDate,
          price,
          currency: item.currency || lastCurrency,
        };
      })
      .filter(Boolean);
  }

  function renderPriceMatrix(data, selectedISODate) {
    if (!matrixBlock) return;
    matrixBlock.innerHTML = "";
    matrixBlock.className = "matrix-calendar";
    if (!data || !data.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "Пока нет данных по соседним датам.";
      matrixBlock.appendChild(empty);
      return;
    }
    const prices = data
      .map((entry) => entry.price)
      .filter((price) => typeof price === "number" && price > 0);
    const minPrice = prices.length ? Math.min(...prices) : null;
    data.forEach((item) => {
      const cell = document.createElement("div");
      cell.className = "matrix-day";
      if (minPrice !== null && item.price === minPrice) {
        cell.classList.add("cheapest");
      }
      if (item.date === selectedISODate) {
        cell.classList.add("selected");
      }
      const dateDiv = document.createElement("div");
      dateDiv.className = "matrix-day__date";
      dateDiv.textContent = item.date_str_ru || item.date_str || item.date;
      const priceDiv = document.createElement("div");
      priceDiv.className = "matrix-day__price";
      priceDiv.textContent = `от ${formatCurrency(item.price, item.currency || lastCurrency)}`;
      cell.appendChild(dateDiv);
      cell.appendChild(priceDiv);
      cell.addEventListener("click", () => {
        if (item.date) {
          departInput.value = item.date;
          normalizeDepartDate();
          if (typeof doSearch === "function") {
            doSearch();
          }
        }
      });
      matrixBlock.appendChild(cell);
    });
  }

  function getMedianPrice(list) {
    if (!list.length) return 0;
    const prices = list
      .map((flight) => flight.price)
      .filter((price) => typeof price === "number" && price > 0)
      .sort((a, b) => a - b);
    if (!prices.length) return 0;
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
  }

  function collectConnectionDiffs(flight) {
    const transfers = getTransfersCount(flight) || 0;
    const departures = getDepartureTimes(flight);
    const arrivals = getArrivalTimes(flight);

    const nightDepartures = departures.filter((time) =>
      isNightTime(time),
    ).length;
    const earlyDepartures = departures.filter(
      (time) => !isNightTime(time) && isEarlyTime(time),
    ).length;
    const nightArrivals = arrivals.filter((time) => isNightTime(time)).length;

    return { transfers, nightDepartures, nightArrivals, earlyDepartures };
  }

  function computeStress(flight, context = {}) {
    const minDurationMinutes = context.minDurationMinutes || 0;
    let stressPoints = 0;
    const { transfers, nightDepartures, nightArrivals, earlyDepartures } =
      collectConnectionDiffs(flight);
    if (transfers >= 1) {
      stressPoints += 2 + Math.max(0, transfers - 1);
    }

    stressPoints += nightDepartures;
    stressPoints += nightArrivals;
    stressPoints += earlyDepartures;

    if (minDurationMinutes > 0) {
      const durationDiffMinutes = Math.max(
        0,
        (flight.durationMinutes || 0) - minDurationMinutes,
      );
      const diffHours = durationDiffMinutes / 60;
      if (diffHours > 2 && diffHours <= 4) stressPoints += 1;
      else if (diffHours > 4 && diffHours <= 6) stressPoints += 2;
      else if (diffHours > 6) stressPoints += 3;
    }

    const level =
      stressPoints <= 2 ? "low" : stressPoints <= 5 ? "medium" : "high";
    return { level, points: stressPoints };
  }

  function recalculateScores(list) {
    if (!Array.isArray(list) || !list.length) return;
    const durations = list
      .map((flight) => flight.durationMinutes)
      .filter((value) => typeof value === "number" && value > 0);
    const minDurationMinutes = durations.length ? Math.min(...durations) : 0;
    const medianPrice = getMedianPrice(list) || 1;

    list.forEach((flight) => {
      const { level, points } = computeStress(flight, { minDurationMinutes });
      flight.stressLevel = level;
      flight.stressPoints = points;

      const priceRatio = medianPrice ? (flight.price || 0) / medianPrice : 1;
      const normPrice = clamp(priceRatio || 1, 0.6, 1.8);
      const priceScore = (2 - normPrice) * 3;

      const durationRatio = minDurationMinutes
        ? (flight.durationMinutes || minDurationMinutes) / minDurationMinutes
        : 1;
      const normDuration = clamp(durationRatio || 1, 1, 2.2);
      const durationScore = (2.3 - normDuration) * 3;

      let transferScore = 0;
      if (flight.transfers === 0) transferScore = 3;
      else if (flight.transfers === 1) transferScore = 2;
      else if (flight.transfers === 2) transferScore = 1;

      let stressScore = 0;
      if (flight.stressLevel === "low") stressScore = 2;
      else if (flight.stressLevel === "medium") stressScore = 1;

      let timeScore = 0;
      const depart = flight?.outbound?.start?.departAt || flight?.departAt;
      const arrive = flight?.outbound?.end?.arriveAt || flight?.arriveAt;
      if (
        depart instanceof Date &&
        !isNightTime(depart) &&
        !isEarlyTime(depart)
      )
        timeScore += 0.4;
      if (arrive instanceof Date && !isNightTime(arrive)) timeScore += 0.2;

      const ratingRaw =
        1 +
        priceScore +
        durationScore +
        transferScore +
        stressScore +
        timeScore;
      const rating = clamp(ratingRaw, 6.0, 9.7);
      flight.rating = Number(rating.toFixed(1));
      flight.yuviaScore = Math.round(flight.rating * 10);
    });
  }

  function getYuviaTop3(list) {
    if (!list.length) return [];
    const working = list.filter(
      (flight) => typeof flight.price === "number" && flight.price > 0,
    );
    if (!working.length) return [];
    const medianPrice = getMedianPrice(working);
    const picks = [];
    const seen = new Set();

    const tryAdd = (candidate, meta) => {
      if (!candidate || seen.has(candidate.id)) return;
      seen.add(candidate.id);
      picks.push({ ...candidate, ...meta });
    };

    const balanced = [...working].sort(
      (a, b) =>
        (b.rating || 0) - (a.rating || 0) || (a.price || 0) - (b.price || 0),
    )[0];
    if (balanced && (!medianPrice || balanced.price <= medianPrice * 1.3)) {
      tryAdd(balanced, { topLabel: "ЗОЛОТАЯ СЕРЕДИНА", topType: "golden" });
    }

    const cheapest = [...working].sort(
      (a, b) => (a.price || Infinity) - (b.price || Infinity),
    )[0];
    if (cheapest) {
      tryAdd(cheapest, { topLabel: "САМЫЙ ДЁШЕВЫЙ", topType: "cheap" });
    }

    const fastest = [...working].sort(
      (a, b) =>
        (a.outbound?.durationMinutes || a.durationMinutes || Infinity) -
        (b.outbound?.durationMinutes || b.durationMinutes || Infinity),
    )[0];
    if (fastest) {
      tryAdd(fastest, { topLabel: "САМЫЙ БЫСТРЫЙ", topType: "fast" });
    }

    return picks;
  }

  function markTopFlights(list, top) {
    const ids = new Set(top.map((flight) => flight.id));
    list.forEach((flight) => {
      flight.isTop = ids.has(flight.id);
      const match = top.find((item) => item.id === flight.id);
      flight.topLabel = match?.topLabel || "";
      flight.topType = match?.topType || "";
    });
  }

  function getRecommendationHint(label) {
    const normalized = String(label || "").toLowerCase();
    if (normalized.includes("золотая")) {
      return "Баланс цены и удобства — без экстремальных стыковок и ночных перелётов";
    }
    if (normalized.includes("быстр")) {
      return "Если хочешь провести в дороге минимум времени";
    }
    if (normalized.includes("деш")) {
      return "Подойдёт, если главное — сэкономить";
    }
    return "";
  }

  function getStressText(level) {
    if (level === "low") return "стресс: низкий";
    if (level === "medium") return "стресс: средний";
    if (level === "high") return "стресс: высокий";
    return "стресс: неизвестно";
  }

  function findFlightById(id) {
    if (!id) return null;
    return allResults.find((flight) => flight.id === id) || null;
  }

  function persistFavorites() {
    localStorage.setItem(
      "favoritesIds",
      JSON.stringify(Array.from(favoritesIds)),
    );
  }

  function persistCompare() {
    localStorage.setItem("compareIds", JSON.stringify(Array.from(compareIds)));
  }

  function updateFavButtonState(button, flightId) {
    if (!button) return;
    const isFav = favoritesIds.has(flightId);
    button.classList.add("btn-secondary", "btn-sm");
    button.classList.remove("btn-primary", "btn-ghost");
    button.classList.toggle("is-active", isFav);
    button.textContent = isFav ? "Убрать из избранного" : "В избранное";
  }

  function updateCompareButtonState(button, flightId) {
    if (!button) return;
    const inCompare = compareIds.has(flightId);
    button.classList.add("btn-secondary", "btn-sm");
    button.classList.remove("btn-primary");
    button.classList.toggle("is-active", inCompare);
    button.textContent = inCompare ? "Убрать из сравнения" : "Сравнить";
  }

  function syncFavoriteButtons() {
    document.querySelectorAll(".btn-fav").forEach((button) => {
      const flightId = button.dataset.id;
      updateFavButtonState(button, flightId);
    });
  }

  function syncCompareButtons() {
    document.querySelectorAll(".btn-compare").forEach((button) => {
      const flightId = button.dataset.id;
      updateCompareButtonState(button, flightId);
    });
  }

  function clearFavorites() {
    favoritesIds.clear();
    persistFavorites();
    renderFavoritesBlock();
    syncFavoriteButtons();
  }

  function clearCompareSelection() {
    compareIds.clear();
    persistCompare();
    renderCompareBlock();
    syncCompareButtons();
    closeCompareModal();
  }

  function renderMiniCard(container, flight, isYuviaChoice = false) {
    const card = document.createElement("div");
    card.className = `mini-flight${isYuviaChoice ? " mini-flight--highlight" : ""}`;
    const badge = isYuviaChoice
      ? '<div class="badge badge-soft">Выбор Yuvia</div>'
      : "";
      card.innerHTML = `
            <div class="mini-flight-title">${flight.originCity || ""} → ${flight.destCity || ""}</div>
            <div class="mini-flight-meta">${formatCurrency(flight.price, flight.currency || lastCurrency)}</div>
            ${badge}
          `;
    card.addEventListener("click", () => highlightResultCard(flight.id));
    container.appendChild(card);
  }

  function pickYuviaChoice(flights) {
    if (!flights?.length) return null;
    const top = getYuviaTop3(flights);
    if (top.length) {
      const balanced = top.find((flight) =>
        (flight.topLabel || "").includes("Золотая"),
      );
      return balanced || top[0];
    }
    return (
      flights
        .slice()
        .sort(
          (a, b) =>
            (b.rating || 0) - (a.rating || 0) ||
            (a.price || 0) - (b.price || 0),
        )[0] || null
    );
  }

  function renderFavoritesBlock() {
    if (!favoritesBlock) return;
    const flights = Array.from(favoritesIds)
      .map((id) => findFlightById(id))
      .filter(Boolean);
    if (!flights.length) {
      favoritesBlock.classList.add("hidden");
      favoritesBlock.innerHTML = "";
      return;
    }
    const yuviaPick = pickYuviaChoice(flights);
    favoritesBlock.classList.remove("hidden");
    favoritesBlock.innerHTML = `
            <div class="section-header">
              <div class="section-title" style="margin-top:0">Избранное</div>
              <button type="button" class="section-close" id="favoritesClear" aria-label="Очистить избранное">×</button>
            </div>
          `;
    const list = document.createElement("div");
    list.className = "favorites-list";
    flights.forEach((flight) =>
      renderMiniCard(list, flight, yuviaPick?.id === flight.id),
    );
    favoritesBlock.appendChild(list);
    if (yuviaPick) {
      const note = document.createElement("div");
      note.className = "mini-flight-note";
      note.textContent =
        "Из сохранённых вариантов я бы выбрал этот: удобное время вылета и разумная цена";
      favoritesBlock.appendChild(note);
    }
    favoritesBlock
      .querySelector("#favoritesClear")
      ?.addEventListener("click", clearFavorites);
  }

  function getDirectionSlice(flight, direction = "outbound") {
    const segment =
      direction === "return" ? flight.return : flight.outbound || flight;
    const originCity =
      segment?.start?.city ||
      (direction === "return" ? flight.destCity : flight.originCity) ||
      "";
    const destCity =
      segment?.end?.city ||
      (direction === "return" ? flight.originCity : flight.destCity) ||
      "";
    const originAirport =
      segment?.start?.airportCode ||
      segment?.start?.airport ||
      flight.originIATA ||
      flight.originAirport ||
      "";
    const destAirport =
      segment?.end?.airportCode ||
      segment?.end?.airport ||
      flight.destIATA ||
      flight.destinationAirport ||
      "";
    const departAt = segment?.start?.departAt || flight.departAt;
    const arriveAt = segment?.end?.arriveAt || flight.arriveAt;
    const durationMinutes = segment?.durationMinutes || flight.durationMinutes;
    const transfers =
      typeof segment?.transfers === "number"
        ? segment.transfers
        : typeof flight.transfers === "number"
          ? flight.transfers
          : 0;
    return {
      originCity,
      destCity,
      originAirport,
      destAirport,
      departAt,
      arriveAt,
      durationMinutes,
      transfers,
    };
  }

  function buildCompareTableRows(flights, direction = compareDirection) {
    if (!compareTable) return;
    compareTable.innerHTML = "";
    const header = document.createElement("tr");
    header.innerHTML = `
            <th>Маршрут</th>
            <th>Аэропорты</th>
            <th>Цена</th>
            <th>Длительность</th>
            <th>Пересадки</th>
            <th>Вылет</th>
            <th>Прилёт</th>
            <th>Авиакомпании</th>
          `;
    compareTable.appendChild(header);
    flights.forEach((flight) => {
      const slice = getDirectionSlice(flight, direction);
      const airportsLine =
        [slice.originAirport, slice.destAirport].filter(Boolean).join(" → ") ||
        "—";
      const airlinesLine = Array.isArray(flight.airlinesMetaAll)
        ? flight.airlinesMetaAll
            .map(({ code, name }) => {
              const resolved = resolveAirlineName(
                code,
                name,
                flight.airlineName,
              );
              return resolved ? `${resolved} (${code})` : code;
            })
            .join(", ")
        : (flight.airlinesAll || [])
            .map((code) => {
              const resolved = resolveAirlineName(code, "", flight.airlineName);
              return resolved ? `${resolved} (${code})` : code;
            })
            .join(", ");
      const row = document.createElement("tr");
      row.innerHTML = `
              <td>${slice.originCity || ""} → ${slice.destCity || ""}</td>
              <td>${airportsLine}</td>
              <td>${formatCurrency(flight.price, flight.currency || lastCurrency)}</td>
              <td>${formatDuration(slice.durationMinutes)}</td>
              <td>${formatTransfers(slice.transfers)}</td>
              <td>${formatTime(slice.departAt) || "—"}</td>
              <td>${formatTime(slice.arriveAt) || "—"}</td>
              <td>${airlinesLine || ""}</td>
            `;
      compareTable.appendChild(row);
    });
  }

  function renderCompareChoice(choice) {
    if (!compareYuviaChoice) return;
    if (!choice) {
      compareYuviaChoice.classList.add("hidden");
      compareYuviaChoice.textContent = "";
      return;
    }
    compareYuviaChoice.classList.remove("hidden");
    const descriptor = `${choice.originCity || ""} → ${choice.destCity || ""}`;
    const airline = choice.airlineName || (choice.airlinesAll || [])[0] || "";
    const depart = formatTime(
      choice.outbound?.start?.departAt || choice.departAt,
    );
    compareYuviaChoice.innerHTML = `<strong>Выбор Yuvia.</strong> Из этих вариантов я бы выбрал рейс ${descriptor} ${airline ? `(${airline})` : ""}. У него удобное время в пути и адекватная цена${
      depart ? ` — вылет в ${depart}` : ""
    }.`;
  }

  function renderCompareTabs(hasReturnDirection) {
    if (!compareTabs) return;
    compareTabs.innerHTML = "";
    const directions = [
      { key: "outbound", label: "Туда" },
      { key: "return", label: "Обратно" },
    ];
    directions
      .filter((item) => item.key === "outbound" || hasReturnDirection)
      .forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `compare-tab${compareDirection === item.key ? " active" : ""}`;
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          compareDirection = item.key;
          renderCompareTabs(
            currentCompareFlights.some((flight) => !!flight.return),
          );
          buildCompareTableRows(currentCompareFlights, compareDirection);
        });
        compareTabs.appendChild(btn);
      });
  }

  function openCompareModal() {
    if (!compareModal || !compareTable) return;
    const flights = Array.from(compareIds)
      .map((id) => findFlightById(id))
      .filter(Boolean);
    if (flights.length < 2) return;
    currentCompareFlights = flights;
    const hasReturnDirection = flights.some((flight) => !!flight.return);
    compareDirection = "outbound";
    renderCompareTabs(hasReturnDirection);
    renderCompareChoice(pickYuviaChoice(flights));
    buildCompareTableRows(flights, compareDirection);
    compareModal.classList.remove("hidden");
  }

  function closeCompareModal() {
    compareModal?.classList.add("hidden");
  }

  function renderCompareBlock() {
    if (!compareBlock) return;
    const flights = Array.from(compareIds)
      .map((id) => findFlightById(id))
      .filter(Boolean);
    if (!flights.length) {
      compareBlock.classList.add("hidden");
      compareBlock.innerHTML = "";
      return;
    }
    compareBlock.classList.remove("hidden");
    compareBlock.innerHTML = `
            <div class="section-header">
              <div class="section-title" style="margin-top:0">Сравнение</div>
              <button type="button" class="section-close" id="compareClear" aria-label="Очистить сравнение">×</button>
            </div>
          `;
    const list = document.createElement("div");
    list.className = "compare-list";
    flights.forEach((flight) => renderMiniCard(list, flight));
    compareBlock.appendChild(list);
    if (flights.length >= 2) {
      const actions = document.createElement("div");
      actions.className = "compare-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary btn-sm";
      btn.textContent = "Сравнить выбранные";
      btn.addEventListener("click", openCompareModal);
      actions.appendChild(btn);
      compareBlock.appendChild(actions);
    }
    compareBlock
      .querySelector("#compareClear")
      ?.addEventListener("click", clearCompareSelection);
  }

  function highlightResultCard(flightId) {
    if (!flightId) return;
    const selector = `.result[data-id="${CSS?.escape ? CSS.escape(flightId) : flightId}"]`;
    const node = document.querySelector(selector);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    node.classList.add("highlighted");
    setTimeout(() => node.classList.remove("highlighted"), 1800);
  }

  function renderYuviaTop(list, presetTop) {
    if (!yuviaTopBlock || !yuviaTopList || !yuviaTopSubtitle) return;
    if (!list.length) {
      yuviaTopBlock.classList.add("hidden");
      yuviaTopList.innerHTML = "";
      currentTopFlights = [];
      return;
    }

    const top = presetTop?.length ? presetTop : getYuviaTop3(list);
    currentTopFlights = top;
    if (!top.length) {
      yuviaTopBlock.classList.add("hidden");
      yuviaTopList.innerHTML = "";
      return;
    }

    yuviaTopBlock.classList.remove("hidden");
    yuviaTopSubtitle.textContent = yuviaTopSubtitleText;
    yuviaTopList.innerHTML = "";

    top.forEach((flight) => {
      const card = document.createElement("article");
      card.className = "topcard";
      card.dataset.id = flight.id;

      const outboundSlice = getDirectionSlice(flight, "outbound");
      const hasReturnSegment = Boolean(
        flight.return && flight.return.durationMinutes,
      );
      const returnSlice = hasReturnSegment
        ? getDirectionSlice(flight, "return")
        : null;

      const originCity =
        getCityName(outboundSlice.originAirport) ||
        outboundSlice.originCity ||
        flight.originCity ||
        formState.originName ||
        "";
      const destCity =
        getCityName(outboundSlice.destAirport) ||
        outboundSlice.destCity ||
        flight.destCity ||
        formState.destName ||
        "";
      const originCode = outboundSlice.originAirport || flight.originAirport || "";
const destCode = outboundSlice.destAirport || flight.destAirport || "";


      const routeLine =
        [originCity, destCity].filter(Boolean).join(" → ") || "Маршрут";

      const airportLine = [
        formatAirport(outboundSlice.originAirport),
        formatAirport(outboundSlice.destAirport),
      ]
        .filter(Boolean)
        .join(" · ");

      const outboundDuration = outboundSlice.durationMinutes;
      const returnDuration = hasReturnSegment
        ? returnSlice.durationMinutes
        : null;
      const primaryDurationText = formatDuration(outboundDuration);
      const totalDurationMinutes =
        outboundDuration && returnDuration
          ? outboundDuration + returnDuration
          : null;
      const transfersText = formatTransfers(outboundSlice.transfers);

      const airlineCode =
        Array.isArray(flight.airlinesAll) && flight.airlinesAll.length
          ? flight.airlinesAll[0]
          : flight.airlineCode || flight.airline;
      const airlineName = resolveAirlineName(
        airlineCode,
        flight.airlineName,
        flight.airlineName || flight.airline,
      );
      const airlineLine = airlineName
        ? airlineCode
          ? `${airlineName} (${airlineCode})`
          : airlineName
        : airlineCode || "";

      const ticketUrl =
        flight.aviasalesTicketUrl ||
        flight.aviasalesSearchUrl ||
        flight.deeplink ||
        null;

      const stressText = getStressText(flight.stressLevel);
      const currency = flight.currency || lastCurrency;

card.innerHTML = `
  <div class="container first">
    <div class="top left corner"></div>
    <div class="top right corner"></div>
    <div class="bottom left corner"></div>
    <div class="bottom right corner"></div>

    <div class="spacer">
     <!-- 1. Лейбл (ЗОЛОТАЯ СЕРЕДИНА / САМЫЙ БЫСТРЫЙ и т.п.) -->
     <div class="ticket-label">
      ${(flight.topLabel || "Рекомендация Yuvia").toUpperCase()}
      
  <!-- 2. Города + самолётик -->
  <div class="ticket-route-row">
    <!-- Левый город (откуда) -->
    <div class="ticket-city ticket-city--from">
      <div class="ticket-city-code">${originCode || "—"}</div>
      <div class="ticket-city-name">${originCity}</div>
    </div>

    <!-- Самолётик по центру -->
    <div class="ticket-plane">✈</div>

    <!-- Правый город (куда) -->
    <div class="ticket-city ticket-city--to">
      <div class="ticket-city-code">${destCode || "—"}</div>
      <div class="ticket-city-name">${destCity}</div>
      </div>
    </div>
  </div>

  <div class="container second">
    <div class="top left corner"></div>
    <div class="top right corner"></div>
    <div class="bottom left corner"></div>
    <div class="bottom right corner"></div>

    <div class="spacer2">
      <!-- нижняя часть билета (stub), наполнение тоже потом -->
    </div>
  </div>
`;



      const openBtn = card.querySelector('[data-action="open-in-results"]');
      openBtn?.addEventListener("click", () => highlightResultCard(flight.id));

      yuviaTopList.appendChild(card);
    });
  }

  async function navigateToResults(event) {
    event?.preventDefault();
    const originCity = getOriginValue();
    const destCity = getDestinationValue();
    if (!originCity || !destCity) {
      alert("Укажи города вылета и прилёта");
      return;
    }
    const departDate = normalizeDepartDate();
    if (!departDate) {
      alert("Укажи дату вылета");
      return;
    }
    const isOneway = getOnewayFlag();
    const returnDate = isOneway ? null : normalizeReturnDate();
    if (!isOneway && !returnDate) {
      alert("Укажи дату возвращения или включи one-way");
      return;
    }
    if (!originIATA) {
      const cities = await suggestCity(originCity);
      originIATA = cities[0]?.code || "";
    }
    if (!destIATA) {
      const cities = await suggestCity(destCity);
      destIATA = cities[0]?.code || "";
    }

    const params = new URLSearchParams({
      originIata: originIATA,
      destIata: destIATA,
      originName: originCity,
      destName: destCity,
      depart: toISO(departDate),
      ret: returnDate ? toISO(returnDate) : "",
      oneway: isOneway ? "yes" : "no",
      adults: String(paxState.adults),
      children: String(paxState.children),
      infants: String(paxState.infants),
      cabin: paxState.cabin,
      style: tripState.style || "",
    });
    const triggersSelected = Object.entries(tripState.triggers)
      .filter(([, value]) => value)
      .map(([key]) => key);
    if (triggersSelected.length) {
      params.set("triggers", triggersSelected.join(","));
    }

    location.href = `results.html?${params.toString()}`;
  }

  async function doSearch(event) {
    event?.preventDefault();
    lastSearchSuccess = false;
    const originCity = getOriginValue();
    const destCity = getDestinationValue();
    if (!originCity || !destCity) {
      alert("Укажи города вылета и прилёта");
      return;
    }
    const departDate = normalizeDepartDate();
    if (!departDate) {
      alert("Укажи дату вылета");
      return;
    }
    const isOneway = getOnewayFlag();
    const returnDate = isOneway ? null : normalizeReturnDate();
    if (!isOneway && !returnDate) {
      alert("Укажи дату возвращения или включи one-way");
      return;
    }
    const passengers = paxState.adults + paxState.children + paxState.infants;
    const oneway = isOneway;
    hasSearched = true;
    updatePostSearchLayout();
    setLoading(true);
    try {
      if (!originIATA) {
        const cities = await suggestCity(originCity);
        originIATA = cities[0]?.code || "";
      }
      if (!destIATA) {
        const cities = await suggestCity(destCity);
        destIATA = cities[0]?.code || "";
      }
      if (!originIATA || !destIATA) {
        throw new Error("iata missing");
      }
      lastCurrency = getCurrencyValue();
      lastSearchContext = {
        origin: originIATA,
        destination: destIATA,
        departDate,
        returnDate,
        oneway: isOneway,
        adults: paxState.adults || 1,
        currency: lastCurrency,
      };
      const searchParams = buildSearchQuery({
        origin: originIATA,
        destination: destIATA,
        currency: lastCurrency,
        departDate,
        returnDate,
        oneway,
        adults: paxState.adults,
        children: paxState.children,
        infants: paxState.infants,
        cabin: paxState.cabin,
      });
      const searchURL = API_SEARCH_PATH + "?" + searchParams.toString();

      let searchPayload;
      try {
        searchPayload = await callJSON(searchURL);
      } catch (e) {
        console.error("[Yuvia] doSearch error", e);
        alert("Не получилось получить рейсы. Попробуй снова.");
        setLoading(false);
        return;
      }

      let matrixPayload = null;
      try {
        const matrixParams = new URLSearchParams({
          origin: originIATA,
          destination: destIATA,
          currency: lastCurrency,
          center: toISO(departDate),
        });
        const matrixURL = API_MATRIX_PATH + "?" + matrixParams.toString();
        matrixPayload = await callJSON(matrixURL);
      } catch (error) {
        console.error("matrix error", error);
      }

      const context = {
        origin: originIATA,
        destination: destIATA,
        originCity,
        destCity,
        departDate,
        returnDate,
        currency: lastCurrency,
        passengers,
        oneway,
      };

      const flightsRaw = Array.isArray(searchPayload && searchPayload.data)
        ? searchPayload.data
        : [];

      console.log("[Yuvia] flightsRaw length =", flightsRaw.length);

      allResults = flightsRaw
        .map((item, index) =>
          normalizeFlight(item, {
            ...context,
            fallbackId: `${originIATA}-${destIATA}-${index}`,
          }),
        )
        .filter((flight) => flight && flight.price > 0);

      recalculateScores(allResults);

      updateFilterOptions();
      matrixData = normalizeMatrixResponse(matrixPayload);
      renderPriceMatrix(matrixData, toISO(departDate));
      applyFiltersAndSort();
      updateSearchSummary();
      lastSearchSuccess = true;
      saveRecent({
        origin: originCity,
        destination: destCity,
        depart: toISO(departDate),
        returnDate: returnDate ? toISO(returnDate) : "",
        originIata: originIATA,
        destIata: destIATA,
      });
    } catch (error) {
      console.error("search error", error);
      alert("Не получилось получить рейсы. Попробуй снова.");
      matrixData = [];
      renderPriceMatrix(matrixData, toISO(departDate));
    } finally {
      setLoading(false);
    }
  }

  async function applyInlineSearch(event) {
    await doSearch(event);
    if (lastSearchSuccess) {
      inlineSnapshot = captureInlineSnapshot();
      hideSearchInlineEditor({ restore: false });
    }
  }

  function applyTripStateToUI() {
    if (tripState.style) {
      $$(".chip-style").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.style === tripState.style);
      });
    }
    Object.entries(tripState.triggers).forEach(([key, value]) => {
      const chip = document.querySelector(`[data-trigger="${key}"]`);
      chip?.classList.toggle("active", !!value);
    });
  }

  function initFromQueryParams() {
    const params = new URLSearchParams(window.location.search || "");
    const originName = params.get("originName") || "";
    const destName = params.get("destName") || "";
    const depart = params.get("depart") || "";
    const ret = params.get("ret") || "";
    const onewayParam = (params.get("oneway") || "").toLowerCase();
    const isOneway =
      onewayParam === "yes" || onewayParam === "true" || onewayParam === "1";
    setOriginValue(originName);
    setDestinationValue(destName);
    setDepartValue(depart || null);
    setReturnValue(ret || null);
    setOnewayFlag(isOneway);

    originIATA = params.get("originIata") || "";
    destIATA = params.get("destIata") || "";

    paxState.adults = Number(params.get("adults")) || paxState.adults;
    paxState.children = Number(params.get("children")) || paxState.children;
    paxState.infants = Number(params.get("infants")) || paxState.infants;
    paxState.cabin = params.get("cabin") || paxState.cabin;

    tripState.style = params.get("style") || null;
    const triggers = params.get("triggers");
    if (triggers) {
      triggers.split(",").forEach((key) => {
        if (tripState.triggers.hasOwnProperty(key)) {
          tripState.triggers[key] = true;
        }
      });
    }
    applyTripStateToUI();
    updateReturnControlState();
    updatePaxSummary();
    updateSearchSummary();
  }

  function initTripPreferenceChips() {
    $$(".chip-style").forEach((chip) => {
      chip.addEventListener("click", () => {
        const wasActive = chip.classList.contains("active");
        $$(".chip-style").forEach((el) => el.classList.remove("active"));
        if (wasActive) {
          tripState.style = null;
        } else {
          chip.classList.add("active");
          tripState.style = chip.dataset.style || null;
        }
        if (allResults.length) {
          applyFiltersAndSort();
        }
      });
    });
    $$("#tripTriggerChips .chip-toggle").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.trigger;
        if (!key) return;
        chip.classList.toggle("active");
        tripState.triggers[key] = chip.classList.contains("active");
        if (allResults.length) {
          applyFiltersAndSort();
        }
      });
    });
  }

  function attachFiltersHandlers() {
    const handleFilterChange = () => {
      applyFiltersAndSort();
      updateActiveFiltersCount();
    };

    [priceMinInput, priceMaxInput].forEach((input) => {
      input?.addEventListener("input", () => {
        handleFilterChange();
      });
    });
    [originAirportFilter, destinationAirportFilter].forEach((container) => {
      container?.addEventListener("change", () => {
        handleFilterChange();
      });
    });
    durMaxInput?.addEventListener("input", () => {
      updateDurationDisplay();
      handleFilterChange();
    });
    document
      .querySelectorAll(".depwin-outbound, .depwin-return")
      .forEach((checkbox) => {
        checkbox.addEventListener("change", handleFilterChange);
      });
    airlineFilter?.addEventListener("change", handleFilterChange);
    document.querySelectorAll('input[name="stops"]').forEach((radio) => {
      radio.addEventListener("change", handleFilterChange);
    });
    $("#clearFilters")?.addEventListener("click", (event) => {
      event.preventDefault();
      clearFilters();
    });
    filtersToggle?.addEventListener("click", () => {
      document.body.classList.add("filters-open");
      filtersOverlay?.classList.remove("hidden");
    });
    filtersClose?.addEventListener("click", () => {
      document.body.classList.remove("filters-open");
      filtersOverlay?.classList.add("hidden");
    });
    filtersOverlay?.addEventListener("click", () => {
      document.body.classList.remove("filters-open");
      filtersOverlay?.classList.add("hidden");
    });
    filtersApply?.addEventListener("click", () => {
      handleFilterChange();
      document.body.classList.remove("filters-open");
      filtersOverlay?.classList.add("hidden");
    });
    durationResetBtn?.addEventListener("click", () => {
      if (durMaxInput) {
        durMaxInput.value = durMaxInput.max || durMaxInput.value || "";
        updateDurationDisplay();
      }
      handleFilterChange();
    });
    updateDurationDisplay();
    updateActiveFiltersCount();
    $("#sortBy")?.addEventListener("change", () => applyFiltersAndSort());
  }

  function navigateBackToSearch(event) {
    event?.preventDefault();
    const targetHref = backToSearchLink?.getAttribute("href") || "search.html";
    window.location.href = targetHref;
  }

  function attachGeneralHandlers() {
    window.addEventListener("resize", repositionInlinePopover);
    mobileInlineQuery?.addEventListener?.("change", repositionInlinePopover);
    window.addEventListener("scroll", repositionInlinePopover, true);
    swapBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      const tmp = originInput.value;
      originInput.value = destinationInput.value;
      destinationInput.value = tmp;
      formState.originName = originInput.value.trim();
      formState.destName = destinationInput.value.trim();
      [originIATA, destIATA] = [destIATA, originIATA];
      updateSearchSummary();
    });
    originInput?.addEventListener("input", () => {
      originIATA = "";
      formState.originName = originInput.value.trim();
      updateSearchSummary();
    });
    destinationInput?.addEventListener("input", () => {
      destIATA = "";
      formState.destName = destinationInput.value.trim();
      updateSearchSummary();
    });
    departInput?.addEventListener("change", () => {
      formState.departDate = parseDateValue(departInput.value) || null;
      normalizeDepartDate();
      normalizeReturnDate();
      updateSearchSummary();
    });
    returnInput?.addEventListener("change", () => {
      formState.returnDate = parseDateValue(returnInput.value) || null;
      normalizeReturnDate();
      updateSearchSummary();
    });
    onewayControl?.addEventListener("change", () => {
      formState.oneway = !!onewayControl.checked;
      updateReturnControlState();
      updateSearchSummary();
    });
    const doSearchBtn = $("#doSearch");
    if (doSearchBtn) {
      doSearchBtn.addEventListener(
        "click",
        isResultsPage ? doSearch : navigateToResults,
      );
    }
    $$("[data-inline-action='apply']").forEach((btn) =>
      btn.addEventListener("click", applyInlineSearch),
    );
    $$("[data-inline-action='cancel']").forEach((btn) =>
      btn.addEventListener("click", () => hideSearchInlineEditor()),
    );
    searchSummaryAction?.addEventListener("click", (event) => {
      const segment = event.target.closest?.(".search-summary-segment");
      if (segment) {
        toggleSearchInlineEditor(segment.dataset.target || "route");
      }
    });
    searchSummaryAction?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        const segment = event.target.closest?.(".search-summary-segment");
        if (segment) {
          event.preventDefault();
          toggleSearchInlineEditor(segment.dataset.target || "route");
        }
      }
    });
    searchInlineEditor?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSearchInlineEditor();
      }
    });
    searchOverlay?.addEventListener("click", (event) => {
      if (event.target === searchOverlay) {
        hideSearchInlineEditor();
      }
    });
    document.addEventListener("click", (event) => {
      if (
        !searchInlineEditor ||
        searchInlineEditor.classList.contains("hidden")
      )
        return;
      const insideEditor = event.target.closest?.("#searchInlineEditor");
      const insideSegment = event.target.closest?.(".search-summary-segment");
      const insidePax = paxPanel?.contains(event.target);
      const insideSuggest = event.target.closest?.(".suggest-panel");
      if (!insideEditor && !insideSegment && !insidePax && !insideSuggest) {
        hideSearchInlineEditor();
      }
    });
    backToSearchLink?.addEventListener("click", navigateBackToSearch);
    compareClose?.addEventListener("click", closeCompareModal);
    compareModalDismiss?.addEventListener("click", closeCompareModal);
    compareModal?.addEventListener("click", (event) => {
      if (event.target === compareModal) {
        closeCompareModal();
      }
    });
  }

  function closeAllTooltips() {
    document.querySelectorAll(".tooltip-popover").forEach((popover) => {
      popover.classList.remove("visible");
    });
    document.querySelectorAll(".tooltip-trigger").forEach((trigger) => {
      trigger.classList.remove("active");
    });
  }

  function positionTooltipPopover(trigger, popover) {
    if (!trigger || !popover) return;
    const width = Math.min(340, Math.max(280, popover.offsetWidth || 320));
    popover.style.width = `${width}px`;
    popover.classList.add("floating");
    if (popover.parentElement !== document.body) {
      document.body.appendChild(popover);
    }
    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(
      margin,
      Math.min(
        window.innerWidth - width - margin,
        rect.left + rect.width / 2 - width / 2,
      ),
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom + 8}px`;
  }

  function initTooltips() {
    document.addEventListener("click", (event) => {
      const trigger = event.target.closest?.(".tooltip-trigger");
      const insidePopover = event.target.closest?.(".tooltip-popover");
      if (trigger) {
        const badge = trigger.closest(".badge-with-tooltip");
        const popover = badge?.querySelector(".tooltip-popover");
        const isOpen = popover?.classList.contains("visible");
        closeAllTooltips();
        if (popover && !isOpen) {
          positionTooltipPopover(trigger, popover);
          popover.classList.add("visible");
          trigger.classList.add("active");
        }
        return;
      }
      if (!insidePopover) {
        closeAllTooltips();
      }
    });
  }

  function analyzeIntent(text, context) {
    const lower = text.toLowerCase();

    if (lower.includes("поезд") || lower.includes("электричк")) {
      context.transport = "train";
    } else if (
      lower.includes("самолёт") ||
      lower.includes("самолет") ||
      lower.includes("авиа")
    ) {
      context.transport = "plane";
    } else if (lower.includes("автобус")) {
      context.transport = "bus";
    } else if (lower.includes("без самол")) {
      context.transport = "no_plane";
    }

    if (lower.includes("море") || lower.includes("пляж")) context.mood = "sea";
    if (lower.includes("горы") || lower.includes("тропы"))
      context.mood = "mountains";
    if (lower.includes("город")) context.mood = "city";
    if (lower.includes("северн") && lower.includes("сияни"))
      context.mood = "northern_lights";
    if (lower.includes("байкал")) context.mood = "baikal";

    const fromMatch = text.match(/\bиз\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)/);
    if (fromMatch && !context.from) {
      context.from = fromMatch[1].trim();
    }
    const toMatch = text.match(/\bв\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)/);
    if (
      toMatch &&
      !context.to &&
      !lower.includes("куда-нибудь") &&
      !lower.includes("куда нибудь")
    ) {
      context.to = toMatch[1].trim();
    }

    if (!context.when) {
      if (lower.includes("выходные")) context.when = "на ближайшие выходные";
      else if (lower.includes("май")) context.when = "в мае";
      else if (lower.includes("июнь")) context.when = "в июне";
      else if (lower.includes("завтра")) context.when = "завтра";
      else if (lower.includes("на недел")) context.when = "на неделю";
    }
  }

  function goToSearch(context) {
    const params = new URLSearchParams();
    if (context.from) params.set("from", context.from);
    if (context.to) params.set("to", context.to);
    if (context.when) params.set("when", context.when);
    if (context.mood) params.set("mood", context.mood);
    if (context.transport) params.set("transport", context.transport);
    window.location.href = "search.html?" + params.toString();
  }

  function goToIdeas(context) {
    const params = new URLSearchParams();
    if (context.from) params.set("from", context.from);
    if (context.when) params.set("when", context.when);
    params.set("mood", context.mood || "any");
    window.location.href = "ideas.html?" + params.toString();
  }

  function renderState(dialogEl, state, context, onInput) {
    if (!dialogEl) return;
    dialogEl.innerHTML = "";

    const panel = document.createElement("div");
    panel.className = "yuvia-panel";

    const progressBadges = [];
    if (context.from) progressBadges.push(`Откуда: ${context.from}`);
    if (context.to) progressBadges.push(`Куда: ${context.to}`);
    else if (context.mood) progressBadges.push(`Настроение: ${context.mood}`);
    if (context.when) progressBadges.push(`Когда: ${context.when}`);
    if (context.transport)
      progressBadges.push(`Транспорт: ${context.transport}`);

    if (progressBadges.length) {
      const progress = document.createElement("div");
      progress.className = "yuvia-panel-progress";
      progressBadges.forEach((badge) => {
        const span = document.createElement("span");
        span.textContent = badge;
        progress.appendChild(span);
      });
      panel.appendChild(progress);
    }

    const question = document.createElement("div");
    question.className = "yuvia-panel-question";

    const optionsWrap = document.createElement("div");
    optionsWrap.className = "yuvia-panel-options";

    const lastInput = context.rawInputs[context.rawInputs.length - 1] || "";
    const lastInputLower = lastInput.toLowerCase();

    if (state === "initial" || (state === "clarify_from" && !context.from)) {
      question.textContent =
        "Приняла запрос, давай зафиксируем точку старта. Из какого города выезжаешь?";
      if (lastInput && lastInputLower.includes("моск")) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "yuvia-option";
        btn.textContent = "Это Москва";
        btn.addEventListener("click", () => onInput("Из Москвы"));
        optionsWrap.appendChild(btn);
      }
    } else if (state === "clarify_to_or_mood") {
      question.textContent =
        "Хочу понять направление. Больше тянет к морю, в горы или в города?";
      [
        "К морю",
        "В горы",
        "По городам",
        "Сам придумаю, давай просто билеты",
      ].forEach((label) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "yuvia-option";
        btn.textContent = label;
        btn.addEventListener("click", () => onInput(label));
        optionsWrap.appendChild(btn);
      });
    } else if (state === "clarify_dates") {
      question.textContent = "На какие даты примерно смотрим эту поездку?";
      [
        "На ближайшие выходные",
        "В этом месяце",
        "В ближайшие каникулы",
      ].forEach((label) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "yuvia-option";
        btn.textContent = label;
        btn.addEventListener("click", () => onInput(label));
        optionsWrap.appendChild(btn);
      });
    } else if (state === "summary") {
      question.textContent =
        "Собрала картину поездки. Дальше могу открыть форму поиска или подсказать идеи.";
      const searchBtn = document.createElement("button");
      searchBtn.type = "button";
      searchBtn.className = "yuvia-option";
      searchBtn.textContent = "Перейти к поиску билетов";
      searchBtn.addEventListener("click", () => goToSearch(context));
      optionsWrap.appendChild(searchBtn);

      if (!context.to && context.mood) {
        const ideasBtn = document.createElement("button");
        ideasBtn.type = "button";
        ideasBtn.className = "yuvia-option";
        ideasBtn.textContent = "Посмотреть идеи направлений";
        ideasBtn.addEventListener("click", () => goToIdeas(context));
        optionsWrap.appendChild(ideasBtn);
      }

      const restartBtn = document.createElement("button");
      restartBtn.type = "button";
      restartBtn.className = "yuvia-option";
      restartBtn.textContent = "Начать сначала";
      restartBtn.addEventListener("click", () => {
        context.rawInputs = [];
        context.from = null;
        context.to = null;
        context.when = null;
        context.mood = null;
        context.transport = null;
        state = STATE.INITIAL;
        askFromAttempts = 0;
        renderState(dialogEl, "initial", context, onInput);
      });
      optionsWrap.appendChild(restartBtn);
    }

    panel.appendChild(question);
    panel.appendChild(optionsWrap);
    dialogEl.appendChild(panel);
  }

  function initYuviaConversation() {
    const dialogEl = document.getElementById("yuviaDialog");
    const chipsEl = document.getElementById("yuviaChips");
    const formEl = document.getElementById("yuviaInputForm");
    const inputEl = document.getElementById("yuviaUserInput");

    const STATE = {
      INITIAL: "initial",
      CLARIFY_FROM: "clarify_from",
      CLARIFY_TO_OR_MOOD: "clarify_to_or_mood",
      CLARIFY_DATES: "clarify_dates",
      SUMMARY: "summary",
    };

    const context = {
      rawInputs: [],
      from: null,
      to: null,
      when: null,
      mood: null,
      transport: null,
    };

    let state = STATE.INITIAL;
    let askFromAttempts = 0;

    if (chipsEl) {
      chipsEl.querySelectorAll(".yuvia-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const text = chip.getAttribute("data-text") || chip.textContent;
          handleUserInput(text);
        });
      });
    }

    if (formEl && inputEl) {
      formEl.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = inputEl.value.trim();
        if (!text) return;
        inputEl.value = "";
        handleUserInput(text);
      });
    }

    renderState(dialogEl, state, context, handleUserInput);

    function handleUserInput(text) {
      const userText = String(text || "").trim();
      if (!userText) return;

      context.rawInputs.push(userText);
      analyzeIntent(userText, context);

      if (!context.from) {
        state = STATE.CLARIFY_FROM;
        askFromAttempts += 1;
      } else if (!context.to && !context.mood) {
        state = STATE.CLARIFY_TO_OR_MOOD;
      } else if (!context.when) {
        state = STATE.CLARIFY_DATES;
      } else {
        state = STATE.SUMMARY;
      }

      if (state === STATE.CLARIFY_FROM && askFromAttempts > 2) {
        state = STATE.SUMMARY;
      }

      renderState(dialogEl, state, context, handleUserInput);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const shell = document.getElementById("yuviaShell");
    if (!shell) return;
    initYuviaConversation();
  });

  function initSuggests() {
    attachSuggest(originInput, handleSuggestPick("origin"));
    attachSuggest(destinationInput, handleSuggestPick("destination"));
  }

  async function init() {
    if (isSearchPage) {
      initMinDateHints();
      initPaxFromAdultsSelect();
      handlePaxButtons();
      await loadDicts();
      initSuggests();
      initTripPreferenceChips();
      applyTripStateToUI();
      attachGeneralHandlers();
      initTooltips();
      renderRecent();
      updateSearchSummary();
      return;
    }

    if (isResultsPage) {
      await loadDicts();
      initMinDateHints();
      initPaxFromAdultsSelect();
      handlePaxButtons();
      initSuggests();
      initTripPreferenceChips();
      initFromQueryParams();
      applyTripStateToUI();
      attachFiltersHandlers();
      attachGeneralHandlers();
      initTooltips();
      updatePostSearchLayout();
      const hasOrigin = !!(originIATA || getOriginValue());
      const hasDest = !!(destIATA || getDestinationValue());
      const hasDepart = !!getDepartValue();
      if (hasOrigin && hasDest && hasDepart) {
        await doSearch();
      }
      return;
    }

    initTooltips();
  }

  init();
})();
