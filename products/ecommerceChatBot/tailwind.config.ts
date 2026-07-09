import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        chat: {
          primary: "var(--chat-primary, #0ea5e9)",
          surface: "var(--chat-surface, #ffffff)",
          bubble: "var(--chat-bubble, #f1f5f9)",
          ink: "var(--chat-ink, #0f172a)",
          muted: "var(--chat-muted, #64748b)",
        }
      }
    },
  },
  plugins: [],
};
export default config;
