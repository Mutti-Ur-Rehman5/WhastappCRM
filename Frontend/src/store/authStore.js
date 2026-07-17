import { create } from 'zustand';
import api, { setAuthHeader } from '../services/api.js';

export const useAuthStore = create((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  loading: true,
  error: null,

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const response = await api.post('/auth/login', { email, password });
      const { accessToken, user } = response.data.data;

      setAuthHeader(accessToken);
      set({
        user,
        token: accessToken,
        isAuthenticated: true,
        loading: false,
        error: null
      });
      return { success: true };
    } catch (err) {
      const msg = err.response?.data?.message || 'Login failed';
      set({ error: msg, loading: false });
      return { success: false, error: msg };
    }
  },

  logout: async () => {
    set({ loading: true });
    try {
      await api.post('/auth/logout');
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setAuthHeader(null);
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        loading: false,
        error: null
      });
    }
  },

  checkAuth: async () => {
    set({ loading: true });
    try {
      // Attempt to refresh the access token using the HTTP-only refresh cookie
      const refreshResponse = await api.post('/auth/refresh');
      const { accessToken } = refreshResponse.data.data;
      
      setAuthHeader(accessToken);

      // Retrieve full profile details with the new access token
      const meResponse = await api.get('/auth/me');
      const { user } = meResponse.data.data;

      set({
        user,
        token: accessToken,
        isAuthenticated: true,
        loading: false
      });
    } catch (err) {
      // Clear headers if verification fails (e.g. no cookie or expired session)
      setAuthHeader(null);
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        loading: false
      });
    }
  },

  inviteAgent: async (name, email, password) => {
    try {
      const response = await api.post('/auth/register', {
        name,
        email,
        password,
        role: 'agent'
      });
      return { success: true, data: response.data.data };
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to create agent';
      return { success: false, error: msg };
    }
  }
}));
