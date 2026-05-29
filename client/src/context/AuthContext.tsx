import React, { createContext, useContext, useEffect, useState } from 'react';
import { apiClient } from '@/services/api';

interface AuthContextValue {
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => !!apiClient.getToken());

  useEffect(() => {
    apiClient.onUnauthorized = () => setIsAuthenticated(false);
    return () => {
      apiClient.onUnauthorized = null;
    };
  }, []);

  const login = async (username: string, password: string) => {
    await apiClient.login(username, password);
    setIsAuthenticated(true);
  };

  const logout = () => {
    apiClient.logout();
    setIsAuthenticated(false);
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
