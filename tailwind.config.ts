import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        brand: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
          950: "#020617",
        },
        accent: {
          DEFAULT: "#1e40af",
          soft: "#eff6ff",
          border: "#bfdbfe",
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f8fafc",
          subtle: "#f1f5f9",
        },
        ink: {
          DEFAULT: "#0f172a",
          secondary: "#475569",
          muted: "#64748b",
          faint: "#94a3b8",
        },
        line: {
          DEFAULT: "#e2e8f0",
          strong: "#cbd5e1",
        },
        success: {
          DEFAULT: "#047857",
          soft: "#f0fdf4",
          border: "#bbf7d0",
        },
        danger: {
          DEFAULT: "#b91c1c",
          soft: "#fef2f2",
          border: "#fecaca",
        },
        warning: {
          DEFAULT: "#b45309",
          soft: "#fffbeb",
          border: "#fde68a",
        },
      },
      borderRadius: {
        sm: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.625rem",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.04)",
        panel: "0 1px 3px 0 rgb(15 23 42 / 0.06)",
        focus: "0 0 0 3px rgb(71 85 105 / 0.2)",
      },
      maxWidth: {
        prose: "65ch",
      },
      keyframes: {
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 0.4s ease-out forwards",
        "fade-in": "fade-in 0.3s ease-out forwards",
      },
    },
  },
  plugins: [],
};

export default config;
