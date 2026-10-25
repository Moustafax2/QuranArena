// Retire the old blanket cache. Offline content needs a separate Content Sync design.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("quran-reader-")) await caches.delete(name);
    }
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
