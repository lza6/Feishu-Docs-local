/** @type {import('tailwindcss').Config} */
// 设计 token 的唯一来源是 src/styles/tokens.css 里的 CSS 自定义属性；
// 这里只把它们映射成 Tailwind 主题名，禁止在组件里散落魔法色值。
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        'paper-2': 'var(--paper-2)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        rule: 'var(--rule)',
        signal: 'var(--signal)',
        go: 'var(--go)'
      },
      fontFamily: {
        display: 'var(--font-display)',
        mono: 'var(--font-mono)'
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '2px'
      },
      spacing: {
        gutter: 'clamp(3rem, 2rem + 4vw, 7rem)'
      }
    }
  },
  plugins: []
};
