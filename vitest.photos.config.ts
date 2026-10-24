import { defineConfig } from 'vitest/config';

// test-photos/ の実写真で自動合わせを評価する（macOS の sips を使用。写真と正解は test-photos/truth.json）
export default defineConfig({
  test: { include: ['tests/photos/**/*.test.ts'], testTimeout: 900_000, hookTimeout: 900_000 },
});
