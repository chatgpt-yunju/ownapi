#!/bin/bash

# CC Club 配额监控脚本
# 限额: $7
# 使用期限: 2026-03-18 08:15 到 2026-03-25 08:15
# 通知邮箱: 2743319061@qq.com

QUOTA_LIMIT=7.00
START_DATE="2026-03-18 08:15:00"
END_DATE="2026-03-25 08:15:00"
NOTIFY_EMAIL="2743319061@qq.com"

# 获取当前时间
CURRENT_DATE=$(date '+%Y-%m-%d %H:%M:%S')

# 检查是否超出使用期限
if [[ "$CURRENT_DATE" > "$END_DATE" ]]; then
    echo "⚠️  CC Club 密钥已过期！"
    echo "过期时间: $END_DATE"
    echo "当前时间: $CURRENT_DATE"

    # 发送邮件通知
    echo "CC Club API 密钥已于 $END_DATE 过期，请及时更新。当前时间: $CURRENT_DATE" | \
    mail -s "⚠️ CC Club 密钥过期通知" $NOTIFY_EMAIL

    exit 1
fi

# 查询 CC Club 模型的总使用费用
TOTAL_COST=$(mysql -uroot wechat_cms -N -e "
SELECT ROUND(SUM(total_cost), 4)
FROM openclaw_call_logs
WHERE model IN ('claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022')
AND created_at >= '$START_DATE'
AND status = 'success';
")

# 如果没有使用记录，设置为 0
if [ -z "$TOTAL_COST" ] || [ "$TOTAL_COST" == "NULL" ]; then
    TOTAL_COST=0
fi

# 计算剩余配额
REMAINING=$(echo "$QUOTA_LIMIT - $TOTAL_COST" | bc)
USAGE_PERCENT=$(echo "scale=2; $TOTAL_COST / $QUOTA_LIMIT * 100" | bc)

echo "=== CC Club 配额监控 ==="
echo "限额: \$$QUOTA_LIMIT"
echo "已使用: \$$TOTAL_COST (${USAGE_PERCENT}%)"
echo "剩余: \$$REMAINING"
echo "有效期: $START_DATE 至 $END_DATE"
echo ""

# 检查是否超出配额
if (( $(echo "$TOTAL_COST >= $QUOTA_LIMIT" | bc -l) )); then
    echo "❌ 配额已用完！"

    # 发送邮件通知
    echo "CC Club API 配额已用完。已使用: \$$TOTAL_COST / \$$QUOTA_LIMIT" | \
    mail -s "❌ CC Club 配额用尽通知" $NOTIFY_EMAIL

    exit 1
fi

# 检查是否接近配额上限（80%）
if (( $(echo "$USAGE_PERCENT >= 80" | bc -l) )); then
    echo "⚠️  配额使用已超过 80%！"

    # 发送邮件通知
    echo "CC Club API 配额使用已达 ${USAGE_PERCENT}%。已使用: \$$TOTAL_COST / \$$QUOTA_LIMIT，剩余: \$$REMAINING" | \
    mail -s "⚠️ CC Club 配额预警" $NOTIFY_EMAIL
fi

echo "✅ 配额正常"
