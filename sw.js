const CACHE_PREFIX = 'fitcounter-';
const CACHE_VERSION = 'v6';
const APP_CACHE = `${CACHE_PREFIX}app-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(
        keys
          .filter(key => (
            key.startsWith(CACHE_PREFIX)
            && key !== APP_CACHE
            && key !== RUNTIME_CACHE
          ))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isCacheable(response){
  return (
    response
    && response.ok
    && response.type === 'basic'
  );
}

async function fetchAndCacheNavigation(request){
  try{
    const response = await fetch(request);

    if(isCacheable(response)){
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }

    return response;
  }
  catch(error){
    return null;
  }
}

async function cacheFirstNavigation(request, event){
  const runtimeCache = await caches.open(RUNTIME_CACHE);
  const cached = (
    await runtimeCache.match(request, {ignoreSearch: true})
    || await caches.match('./index.html', {ignoreSearch: true})
    || await caches.match('./', {ignoreSearch: true})
  );

  if(cached){
    /* На iPhone сразу показываем сохранённое приложение, не ожидая сеть. */
    event.waitUntil(fetchAndCacheNavigation(request));
    return cached;
  }

  return (
    await fetchAndCacheNavigation(request)
    || new Response('FitCounter недоступен офлайн', {
      status: 503,
      headers: {'Content-Type': 'text/plain; charset=utf-8'}
    })
  );
}

async function cacheFirstAsset(request){
  const cached = await caches.match(request);

  if(cached){
    return cached;
  }

  try{
    const response = await fetch(request);

    if(isCacheable(response)){
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }

    return response;
  }
  catch(error){
    return new Response('', {status: 504, statusText: 'Offline'});
  }
}

self.addEventListener('fetch', event => {
  const {request} = event;

  if(request.method !== 'GET'){
    return;
  }

  const url = new URL(request.url);

  /* Не кэшируем сторонние запросы и не меняем их поведение. */
  if(url.origin !== self.location.origin){
    return;
  }

  if(request.mode === 'navigate'){
    event.respondWith(cacheFirstNavigation(request, event));
    return;
  }

  event.respondWith(cacheFirstAsset(request));
});
