"use client";

import { useEffect } from "react";

/**
 * Injects the production embed loader exactly the way a merchant would paste it
 * on their own site: a single async <script src="/embed.js"> carrying the
 * product token. This exercises the real integration path (iframe + per-token
 * framing gate + resize messaging) rather than mounting the widget directly.
 */
export function ChatWidgetEmbed({ token }: { token: string }) {
  useEffect(() => {
    if (document.getElementById("ecommerce-chatbot-embed")) {
      return;
    }
    const script = document.createElement("script");
    script.id = "ecommerce-chatbot-embed";
    script.src = "/embed.js";
    script.async = true;
    script.setAttribute("data-product-token", token);
    document.body.appendChild(script);
  }, [token]);

  return null;
}
