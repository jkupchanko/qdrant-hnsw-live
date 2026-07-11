import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        qdrant: {
          red: "#DC244C",
          "red-dark": "#9E0D38",
          "red-light": "#FF8792",
          violet: "#6047FF",
          "violet-dark": "#4325AE",
          "violet-light": "#C2C5FF",
          teal: "#009688",
          blue: "#03A9F4",
          orange: "#FF9800",
        },
        bg: {
          base: "#0B0F19",
          elev1: "#111824",
          elev2: "#141A2A",
          elev8: "#212635",
        },
        fg: {
          primary: "#F0F3FA",
          secondary: "#656B7F",
          disabled: "#ABB1C7",
        },
        line: "#4E5366",
      },
      fontFamily: {
        sans: ['"Mona Sans"', "Inter", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", "sans-serif"],
        mono: ['"Geist Mono"', '"JetBrains Mono"', '"Fira Code"', '"SF Mono"', "Consolas", "monospace"],
      },
      letterSpacing: {
        "tight-brand": "-0.02em",
        "tighter-brand": "-0.03em",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #DC244C 0%, #6047FF 100%)",
        "brand-gradient-soft": "linear-gradient(135deg, rgba(220,36,76,0.15) 0%, rgba(96,71,255,0.15) 100%)",
      },
      boxShadow: {
        glow: "0 0 40px rgba(220, 36, 76, 0.35)",
        "glow-violet": "0 0 40px rgba(96, 71, 255, 0.35)",
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        twinkle: "twinkle 3s ease-in-out infinite",
        drift: "drift 20s linear infinite",
      },
      keyframes: {
        twinkle: {
          "0%, 100%": { opacity: "0.3", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.2)" },
        },
        drift: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-100px)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
