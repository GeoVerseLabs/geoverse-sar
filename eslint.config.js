import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Node 构建脚本所需全局（不引 `globals` 包，避免新增依赖）
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

// 浏览器/内核库代码禁 Node 内置模块（沿用 geoverse 制度性约束）
const nodeBuiltinBan = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        'path',
        'fs',
        'timers',
        'os',
        'crypto',
        'util',
        'url',
        'http',
        'https',
        'stream',
        'events',
        'buffer',
        'child_process',
        'process',
      ].map((name) => ({
        name,
        message: 'SAR 各包须可在浏览器运行，禁止 import Node 内置模块。',
      })),
      patterns: [
        {
          group: ['node:*', 'fs/*', 'timers/*'],
          message: 'SAR 各包须可在浏览器运行，禁止 import Node 内置模块。',
        },
      ],
    },
  ],
};

// 依赖方向门（RFC-0008 §四，沿用 ADR-0001 精神）：
//   skill / examples → capabilities-* / engine-* → kernel
// kernel 只依赖 zod——若内核必须依赖 geoverse 才能跑，就没做到"运行时"（可证伪判据）。
const geoverseBan = {
  group: ['geoverse', 'geoverse/*', '@geoverse/*', 'ol', 'ol/*', 'maplibre-gl', 'maplibre-gl/*'],
  message:
    'M1 全程零 geoverse/地图库依赖；geoverse 适配器是 M2 的 engine-geo/capabilities-* 新包。见 docs/rfc/0008。',
};

export default tseslint.config(
  {
    // *.vue：示例站 SFC（无 vue-eslint-parser，跳过；非发布代码，沿 geoverse 约定）
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.vue'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.config.{js,ts}'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: nodeBuiltinBan,
  },
  {
    // kernel 是纯机制内核：零领域、零 geoverse、零同仓其它包——只准 zod。
    files: ['packages/kernel/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            geoverseBan,
            {
              group: ['@geoverse-sar/*'],
              message:
                '@geoverse-sar/kernel 是最内层，禁止 import 同仓其它包（依赖只能由外向内）。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // 引擎/能力层：可依赖 kernel（能力包还可依赖引擎包的类型），禁入口层与 geoverse。
    files: ['packages/engine-memory/src/**/*.ts', 'packages/capabilities-records/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            geoverseBan,
            {
              group: ['@geoverse-sar/skill', '@geoverse-sar/skill/*'],
              message: '引擎/能力层禁止依赖入口层（依赖只能由外向内）。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // engine-memory 是引擎实现，不得反依赖能力包。
    files: ['packages/engine-memory/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            geoverseBan,
            {
              group: ['@geoverse-sar/skill', '@geoverse-sar/skill/*', '@geoverse-sar/capabilities-*'],
              message: 'engine-memory 只准依赖 kernel。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
