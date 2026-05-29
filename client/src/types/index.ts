export interface OpenBot {
  id: string;
  handle: string;
  endpoint: string;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenBotSecret {
  secretId: string;
  description: string;
  createdAt: Date;
  expiresAt?: Date;
  secret?: string;
}

export interface WebChatChannel {
  id: string;
  name: string;
  createdAt: Date;
  secret1?: string;
  secret2?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LoginResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
}
