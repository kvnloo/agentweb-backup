export interface MetaAdAccount {
  id: string;
  name: string;
  account_id: string;
  currency: string;
  account_status: number;
  owner?: string;
  business?: {
    id: string;
    name: string;
    [key: string]: any;
  };
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string; // Page-specific access token
  category: string;
  tasks?: string[];
}

export interface MetaConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export interface MetaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}
