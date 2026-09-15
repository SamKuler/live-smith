import type { SunoCaptchaVersion } from "../../audio-services/suno-verification.js";

/** Runs on an actual Suno document. Opaque results go only to the native pipe. */
export function buildSunoVerificationScript(version: SunoCaptchaVersion, locale: string, styles: string): string {
  return clientScript.replace("__LIVE_SMITH_VERIFICATION_CONFIG__", JSON.stringify({ version, locale, styles }));
}

// Literal client source avoids dependence on bundler-renamed closure helpers.
const clientScript = String.raw`(function mountSunoVerification(config) {
  if (window.top !== window || window.location.origin !== "https://suno.com" ||
      document.getElementById("live-smith-verification")) return;
  const browser = window;
  const zh = config.locale === "zh-CN" || config.locale === "system" && navigator.language.toLowerCase().startsWith("zh");
  const text = zh ? {
    title: "Suno 手工验证", origin: "官方验证 · suno.com", start: "开始验证", retry: "重试验证", cancel: "取消生成",
    initial: "点击开始验证。如果出现题目，请手工完成。", loading: "正在加载官方验证组件…",
    pending: "等待验证结果。如果出现题目，请手工完成。", success: "验证完成", continuing: "正在继续原来的生成请求…",
    failed: "验证未完成，可以重试。尚未提交生成请求。", timeout: "验证没有返回结果，可以重试。尚未提交生成请求。",
    unavailable: "此环境无法完成官方验证。尚未提交生成请求。", note: "验证通过后会继续这次音乐生成。取消或关闭窗口不会提交生成请求。",
  } : {
    title: "Verify with Suno", origin: "Official verification · suno.com", start: "Start verification", retry: "Retry verification", cancel: "Cancel generation",
    initial: "Start verification. Complete any challenge yourself.", loading: "Loading official verification…",
    pending: "Waiting for verification. Complete any challenge yourself.", success: "Verified", continuing: "Continuing your original generation request…",
    failed: "Verification did not finish. You can retry. No generation was submitted.", timeout: "Verification did not respond. You can retry. No generation was submitted.",
    unavailable: "Official verification is unavailable in this environment. No generation was submitted.", note: "Verification continues this music request. Cancelling or closing this window does not submit generation.",
  };
  const host = document.createElement("div");
  host.id = "live-smith-verification";
  // hCaptcha's own challenge layer must remain above this app-owned panel.
  host.style.cssText = "position:fixed;inset:0;z-index:2147483000";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = config.styles;
  root.appendChild(style);
  const main = document.createElement("main");
  main.innerHTML = '<header><p id="origin"></p><h1 id="title"></h1></header><p id="status" role="status" aria-live="polite"></p><div id="widget"></div><div class="actions"><button type="button" id="start"></button><button type="button" id="cancel" class="secondary"></button></div><p id="note"></p>';
  root.appendChild(main);
  const start = root.getElementById("start");
  const cancel = root.getElementById("cancel");
  const status = root.getElementById("status");
  const container = root.getElementById("widget");
  root.getElementById("title").textContent = text.title;
  root.getElementById("origin").textContent = text.origin;
  root.getElementById("note").textContent = text.note;
  status.textContent = text.initial;
  start.textContent = text.start;
  cancel.textContent = text.cancel;
  document.body.appendChild(host);
  let attempt = 0;
  let active = false;
  let finished = false;
  let sdk;
  let widgetId;
  let deadline;
  let loader;
  let mountedAttempt = -1;
  function removeWidget() {
    if (sdk && widgetId !== undefined) { try { sdk.remove(widgetId); } catch {} }
    widgetId = undefined;
    container.replaceChildren();
  }
  function send(value) {
    if (finished) return;
    finished = true;
    active = false;
    attempt++;
    clearTimeout(deadline);
    removeWidget();
    start.disabled = true;
    cancel.disabled = true;
    observer.disconnect();
    browser.webkit?.messageHandlers?.liveSmithVerification?.postMessage(value);
  }
  function fail(id, code) {
    if (id !== attempt || !active || finished) return;
    active = false;
    clearTimeout(deadline);
    removeWidget();
    if (code === "unsupported-domain" || code === "unsupported-environment") {
      status.textContent = text.unavailable;
      send({ type: "failed", code });
      return;
    }
    status.textContent = code.includes("timeout") ? text.timeout : text.failed;
    start.textContent = text.retry;
    start.disabled = false;
  }
  function errorCode(value) {
    if (config.version === 2 && typeof value === "string" && ["110100", "110110", "110200"].includes(value) ||
        config.version === 1 && ["invalid-domain", "sitekey-secret-mismatch", "invalid-sitekey"].includes(String(value))) return "unsupported-domain";
    if (config.version === 2 && value === "110500") return "unsupported-environment";
    return "widget-error";
  }
  function mount(id) {
    if (id !== attempt || !active || finished || mountedAttempt === id) return;
    mountedAttempt = id;
    sdk = browser[config.version === 2 ? "turnstile" : "hcaptcha"];
    if (!sdk || typeof sdk.render !== "function" || typeof sdk.execute !== "function") return fail(id, "sdk-unavailable");
    clearTimeout(deadline);
    status.textContent = text.pending;
    const callbacks = {
      callback(token) {
        if (id !== attempt || !active || finished) return;
        if (typeof token !== "string" || !token.length || token.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(token)) return fail(id, "empty-result");
        status.textContent = text.continuing;
        start.textContent = text.success;
        send({ type: "verified", captchaVersion: config.version, token });
      },
      "error-callback"(value) { fail(id, errorCode(value)); },
      "expired-callback"() { fail(id, "expired"); },
      "timeout-callback"() { fail(id, "verification-timeout"); },
      "chalexpired-callback"() { fail(id, "verification-timeout"); },
      "unsupported-callback"() { fail(id, "unsupported-environment"); },
    };
    try {
      widgetId = sdk.render(container, {
        ...callbacks,
        ...(config.version === 2 ? {
          sitekey: "0x4AAAAAADI7xDNyj-3LcIbi", execution: "execute", appearance: "interaction-only", language: zh ? "zh-cn" : "en",
        } : {
          sitekey: "d65453de-3f1a-4aac-9366-a0f06e52b2ce", size: "invisible", theme: "dark", hl: zh ? "zh-CN" : "en",
        }),
      });
      if (id !== attempt || !active || finished) return removeWidget();
      deadline = setTimeout(() => fail(id, "verification-timeout"), 180000);
      sdk.execute(widgetId);
    } catch { fail(id, "widget-initialization-error"); }
  }
  start.addEventListener("click", () => {
    if (active || finished) return;
    removeWidget();
    const id = ++attempt;
    active = true;
    start.disabled = true;
    status.textContent = text.loading;
    if (browser[config.version === 2 ? "turnstile" : "hcaptcha"]) return mount(id);
    if (loader) loader.remove();
    loader = document.createElement("script");
    const loadedName = "liveSmithCaptchaLoaded_" + id;
    browser[loadedName] = () => mount(id);
    const params = new URLSearchParams({ render: "explicit", onload: loadedName });
    if (config.version === 1) {
      for (const [key, value] of Object.entries({ endpoint: "endpoint", assethost: "assets", imghost: "imgs", reportapi: "reportapi" })) {
        params.set(key, "https://hcaptcha-" + value + "-prod.suno.com");
      }
      params.set("sentry", "false");
    }
    loader.src = (config.version === 2 ? "https://challenges.cloudflare.com/turnstile/v0/api.js" : "https://hcaptcha-endpoint-prod.suno.com/1/api.js") + "?" + params;
    loader.async = true;
    loader.onerror = () => fail(id, "script-load-error");
    deadline = setTimeout(() => fail(id, "script-load-timeout"), 20000);
    document.head.appendChild(loader);
  });
  cancel.addEventListener("click", () => send({ type: "cancelled" }));
  const observer = new MutationObserver(() => {
    const current = browser.document;
    if (finished || host.isConnected || !current?.body || window.location.origin !== "https://suno.com") return;
    if (active) fail(attempt, "page-updated");
    current.body.appendChild(host);
  });
  observer.observe(document, { childList: true, subtree: true });
})(__LIVE_SMITH_VERIFICATION_CONFIG__);`;
