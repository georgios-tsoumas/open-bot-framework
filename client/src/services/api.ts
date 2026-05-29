import axios, { AxiosInstance } from 'axios';
import { OpenBot, OpenBotSecret, WebChatChannel, PaginatedResponse, LoginResponse } from '@/types';

const API_BASE_URL: string = import.meta.env.VITE_API_URL || '';
const TOKEN_KEY = 'obf_token';

class ApiClient {
  private client: AxiosInstance;
  onUnauthorized: (() => void) | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.request.use((config) => {
      const token = this.getToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          this.clearToken();
          this.onUnauthorized?.();
        }
        return Promise.reject(error);
      }
    );
  }

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  private setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  }

  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
  }

  async login(username: string, password: string): Promise<void> {
    const response = await this.client.post<LoginResponse>('/api/login', { username, password });
    this.setToken(response.data.access_token);
  }

  logout(): void {
    this.clearToken();
    this.onUnauthorized?.();
  }

  async getOpenBots(page: number = 0, pageSize: number = 10): Promise<PaginatedResponse<OpenBot>> {
    const response = await this.client.get('/api/bots', { params: { page, pageSize } });
    return response.data;
  }

  async getOpenBotById(id: string): Promise<OpenBot> {
    const response = await this.client.get(`/api/bots/${id}`);
    return response.data;
  }

  async createOpenBot(bot: Omit<OpenBot, 'id' | 'createdAt' | 'updatedAt'>): Promise<OpenBot> {
    const response = await this.client.post('/api/bots', bot);
    return response.data;
  }

  async updateOpenBot(id: string, bot: Partial<OpenBot>): Promise<OpenBot> {
    const response = await this.client.put(`/api/bots/${id}`, bot);
    return response.data;
  }

  async deleteOpenBot(id: string): Promise<void> {
    await this.client.delete(`/api/bots/${id}`);
  }

  async getOpenBotSecrets(botId: string, page: number = 0, pageSize: number = 10): Promise<PaginatedResponse<OpenBotSecret>> {
    const response = await this.client.get(`/api/bots/${botId}/credentials`, { params: { page, pageSize } });
    return response.data;
  }

  async getOpenBotSecretById(botId: string, secretId: string): Promise<OpenBotSecret> {
    const response = await this.client.get(`/api/bots/${botId}/credentials/${secretId}`);
    return response.data;
  }

  async createOpenBotSecret(botId: string, secret: Omit<OpenBotSecret, 'secretId' | 'createdAt'>): Promise<OpenBotSecret> {
    const response = await this.client.post(`/api/bots/${botId}/credentials`, secret);
    return response.data;
  }

  async updateOpenBotSecret(botId: string, secretId: string, secret: Partial<OpenBotSecret>): Promise<OpenBotSecret> {
    const response = await this.client.put(`/api/bots/${botId}/credentials/${secretId}`, secret);
    return response.data;
  }

  async deleteOpenBotSecret(botId: string, secretId: string): Promise<void> {
    await this.client.delete(`/api/bots/${botId}/credentials/${secretId}`);
  }

  async getWebChatChannels(botId: string, page: number = 0, pageSize: number = 10): Promise<PaginatedResponse<WebChatChannel>> {
    const response = await this.client.get(`/api/bots/${botId}/webchat`, { params: { page, pageSize } });
    return response.data;
  }

  async getWebChatChannelById(botId: string, channelId: string): Promise<WebChatChannel> {
    const response = await this.client.get(`/api/bots/${botId}/webchat/${channelId}`);
    return response.data;
  }

  async createWebChatChannel(botId: string, channel: Omit<WebChatChannel, 'id' | 'createdAt' | 'secret1' | 'secret2'>): Promise<WebChatChannel> {
    const response = await this.client.post(`/api/bots/${botId}/webchat`, channel);
    return response.data;
  }

  async updateWebChatChannel(botId: string, channelId: string, channel: Partial<WebChatChannel>): Promise<WebChatChannel> {
    const response = await this.client.patch(`/api/bots/${botId}/webchat/${channelId}`, channel);
    return response.data;
  }

  async deleteWebChatChannel(botId: string, channelId: string): Promise<void> {
    await this.client.delete(`/api/bots/${botId}/webchat/${channelId}`);
  }
}

export const apiClient = new ApiClient();
