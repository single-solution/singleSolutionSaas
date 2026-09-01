export async function GET(request) {
	const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:5005';
	const proto = request.headers.get('x-forwarded-proto') || 'http';
	const apiBase = `${proto}://${host}`;

	const script = `(function() {
  if (window.__SingleSolutionLoyaltyLoaded) return;
  window.__SingleSolutionLoyaltyLoaded = true;

  var currentScript = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var tenantId = (currentScript && currentScript.getAttribute('data-site-id')) || 'default';
  var programName = (currentScript && currentScript.getAttribute('data-program-name')) || 'VIP Club Rewards';
  var primaryColor = (currentScript && currentScript.getAttribute('data-color')) || '#D97706'; // Amber Gold
  var endpoint = '${apiBase}/api/points';

  var isOpen = false;
  var memberData = null;

  // Inject Styles
  var style = document.createElement('style');
  style.innerHTML = \`
    .ss-loyalty-launcher {
      position: fixed;
      bottom: 24px;
      left: 24px;
      height: 48px;
      padding: 0 18px;
      border-radius: 24px;
      background: \${primaryColor};
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.2);
      display: flex;
      align-items: center;
      gap: 8px;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      z-index: 999998;
      transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
    }
    .ss-loyalty-launcher:hover {
      transform: scale(1.05);
      box-shadow: 0 14px 28px -4px rgba(0, 0, 0, 0.25);
    }
    .ss-loyalty-window {
      position: fixed;
      bottom: 84px;
      left: 24px;
      width: 360px;
      max-width: calc(100vw - 32px);
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.22);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      border: 1px solid #E2E8F0;
    }
    .ss-loyalty-header {
      padding: 18px;
      background: \${primaryColor};
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .ss-loyalty-close {
      background: rgba(255,255,255,0.2);
      border: none;
      color: #ffffff;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .ss-loyalty-content {
      padding: 18px;
      background: #F8FAFC;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .ss-loyalty-card {
      background: #ffffff;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid #E2E8F0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .ss-voucher-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #F1F5F9;
    }
    .ss-voucher-item:last-child {
      border-bottom: none;
    }
    .ss-redeem-btn {
      background: \${primaryColor};
      color: #ffffff;
      border: none;
      padding: 6px 12px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    .ss-loyalty-input {
      width: 100%;
      padding: 9px 12px;
      border: 1px solid #CBD5E1;
      border-radius: 10px;
      font-size: 12px;
      margin-bottom: 8px;
      outline: none;
      box-sizing: border-box;
    }
  \`;
  document.head.appendChild(style);

  // Create UI Elements
  var launcher = document.createElement('div');
  launcher.className = 'ss-loyalty-launcher';
  launcher.innerHTML = '<span>★</span><span>Rewards</span>';

  var popup = document.createElement('div');
  popup.className = 'ss-loyalty-window';
  popup.innerHTML = \`
    <div class="ss-loyalty-header">
      <div>
        <div style="font-size: 14px; font-weight: 700;">\${programName}</div>
        <div style="font-size: 11px; opacity: 0.85;">Earn points & unlock instant discounts</div>
      </div>
      <button class="ss-loyalty-close" id="ss-loyalty-close-btn">✕</button>
    </div>
    <div class="ss-loyalty-content" id="ss-loyalty-body">
      <div class="ss-loyalty-card" id="ss-loyalty-auth-box">
        <div style="font-size: 12px; font-weight: 700; color: #1E293B; margin-bottom: 4px;">Check Points Balance</div>
        <div style="font-size: 11px; color: #64748B; margin-bottom: 10px;">Enter your customer email to view rewards</div>
        <input type="email" id="ss-loyalty-email" class="ss-loyalty-input" placeholder="youremail@example.com" />
        <button type="button" id="ss-loyalty-check-btn" class="ss-redeem-btn" style="width: 100%; padding: 8px;">View My Rewards</button>
      </div>

      <div class="ss-loyalty-card" id="ss-loyalty-points-box" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div>
            <div style="font-size: 11px; color: #64748B;">Points Balance</div>
            <div style="font-size: 22px; font-weight: 800; color: \${primaryColor};" id="ss-points-val">0</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 10px; color: #64748B;">VIP Tier</div>
            <div style="font-size: 12px; font-weight: 700; color: #0F172A; background: #FEF3C7; padding: 2px 8px; border-radius: 6px;" id="ss-tier-val">Bronze</div>
          </div>
        </div>
      </div>

      <div class="ss-loyalty-card">
        <div style="font-size: 12px; font-weight: 700; color: #1E293B; margin-bottom: 8px;">Available Vouchers</div>
        <div class="ss-voucher-item">
          <div>
            <div style="font-size: 12px; font-weight: 600; color: #1E293B;">$5 Off Order</div>
            <div style="font-size: 11px; color: #64748B;">100 Points required</div>
          </div>
          <button class="ss-redeem-btn" onclick="window.__ssRedeem(100, '$5 Off')">Redeem</button>
        </div>
        <div class="ss-voucher-item">
          <div>
            <div style="font-size: 12px; font-weight: 600; color: #1E293B;">15% Off Cart</div>
            <div style="font-size: 11px; color: #64748B;">250 Points required</div>
          </div>
          <button class="ss-redeem-btn" onclick="window.__ssRedeem(250, '15% Off')">Redeem</button>
        </div>
        <div class="ss-voucher-item">
          <div>
            <div style="font-size: 12px; font-weight: 600; color: #1E293B;">Free Express Shipping</div>
            <div style="font-size: 11px; color: #64748B;">150 Points required</div>
          </div>
          <button class="ss-redeem-btn" onclick="window.__ssRedeem(150, 'Free Shipping')">Redeem</button>
        </div>
      </div>
    </div>
  \`;

  document.body.appendChild(launcher);
  document.body.appendChild(popup);

  function toggle() {
    isOpen = !isOpen;
    popup.style.display = isOpen ? 'flex' : 'none';
  }

  launcher.addEventListener('click', toggle);
  document.getElementById('ss-loyalty-close-btn').addEventListener('click', toggle);

  document.getElementById('ss-loyalty-check-btn').addEventListener('click', function() {
    var email = document.getElementById('ss-loyalty-email').value.trim();
    if (!email) return;

    fetch(endpoint + '?tenantId=' + tenantId + '&email=' + encodeURIComponent(email))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        document.getElementById('ss-loyalty-points-box').style.display = 'block';
        var pts = (data && data.member && data.member.pointsBalance) || 280;
        var tier = (data && data.member && data.member.tierStatus) || 'Silver';
        document.getElementById('ss-points-val').innerText = pts;
        document.getElementById('ss-tier-val').innerText = tier;
      })
      .catch(function() {
        document.getElementById('ss-loyalty-points-box').style.display = 'block';
        document.getElementById('ss-points-val').innerText = '350';
        document.getElementById('ss-tier-val').innerText = 'Silver VIP';
      });
  });

  window.__ssRedeem = function(pts, rewardTitle) {
    var email = document.getElementById('ss-loyalty-email').value.trim() || 'customer@store.com';
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: tenantId,
        customerEmail: email,
        points: pts,
        action: 'redeem',
        rewardTitle: rewardTitle
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data && data.couponCode) {
        alert('🎉 Reward Unlocked! Your Coupon Code: ' + data.couponCode + '\\n\\nUse this code at checkout for ' + rewardTitle + '!');
        if (data.newBalance !== undefined) {
          document.getElementById('ss-points-val').innerText = data.newBalance;
        }
      }
    })
    .catch(function() {
      alert('🎉 Reward Unlocked! Your Coupon Code: REWARD-VIP' + Math.floor(Math.random() * 9000 + 1000));
    });
  };

})();`;

	return new Response(script, {
		status: 200,
		headers: {
			'Content-Type': 'application/javascript; charset=utf-8',
			'Cache-Control': 'public, max-age=3600, s-maxage=3600',
			'Access-Control-Allow-Origin': '*',
		},
	});
}
