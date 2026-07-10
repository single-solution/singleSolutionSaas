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
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
        accent: {
          DEFAULT: "#4338ca",
          soft: "#eef2ff",
          border: "#c7d2fe",
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f8fafc",
          subtle: "#f1f5f9",
        },
        ink: {
          DEFAULT: "#0f172a",
          secondary: "#334155",
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
      zIndex: {
        dropdown: "20",
        sticky: "30",
        overlay: "40",
        modal: "50",
        popover: "60",
        toast: "70",
        tooltip: "80",
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
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(24px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "zoom-in": {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 0.4s ease-out forwards",
        "fade-in": "fade-in 0.3s ease-out forwards",
        "slide-in-right": "slide-in-right 0.25s ease-out forwards",
        "zoom-in": "zoom-in 0.2s ease-out forwards",
      },
    },
  },
  plugins: [],
};

export default config;
