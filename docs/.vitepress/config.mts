import { defineConfig } from 'vitepress';

// Cloudflare Pages 默认部署在根域；GitHub Pages 等子路径部署时由 CI 注入，
// 例如 SAR_DOCS_BASE=/geoverse-sar/。未注入时保持本地预览和 Pages 根路径。
const base = process.env.SAR_DOCS_BASE ?? '/';

// SAR 文档站（SAR_DOCS_PLAN D1）：既有指南原地站点化 + 架构明细页 + typedoc API。
// README.md 保留给 GitHub 仓库浏览（含跨仓相对链接），不进站点。
export default defineConfig({
  base,
  lang: 'zh-CN',
  title: 'GeoVerse SAR',
  description:
    'Spatial Application Runtime——AI-native 空间应用运行时：一切能力注册成 Capability，一切操作走单一漏斗；GIS app / AI Copilot / 自治 Agent 只是同一 Runtime 的不同入口。',
  // playground 由 docs:build 的前置步骤写入 docs/public，VitePress 本身不参与解析该 iframe 资源。
  ignoreDeadLinks: [/^\.\/playground\/index/],
  srcExclude: ['README.md'],
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '指南', link: '/concepts', activeMatch: '^/(?!architecture|api)' },
      { text: '架构与技术明细', link: '/architecture' },
      { text: '在线 Playground', link: '/playground' },
      { text: 'API 参考', link: '/api/', target: '_blank' },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '核心概念', link: '/concepts' },
          { text: '架构与技术明细', link: '/architecture' },
          { text: '在线 Playground', link: '/playground' },
        ],
      },
      {
        text: '核心机制',
        items: [
          { text: '写一个能力包', link: '/capabilities' },
          { text: '工作流与宏撤销', link: '/workflows' },
          { text: '入口：同一 Runtime 的六副面孔', link: '/entries' },
        ],
      },
      {
        text: '运行时',
        items: [
          { text: '持久化与工作区', link: '/persistence' },
          { text: '远程模式（HTTP+WS）', link: '/remote' },
          { text: '自检与错误分析', link: '/doctor' },
        ],
      },
      {
        text: '智能层',
        items: [
          { text: 'NL planner 与无头聊天', link: '/planner' },
          { text: '自治 Agent 与治理', link: '/agent' },
          { text: '自进化起步', link: '/evolution' },
          { text: '评测闭环（eval）', link: '/eval' },
        ],
      },
      {
        text: '接入与生态',
        items: [
          { text: '接入自有引擎', link: '/engines' },
          { text: '扩展指南（能力生态）', link: '/extending' },
        ],
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdatedText: '最近更新',
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/GeoVerseLabs/geoverse-sar' },
    ],
    footer: {
      message:
        'MIT Licensed · 设计档案（RFC-0008/0009、ADR-0010~0013）在内部 vault，不在本站',
    },
  },
});
