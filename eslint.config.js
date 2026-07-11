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

// 浏览器/内核库代码禁 Node 内置模块（沿用 geoverse 制度性约束）。
// 注意 flat config 同一规则后配置整体覆盖前配置——各包的依赖方向块重写
// no-restricted-imports 时必须把这两组 spread 进去，否则 Node 禁令被顶掉。
const nodeBuiltinPaths = [
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
}));
const nodeBuiltinPatterns = [
  {
    group: ['node:*', 'fs/*', 'timers/*'],
    message: 'SAR 各包须可在浏览器运行，禁止 import Node 内置模块。',
  },
];
const nodeBuiltinBan = {
  'no-restricted-imports': [
    'error',
    { paths: nodeBuiltinPaths, patterns: nodeBuiltinPatterns },
  ],
};

// 依赖方向门（RFC-0008 §四，沿用 ADR-0001 精神）：
//   skill / examples → capabilities-* / engine-* → kernel
// kernel 只依赖 zod——若内核必须依赖 geoverse 才能跑，就没做到"运行时"（可证伪判据）。
const geoverseBan = {
  group: [
    'geoverse',
    'geoverse/*',
    '@geoverse/*',
    'ol',
    'ol/*',
    'maplibre-gl',
    'maplibre-gl/*',
  ],
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
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
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
    // 唯一豁免 Node 禁令的内核文件：fileStore 是 Node-only 存储适配器，
    // 走子导出 `@geoverse-sar/kernel/store-file`，不进浏览器主入口（目标架构 R1）。
    files: ['packages/kernel/src/store-file.ts'],
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
    // workspace 是生命周期组装层：只准依赖 kernel（引擎/能力包/服务经入参注入，不直连）。
    files: ['packages/workspace/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            geoverseBan,
            {
              group: [
                '@geoverse-sar/engine-*',
                '@geoverse-sar/capabilities-*',
                '@geoverse-sar/skill',
                '@geoverse-sar/skill/*',
                '@geoverse-sar/planner',
                '@geoverse-sar/planner/*',
                '@geoverse-sar/agent',
                '@geoverse-sar/agent/*',
                '@geoverse-sar/mcp',
                '@geoverse-sar/mcp/*',
              ],
              message:
                '@geoverse-sar/workspace 只准依赖 kernel（组装物经 openWorkspace 入参注入）。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // 引擎/能力层：可依赖 kernel（能力包还可依赖引擎包的类型），禁入口层与 geoverse。
    files: [
      'packages/engine-memory/src/**/*.ts',
      'packages/capabilities-records/src/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            geoverseBan,
            {
              group: ['@geoverse-sar/skill', '@geoverse-sar/skill/*'],
              message:
                '引擎/能力层禁止依赖入口层（依赖只能由外向内）。见 docs/rfc/0008 §四。',
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
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            geoverseBan,
            {
              group: [
                '@geoverse-sar/skill',
                '@geoverse-sar/skill/*',
                '@geoverse-sar/capabilities-*',
              ],
              message: 'engine-memory 只准依赖 kernel。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // server 是 Node-only 服务宿主（R7）：kernel 单漏斗的网络投影，豁免 Node 内置禁令；
    // 依赖只准 kernel + ws——工作区/引擎/能力包由宿主装配好经入参注入，薄层不碰。
    files: ['packages/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            geoverseBan,
            {
              group: [
                '@geoverse-sar/engine-*',
                '@geoverse-sar/capabilities-*',
                '@geoverse-sar/skill',
                '@geoverse-sar/skill/*',
                '@geoverse-sar/planner',
                '@geoverse-sar/planner/*',
                '@geoverse-sar/agent',
                '@geoverse-sar/agent/*',
                '@geoverse-sar/mcp',
                '@geoverse-sar/mcp/*',
                '@geoverse-sar/workspace',
                '@geoverse-sar/workspace/*',
              ],
              message:
                '@geoverse-sar/server 只准依赖 kernel（内核经 SarServerOptions.workspaces 注入）。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // agent 是自治入口层（M4）：只准依赖 kernel/skill/planner——治理（权限/审计/取消）
    // 由内核单漏斗强制，agent 循环不碰引擎/能力实现。
    files: ['packages/agent/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            geoverseBan,
            {
              group: [
                '@geoverse-sar/engine-*',
                '@geoverse-sar/capabilities-*',
                '@geoverse-sar/mcp',
                '@geoverse-sar/mcp/*',
              ],
              message:
                'agent 只准依赖 kernel/skill/planner（依赖只能由外向内）。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // planner 是 AI 入口层（M3）：只准依赖 kernel 与 skill——NL→能力路由经
    // describeAll/toToolSpecs 目录投影 + handleToolCall 回灌，不碰引擎/能力实现。
    files: ['packages/planner/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            geoverseBan,
            {
              group: [
                '@geoverse-sar/engine-*',
                '@geoverse-sar/capabilities-*',
                '@geoverse-sar/mcp',
                '@geoverse-sar/mcp/*',
              ],
              message:
                'planner 只准依赖 kernel 与 skill（NL 出内核，路由不碰引擎/能力实现）。见 docs/rfc/0008 §四。',
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
