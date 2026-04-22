package com.geo.system.config;

import com.geo.system.service.QuotaService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 配额定时重置任务
 * 每月1号00:00执行配额重置
 */
@Slf4j
@Component
public class QuotaScheduler {

    private final QuotaService quotaService;

    public QuotaScheduler(QuotaService quotaService) {
        this.quotaService = quotaService;
    }

    /**
     * 每月1号00:00执行配额重置
     * Cron表达式: 0 0 0 1 * ?
     * - 0: 秒
     * - 0: 分
     * - 0: 小时
     * - 1: 日期（每月1号）
     * - *: 月份（每个月）
     * - ?: 星期（不指定）
     */
    @Scheduled(cron = "0 0 0 1 * ?")
    public void resetMonthlyQuotas() {
        try {
            log.info("Starting monthly quota reset task...");
            quotaService.resetAllQuotas();
            log.info("Monthly quota reset task completed successfully");
        } catch (Exception e) {
            log.error("Error during monthly quota reset task", e);
        }
    }
}
