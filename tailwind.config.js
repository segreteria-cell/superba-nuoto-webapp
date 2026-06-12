/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'sb-dark':   '#071422',
        'sb-blue':   '#0077c8',
        'sb-aqua':   '#008db8',
        'sb-green':  '#06845a',
        'sb-bg':     '#ddeef8',
        'sb-panel':  '#eaf5fc',
        'sb-text':   '#0a2540',
        'sb-muted':  '#3a6480',
        'sb-sep':    '#b8d8ec',
        'sb-hover':  '#0d2035',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
