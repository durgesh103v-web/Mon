/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'Consolas', 'monospace'],
      },
      colors: {
        // Vibrant accent colors
        red: {
          500: '#ff3b30',
          600: '#e6342a',
          700: '#cc2e25',
        },
        yellow: {
          500: '#ffcc00',
          600: '#e6b800',
          700: '#cca300',
        },
        green: {
          500: '#00d563',
          600: '#00bf59',
          700: '#00aa4f',
        },
        blue: {
          500: '#007aff',
          600: '#006ee6',
          700: '#0062cc',
        },
        // Dark background shades
        dark: {
          50: '#f8fafc',
          100: '#e5e7eb',
          200: '#d1d5db',
          300: '#9ca3af',
          400: '#6b7280',
          500: '#4b5563',
          600: '#374151',
          700: '#1f2937',
          800: '#111827',
          900: '#0a0d14',
          950: '#05070a',
        },
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgba(0, 0, 0, 0.3)',
        'card-hover': '0 2px 6px 0 rgba(0, 0, 0, 0.4)',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slide-up 0.3s ease-out',
        'fade-in': 'fade-in 0.2s ease-in',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 1px rgba(168, 85, 247, 0.2), 0 0 20px rgba(168, 85, 247, 0.3)' },
          '50%': { opacity: '0.8', boxShadow: '0 0 0 1px rgba(168, 85, 247, 0.3), 0 0 40px rgba(168, 85, 247, 0.4)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-radial-at-t': 'radial-gradient(ellipse at top, var(--tw-gradient-stops))',
        'gradient-radial-at-b': 'radial-gradient(ellipse at bottom, var(--tw-gradient-stops))',
      },
    },
  },
  plugins: [],
}
