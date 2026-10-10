# tasks/manual/ — 任务人工校对档案

**内容**：这里存放人工补充的任务内容（NPC 名 / 前置 / 攻略 / 流程点 / 图层覆盖），一个任务一个 `.yaml` 文件。

**规则**：

1. **只放人工补充的部分**，不放完整任务——任务本体（坐标 / 分类 / 层级）仍由 ROM 抽取，单一数据源不被破坏。
2. **一个任务一个文件**，按任务 key 命名（`PhotoSpot_Challenge_05.yaml`）；改一条只打开一个文件。
3. **`_flags.yaml`** 单独存 flag→中文名（一条 flag 被多条任务共用，按 flag 索引）。
4. **下划线前缀**（`_note` / `_source` / `_warnings`）是给人看的，生成时忽略。
5. **不预先生成 139 个空文件**——只给校对过的建文件，`task_check.py` 按「库里有但文件没有」生成待补清单。
6. 复制 `_template.yaml` 开写；字段全可选，删掉用不上的即可。

**工具链**（tools/）：
- `load_manual.py` — 读取全部档案 + 校验（ERROR 崩 / WARN 警告 / INFO 提示），合并成 6 个 dict
- `task_batch.py` — 批量导入老大档案 / 清单回传 → 落盘 YAML（宽松解析）
- `task_check.py` — 全库体检 + 生成待补作业清单
- `task_show.py` — 查单条状态（阶段 3）
- `task_preview.py` — 本地预览卡片（阶段 3）
