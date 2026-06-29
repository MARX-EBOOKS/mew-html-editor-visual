# 文本—扫描原图对照阅读器 Demo

这是第 6、7 卷的零依赖 Node.js 静态站生成示例。

## 构建

```powershell
node .\demo-parallel-reader\build.mjs
```

## 本地预览

```powershell
node .\demo-parallel-reader\serve.mjs
```

然后访问：

```text
http://127.0.0.1:4177/
```

`contents.mjs` 中的 `scanDir` 相对于 demo 目录解析。构建时，扫描目录会按其目录名完整复制到 `dist` 根目录，例如：

```text
scanDir: "../../cache_images_zhwj6"
→ dist/cache_images_zhwj6/
```

因此 `dist` 是可直接部署的完整静态站，开发服务器不再包含卷号或扫描目录硬编码。


逐页输出采用单 HTML 文件，例如：

```text
/books/6/page/134.html
```
