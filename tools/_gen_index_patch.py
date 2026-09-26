# -*- coding: utf-8 -*-
'''仅对 index.html 暂存"版本号+帮助文案"两个 hunk（用户图鉴 WIP 不入库）。
生成 patch 并 git apply --cached。'''
import io, subprocess, os

P = r"E:\WorkSpace\TOTKmap\index.html"
HEAD = subprocess.run(["git", "show", "HEAD:index.html"], capture_output=True, cwd=r"E:\WorkSpace\TOTKmap").stdout.decode("utf-8")

# 在 HEAD 版本上施加我的两处修改
t = HEAD
old_ver = '<p class="foot-version">TOTKMAP V1.7.8</p>'
assert t.count(old_ver) == 1
t = t.replace(old_ver, '<p class="foot-version">TOTKMAP V1.8.0</p>')

old_help = '''    <h4>存档文件在哪？</h4>
    <p>需要选择游戏存档目录下的 <code>progress.sav</code> 文件：</p>
    <ul>
      <li><b class="hl">Ryujinx</b>（Switch 模拟器）：<br>
        <span class="path-line"><code>%APPDATA%\\Ryujinx\\bis\\user\\save\\&lt;用户ID&gt;\\0\\slot_XX\\progress.sav</code></span></li>
      <li><b class="hl">Yuzu</b>：<br>
        <span class="path-line"><code>…\\load\\0100F2C0115B6000\\&lt;用户ID&gt;\\&lt;存档槽&gt;\\progress.sav</code></span></li>
    </ul>
    <p>找不到时：按 <code>Win+R</code> 输入 <code>%APPDATA%\\Ryujinx\\bis\\user\\save</code> 回车，
      进入 <code>0100F2C0115B6000</code>（王国之泪）对应的用户目录，在 <code>slot_XX</code> 下找 <code>progress.sav</code>。</p>'''
new_help = '''    <h4>存档在哪？怎么同步？（V1.8.0 起自动检测）</h4>
    <p>启动本地服务后，地图会<b class="hl">自动读取 Ryujinx 当前游戏的存档</b>（默认取
      <code>slot_00</code>，无需手动上传）。加载存档后，鸟望台/神庙/克洛格等
      收集进度会自动同步到面板（按钮显示「存档自动同步 ✓」）。</p>
    <ul>
      <li><b class="hl">快速查看存档位置</b>：在 Ryujinx 游戏列表中，<b class="hl">鼠标右键点击
        「塞尔达传说：王国之泪」→ 查看存档位置</b>，即可打开存档文件夹
        （<code>…\\bis\\user\\save\\&lt;用户ID&gt;\\0\\slot_XX\\progress.sav</code>）。</li>
      <li>换槽位/换游戏进度：把对应的 <code>progress.sav</code> 放到 <code>slot_00</code>，
        或重启本地服务让自动检测重新生效。</li>
      <li>仍然支持手动方式：点「同步存档」按钮选择 <code>progress.sav</code>，
        或直接把文件拖进左侧面板；解析全部在本机完成，<b class="hl">不会上传任何数据</b>。</li>
    </ul>'''
assert t.count(old_help) == 1
t = t.replace(old_help, new_help)

# 生成 unified diff（python difflib）
import difflib
diff = ''.join(difflib.unified_diff(
    HEAD.splitlines(keepends=True), t.splitlines(keepends=True),
    fromfile='a/index.html', tofile='b/index.html', n=3))
patch_path = r"E:\WorkSpace\TOTKmap\tools\_index_partial.patch"
io.open(patch_path, "w", encoding="utf-8", newline="\n").write(diff)
print(diff[:800])
print("patch hunks:", diff.count('@@'))
