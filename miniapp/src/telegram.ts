type BackButton = {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
};

type WebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string } };
  version: string;
  ready(): void;
  expand(): void;
  openTelegramLink(url: string): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  showAlert(message: string): void;
  isVersionAtLeast(version: string): boolean;
  /** Свайп вниз закрывает мини-апп — при скролле длинных списков это мешает. */
  disableVerticalSwipes?(): void;
  BackButton?: BackButton;
  HapticFeedback?: { impactOccurred(style: 'light' | 'medium' | 'heavy'): void };
  themeParams: Record<string, string>;
};

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp };
  }
}

export const tg = window.Telegram?.WebApp;

const SESSION_KEY = 'telemusic.session';

/** Внутри Telegram initData непустой; в установленном PWA его нет. */
export function insideTelegram(): boolean {
  return Boolean(tg?.initData);
}

export function initTelegram(): void {
  captureSessionFromUrl();
  blockZoom();

  if (insideTelegram()) {
    tg?.ready();
    tg?.expand();
    tg?.disableVerticalSwipes?.();
  }
}

/**
 * Штатная кнопка «Назад» в шапке Telegram. Показанная, она встаёт на место
 * закрывающего крестика — поэтому своих кнопок «назад» в интерфейсе быть не должно,
 * иначе их получается две и обе делают разное.
 */
export const backButton = tg?.BackButton;

export function hasNativeBack(): boolean {
  return insideTelegram() && Boolean(backButton);
}

/**
 * Двойной тап и щипок в мини-аппе не нужны: это интерфейс, а не документ.
 * meta viewport закрывает Android и большую часть случаев, но Safari на iOS
 * его игнорирует — там масштаб приходится гасить руками по жестам.
 */
function blockZoom(): void {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }

  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (event) => {
      const now = Date.now();
      if (now - lastTouch <= 350) event.preventDefault();
      lastTouch = now;
    },
    { passive: false },
  );
}

/**
 * PWA открывается ссылкой вида /?s=<токен>. Забираем токен в localStorage и вычищаем
 * из адреса, чтобы он не остался в истории браузера и не утёк через шаринг ссылки.
 */
function captureSessionFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('s');
  if (!token) return;

  localStorage.setItem(SESSION_KEY, token);
  params.delete('s');

  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
}

export function sessionToken(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** Плейлист, на который привёл deep link t.me/<bot>/app?startapp=<slug>. */
export function sharedSlug(): string | null {
  return tg?.initDataUnsafe.start_param ?? null;
}

export function haptic(): void {
  tg?.HapticFeedback?.impactOccurred('light');
}

export function alert(message: string): void {
  if (insideTelegram()) tg?.showAlert(message);
  else window.alert(message);
}
