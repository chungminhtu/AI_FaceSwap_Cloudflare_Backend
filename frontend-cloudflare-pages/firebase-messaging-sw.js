// frontend-cloudflare-pages/firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({{FIREBASE_WEB_CONFIG}});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  
  const data = payload.data || {};
  
  if (data.type === 'silent') {
    return;
  }
  
  const notificationTitle = data.title || 'AI Face Swap';
  const notificationOptions = {
    body: data.body || 'You have a new update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data
  };
  
  self.registration.showNotification(notificationTitle, notificationOptions);
});
