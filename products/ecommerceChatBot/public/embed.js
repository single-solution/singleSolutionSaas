/**
 * Ecommerce Chatbot embed loader.
 *
 * Merchants paste one line on their site:
 *   <script src="https://YOUR-PRODUCT-HOST/embed.js" data-product-token="pk_live_xxx" async></script>
 *
 * It injects a floating iframe (the hosted widget) and resizes it between the
 * launcher bubble and the open panel based on messages from the widget, so the
 * closed widget never blocks clicks on the host page.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var token = script.getAttribute("data-product-token");
  if (!token) {
    return;
  }

  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (error) {
    return;
  }

  var CLOSED = { width: "96px", height: "96px" };
  var OPEN = { width: "402px", height: "min(640px, calc(100vh - 24px))" };

  function mount() {
    if (document.getElementById("ecommerce-chatbot-frame")) return;

    var iframe = document.createElement("iframe");
    iframe.id = "ecommerce-chatbot-frame";
    iframe.title = "Chat";
    iframe.src = origin + "/embed?token=" + encodeURIComponent(token);
    iframe.setAttribute("allowtransparency", "true");
    var style = iframe.style;
    style.position = "fixed";
    style.bottom = "0";
    style.right = "0";
    style.width = CLOSED.width;
    style.height = CLOSED.height;
    style.border = "0";
    style.background = "transparent";
    style.colorScheme = "normal";
    style.zIndex = "2147483000";
    document.body.appendChild(iframe);

    window.addEventListener("message", function (event) {
      if (event.origin !== origin) return;
      var data = event.data || {};
      if (data.source !== "ecommerce-chatbot" || data.type !== "resize") return;
      var size = data.open ? OPEN : CLOSED;
      style.width = size.width;
      style.height = size.height;
    });
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount);
  }
})();
