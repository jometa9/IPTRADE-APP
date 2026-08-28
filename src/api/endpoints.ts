export const endpoints = {
  accounts: {
    status: '/api/accounts/status',
    orders: '/api/accounts/orders',
    deleteAll: '/api/accounts',
    byId: (id: string) => `/api/accounts/${encodeURIComponent(id)}`,
    tcp: (id: string, enabled: boolean) =>
      `/api/accounts/${encodeURIComponent(id)}/tcp?enabled=${enabled}`,
  },
  preferences: '/api/system/preferences',
  authCtrader: {
    oauthUrl: '/api/auth/ctrader',
    complete: '/api/auth/ctrader',
    appCredentials: '/api/ctrader/app-credentials',
  },
  metatrader: {
    install: '/api/metatrader/install',
  },
  system: {
    engine: (status: 'on' | 'off') => `/api/system/engine/${status}`,
  },
  logs: '/api/logs',
  logsClear: '/api/logs',
  buildInfo: '/api/build-info',
  orders: {
    open: '/api/orders/open',
    openWs: '/api/orders/open/ws',
  },
} as const;
