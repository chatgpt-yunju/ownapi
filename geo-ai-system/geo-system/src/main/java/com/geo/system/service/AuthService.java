package com.geo.system.service;

import com.geo.common.exception.GeoException;
import com.geo.system.dto.LoginRequest;
import com.geo.system.dto.LoginResponse;
import com.geo.system.dto.RegisterRequest;

/**
 * Authentication Service Interface
 */
public interface AuthService {

    /**
     * User login
     * @param request Login request with username and password
     * @return Login response with JWT tokens
     * @throws GeoException if credentials are invalid or account is locked
     */
    LoginResponse login(LoginRequest request) throws GeoException;

    /**
     * User registration
     * @param request Registration request with user details
     * @throws GeoException if validation fails or user already exists
     */
    void register(RegisterRequest request) throws GeoException;

    /**
     * User logout
     * @param token JWT token to blacklist
     * @param userId User ID
     */
    void logout(String token, Long userId);

    /**
     * Refresh access token
     * @param refreshToken Refresh token
     * @return New login response with new access token
     * @throws GeoException if refresh token is invalid
     */
    LoginResponse refreshToken(String refreshToken) throws GeoException;

    /**
     * Validate password strength
     * @param password Password to validate
     * @throws GeoException if password doesn't meet strength requirements
     */
    void validatePasswordStrength(String password) throws GeoException;
}
