// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: light-green; icon-glyph: signal;

/**
 * MiTelcelWidgetv2 2.1.0 — autónomo para Scriptable, sin dependencias.
 * Credenciales solo en Keychain. Nunca registra respuestas, teléfonos o tokens.
 * Un login por consulta; sin fallback automático entre métodos de acceso.
 * Si falla el acceso, se pausa hasta revisión manual (también tras reiniciar).
 */
const CONFIG = {
  refreshMinutes: 60, // Intervalo solicitado a iOS; mínimo permitido: 15 minutos.
  authMethod: "oidc", // "oidc" o "weblogin". Cambiar manualmente, nunca alternar en bucle.
  cooldownMinutes: 30,
  retryMinutes: 60,
  timeoutSeconds: 8,
  usageAlertsEnabled: true,
  alertCooldownHours: 24, // Mínimo 24 h entre alertas automáticas.
  cacheFileName: "mitelcel_v2_usage_cache.json",
  stateFileName: "mitelcel_v2_state.json",
  basicCacheFileName: "mitelcel_v2_public_basic.json",
  alertStateFileName: "mitelcel_v2_alerts.json"
};
// Se evalúa primero el nivel más alto. Sin aviso cuando queda un día o menos.
const USAGE_ALERT_RULES = [
  { level: 3, usedPercent: 95, minDaysLeft: 2 },
  { level: 2, usedPercent: 90, minDaysLeft: 3 },
  { level: 1, usedPercent: 80, minDaysLeft: 7 }
];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const COLORS = {
  bg: new Color("#111111", 0.9), pillBg: new Color("#242428", 0.3),
  brandGreen: new Color("#32D74B"), spentRed: new Color("#FF453A"),
  white: new Color("#FFFFFF"), subtitleGray: new Color("#98989F"),
  trackGray: new Color("#2C2C2E"), warnYellow: new Color("#FFD60A"),
  alertRed: new Color("#FF453A")
};
const minutes = n => n * 60000;
const refreshInterval = () => minutes(Math.max(15, Number(CONFIG.refreshMinutes) || 60));
const cooldownInterval = () => minutes(Math.max(30, Number(CONFIG.cooldownMinutes) || 30));

class TelcelError extends Error {
  constructor(code, stage, status = 0) {
    const descriptions = {
      http: `El servicio rechazó la solicitud${status ? ` (HTTP ${status})` : ""}.`,
      network: "No se completó la conexión. No se reintentó el acceso.",
      format: "El servicio devolvió un formato inesperado.",
      login: "No se recibió una sesión válida; puede ser rechazo del acceso o protección del portal.",
      redirect: "El portal no entregó el código de acceso OIDC. No confirma una contraseña incorrecta.",
      token: "No se recibió el token de consumo. Revisa la compatibilidad del servicio.",
      parse: "La respuesta no contiene bolsas de datos reconocibles.",
      paused: "Acceso pausado. Abre Scriptable para revisar tus credenciales y reanudar.",
      wait: "Aún no corresponde otra consulta. Se conserva la última gráfica.",
      setup: "Abre Scriptable y configura MiTelcelWidgetv2.",
      phone: "El campo Número Telcel debe contener 10 dígitos. También se acepta el prefijo +52.",
      password: "El campo Contraseña está vacío o contiene solo espacios. Complétalo antes de continuar.",
      capture: "No se pudieron leer los datos del formulario. No se intentó iniciar sesión en Telcel.",
      formTimeout: "La pantalla de configuración no respondió a tiempo. Cierra la ejecución y vuelve a abrir el script. No se intentó iniciar sesión en Telcel.",
      notification: "No fue posible programar la notificación. Revisa los permisos de notificaciones de Scriptable en Ajustes.",
      storage: "No fue posible guardar el estado de protección. Revisa el almacenamiento de Scriptable."
    };
    super(`${stage}: ${descriptions[code] || descriptions.format}`);
    this.code = code;
    this.stage = stage;
    this.status = status;
  }
}

function filePath(name) {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), name);
}
function readJSON(name) {
  const fm = FileManager.local();
  const path = filePath(name);
  if (!fm.fileExists(path)) return null;
  return JSON.parse(fm.readString(path));
}
function writeJSON(name, value) {
  try {
    FileManager.local().writeString(filePath(name), JSON.stringify(value));
  } catch (_) {
    throw new TelcelError("storage", "Dispositivo");
  }
}
function loadState(now = new Date()) {
  try {
    const s = readJSON(CONFIG.stateFileName);
    if (s === null) return { version: 2, configured: false, paused: false, nextAllowedAt: 0 };
    if (s.version !== 2 || typeof s.configured !== "boolean" || typeof s.paused !== "boolean"
      || !Number.isFinite(s.nextAllowedAt) || s.nextAllowedAt < 0) throw new Error();
    return s;
  } catch (_) {
    // Fallar cerrado: no iniciar sesión si el estado de protección está dañado.
    const s = { version: 2, configured: false, paused: true,
      nextAllowedAt: now.getTime() + cooldownInterval(),
      message: "Estado de protección ilegible. Espera 30 minutos y configura el acceso nuevamente." };
    writeJSON(CONFIG.stateFileName, s);
    return s;
  }
}
function saveState(state) { writeJSON(CONFIG.stateFileName, state); }

function usageAlertRisk(data, now = new Date()) {
  if (!CONFIG.usageAlertsEnabled || !data || data.fromCache || data.daysLeftEstimated) return null;
  const { totalMB, consumedMB, availableMB, daysLeft } = data;
  if (![totalMB, consumedMB, availableMB, daysLeft].every(Number.isFinite)
    || totalMB <= 0 || consumedMB < 0 || availableMB < 0 || !Number.isInteger(daysLeft)) return null;
  const updatedAt = Date.parse(data.updatedAtISO);
  if (!Number.isFinite(updatedAt) || updatedAt > now.getTime()
    || now.getTime() - updatedAt > minutes(15)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.cutoffISO || "")) return null;
  const cutoffAt = Date.parse(`${data.cutoffISO}T00:00:00Z`);
  if (!Number.isFinite(cutoffAt) || new Date(cutoffAt).toISOString().slice(0, 10) !== data.cutoffISO) return null;
  const usedPercent = Math.min(100, consumedMB / totalMB * 100);
  const rule = USAGE_ALERT_RULES.find(r => usedPercent >= r.usedPercent && daysLeft >= r.minDaysLeft);
  return rule ? { ...rule, usedPercent, availableMB, daysLeft, cutoffISO: data.cutoffISO, cutoffAt } : null;
}

function loadAlertHistory() {
  const history = readJSON(CONFIG.alertStateFileName);
  if (history === null) return { version: 1, lastSentAt: 0, lastAttemptAt: 0, cycles: [] };
  if (history.version !== 1 || !Number.isFinite(history.lastSentAt) || history.lastSentAt < 0
    || !Number.isFinite(history.lastAttemptAt) || history.lastAttemptAt < 0 || !Array.isArray(history.cycles)
    || history.cycles.length > 6 || !history.cycles.every(c => /^\d{4}-\d{2}-\d{2}$/.test(c.cutoffISO || "")
      && Number.isFinite(Date.parse(`${c.cutoffISO}T00:00:00Z`)) && Number.isInteger(c.level) && c.level >= 0 && c.level <= 3)) {
    throw new Error("Historial de alertas inválido");
  }
  return history;
}

async function notifyUsageRisk(data, now = new Date()) {
  const risk = usageAlertRisk(data, now);
  if (!risk || typeof Notification === "undefined") return false;
  try {
    const history = loadAlertHistory();
    const cooldown = minutes(Math.max(24, Number(CONFIG.alertCooldownHours) || 24) * 60);
    if ((history.lastSentAt && now.getTime() - history.lastSentAt < cooldown)
      || (history.lastAttemptAt && now.getTime() - history.lastAttemptAt < minutes(60))) return false;
    // Tolerar un día de diferencia en el conteo del servidor sin rearmar las alertas.
    let cycle = history.cycles.find(c => Math.abs(Date.parse(`${c.cutoffISO}T00:00:00Z`) - risk.cutoffAt) <= 86400000);
    if (cycle && risk.level <= cycle.level) return false;
    if (!cycle) {
      cycle = { cutoffISO: risk.cutoffISO, level: 0 };
      history.cycles = [...history.cycles.slice(-5), cycle];
    }
    const alert = new Notification();
    alert.identifier = `mitelcel-v2-usage-${cycle.cutoffISO}-${risk.level}`;
    alert.threadIdentifier = "mitelcel-v2-usage";
    alert.title = risk.availableMB === 0 ? "Mi Telcel: datos agotados"
      : risk.level === 3 ? "Mi Telcel: datos por agotarse" : "Mi Telcel: revisa tu consumo";
    const dailyMB = risk.availableMB / risk.daysLeft;
    const daily = dailyMB >= 1000 ? `${(dailyMB / 1000).toFixed(2)} GB` : `${Math.floor(dailyMB)} MB`;
    alert.body = `Llevas ${Math.floor(risk.usedPercent)}% usado y faltan ${risk.daysLeft} días para el corte. Disponibles: ${(risk.availableMB / 1000).toFixed(2)} GB. Presupuesto: ${daily}/día.`;
    alert.sound = "default";
    const name = typeof Script !== "undefined" ? Script.name() : "";
    alert.openURL = name ? `scriptable:///run?scriptName=${encodeURIComponent(name)}` : "scriptable://";
    alert.setTriggerDate(new Date(now.getTime() + 1000));
    // Reservar nivel y hora antes de programar: si iOS interrumpe la ejecución,
    // una nueva carga no vuelve a enviar una notificación de resultado incierto.
    const previousLevel = cycle.level;
    const previousSentAt = history.lastSentAt;
    history.lastAttemptAt = now.getTime();
    cycle.level = risk.level;
    history.lastSentAt = now.getTime();
    writeJSON(CONFIG.alertStateFileName, history);
    try { await alert.schedule(); }
    catch (err) {
      // Un fallo confirmado permite otro intento en una hora, sin repetir logins.
      cycle.level = previousLevel;
      history.lastSentAt = previousSentAt;
      try { writeJSON(CONFIG.alertStateFileName, history); } catch (_) {}
      throw err;
    }
    return true;
  } catch (_) {
    // Una falla de notificaciones jamás invalida el consumo ni pausa el acceso SSO.
    console.warn("No se pudo programar la alerta local. Revisa el historial y los permisos de notificaciones de Scriptable.");
    return false;
  }
}

async function sendTestUsageNotification(now = new Date()) {
  try {
    const alert = new Notification();
    alert.identifier = "mitelcel-v2-usage-test";
    alert.threadIdentifier = "mitelcel-v2-usage";
    alert.title = "Mi Telcel: prueba de alerta";
    alert.body = "Las alertas de consumo combinan porcentaje usado y días restantes. Esta prueba no consulta tu cuenta ni modifica el límite de avisos.";
    alert.sound = "default";
    alert.setTriggerDate(new Date(now.getTime() + 1000));
    await alert.schedule();
  } catch (_) { throw new TelcelError("notification", "Notificaciones"); }
}

function getStoredCredentials() {
  return {
    phone: Keychain.contains("TELCEL_PHONE") ? Keychain.get("TELCEL_PHONE") : "",
    password: Keychain.contains("TELCEL_PASS") ? Keychain.get("TELCEL_PASS") : ""
  };
}
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("52") ? digits.slice(2) : digits;
}
function assertCredentials(creds) {
  const phone = normalizePhone(creds?.phone);
  if (!/^\d{10}$/.test(phone)) throw new TelcelError("phone", `Número (${phone.length} dígitos detectados)`);
  if (typeof creds?.password !== "string" || !creds.password.trim()) throw new TelcelError("password", "Contraseña");
}
function assertCanAttempt(state, now, manual = false) {
  if (now.getTime() < state.nextAllowedAt) throw new TelcelError("wait", "Protección");
  if (state.paused && !manual) throw new TelcelError("paused", "Protección");
}

/** HTTP sin reintentos. Los errores solo incluyen etapa y estado, nunca cuerpo o URL. */
async function requestText(url, method, headers, body, stage, redirect = "follow", timeout = CONFIG.timeoutSeconds) {
  let response;
  try {
    if (typeof Request !== "undefined" && typeof Request.prototype?.loadString === "function") {
      const req = new Request(url);
      req.method = method;
      req.headers = headers;
      req.timeoutInterval = timeout;
      if (body) req.body = body;
      let location = "";
      if (redirect === "manual") {
        // Asignar siempre: no comprobar si la propiedad ya existía en Request.
        req.onRedirect = redirected => { location = redirected?.url || ""; return null; };
      } else if (stage === "SSO WebLogin") {
        let redirects = 0;
        req.onRedirect = redirected => {
          if (++redirects > 1 || !/^https:\/\/wbl\.telcel-id\.com:8443\/Auth\?/i.test(redirected?.url || "")) return null;
          return redirected;
        };
      }
      const raw = await req.loadString();
      response = { text: raw, status: req.response?.statusCode || 200,
        headers: req.response?.headers || {}, location, url: req.response?.url || url };
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout * 1000);
      try {
        const res = await fetch(url, { method, headers, body: body || undefined,
          redirect: stage === "SSO WebLogin" ? "manual" : redirect, signal: controller.signal });
        response = { text: await res.text(), status: res.status,
          headers: Object.fromEntries(res.headers.entries()), url: res.url || url, location: "" };
      } finally { clearTimeout(timer); }
      if (stage === "SSO WebLogin" && response.status >= 300 && response.status < 400) {
        const location = header(response.headers, "location");
        const target = location.startsWith("/") ? `https://wbl.telcel-id.com:8443${location}` : location;
        if (!/^https:\/\/wbl\.telcel-id\.com:8443\/Auth\?/i.test(target)) throw new TelcelError("redirect", stage);
        return requestText(target, "GET", { "Accept": "application/json", "User-Agent": UA }, null, "SSO WebLogin respuesta", "manual");
      }
    }
  } catch (err) {
    if (err instanceof TelcelError) throw err;
    throw new TelcelError("network", stage);
  }
  if (response.status < 200 || response.status >= (redirect === "manual" ? 400 : 300)) {
    throw new TelcelError("http", stage, response.status);
  }
  return response;
}
function header(headers, name) {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? String(headers[key]) : "";
}
async function requestTelcel(url, method, headers, body, stage) {
  const res = await requestText(url, method, headers, body, stage);
  try { return JSON.parse(res.text); }
  catch (_) { throw new TelcelError("format", stage); }
}

function extractMtlBasic(text) {
  const match = String(text).match(/["']?MTL_AUTHORIZATION_BASIC["']?\s*[:=]\s*["'`]((?:Basic\s+)?[A-Za-z0-9+/=]+)["'`]/i);
  return match ? match[1].replace(/^Basic\s+/i, "") : null;
}
function resolveAsset(src, page) {
  if (src.startsWith("/")) return src.startsWith("//") ? null : `https://www.mitelcel.com${src}`;
  if (/^https:\/\/www\.mitelcel\.com\//i.test(src)) return src;
  if (/^[a-z]+:/i.test(src) || src.startsWith("//")) return null;
  const parts = (page.slice("https://www.mitelcel.com".length).replace(/[^/]*$/, "") + src).split("/");
  const path = [];
  for (const part of parts) {
    if (part === "..") path.pop();
    else if (part && part !== ".") path.push(part);
  }
  return `https://www.mitelcel.com/${path.join("/")}`;
}
async function fetchDynamicMtlBasic(now = new Date()) {
  try {
    const cached = readJSON(CONFIG.basicCacheFileName);
    if (cached && typeof cached.value === "string" && /^[A-Za-z0-9+/=]+$/.test(cached.value)
      && Number.isFinite(cached.savedAt) && now.getTime() >= cached.savedAt
      && now.getTime() - cached.savedAt < minutes(360)) return cached.value;
  } catch (_) {}
  // Solo recursos públicos; no envía credenciales ni ejecuta el JavaScript descargado.
  for (const page of ["https://www.mitelcel.com/login", "https://www.mitelcel.com/mitelcel/login"]) {
    try {
      const html = (await requestText(page, "GET", { "User-Agent": UA }, null, "Configuración pública")).text;
      let basic = extractMtlBasic(html);
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js(?:\?[^"']*)?)["']/gi)]
        .map(m => resolveAsset(m[1], page)).filter(Boolean)
        .sort((a, b) => Number(/(?:index|main)[.-]/.test(b)) - Number(/(?:index|main)[.-]/.test(a)));
      for (const script of [...new Set(scripts)].slice(0, 2)) {
        if (basic) break;
        basic = extractMtlBasic((await requestText(script, "GET", { "User-Agent": UA }, null, "Configuración pública")).text);
      }
      if (basic) {
        try { writeJSON(CONFIG.basicCacheFileName, { value: basic, savedAt: now.getTime() }); } catch (_) {}
        return basic;
      }
    } catch (_) {}
  }
  // Clave pública de la aplicación web, no es una contraseña de usuario.
  console.warn("Configuración pública no disponible; usando Basic de respaldo. Esto no valida ni invalida tu contraseña.");
  return "bXRwc2VydmljZXM6NyQ4N3JmRnN3ZSQyMV8=";
}

async function loginTelcelSSO(phone, password) {
  if (CONFIG.authMethod === "weblogin") {
    const clean = String(password).replace(/\s+/g, "");
    const pB64 = typeof Data !== "undefined" ? Data.fromString(clean).toBase64String() : Buffer.from(clean, "utf8").toString("base64");
    const fields = { username: phone, "telcel-pass": password, sitedomain: "https://www.mitelcel.com",
      CCode: "52", Type: "MSISDN", Invocation: "iFrame", MSISDN: phone, Source: "", pB64,
      url: "https://wbl.telcel-id.com:8443" };
    const result = await requestTelcel("https://wbl.telcel-id.com:8443/login", "POST", {
      "Origin": "https://wbl.telcel-id.com:8443",
      "Referer": "https://wbl.telcel-id.com:8443/login?sitedomain=https://www.mitelcel.com&CCode=52&Type=MSISDN&Invocation=iFrame",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest", "User-Agent": UA
    }, Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"), "SSO WebLogin");
    if (typeof result?.token !== "string" || !result.token) throw new TelcelError("login", "SSO WebLogin");
    return result.token;
  }
  if (CONFIG.authMethod !== "oidc") throw new TelcelError("setup", "Método de acceso");
  const base = "https://www.mitelcel.com/oid-authorize-prod";
  const clientId = "31f419f6-5446-4e7e-a275-daf60f568698";
  const callback = "https://mtl.smapps.mx:1333/sso/callback";
  const state = typeof UUID !== "undefined" ? UUID.string() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const nonce = typeof UUID !== "undefined" ? UUID.string() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await requestText(`${base}/authorize?client_id=${clientId}&response_type=code&scope=openid&redirect_uri=${encodeURIComponent(callback)}&acr_values=1&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`,
    "GET", { "USERNAME": `52${phone}`, "PASSWORD": password, "Accept": "application/json", "Accept-Charset": "UTF-8", "User-Agent": UA },
    null, "SSO OIDC", "manual");
  const location = res.location || header(res.headers, "x-oidc-redirect-location") || header(res.headers, "location");
  // Nunca seguir el callback con las cabeceras USERNAME/PASSWORD ni fabricar un HTTP 401.
  const code = location.match(/[?&]code=([^&\s"<>]+)/)?.[1];
  const returnedState = location.match(/[?&]state=([^&\s"<>]+)/)?.[1];
  if (!location.startsWith(`${callback}?`) || !code || !returnedState || decodeURIComponent(returnedState) !== state) {
    throw new TelcelError("redirect", "SSO OIDC");
  }
  const result = await requestTelcel(`${base}/token`, "POST", {
    "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": UA
  }, `grant_type=authorization_code&redirect_uri=${encodeURIComponent(callback)}&client_id=${clientId}&code=${encodeURIComponent(decodeURIComponent(code))}`, "SSO OIDC token");
  const token = result?.access_token || result?.token;
  if (typeof token !== "string" || !token) throw new TelcelError("login", "SSO OIDC token");
  return token;
}

async function revokeSSO(token) {
  await requestText("https://dev.smapps.mx:9000/sso/revoke", "POST", {
    "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"
  }, `token=${encodeURIComponent(token)}&token_type=revoke`, "Cierre SSO", "follow", 4);
}

// Solo se llama desde fetchTelcelData, después de persistir el bloqueo preventivo.
async function fetchUsageOnce(creds, now, attemptId) {
  const basic = await fetchDynamicMtlBasic(now);
  if (loadState(now).attemptId !== attemptId) throw new TelcelError("wait", "Protección");
  const sso = await loginTelcelSSO(normalizePhone(creds.phone), creds.password);
  let data;
  let revokeFailed = false;
  try {
    const tokens = await requestTelcel(`https://mi-telcel.smapps.mx/security/1.0.0/v2/token?user=${encodeURIComponent(normalizePhone(creds.phone))}&token=${encodeURIComponent(sso)}`,
      "GET", { "Authorization": `Basic ${basic}`, "scope": "token:mit|token:b2f", "Accept": "application/json",
        "Content-Type": "application/json", "App-Version": "0.14", "Code-Version": "38", "Device-Id": "DSK",
        "tipoRequest": "1", "Os": "WEB", "Os-Version": "13", "X-Channel": "web-browser", "User-Agent": "ktor-client" }, null, "Intercambio B2F");
    const list = tokens?.tokenResponse?.tokens;
    const b2f = Array.isArray(list) ? list.find(t => t.id === "token:b2f")?.access_token : null;
    if (typeof b2f !== "string" || !b2f) throw new TelcelError("token", "Intercambio B2F");
    const home = await requestTelcel(`https://api.journeys.telcel.wavebybemobi.com/api/components/flow/home?externalCode=52${encodeURIComponent(normalizePhone(creds.phone))}`,
      "GET", { "Authorization": `Bearer ${b2f}`, "Accept": "application/json", "Content-Type": "application/json",
        "X-Is-iPad": "false", "x-wave-sdk": "WEB", "x-wave-device": "iPhone", "x-wave-device-type": "mobile",
        "x-wave-os": "iOS-web", "x-wave-os-version": "18.0", "User-Agent": UA, "Cache-Control": "no-cache" }, null, "Consumo Home");
    try { data = parseTelcelResponse(home, now); }
    catch (_) { throw new TelcelError("parse", "Consumo Home"); }
  } finally {
    try { await revokeSSO(sso); }
    catch (_) {
      revokeFailed = true;
      // Se guarda aun si también falló la consulta. No ignorar un cierre no confirmado.
      const state = loadState(now);
      state.paused = true;
      state.message = "No se confirmó el cierre SSO. Cierra Mi Telcel, espera y revisa el acceso en Scriptable.";
      state.nextAllowedAt = Math.max(state.nextAllowedAt, now.getTime() + cooldownInterval());
      saveState(state);
    }
  }
  return { data, revokeFailed };
}

/** Consulta protegida: todos los puntos de entrada comparten el mismo estado en disco. */
async function fetchTelcelData(creds, { manual = false, now = new Date() } = {}) {
  let state = loadState(now);
  assertCanAttempt(state, now, manual);
  if (!manual && !state.configured) throw new TelcelError("setup", "Configuración");
  const raw = creds || getStoredCredentials();
  assertCredentials(raw);
  // Persistir antes de enviar credenciales. Si iOS mata el proceso, NO repetir el login.
  const attemptId = typeof UUID !== "undefined" ? UUID.string() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state = { ...state, paused: true, lastAttemptAt: now.getTime(), attemptId,
    nextAllowedAt: now.getTime() + cooldownInterval(),
    message: "La consulta anterior no terminó. Espera y revisa el acceso en Scriptable." };
  saveState(state);
  try {
    const result = await fetchUsageOnce(raw, now, attemptId);
    if (!result.revokeFailed) {
      state.paused = false;
      state.message = "";
      state.nextAllowedAt = now.getTime() + refreshInterval();
      state.lastSuccessAt = now.getTime();
      saveState(state);
    }
    // Incluso si falló la revocación, preservar el consumo que sí se obtuvo.
    writeJSON(CONFIG.cacheFileName, result.data);
    return result.data;
  } catch (err) {
    const safe = err instanceof TelcelError ? err : new TelcelError("format", "Consulta");
    state = loadState(now);
    if (state.attemptId !== attemptId) throw safe;
    const pause = state.message?.startsWith("No se confirmó") || safe.stage.startsWith("SSO")
      || [400, 401, 403, 423, 429].includes(safe.status) || ["token", "storage"].includes(safe.code);
    if (safe.stage === "Intercambio B2F" && ([400, 401, 403].includes(safe.status) || safe.code === "token")) {
      // Un rechazo aquí puede ser configuración pública obsoleta, no contraseña incorrecta.
      try {
        const fm = FileManager.local();
        const path = filePath(CONFIG.basicCacheFileName);
        if (fm.fileExists(path)) fm.remove(path);
      } catch (_) {}
    }
    state.paused = Boolean(pause);
    if (!state.message?.startsWith("No se confirmó")) state.message = safe.message;
    state.nextAllowedAt = now.getTime() + (pause ? cooldownInterval() : Math.max(refreshInterval(), minutes(CONFIG.retryMinutes)));
    saveState(state);
    throw safe;
  }
}
// Valida y carga el consumo en UNA sesión, revocada antes de escribir credenciales.
async function validateTelcelCredentials(phone, password, options = {}) {
  return fetchTelcelData({ phone, password }, { ...options, manual: true });
}

// Formulario local: no depende de Alert.textFieldValue ni carga recursos externos.
// No interpolar credenciales en este HTML ni guardarlo después de rellenarlo.
function credentialFormHTML() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Mi Telcel v2.1.0</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font:17px -apple-system,system-ui,sans-serif;padding:28px 20px}
main{max-width:440px;margin:auto}h1{font-size:26px;margin:0 0 12px}p{color:#b8b8c0;line-height:1.45}label{display:block;font-weight:600;margin:24px 0 8px}
input{width:100%;padding:15px;border:1px solid #555;border-radius:12px;background:#242428;color:#fff;font:inherit;outline-offset:3px}
button{width:100%;margin-top:24px;padding:15px;border:0;border-radius:12px;background:#32d74b;color:#111;font:600 17px -apple-system,system-ui,sans-serif}
button.secondary{margin-top:10px;background:#242428;color:#fff}#error{color:#ffd60a;min-height:24px}#ready{padding:12px 0}#ready p{color:#fff}
</style></head><body><main>
<h1>Configurar Mi Telcel v2.1.0</h1>
<p>Tu cuenta debe estar desbloqueada y los widgets Telcel anteriores desactivados.</p>
<form id="form" novalidate autocomplete="off">
<label for="phone">Número Telcel</label>
<input id="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="10 dígitos" aria-describedby="error">
<label for="password">Contraseña de Mi Telcel</label>
<input id="password" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="error">
<p id="error" role="alert" aria-live="polite"></p>
<button type="submit">Continuar</button>
<button id="cancel" class="secondary" type="button">Cancelar</button>
<p>Después de Continuar, pulsa Listo en la barra superior para consultar tu consumo.</p>
</form>
<section id="ready" hidden role="status"><h2>Datos preparados</h2><p id="ready-message">Pulsa Listo en la barra superior para validar el acceso y cargar tu gráfica.</p></section>
</main><script>
const normalizePhone = ${normalizePhone.toString()};
const form = document.getElementById('form');
const phoneField = document.getElementById('phone');
const passwordField = document.getElementById('password');
const error = document.getElementById('error');
const ready = document.getElementById('ready');
window.__telcelCredentials = null;
form.addEventListener('submit', event => {
  event.preventDefault();
  const phone = normalizePhone(phoneField.value);
  const password = passwordField.value;
  if (!/^\\d{10}$/.test(phone)) {
    error.textContent = 'Escribe tu número Telcel a 10 dígitos. También se acepta +52.';
    phoneField.focus();
    return;
  }
  if (!password.trim()) {
    error.textContent = 'Escribe tu contraseña antes de continuar.';
    passwordField.focus();
    return;
  }
  window.__telcelCredentials = { phone, password };
  phoneField.value = '';
  passwordField.value = '';
  error.textContent = '';
  form.hidden = true;
  ready.hidden = false;
});
document.getElementById('cancel').addEventListener('click', () => {
  window.__telcelCredentials = null;
  phoneField.value = '';
  passwordField.value = '';
  form.hidden = true;
  ready.hidden = false;
  document.getElementById('ready-message').textContent = 'Configuración cancelada. Pulsa Listo para volver.';
});
</script></body></html>`;
}

async function withFormTimeout(operation, stage, milliseconds = 10000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    const expire = () => reject(new TelcelError("formTimeout", stage));
    timer = typeof Timer !== "undefined"
      ? Timer.schedule(milliseconds, false, expire)
      : setTimeout(expire, milliseconds);
  });
  try { return await Promise.race([operation, timeout]); }
  finally {
    if (typeof timer?.invalidate === "function") timer.invalidate();
    else clearTimeout(timer);
  }
}

async function readCredentialForm() {
  const view = new WebView();
  try {
    // No bloquear la navegación inicial de WKWebView: aún no contiene credenciales.
    // El HTML estático usa CSP para impedir conexiones y recursos externos.
    await withFormTimeout(view.loadHTML(credentialFormHTML()), "Abrir formulario");
    view.shouldAllowRequest = request => /^about:blank(?:[?#]|$)/i.test(String(request?.url || ""));
    await view.present(false);
    // Leer valores DOM, consumirlos una vez y limpiar la página al salir.
    const creds = await withFormTimeout(view.evaluateJavaScript(`(() => {
      const value = window.__telcelCredentials;
      window.__telcelCredentials = null;
      document.getElementById('phone').value = '';
      document.getElementById('password').value = '';
      return value;
    })()`, false), "Leer formulario");
    if (creds === null) return null; // Cerrar con Listo sin Continuar también cancela.
    if (!creds || typeof creds.phone !== "string" || typeof creds.password !== "string") {
      throw new TelcelError("capture", "Formulario");
    }
    return creds;
  } catch (err) {
    if (err instanceof TelcelError) throw err;
    throw new TelcelError("capture", "Formulario");
  } finally {
    try {
      await withFormTimeout(view.loadHTML("<!doctype html><html><body></body></html>"), "Cerrar formulario", 2000);
    } catch (_) {}
  }
}

async function configureCredentials() {
  const state = loadState();
  assertCanAttempt(state, new Date(), true);
  const previousPhone = normalizePhone(getStoredCredentials().phone);
  const creds = await readCredentialForm();
  if (!creds) return null;
  assertCredentials(creds);
  const { phone, password } = creds;
  const data = await validateTelcelCredentials(phone, password);
  if (loadState().paused) throw new TelcelError("network", "Cierre SSO");
  Keychain.set("TELCEL_PHONE", phone);
  Keychain.set("TELCEL_PASS", password);
  const updated = loadState();
  updated.configured = true;
  saveState(updated);
  if (previousPhone && previousPhone !== phone) {
    try {
      const fm = FileManager.local();
      const path = filePath(CONFIG.alertStateFileName);
      if (fm.fileExists(path)) fm.remove(path);
    } catch (_) {}
  }
  return data;
}

async function main() {
  let data = null;
  let message = "";
  try {
    let state = loadState();
    if (config.runsInWidget) {
      if (state.configured && !state.paused && Date.now() >= state.nextAllowedAt) data = await fetchTelcelData();
    } else if (!state.configured || !getStoredCredentials().password) {
      data = await configureCredentials();
    } else {
      const alert = new Alert();
      alert.title = "Mi Telcel v2";
      const wait = Math.max(0, Math.ceil((state.nextAllowedAt - Date.now()) / 60000));
      alert.message = `${state.message || "Actualización automática cada " + Math.round(refreshInterval() / 60000) + " minutos, según iOS."}${wait ? ` Próxima consulta permitida en ${wait} min.` : ""}`;
      const actions = [];
      if (!wait) {
        if (!state.paused) { alert.addAction("Actualizar ahora"); actions.push("update"); }
        alert.addAction(state.paused ? "Revisar credenciales y reanudar" : "Cambiar credenciales");
        actions.push("configure");
      }
      if (typeof Notification !== "undefined") {
        alert.addAction("Probar notificación");
        actions.push("notification");
      }
      alert.addCancelAction("Ver gráfica guardada");
      const choice = actions[await alert.presentAlert()];
      if (choice === "update") data = await fetchTelcelData();
      if (choice === "configure") data = await configureCredentials();
      if (choice === "notification") await sendTestUsageNotification();
    }
  } catch (err) {
    message = err instanceof TelcelError ? err.message : "Dispositivo: no se pudo completar la consulta. Abre Scriptable para revisar el acceso.";
    console.warn(message);
    if (!config.runsInWidget) {
      const alert = new Alert();
      alert.title = "Consulta detenida";
      alert.message = message;
      alert.addAction("Aceptar");
      await alert.presentAlert();
    }
  }
  if (!data) data = loadCache();
  let state;
  try { state = loadState(); }
  catch (_) { state = { paused: true, message: "Revisa el almacenamiento de Scriptable.", nextAllowedAt: 0 }; }
  const widget = createWidget(data, state, new Date(), message);
  Script.setWidget(widget); // Actualizar también al ejecutar dentro de la app.
  if (state.configured) await notifyUsageRisk(data);
  if (!config.runsInWidget) await widget.presentSmall();
  Script.complete();
}

function parseTelcelResponse(payload, now = new Date()) {
  const byId = {};
  const suffixesSet = new Set();
  const webSuffixesSet = new Set();

  const stack = [payload];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    if (typeof node.id === "string" && node.config) {
      byId[node.id] = node.config;
      if (node.id.startsWith("tabs-plans-v2-plan-name-")) {
        const rest = node.id.slice(24);
        let start = 0;
        let isWeb = false;
        if (rest.startsWith("web-")) {
          start = 4;
          isWeb = true;
        }
        let isSuffix = true;
        let dashes = 0;
        let digitsInSegment = 0;
        for (let i = start; i < rest.length; i++) {
          const charCode = rest.charCodeAt(i);
          if (charCode === 45) {
            if (digitsInSegment === 0) {
              isSuffix = false;
              break;
            }
            dashes++;
            digitsInSegment = 0;
          } else if (charCode >= 48 && charCode <= 57) {
            digitsInSegment++;
          } else {
            isSuffix = false;
            break;
          }
        }
        if (isSuffix && dashes === 2 && digitsInSegment > 0) {
          if (isWeb) webSuffixesSet.add(rest);
          else suffixesSet.add(rest);
        }
      }
    }

    const children = node.children;
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
    if (node.blocks) {
      stack.push(node.blocks);
    }
  }

  const activeSuffixes = suffixesSet.size ? suffixesSet : webSuffixesSet;
  // Optimization: Avoid localeCompare({ numeric: true }) which is slow in V8.
  // Custom split-and-parse sort is >2x faster for suffix keys (e.g. "0-1-1").
  const suffixes = Array.from(activeSuffixes).sort((a, b) => {
    if (a === b) return 0;
    let pA = 0, pB = 0;
    while (pA < a.length && pB < b.length) {
      let nA = 0;
      const sA = pA;
      while (pA < a.length && a.charCodeAt(pA) !== 45) {
        nA = nA * 10 + (a.charCodeAt(pA) - 48);
        pA++;
      }
      let nB = 0;
      const sB = pB;
      while (pB < b.length && b.charCodeAt(pB) !== 45) {
        nB = nB * 10 + (b.charCodeAt(pB) - 48);
        pB++;
      }
      if (nA !== nB) return nA - nB;
      if (pA - sA !== pB - sB) return a.slice(sA, pA) < b.slice(sB, pB) ? -1 : 1; // leading-zero tiebreak
      pA++; pB++; // skip '-'
    }
    return a.length - b.length;
  });

  const toMB = (val, unit) => {
    if (val === undefined || val === null || val === "") return null;
    const n = Number(val);
    if (Number.isNaN(n)) return null;

    const u = String(unit || "").toUpperCase();
    if (u === "GB") return n * 1000;
    if (u === "KB") return n / 1024;
    return n;
  };

  const parseBucket = (sfx) => {
    const chartData = byId[`tabs-plans-v2-usage-chart-${sfx}`]?.data;
    let usedKB = undefined;
    let availKB = undefined;
    if (chartData) {
      for (let i = 0; i < chartData.length; i++) {
        if (chartData[i].key === "used") usedKB = chartData[i].value;
        else if (chartData[i].key === "available") availKB = chartData[i].value;
      }
    }

    const labelUsedMB = toMB(
      byId[`tabs-plans-v2-used-data-value-${sfx}`]?.value,
      byId[`tabs-plans-v2-used-data-unit-${sfx}`]?.value
    );
    const labelTotalMB = toMB(
      byId[`tabs-plans-v2-total-data-value-${sfx}`]?.value,
      byId[`tabs-plans-v2-total-data-unit-${sfx}`]?.value
    );
    const labelAvailMB = toMB(
      byId[`tabs-plans-v2-available-data-value-${sfx}`]?.value,
      byId[`tabs-plans-v2-available-data-unit-${sfx}`]?.value
    );

    const totalMB = labelTotalMB ?? (Number.isFinite(usedKB) && Number.isFinite(availKB) ? (usedKB + availKB) / 1024 : 0);
    const consumedMB = labelUsedMB ?? (Number.isFinite(usedKB) ? usedKB / 1024 : 0);
    const availableMB = labelAvailMB ?? Math.max(0, totalMB - consumedMB);

    const cutoffSegments = byId[`tabs-plans-v2-limited-cutoff-message-${sfx}`]?.segments || [];
    let cutoffText = "";
    for (let i = 0; i < cutoffSegments.length; i++) {
      cutoffText += cutoffSegments[i].text || "";
    }

    let numStr = "";
    let started = false;
    for (let i = 0; i < cutoffText.length; i++) {
      const c = cutoffText.charCodeAt(i);
      if (c >= 48 && c <= 57) { // '0'-'9'
        numStr += cutoffText[i];
        started = true;
      } else if (started) {
        break;
      }
    }
    const daysLeft = started ? Number(numStr) : null;

    return {
      id: sfx,
      name: byId[`tabs-plans-v2-plan-name-${sfx}`]?.value || sfx,
      consumedMB,
      totalMB,
      availableMB,
      daysLeft
    };
  };

  let consumedMB = 0;
  let totalMB = 0;
  let availableMB = 0;
  let daysLeft = null;
  const rawBuckets = [];

  const bucketKeys = suffixes.length ? suffixes : ["0-0-0"];
  for (let i = 0; i < bucketKeys.length; i++) {
    const b = parseBucket(bucketKeys[i]);
    if (b.totalMB > 0 || b.availableMB > 0) {
      rawBuckets.push(b);
    }
  }
  const isBase = b => b.id === "0-0-0" || b.id === "web-0-0-0";

  let hasActivePromo = false;
  for (let i = 0; i < rawBuckets.length; i++) {
    if (!isBase(rawBuckets[i]) && rawBuckets[i].availableMB > 0) {
      hasActivePromo = true;
      break;
    }
  }

  // Al cambiar de plan mid-cycle, Telcel deja la promo anterior en 0 MB disp. Solo descartar si hay otra promo activa.
  const buckets = [];
  for (let i = 0; i < rawBuckets.length; i++) {
    const b = rawBuckets[i];
    if (isBase(b) || b.availableMB > 0 || !hasActivePromo) {
      buckets.push(b);
      consumedMB += b.consumedMB;
      totalMB += b.totalMB;
      availableMB += b.availableMB;
      if (daysLeft === null && b.daysLeft !== null) {
        daysLeft = b.daysLeft;
      }
    }
  }
  if (!buckets.length) {
    throw new Error(payload?.message || payload?.error || "Respuesta Home Flow sin bolsas de datos");
  }

  const daysLeftEstimated = daysLeft === null;
  if (daysLeft === null) {
    daysLeft = 28;
  }
  const cutoffDate = byId["plan-details-row-template-col-2-0-0"]?.value
    || byId["plan-details-row-template-col-2-web-0-0"]?.value
    || "";
  const planName = byId["text-plan-name"]?.value
    || byId["plan-details-name"]?.value
    || "Mi Telcel";

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + daysLeft);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");

  return {
    consumedMB,
    totalMB,
    availableMB,
    daysLeft,
    daysLeftEstimated,
    cutoffDate,
    planName,
    promo: buckets.length > 1,
    buckets,
    updatedAt: `${hh}:${mm}`,
    updatedAtISO: now.toISOString(),
    cutoffISO: dateISO(cutoff),
    fromCache: false
  };
}

/** UI lineal: tarjeta, gauge bicolor, consumo y presupuesto diario. */
function createWidget(data, state = {}, now = new Date(), message = "") {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(9, 10, 9, 10);
  const name = typeof Script !== "undefined" ? Script.name() : "";
  w.url = name ? `scriptable:///run?scriptName=${encodeURIComponent(name)}` : "scriptable://";
  w.refreshAfterDate = new Date(!state.paused && state.nextAllowedAt > now.getTime()
    ? state.nextAllowedAt : now.getTime() + refreshInterval());
  if (!data) {
    w.addSpacer();
    const icon = w.addText("⚠️");
    icon.font = Font.systemFont(24);
    icon.centerAlignText();
    w.addSpacer(8);
    const text = w.addText(state.message || message || "Abre Scriptable para configurar MiTelcelWidgetv2.");
    text.textColor = COLORS.white;
    text.font = Font.mediumSystemFont(11);
    text.centerAlignText();
    w.addSpacer();
    return w;
  }
  const remaining = Math.max(0, data.availableMB);
  const ratio = data.totalMB > 0 ? Math.min(1, Math.max(0, data.consumedMB / data.totalMB)) : 0;
  const daily = remaining / Math.max(1, data.daysLeft);
  const spent = data.consumedMB < 1000 ? `${Math.round(data.consumedMB)} MB` : `${(data.consumedMB / 1000).toFixed(2)} GB`;
  const expired = data.fromCache && data.daysLeft <= 0;
  const pace = expired ? "—" : daily >= 1000 ? `${(daily / 1000).toFixed(2)} GB/d` : `${Math.round(daily)} MB/d`;
  w.addSpacer();
  const header = w.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  const title = header.addStack();
  title.layoutVertically();
  title.size = new Size(62, 24);
  title.spacing = 1;
  const brand = title.addText("Mi Telcel");
  brand.font = Font.boldSystemFont(10.5);
  brand.textColor = COLORS.white;
  brand.lineLimit = 1;
  brand.minimumScaleFactor = 0.9;
  const cutoff = String(data.cutoffDate || "")
    .replace(/\s+de\s+([a-záéíóú]{3})[a-záéíóú]*/i, " $1")
    .replace(/\s+(?:de\s+)?\d{4}$/, "");
  const cut = title.addText(cutoff ? `Corte ${cutoff}` : "Consumo móvil");
  cut.font = Font.regularSystemFont(8);
  cut.textColor = COLORS.subtitleGray;
  cut.lineLimit = 1;
  cut.minimumScaleFactor = 0.85;
  header.addSpacer();
  const pill = header.addStack();
  pill.layoutHorizontally();
  pill.backgroundColor = COLORS.pillBg;
  pill.cornerRadius = 8;
  pill.size = new Size(52, 26);
  pill.setPadding(0, 0, 0, 0);
  // Un solo lienzo, como el gauge: WidgetKit no puede truncar las dos líneas
  // al repartir el ancho entre textos y espaciadores de stacks anidados.
  const daysLabel = `${data.daysLeft} ${data.daysLeft === 1 ? "día" : "días"}`;
  const daysCanvas = new DrawContext();
  daysCanvas.size = new Size(156, 78);
  daysCanvas.opaque = false;
  daysCanvas.respectScreenScale = true;
  daysCanvas.setTextAlignedCenter();
  daysCanvas.setFont(Font.regularSystemFont(22.5));
  daysCanvas.setTextColor(COLORS.subtitleGray);
  daysCanvas.drawTextInRect(data.daysLeft === 1 ? "Queda" : "Quedan", new Rect(6, 5, 144, 27));
  daysCanvas.setFont(Font.boldSystemFont(daysLabel.length > 7 ? 28 : 31.5));
  daysCanvas.setTextColor(data.daysLeft <= 2 ? COLORS.alertRed : data.daysLeft <= 5 ? COLORS.warnYellow : COLORS.white);
  daysCanvas.drawTextInRect(daysLabel, new Rect(6, 32, 144, 39));
  const daysImage = pill.addImage(daysCanvas.getImage());
  daysImage.resizable = true;
  daysImage.imageSize = new Size(52, 26);
  w.addSpacer(2);
  const gaugeRow = w.addStack();
  gaugeRow.layoutHorizontally();
  gaugeRow.addSpacer();
  const gauge = gaugeRow.addImage(drawSemicircleGauge(data.totalMB > 0 ? ratio : null,
    `${(remaining / 1000).toFixed(2)} GB`, `libres de ${(data.totalMB / 1000).toFixed(1)} GB`));
  gauge.resizable = true;
  gauge.imageSize = new Size(120, 60);
  gaugeRow.addSpacer();
  w.addSpacer(2);
  const stats = w.addStack();
  stats.layoutHorizontally();
  stats.centerAlignContent();
  // Columnas iguales: ningún valor se comprime para dar espacio al otro.
  const usedColumn = stats.addStack();
  usedColumn.layoutVertically();
  usedColumn.size = new Size(58, 22);
  usedColumn.spacing = 1;
  const used = usedColumn.addText(`● ${spent}`);
  used.font = Font.semiboldSystemFont(9.5);
  used.textColor = COLORS.spentRed;
  used.lineLimit = 1;
  used.minimumScaleFactor = 0.85;
  const usedCaption = usedColumn.addText(`Usado · ${Math.round(ratio * 100)}%`);
  usedCaption.font = Font.regularSystemFont(7.5);
  usedCaption.textColor = COLORS.subtitleGray;
  usedCaption.lineLimit = 1;
  stats.addSpacer();
  const dailyColumn = stats.addStack();
  dailyColumn.layoutVertically();
  dailyColumn.size = new Size(58, 22);
  dailyColumn.spacing = 1;
  const budgetRow = dailyColumn.addStack();
  budgetRow.addSpacer();
  const budget = budgetRow.addText(`● ${pace}`);
  budget.font = Font.semiboldSystemFont(9.5);
  budget.textColor = COLORS.brandGreen;
  budget.lineLimit = 1;
  budget.minimumScaleFactor = 0.85;
  const captionRow = dailyColumn.addStack();
  captionRow.addSpacer();
  const dailyCaption = captionRow.addText(expired ? "Corte vencido" : "Diario");
  dailyCaption.font = Font.regularSystemFont(7.5);
  dailyCaption.textColor = COLORS.subtitleGray;
  dailyCaption.lineLimit = 1;
  w.addSpacer(2);
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(data.updatedAtISO)) / 60000)) || 0;
  const ageText = age >= 1440 ? `${Math.floor(age / 1440)} d` : age >= 60 ? `${Math.floor(age / 60)} h` : `${age} min`;
  // Una sola línea. Los símbolos en modo texto evitan que iOS agrande los emoji.
  const footerText = state.paused
    ? `⏸︎ Acceso pausado · ${ageText}`
    : `${data.promo ? "Plan+Promo" : "Plan"} · ⏱︎ ${data.updatedAt || "--:--"}${data.fromCache ? ` ☁︎${age >= 60 ? ` ${ageText}` : ""}` : ""}`;
  const footer = w.addText(footerText);
  footer.font = Font.regularSystemFont(7.5);
  footer.textColor = state.paused || (data.fromCache && age >= 1440) ? COLORS.warnYellow : COLORS.subtitleGray;
  footer.lineLimit = 1;
  footer.minimumScaleFactor = 0.85;
  w.addSpacer();
  return w;
}

function drawArc(ctx, cx, cy, r, startAngle, endAngle, thickness, color) {
  if (endAngle - startAngle <= 0.005) return;
  const path = new Path();
  const steps = Math.max(12, Math.ceil((endAngle - startAngle) * 40));
  for (let i = 0; i <= steps; i++) {
    const a = startAngle + ((endAngle - startAngle) * i) / steps;
    const pt = new Point(cx + r * Math.cos(a), cy + r * Math.sin(a));
    if (i === 0) path.move(pt);
    else path.addLine(pt);
  }
  ctx.addPath(path);
  ctx.setStrokeColor(color);
  ctx.setLineWidth(thickness);
  ctx.strokePath();

  ctx.setFillColor(color);
  const half = thickness / 2;
  for (const a of [startAngle, endAngle]) {
    ctx.fillEllipse(new Rect(cx + r * Math.cos(a) - half, cy + r * Math.sin(a) - half, thickness, thickness));
  }
}

/**
 * Dibuja el medidor semicircular con lo gastado en rojo (izquierda) y lo disponible en verde (derecha)
 */
function drawSemicircleGauge(spentRatio, mainLabel, subLabel) {
  const width = 320;
  const height = 160;
  const cx = width / 2;
  const cy = 136;
  const r = 124;
  const thickness = 18;

  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  // Riel completo semicircular (de PI a 2*PI)
  drawArc(ctx, cx, cy, r, Math.PI, 2 * Math.PI, thickness, COLORS.trackGray);

  if (spentRatio !== null && Number.isFinite(spentRatio)) {
    const clamped = Math.max(0, Math.min(1, spentRatio));
    const splitAngle = Math.PI + clamped * Math.PI;
    const gap = clamped > 0.04 && clamped < 0.96 ? 0.11 : 0;

    // Segmento izquierdo: Gastado en Rojo
    if (clamped > 0.005) {
      drawArc(ctx, cx, cy, r, Math.PI, Math.max(Math.PI + 0.01, splitAngle - gap), thickness, COLORS.spentRed);
    }
    // Segmento derecho: Disponible en Verde
    if (clamped < 0.995) {
      drawArc(ctx, cx, cy, r, Math.min(2 * Math.PI - 0.01, splitAngle + gap), 2 * Math.PI, thickness, COLORS.brandGreen);
    }
  }

  // Texto principal centrado dentro del arco ("5.47 GB")
  ctx.setTextAlignedCenter();
  ctx.setFont(Font.boldSystemFont(mainLabel.length > 9 ? 40 : 46));
  ctx.setTextColor(COLORS.white);
  ctx.drawTextInRect(mainLabel, new Rect(16, 70, width - 32, 52));

  // Subtítulo centrado debajo ("libres de 15.0 GB")
  ctx.setFont(Font.mediumSystemFont(22));
  ctx.setTextColor(COLORS.subtitleGray);
  ctx.drawTextInRect(subLabel, new Rect(22, 120, width - 44, 28));

  return ctx.getImage();
}

function dateISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function loadCache(now = new Date()) {
  try {
    const data = readJSON(CONFIG.cacheFileName);
    if (!data || Array.isArray(data) || ![data.consumedMB, data.totalMB, data.availableMB, data.daysLeft].every(n => Number.isFinite(n) && n >= 0)
      || !Number.isFinite(Date.parse(data.updatedAtISO)) || Date.parse(data.updatedAtISO) > now.getTime() + 60000
      || !/^\d{4}-\d{2}-\d{2}$/.test(data.cutoffISO)) return null;
    const [y, m, d] = data.cutoffISO.split("-").map(Number);
    const end = Date.UTC(y, m - 1, d);
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    data.daysLeft = Math.max(0, Math.round((end - today) / 86400000));
    data.fromCache = true;
    return data;
  } catch (_) { return null; }
}

// Scriptable debe esperar también la carga inicial, antes de presentar cualquier UI.
if (typeof Script !== "undefined") await main();
if (typeof module !== "undefined") {
  module.exports = { CONFIG, TelcelError, main, fetchTelcelData, parseTelcelResponse,
    createWidget, loadCache, loadState, saveState, assertCanAttempt,
    validateTelcelCredentials, configureCredentials, readCredentialForm, credentialFormHTML, withFormTimeout, requestText, loginTelcelSSO,
    extractMtlBasic, resolveAsset, fetchDynamicMtlBasic, usageAlertRisk,
    notifyUsageRisk, sendTestUsageNotification };
}
