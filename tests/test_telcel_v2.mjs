import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";

// Invocado desde test_parser.mjs: reutiliza únicamente sus stubs visuales, sin red.
export async function testTelcelV2(fixtures) {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("../src/MiTelcelWidgetv2.js", import.meta.url), "utf8");
  const AsyncFunction = (async () => {}).constructor;
  // Mismo contexto asíncrono de Scriptable: admite y comprueba el await del arranque.
  const loadV2 = async () => {
    const module = { exports: {} };
    await new AsyncFunction("module", source)(module);
    return module.exports;
  };
  const v2 = await loadV2();
  const globals = ["FileManager", "Keychain", "Request", "fetch", "config", "Script", "Alert", "WebView", "Timer", "Notification"];
  const originals = new Map(globals.map(k => [k, globalThis[k]]));
  const originalConfig = { ...v2.CONFIG };
  const originalWarn = console.warn;
  const originalPreview = ListWidget.prototype.presentSmall;
  const now = new Date("2026-11-25T18:00:00Z");
  const phone = "0000000000";
  const password = "fake password + &= ñ";
  let files, keys, calls, warnings, failure, storageFailure, started;
  const path = name => `/mock/${name}`;
  const state = () => JSON.parse(files.get(path(v2.CONFIG.stateFileName)));
  const reset = (configured = true) => {
    files = new Map(); keys = new Map([["TELCEL_PHONE", phone], ["TELCEL_PASS", password]]);
    calls = []; warnings = []; failure = ""; storageFailure = false; started = null;
    v2.CONFIG.authMethod = "oidc";
    v2.saveState({ version: 2, configured, paused: false, nextAllowedAt: 0 });
  };
  const respond = req => {
    calls.push(req);
    if (req.url.endsWith("/login") && req.url.includes("www.mitelcel.com")) {
      return { text: '<script src="./assets/index-test.js" type="module"></script>' };
    }
    if (req.url.endsWith("/assets/index-test.js")) {
      return { text: 'const c={"MTL_AUTHORIZATION_BASIC": "Basic cHVibGljOmZha2U="};' };
    }
    if (req.url.includes("/authorize?")) {
      if (failure === "login401") return { statusCode: 401, text: "secret body must never be logged" };
      if (failure === "login429") return { statusCode: 429, text: "locked" };
      if (failure === "timeout") throw new Error("unsafe request URL and credentials");
      if (failure === "emptyOIDC") return { text: "<html>bot protection</html>" };
      started?.();
      const state = new URL(req.url).searchParams.get("state");
      return { statusCode: 302, location: `https://mtl.smapps.mx:1333/sso/callback?code=fake_code&state=${failure === "wrongState" ? "other" : state}` };
    }
    if (req.url.endsWith("/oid-authorize-prod/token")) return { text: JSON.stringify({ access_token: "fake_sso" }) };
    if (req.url.includes("/v2/token?")) {
      if (failure === "exchange401") return { statusCode: 401, text: "expired public key" };
      if (failure === "emptyB2F") return { text: '{"tokenResponse":{"tokens":[]}}' };
      return { text: JSON.stringify({ tokenResponse: { tokens: [{ id: "token:b2f", access_token: "fake_b2f" }] } }) };
    }
    if (req.url.includes("/flow/home?")) {
      if (failure === "home503") return { statusCode: 503, text: "offline" };
      if (failure === "homeInvalid") return { text: "{}" };
      if (failure === "highUsage") return { text: JSON.stringify({ blocks: { children: [
        { id: "tabs-plans-v2-plan-name-0-0-0", config: { value: "Plan de prueba" } },
        { id: "tabs-plans-v2-total-data-value-0-0-0", config: { value: 10000 } },
        { id: "tabs-plans-v2-used-data-value-0-0-0", config: { value: 8000 } },
        { id: "tabs-plans-v2-available-data-value-0-0-0", config: { value: 2000 } },
        { id: "tabs-plans-v2-limited-cutoff-message-0-0-0", config: { segments: [{ text: "Faltan 7 días" }] } }
      ] } }) };
      return { text: JSON.stringify(fixtures[0]) };
    }
    if (req.url.endsWith("/sso/revoke")) {
      if (failure === "revoke") return { statusCode: 503, text: "offline" };
      return { text: "ok" };
    }
    if (req.url === "https://wbl.telcel-id.com:8443/login") {
      return failure === "webloginEmpty" ? { text: "" } : { statusCode: 302, location: "https://wbl.telcel-id.com:8443/Auth?mock=1" };
    }
    if (req.url === "https://wbl.telcel-id.com:8443/Auth?mock=1") return { text: '{"token":"fake_sso"}' };
    throw new Error(`Unexpected mock route: ${req.url}`);
  };
  class MockRequest {
    constructor(url) { this.url = url; }
    async loadString() {
      const r = respond(this);
      this.response = { statusCode: r.statusCode || 200, headers: r.headers || {}, url: this.url };
      if (r.location) {
        const next = this.onRedirect(new MockRequest(r.location));
        if (next) {
          const result = respond(next);
          this.response.statusCode = result.statusCode || 200;
          return result.text;
        }
      }
      return r.text || "";
    }
  }
  try {
    globalThis.FileManager = { local: () => ({
      documentsDirectory: () => "/mock", joinPath: (a, b) => `${a}/${b}`,
      fileExists: p => files.has(p), readString: p => files.get(p),
      remove: p => files.delete(p),
      writeString: (p, text) => { if (storageFailure) throw new Error("disk full"); files.set(p, text); }
    }) };
    globalThis.Keychain = { contains: k => keys.has(k), get: k => keys.get(k), set: (k, v) => keys.set(k, v) };
    globalThis.Request = MockRequest;
    // Ninguna ruta puede escapar a la simulación por el transporte alternativo.
    globalThis.fetch = async () => { throw new Error("Unexpected real transport"); };
    console.warn = value => warnings.push(value);
    reset();

    // Parser original conservado, incluyendo Plan+Promo, web duplicado y cambios de plan.
    const original = require("../src/MiTelcelWidget.js");
    for (const fixture of fixtures) {
      const expected = original.parseTelcelResponse(fixture);
      const parsed = v2.parseTelcelResponse(fixture, now);
      for (const key of ["consumedMB", "totalMB", "availableMB", "daysLeft", "buckets", "promo"]) {
        assert.deepEqual(parsed[key], expected[key]);
      }
    }
    assert.equal(v2.extractMtlBasic("MTL_AUTHORIZATION_BASIC='abc='"), "abc=");
    assert.equal(v2.extractMtlBasic('MTL_AUTHORIZATION_BASIC:"Basic abc="'), "abc=");
    assert.equal(v2.resolveAsset("./assets/index.js", "https://www.mitelcel.com/login"), "https://www.mitelcel.com/assets/index.js");
    assert.equal(v2.resolveAsset("//evil.test/index.js", "https://www.mitelcel.com/login"), null);

    // El error de la captura era genérico: distinguir qué campo falló sin contactar Telcel.
    for (const [creds, code] of [
      [{ phone: "", password }, "phone"],
      [{ phone: "00000", password }, "phone"],
      [{ phone, password: "" }, "password"],
      [{ phone, password: "   " }, "password"]
    ]) {
      reset();
      const before = files.get(path(v2.CONFIG.stateFileName));
      await assert.rejects(() => v2.fetchTelcelData(creds, { now }), e => e.code === code && !e.message.includes(password));
      assert.equal(calls.length, 0);
      assert.equal(files.get(path(v2.CONFIG.stateFileName)), before);
    }
    reset();
    started = () => {
      assert.equal(state().paused, true); // Protección persistida antes de enviar contraseña.
      assert(state().nextAllowedAt > now.getTime());
    };
    const data = await v2.fetchTelcelData(undefined, { now });
    assert.equal(data.totalMB, 15001);
    assert.equal(state().paused, false);
    assert.equal(state().nextAllowedAt, now.getTime() + 3600000);
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 1);
    assert.equal(calls.filter(r => r.url.endsWith("/sso/revoke")).length, 1);
    assert.equal(calls.find(r => r.url.includes("/authorize?")).headers.PASSWORD, password);
    assert.equal(calls.some(r => r.url.includes("wbl.telcel-id")), false);
    assert.equal(calls.some(r => r.url.startsWith("https://mtl.smapps.mx")), false);
    assert.equal(calls.find(r => r.url.endsWith("/sso/revoke")).body, "token=fake_sso&token_type=revoke");
    for (const text of files.values()) {
      for (const secret of [phone, password, "fake_sso", "fake_b2f", "fake_code"]) assert(!text.includes(secret));
    }
    const count = calls.length;
    await assert.rejects(() => v2.fetchTelcelData(undefined, { now }), e => e.code === "wait");
    assert.equal(calls.length, count);
    await v2.fetchTelcelData(undefined, { now: new Date(now.getTime() + 3600000) });
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 2);

    for (const scenario of ["login401", "login429", "timeout", "emptyOIDC", "wrongState", "exchange401", "emptyB2F"]) {
      reset(); failure = scenario;
      await assert.rejects(() => v2.fetchTelcelData(undefined, { now }), e => e instanceof v2.TelcelError);
      assert.equal(state().paused, true, scenario);
      const count = calls.length;
      // Ni la ejecución manual ni el paso de varias horas reactivan automáticamente el acceso.
      await assert.rejects(() => v2.fetchTelcelData(undefined, { manual: true, now }), e => e.code === "wait");
      await assert.rejects(() => v2.fetchTelcelData(undefined, { now: new Date(now.getTime() + 86400000) }), e => e.code === "paused");
      assert.equal(calls.length, count);
      assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 1);
      assert.equal(calls.filter(r => r.url.endsWith("/sso/revoke")).length, ["exchange401", "emptyB2F"].includes(scenario) ? 1 : 0);
      if (["exchange401", "emptyB2F"].includes(scenario)) assert(!files.has(path(v2.CONFIG.basicCacheFileName)));
      if (scenario === "emptyOIDC") assert(!state().message.includes("401"));
      assert(!state().message.includes(password));
      assert(!state().message.includes("unsafe request"));
      failure = "";
      await v2.validateTelcelCredentials(phone, password, { now: new Date(now.getTime() + 31 * 60000) });
      assert.equal(state().paused, false);
    }

    for (const scenario of ["home503", "homeInvalid"]) {
      reset(); failure = scenario;
      await assert.rejects(() => v2.fetchTelcelData(undefined, { now }));
      assert.equal(state().paused, false); // Fallo posterior al login: reintento espaciado.
      assert.equal(state().nextAllowedAt, now.getTime() + 3600000);
      assert.equal(calls.filter(r => r.url.endsWith("/sso/revoke")).length, 1);
    }
    reset(); failure = "revoke";
    await v2.fetchTelcelData(undefined, { now });
    assert.equal(state().paused, true);
    assert.match(state().message, /cierre SSO/);
    assert.equal(v2.loadCache(now).totalMB, 15001);
    const cached = v2.loadCache(new Date(now.getTime() + 2 * 86400000));
    assert.equal(cached.daysLeft, 7);
    assert.equal(cached.updatedAtISO, now.toISOString());
    const widget = v2.createWidget(cached, state(), new Date(now.getTime() + 2 * 86400000));
    assert(widget.texts.some(t => t.includes("Acceso pausado") && t.includes("2 d")));
    assert.equal(widget.images.find(image => image.arcs > 0).arcs, 3);
    assert(widget.refreshAfterDate instanceof Date);
    assert.equal(v2.createWidget(null).url, "scriptable://");
    // Una lectura anticipada de caché no aplaza otros 60 minutos la consulta ya programada.
    const early = new Date(now.getTime() + 20 * 60000);
    const scheduledWidget = v2.createWidget(data, { paused: false, nextAllowedAt: now.getTime() + 3600000 }, early);
    assert.equal(scheduledWidget.refreshAfterDate.getTime(), now.getTime() + 3600000);
    files.set(path(v2.CONFIG.cacheFileName), "[1,2]");
    assert.equal(v2.loadCache(now), null);

    reset();
    files.set(path(v2.CONFIG.stateFileName), "broken");
    assert.equal(v2.loadState(now).paused, true);
    await assert.rejects(() => v2.fetchTelcelData(undefined, { now }));
    assert.equal(calls.length, 0);
    reset(); storageFailure = true;
    await assert.rejects(() => v2.fetchTelcelData(undefined, { now }), e => e.code === "storage");
    assert.equal(calls.length, 0);

    // Una ejecución en widget recién instalado no reutiliza la contraseña antigua.
    reset(false);
    globalThis.config = { runsInWidget: true };
    let rendered;
    globalThis.Script = { name: () => "MiTelcelWidgetv2", setWidget: w => { rendered = w; }, complete() {} };
    await v2.main();
    assert.equal(calls.length, 0);
    assert(rendered.texts.some(t => t.includes("configurar")));
    // Configuración interactiva: una sola sesión valida, obtiene consumo y guarda credenciales.
    globalThis.config.runsInWidget = false;
    let formInputs = null;
    let forms = [];
    let nativeFieldReads = 0;
    let formLoadGate = null;
    let hangOnLoad = false;
    let completeCount = 0;
    globalThis.Script.complete = () => { completeCount++; };
    globalThis.Alert = class {
      addTextField() { throw new Error("Do not capture credentials with native Alert fields"); }
      addSecureTextField() { throw new Error("Do not capture credentials with native Alert fields"); }
      addAction() {} addCancelAction() {}
      async presentAlert() { return 0; }
      // Reproduce el síntoma del dispositivo: el getter nativo devuelve vacío.
      textFieldValue() { nativeFieldReads++; return ""; }
    };
    globalThis.WebView = class {
      async loadHTML(html) {
        if (this.shouldAllowRequest) {
          assert.equal(this.shouldAllowRequest({ url: "about:blank" }), true, "Do not block WKWebView's local navigation");
        }
        this.context = null;
        if (!html.includes("<script>")) return;
        if (hangOnLoad) await new Promise(() => {});
        if (formLoadGate) await formLoadGate;
        const nodes = new Map();
        const node = id => {
          if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: id === "ready", handlers: {},
            focus() {}, addEventListener(event, handler) { this.handlers[event] = handler; } });
          return nodes.get(id);
        };
        this.node = node;
        this.context = createContext({ window: {}, document: { getElementById: node } });
        // Ejecutar el mismo manejador del formulario que se entrega al iPhone.
        runInContext(html.match(/<script>([\s\S]+)<\/script>/)[1], this.context);
        assert.match(html, /connect-src 'none'; form-action 'none'/);
      }
      async present() {
        assert.equal(this.shouldAllowRequest({ url: "https://www.mitelcel.com" }), false);
        while (!this.node("form").hidden) {
          const input = formInputs ? formInputs.shift() : { values: [phone, password], action: 0 };
          assert(input, "Unexpected extra credential prompt");
          forms.push({ message: this.node("error").textContent,
            phoneBefore: this.node("phone").value, calls: calls.length });
          this.node("phone").value = input.values[0];
          this.node("password").value = input.values[1];
          if (input.action === -1) return; // Cerrar con Listo sin Continuar.
          if (input.action === -2) { this.node("cancel").handlers.click(); return; }
          this.node("form").handlers.submit({ preventDefault() {} });
        }
      }
      async evaluateJavaScript(script) {
        const result = runInContext(script, this.context);
        assert.equal(this.context.window.__telcelCredentials, null);
        assert.equal(this.node("phone").value, "");
        assert.equal(this.node("password").value, "");
        return result;
      }
    };
    ListWidget.prototype.presentSmall = async () => {};
    keys.set("TELCEL_PASS", "old invalid password");
    await v2.main();
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 1);
    assert.equal(nativeFieldReads, 0);
    assert.equal(calls.find(r => r.url.includes("/authorize?")).headers.PASSWORD, password);
    assert.equal(state().configured, true);
    assert.equal(keys.get("TELCEL_PASS"), password);
    assert(rendered.texts.includes("Mi Telcel"));
    globalThis.config.runsInWidget = true;
    await v2.main();
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 1);

    // Corregir errores en el mismo DOM, sin consultas ni pausas de acceso nuevas.
    globalThis.config.runsInWidget = false;
    for (const [values, expectedMessage] of [
      [[phone, ""], /Escribe tu contraseña/],
      [[phone, "   "], /Escribe tu contraseña/],
      [["00000", password], /número Telcel a 10 dígitos/]
    ]) {
      reset(false); forms = [];
      formInputs = [{ values, action: 0 }, { values: [phone, password], action: 0 }];
      await v2.main();
      assert.equal(forms.length, 2);
      assert.match(forms[1].message, expectedMessage);
      assert.equal(forms[0].calls, 0);
      assert.equal(forms[1].calls, 0);
      assert.equal(forms[1].phoneBefore, values[0]);
      assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 1);
      assert.equal(keys.get("TELCEL_PASS"), password);
      assert.equal(state().configured, true);
      assert.equal(formInputs.length, 0);
    }
    reset(false); forms = [];
    formInputs = [{ values: [phone, ""], action: 0 }, { values: [phone, ""], action: -1 }];
    const beforeCancel = files.get(path(v2.CONFIG.stateFileName));
    await v2.main();
    assert.equal(calls.length, 0);
    assert.equal(files.get(path(v2.CONFIG.stateFileName)), beforeCancel);
    reset(false);
    formInputs = [{ values: [phone, password], action: -2 }];
    await v2.main();
    assert.equal(calls.length, 0);
    assert.equal(state().configured, false);
    formInputs = null;

    // Ejecutar el ARCHIVO COMPLETO: no debe terminar mientras WKWebView aún carga.
    reset(false); forms = [];
    formInputs = [{ values: [phone, ""], action: -1 }];
    let releaseLoad;
    formLoadGate = new Promise(resolve => { releaseLoad = resolve; });
    let entryFinished = false;
    const beforeComplete = completeCount;
    const entry = loadV2().then(() => { entryFinished = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(entryFinished, false);
    assert.equal(completeCount, beforeComplete);
    releaseLoad();
    await entry;
    assert.equal(completeCount, beforeComplete + 1);
    assert.equal(forms.length, 1);
    assert.equal(calls.length, 0);
    formLoadGate = null;
    formInputs = null;

    // Una carga que no termina debe mostrar un error acotado, sin abrir sesión.
    reset(false);
    const timerCallbacks = [];
    let invalidatedTimers = 0;
    globalThis.Timer = { schedule: (_milliseconds, _repeat, callback) => {
      timerCallbacks.push(callback);
      return { invalidate() { invalidatedTimers++; } };
    } };
    hangOnLoad = true;
    const frozenRun = v2.main();
    assert.equal(timerCallbacks.length, 1);
    timerCallbacks[0]();
    await frozenRun;
    assert.equal(calls.length, 0);
    assert.equal(state().paused, false);
    assert(warnings.some(message => message.includes("Abrir formulario") && message.includes("no respondió")));
    assert(invalidatedTimers >= 1);
    hangOnLoad = false;
    delete globalThis.Timer;

    // Error de configuración: no persistir la contraseña introducida ni entrar en bucle de alertas.
    reset(false); failure = "login401";
    globalThis.config.runsInWidget = false;
    keys.set("TELCEL_PASS", "old invalid password");
    await v2.main();
    assert.equal(keys.get("TELCEL_PASS"), "old invalid password");
    assert.equal(state().configured, false);
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 1);

    reset(false); failure = "revoke";
    keys.set("TELCEL_PASS", "old invalid password");
    await v2.main();
    assert.equal(keys.get("TELCEL_PASS"), "old invalid password");
    assert.equal(state().paused, true);
    assert.equal(state().configured, false);
    assert(v2.loadCache()); // Se conserva la gráfica válida aunque no se guarde el nuevo acceso.

    // Transporte fetch de Node: OIDC manual y WebLogin siguen solo el salto SSO permitido.
    reset(); delete globalThis.Request;
    globalThis.fetch = async (url, opts) => {
      const r = respond({ url, ...opts });
      return { status: r.statusCode || 200, url, text: async () => r.text || "",
        headers: new Headers({ ...(r.headers || {}), ...(r.location ? { location: r.location } : {}) }) };
    };
    await v2.fetchTelcelData(undefined, { now });
    assert.equal(calls.find(r => r.url.includes("/authorize?")).redirect, "manual");
    reset(); v2.CONFIG.authMethod = "weblogin";
    await v2.fetchTelcelData(undefined, { now });
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 0);
    assert.equal(calls.filter(r => r.url.endsWith("/sso/revoke")).length, 1);
    reset(); v2.CONFIG.authMethod = "weblogin"; failure = "webloginEmpty";
    await assert.rejects(() => v2.fetchTelcelData(undefined, { now }));
    assert.equal(calls.filter(r => r.url.includes("/authorize?")).length, 0);
    assert.equal(state().paused, true);
    // Un módulo recién cargado también respeta la pausa persistida.
    delete globalThis.Script;
    const restarted = await loadV2();
    const countAfterFailure = calls.length;
    await assert.rejects(() => restarted.fetchTelcelData(undefined, { now: new Date(now.getTime() + 86400000) }), e => e.code === "paused");
    assert.equal(calls.length, countAfterFailure);

    // Alertas: límites de porcentaje/días, datos recientes y días confirmados.
    const usage = (percent = 80, daysLeft = 7, at = now, cutoffISO = "2026-12-02") => ({
      totalMB: 10000, consumedMB: percent * 100, availableMB: 10000 - percent * 100,
      daysLeft, cutoffISO, updatedAtISO: at.toISOString(), fromCache: false, daysLeftEstimated: false
    });
    for (const [percent, days, level] of [
      [79.99, 30, null], [80, 6, null], [80, 7, 1], [80, 30, 1],
      [89.99, 3, null], [90, 2, null], [90, 3, 2], [94.99, 2, null],
      [95, 2, 3], [100, 1, null], [100, 0, null], [100, 20, 3]
    ]) assert.equal(v2.usageAlertRisk(usage(percent, days), now)?.level ?? null, level, `${percent}%/${days}d`);
    for (const override of [
      { fromCache: true }, { daysLeftEstimated: true }, { totalMB: 0 }, { availableMB: -1 },
      { consumedMB: NaN }, { daysLeft: 2.5 }, { cutoffISO: "2026-02-30" },
      { updatedAtISO: new Date(now.getTime() - 16 * 60000).toISOString() },
      { updatedAtISO: new Date(now.getTime() + 1000).toISOString() }
    ]) assert.equal(v2.usageAlertRisk({ ...usage(), ...override }, now), null);
    v2.CONFIG.usageAlertsEnabled = false;
    assert.equal(v2.usageAlertRisk(usage(), now), null);
    v2.CONFIG.usageAlertsEnabled = true;
    const estimated = v2.parseTelcelResponse({ blocks: { children: [
      { id: "tabs-plans-v2-plan-name-0-0-0", config: { value: "Plan" } },
      { id: "tabs-plans-v2-total-data-value-0-0-0", config: { value: 10000 } },
      { id: "tabs-plans-v2-used-data-value-0-0-0", config: { value: 9000 } }
    ] } }, now);
    assert.equal(estimated.daysLeftEstimated, true);
    assert.equal(v2.usageAlertRisk(estimated, now), null);

    let scheduled = [];
    let notificationAttempts = 0;
    let notificationFailure = false;
    let onSchedule = null;
    let notificationGate = null;
    globalThis.Notification = class {
      setTriggerDate(date) { this.triggerDate = date; }
      async schedule() {
        notificationAttempts++;
        onSchedule?.();
        if (notificationFailure) throw new Error(`Private error ${password}`);
        if (notificationGate) await notificationGate;
        scheduled.push({ ...this });
      }
    };
    const later = hours => new Date(now.getTime() + hours * 3600000);
    reset();
    assert.deepEqual(await Promise.all([v2.notifyUsageRisk(usage(), now), v2.notifyUsageRisk(usage(), now)]), [true, false]);
    assert.equal(scheduled.length, 1);
    assert.match(scheduled[0].body, /80%.*7 días.*2\.00 GB/);
    assert.equal(scheduled[0].sound, "default");
    assert.equal(scheduled[0].triggerDate.getTime(), now.getTime() + 1000);
    assert.equal(await v2.notifyUsageRisk(usage(90, 3, later(23)), later(23)), false);
    assert.equal(await v2.notifyUsageRisk(usage(90, 3, later(24)), later(24)), true);
    assert.equal(await v2.notifyUsageRisk(usage(95, 2, later(25)), later(25)), false);
    assert.equal(await v2.notifyUsageRisk(usage(95, 2, later(48)), later(48)), true);
    // No rearmar un nivel menor ni otro aviso por un día de diferencia del servidor.
    assert.equal(await v2.notifyUsageRisk(usage(80, 7, later(72)), later(72)), false);
    assert.equal(await v2.notifyUsageRisk(usage(95, 2, later(72), "2026-12-03"), later(72)), false);
    assert.equal(scheduled.length, 3);
    // El historial en disco también se respeta después de cargar un módulo nuevo.
    const afterRestart = await loadV2();
    assert.equal(await afterRestart.notifyUsageRisk(usage(95, 2, later(72)), later(72)), false);
    assert.equal(await v2.notifyUsageRisk(usage(80, 7, later(72), "2027-01-02"), later(72)), true);
    assert.equal(scheduled.length, 4);
    for (const text of files.values()) {
      for (const secret of [phone, password, "fake_sso", "fake_b2f"]) assert(!text.includes(secret));
    }
    assert.equal(calls.length, 0); // Las alertas no consultan la red.

    // Una programación pendiente conserva la reserva incluso tras pasar 24 horas.
    reset(); scheduled = [];
    let releaseNotification;
    notificationGate = new Promise(resolve => { releaseNotification = resolve; });
    const pendingNotification = v2.notifyUsageRisk(usage(), now);
    assert.equal(await v2.notifyUsageRisk(usage(80, 7, later(48)), later(48)), false);
    releaseNotification();
    assert.equal(await pendingNotification, true);
    assert.equal(scheduled.length, 1);
    notificationGate = null;

    // Permisos/almacenamiento: no alterar la sesión ni perder la gráfica.
    reset(); scheduled = []; notificationAttempts = 0; notificationFailure = true;
    const sessionBefore = files.get(path(v2.CONFIG.stateFileName));
    assert.equal(await v2.notifyUsageRisk(usage(), now), false);
    assert.equal(await v2.notifyUsageRisk(usage(), now), false);
    assert.equal(notificationAttempts, 1);
    assert.equal(files.get(path(v2.CONFIG.stateFileName)), sessionBefore);
    notificationFailure = false;
    assert.equal(await v2.notifyUsageRisk(usage(80, 7, later(1)), later(1)), true);
    assert.equal(scheduled.length, 1);
    reset(); scheduled = []; notificationAttempts = 0; storageFailure = true;
    assert.equal(await v2.notifyUsageRisk(usage(), now), false);
    assert.equal(notificationAttempts, 0);
    storageFailure = false;
    files.set(path(v2.CONFIG.alertStateFileName), "broken");
    assert.equal(await v2.notifyUsageRisk(usage(), now), false);
    assert.equal(notificationAttempts, 0);
    assert.equal(state().paused, false);
    // La prueba manual no modifica los límites automáticos ni autentica.
    const alertHistoryBeforeTest = files.get(path(v2.CONFIG.alertStateFileName));
    await v2.sendTestUsageNotification(now);
    assert.equal(scheduled[0].identifier, "mitelcel-v2-usage-test");
    assert.equal(files.get(path(v2.CONFIG.alertStateFileName)), alertHistoryBeforeTest);
    assert.equal(calls.length, 0);
    notificationFailure = true;
    await assert.rejects(() => v2.sendTestUsageNotification(now), e => e.code === "notification" && !e.message.includes(password));
    notificationFailure = false;

    // Integración real de main con transporte simulado: primero revocar, luego avisar.
    reset(); failure = "highUsage"; scheduled = []; notificationAttempts = 0;
    globalThis.config = { runsInWidget: true };
    let widgetReady = false;
    globalThis.Script = { name: () => "Mi Telcel", setWidget: () => { widgetReady = true; }, complete() {} };
    onSchedule = () => {
      assert(calls.at(-1).url.endsWith("/sso/revoke"));
      assert.equal(state().paused, false);
      assert.equal(widgetReady, true);
    };
    await v2.main();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].openURL, "scriptable:///run?scriptName=Mi%20Telcel");
    const networkAfterAlert = calls.length;
    await v2.main();
    assert.equal(scheduled.length, 1);
    assert.equal(calls.length, networkAfterAlert);
    onSchedule = null;
    // Durante el intervalo de protección se puede probar la notificación sin otro login.
    globalThis.config.runsInWidget = false;
    const historyBeforeMenu = files.get(path(v2.CONFIG.alertStateFileName));
    await v2.main(); // El stub selecciona la única acción: Probar notificación.
    assert.equal(scheduled.at(-1).identifier, "mitelcel-v2-usage-test");
    assert.equal(calls.length, networkAfterAlert);
    assert.equal(files.get(path(v2.CONFIG.alertStateFileName)), historyBeforeMenu);
    // Si falla la notificación después de un consumo válido, el acceso sigue habilitado.
    reset(); failure = "highUsage"; notificationFailure = true; scheduled = [];
    globalThis.config.runsInWidget = true;
    await v2.main();
    assert.equal(state().paused, false);
    assert(v2.loadCache());
    assert.equal(scheduled.length, 0);
    console.log("✅ Alertas Telcel: umbrales, caché, ciclos, 24 h, permisos y revocación previa sin red.");
    console.log("✅ Telcel v2: acceso, revocación, pausa persistente, caché y actualización sin red.");
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    Object.assign(v2.CONFIG, originalConfig);
    console.warn = originalWarn;
    if (originalPreview === undefined) delete ListWidget.prototype.presentSmall;
    else ListWidget.prototype.presentSmall = originalPreview;
  }
}
