package com.geo.system.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Login Response DTO
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class LoginResponse {

    private String accessToken;

    private String refreshToken;

    private Long expiresIn; // 2 hours in seconds = 7200

    private String tokenType; // "Bearer"

    private Long userId;

    private String username;

    private Long tenantId;

    private List<String> roles;
}
