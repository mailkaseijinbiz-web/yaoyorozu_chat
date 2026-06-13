// Service Worker: アップデートをユーザー確認後に適用する

self.addEventListener('install', () => {
  // skipWaiting を即時呼ばない — ユーザーが「更新」をタップしてから適用
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// フロントエンドから 'SKIP_WAITING' を受け取ったら新しい SW を有効化
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// ネットワークファースト: APIや動的コンテンツはキャッシュしない
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => new Response('offline', { status: 503 })));
});
