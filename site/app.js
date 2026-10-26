const profiles = {
  general: { ttl: 60, stale: 120, timeout: 10000, max: 1000 },
  "ai-agent": { ttl: 30, stale: 60, timeout: 15000, max: 2000 },
  "ai-training": { ttl: 300, stale: 900, timeout: 30000, max: 500 },
  "developer-work": { ttl: 120, stale: 300, timeout: 15000, max: 1500 }
};
let selected = "general";
const upstream = document.querySelector("#upstream-url");
const prefix = document.querySelector("#route-prefix");
const preview = document.querySelector("#config-preview");
function safeOrigin(value) { try { return new URL(value).origin; } catch { return "https://api.example.com"; } }
function config() { const p = profiles[selected]; return { workloadProfile: selected, port: 8787, defaultTtlSeconds: p.ttl, staleWhileRevalidateSeconds: p.stale, requestTimeoutMs: p.timeout, maxEntries: p.max, routes: [{ prefix: prefix.value.trim().startsWith("/") ? prefix.value.trim() : `/${prefix.value.trim()}`, upstream: safeOrigin(upstream.value), cacheTtlSeconds: p.ttl }] }; }
function render() { preview.textContent = JSON.stringify(config(), null, 2); }
document.querySelectorAll(".profile-choice").forEach((button) => button.addEventListener("click", () => { selected = button.dataset.profile; document.querySelectorAll(".profile-choice").forEach((item) => item.classList.toggle("active", item === button)); render(); }));
[upstream, prefix].forEach((input) => input.addEventListener("input", render));
document.querySelector("#download-config").addEventListener("click", () => { const file = new Blob([JSON.stringify(config(), null, 2) + "\n"], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(file); link.download = "super-lightning.config.json"; link.click(); URL.revokeObjectURL(link.href); });
render();
