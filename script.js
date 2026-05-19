const map = L.map("map", {
  center: [18, 8],
  zoom: 2,
  minZoom: 2,
  maxZoom: 8,
  zoomSnap: 1,
  zoomDelta: 1,
  zoomControl: true,
  attributionControl: false,
  scrollWheelZoom: true,
  worldCopyJump: false,
  maxBoundsViscosity: 1
});

map.createPane("stripePane");
map.getPane("stripePane").style.zIndex = 180;
map.getPane("stripePane").style.pointerEvents = "none";

map.createPane("gridPane");
map.getPane("gridPane").style.zIndex = 220;
map.getPane("gridPane").style.pointerEvents = "none";

const worldBounds = [
  [-72, -180],
  [82, 180]
];

const initialMapBounds = [
  [-58, -176],
  [76, 176]
];

function resetMapView() {
  map.invalidateSize();
  map.fitBounds(initialMapBounds, {
    padding: [28, 28],
    maxZoom: 2,
    animate: true
  });
}

resetMapView();
map.setMaxBounds(worldBounds);

const ResetHomeControl = L.Control.extend({
  options: {
    position: "topleft"
  },

  onAdd: function () {
    const button = L.DomUtil.create("button", "leaflet-control-home");
    button.type = "button";
    button.title = "Reset map view";
    button.setAttribute("aria-label", "Reset map view");
    button.innerHTML = "⌂";

    L.DomEvent.disableClickPropagation(button);
    L.DomEvent.on(button, "click", function (event) {
      L.DomEvent.preventDefault(event);
      resetMapView();
      closeActiveTooltip();
      clearDelayedHover();
      clearClickedEffect();
      hoveredLayer = null;
      hoveredTimezone = null;
      updateInfoPanel(null);
      resetCountryInfo();
    });

    return button;
  }
});

map.addControl(new ResetHomeControl());

const gmtTimeElement = document.getElementById("gmt-time");
const infoElement = document.getElementById("timezone-info");
const topOffsetBar = document.getElementById("top-offset-bar");
const offsetBar = document.getElementById("offset-bar");
const countryInfoElement = document.getElementById("country-info");
const countryTitleElement = document.getElementById("country-title");
const infoPanel = document.querySelector(".info-panel");

let timezoneLayer;

let hoveredLayer = null;
let hoveredTimezone = null;

let resetPanelTimeout = null;
let isMouseOnInfoPanel = false;

let tooltipShowTimeout = null;
let activeTooltipLayer = null;

let clickedLayer = null;
let clickedTimezone = null;
let clickedEffectTimeout = null;

let clickedVisualActive = false;
let clickedEffectPinnedByPanel = false;

let hoverOutlineTimeout = null;
let outlinedHoverLayer = null;

let returnToMapPanelResetTimeout = null;
let isWaitingToResetPanelAfterMapReturn = false;

let isCountryClickLocked = false;
let delayedHoverTimeout = null;
let pendingHoverLayer = null;
let pendingHoverTimezone = null;

let capitalCityLayer = L.layerGroup();
let capitalCitiesLoaded = false;

let countryPhotoSubjects = {};
const countryCache = new Map();

const CAPITAL_CITY_ZOOM_LEVEL = 5;
const PANEL_RESET_DELAY = 7000;
const TOOLTIP_SHOW_DELAY = 500;
const POST_CLICK_HOVER_DELAY = 500;

const CLICKED_EFFECT_DURATION = 5000;
const HOVER_OUTLINE_DURATION = 2000;
const RETURN_TO_MAP_PANEL_RESET_DELAY = 3000;

// ---------- TIME ----------

function updateGMTClock() {
  const now = new Date();

  const gmtTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(now);

  gmtTimeElement.textContent = gmtTime;
}

function getTimezoneName(feature) {
  return (
    feature.properties.tzid ||
    feature.properties.TZID ||
    feature.properties.timezone ||
    feature.properties.name ||
    "Unknown timezone"
  );
}

function getTimeInTimezone(timezone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());
  } catch {
    return "Invalid timezone";
  }
}

function getOffsetInfo(timezone, date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset"
    });

    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find(part => part.type === "timeZoneName");

    if (!offsetPart) {
      return { text: "Unknown", hours: 0 };
    }

    const text = offsetPart.value;

    if (text === "GMT") {
      return { text: "GMT+00:00", hours: 0 };
    }

    const match = text.match(/GMT([+-])(\d{2}):?(\d{2})?/);

    if (!match) {
      return { text, hours: 0 };
    }

    const sign = match[1] === "+" ? 1 : -1;
    const hrs = Number(match[2]);
    const mins = Number(match[3] || 0);
    const decimal = sign * (hrs + mins / 60);

    return {
      text: `GMT${match[1]}${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}`,
      hours: decimal
    };
  } catch {
    return { text: "Unknown", hours: 0 };
  }
}

function getSeasonalTimeStatus(timezone) {
  try {
    const now = new Date();
    const year = now.getFullYear();

    const januaryOffset = getOffsetInfo(
      timezone,
      new Date(Date.UTC(year, 0, 1))
    ).hours;

    const julyOffset = getOffsetInfo(
      timezone,
      new Date(Date.UTC(year, 6, 1))
    ).hours;

    const currentOffset = getOffsetInfo(timezone, now).hours;

    if (januaryOffset === julyOffset) {
      return {
        label: "Seasonal time",
        value: "No daylight saving adjustment"
      };
    }

    const standardOffset = Math.min(januaryOffset, julyOffset);

    if (currentOffset > standardOffset) {
      return {
        label: "Seasonal time",
        value: "Daylight Saving Time"
      };
    }

    return {
      label: "Seasonal time",
      value: "Standard Time"
    };
  } catch {
    return {
      label: "Seasonal time",
      value: "Unknown"
    };
  }
}

// ---------- COLORS ----------

function getColorFromOffsetHours(offsetHours) {
  const palette = {
    "-12": "#f08a5d",
    "-11": "#f6c177",
    "-10": "#8ecae6",
    "-9": "#b39ddb",
    "-8": "#ef6f6c",
    "-7": "#f4a261",
    "-6": "#e9d48a",
    "-5": "#9ecb8f",
    "-4": "#7fb3d5",
    "-3": "#a28cc8",
    "-2": "#ea6b66",
    "-1": "#f0905a",
    "0": "#e9d48a",
    "1": "#9ecb8f",
    "2": "#7fb3d5",
    "3": "#a28cc8",
    "4": "#ea6b66",
    "5": "#f0905a",
    "6": "#e9d48a",
    "7": "#9ecb8f",
    "8": "#7fb3d5",
    "9": "#a28cc8",
    "10": "#ea6b66",
    "11": "#f0905a",
    "12": "#e9d48a",
    "13": "#9ecb8f",
    "14": "#7fb3d5"
  };

  const rounded = String(Math.round(offsetHours));
  return palette[rounded] || "#cbd5e1";
}

function hexToRgb(hex) {
  const cleaned = hex.replace("#", "");

  return {
    r: parseInt(cleaned.substring(0, 2), 16),
    g: parseInt(cleaned.substring(2, 4), 16),
    b: parseInt(cleaned.substring(4, 6), 16)
  };
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map(value => {
        const hex = Math.max(0, Math.min(255, value)).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

function intensifyColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const factor = 1.45;

  const newR = Math.round(128 + (r - 128) * factor);
  const newG = Math.round(128 + (g - 128) * factor);
  const newB = Math.round(128 + (b - 128) * factor);

  return rgbToHex(newR, newG, newB);
}

// ---------- COUNTRY BASE MAP REMOVED ----------

function loadCountryOutlineMap() {
  return;
}

// ---------- SVG STRIPE EFFECT ----------

function ensureSvgDefs() {
  const svg = map.getPanes().overlayPane.querySelector("svg");

  if (!svg) return null;

  let defs = svg.querySelector("defs");

  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  return defs;
}

function createStripePattern(baseColor) {
  const defs = ensureSvgDefs();

  if (!defs) {
    return baseColor;
  }

  const intenseColor = intensifyColor(baseColor);
  const patternId = `clicked-stripes-${baseColor.replace("#", "")}`;

  if (!document.getElementById(patternId)) {
    const pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
    pattern.setAttribute("id", patternId);
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    pattern.setAttribute("width", "12");
    pattern.setAttribute("height", "12");
    pattern.setAttribute("patternTransform", "rotate(45)");

    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("width", "12");
    background.setAttribute("height", "12");
    background.setAttribute("fill", intenseColor);

    const stripe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    stripe.setAttribute("width", "5");
    stripe.setAttribute("height", "12");
    stripe.setAttribute("fill", "#ffffff");
    stripe.setAttribute("opacity", "0.55");

    pattern.appendChild(background);
    pattern.appendChild(stripe);
    defs.appendChild(pattern);
  }

  return `url(#${patternId})`;
}

function layerHasClickedVisual(layer) {
  return clickedVisualActive && clickedLayer === layer;
}

function removeClickedVisualEffect() {
  if (clickedEffectTimeout) {
    clearTimeout(clickedEffectTimeout);
    clickedEffectTimeout = null;
  }

  if (clickedLayer && timezoneLayer) {
    timezoneLayer.resetStyle(clickedLayer);
  }

  clickedVisualActive = false;
  clickedEffectPinnedByPanel = false;
}

function clearClickedEffect() {
  removeClickedVisualEffect();

  clickedLayer = null;
  clickedTimezone = null;
}

function showClickedEffect(layer, timezone, options = {}) {
  const shouldPin = options.pinned === true;

  if (clickedEffectTimeout) {
    clearTimeout(clickedEffectTimeout);
    clickedEffectTimeout = null;
  }

  if (clickedLayer && clickedLayer !== layer && timezoneLayer) {
    timezoneLayer.resetStyle(clickedLayer);
  }

  clickedLayer = layer;
  clickedTimezone = timezone;
  clickedVisualActive = true;

  if (shouldPin) {
    clickedEffectPinnedByPanel = true;
  }

  const offset = getOffsetInfo(timezone);
  const baseColor = getColorFromOffsetHours(offset.hours);
  const stripedFill = createStripePattern(baseColor);

  layer.setStyle({
    fillColor: stripedFill,
    fillOpacity: 0.9,
    color: "#111827",
    weight: 3,
    opacity: 1
  });

  layer.bringToFront();

  if (!shouldPin) {
    clickedEffectTimeout = setTimeout(() => {
      if (!isMouseOnInfoPanel && !clickedEffectPinnedByPanel) {
        removeClickedVisualEffect();
      }
    }, CLICKED_EFFECT_DURATION);
  }
}

// ---------- HOVER OUTLINE EFFECT ----------

function clearHoverOutlineTimeout() {
  if (hoverOutlineTimeout) {
    clearTimeout(hoverOutlineTimeout);
    hoverOutlineTimeout = null;
  }
}

function resetOutlinedHoverLayer(layer) {
  if (!layer || !timezoneLayer) return;

  if (!layerHasClickedVisual(layer)) {
    timezoneLayer.resetStyle(layer);
  }

  if (outlinedHoverLayer === layer) {
    outlinedHoverLayer = null;
  }
}

function scheduleHoverOutlineReset(layer) {
  clearHoverOutlineTimeout();

  outlinedHoverLayer = layer;

  hoverOutlineTimeout = setTimeout(() => {
    resetOutlinedHoverLayer(layer);
  }, HOVER_OUTLINE_DURATION);
}

function immediatelyRemovePanelPinnedClickEffect() {
  if (clickedEffectPinnedByPanel && clickedVisualActive) {
    removeClickedVisualEffect();
  }
}

// ---------- RETURN TO MAP PANEL RESET ----------

function cancelReturnToMapPanelReset() {
  if (returnToMapPanelResetTimeout) {
    clearTimeout(returnToMapPanelResetTimeout);
    returnToMapPanelResetTimeout = null;
  }

  isWaitingToResetPanelAfterMapReturn = false;
}

function scheduleReturnToMapPanelReset() {
  if (!clickedLayer || !clickedTimezone) return;

  if (returnToMapPanelResetTimeout) {
    clearTimeout(returnToMapPanelResetTimeout);
  }

  isWaitingToResetPanelAfterMapReturn = true;

  returnToMapPanelResetTimeout = setTimeout(() => {
    if (!isMouseOnInfoPanel) {
      clearClickedEffect();

      isCountryClickLocked = false;
      hoveredLayer = null;
      hoveredTimezone = null;

      closeActiveTooltip();
      updateInfoPanel(null);
      resetCountryInfo();
    }

    returnToMapPanelResetTimeout = null;
    isWaitingToResetPanelAfterMapReturn = false;
  }, RETURN_TO_MAP_PANEL_RESET_DELAY);
}

// ---------- HOVER LOCK AFTER CLICK ----------

function clearDelayedHover() {
  if (delayedHoverTimeout) {
    clearTimeout(delayedHoverTimeout);
    delayedHoverTimeout = null;
  }

  pendingHoverLayer = null;
  pendingHoverTimezone = null;
}

function lockClickedCountryHover(layer, timezone) {
  isCountryClickLocked = true;
  hoveredLayer = layer;
  hoveredTimezone = timezone;

  updateInfoPanel(timezone);
  setTooltipContent(layer, timezone);
}

function unlockClickedCountryHover() {
  isCountryClickLocked = false;
  clearDelayedHover();
}

function activateHover(layer, timezone) {
  cancelPanelReset();
  closeActiveTooltip();
  clearHoverOutlineTimeout();

  if (
    outlinedHoverLayer &&
    outlinedHoverLayer !== layer &&
    !layerHasClickedVisual(outlinedHoverLayer)
  ) {
    timezoneLayer.resetStyle(outlinedHoverLayer);
  }

  hoveredLayer = layer;
  hoveredTimezone = timezone;
  outlinedHoverLayer = layer;

  if (!isWaitingToResetPanelAfterMapReturn) {
    updateInfoPanel(timezone);
  }

  showTooltipAfterDelay(layer, timezone);

  if (!layerHasClickedVisual(layer)) {
    layer.setStyle({
      weight: 2.2,
      color: "#111827",
      fillOpacity: 0.84
    });
  }

  layer.bringToFront();
}

function delayedActivateHover(layer, timezone) {
  clearDelayedHover();

  pendingHoverLayer = layer;
  pendingHoverTimezone = timezone;

  delayedHoverTimeout = setTimeout(() => {
    if (
      pendingHoverLayer === layer &&
      pendingHoverTimezone === timezone &&
      !isMouseOnInfoPanel
    ) {
      unlockClickedCountryHover();
      activateHover(layer, timezone);
    }
  }, POST_CLICK_HOVER_DELAY);
}

// ---------- INFO PANEL ----------

function updateInfoPanel(timezone) {
  if (!timezone) {
    infoElement.innerHTML = `<p>Hover over the map to see timezone information.</p>`;
    return;
  }

  const localTime = getTimeInTimezone(timezone);
  const offset = getOffsetInfo(timezone);
  const seasonalStatus = getSeasonalTimeStatus(timezone);

  infoElement.innerHTML = `
    <p class="info-label">Timezone name</p>
    <p class="info-value">${timezone}</p>

    <p class="info-label">Local time</p>
    <p class="info-value big-time">${localTime}</p>

    <p class="info-label">Current offset from UTC</p>
    <p class="info-value offset">${offset.text}</p>

    <p class="info-label">${seasonalStatus.label}</p>
    <p class="info-value seasonal-status">${seasonalStatus.value}</p>
  `;
}

// ---------- COUNTRY PANEL ----------

function formatNumber(value) {
  if (value == null) return "Unknown";
  return new Intl.NumberFormat("en-US").format(value);
}

function resetCountryInfo() {
  countryTitleElement.classList.add("hidden");

  countryInfoElement.innerHTML = `
    <p>Click on a country to see a visual gallery, its flag, and a fun fact.</p>
  `;
}

function setCountryLoading() {
  countryTitleElement.classList.remove("hidden");

  countryInfoElement.innerHTML = `
    <div class="country-loading">
      Loading country information...
    </div>
  `;
}

function setCountryError(message) {
  countryTitleElement.classList.remove("hidden");

  countryInfoElement.innerHTML = `
    <div class="country-error">
      ${message}
    </div>
  `;
}

function schedulePanelReset() {
  clearTimeout(resetPanelTimeout);

  resetPanelTimeout = setTimeout(() => {
    if (!isMouseOnInfoPanel && !isCountryClickLocked) {
      hoveredLayer = null;
      hoveredTimezone = null;

      updateInfoPanel(null);
      resetCountryInfo();
    }
  }, PANEL_RESET_DELAY);
}

function cancelPanelReset() {
  clearTimeout(resetPanelTimeout);
}

function buildFunFact(countryData, wikiData) {
  if (wikiData && wikiData.extract) {
    const text = wikiData.extract.trim();
    const sentences = text.match(/[^.!?]+[.!?]+/g);

    if (sentences && sentences.length > 0) {
      return sentences.slice(0, 2).join(" ").trim();
    }

    return text;
  }

  const capital = countryData.capital?.[0] || "Unknown";
  const region = countryData.subregion || countryData.region || "Unknown region";
  const population = formatNumber(countryData.population);

  return `${countryData.name.common} is in ${region}. Its capital is ${capital}, and it has a population of about ${population}.`;
}

async function reverseGeocodeCountry(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Could not determine which country you clicked.");
  }

  const data = await response.json();

  if (!data.countryName || !data.countryCode) {
    throw new Error("No country was found at that location.");
  }

  return {
    countryName: data.countryName,
    countryCode: data.countryCode
  };
}

async function fetchCountryData(countryCode) {
  const url = `https://restcountries.com/v3.1/alpha/${countryCode}?fields=name,flags,capital,population,region,subregion,languages`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Could not load country details.");
  }

  const data = await response.json();
  return Array.isArray(data) ? data[0] : data;
}

async function fetchWikipediaSummary(countryName) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(countryName)}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

// ---------- COUNTRY GALLERY ----------

async function loadCountryPhotoSubjects() {
  try {
    const response = await fetch("Data/country_gallery_subjects.json");

    if (!response.ok) {
      throw new Error("Could not load Data/country_gallery_subjects.json");
    }

    countryPhotoSubjects = await response.json();
  } catch (error) {
    console.warn(error.message);
    countryPhotoSubjects = {};
  }
}

function normalizeCountryName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getPhotoSubjectsForCountry(countryName) {
  const exact = countryPhotoSubjects[countryName];

  if (exact) {
    return exact;
  }

  const targetName = normalizeCountryName(countryName);

  const matchedKey = Object.keys(countryPhotoSubjects).find(
    key => normalizeCountryName(key) === targetName
  );

  if (matchedKey) {
    return countryPhotoSubjects[matchedKey];
  }

  return [];
}

function isBadImageTitle(title = "") {
  const lowerTitle = title.toLowerCase();

  const badWords = [
    "flag",
    "flags",
    "coat of arms",
    "emblem",
    "seal",
    "logo",
    "insignia",
    "locator",
    "location map",
    "blank map",
    "svg",
    "drawing",
    "illustration",
    "diagram",
    "chart",
    "graph",
    "poster",
    "stamp",
    "coin",
    "banknote",
    "portrait",
    "selfie",
    "passport",
    "president",
    "prime minister",
    "minister",
    "politician"
  ];

  return badWords.some(word => lowerTitle.includes(word));
}

function isBadImageUrl(url = "") {
  const lowerUrl = url.toLowerCase();

  const badParts = [
    "flag",
    "flags",
    "coat_of_arms",
    "coat-of-arms",
    "emblem",
    "seal",
    "logo",
    "locator",
    "blank_map",
    ".svg",
    ".gif"
  ];

  return badParts.some(part => lowerUrl.includes(part));
}

function simplifySubjectLabel(subject) {
  return String(subject || "")
    .replace(/photograph/gi, "")
    .replace(/photo/gi, "")
    .replace(/landscape/gi, "")
    .replace(/wide/gi, "")
    .replace(/exterior/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImageIdentity(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/file:/g, "")
    .replace(/\.[a-z0-9]+$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isDuplicateImageCandidate(candidate, usedUrls, usedTitles) {
  const normalizedTitle = normalizeImageIdentity(candidate.title || candidate.url);

  if (usedUrls.has(candidate.url)) {
    return true;
  }

  for (const usedTitle of usedTitles) {
    if (
      normalizedTitle.includes(usedTitle) ||
      usedTitle.includes(normalizedTitle)
    ) {
      return true;
    }
  }

  return false;
}

function getBackupSubjects(countryName) {
  return [
    `${countryName} landmark`,
    `${countryName} old town`,
    `${countryName} city skyline`,
    `${countryName} architecture`,
    `${countryName} landscape`,
    `${countryName} nature`,
    `${countryName} national park`,
    `${countryName} coastline`,
    `${countryName} mountains`,
    `${countryName} traditional food`
  ];
}

async function searchCommonsImages(searchText) {
  const url =
    "https://commons.wikimedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: `${searchText} photograph`,
      gsrnamespace: "6",
      gsrlimit: "60",
      prop: "imageinfo",
      iiprop: "url|mime|size",
      iiurlwidth: "1200",
      format: "json",
      origin: "*"
    });

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const pages = Object.values(data.query?.pages || {});
    const results = [];

    for (const page of pages) {
      const title = page.title || "";
      const imageInfo = page.imageinfo?.[0];

      if (!imageInfo) continue;
      if (isBadImageTitle(title)) continue;
      if (!imageInfo.mime || !imageInfo.mime.startsWith("image/")) continue;

      const imageUrl = imageInfo.thumburl || imageInfo.url;
      const width = imageInfo.thumbwidth || imageInfo.width || 0;
      const height = imageInfo.thumbheight || imageInfo.height || 0;

      if (!imageUrl) continue;
      if (isBadImageUrl(imageUrl)) continue;

      const isBigEnough = width >= 300 && height >= 200;

      if (!isBigEnough) continue;

      results.push({
        url: imageUrl,
        title,
        width,
        height
      });
    }

    return results;
  } catch (error) {
    console.warn("Commons image search failed:", error);
    return [];
  }
}

async function fetchCountryGalleryImages(countryName) {
  const usedUrls = new Set();
  const usedTitles = new Set();
  const images = [];

  const customSubjects = getPhotoSubjectsForCountry(countryName);
  const backupSubjects = getBackupSubjects(countryName);
  const allSubjects = [...customSubjects, ...backupSubjects];

  for (const subject of allSubjects) {
    const results = await searchCommonsImages(subject);

    const chosen = results.find(result => {
      const candidate = {
        url: result.url,
        title: result.title
      };

      return !isDuplicateImageCandidate(candidate, usedUrls, usedTitles);
    });

    if (chosen) {
      usedUrls.add(chosen.url);
      usedTitles.add(normalizeImageIdentity(chosen.title || chosen.url));

      images.push({
        url: chosen.url,
        type: simplifySubjectLabel(subject)
      });
    }

    if (images.length >= 5) {
      break;
    }
  }

  return images.slice(0, 5);
}

function buildGalleryImages(galleryImages, fallbackImage, flagUrl) {
  const cleanedImages = [];
  const usedUrls = new Set();

  galleryImages.forEach(image => {
    if (!image?.url) return;
    if (image.url === flagUrl) return;
    if (isBadImageUrl(image.url)) return;
    if (usedUrls.has(image.url)) return;

    usedUrls.add(image.url);
    cleanedImages.push(image);
  });

  const safeFallback =
    fallbackImage &&
    fallbackImage !== flagUrl &&
    !isBadImageUrl(fallbackImage) &&
    !usedUrls.has(fallbackImage);

  if (cleanedImages.length === 0 && safeFallback) {
    cleanedImages.push({
      url: fallbackImage,
      type: "Representative photo"
    });
  }

  return cleanedImages.slice(0, 5);
}

function renderCountryCard(countryData, wikiData, galleryImages = []) {
  countryTitleElement.classList.remove("hidden");

  const commonName = countryData.name?.common || "Unknown country";
  const officialName = countryData.name?.official || commonName;
  const capital = countryData.capital?.[0] || "Unknown";
  const region = [countryData.region, countryData.subregion].filter(Boolean).join(" • ") || "Unknown";
  const population = formatNumber(countryData.population);
  const languages = countryData.languages
    ? Object.values(countryData.languages).join(", ")
    : "Unknown";

  const flagUrl = countryData.flags?.svg || countryData.flags?.png || "";

  const fallbackImage =
    wikiData?.originalimage?.source ||
    wikiData?.thumbnail?.source ||
    "";

  const finalGalleryImages = buildGalleryImages(
    galleryImages,
    fallbackImage,
    flagUrl
  );

  const funFact = buildFunFact(countryData, wikiData);

  const galleryMarkup = finalGalleryImages.length
    ? finalGalleryImages
        .map(
          (image, index) => `
            <div class="country-gallery-slide ${index === 0 ? "active" : ""}" data-gallery-index="${index}">
              <img
                class="country-gallery-image"
                src="${image.url}"
                alt="${image.type || "Representative photo"} of ${commonName}"
                loading="lazy"
              />
              <span class="country-gallery-tag">
                ${image.type || "Photo"}
              </span>
            </div>
          `
        )
        .join("")
    : `
        <div class="country-gallery-empty">
          No suitable landscape photos found yet.
        </div>
      `;

  countryInfoElement.innerHTML = `
    <div class="country-card bento-country-card">
      <div class="country-gallery-carousel" data-current-index="0">
        <button class="gallery-arrow gallery-arrow-left" type="button" aria-label="Previous photo">
          ‹
        </button>

        <div class="country-gallery-track">
          ${galleryMarkup}
        </div>

        <button class="gallery-arrow gallery-arrow-right" type="button" aria-label="Next photo">
          ›
        </button>
      </div>

      <div class="country-card-body">
        <div class="country-header bento-country-header">
          <img
            class="country-flag"
            src="${flagUrl}"
            alt="Flag of ${commonName}"
          />

          <div>
            <h3 class="country-name">${commonName}</h3>
            <p class="country-subtitle">${officialName}</p>
          </div>
        </div>

        <div class="country-meta bento-grid">
          <div class="meta-box bento-box">
            <div class="meta-label">Capital</div>
            <div class="meta-value">${capital}</div>
          </div>

          <div class="meta-box bento-box">
            <div class="meta-label">Region</div>
            <div class="meta-value">${region}</div>
          </div>

          <div class="meta-box bento-box">
            <div class="meta-label">Population</div>
            <div class="meta-value">${population}</div>
          </div>

          <div class="meta-box bento-box">
            <div class="meta-label">Languages</div>
            <div class="meta-value">${languages}</div>
          </div>
        </div>

        <div class="fun-fact-box bento-fun-fact">
          <strong>Fun fact</strong>
          <p>${funFact}</p>
        </div>
      </div>
    </div>
  `;

  setupCountryGalleryCarousel();
}

function setupCountryGalleryCarousel() {
  const carousel = document.querySelector(".country-gallery-carousel");

  if (!carousel) return;

  const slides = Array.from(carousel.querySelectorAll(".country-gallery-slide"));
  const leftButton = carousel.querySelector(".gallery-arrow-left");
  const rightButton = carousel.querySelector(".gallery-arrow-right");

  if (slides.length <= 1) {
    if (leftButton) leftButton.style.display = "none";
    if (rightButton) rightButton.style.display = "none";
    return;
  }

  function showSlide(newIndex) {
    const totalSlides = slides.length;
    const wrappedIndex = ((newIndex % totalSlides) + totalSlides) % totalSlides;

    slides.forEach((slide, index) => {
      slide.classList.toggle("active", index === wrappedIndex);
    });

    carousel.dataset.currentIndex = String(wrappedIndex);
  }

  leftButton.addEventListener("click", () => {
    const currentIndex = Number(carousel.dataset.currentIndex || 0);
    showSlide(currentIndex - 1);
  });

  rightButton.addEventListener("click", () => {
    const currentIndex = Number(carousel.dataset.currentIndex || 0);
    showSlide(currentIndex + 1);
  });

  showSlide(0);
}

async function showCountryInfo(lat, lon) {
  setCountryLoading();

  try {
    const { countryCode } = await reverseGeocodeCountry(lat, lon);

    if (countryCache.has(countryCode)) {
      countryTitleElement.classList.remove("hidden");
      countryInfoElement.innerHTML = countryCache.get(countryCode);
      setupCountryGalleryCarousel();
      return;
    }

    const countryData = await fetchCountryData(countryCode);
    const wikiData = await fetchWikipediaSummary(countryData.name.common);
    const galleryImages = await fetchCountryGalleryImages(countryData.name.common);

    renderCountryCard(countryData, wikiData, galleryImages);

    countryCache.set(countryCode, countryInfoElement.innerHTML);
  } catch (error) {
    setCountryError(error.message || "Could not load country information.");
  }
}

// ---------- CAPITAL CITIES ----------

async function loadCapitalCities() {
  if (capitalCitiesLoaded) return;

  capitalCitiesLoaded = true;

  try {
    const response = await fetch(
      "https://restcountries.com/v3.1/all?fields=name,capital,capitalInfo"
    );

    if (!response.ok) {
      throw new Error("Could not load capital cities.");
    }

    const countries = await response.json();

    countries.forEach(country => {
      const capitalName = country.capital?.[0];
      const latlng = country.capitalInfo?.latlng;

      if (!capitalName || !latlng || latlng.length !== 2) {
        return;
      }

      const marker = L.marker([latlng[0], latlng[1]], {
        icon: L.divIcon({
          className: "",
          html: `<div class="capital-city-marker"></div>`,
          iconSize: [10, 10],
          iconAnchor: [5, 5]
        }),
        interactive: false
      });

      marker.bindTooltip(capitalName, {
        permanent: true,
        direction: "top",
        offset: [0, -8],
        className: "capital-city-label"
      });

      capitalCityLayer.addLayer(marker);
    });

    updateCapitalCitiesVisibility();
  } catch (error) {
    console.warn(error.message);
  }
}

function updateCapitalCitiesVisibility() {
  const shouldShowCapitals = map.getZoom() >= CAPITAL_CITY_ZOOM_LEVEL;

  if (shouldShowCapitals) {
    loadCapitalCities();

    if (!map.hasLayer(capitalCityLayer)) {
      capitalCityLayer.addTo(map);
    }
  } else {
    if (map.hasLayer(capitalCityLayer)) {
      map.removeLayer(capitalCityLayer);
    }
  }
}

// ---------- MAP GRID LINES ----------

function addTimezoneColorStripes() {
  for (let offset = -11; offset <= 12; offset++) {
    const stripeIndex = offset + 11;
    const west = -180 + stripeIndex * 15;
    const east = west + 15;

    L.rectangle(
      [
        [-72, west],
        [82, east]
      ],
      {
        pane: "stripePane",
        stroke: false,
        fillColor: getColorFromOffsetHours(offset),
        fillOpacity: 0.18,
        interactive: false
      }
    ).addTo(map);
  }
}

function addLongitudeLines() {
  for (let lon = -180; lon <= 180; lon += 15) {
    L.polyline(
      [
        [-72, lon],
        [82, lon]
      ],
      {
        pane: "gridPane",
        color: "#94a3b8",
        weight: 1,
        opacity: 0.2,
        interactive: false
      }
    ).addTo(map);
  }
}

function addLatitudeLines() {
  for (let lat = -60; lat <= 75; lat += 15) {
    L.polyline(
      [
        [lat, -180],
        [lat, 180]
      ],
      {
        pane: "gridPane",
        color: "#94a3b8",
        weight: 1,
        opacity: 0.12,
        interactive: false
      }
    ).addTo(map);
  }
}

// ---------- OFFSET BARS ----------

function renderOffsetBar(barElement) {
  const offsets = [];

  for (let i = -11; i <= 12; i++) {
    offsets.push(i);
  }

  barElement.innerHTML = "";

  offsets.forEach(offset => {
    const cell = document.createElement("div");
    cell.className = "offset-cell";

    const label = document.createElement("div");
    label.textContent = offset === 0 ? "UTC" : `${offset > 0 ? "+" : ""}${offset}`;

    const colorStrip = document.createElement("div");
    colorStrip.className = "offset-color";
    colorStrip.style.background = getColorFromOffsetHours(offset);

    cell.appendChild(label);
    cell.appendChild(colorStrip);
    barElement.appendChild(cell);
  });
}

function buildOffsetBar() {
  if (topOffsetBar) {
    renderOffsetBar(topOffsetBar);
  }

  if (offsetBar) {
    renderOffsetBar(offsetBar);
  }
}

// ---------- GEOJSON STYLING ----------

function styleTimezone(feature) {
  const timezone = getTimezoneName(feature);
  const offset = getOffsetInfo(timezone);
  const isHovered = hoveredTimezone === timezone;

  return {
    fillColor: getColorFromOffsetHours(offset.hours),
    fillOpacity: isHovered ? 0.84 : 0.72,
    color: "#ffffff",
    weight: 0.55,
    opacity: 0.9
  };
}

function getTooltipContent(timezone) {
  const offset = getOffsetInfo(timezone);
  const currentTime = getTimeInTimezone(timezone);
  const seasonalStatus = getSeasonalTimeStatus(timezone);

  return `
      <strong>${timezone}</strong><br>
      Time: ${currentTime}<br>
      ${offset.text}<br>
      ${seasonalStatus.value}
    `;
}

function setTooltipContent(layer, timezone) {
  const content = getTooltipContent(timezone);
  const tooltip = layer.getTooltip && layer.getTooltip();

  if (tooltip) {
    tooltip.setContent(content);
  }
}

function cancelTooltipShowTimer() {
  if (tooltipShowTimeout) {
    clearTimeout(tooltipShowTimeout);
    tooltipShowTimeout = null;
  }
}

function closeActiveTooltip() {
  cancelTooltipShowTimer();

  if (activeTooltipLayer) {
    activeTooltipLayer.closeTooltip();
    activeTooltipLayer.unbindTooltip();
  }

  activeTooltipLayer = null;
}

function showTooltipAfterDelay(layer, timezone) {
  cancelTooltipShowTimer();

  tooltipShowTimeout = setTimeout(() => {
    if (hoveredLayer === layer && hoveredTimezone === timezone && !isMouseOnInfoPanel) {
      layer.bindTooltip(getTooltipContent(timezone), {
        sticky: false,
        permanent: false,
        direction: "auto"
      });

      activeTooltipLayer = layer;
      layer.openTooltip();
    }

    tooltipShowTimeout = null;
  }, TOOLTIP_SHOW_DELAY);
}

function onEachTimezone(feature, layer) {
  const timezone = getTimezoneName(feature);

  layer.on("mouseover", function () {
    immediatelyRemovePanelPinnedClickEffect();
    cancelPanelReset();

    if (isCountryClickLocked && layer !== clickedLayer) {
      delayedActivateHover(layer, timezone);
      return;
    }

    activateHover(layer, timezone);
  });

  layer.on("mouseout", function () {
    clearDelayedHover();

    closeActiveTooltip();

    resetOutlinedHoverLayer(layer);

    if (isCountryClickLocked) {
      if (
        clickedLayer &&
        clickedTimezone &&
        !isWaitingToResetPanelAfterMapReturn
      ) {
        hoveredLayer = clickedLayer;
        hoveredTimezone = clickedTimezone;
        updateInfoPanel(clickedTimezone);
      }

      return;
    }

    hoveredTimezone = null;
    hoveredLayer = null;

    schedulePanelReset();
  });

  layer.on("click", function (e) {
    closeActiveTooltip();
    clearDelayedHover();
    clearHoverOutlineTimeout();
    cancelPanelReset();
    cancelReturnToMapPanelReset();

    lockClickedCountryHover(layer, timezone);
    showClickedEffect(layer, timezone);
    showCountryInfo(e.latlng.lat, e.latlng.lng);
  });
}

// ---------- RIGHT PANEL HOVER BEHAVIOR ----------

if (infoPanel) {
  infoPanel.addEventListener("mouseenter", function () {
    isMouseOnInfoPanel = true;

    cancelPanelReset();
    cancelReturnToMapPanelReset();
    clearDelayedHover();

    if (clickedLayer && clickedTimezone) {
      isCountryClickLocked = true;
      clickedEffectPinnedByPanel = true;

      hoveredLayer = clickedLayer;
      hoveredTimezone = clickedTimezone;

      updateInfoPanel(clickedTimezone);
      showClickedEffect(clickedLayer, clickedTimezone, { pinned: true });
    }
  });

  infoPanel.addEventListener("mouseleave", function () {
    isMouseOnInfoPanel = false;
    clearDelayedHover();

    if (clickedLayer && clickedTimezone) {
      isCountryClickLocked = true;
      hoveredLayer = clickedLayer;
      hoveredTimezone = clickedTimezone;
      updateInfoPanel(clickedTimezone);

      scheduleReturnToMapPanelReset();
      return;
    }

    updateInfoPanel(null);
    resetCountryInfo();

    if (hoveredLayer && timezoneLayer && !layerHasClickedVisual(hoveredLayer)) {
      scheduleHoverOutlineReset(hoveredLayer);
    }

    hoveredLayer = null;
    hoveredTimezone = null;
  });
}

map.on("mousemove", function () {
  immediatelyRemovePanelPinnedClickEffect();

  if (!isMouseOnInfoPanel && clickedLayer && clickedTimezone) {
    isCountryClickLocked = true;

    if (!isWaitingToResetPanelAfterMapReturn) {
      scheduleReturnToMapPanelReset();
    }
  }
});

map.on("mouseover", function () {
  immediatelyRemovePanelPinnedClickEffect();

  if (!isMouseOnInfoPanel && clickedLayer && clickedTimezone) {
    scheduleReturnToMapPanelReset();
  }
});

map.on("mouseout", function () {
  if (
    clickedLayer &&
    clickedTimezone &&
    !isWaitingToResetPanelAfterMapReturn
  ) {
    isCountryClickLocked = true;
    hoveredLayer = clickedLayer;
    hoveredTimezone = clickedTimezone;
    updateInfoPanel(clickedTimezone);
  }
});

// ---------- LOAD TIMEZONE GEOJSON ----------

function loadTimezoneMap() {
  fetch("Data/timezones-small.geojson")
    .then(response => {
      if (!response.ok) {
        throw new Error("Could not load Data/timezones-small.geojson");
      }

      return response.json();
    })
    .then(data => {
      timezoneLayer = L.geoJSON(data, {
        style: styleTimezone,
        onEachFeature: onEachTimezone
      }).addTo(map);
    })
    .catch(error => {
      infoElement.innerHTML = `
        <p><strong>Map data missing.</strong></p>
        <p>You need to add a file called <code>timezones-small.geojson</code> inside the <code>Data</code> folder.</p>
        <p>${error.message}</p>
      `;
    });
}

// ---------- LIVE CLOCK UPDATE ----------

setInterval(() => {
  updateGMTClock();

  if (hoveredTimezone && !isWaitingToResetPanelAfterMapReturn) {
    updateInfoPanel(hoveredTimezone);

    if (hoveredLayer) {
      setTooltipContent(hoveredLayer, hoveredTimezone);

      if (activeTooltipLayer === hoveredLayer && !isMouseOnInfoPanel) {
        hoveredLayer.openTooltip();
      }
    }
  }
}, 1000);

map.on("zoomend", updateCapitalCitiesVisibility);

function initApp() {
  updateGMTClock();
  resetCountryInfo();
  buildOffsetBar();

  loadCountryOutlineMap();
  addTimezoneColorStripes();
  addLongitudeLines();
  addLatitudeLines();
  loadTimezoneMap();

  loadCountryPhotoSubjects().catch(error => {
    console.warn("Country photo subjects could not load:", error);
  });

  setTimeout(() => {
    map.invalidateSize();
    resetMapView();
  }, 0);

  updateCapitalCitiesVisibility();
}

initApp();

/* ---------- WORLD CLOCKS ---------- */

function updateWorldClocks() {
  const now = new Date();

  document.querySelectorAll("[data-timezone]").forEach((clock) => {
    const timezone = clock.dataset.timezone;

    clock.textContent = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  });

  document.querySelectorAll("[data-date-timezone]").forEach((dateElement) => {
    const timezone = dateElement.dataset.dateTimezone;

    dateElement.textContent = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric"
    }).format(now);
  });
}

updateWorldClocks();
setInterval(updateWorldClocks, 1000);

/* ---------- KEYBOARD SHORTCUT: H = HOME BUTTON ---------- */

document.addEventListener("keydown", function (event) {
  const isTyping =
    event.target.tagName === "INPUT" ||
    event.target.tagName === "TEXTAREA" ||
    event.target.isContentEditable;

  if (isTyping) return;

  if (event.key.toLowerCase() === "h") {
    const homeButton = document.querySelector(".leaflet-control-home");

    if (homeButton) {
      homeButton.click();
    }
  }
});

function updateMobileInteractionText() {
  const timezoneTitle = document.querySelector(".info-panel h2");
  const timezoneInfo = document.querySelector("#timezone-info");

  if (window.innerWidth <= 900) {
    if (timezoneTitle) {
      timezoneTitle.textContent = "Clicked Timezone";
    }

    if (timezoneInfo && timezoneInfo.textContent.includes("Hover")) {
      timezoneInfo.innerHTML = "<p>Click on the map to see timezone information.</p>";
    }
  }
}

window.addEventListener("load", updateMobileInteractionText);
window.addEventListener("resize", updateMobileInteractionText);