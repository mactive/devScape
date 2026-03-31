/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'neon-green': '#aaff00',
        'neon-yellow': '#ffff00',
        'neon-cyan': '#00ffff',
        'neon-success': '#00ff88',
        'neon-debug': '#ffcc00',
        'neon-error': '#ff4444',
        'cyber-dark': '#0a0a0a',
        'cyber-bg': '#0d120d',
        'cyber-gray': '#111811',
        'cyber-border': '#1a2a1a',
        'cyber-border-bright': '#2a4a2a',
        'cyber-muted': '#334433',
        'cyber-text': '#88bb88',
        'cyber-text-dim': '#446644',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Space Mono', 'Courier New', 'monospace'],
      },
      animation: {
        'pulse-fast': 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'scanline': 'scanline 8s linear infinite',
      },
      keyframes: {
        glow: {
          '0%': { textShadow: '0 0 4px #aaff00, 0 0 8px #aaff00' },
          '100%': { textShadow: '0 0 8px #aaff00, 0 0 16px #aaff00, 0 0 24px #aaff0088' },
        },
        scanline: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        }
      }
    },
  },
  plugins: [],
}
