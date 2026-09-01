export async function GET(request) {
	const { searchParams } = new URL(request.url);
	const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:5002';
	const proto = request.headers.get('x-forwarded-proto') || 'http';
	const apiBase = `${proto}://${host}`;

	const script = `(function() {
  if (window.__SingleSolutionChatLoaded) return;
  window.__SingleSolutionChatLoaded = true;

  var currentScript = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var tenantId = (currentScript && currentScript.getAttribute('data-site-id')) || 'default';
  var botName = (currentScript && currentScript.getAttribute('data-bot-name')) || 'AI Support';
  var primaryColor = (currentScript && currentScript.getAttribute('data-color')) || '#4F46E5';
  var endpoint = '${apiBase}/api/chat';

  var conversationId = 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  var isOpen = false;
  var messages = [
    { sender: 'bot', text: 'Hi there! 👋 How can I help you with your order or questions today?' }
  ];

  // Inject Styles
  var style = document.createElement('style');
  style.innerHTML = \`
    .ss-chat-launcher {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: \${primaryColor};
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      cursor: pointer;
      z-index: 999998;
      transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
    }
    .ss-chat-launcher:hover {
      transform: scale(1.08);
      box-shadow: 0 14px 28px -4px rgba(0, 0, 0, 0.25);
    }
    .ss-chat-launcher svg {
      width: 26px;
      height: 26px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ss-chat-window {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 360px;
      height: 520px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 120px);
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.05);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      border: 1px solid #E2E8F0;
    }
    .ss-chat-header {
      padding: 16px 18px;
      background: \${primaryColor};
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .ss-chat-header-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }
    .ss-chat-header-sub {
      font-size: 11px;
      opacity: 0.85;
    }
    .ss-chat-close {
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
    .ss-chat-messages {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #F8FAFC;
    }
    .ss-chat-bubble {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.45;
      word-break: break-word;
    }
    .ss-chat-bubble.bot {
      align-self: flex-start;
      background: #ffffff;
      color: #1E293B;
      border: 1px solid #E2E8F0;
      border-bottom-left-radius: 4px;
    }
    .ss-chat-bubble.customer {
      align-self: flex-end;
      background: \${primaryColor};
      color: #ffffff;
      border-bottom-right-radius: 4px;
    }
    .ss-chat-typing {
      font-size: 11px;
      color: #64748B;
      font-style: italic;
      display: none;
      padding-left: 6px;
    }
    .ss-chat-footer {
      padding: 12px 14px;
      background: #ffffff;
      border-top: 1px solid #E2E8F0;
      display: flex;
      gap: 8px;
    }
    .ss-chat-input {
      flex: 1;
      border: 1px solid #CBD5E1;
      border-radius: 12px;
      padding: 9px 12px;
      font-size: 13px;
      outline: none;
    }
    .ss-chat-input:focus {
      border-color: \${primaryColor};
    }
    .ss-chat-send {
      background: \${primaryColor};
      border: none;
      color: #ffffff;
      padding: 0 14px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
    }
  \`;
  document.head.appendChild(style);

  // Create UI Elements
  var launcher = document.createElement('div');
  launcher.className = 'ss-chat-launcher';
  launcher.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var chatWin = document.createElement('div');
  chatWin.className = 'ss-chat-window';
  chatWin.innerHTML = \`
    <div class="ss-chat-header">
      <div>
        <div class="ss-chat-header-title">\${botName}</div>
        <div class="ss-chat-header-sub">Instant E-Commerce Support</div>
      </div>
      <button class="ss-chat-close" id="ss-chat-close-btn">✕</button>
    </div>
    <div class="ss-chat-messages" id="ss-chat-msg-list"></div>
    <div class="ss-chat-typing" id="ss-chat-typing">Assistant is typing...</div>
    <form class="ss-chat-footer" id="ss-chat-form">
      <input type="text" class="ss-chat-input" id="ss-chat-input-field" placeholder="Type your question..." autocomplete="off" />
      <button type="submit" class="ss-chat-send">Send</button>
    </form>
  \`;

  document.body.appendChild(launcher);
  document.body.appendChild(chatWin);

  function renderMessages() {
    var msgList = document.getElementById('ss-chat-msg-list');
    if (!msgList) return;
    msgList.innerHTML = messages.map(function(m) {
      return '<div class="ss-chat-bubble ' + m.sender + '">' + m.text + '</div>';
    }).join('');
    msgList.scrollTop = msgList.scrollHeight;
  }

  function toggleChat() {
    isOpen = !isOpen;
    chatWin.style.display = isOpen ? 'flex' : 'none';
    if (isOpen) {
      renderMessages();
      var input = document.getElementById('ss-chat-input-field');
      if (input) input.focus();
    }
  }

  launcher.addEventListener('click', toggleChat);
  document.getElementById('ss-chat-close-btn').addEventListener('click', toggleChat);

  document.getElementById('ss-chat-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var input = document.getElementById('ss-chat-input-field');
    var text = input.value.trim();
    if (!text) return;

    messages.push({ sender: 'customer', text: text });
    input.value = '';
    renderMessages();

    var typing = document.getElementById('ss-chat-typing');
    if (typing) typing.style.display = 'block';

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        tenantId: tenantId,
        conversationId: conversationId
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (typing) typing.style.display = 'none';
      if (data && data.reply) {
        messages.push({ sender: 'bot', text: data.reply });
      } else {
        messages.push({ sender: 'bot', text: 'Thank you for your message. An agent will review shortly.' });
      }
      renderMessages();
    })
    .catch(function() {
      if (typing) typing.style.display = 'none';
      messages.push({ sender: 'bot', text: 'Sorry, I am having trouble connecting. Please try again in a moment.' });
      renderMessages();
    });
  });

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
