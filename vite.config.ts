import { defineConfig, type Plugin } from 'vite';

// 本番ビルドのみ CSP を埋め込み、通信先を地理院タイル・Overpass に限定する。
// 写真は blob: で扱うだけで、どこにも送信されないことをブラウザ側でも強制する。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://cyberjapandata.gsi.go.jp",
  "connect-src 'self' https://cyberjapandata.gsi.go.jp https://cyberjapandata2.gsi.go.jp https://overpass-api.de https://overpass.kumi.systems https://overpass.private.coffee",
  "worker-src 'self' blob:",
  "media-src 'self' blob: mediastream:",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

export default defineConfig({
  base: '/sanza-prototype/',
  plugins: [cspPlugin()],
  worker: { format: 'es' },
  build: {
    rollupOptions: { input: { main: 'index.html', sensor: 'sensor.html', ar: 'ar.html' } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/online/**', 'tests/photos/**'],
  },
});
