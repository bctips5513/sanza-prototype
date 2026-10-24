import { defineConfig } from 'vitest/config';

// 実際に地理院サーバへアクセスする検証テスト（npm run test:online）
export default defineConfig({
  test: { include: ['tests/online/**/*.test.ts'], testTimeout: 60000 },
});
