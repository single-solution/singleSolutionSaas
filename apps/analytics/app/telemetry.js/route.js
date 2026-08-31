import { NextResponse } from 'next/server';

export async function GET(request) {
	const { searchParams } = new URL(request.url);
	const querySiteId = searchParams.get('siteId') || '';

	const scriptContent = `(function() {
  var script = document.currentScript;
  var siteId = (script && (script.getAttribute('data-site-id') || script.getAttribute('data-site'))) || '${querySiteId}';
  if (!siteId) return;

  var endpoint = (script && script.src ? script.src.split('/telemetry')[0] : '') + '/api/events';
  var sessionId = sessionStorage.getItem('__ss_sess') || ('sess_' + Math.random().toString(36).substring(2, 10));
  sessionStorage.setItem('__ss_sess', sessionId);

  var visitorId = localStorage.getItem('__ss_vis') || ('vis_' + Math.random().toString(36).substring(2, 10));
  localStorage.setItem('__ss_vis', visitorId);

  function sendEvent(type, name, data, vitals) {
    var payload = {
      siteId: siteId,
      eventType: type || 'page_view',
      eventName: name,
      path: window.location.pathname,
      title: document.title,
      referrer: document.referrer || 'Direct',
      sessionId: sessionId,
      visitorId: visitorId,
      device: /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'Mobile Phone' : 'Desktop PC',
      browser: /Chrome/i.test(navigator.userAgent) ? 'Chrome' : /Safari/i.test(navigator.userAgent) ? 'Safari' : 'Browser',
      os: /Mac/i.test(navigator.userAgent) ? 'macOS' : /Windows/i.test(navigator.userAgent) ? 'Windows' : /Android/i.test(navigator.userAgent) ? 'Android' : 'iOS',
      eventData: data,
      vitalMetric: vitals && vitals.metric,
      vitalValue: vitals && vitals.value,
      vitalRating: vitals && vitals.rating
    };

    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(endpoint, blob);
      } else {
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true });
      }
    } catch (e) {}
  }

  // Initial Pageview
  sendEvent('page_view', 'page_viewed');

  // Performance Web Vitals Observer (LCP & CLS)
  if ('PerformanceObserver' in window) {
    try {
      var lcpObserver = new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        var lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          sendEvent('vital', 'vital_lcp', null, { metric: 'LCP', value: (lastEntry.startTime / 1000).toFixed(2) + 's', rating: lastEntry.startTime < 2500 ? 'good' : 'poor' });
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch(e) {}
  }

  // Global Analytics Track API
  window.__ss_analytics = {
    track: function(eventName, eventData) {
      sendEvent('custom', eventName, eventData);
    },
    trackAddToCart: function(item) {
      sendEvent('add_to_cart', 'add_to_cart', item);
    },
    trackPurchase: function(order) {
      sendEvent('purchase', 'order_completed', order);
    },
    trackSearch: function(query, resultsCount) {
      sendEvent('search', 'store_search', { query: query, count: resultsCount });
    }
  };
})();`;

	return new NextResponse(scriptContent, {
		status: 200,
		headers: {
			'Content-Type': 'application/javascript; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'public, max-age=3600',
		},
	});
}
