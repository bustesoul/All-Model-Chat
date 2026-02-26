
import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * Vite 插件：Tauri 构建时将 index.html 中的所有 CDN 依赖替换为本地资源
 *
 * 处理策略：
 * ┌──────────────────────┬──────────────────────────────────────────┐
 * │ 资源类型              │ Tauri 本地化方式                          │
 * ├──────────────────────┼──────────────────────────────────────────┤
 * │ Tailwind CDN script  │ 删除（PostCSS 编译替代）                   │
 * │ 主题 CSS (带 id)      │ URL 替换为 /vendor/css/ 本地路径          │
 * │ 字体 CSS (FA/KaTeX)  │ 删除（vendor-local.css 已从 npm 导入）     │
 * │ React-PDF CSS        │ 删除（vendor-local.css 已从 npm 导入）     │
 * │ viz.js / html2pdf    │ 替换为 /vendor/js/ 本地路径               │
 * │ importmap            │ 整块删除（Vite 全量打包替代）               │
 * └──────────────────────┴──────────────────────────────────────────┘
 */
function tauriHtmlTransform(): Plugin {
  return {
    name: 'tauri-html-transform',
    transformIndexHtml(html) {
      if (process.env.TAURI_PLATFORM === undefined) {
        return html;
      }

      let result = html;

      // ── 1. Tailwind CDN script → 删除 ──
      result = result.replace(
        /[ \t]*<script\s[^>]*src\s*=\s*"https?:\/\/cdn\.tailwindcss\.com[^"]*"[^>]*><\/script>\s*\n?/gi,
        ''
      );

      // ── 2. 主题切换 CSS → 替换为本地路径（保留 id/disabled 属性） ──
      const themeCssMap: Record<string, string> = {
        'github-markdown-dark.min.css': './vendor/css/github-markdown-dark.min.css',
        'github-markdown.min.css': './vendor/css/github-markdown.min.css',
        'a11y-dark.min.css': './vendor/css/a11y-dark.min.css',
        'a11y-light.min.css': './vendor/css/a11y-light.min.css',
      };
      for (const [cdnFile, localPath] of Object.entries(themeCssMap)) {
        // 匹配包含该文件名的 CDN URL，替换整个 href 值
        const escapedFile = cdnFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(
          new RegExp(`href\\s*=\\s*"https?://[^"]*${escapedFile}"`, 'gi'),
          `href="${localPath}"`
        );
      }

      // ── 3. 删除带字体依赖的 CDN CSS（已由 vendor-local.css 从 npm 打包） ──
      // font-awesome
      result = result.replace(
        /[ \t]*<link\s[^>]*href\s*=\s*"https?:\/\/[^"]*font-awesome[^"]*"[^>]*\/?>\s*\n?/gi,
        ''
      );
      // katex (可能跨多行，用 [^>] 匹配单标签内的换行，避免跨标签吞噬)
      result = result.replace(
        /[ \t]*<link\s[^>]*href\s*=\s*"https?:\/\/[^"]*katex[^"]*"[^>]*\/?>\s*\n?/gi,
        ''
      );
      // react-pdf CSS
      result = result.replace(
        /[ \t]*<link\s[^>]*href\s*=\s*"https?:\/\/esm\.sh\/react-pdf[^"]*\.css"[^>]*\/?>\s*\n?/gi,
        ''
      );

      // ── 4. CDN JS → 替换为本地路径 ──
      // viz.js
      result = result.replace(
        /(<script\s[^>]*src\s*=\s*")https?:\/\/[^"]*\/viz\.js("[^>]*><\/script>)/gi,
        '$1./vendor/js/viz.js$2'
      );
      // full.render.js
      result = result.replace(
        /(<script\s[^>]*src\s*=\s*")https?:\/\/[^"]*\/full\.render\.js("[^>]*><\/script>)/gi,
        '$1./vendor/js/full.render.js$2'
      );
      // html2pdf
      result = result.replace(
        /[ \t]*<script\s[^>]*src\s*=\s*"https?:\/\/[^"]*html2pdf[^"]*"[^>]*><\/script>\s*\n?/gi,
        '  <script src="./vendor/js/html2pdf.bundle.min.js"></script>\n'
      );

      // ── 5. 删除 importmap（Vite 已全量打包所有 JS 依赖） ──
      result = result.replace(
        /[ \t]*<script\s+type\s*=\s*"importmap"[\s\S]*?<\/script>\s*\n?/gi,
        ''
      );

      // ── 6. 删除 HTML 注释（CDN 标记已无意义） ──
      result = result.replace(/[ \t]*<!-- React PDF Styles -->\s*\n?/g, '');
      result = result.replace(/[ \t]*<!-- Graphviz scripts -->\s*\n?/g, '');
      result = result.replace(/[ \t]*<!-- HTML2PDF -->\s*\n?/g, '');

      return result;
    },
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');

    // 检测是否在 Tauri 环境中
    const isTauri = process.env.TAURI_PLATFORM !== undefined;

    return {
      // Tauri 使用相对路径确保资源在 tauri:// 协议下正确加载
      base: isTauri ? './' : '/',
      plugins: [
        react(),
        tauriHtmlTransform(),
        viteStaticCopy({
            targets: [
                {
                    src: 'node_modules/pyodide/*',
                    dest: 'pyodide'
                }
            ]
        })
      ],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          // __dirname is not available in ES modules.
          // We'll resolve from the current working directory.
          '@': path.resolve('.'),
        }
      },
      build: {
        rollupOptions: {
          // 在 Tauri 环境下不外部化任何依赖，因为所有资源会被打包进应用
          // 在 Web 环境下外部化以兼容 CDN 加载
          external: isTauri ? [] : [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react-pdf',
            'pdfjs-dist',
            '@formkit/auto-animate/react',
            'react-virtuoso',
            'xlsx'
          ]
        }
      },
      // 清除 console 在生产环境的输出
      clearScreen: false,
      // Tauri 使用固定端口避免冲突
      server: isTauri ? {
        port: 5173,
        strictPort: true,
      } : {},
      // 配置环境变量前缀
      envPrefix: ['VITE_', 'TAURI_'],
    };
});
