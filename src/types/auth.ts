/**
 * Auth Types
 * All users are citizens — no admin role exists.
 */

export interface User {
  id: string;
  email: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  mobileNumber?: string;
  phone?: string;
  address?: string;
  profilePhotoUri?: string;
  pushToken?: string;
  createdAt: string;
}

/** Stored in the DB but never returned in API responses. */
export interface UserRow extends User {
  passwordHash: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface AuthResponse {
  success: boolean;
  user?: User;
  token?: string;
  error?: string;
}

/** Payload encoded inside every JWT. */
export interface JwtPayload {
  userId: string;
  email: string;
}
