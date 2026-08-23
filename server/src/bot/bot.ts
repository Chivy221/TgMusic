import { Bot } from 'grammy';
import { config } from '../config.js';

/** Инстанс живёт отдельно от хендлеров, чтобы сервисы могли слать сообщения без циклических импортов. */
export const bot = new Bot(config.botToken);
