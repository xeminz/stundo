// Adresse des Stundo-Servers (Cloudflare Worker). Wird auch vom Service Worker gelesen.
self.SP_CONFIG = {
  api: location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:8787"
    : "https://stundo.schulplaner-worker.workers.dev",
};
