package com.geo.system.config;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * 租户拦截器
 * 从JWT token中提取租户ID，设置到TenantContext中
 */
@Component
public class TenantInterceptor implements HandlerInterceptor {

    @Value("${jwt.secret:your-secret-key-change-in-production}")
    private String jwtSecret;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        String authHeader = request.getHeader("Authorization");

        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            String token = authHeader.substring(7);
            try {
                Claims claims = Jwts.parser()
                        .setSigningKey(jwtSecret.getBytes())
                        .build()
                        .parseClaimsJws(token)
                        .getBody();

                Long tenantId = claims.get("tenantId", Long.class);
                if (tenantId != null) {
                    TenantContext.setTenantId(tenantId);
                }
            } catch (Exception e) {
                // Token解析失败，继续处理（由其他拦截器或控制器处理认证）
            }
        }

        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) throws Exception {
        TenantContext.clear();
    }
}
