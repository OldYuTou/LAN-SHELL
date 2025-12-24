/**
* Copyright (c) 2025 OldYuTou https://github.com/OldYuTou
* Project: LAN-SHELL
* Released under the MIT License.
* 欢迎使用并提供反馈!
* Hope to get your advice!
*/

// Minimal Service Worker for installable PWA.
// Network-only fetch so UI always stays fresh (no caching side effects).

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
