import { createClient } from 'webdav'; // ESM 导入方式
import cors from 'cors';

// 适配 Vercel Node 版本，跳过非必要证书验证（仅测试）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// CORS 中间件
const corsMiddleware = cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
});

// 初始化 WebDAV 客户端（带超时配置）
const webdavClient = createClient(
    process.env.REMOTE_WEBDAV_URL || '',
    {
        username: process.env.REMOTE_WEBDAV_USER || '',
        password: process.env.REMOTE_WEBDAV_PASS || '',
        timeout: 30000,
        headers: { 'User-Agent': 'Vercel-WebDAV-Mirror' }
    }
);

// Vercel Serverless 入口函数（ESM 模式下需导出默认函数）
export default async (req, res) => { // 替换 module.exports 为 export default
    // 前置检查：环境变量是否配置
    if (!process.env.REMOTE_WEBDAV_URL || !process.env.REMOTE_WEBDAV_USER || !process.env.REMOTE_WEBDAV_PASS) {
        return res.status(500).json({ error: 'Missing environment variables (REMOTE_WEBDAV_URL/USER/PASS)' });
    }

    try {
        // 处理 CORS 预检
        if (req.method === 'OPTIONS') {
            corsMiddleware(req, res, () => res.status(200).end());
            return;
        }

        // 拦截写操作
        const writeMethods = ['PUT', 'POST', 'DELETE', 'MKCOL', 'COPY', 'MOVE'];
        if (writeMethods.includes(req.method)) {
            return res.status(403).json({ error: 'Read-only: write operations forbidden' });
        }

        // 解析路径
        const path = req.url.replace(/^\/api/, '') || '/';

        // 处理 GET/HEAD
        if (req.method === 'GET' || req.method === 'HEAD') {
            // 检查路径是否存在
            let pathStat;
            try {
                pathStat = await webdavClient.stat(path);
            } catch (err) {
                if (err.statusCode === 404) {
                    return res.status(404).json({ error: `Path "${path}" not found` });
                }
                throw err;
            }

            // 目录处理
            if (pathStat.type === 'directory') {
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
                // 上级目录
                if (path !== '/') {
                    const parentPath = path.replace(/\/[^/]+\/?$/, '') || '/';
                    html += `<li><a href="${parentPath}">⬆️ Parent Directory</a></li>`;
                }
                // 文件列表
                files.forEach(file => {
                    const filePath = file.filename.startsWith('/') ? file.filename : `/${file.filename}`;
                    const fileSize = formatFileSize(file.size);
                    html += `<li><a href="${filePath}">${file.basename}</a> <span class="size">${fileSize}</span></li>`;
                });
                html += `</ul></body></html>`;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(html);
            }

            // 文件处理（用缓冲区替代流，适配 Vercel）
            const maxFileSize = 100 * 1024 * 1024; // 限制 100MB
            if (pathStat.size > maxFileSize) {
                return res.status(413).json({ error: `File too large (max ${maxFileSize / 1024 / 1024}MB)` });
            }

            const fileBuffer = await webdavClient.getFileContents(path, { format: 'buffer' });
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', fileBuffer.length);
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pathStat.basename)}"; filename*=UTF-8''${encodeURIComponent(pathStat.basename)}`);
            return res.status(200).send(fileBuffer);
        }

        res.status(200).end();
    } catch (err) {
        console.error('Crash details:', err);
        // 友好的错误返回
        res.status(500).json({
            error: 'Server function crashed',
            details: err.message,
            hint: 'Check Vercel logs for more info'
        });
    }
};

// 格式化文件大小（ESM 中函数定义不变）
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}