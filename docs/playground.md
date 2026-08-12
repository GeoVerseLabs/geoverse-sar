# 在线 Playground

Playground 与文档站使用同一份构建产物。下面的嵌入页包含内存域、LLM chat、真地图、自治 Agent 和远程模式五个入口；其中 LLM 页需要本地开发代理注入密钥，部署站点不会把密钥打进浏览器。

<iframe
  src="./playground/index.html"
  title="GeoVerse SAR Playground"
  style="width: 100%; min-height: 820px; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg);"
  loading="lazy"
></iframe>

如果浏览器阻止了嵌入页的脚本，可直接打开 [Playground 独立页面](./playground/index.html)。本地运行 `pnpm playground:dev` 时，入口地址为 `http://localhost:8090/index.html`。
