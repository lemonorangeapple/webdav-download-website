const { createClient } = require('webdav-client');
const cors = require('cors');

// 初始化 CORS 中间件（允许所有域名访问，生产可限定）
const corsMiddleware = cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'], // 仅放行读操作
    allowedHeaders: ['Content-Type']
});

// 初始化远程 WebDAV 客户端（从环境变量读取远程配置）
const webdavClient = createClient(
    process.env.REMOTE_WEBDAV_URL,
    {
        username: process.env.REMOTE_WEBDAV_USER,
        password: process.env.REMOTE_WEBDAV_PASS,
    }
);

// Vercel Serverless 入口函数
module.exports = async (req, res) => {
    try {
        // 1. 处理 CORS 预检请求
        if (req.method === 'OPTIONS') {
            corsMiddleware(req, res, () => res.status(200).end());
            return;
        }

        // 2. 强制拦截所有写操作（只读保护）
        const writeMethods = ['PUT', 'POST', 'DELETE', 'MKCOL', 'COPY', 'MOVE'];
        if (writeMethods.includes(req.method)) {
            return res.status(403).json({ error: 'Read-only mirror: write operations are forbidden' });
        }

        // 3. 解析请求路径（去除 Vercel 路由前缀 /api）
        const path = req.url.replace(/^\/api/, '') || '/';

        // 4. 处理文件/目录请求（GET/HEAD）
        if (req.method === 'GET' || req.method === 'HEAD') {
            // 先检查路径是否存在
            const pathExists = await webdavClient.exists(path);
            if (!pathExists) {
                return res.status(404).json({ error: `Path "${path}" not found` });
            }

            // 获取路径信息（目录/文件）
            const pathStat = await webdavClient.stat(path);

            if (pathStat.isDirectory()) {
                // 目录：返回简易文件列表（支持点击下载）
                const files = await webdavClient.getDirectoryContents(path);
                let html = `
          <!DOCTYPE html>
          <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <title>Directory: ${path}</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
              h1 { color: #333; }
              ul { list-style: none; padding: 0; }
              li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
              a { color: #0066cc; text-decoration: none; }
              a:hover { text-decoration: underline; }
              .size { color: #666; margin-left: 1rem; font-size: 0.9rem; }
            </style>
          </head>
          <body>
            <h1>📁 Directory: ${path}</h1>
            <ul>
        `;
                // 添加上级目录（根目录除外）
                if (path !== '/') {
                    const parentPath = path.replace(/\/[^/]+\/?$/, '') || '/';
                    html += `<li><a href="${parentPath}">⬆️ Parent Directory</a></li>`;
                }
                // 列出当前目录文件
                files.forEach(file => {
                    const filePath = file.filename.startsWith('/') ? file.filename : `/${file.filename}`;
                    const fileSize = formatFileSize(file.size);
                    html += `<li><a href="${filePath}">${file.basename}</a> <span class="size">${fileSize}</span></li>`;
                });
                html += `
            </ul>
          </body>
          </html>
        `;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(html);
            } else {
                // 文件：直接返回下载流（强制下载，不预览）
                const fileStream = await webdavClient.createReadStream(path);

                // 设置下载响应头
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', pathStat.size);
                // 强制下载，文件名编码避免中文乱码
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pathStat.basename)}"; filename*=UTF-8''${encodeURIComponent(pathStat.basename)}`);

                // 管道传输文件流
                fileStream.pipe(res);
                fileStream.on('error', (err) => {
                    console.error('File stream error:', err);
                    res.status(500).json({ error: `Failed to download file: ${err.message}` });
                });
                return;
            }
        }

        // 其他读操作（如 OPTIONS）直接返回成功
        res.status(200).end();
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
};

// 辅助函数：格式化文件大小（字节 → KB/MB/GB）
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}