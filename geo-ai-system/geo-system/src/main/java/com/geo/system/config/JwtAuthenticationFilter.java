package com.geo.system.config;

import com.geo.common.model.ApiResponse;
import com.geo.common.utils.JwtTokenProvider;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * JWT Authentication Filter
 * Validates JWT tokens on each request and sets authentication context
 */
@Slf4j
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private static final ObjectMapper objectMapper = new ObjectMapper();

    // Public endpoints that don't require authentication
    private static final List<String> PUBLIC_ENDPOINTS = List.of(
            "/api/v1/auth/login",
            "/api/v1/auth/register",
            "/api/v1/auth/refresh"
    );

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        String requestPath = request.getRequestURI();

        // Skip authentication for public endpoints
        if (isPublicEndpoint(requestPath)) {
            filterChain.doFilter(request, response);
            return;
        }

        try {
            // Extract Bearer token from Authorization header
            String authHeader = request.getHeader("Authorization");
            if (authHeader == null || !authHeader.startsWith("Bearer ")) {
                sendUnauthorizedError(response, "缺少授权令牌");
                return;
            }

            String token = authHeader.substring(7);

            // Validate token
            if (!jwtTokenProvider.validateToken(token)) {
                sendUnauthorizedError(response, "授权令牌无效或已过期");
                return;
            }

            // Extract claims from token
            Long userId = jwtTokenProvider.getUserIdFromToken(token);
            Long tenantId = jwtTokenProvider.getTenantIdFromToken(token);
            List<String> roles = jwtTokenProvider.getRolesFromToken(token);

            if (userId == null || tenantId == null) {
                sendUnauthorizedError(response, "授权令牌格式错误");
                return;
            }

            // Set attributes in request for downstream use
            request.setAttribute("userId", userId);
            request.setAttribute("tenantId", tenantId);
            request.setAttribute("roles", roles);
            request.setAttribute("token", token);

            log.debug("Token validated for user: {}, tenant: {}", userId, tenantId);

            // Continue with the filter chain
            filterChain.doFilter(request, response);

        } catch (Exception e) {
            log.error("JWT authentication error: {}", e.getMessage(), e);
            sendUnauthorizedError(response, "认证失败");
        }
    }

    /**
     * Check if the request path is a public endpoint
     */
    private boolean isPublicEndpoint(String path) {
        return PUBLIC_ENDPOINTS.stream().anyMatch(path::startsWith);
    }

    /**
     * Send unauthorized error response
     */
    private void sendUnauthorizedError(HttpServletResponse response, String message) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");

        ApiResponse<Void> errorResponse = ApiResponse.error(401, message);
        response.getWriter().write(objectMapper.writeValueAsString(errorResponse));
    }
}
