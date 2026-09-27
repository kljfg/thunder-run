"""
雷霆酷跑 · 本地开发服务器
为什么不用裸的 python -m http.server：Windows 注册表会把 .js 识别成 text/plain，
浏览器对 ES Module 强制 MIME 检查会拒绝加载。这里显式注册正确的 MIME 类型。
用法：python tools/serve.py  （或双击 启动本地测试.bat）
"""
import http.server
import mimetypes
import os
import socketserver
import threading
import webbrowser

PORT = 8767
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
