package com.geo.system.service.impl;

import com.geo.common.exception.GeoException;
import com.geo.system.dto.QuotaUsageDTO;
import com.geo.system.entity.SysUser;
import com.geo.system.entity.SysVersion;
import com.geo.system.mapper.SysUserMapper;
import com.geo.system.mapper.SysVersionMapper;
import com.geo.system.service.QuotaService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.YearMonth;
import java.util.concurrent.TimeUnit;

/**
 * 配额管理Service实现
 * 使用Redis进行实时计数，支持月度配额管理
 */
@Slf4j
@Service
@Transactional
public class QuotaServiceImpl implements QuotaService {

    private final RedisTemplate<String, Object> redisTemplate;
    private final SysUserMapper sysUserMapper;
    private final SysVersionMapper sysVersionMapper;

    public QuotaServiceImpl(RedisTemplate<String, Object> redisTemplate,
                          SysUserMapper sysUserMapper,
                          SysVersionMapper sysVersionMapper) {
        this.redisTemplate = redisTemplate;
        this.sysUserMapper = sysUserMapper;
        this.sysVersionMapper = sysVersionMapper;
    }

    @Override
    public boolean checkQuota(Long tenantId, String quotaType) {
        try {
            // 获取用户信息（假设从ThreadLocal或SecurityContext获取）
            // 这里简化处理，实际应该从当前登录用户获取
            SysUser user = sysUserMapper.selectById(tenantId);
            if (user == null) {
                log.warn("User not found for tenantId: {}", tenantId);
                return false;
            }

            // 获取用户的版本信息
            SysVersion version = sysVersionMapper.findById(user.getRoleId());
            if (version == null) {
                log.warn("Version not found for roleId: {}", user.getRoleId());
                return false;
            }

            // 获取当月配额使用量
            String key = buildQuotaKey(tenantId, quotaType);
            Long used = (Long) redisTemplate.opsForValue().get(key);
            if (used == null) {
                used = 0L;
            }

            // 获取配额限额
            Long limit = getQuotaLimit(version, quotaType);
            if (limit == null) {
                log.warn("Quota limit not found for quotaType: {}", quotaType);
                return false;
            }

            boolean result = used < limit;
            log.debug("Quota check for tenant {}, type {}: used={}, limit={}, result={}",
                    tenantId, quotaType, used, limit, result);
            return result;
        } catch (Exception e) {
            log.error("Error checking quota for tenant {}, type {}", tenantId, quotaType, e);
            return false;
        }
    }

    @Override
    public void consumeQuota(Long tenantId, String quotaType, int count) {
        // 检查配额是否充足
        if (!checkQuota(tenantId, quotaType)) {
            throw new GeoException("配额不足，无法继续操作");
        }

        // 增加Redis计数器
        String key = buildQuotaKey(tenantId, quotaType);
        redisTemplate.opsForValue().increment(key, count);

        // 设置过期时间为月底
        long ttl = getMonthEndTTL();
        redisTemplate.expire(key, ttl, TimeUnit.SECONDS);

        log.info("Consumed quota for tenant {}, type {}, count {}", tenantId, quotaType, count);
    }

    @Override
    public QuotaUsageDTO getQuotaUsage(Long tenantId) {
        try {
            // 获取用户信息
            SysUser user = sysUserMapper.selectById(tenantId);
            if (user == null) {
                log.warn("User not found for tenantId: {}", tenantId);
                return new QuotaUsageDTO();
            }

            // 获取用户的版本信息
            SysVersion version = sysVersionMapper.findById(user.getRoleId());
            if (version == null) {
                log.warn("Version not found for roleId: {}", user.getRoleId());
                return new QuotaUsageDTO();
            }

            QuotaUsageDTO dto = new QuotaUsageDTO();

            // 诊断配额
            Long diagnosisUsed = getQuotaUsed(tenantId, "diagnosis");
            Long diagnosisLimit = version.getMonthlyDiagnosisCount().longValue();
            dto.setDiagnosisUsed(diagnosisUsed);
            dto.setDiagnosisLimit(diagnosisLimit);
            dto.setDiagnosisRemaining(diagnosisLimit - diagnosisUsed);

            // 监控配额
            Long monitorUsed = getQuotaUsed(tenantId, "monitor");
            Long monitorLimit = version.getMonitorCountLimit().longValue();
            dto.setMonitorUsed(monitorUsed);
            dto.setMonitorLimit(monitorLimit);
            dto.setMonitorRemaining(monitorLimit - monitorUsed);

            // 创作配额
            Long contentUsed = getQuotaUsed(tenantId, "content");
            Long contentLimit = version.getMonthlyContentCount().longValue();
            dto.setContentUsed(contentUsed);
            dto.setContentLimit(contentLimit);
            dto.setContentRemaining(contentLimit - contentUsed);

            return dto;
        } catch (Exception e) {
            log.error("Error getting quota usage for tenant {}", tenantId, e);
            return new QuotaUsageDTO();
        }
    }

    @Override
    public void resetQuota(Long tenantId) {
        try {
            String diagnosisKey = buildQuotaKey(tenantId, "diagnosis");
            String monitorKey = buildQuotaKey(tenantId, "monitor");
            String contentKey = buildQuotaKey(tenantId, "content");

            redisTemplate.delete(diagnosisKey);
            redisTemplate.delete(monitorKey);
            redisTemplate.delete(contentKey);

            log.info("Reset quota for tenant {}", tenantId);
        } catch (Exception e) {
            log.error("Error resetting quota for tenant {}", tenantId, e);
        }
    }

    @Override
    public void resetAllQuotas() {
        try {
            // 获取所有租户
            // 这里简化处理，实际应该查询所有租户
            log.info("Reset all quotas - scheduled task executed");
        } catch (Exception e) {
            log.error("Error resetting all quotas", e);
        }
    }

    /**
     * 构建Redis key
     */
    private String buildQuotaKey(Long tenantId, String quotaType) {
        String yearMonth = YearMonth.now().toString().replace("-", "");
        return String.format("quota:%d:%s:%s", tenantId, quotaType, yearMonth);
    }

    /**
     * 获取配额使用量
     */
    private Long getQuotaUsed(Long tenantId, String quotaType) {
        String key = buildQuotaKey(tenantId, quotaType);
        Long used = (Long) redisTemplate.opsForValue().get(key);
        return used != null ? used : 0L;
    }

    /**
     * 获取配额限额
     */
    private Long getQuotaLimit(SysVersion version, String quotaType) {
        if (version == null) {
            return null;
        }
        switch (quotaType) {
            case "diagnosis":
                return version.getMonthlyDiagnosisCount().longValue();
            case "monitor":
                return version.getMonitorCountLimit().longValue();
            case "content":
                return version.getMonthlyContentCount().longValue();
            default:
                return null;
        }
    }

    /**
     * 获取月底的TTL（秒数）
     */
    private long getMonthEndTTL() {
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime monthEnd = now.withDayOfMonth(now.getMonth().length(now.toLocalDate().isLeapYear()))
                .withHour(23).withMinute(59).withSecond(59);
        return java.time.temporal.ChronoUnit.SECONDS.between(now, monthEnd);
    }
}
