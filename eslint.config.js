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
    // docs/public/api 与 .vitepress 缓存是 docs:build 生成物（typedoc/vitepress），不 lint
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.vue',
      'docs/public/api/**',
      'docs/.vitepress/cache/**',
    ],
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
    // geo-profile 是能力层共享 schema 底座（阶段四 U0，ADR-0015）：叶子包只准 zod
    // （geojson 仅类型）——kernel 永不 import 它（geo 类型在 kernel 旁不在内，红线一），
    // 它也不依赖任何同仓包（被 capabilities-*/engine-* 消费，反向即环）。
    files: ['packages/geo-profile/src/**/*.ts'],
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
                'geo-profile 是能力层叶子 schema 库，只准依赖 zod（geojson 仅类型）。见 SAR_UNIVERSALIZATION_PLAN §5.2。',
            },
          ],
        },
      ],
    },
  },
  {
    // capabilities-geo 是 geo 能力包：editor-core 算子必须经 engine-geo 几何桥再导出
    // 消费，禁止直连 @geoverse/*（"编辑能力=复用 geoverse 且只经桥"的机器化）；禁入口/组装层。
    files: ['packages/capabilities-geo/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            {
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
                '能力包禁止直连 geoverse/地图库——editor-core 算子必须经 @geoverse-sar/engine-geo 几何桥消费；桥上没有的先补 editor-core 再经桥导出。',
            },
            {
              group: [
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
                '@geoverse-sar/server',
                '@geoverse-sar/server/*',
              ],
              message:
                '能力层禁止依赖入口/组装层（依赖只能由外向内）。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // engine-geo 是 geoverse 适配器（唯二可碰 @geoverse/* 的包）：只适配 editor-core
    // 无头引擎层，不碰地图库；不得反依赖能力包/入口层。
    files: ['packages/engine-geo/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            ...nodeBuiltinPatterns,
            {
              group: ['ol', 'ol/*', 'maplibre-gl', 'maplibre-gl/*'],
              message:
                'engine-geo 只适配 @geoverse/editor-core（无头引擎层）；地图库归 SDK 门面/宿主。',
            },
            {
              group: [
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
                'engine-geo 只准依赖 kernel、geo-profile 与 @geoverse/editor-core。见 docs/rfc/0008 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // otel 是可观测导出层（RFC-0009 F4，可选包）：只准依赖 kernel + @opentelemetry/api。
    files: ['packages/otel/src/**/*.ts'],
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
                '@geoverse-sar/workspace',
                '@geoverse-sar/workspace/*',
                '@geoverse-sar/server',
                '@geoverse-sar/server/*',
              ],
              message:
                '@geoverse-sar/otel 只准依赖 kernel 与 @opentelemetry/api（BYO SDK）。见 docs/rfc/0009 F4。',
            },
          ],
        },
      ],
    },
  },
  {
    // evolution 是自进化工具层（RFC-0009 T16/T17）：只准依赖 kernel——
    // LLM 走自带 DraftLlm 端口（不依赖 planner），产物是数据（workflow 草稿/代码骨架）。
    files: ['packages/evolution/src/**/*.ts'],
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
                '@geoverse-sar/workspace',
                '@geoverse-sar/workspace/*',
                '@geoverse-sar/server',
                '@geoverse-sar/server/*',
              ],
              message:
                '@geoverse-sar/evolution 只准依赖 kernel（LLM 经 DraftLlm 端口注入）。见 docs/rfc/0009。',
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
    // conformance 是能力包一致性套件（阶段四 U5，RFC-0012 §四）：只准 kernel+fast-check
    // （vitest 经 hooks 显式传入不静态依赖）——kit 必须包无关，域夹具经 harness 注入。
    files: ['packages/conformance/src/**/*.ts'],
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
                '@geoverse-sar/workspace',
                '@geoverse-sar/workspace/*',
                '@geoverse-sar/server',
                '@geoverse-sar/server/*',
                '@geoverse-sar/evolution',
                '@geoverse-sar/evolution/*',
                '@geoverse-sar/eval',
                '@geoverse-sar/eval/*',
              ],
              message:
                '@geoverse-sar/conformance 只准依赖 kernel 与 fast-check（域夹具经 createHarness 注入）。见 docs/rfc/0012 §四。',
            },
          ],
        },
      ],
    },
  },
  {
    // eval 是确定性评测闭环（阶段四 U2，RFC-0011）：只准 kernel+planner(+skill 经 planner)——
    // 域夹具（引擎/能力包）放在 tests 里注入，评测器本体保持域无关。
    files: ['packages/eval/src/**/*.ts'],
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
                '@geoverse-sar/agent',
                '@geoverse-sar/agent/*',
                '@geoverse-sar/mcp',
                '@geoverse-sar/mcp/*',
                '@geoverse-sar/workspace',
                '@geoverse-sar/workspace/*',
                '@geoverse-sar/server',
                '@geoverse-sar/server/*',
                '@geoverse-sar/evolution',
                '@geoverse-sar/evolution/*',
              ],
              message:
                '@geoverse-sar/eval 只准依赖 kernel 与 planner（域夹具经 scenario.setup 注入）。见 docs/rfc/0011。',
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
