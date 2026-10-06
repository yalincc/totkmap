# 前端验证脚本

浏览器端改动的验收脚本。**静态推断靠不住** —— M3 的 4 个 bug 全部只有真实浏览器才暴露。

## 环境

- `playwright-core` 1.61.1（已在托管 node workspace，无需安装）
- Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`
- 运行方式见下方「用法」

## ★ 后台进程活不过一次工具调用

`python -m http.server` 必须和node 测试**放在同一条命令**里：

```bash
cd app && python -m http.server 8899 --bind 127.0.0.1 > /tmp/httpd.log 2>&1 &
SRV=$!
sleep 3
cd <node workspace> && NODE_PATH=... node verify_m3_final.js
kill $SRV
```

## 清单

| 文件 | 覆盖 |
|---|---|
| `verify_m3.js` | M3 快速冒烟（面板 / 画点 / 卡片 / 切层） |
| `verify_m3_final.js` | M3 完整 11 项验收 + 截图 |
| `verify_layers.js` | 三层（地上/地下/天空）跨层行为 |

## 要点

- 外网瓦片会报 `ERR_CONNECTION_REFUSED`，**这是正常的**，过滤掉即可
- app.js 改的是普通对象（`state.selected`）无 change 事件，只能轮询
- 判断渲染结果要查 `getComputedStyle`，不能只看 class —— M3 的 CSS 丢失就是
  「DOM 正常、class 正确，但 position 还是 static」
