import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { RequireAuth } from '@/routes/RequireAuth';
import { AppLayout } from '@/layout/AppLayout';
import {
  LoginPage,
  BotsListPage,
  BotDetailsPage,
  CredentialsPage,
  WebChatPage,
} from '@/pages';

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/bots" replace />} />
              <Route path="/bots" element={<BotsListPage />} />
              <Route path="/bots/:botId" element={<BotDetailsPage />} />
              <Route path="/bots/:botId/credentials" element={<CredentialsPage />} />
              <Route path="/bots/:botId/webchat" element={<WebChatPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
};

export default App;
