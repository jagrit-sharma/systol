// Systol — service worker.
//
// This file MUST live at the site root: a worker's scope is its own directory
// and below, so anywhere else it couldn't control the app it's meant to serve.
//
// Strategy: cache-first for everything. Systol is a handful of static files
// with no server and no network content — the heart-rate data comes from
// Bluetooth (local hardware), not the network — so once the shell is cached
// there is nothing left worth going to the network for. That makes the app
// fully usable offline, including across refreshes.
//
// Staleness is prevented by VERSION below: the cache name is stamped with it,
// and activate deletes every cache that isn't the current one. Bump VERSION on
// each deploy (keep it in step with APP_VERSION in app.js) and old files can't
// survive. New workers take over immediately (skipWaiting + clients.claim), so
// the next load after a deploy is always current.

"use strict";

const VERSION = "1.0.1";           // keep in step with APP_VERSION (app.js §1)
const CACHE = `systol-v${VERSION}`;

// The complete app shell. Relative paths: the site is served from a
// subdirectory (/systol/), so leading slashes would resolve to the wrong host
// root. "./" is the start URL — the app itself.
const SHELL = [
  "./",
  "./index.html",
  "./faq.html",
  "./app.js",
  "./style.css",
  "./systol-bgfx.js",
  "./manifest.webmanifest",
  "./assets/icons/favicon.svg",
  "./assets/icons/favicon.ico",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/icon-monochrome-512.png",
  "./assets/img/browsers/arc.svg",
  "./assets/img/browsers/brave.svg",
  "./assets/img/browsers/chrome.svg",
  "./assets/img/browsers/edge.svg",
  "./assets/img/browsers/opera.svg",
  "./assets/img/browsers/samsung_internet.svg",
  "./assets/img/browsers/vivaldi.svg",
  "./assets/img/stores/flathub_dark.svg",
  "./assets/img/stores/flathub_light.svg",
  "./assets/img/stores/ms_store_dark.svg",
  "./assets/img/stores/ms_store_light.svg",
  "./assets/img/stores/playstore_dark.svg",
  "./assets/img/stores/playstore_light.svg",
];

// INSTALL — fill the versioned cache, then step in front of the old worker.
// Individual adds rather than cache.addAll(): addAll is all-or-nothing, so one
// 404 (a renamed asset, say) would fail the whole install and leave the user
// with no offline app at all. Here a missing file costs only that file.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })) // bypass the HTTP cache
            .catch((err) => console.warn("[sw] skipped", url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// ACTIVATE — drop every cache that isn't this version, then take over open
// pages so the update lands without waiting for a second navigation.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// FETCH — cache first, network as the fallback that also refills the cache.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is cacheable, and only our own origin: a cross-origin request
  // (were one ever added) should go straight to the network untouched.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;

      return fetch(request)
        .then((res) => {
          // Cache successful same-origin responses so anything missed at
          // install time (or added later) is available offline next time.
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline and not cached. For a page navigation, serve the app
          // shell rather than the browser's error page — this is what makes
          // a refresh (and any in-app URL, e.g. ?demo) work with no network.
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        });
    })
  );
});
