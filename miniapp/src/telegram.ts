type WebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string } };
  ready(): void;
  expand(): void;
  openTelegramLink(url: string): void;
  showAlert(message: string): void;
  HapticFeedback?: { impactOccurred(style: 'light' | 'medium' | 'heavy'): void };
  themeParams: Record<string, string>;
};

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp };
  }
}

export const tg = window.Telegram?.WebApp;

export function initTelegram(): void {
  tg?.ready();
  tg?.expand();
}

/** Плейлист, на который привёл deep link t.me/<bot>/app?startapp=<slug>. */
export function sharedSlug(): string | null {
  return tg?.initDataUnsafe.start_param ?? null;
}

export function haptic(): void {
  tg?.HapticFeedback?.impactOccurred('light');
}
