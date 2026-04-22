package com.geo.system.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 配额使用情况DTO
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class QuotaUsageDTO {

    // 诊断配额
    private Long diagnosisUsed;
    private Long diagnosisLimit;
    private Long diagnosisRemaining;

    // 监控配额
    private Long monitorUsed;
    private Long monitorLimit;
    private Long monitorRemaining;

    // 创作配额
    private Long contentUsed;
    private Long contentLimit;
    private Long contentRemaining;
}
