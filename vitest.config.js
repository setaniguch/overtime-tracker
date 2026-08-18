import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ドメイン層のテストは tests/ 配下、および src/ 内の co-located *.test.js を対象とする。
    include: ['tests/**/*.test.js', 'src/**/*.test.js'],
    // 基盤整備段階ではテストがまだ存在しないため、テスト0件でも成功扱いにする。
    passWithNoTests: true,
    environment: 'node',
  },
});
