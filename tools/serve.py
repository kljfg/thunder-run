"""
雷霆酷跑 · 本地静态服务器（离线兜底；日常开发首选 npm run dev 起 Vite）
为什么不用裸的 python -m http.server：Windows 注册表会把 .js 识别成 text/plain，
浏览器对 ES Module 强制 MIME 检查会拒绝加载。这里显式注册正确的 MIME 类型。
用法：先 npm run build:web（产物在 apps/web/dist，含拷贝的 config/*.json），
     再 python tools/serve.py
"""
import http.server
import mimetypes
import os
import socketserver
import threading
import webbrowser

PORT = 8767
# Vite 构建产物目录（自包含：JS/CSS 打包 + config/*.json 由 publicDir 拷入）
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'apps', 'web', 'dist')

mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('application/json', '.json')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 本地开发禁缓存，改完刷新即见
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):  # 静音逐条日志，只留启动提示
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    url = f'http://127.0.0.1:{PORT}/index.html'
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print(f'雷霆酷跑本地测试: {url}')
        print('停止服务: 关闭本窗口 (Ctrl+C)')
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        httpd.serve_forever()
