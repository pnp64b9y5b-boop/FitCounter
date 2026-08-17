import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDirectory, '..');
const origin = 'https://example.test';

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const serviceWorkerSource = read('sw.js');
const manifest = JSON.parse(read('manifest.json'));

assert.match(
  html,
  /\.warm \.bar span\s*\{[\s\S]*?background:\s*#20e7ff;/,
  'warm-up progress bar must use the neon blue color'
);

assert.match(
  html,
  /id=["']warmMinus["']/,
  'warm-up card must provide a decrease control'
);

assert.match(
  html,
  /id=["']warmPlus["']/,
  'warm-up card must provide an increase control'
);

assert.match(
  html,
  /const WARM_DEFAULT_MINUTES\s*=\s*10;/,
  'warm-up timer must default to 10 minutes'
);

assert.match(
  html,
  /const WARM_MAX_MINUTES\s*=\s*60;/,
  'warm-up timer must cap custom duration at 60 minutes'
);

assert.match(
  html,
  /fitcounter_warm_minutes_v1/,
  'warm-up duration must be persisted locally'
);

assert.match(
  html,
  /<link\s+rel=["']manifest["']\s+href=["']\.\/manifest\.json["']>/i,
  'index.html must link the web app manifest'
);

const expectedIcons = new Map([
  ['./icons/icon-192.png', [192, 192]],
  ['./icons/icon-512.png', [512, 512]],
  ['./icons/icon-maskable-512.png', [512, 512]]
]);

for(const icon of manifest.icons){
  assert.ok(expectedIcons.has(icon.src), `unexpected manifest icon: ${icon.src}`);

  const file = path.join(root, icon.src.replace(/^\.\//, ''));
  const png = fs.readFileSync(file);
  const dimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];

  assert.deepEqual(
    dimensions,
    expectedIcons.get(icon.src),
    `${icon.src} has incorrect dimensions`
  );
}

assert.equal(manifest.icons.length, expectedIcons.size);

for(const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].entries()){
  assert.doesNotThrow(
    () => new Function(match[1]),
    `inline script ${index + 1} must parse`
  );
}

const documentIds = [
  ...html.matchAll(/\sid=["']([^"']+)["']/gi)
].map(match => match[1]);
const duplicateIds = documentIds.filter(
  (id, index) => documentIds.indexOf(id) !== index
);

assert.deepEqual(
  [...new Set(duplicateIds)],
  [],
  'HTML IDs must be unique'
);

const referencedIds = [
  ...html.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)
].map(match => match[1]);
const missingIds = referencedIds.filter(id => !documentIds.includes(id));

assert.deepEqual(
  [...new Set(missingIds)],
  [],
  'all JavaScript element references must exist in the document'
);

const handlers = {};
const cacheBuckets = new Map();
const openedCaches = [];
const deletedCaches = [];
let skipWaitingCalls = 0;
let claimCalls = 0;
let fetchImplementation = async () => {
  throw new Error('network is offline');
};

const normalizeRequest = request => new URL(
  typeof request === 'string' ? request : request.url,
  `${origin}/`
).href;

const cloneResponse = response => (
  typeof response?.clone === 'function'
    ? response.clone()
    : response
);

class MockCache{
  constructor(){
    this.entries = new Map();
    this.precached = [];
  }

  async addAll(files){
    this.precached = [...files];
  }

  async put(request, response){
    this.entries.set(normalizeRequest(request), cloneResponse(response));
  }

  async match(request){
    return cloneResponse(this.entries.get(normalizeRequest(request)));
  }
}

const cachesMock = {
  async open(name){
    openedCaches.push(name);

    if(!cacheBuckets.has(name)){
      cacheBuckets.set(name, new MockCache());
    }

    return cacheBuckets.get(name);
  },

  async keys(){
    return [...cacheBuckets.keys()];
  },

  async delete(name){
    deletedCaches.push(name);
    return cacheBuckets.delete(name);
  },

  async match(request){
    for(const cache of cacheBuckets.values()){
      const response = await cache.match(request);

      if(response){
        return response;
      }
    }

    return undefined;
  }
};

const selfMock = {
  location: new URL(`${origin}/sw.js`),
  clients: {
    async claim(){
      claimCalls += 1;
    }
  },
  addEventListener(type, handler){
    handlers[type] = handler;
  },
  async skipWaiting(){
    skipWaitingCalls += 1;
  }
};

vm.runInNewContext(serviceWorkerSource, {
  self: selfMock,
  caches: cachesMock,
  fetch: request => fetchImplementation(request),
  URL,
  Response,
  Promise,
  console
});

let installPromise;
handlers.install({
  waitUntil(promise){
    installPromise = promise;
  }
});
await installPromise;

assert.equal(skipWaitingCalls, 1, 'new service worker must activate immediately');
assert.equal(openedCaches[0], 'fitcounter-app-v4');

const appCache = cacheBuckets.get('fitcounter-app-v4');

for(const entry of appCache.precached){
  const localPath = entry === './'
    ? path.join(root, 'index.html')
    : path.join(root, entry.replace(/^\.\//, ''));

  assert.ok(fs.existsSync(localPath), `precache file does not exist: ${entry}`);
}

cacheBuckets.set('fitcounter-offline-v1', new MockCache());
cacheBuckets.set('fitcounter-runtime-v3', new MockCache());
cacheBuckets.set('unrelated-cache', new MockCache());

let activatePromise;
handlers.activate({
  waitUntil(promise){
    activatePromise = promise;
  }
});
await activatePromise;

assert.ok(deletedCaches.includes('fitcounter-offline-v1'));
assert.ok(deletedCaches.includes('fitcounter-runtime-v3'));
assert.ok(cacheBuckets.has('unrelated-cache'), 'unrelated caches must be preserved');
assert.equal(claimCalls, 1, 'active service worker must claim open clients');

const basicResponse = (body, options) => {
  const response = new Response(body, options);
  Object.defineProperty(response, 'type', {value: 'basic'});
  return response;
};

const dispatchFetch = request => {
  let responsePromise;

  handlers.fetch({
    request,
    respondWith(promise){
      responsePromise = Promise.resolve(promise);
    }
  });

  return responsePromise;
};

const navigationRequest = {
  method: 'GET',
  mode: 'navigate',
  url: `${origin}/`
};

fetchImplementation = async () => basicResponse('<!doctype html>', {
  status: 200,
  headers: {'Content-Type': 'text/html'}
});

const onlineNavigation = await dispatchFetch(navigationRequest);
assert.equal(onlineNavigation.status, 200);
assert.ok(
  cacheBuckets.get('fitcounter-runtime-v4').entries.has(`${origin}/`),
  'online navigation must refresh the runtime cache'
);

appCache.entries.set(
  `${origin}/index.html`,
  new Response('<!doctype html><title>offline</title>', {status: 200})
);

fetchImplementation = async () => {
  throw new Error('network is offline');
};

const offlineNavigation = await dispatchFetch({
  ...navigationRequest,
  url: `${origin}/unknown-route`
});
assert.equal(offlineNavigation.status, 200, 'offline navigation must use index.html');

appCache.entries.set(
  `${origin}/icons/icon-192.png`,
  new Response('cached icon', {status: 200})
);

const offlineIcon = await dispatchFetch({
  method: 'GET',
  mode: 'same-origin',
  url: `${origin}/icons/icon-192.png`
});
assert.equal(offlineIcon.status, 200, 'cached assets must work offline');

const crossOriginResult = dispatchFetch({
  method: 'GET',
  mode: 'cors',
  url: 'https://cdn.example.test/file.js'
});
assert.equal(crossOriginResult, undefined, 'cross-origin requests must not be intercepted');

console.log('Offline smoke checks passed.');
