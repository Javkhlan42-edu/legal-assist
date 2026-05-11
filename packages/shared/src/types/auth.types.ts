export type AuthProvider = 'credentials' | 'google';

export interface AuthUser {
  id: string;
  email: string;
  fullName?: string;
  avatarUrl?: string;
  providerHints: AuthProvider[];
  createdAt: string;
  lastLoginAt?: string;
}

export interface SignupRequest {
  email: string;
  password: string;
  fullName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface GoogleAuthRequest {
  credential: string;
}

export interface AuthSuccessResponse {
  accessToken: string;
  user: AuthUser;
}

export interface AuthMeResponse {
  user: AuthUser;
}
