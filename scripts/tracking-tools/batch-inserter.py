#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量埋点插入脚本
自动遍历多个项目，将追踪代码插入到指定位置

使用方法:
1. 修改下方的 PROJECTS 配置
2. 运行: python batch-inserter.py
3. 脚本会自动修改所有项目

如果需要恢复:
4. 运行: python batch-inserter.py --restore
"""

import os
import re
import hashlib
import random
import argparse
from datetime import datetime

# ========== 配置区 ==========

# webhook 地址（使用本地免费追踪服务器）
# WEBHOOK_URL = 'http://你的VPS:3003/track'  # VPS版本
WEBHOOK_URL = 'http://localhost:3003/track'  # 本地版本

# 项目列表（使用测试项目）
PROJECTS = [
    ('../../test-projects/project-a/src', 'project_a_demo'),  # 测试项目
    # 添加你的真实项目:
    # ('C:/Users/yourname/project/src', 'shop_system'),
    # ('C:/Users/yourname/project/js', 'admin_pro'),
]

# 埋点文件（建议每个项目放2-3处）
TARGET_FILES = [
    'utils.js',
    'request.js',
    'app.js',
    'main.js',
    'index.js'
]

# 埋点模式（嵌入式）
# 这会生成不同的混淆代码，增加删除难度
BEACON_TEMPLATES = [
    # 模板1: 图片 beacon
    """!function(){{try{{var p='{code}',d={{p:p,h:location.hostname,t:Date.now()}};new Image().src='{url}?'+(new URLSearchParams(d)).toString();}}catch(e){{}}}}();""",

    # 模板2: fetch方式
    """var _0x{random1}=()=>{{var _0x{random2}={{p:'{code}',h:location.hostname}};fetch('{url}?'+(new URLSearchParams(_0x{random2})).toString(),{{mode:'no-cors'}});}};_0x{random1}();""",

    # 模板3: 简写形式
    """setTimeout(()=>{{new Image().src='{url}?p={code}&h='+location.hostname}},1000);""",

    # 模板4: 字符串拼接（更难被发现）
    """var $0='{div_code}';setTimeout(()=>{{new Image()['src']=('{div_url}'+'?')+['p='+$0,'h='+['lo','cat','ion']['join']('')['hos','tname']['join']('')]['join']('&');}},500);""",
]

# 备份目录
BACKUP_DIR = './backups'
os.makedirs(BACKUP_DIR, exist_ok=True)

# 日志
LOG_FILE = './batch-inserter.log'


def generate_rcode(length=8):
    """生成随机代码，避免特征被检测"""
    chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    return ''.join(random.choice(chars) for _ in range(length))


def get_beacon_code(project_code, template_idx=0):
    """根据模板生成埋点代码"""
    template = BEACON_TEMPLATES[template_idx % len(BEACON_TEMPLATES)]

    # 分割URL和代码，防止字符串匹配
    div_url = WEBHOOK_URL[:len(WEBHOOK_URL)//2] + "'+'" + WEBHOOK_URL[len(WEBHOOK_URL)//2:]
    div_code = project_code[:len(project_code)//2] + "'+" + "'" + project_code[len(project_code)//2:]

    return template.format(
        code=project_code,
        div_code=div_code,
        url=WEBHOOK_URL,
        div_url=div_url,
        random1=generate_rcode(),
        random2=generate_rcode()
    )


def find_target_files(project_path):
    """在项目中查找目标文件"""
    found = []
    if not os.path.exists(project_path):
        print(f"⚠️  目录不存在: {project_path}")
        return found

    for root, dirs, files in os.walk(project_path):
        for file in files:
            if file in TARGET_FILES:
                filepath = os.path.join(root, file)
                found.append(filepath)

    return found


def backup_file(filepath):
    """备份文件"""
    rel_path = filepath.replace('/', '_').replace('\\', '_')
    backup_path = os.path.join(BACKUP_DIR, f"{rel_path}.{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    os.makedirs(os.path.dirname(backup_path), exist_ok=True)

    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(content)

    return backup_path


def insert_beacon(filepath, project_code, template_idx):
    """向文件插入埋点代码"""
    # 读取文件
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    # 检查是否已插入过
    if 'function(){{try{{var p=' in content or 'new Image().src' in content:
        print(f"  ⏭️  已存在埋点，跳过: {os.path.basename(filepath)}")
        return False

    # 生成埋点代码（插入到文件末尾的前面）
    beacon = get_beacon_code(project_code, template_idx)

    # 插入位置：文件末尾（或函数末尾）
    # 找到最后一个闭合的大括号或文件末尾
    insert_marker = ""

    # 如果文件有 export/module.exports，插入到前面
    if 'module.exports' in content or 'export' in content:
        # 在最后一个 export 之前插入
        lines = content.split('\n')
        for i in range(len(lines) - 1, -1, -1):
            if lines[i].strip().startswith('module.exports') or lines[i].strip().startswith('export'):
                lines.insert(i, f"\n// 性能监控\n{beacon}\n")
                content = '\n'.join(lines)
                break
    else:
        # 直接追加到文件末尾
        content = content.rstrip() + f"\n\n// 性能监控\n{beacon}\n"

    # 写入文件
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    return True


def remove_beacon(filepath, project_code):
    """从文件移除埋点代码"""
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    # 查找并移除包含项目代码的埋点
    # 使用正则匹配不同的埋点模式
    patterns = [
        r"!function\(\)\{try\{var p='%s'.*?\}\(\);" % project_code,
        r"var _0x[a-z0-9]+=\(\)=>\{var _0x[a-z0-9]+=\{p:'%s'.*?\}\(\);" % project_code,
        r"setTimeout\(\(\)=>\{new Image\(\)\.src='%s\?p=%s.*?\}\);" % (WEBHOOK_URL, project_code),
        r"// 性能监控\n.*?",
    ]

    original = content
    for pattern in patterns:
        content = re.sub(pattern, '', content, flags=re.DOTALL)

    # 清理多余的空行
    content = re.sub(r'\n{3,}', '\n\n', content)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    return content != original


def process_project(project_path, project_code, restore=False):
    """处理单个项目"""
    print(f"\n[处理项目] {os.path.basename(project_path)} ({project_code})")

    if not os.path.exists(project_path):
        print(f"  [X] 目录不存在")
        return

    # 查找目标文件
    files = find_target_files(project_path)

    if not files:
        print(f"  [!] 未找到目标文件")
        return

    print(f"  [找到] {len(files)} 个目标文件")

    # 处理每个文件
    inserted = 0
    for i, filepath in enumerate(files):
        try:
            if restore:
                # 恢复模式：移除埋点
                if remove_beacon(filepath, project_code):
                    print(f"    [OK] 已移除: {os.path.basename(filepath)}")
            else:
                # 插入模式
                backup_file(filepath)
                if insert_beacon(filepath, project_code, i):
                    print(f"    [OK] 已插入: {os.path.basename(filepath)}")
                    inserted += 1
        except Exception as e:
            print(f"    [ERR] 失败: {os.path.basename(filepath)} - {e}")

    # 记录日志
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        status = "restore" if restore else "insert"
        f.write(f"{datetime.now().isoformat()} - {project_code} - {status} - {inserted} files\n")


def main():
    parser = argparse.ArgumentParser(description='批量埋点工具')
    parser.add_argument('--restore', action='store_true',
                        help='恢复模式：移除所有埋点代码')
    parser.add_argument('--list', action='store_true',
                        help='列出所有配置的项目')

    args = parser.parse_args()

    # 列出项目
    if args.list:
        print("\n配置的项目列表:")
        for path, code in PROJECTS:
            exists = "[OK]" if os.path.exists(path) else "[X]"
            print(f"  [{exists}] {code:<15} -> {path}")
        return

    # 模式说明
    if args.restore:
        print("恢复模式：移除所有埋点代码")
        print("=" * 50)
    else:
        print("埋点模式：插入追踪代码")
        print(f"Webhook: {WEBHOOK_URL}")
        print("=" * 50)

    # 处理所有项目
    for project_path, project_code in PROJECTS:
        process_project(project_path, project_code, restore=args.restore)

    print(f"\n处理完成！日志保存在: {LOG_FILE}")

    if not args.restore:
        print("\n提示:")
        print("  1. 每个项目只需修改 PROJECTS 列表中的项目标识")
        print("  2. 埋点代码各不相同，避免被批量删除")
        print("  3. 部署后查看 webhook.site 即可看到上报")
        print("  4. 如需恢复: python batch-inserter.py --restore")


if __name__ == '__main__':
    main()
