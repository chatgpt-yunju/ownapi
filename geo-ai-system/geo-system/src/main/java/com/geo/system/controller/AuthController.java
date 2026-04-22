package com.geo.system.controller;

import com.geo.common.exception.GeoException;
import com.geo.common.model.ApiResponse;
import com.geo.system.dto.LoginRequest;
import com.geo.system.dto.LoginResponse;
import com.geo.system.dto.RegisterRequest;
import com.geo.system.service.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

/**
 * Authentication Controller
 * Handles login, register, logout, and token refresh endpoints
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    @Autowired
    private AuthService authService;

    /**
     * User login endpoint
     * POST /api/v1/auth/login
     */
    @PostMapping("/login")
    public ApiResponse<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
        try {
            LoginResponse response = authService.login(request);
            return ApiResponse.success(response);
        } catch (GeoException e) {
            return ApiResponse.error(e.getCode(), e.getMessage());
        } catch (Exception e) {
            log.error("Login error: {}", e.getMessage(), e);
            return ApiResponse.error(500, "登录失败，请稍后重试");
        }
    }

    /**
     * User registration endpoint
     * POST /api/v1/auth/register
     */
    @PostMapping("/register")
    public ApiResponse<Void> register(@Valid @RequestBody RegisterRequest request) {
        try {
            authService.register(request);
            return ApiResponse.success("注册成功", null);
        } catch (GeoException e) {
            return ApiResponse.error(e.getCode(), e.getMessage());
        } catch (Exception e) {
            log.error("Registration error: {}", e.getMessage(), e);
            return ApiResponse.error(500, "注册失败，请稍后重试");
        }
    }

    /**
     * User logout endpoint
     * POST /api/v1/auth/logout
     * Requires authentication
     */
    @PostMapping("/logout")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<Void> logout(HttpServletRequest request) {
        try {
            // Extract token from Authorization header
            String authHeader = request.getHeader("Authorization");
            if (authHeader != null && authHeader.startsWith("Bearer ")) {
                String token = authHeader.substring(7);
                // Get userId from request attribute (set by JwtAuthenticationFilter)
                Long userId = (Long) request.getAttribute("userId");
                authService.logout(token, userId);
                return ApiResponse.success("退出登录成功", null);
            }
            return ApiResponse.error(400, "无效的授权令牌");
        } catch (Exception e) {
            log.error("Logout error: {}", e.getMessage(), e);
            return ApiResponse.error(500, "退出登录失败，请稍后重试");
        }
    }

    /**
     * Refresh access token endpoint
     * POST /api/v1/auth/refresh
     */
    @PostMapping("/refresh")
    public ApiResponse<LoginResponse> refresh(@RequestBody RefreshTokenRequest request) {
        try {
            LoginResponse response = authService.refreshToken(request.getRefreshToken());
            return ApiResponse.success(response);
        } catch (GeoException e) {
            return ApiResponse.error(e.getCode(), e.getMessage());
        } catch (Exception e) {
            log.error("Token refresh error: {}", e.getMessage(), e);
            return ApiResponse.error(500, "刷新令牌失败，请稍后重试");
        }
    }

    /**
     * Get current user info endpoint
     * GET /api/v1/auth/me
     * Requires authentication
     */
    @GetMapping("/me")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<UserInfo> getCurrentUser(HttpServletRequest request) {
        try {
            Long userId = (Long) request.getAttribute("userId");
            Long tenantId = (Long) request.getAttribute("tenantId");

            UserInfo userInfo = new UserInfo();
            userInfo.setUserId(userId);
            userInfo.setTenantId(tenantId);

            return ApiResponse.success(userInfo);
        } catch (Exception e) {
            log.error("Get current user error: {}", e.getMessage(), e);
            return ApiResponse.error(500, "获取用户信息失败");
        }
    }

    /**
     * Refresh token request DTO
     */
    @lombok.Data
    @lombok.NoArgsConstructor
    @lombok.AllArgsConstructor
    public static class RefreshTokenRequest {
        private String refreshToken;
    }

    /**
     * User info response DTO
     */
    @lombok.Data
    @lombok.NoArgsConstructor
    @lombok.AllArgsConstructor
    public static class UserInfo {
        private Long userId;
        private Long tenantId;
    }
}
