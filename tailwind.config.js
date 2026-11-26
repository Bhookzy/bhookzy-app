/** Storefront styles (built locally — no CDN). Run `npm run build:css` after changing markup/classes. */
module.exports = {
  content: ['./public/index.html', './public/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], display: ['Plus Jakarta Sans', 'Inter', 'system-ui', 'sans-serif'] },
      colors: {
        bhookzy: { crimson: '#E23744', orange: '#FF4D00', gold: '#D97706', charcoal: '#141518', ivory: '#FAF8F5', border: '#ECE7DF', veg: '#059669', vegBg: '#ECFDF5' },
      },
      boxShadow: {
        '2xs': '0 1px 2px rgba(20,21,24,0.05)',
        'lux-card': '0 6px 20px -4px rgba(20, 21, 24, 0.05), 0 2px 4px rgba(20, 21, 24, 0.03)',
        'lux-hover': '0 16px 32px -8px rgba(255, 77, 0, 0.16), 0 6px 14px -3px rgba(20, 21, 24, 0.06)',
        'google-search': '0 3px 14px -2px rgba(20, 21, 24, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.95)',
      },
      scale: { 98: '.98' },
    },
  },
  safelist: ['hidden', 'opacity-60', 'translate-x-0', 'translate-x-full'],
  plugins: [],
};
